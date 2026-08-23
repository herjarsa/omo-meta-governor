/**
 * Tests for skill dependency storage + registry deps ingestion (v0.32.0 F1-B).
 * IDs: SKD-* (backend), SKB-12..14 (sync ingestion of deps.json shape).
 *
 * Real deps.json shape (verified against skills-library.com):
 * { [depType: string]: { [depName: string]: { skills: string[] } } }
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { SqliteBackend } from "./sqlite-backend"
import { SkillHubSync } from "./skill-hub-sync"

describe("SqliteBackend skill_deps", () => {
  let dbPath: string
  let backend: SqliteBackend

  beforeEach(() => {
    dbPath = join(tmpdir(), `skdeps-${Date.now()}-${Math.random().toString(36).slice(2)}.db`)
    backend = new SqliteBackend(dbPath)
  })

  afterEach(() => {
    try {
      backend.close()
    } catch {
      /* already closed */
    }
  })

  test("SKD-1: replace+get round-trip, sorted by type then name", async () => {
    await backend.skillReplaceDeps("a/b/c", [
      { depType: "pip", depName: "requests" },
      { depType: "npm", depName: "zod" },
      { depType: "npm", depName: "axios" },
    ])
    const deps = await backend.skillGetDeps("a/b/c")
    expect(deps).toEqual([
      { depType: "npm", depName: "axios" },
      { depType: "npm", depName: "zod" },
      { depType: "pip", depName: "requests" },
    ])
  })

  test("SKD-2: replace is idempotent — no duplicate rows on re-run", async () => {
    const deps = [{ depType: "system", depName: "ffmpeg" }]
    await backend.skillReplaceDeps("x/y/z", deps)
    await backend.skillReplaceDeps("x/y/z", deps)
    expect(await backend.skillGetDeps("x/y/z")).toEqual(deps)
  })

  test("SKD-3: replace with empty array clears previous deps", async () => {
    await backend.skillReplaceDeps("x/y/z", [{ depType: "brew", depName: "jq" }])
    await backend.skillReplaceDeps("x/y/z", [])
    expect(await backend.skillGetDeps("x/y/z")).toEqual([])
  })

  test("SKD-4: invalid entries filtered, valid ones kept", async () => {
    await backend.skillReplaceDeps("x/y/z", [
      { depType: "npm", depName: "ok-pkg" },
      { depType: "", depName: "no-type" },
      { depType: "pip", depName: "" },
    ])
    expect(await backend.skillGetDeps("x/y/z")).toEqual([{ depType: "npm", depName: "ok-pkg" }])
  })
})

describe("SkillHubSync.ingestDeps", () => {
  let dbPath: string
  let backend: SqliteBackend
  let sync: SkillHubSync

  beforeEach(() => {
    dbPath = join(tmpdir(), `skdepsi-${Date.now()}-${Math.random().toString(36).slice(2)}.db`)
    backend = new SqliteBackend(dbPath)
    sync = new SkillHubSync({ backend })
  })

  afterEach(() => {
    try {
      backend.close()
    } catch {
      /* already closed */
    }
  })

  const REAL_SHAPE = {
    npm: {
      "npx": { skills: ["vercel-labs/skills/find-skills"] },
      "zod": { skills: ["a/b/one", "a/b/two"] },
    },
    pip: {
      requests: { skills: ["a/b/one"] },
    },
    system: {
      ffmpeg: { skills: ["a/b/two", "c/d/three"] },
    },
  }

  test("SKB-12: walks real shape → per-skill dep rows queryable", async () => {
    const res = await sync.ingestDeps(REAL_SHAPE)
    expect(res.skillsTouched).toBe(4)
    expect(res.depsWritten).toBe(6)
    expect(res.invalidGroups).toBe(0)
    expect(await backend.skillGetDeps("a/b/one")).toEqual([
      { depType: "npm", depName: "zod" },
      { depType: "pip", depName: "requests" },
    ])
    expect(await backend.skillGetDeps("c/d/three")).toEqual([
      { depType: "system", depName: "ffmpeg" },
    ])
  })

  test("SKB-13: non-object inputs → zero-result without throwing", async () => {
    for (const bad of [null, undefined, 42, "str", [], ["x"]]) {
      const res = await sync.ingestDeps(bad)
      expect(res).toEqual({ skillsTouched: 0, depsWritten: 0, invalidGroups: 0 })
    }
  })

  test("SKB-14: re-ingest replaces cleanly — no accumulation", async () => {
    await sync.ingestDeps(REAL_SHAPE)
    const res2 = await sync.ingestDeps({
      npm: { zod: { skills: ["a/b/one"] } },
    })
    expect(res2.skillsTouched).toBeGreaterThanOrEqual(1)
    const one = await backend.skillGetDeps("a/b/one")
    expect(one).toEqual([{ depType: "npm", depName: "zod" }])
    // untouched skill keeps its rows
    expect((await backend.skillGetDeps("c/d/three")).length).toBe(1)
  })

  test("SKB-15: malformed groups counted, well-formed still ingested", async () => {
    const res = await sync.ingestDeps({
      npm: {
        good: { skills: ["a/b/ok"] },
        broken: { notSkills: true },
        alsobroken: "string-instead-of-object",
      },
      emptytype: {},
    })
    expect(res.invalidGroups).toBe(2)
    expect(res.depsWritten).toBe(1)
    expect(await backend.skillGetDeps("a/b/ok")).toEqual([{ depType: "npm", depName: "good" }])
  })
})
