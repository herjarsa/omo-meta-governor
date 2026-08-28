// scripts/release.ts
// Automates the AGENTS.md ship protocol: bump version, validate CHANGELOG,
// run tests, build, publish, tag, release. Aborts on any step failure.
//
// Usage: bun run release 0.38.0
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

export function validateChangelog(changelogPath: string): void {
  if (!existsSync(changelogPath)) {
    throw new Error(`CHANGELOG not found: ${changelogPath}`)
  }
  const content = readFileSync(changelogPath, "utf-8")
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

  // Step 1: Bump version in package.json
  console.log("[release] Step 1/7: Bumping version in package.json")
  const pkgPath = resolve(cwd, "package.json")
  const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"))
  pkg.version = `${version.major}.${version.minor}.${version.patch}`
  if (!options.dryRun) {
    writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n")
  }

  // Step 2: Validate CHANGELOG
  console.log("[release] Step 2/7: Validating CHANGELOG")
  validateChangelog(resolve(cwd, "CHANGELOG.md"))

// Step 3: Run tests
  console.log("[release] Step 3/7: Running tests")
  if (!options.dryRun) {
let result = await run(["bun", "test"])
if (result.exitCode !== 0) {
throw new Error(`Tests failed (exit ${result.exitCode}):\n${result.stdout}\n${result.stderr}`)
  }
  } else {
    console.log("[release] (dry-run: skipped tests)")
  }

// Step 4: Build
  console.log("[release] Step 4/7: Building")
  if (!options.dryRun) {
    let
result = await run(["bun", "run", "build"])
if (result.exitCode !== 0) {
throw new Error(`Build failed (exit ${result.exitCode}):\n${result.stdout}\n${result.stderr}`)
  }
  } else {
    console.log("[release] (dry-run: skipped build)")
  }

  // Step 5: npm publish
  console.log("[release] Step 5/7: Publishing to npm")
  if (!options.dryRun) {
    result = await run(["npm", "publish"])
    if (result.exitCode !== 0) {
      throw new Error(`npm publish failed (exit ${result.exitCode}):\n${result.stdout}\n${result.stderr}`)
    }
  } else {
    console.log("[release] (dry-run: skipped npm publish)")
  }

  // Step 6: git tag
  console.log("[release] Step 6/7: Creating git tag")
  if (!options.dryRun) {
    result = await run(["git", "tag", version.tag])
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

  // Step 7: GitHub release
  console.log("[release] Step 7/7: Creating GitHub release")
  const notesFile = resolve(cwd, `.release-notes-${version.tag}.md`)
  const changelog = readFileSync(resolve(cwd, "CHANGELOG.md"), "utf-8")
  // Extract the most recent version section
  const versionSectionText = changelog.split(`## [`)[1]?.split("##")[0] ?? ""
  const fullSection = `## [${versionSectionText}`
  if (!options.dryRun) {
    writeFileSync(notesFile, fullSection)
    try {
      result = await run([
        "gh", "release", "create", version.tag,
        "--repo", "herjarsa/omo-meta-governor",
        "--title", `${version.tag} — automated release`,
        "--notes-file", notesFile,
      ])
      if (result.exitCode !== 0) {
        throw new Error(`gh release create failed (exit ${result.exitCode}):\n${result.stdout}\n${result.stderr}`)
      }
    } finally {
      // Cleanup notes file
      if (existsSync(notesFile)) unlinkSync(notesFile)
    }
  } else {
    console.log("[release] (dry-run: skipped gh release create)")
  }

  console.log(`\n[release] ✅ Release ${version.tag} complete\n`)
}

if (import.meta.main) {
  const versionArg = process.argv[2]
  if (!versionArg) {
    console.error("Usage: bun run release <version>")
    console.error("Example: bun run release 0.38.0")
    process.exit(1)
  }
  release(versionArg).catch((err) => {
    console.error(`\n[release] ❌ ${err.message}\n`)
    process.exit(1)
  })
}
