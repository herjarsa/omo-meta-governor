/**
 * Filesystem watcher for project-local skills.
 *
 * Watches cwd/.agents/skills/ recursively for SKILL.md changes. Triggers a
 * callback on create (add) so the resolver can re-scan and the new skill
 * appears immediately in search results. Change events are reported too
 * for callers that care, but the plugin's spec only counts creates.
 *
 * Implementation: chokidar v4 (ESM, named import). Falls back to a no-op
 * if chokidar is unavailable.
 */

import { watch } from "chokidar"
import { existsSync } from "node:fs"

export interface FsWatcher {
  stop(): Promise<void>
}

export type SkillFileEvent = "add" | "change"

// v0.38.X (CI fix): Windows system paths that chokidar's readdirp walker
// (usePolling: true) cannot lstat. Without this filter, the EINVAL leaks to
// bun's test runner as "Unhandled error between tests" and bumps the exit
// code to 1 even when no test fails. Mirrors src/error-handler.ts paths.
const WINDOWS_SYSTEM_PATH_REGEX =
  /^[A-Z]:[\\/](pagefile\.sys|DumpStack\.log\.tmp|hiberfil\.sys|swapfile\.sys)/i

export async function startSkillsFsWatcher(opts: {
  projectDir: string
  onChange: (path: string, event: SkillFileEvent) => Promise<void>
}): Promise<FsWatcher> {
  // v0.38.X (CI fix): if the directory does not exist (common in tests with
  // mockPluginInput.directory=""), chokidar with usePolling falls back to
  // scanning from process.cwd() and recurses into Windows system paths
  // (D:\DumpStack.log.tmp, D:\pagefile.sys) that throw EINVAL on lstat.
  // Returning a no-op watcher avoids the error entirely — we don't need to
  // watch a directory that doesn't exist.
  if (!opts.projectDir || !existsSync(opts.projectDir)) {
    const noop: FsWatcher = { stop: async () => {} }
    return noop
  }
  const isSkillFile = (p: string): boolean => p.endsWith("SKILL.md")
  const watcher = watch(opts.projectDir, {
    ignoreInitial: true,
    usePolling: true,
    interval: 100,
    binaryInterval: 100,
    // Belt-and-braces: even if a system path sneaks past the existsSync
    // check (e.g. created mid-scan), ignore it before readdirp lstats.
    ignored: (p: string) => WINDOWS_SYSTEM_PATH_REGEX.test(p),
  })
  // Race-safe: if `stop()` is called before the ready promise resolves, we
  // short-circuit the await so the caller doesn't hang on plugin dispose.
  let stopped = false
  const ready = new Promise<void>((resolve) => {
    watcher.once("ready", () => {
      if (!stopped) resolve()
    })
  })
  watcher.on("add", (p) => {
    if (!stopped && isSkillFile(p)) void opts.onChange(p, "add")
  })
  watcher.on("change", (p) => {
    if (!stopped && isSkillFile(p)) void opts.onChange(p, "change")
  })
  await ready
  // Windows chokidar v4 needs a small stabilization window before subdir
  // events are reliably delivered. See plan note.
  await new Promise((r) => setTimeout(r, 100))
  return {
    async stop() {
      stopped = true
      await watcher.close()
    },
  }
}
