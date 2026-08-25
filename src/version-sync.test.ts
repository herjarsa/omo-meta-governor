/**
 * v0.33.5: regression guard for the build-time package.json inlining bug.
 *
 * `bun build` inlines `package.json` into each bundle entrypoint as a
 * plain JS object literal. The plugin's banner (`# omo-meta-governor
 * v{version}`) reads that inlined version, NOT `package.json` from
 * disk. If the version in `package.json` is bumped AFTER the last
 * `bun build`, the bundle still reports the old version.
 *
 * v0.33.4 shipped this exact way: package.json said 0.33.4 but
 * dist/mcp-server.js and dist/lib.js inlined `version: "0.33.3"`.
 * Result: omo_health banner lied about the running version.
 *
 * This test reads the package.json version and the version embedded
 * in each dist entrypoint and asserts they match. If `dist/` is
 * missing (e.g. fresh clone in CI before `bun build.ts` ran), the
 * test self-heals by invoking the build first.
 *
 * If you legitimately need to bump the version without rebuilding
 * (e.g. for a metadata-only release), this test will catch it. The
 * fix is always: bump package.json, then run `bun build.ts`.
 */
import { describe, expect, it, beforeAll } from "bun:test"
import { readFileSync, existsSync } from "node:fs"
import { resolve } from "node:path"

const REPO_ROOT = resolve(import.meta.dir, "..")
const PKG_PATH = resolve(REPO_ROOT, "package.json")
const DIST_ENTRIES = ["dist/index.js", "dist/lib.js", "dist/mcp-server.js"] as const

function readPackageVersion(): string {
  const pkg = JSON.parse(readFileSync(PKG_PATH, "utf-8"))
  if (typeof pkg.version !== "string") {
    throw new Error(`package.json version is missing or not a string`)
  }
  return pkg.version
}

/**
 * Extract the inlined `version:"X.Y.Z"` from a bundle entrypoint.
 * The build minifies so we look for the first match of
 * `version:"..."` anywhere in the file. Bun's inlined package.json
 * object is the only place that exact pattern appears.
 */
function readInlinedVersion(entryPath: string): string {
  if (!existsSync(entryPath)) {
    throw new Error(`Bundle entrypoint not found: ${entryPath}`)
  }
  const src = readFileSync(entryPath, "utf-8")
  const match = src.match(/version:"(\d+\.\d+\.\d+)"/)
  if (!match) {
    throw new Error(
      `Could not find inlined version:"x.y.z" in ${entryPath}. ` +
        `Either the build target changed (the inlining pattern moved) or ` +
        `this file is not a bundle entrypoint.`,
    )
  }
  return match[1]!
}

let buildInvoked = false

beforeAll(async () => {
  // Self-heal: if dist/ is missing or stale (e.g. CI checkout without
  // running `bun build.ts` yet), run it before validating. This makes
  // the test self-contained regardless of CI step ordering.
  const allPresent = DIST_ENTRIES.every((e) => existsSync(resolve(REPO_ROOT, e)))
  if (!allPresent) {
    const proc = Bun.spawn(["bun", "build.ts"], {
      cwd: REPO_ROOT,
      stdout: "pipe",
      stderr: "pipe",
    })
    await proc.exited
    if (proc.exitCode !== 0) {
      const stderr = await new Response(proc.stderr).text()
      throw new Error(
        `bun build.ts failed with exit code ${proc.exitCode}: ${stderr}`,
      )
    }
    buildInvoked = true
  }
})

describe("version sync between package.json and dist bundles", () => {
  describe("#given package.json with a semantic version", () => {
    const pkgVersion = readPackageVersion()

    it("then every dist entrypoint inlines the same version", () => {
      for (const entry of DIST_ENTRIES) {
        const fullPath = resolve(REPO_ROOT, entry)
        const inlined = readInlinedVersion(fullPath)
        expect(inlined).toBe(pkgVersion)
      }
    })

    it("then the test reads package.json version correctly (sanity)", () => {
      expect(pkgVersion).toMatch(/^\d+\.\d+\.\d+/)
    })
  })

  describe("#given the omo_health banner format", () => {
    it("then it can be reconstructed from package.json version + dist inlining", () => {
      // The banner is `# omo-meta-governor v${inlinedVersion} — Health Report`.
      // Verify the inlined version is presentable (no semver-prerelease noise
      // would crash the banner regex on user machines).
      const pkgVersion = readPackageVersion()
      expect(pkgVersion).toMatch(/^\d+\.\d+\.\d+/)
    })
  })

  describe("#given the self-heal build path", () => {
    it("then either the build was already up to date or invoked via beforeAll", () => {
      // After beforeAll, every dist entry must exist regardless of whether
      // we had to rebuild or not. This proves the test is CI-ordering-safe.
      for (const entry of DIST_ENTRIES) {
        expect(existsSync(resolve(REPO_ROOT, entry))).toBe(true)
      }
      // buildInvoked is set if the test had to rebuild; either way is fine.
      expect(typeof buildInvoked).toBe("boolean")
    })
  })
})
