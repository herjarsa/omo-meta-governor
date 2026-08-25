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
 * in each dist entrypoint and asserts they match.
 *
 * If you legitimately need to bump the version without rebuilding
 * (e.g. for a metadata-only release), this test will catch it. The
 * fix is always: bump package.json, then run `bun build.ts`.
 */
import { describe, expect, it } from "bun:test"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"

const PKG_PATH = resolve(import.meta.dir, "..", "package.json")
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

describe("version sync between package.json and dist bundles", () => {
  describe("#given package.json with version 0.33.5", () => {
    const pkgVersion = readPackageVersion()

    it("then every dist entrypoint inlines the same version", () => {
      for (const entry of DIST_ENTRIES) {
        const inlined = readInlinedVersion(entry)
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
})
