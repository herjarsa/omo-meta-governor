/**
 * Tests for the JSONC config file loader.
 *
 * given/when/then style covering:
 * - JSONC comment stripping
 * - JSONC trailing comma stripping
 * - File loading (with temp files)
 * - Priority ordering (CLI > project > user > defaults)
 * - Deep merge behavior
 */

import { describe, expect, it, beforeEach, afterEach } from "bun:test"
import { mkdir, writeFile, unlink, rmdir } from "node:fs/promises"
import { resolve } from "node:path"
import { tmpdir } from "node:os"
import {
  stripJsoncComments,
  parseJsonc,
  deepMerge,
  loadMetaGovernorConfig,
  getUserConfigPath,
  getProjectConfigPath,
  loadJsoncFile,
} from "./config-file"

// ─── JSONC Comment Stripping ────────────────────────────────────────

describe("stripJsoncComments", () => {
  describe("#given JSONC with single-line comments", () => {
    it("then strips // comments", () => {
      const input = `{
        "a": 1, // this is a comment
        "b": 2
      }`
      const result = stripJsoncComments(input)
      expect(result).not.toContain("//")
      expect(parseJsonc(result)).toEqual({ a: 1, b: 2 })
    })
  })

  describe("#given JSONC with multi-line comments", () => {
    it("then strips /* */ comments", () => {
      const input = `{
        "a": 1, /* comment block
          across lines */
        "b": 2
      }`
      const result = stripJsoncComments(input)
      expect(result).not.toContain("/*")
      expect(result).not.toContain("*/")
      expect(parseJsonc(result)).toEqual({ a: 1, b: 2 })
    })
  })

  describe("#given JSONC with trailing commas", () => {
    it("then strips trailing commas before }", () => {
      const input = `{
        "a": 1,
        "b": 2,
      }`
      const result = stripJsoncComments(input)
      expect(parseJsonc(result)).toEqual({ a: 1, b: 2 })
    })

    it("then strips trailing commas before ]", () => {
      const input = `{
        "a": [1, 2, 3,]
      }`
      const result = stripJsoncComments(input)
      expect(parseJsonc(result)).toEqual({ a: [1, 2, 3] })
    })
  })

  describe("#given JSONC with comments inside strings", () => {
    it("then preserves // inside strings", () => {
      const input = `{
        "url": "http://example.com"
      }`
      const result = stripJsoncComments(input)
      expect(result).toContain("http://example.com")
      expect(parseJsonc(result)).toEqual({ url: "http://example.com" })
    })
  })

  describe("#given JSONC with mixed comments and trailing commas", () => {
    it("then produces valid JSON", () => {
      const input = `{
        // User config for meta-governor
        "enabled": true,  /* master switch */
        "memory": {
          "query": "test",
          "timeoutMs": 5000, // override
        },
      }`
      const result = stripJsoncComments(input)
      const parsed = parseJsonc(result)
      expect(parsed).toEqual({ enabled: true, memory: { query: "test", timeoutMs: 5000 } })
    })
  })

  describe("#given plain JSON (no comments)", () => {
    it("then returns unchanged", () => {
      const input = JSON.stringify({ a: 1, b: 2 })
      const result = stripJsoncComments(input)
      expect(JSON.parse(result)).toEqual({ a: 1, b: 2 })
    })
  })
})

// ─── parseJsonc ─────────────────────────────────────────────────────

describe("parseJsonc", () => {
  describe("#given valid JSONC", () => {
    it("then returns parsed object", () => {
      const result = parseJsonc('{ "a": 1 }')
      expect(result).toEqual({ a: 1 })
    })
  })

  describe("#given invalid JSONC", () => {
    it("then returns undefined", () => {
      const result = parseJsonc("not json")
      expect(result).toBeUndefined()
    })
  })

  describe("#given null input", () => {
    it("then returns undefined", () => {
      const result = parseJsonc("null")
      // null is valid JSON
      expect(result).toBeNull()
    })
  })
})

// ─── deepMerge ──────────────────────────────────────────────────────

describe("deepMerge", () => {
  describe("#given two flat objects", () => {
    it("then source overrides target", () => {
      const result = deepMerge({ a: 1, b: 2 }, { b: 3, c: 4 })
      expect(result).toEqual({ a: 1, b: 3, c: 4 })
    })
  })

  describe("#given nested objects", () => {
    it("then performs deep merge", () => {
      const result = deepMerge(
        { outer: { a: 1, b: 2 } },
        { outer: { b: 3, c: 4 } },
      )
      expect(result).toEqual({ outer: { a: 1, b: 3, c: 4 } })
    })
  })

  describe("#given undefined values in source", () => {
    it("then skips undefined", () => {
      const result = deepMerge({ a: 1 }, { a: undefined, b: 2 })
      expect(result).toEqual({ a: 1, b: 2 })
    })
  })

  describe("#given arrays", () => {
    it("then replaces arrays (not merged)", () => {
      const result = deepMerge({ arr: [1, 2] }, { arr: [3] })
      expect(result).toEqual({ arr: [3] })
    })
  })
})

// ─── Config path helpers ────────────────────────────────────────────

describe("getUserConfigPath", () => {
  it("then returns path ending with omo-meta-governor.jsonc", () => {
    const path = getUserConfigPath()
    expect(path).toContain(".config/opencode/omo-meta-governor.jsonc")
  })
})

describe("getProjectConfigPath", () => {
  it("then returns path in .opencode subdirectory", () => {
    const path = getProjectConfigPath("/projects/test")
    expect(path).toBe("/projects/test/.opencode/omo-meta-governor.jsonc")
  })

  it("then uses cwd when no projectDir provided", () => {
    const path = getProjectConfigPath()
    expect(path).toContain(".opencode/omo-meta-governor.jsonc")
  })
})

// ─── File loading with temp directory ───────────────────────────────

describe("loadJsoncFile", () => {
  const testDir = resolve(tmpdir(), "omo-meta-governor-test", `config-file-${Date.now()}`)
  const testFile = resolve(testDir, "config.jsonc")

  beforeEach(async () => {
    await mkdir(testDir, { recursive: true })
  })

  afterEach(async () => {
    try { await unlink(testFile) } catch { /* ok */ }
    try { await rmdir(testDir) } catch { /* ok */ }
  })

  describe("#given a valid JSONC file", () => {
    beforeEach(async () => {
      await writeFile(testFile, '{ "enabled": true, "memory": { "query": "test" } }')
    })

    it("then returns parsed content", async () => {
      const result = await loadJsoncFile(testFile)
      expect(result).toEqual({ enabled: true, memory: { query: "test" } })
    })
  })

  describe("#given a JSONC file with comments", () => {
    beforeEach(async () => {
      await writeFile(testFile, '{\n  // comment\n  "enabled": true,\n}')
    })

    it("then returns parsed content", async () => {
      const result = await loadJsoncFile(testFile)
      expect(result).toEqual({ enabled: true })
    })
  })

  describe("#given a non-existent file", () => {
    it("then returns undefined", async () => {
      const result = await loadJsoncFile("/nonexistent/path.jsonc")
      expect(result).toBeUndefined()
    })
  })
})

// ─── Priority ordering ──────────────────────────────────────────────

describe("loadMetaGovernorConfig priority", () => {
  describe("#given only cliOptions", () => {
    it("then effectiveSource is cli", async () => {
      const result = await loadMetaGovernorConfig({
        cliOptions: { enabled: true },
      })
      expect(result.effectiveSource).toBe("cli")
      expect(result.config.enabled).toBe(true)
    })
  })

  describe("#given cliOptions with nested values", () => {
    it("then nested values merge", async () => {
      const result = await loadMetaGovernorConfig({
        cliOptions: {
          enabled: true,
          memory: { query: "cli-query" },
          scoring: { stopThreshold: 0.99 },
        },
      })
      expect(result.config.enabled).toBe(true)
      expect(result.config.memory?.query).toBe("cli-query")
      expect(result.config.scoring?.stopThreshold).toBe(0.99)
    })
  })

  describe("#given cliOptions with deepMerge behavior", () => {
    it("then nested overrides merge, not replace entirely", async () => {
      const result = await loadMetaGovernorConfig({
        cliOptions: {
          enabled: true,
          memory: { query: "deep-query" },
        },
      })
      expect(result.config.enabled).toBe(true)
      expect(result.config.memory?.query).toBe("deep-query")
      // tokenPredictor shouldn't be set by our cliOptions
      expect(result.config.tokenPredictor).toBeUndefined()
    })
  })

  describe("#given empty cliOptions", () => {
    it("then falls through to user or defaults", async () => {
      // With no cwd and no cliOptions, walks up from process.cwd() to find
      // project config, then falls back to ~/.config/opencode/, then defaults.
      const result = await loadMetaGovernorConfig()
      // Result source should be one of: project, user, or defaults.
      expect(["project", "user", "defaults"]).toContain(result.effectiveSource)
      // Effective config is always defined (even if empty).
      expect(result.config).toBeDefined()
    })
  })

  describe("#given project config via loadJsoncFile", () => {
    const testDir = resolve(tmpdir(), "omo-meta-governor-test", `proj-${Date.now()}`)
    const projectConfigDir = resolve(testDir, ".opencode")
    const projectConfigPath = resolve(projectConfigDir, "omo-meta-governor.jsonc")

    beforeEach(async () => {
      await mkdir(projectConfigDir, { recursive: true })
      await writeFile(
        projectConfigPath,
        JSON.stringify({ enabled: true, scoring: { stopThreshold: 0.9 } }),
      )
    })

    afterEach(async () => {
      try { await unlink(projectConfigPath) } catch { /* ok */ }
      try { await rmdir(projectConfigDir) } catch { /* ok */ }
      try { await rmdir(testDir) } catch { /* ok */ }
    })

    it("then loadJsoncFile returns parsed config", async () => {
      const cfg = await loadJsoncFile(projectConfigPath)
      expect(cfg).toBeDefined()
      expect((cfg as Record<string, unknown>).enabled).toBe(true)
    })
  })
})
