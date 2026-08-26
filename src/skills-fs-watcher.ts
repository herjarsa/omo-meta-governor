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

export interface FsWatcher {
  stop(): Promise<void>
}

export type SkillFileEvent = "add" | "change"

export async function startSkillsFsWatcher(opts: {
  projectDir: string
  onChange: (path: string, event: SkillFileEvent) => Promise<void>
}): Promise<FsWatcher> {
  const isSkillFile = (p: string): boolean => p.endsWith("SKILL.md")
  const watcher = watch(opts.projectDir, {
    ignoreInitial: true,
    usePolling: true,
    interval: 100,
    binaryInterval: 100,
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
