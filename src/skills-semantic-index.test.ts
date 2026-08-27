/**
 * skills-semantic-index.test.ts - unit tests for the v0.35.8 semantic index.
 * Embedding calls are mocked via the deps.fetch hook so tests run offline.
 */
import { describe, expect, it, beforeEach, afterEach } from "bun:test"
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  setGlobalSkillsRootOverride,
} from "./skills-catalog"
import {
  buildOrUpdateIndex,
  semanticSearch,
  setCachePathOverride,
  type IndexDeps,
} from "./skills-semantic-index"

const _tmpHomes: string[] = []
function fakeHome(): string {
  const p = mkdtempSync(join(tmpdir(), "omo-sem-"))
  _tmpHomes.push(p)
  return p
}

afterEach(() => {
  setGlobalSkillsRootOverride(null)
  setCachePathOverride(null)
  while (_tmpHomes.length > 0) {
    const p = _tmpHomes.pop()!
    try { rmSync(p, { recursive: true, force: true }) } catch {}
  }
})

/** Mock fetch: echoes a 4-dim vector based on text length (deterministic). */
function mockFetch(rng: number[] = [0.1, 0.2, 0.3, 0.4]): typeof fetch {
  return (async (input: any, init: any) => {
    const body = JSON.parse(init.body)
    const data = body.input.map((s: string, i: number) => {
      // Different vectors per input so cosine ranks them meaningfully.
      const offset = (s.length % 4) * 0.1
      return {
        object: "embedding",
        embedding: [rng[0] + offset, rng[1] - offset, rng[2] + offset, rng[3] - offset],
        index: i,
      }
    })
    return new Response(JSON.stringify({ object: "list", data, model: body.model }), {
      status: 200,
      headers: { "content-type": "application/json" },
    })
  }) as any
}

function fakeIndexDeps(): IndexDeps {
  // Each test gets its own cache file so the persistent cache does not bleed
  // entries across test runs (which would cause the second test to see N+M
  // hits instead of N).
  const cacheFile = mkdtempSync(join(tmpdir(), "omo-sem-cache-")) + "/idx.json"
  setCachePathOverride(cacheFile)
  return { baseUrl: "http://127.0.0.1:3114/v1", model: "bge-m3", fetch: mockFetch() as any }
}

describe("buildOrUpdateIndex", () => {
  it("then returns an empty index when global cache is empty", async () => {
    const home = fakeHome()
    setGlobalSkillsRootOverride(home)
    const idx = await buildOrUpdateIndex(fakeIndexDeps())
    expect(idx.version).toBe(1)
    expect(Object.keys(idx.skills).length).toBe(0)
  })

  it("then indexes every skill in the global cache and stores embeddings", async () => {
    const home = fakeHome()
    setGlobalSkillsRootOverride(home)
    for (const name of ["alpha", "beta", "gamma"]) {
      mkdirSync(join(home, ".agents", "skills", name), { recursive: true })
      writeFileSync(join(home, ".agents", "skills", name, "SKILL.md"),
        `---\nname: ${name}\ndescription: skill for ${name}\n---\n`)
    }
    const idx = await buildOrUpdateIndex(fakeIndexDeps())
    expect(Object.keys(idx.skills).sort()).toEqual(["alpha", "beta", "gamma"])
    for (const slug of ["alpha", "beta", "gamma"]) {
      expect(idx.skills[slug].embedding).toHaveLength(4)
    }
  })

  it("then reuses the cache when text+mtime are unchanged", async () => {
    const home = fakeHome()
    setGlobalSkillsRootOverride(home)
    mkdirSync(join(home, ".agents", "skills", "stable"), { recursive: true })
    writeFileSync(join(home, ".agents", "skills", "stable", "SKILL.md"),
      `---\nname: stable\ndescription: deterministic\n---\n`)
    const deps = fakeIndexDeps()
    const a = await buildOrUpdateIndex(deps)
    const b = await buildOrUpdateIndex(deps)
    expect(b.skills["stable"].embedding).toEqual(a.skills["stable"].embedding)
  })
})

describe("semanticSearch", () => {
  it("then returns hits sorted by cosine score (descending)", async () => {
    const home = fakeHome()
    setGlobalSkillsRootOverride(home)
    for (const name of ["alpha", "beta"]) {
      mkdirSync(join(home, ".agents", "skills", name), { recursive: true })
      writeFileSync(join(home, ".agents", "skills", name, "SKILL.md"),
        `---\nname: ${name}\ndescription: ${"x".repeat(10 + name.length)}\n---\n`)
    }
    const deps = fakeIndexDeps()
    const hits = await semanticSearch(deps, "alpha", 5)
    expect(hits.length).toBe(2)
    expect(hits[0].score).toBeGreaterThanOrEqual(hits[1].score)
  })

  it("then returns [] when the query is empty", async () => {
    const home = fakeHome()
    setGlobalSkillsRootOverride(home)
    const hits = await semanticSearch(fakeIndexDeps(), "", 5)
    expect(hits).toEqual([])
  })
})