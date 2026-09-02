// scripts/release.ts
// Automates the AGENTS.md ship protocol: bump version, commit bump,
// validate CHANGELOG, run tests, build, publish, tag, release.
// Aborts on any step failure.
//
// Usage: bun run release 0.38.0
//        bun run release 0.38.0 --dry-run
//
// v0.38.0 NOTE: This is a fresh implementation. Earlier shell-based flows
// suffered from PowerShell backtick escaping issues (gh release create
// --notes "...`..."). The new script uses --notes-file to avoid the issue.

import { readFileSync, writeFileSync, existsSync, unlinkSync } from "node:fs"
import { resolve } from "node:path"

export interface ParsedVersion {
  major: number
  minor: number
  patch: number
  tag: string
}

export function parseVersion(input: string): ParsedVersion {
  if (!input) throw new Error("Version is required")
  const cleaned = input.startsWith("v") ? input.slice(1) : input
  const match = cleaned.match(/^(\d+)\.(\d+)\.(\d+)$/)
  if (!match) {
    throw new Error(`Invalid version: ${input}. Expected format: MAJOR.MINOR.PATCH`)
  }
  return {
    major: parseInt(match[1], 10),
    minor: parseInt(match[2], 10),
    patch: parseInt(match[3], 10),
    tag: `v${cleaned}`,
  }
}

export function validateChangelog(changelogPath: string, version: ParsedVersion): void {
  if (!existsSync(changelogPath)) {
    throw new Error(`CHANGELOG not found: ${changelogPath}`)
  }
  const content = readFileSync(changelogPath, "utf-8")
  if (!content.includes(`## [${version.major}.${version.minor}.${version.patch}]`)) {
    throw new Error(`CHANGELOG missing entry for ## [${version.major}.${version.minor}.${version.patch}]`)
  }
  if (!content.includes("### Ship protocol compliance")) {
    throw new Error("CHANGELOG missing '### Ship protocol compliance' section")
  }
  const shipSection = content.split("### Ship protocol compliance")[1]?.split("##")[0] ?? ""
  if (!shipSection.includes("✅")) {
    throw new Error("CHANGELOG 'Ship protocol compliance' section missing ✅ markers")
  }
}

export interface RunResult {
  exitCode: number
  stdout: string
  stderr: string
}

export async function runCommand(
  cmd: string[],
  options: { cwd?: string } = {}
): Promise<RunResult> {
  const proc = Bun.spawn(cmd, {
    cwd: options.cwd ?? process.cwd(),
    stdout: "pipe",
    stderr: "pipe",
  })
  const stdout = await new Response(proc.stdout).text()
  const stderr = await new Response(proc.stderr).text()
  const exitCode = await proc.exited
  return { exitCode, stdout, stderr }
}

export interface ReleaseOptions {
  dryRun?: boolean
  runCommandFn?: (cmd: string[]) => Promise<RunResult>
  cwd?: string
}

export async function release(
  versionInput: string,
  options: ReleaseOptions = {}
): Promise<void> {
  if (!versionInput) throw new Error("Version is required")
  const version = parseVersion(versionInput)
  const cwd = options.cwd ?? process.cwd()
  const run = options.runCommandFn
    ? (cmd: string[]) => options.runCommandFn!(cmd)
    : (cmd: string[]) => runCommand(cmd, { cwd })

  console.log(`\n[release] Starting release for ${version.tag}\n`)

  // Step 0 (NEW): Preflight checks — fail fast on bad state.
  console.log("[release] Step 0/8: Preflight checks")
  if (!options.dryRun) {
    // Ensure git tree is clean (no uncommitted changes that would conflict with the bump)
    const statusResult = await run(["git", "status", "--porcelain", "--untracked-files=no"])
    if (statusResult.stdout.trim().length > 0) {
      throw new Error(`Git tracked tree has uncommitted changes. Commit or stash first:\n${statusResult.stdout}`)
    }
    // Ensure tag doesn't already exist
    const tagCheck = await run(["git", "rev-parse", "--verify", `--quiet`, version.tag])
    if (tagCheck.exitCode === 0) {
      throw new Error(`Tag ${version.tag} already exists. Delete it first or use a different version.`)
    }
  }

  // Step 1: Bump version in package.json
  console.log("[release] Step 1/8: Bumping version in package.json")
  const pkgPath = resolve(cwd, "package.json")
  const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"))
  pkg.version = `${version.major}.${version.minor}.${version.patch}`
  if (!options.dryRun) {
    writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n")
  }

  // Step 1b (NEW): Commit the version bump
  console.log("[release] Step 1b/8: Committing version bump")
  if (!options.dryRun) {
    const addResult = await run(["git", "add", "package.json"])
    if (addResult.exitCode !== 0) {
      throw new Error(`git add package.json failed: ${addResult.stderr}`)
    }
    // v0.43.0: skip the commit if package.json was already at this version
    // (PR #11 may have landed the bump commit before the script ran).
    const statusCheck = await run(["git", "status", "--porcelain", "--untracked-files=no"])
    if (statusCheck.stdout.trim().length === 0) {
      console.log(`[release] (skip commit: package.json already at ${version.tag}, no changes)`)
    } else {
      const commitResult = await run(["git", "commit", "-m", `chore(release): bump version to ${version.tag}`])
      if (commitResult.exitCode !== 0) {
        throw new Error(`git commit failed: ${commitResult.stderr}`)
      }
    }
  }

  // Step 2: Validate CHANGELOG (now with version-specific check)
  console.log("[release] Step 2/8: Validating CHANGELOG")
  validateChangelog(resolve(cwd, "CHANGELOG.md"), version)

  // Step 3: Run tests
  console.log("[release] Step 3/8: Running tests")
  if (!options.dryRun) {
    const result = await run(["bun", "test"])
    if (result.exitCode !== 0) {
      throw new Error(`Tests failed (exit ${result.exitCode}):\n${result.stdout}\n${result.stderr}`)
    }
  } else {
    console.log("[release] (dry-run: skipped tests)")
  }

  // Step 4: Build
  console.log("[release] Step 4/8: Building")
  if (!options.dryRun) {
    const result = await run(["bun", "run", "build"])
    if (result.exitCode !== 0) {
      throw new Error(`Build failed (exit ${result.exitCode}):\n${result.stdout}\n${result.stderr}`)
    }
  } else {
    console.log("[release] (dry-run: skipped build)")
  }

  // Step 5: npm publish
  console.log("[release] Step 5/8: Publishing to npm")
  if (!options.dryRun) {
    const result = await run(["npm", "publish"])
    if (result.exitCode !== 0) {
      throw new Error(`npm publish failed (exit ${result.exitCode}):\n${result.stdout}\n${result.stderr}`)
    }
  } else {
    console.log("[release] (dry-run: skipped npm publish)")
  }

  // Step 6: git tag + push
  console.log("[release] Step 6/8: Creating git tag")
  if (!options.dryRun) {
    let result = await run(["git", "tag", version.tag])
    if (result.exitCode !== 0) {
      throw new Error(`git tag failed (exit ${result.exitCode}):\n${result.stdout}\n${result.stderr}`)
    }
    result = await run(["git", "push", "origin", version.tag])
    if (result.exitCode !== 0) {
      throw new Error(`git push tag failed (exit ${result.exitCode}):\n${result.stdout}\n${result.stderr}`)
    }
  } else {
    console.log("[release] (dry-run: skipped git tag + push)")
  }

  // Step 7: GitHub release — extract the version-specific CHANGELOG section
  console.log("[release] Step 7/8: Creating GitHub release")
  const notesFile = resolve(cwd, `.release-notes-${version.tag}.md`)
  const changelog = readFileSync(resolve(cwd, "CHANGELOG.md"), "utf-8")
  const versionStr = `${version.major}.${version.minor}.${version.patch}`
  const versionSection = changelog.split(`## [${versionStr}]`)[1]?.split("## [")[0] ?? ""
  const fullSection = `## [${versionStr}]${versionSection}`
  if (!options.dryRun) {
    writeFileSync(notesFile, fullSection)
    try {
      const result = await run([
        "gh", "release", "create", version.tag,
        "--repo", "herjarsa/omo-meta-governor",
        "--title", `${version.tag} — automated release`,
        "--notes-file", notesFile,
      ])
      if (result.exitCode !== 0) {
        throw new Error(`gh release create failed (exit ${result.exitCode}):\n${result.stdout}\n${result.stderr}`)
      }
    } finally {
      if (existsSync(notesFile)) unlinkSync(notesFile)
    }
  } else {
    console.log("[release] (dry-run: skipped gh release create)")
  }

  // Step 8 (FIXED): Verification — confirm the publish + tag actually happened.
// npm registry can take 30-60s to propagate after `npm publish` returns
// success. Retry up to 3 times with exponential backoff (5s, 10s, 20s).
// If still stale after retries, log a warning but DON'T throw — the publish,
// tag push, and GitHub release all already succeeded at this point. The
// verification is best-effort sanity check, not a hard gate.
console.log("[release] Step 8/8: Verifying release")
if (!options.dryRun) {
  const maxAttempts = 3
  const delays = [5000, 10000, 20000] // ms before retry 1, 2, 3 (total max ~35s wait)
  let verified = false
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const npmCheck = await run(["npm", "view", `@herjarsa/omo-meta-governor`, "version"])
    if (npmCheck.stdout.includes(versionStr)) {
      verified = true
      if (attempt > 1) {
        console.log(`[release] ✅ Verified on attempt ${attempt}/${maxAttempts} (npm propagation caught up)`)
      }
      break
    }
    if (attempt < maxAttempts) {
      const delay = delays[attempt - 1]
      console.log(`[release] npm view returned "${npmCheck.stdout.trim()}" (attempt ${attempt}/${maxAttempts}); waiting ${delay / 1000}s before retry (npm propagation delay)...`)
      await new Promise((r) => setTimeout(r, delay))
    } else {
      console.log(`[release] ⚠️ npm view still shows "${npmCheck.stdout.trim()}" after ${maxAttempts} attempts.`)
      console.log(`[release]    This may be a registry propagation delay (try \`npm view @herjarsa/omo-meta-governor version\` manually in a few minutes).`)
      console.log(`[release]    The earlier npm publish + git tag + gh release create all returned success.`)
    }
  }
}

  console.log(`\n[release] ✅ Release ${version.tag} complete\n`)
}

if (import.meta.main) {
  // Parse CLI args: positional = version, --dry-run = flag
  const args = process.argv.slice(2)
  const dryRun = args.includes("--dry-run")
  const versionArg = args.find((a) => !a.startsWith("--"))
  if (!versionArg) {
    console.error("Usage: bun run release <version> [--dry-run]")
    console.error("Example: bun run release 0.38.0")
    console.error("Example: bun run release 0.38.0 --dry-run")
    process.exit(1)
  }
  release(versionArg, { dryRun }).catch((err) => {
    console.error(`\n[release] ❌ ${err.message}\n`)
    process.exit(1)
  })
}