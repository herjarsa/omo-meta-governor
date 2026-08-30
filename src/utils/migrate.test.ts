/**
 * v0.39.0 — tests for src/utils/migrate.ts
 *
 * Covers: oldPluginPaths/newPluginPaths shape, migrateOldToNew idempotency,
 * readOpencodeJsonc parse fallback, patchInstructionsArray append/idempotent,
 * JSONC comment stripping.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test"
import { mkdtempSync, writeFileSync, mkdirSync, existsSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  oldPluginPaths,
  newPluginPaths,
  migrateOldToNew,
  readOpencodeJsonc,
  patchInstructionsArray,
} from "./migrate"

let baseDir: string

beforeEach(() => {
  baseDir = mkdtempSync(join(tmpdir(), "omo-migrate-test-"))
})

afterEach(() => {
  // best-effort cleanup
})

describe("migrate — path helpers", () => {
  test("oldPluginPaths returns absolute paths ending in legacy filenames", () => {
    const p = oldPluginPaths(baseDir)
    expect(p.log.endsWith("meta-governor.log")).toBe(true)
    expect(p.health.endsWith("meta-governor-health.json")).toBe(true)
    expect(p.selfVersionCache.endsWith("omo-meta-governor-self-version-cache.json")).toBe(true)
    expect(p.upgradeCheck.endsWith("omo-meta-governor-upgrade-check.json")).toBe(true)
    expect(p.cliAnythingUpgradeCheck.endsWith("omo-cli-anything-upgrade-check.json")).toBe(true)
  })

  test("newPluginPaths places everything under plugins/omo-meta-governor/", () => {
    const p = newPluginPaths(baseDir)
    expect(p.pluginDir).toContain("plugins")
    expect(p.pluginDir).toContain("omo-meta-governor")
    expect(p.log.endsWith("meta-governor.log")).toBe(true)
    expect(p.health.endsWith("health.json")).toBe(true)
    expect(p.instructions.endsWith("instructions.md")).toBe(true)
    expect(p.config.endsWith("config.json")).toBe(true)
    expect(p.logDir).toBe(join(p.pluginDir, "log"))
    expect(p.cacheDir).toBe(join(p.pluginDir, "cache"))
  })

  test("default base (no arg) points to ~/.config/opencode", () => {
    const def = oldPluginPaths()
    expect(def.log).toContain(".config")
    expect(def.log).toContain("opencode")
  })
})

describe("migrate — migrateOldToNew", () => {
  test("no old files → migrated empty, skipped lists each missing path", () => {
    const result = migrateOldToNew({ oldPaths: oldPluginPaths(baseDir), newPaths: newPluginPaths(baseDir) })
    expect(result.migrated).toEqual([])
    expect(result.skipped.length).toBe(5)
  })

  test("migrates single old file to new path with same content", () => {
    const old = oldPluginPaths(baseDir)
    const next = newPluginPaths(baseDir)
    writeFileSync(old.log, "old log content\n", "utf8")

    const result = migrateOldToNew({ oldPaths: old, newPaths: next })

    expect(result.migrated).toContain(old.log)
    expect(existsSync(old.log)).toBe(false)
    expect(existsSync(next.log)).toBe(true)
    expect(readFileSync(next.log, "utf8")).toBe("old log content\n")
  })

  test("migrates all 5 old paths in one pass", () => {
    const old = oldPluginPaths(baseDir)
    const next = newPluginPaths(baseDir)
    writeFileSync(old.log, "L", "utf8")
    writeFileSync(old.health, '{"ok":true}', "utf8")
    writeFileSync(old.selfVersionCache, '{"v":"0.38.9"}', "utf8")
    writeFileSync(old.upgradeCheck, '{"latest":"x"}', "utf8")
    writeFileSync(old.cliAnythingUpgradeCheck, '{"latest":"y"}', "utf8")

    const result = migrateOldToNew({ oldPaths: old, newPaths: next })

    expect(result.migrated.length).toBe(5)
    expect(existsSync(next.log)).toBe(true)
    expect(existsSync(next.health)).toBe(true)
    expect(existsSync(next.selfVersionCache)).toBe(true)
    expect(existsSync(next.upgradeCheck)).toBe(true)
    expect(existsSync(next.cliAnythingUpgradeCheck)).toBe(true)
  })

  test("idempotent — second call returns empty migrated", () => {
    const old = oldPluginPaths(baseDir)
    const next = newPluginPaths(baseDir)
    writeFileSync(old.log, "L", "utf8")
    migrateOldToNew({ oldPaths: old, newPaths: next })

    const second = migrateOldToNew({ oldPaths: old, newPaths: next })
    expect(second.migrated).toEqual([])
  })

  test("creates parent directories as needed", () => {
    const old = oldPluginPaths(baseDir)
    const next = newPluginPaths(baseDir)
    writeFileSync(old.upgradeCheck, "{}", "utf8")
    // sanity: cache dir does not exist yet
    expect(existsSync(next.cacheDir)).toBe(false)

    migrateOldToNew({ oldPaths: old, newPaths: next })

    expect(existsSync(next.cacheDir)).toBe(true)
    expect(existsSync(next.upgradeCheck)).toBe(true)
  })
})

describe("migrate — readOpencodeJsonc", () => {
  test("non-existent file returns exists:false", () => {
    const r = readOpencodeJsonc(join(baseDir, "missing.jsonc"))
    expect(r.exists).toBe(false)
  })

  test("valid JSON file parses", () => {
    const p = join(baseDir, "ok.jsonc")
    writeFileSync(p, '{"instructions": ["a.md"]}', "utf8")
    const r = readOpencodeJsonc(p)
    expect(r.exists).toBe(true)
    expect(r.error).toBeUndefined()
    expect(r.data).toEqual({ instructions: ["a.md"] })
  })

  test("invalid JSON returns error, no throw", () => {
    const p = join(baseDir, "bad.jsonc")
    writeFileSync(p, "{ not valid", "utf8")
    const r = readOpencodeJsonc(p)
    expect(r.exists).toBe(true)
    expect(r.error).toBeDefined()
    expect(r.data).toBeUndefined()
  })

  test("strips // line comments before parsing", () => {
    const p = join(baseDir, "commented.jsonc")
    writeFileSync(p, '// header\n{ "a": 1 }\n// tail', "utf8")
    const r = readOpencodeJsonc(p)
    expect(r.error).toBeUndefined()
    expect(r.data).toEqual({ a: 1 })
  })

  test("strips /* block */ comments before parsing", () => {
    const p = join(baseDir, "block.jsonc")
    writeFileSync(p, '/* hi */ { "b": 2 } /* bye */', "utf8")
    const r = readOpencodeJsonc(p)
    expect(r.data).toEqual({ b: 2 })
  })
})

describe("migrate — patchInstructionsArray", () => {
  test("non-existent file returns error", () => {
    const r = patchInstructionsArray(join(baseDir, "nope.jsonc"), "plugins/omo-meta-governor/instructions.md")
    expect(r.error).toBeDefined()
  })

  test("adds instructions key when missing", () => {
    const p = join(baseDir, "opencode.jsonc")
    writeFileSync(p, '{ "theme": "dark" }', "utf8")
    const r = patchInstructionsArray(p, "plugins/omo-meta-governor/instructions.md")
    expect(r.changed).toBe(true)
    expect(r.wrote).toBe(true)
    const data = JSON.parse(readFileSync(p, "utf8"))
    expect(data.instructions).toEqual(["plugins/omo-meta-governor/instructions.md"])
    expect(data.theme).toBe("dark")
  })

  test("appends when instructions array exists without target path", () => {
    const p = join(baseDir, "opencode.jsonc")
    writeFileSync(p, '{ "instructions": ["other.md"] }', "utf8")
    const r = patchInstructionsArray(p, "plugins/omo-meta-governor/instructions.md")
    expect(r.changed).toBe(true)
    const data = JSON.parse(readFileSync(p, "utf8"))
    expect(data.instructions).toEqual(["other.md", "plugins/omo-meta-governor/instructions.md"])
  })

  test("no-op when instructions array already contains target", () => {
    const p = join(baseDir, "opencode.jsonc")
    writeFileSync(p, '{ "instructions": ["plugins/omo-meta-governor/instructions.md"] }', "utf8")
    const r = patchInstructionsArray(p, "plugins/omo-meta-governor/instructions.md")
    expect(r.changed).toBe(false)
    expect(r.wrote).toBe(false)
  })

  test("treats malformed JSON as error, does not write", () => {
    const p = join(baseDir, "bad.jsonc")
    writeFileSync(p, "{ broken", "utf8")
    const r = patchInstructionsArray(p, "plugins/omo-meta-governor/instructions.md")
    expect(r.changed).toBe(false)
    expect(r.error).toBeDefined()
    // file untouched
    expect(readFileSync(p, "utf8")).toBe("{ broken")
  })
})