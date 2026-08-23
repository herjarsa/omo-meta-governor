/**
 * Tests for skill-hub sync (v0.32.0) — SKB-* test IDs.
 * Hermetic: real SqliteBackend on a tmp file, no network.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { SqliteBackend } from "./sqlite-backend"
import {
  SkillHubSync,
  skillHubRecordHash,
  type SkillHubSourceRecord,
} from "./skill-hub-sync"

// ---------------------------------------------------------------------------
// Fixture — mirrors skills-library.com/api/skills.json record shape.
// ---------------------------------------------------------------------------

function rec(overrides: Partial<SkillHubSourceRecord> & { id: string; name: string }): SkillHubSourceRecord {
  const segs = overrides.id.split("/")
  const source = segs.length >= 2 ? `${segs[0]}/${segs[1]}` : overrides.id
  const skillId = segs[segs.length - 1]
  return {
    description: `desc for ${overrides.name}`,
    source,
    skillId,
    installs: 100,
    githubStars: 10,
    repoUrl: `https://github.com/${source}`,
    ...overrides,
  }
}

const FIXTURE: SkillHubSourceRecord[] = [
  rec({ id: "obra/superpowers/systematic-debugging", name: "systematic-debugging", installs: 233900 }),
  rec({ id: "obra/superpowers/brainstorming", name: "brainstorming", installs: 180000 }),
  rec({ id: "vercel-labs/skills/find-skills", name: "find-skills", installs: 355500 }),
  rec({ id: "expo/skills/react-native", name: "React Native", installs: 3842 }),
  rec({ id: "anthropics/skills/skill-creator", name: "skill-creator", installs: 95000 }),
  // duplicate slug, different source — kept as distinct row (id differs)
  rec({ id: "jnmetacode/superpowers-zh/systematic-debugging", name: "systematic-debugging", installs: 1000 }),
  // unicode description
  rec({ id: "acme/tools/ñandú", name: "ñandú-check", description: "Chequea ñandúes 🦩" }),
  // zero installs edge
  rec({ id: "acme/tools/brand-new", name: "brand-new", installs: 0 }),
  // null-ish description edge (empty string)
  rec({ id: "acme/tools/no-desc", name: "no-desc", description: "" }),
]

describe("skillHubRecordHash", () => {
  test("SKB-H1: deterministic and sensitive to content", () => {
    const base = { id: "a/b/c", name: "c", description: "d", installs: 1 }
    expect(skillHubRecordHash(base)).toBe(skillHubRecordHash({ ...base }))
    expect(skillHubRecordHash(base)).not.toBe(skillHubRecordHash({ ...base, installs: 2 }))
    expect(skillHubRecordHash(base)).toMatch(/^[a-f0-9]{64}$/)
  })
})

describe("SkillHubSync.ingestBootstrap", () => {
  let dbPath: string
  let backend: SqliteBackend
  let sync: SkillHubSync

  beforeEach(() => {
    dbPath = join(tmpdir(), `skhub-${Date.now()}-${Math.random().toString(36).slice(2)}.db`)
    backend = new SqliteBackend(dbPath)
    sync = new SkillHubSync({ backend })
  })

  afterEach(() => {
    backend.close()
  })

  test("SKB-1: ingests valid records into backend (queryable via skillGet)", async () => {
    const res = await sync.ingestBootstrap(FIXTURE)
    expect(res.invalid).toBe(0)
    expect(res.inserted).toBe(FIXTURE.length)
    expect(res.updated).toBe(0)
    const got = await backend.skillGet("obra/superpowers/systematic-debugging")
    expect(got).not.toBeNull()
    expect(got?.name).toBe("systematic-debugging")
    expect(got?.installs).toBe(233900)
    expect(got?.repo_url).toBe("https://github.com/obra/superpowers")
    expect(got?.content_hash).toBe(
      skillHubRecordHash({
        id: "obra/superpowers/systematic-debugging",
        name: "systematic-debugging",
        description: "desc for systematic-debugging",
        installs: 233900,
      }),
    )
  })

  test("SKB-2: re-ingest unchanged records → skippedUnchanged, no hash drift", async () => {
    await sync.ingestBootstrap(FIXTURE)
    const first = await backend.skillGet("vercel-labs/skills/find-skills")
    const res2 = await sync.ingestBootstrap(FIXTURE)
    expect(res2.skippedUnchanged).toBe(FIXTURE.length)
    expect(res2.inserted).toBe(0)
    expect(res2.updated).toBe(0)
    const second = await backend.skillGet("vercel-labs/skills/find-skills")
    expect(second?.last_synced).toBe(first?.last_synced)
  })

  test("SKB-3: changed installs → updated row with new hash", async () => {
    await sync.ingestBootstrap(FIXTURE)
    const bumped = structuredClone(FIXTURE)
    bumped[3] = { ...bumped[3], installs: 9999 }
    const res = await sync.ingestBootstrap(bumped)
    expect(res.updated).toBe(1)
    expect(res.inserted).toBe(0)
    expect(res.skippedUnchanged).toBe(FIXTURE.length - 1)
    const got = await backend.skillGet("expo/skills/react-native")
    expect(got?.installs).toBe(9999)
  })

  test("SKB-4: invalid records counted, valid ones still ingested", async () => {
    const mixed: SkillHubSourceRecord[] = [
      ...FIXTURE.slice(0, 2),
      { id: "", name: "no-id" },
      { id: "x/y/z" }, // missing name
      { name: "no-id-at-all" },
      { id: 42, name: 43 }, // wrong types
    ]
    const res = await sync.ingestBootstrap(mixed)
    expect(res.invalid).toBe(4)
    expect(res.inserted).toBe(2)
    expect(await backend.skillGet("obra/superpowers/systematic-debugging")).not.toBeNull()
  })

  test("SKB-5: non-array input rejected without throwing", async () => {
    for (const bad of [null, undefined, "str", 42, {}]) {
      const res = await sync.ingestBootstrap(bad)
      expect(res).toEqual({ inserted: 0, updated: 0, skippedUnchanged: 0, invalid: 0 })
    }
  })

  test("SKB-6: empty array is a no-op success", async () => {
    const res = await sync.ingestBootstrap([])
    expect(res).toEqual({ inserted: 0, updated: 0, skippedUnchanged: 0, invalid: 0 })
  })

  test("SKB-7: unicode + empty description round-trip", async () => {
    await sync.ingestBootstrap(FIXTURE)
    const uni = await backend.skillGet("acme/tools/ñandú")
    expect(uni?.description).toBe("Chequea ñandúes 🦩")
    const noDesc = await backend.skillGet("acme/tools/no-desc")
    expect(noDesc?.description).toBe("")
  })

  test("SKB-8: FTS5 finds ingested skills by name token", async () => {
    await sync.ingestBootstrap(FIXTURE)
    const hits = await backend.skillSearch({ query: "debugging" })
    expect(hits.length).toBeGreaterThanOrEqual(2)
    expect(hits.some((h) => h.id === "obra/superpowers/systematic-debugging")).toBe(true)
  })

  test("SKB-9: minInstalls filter flows through backend search", async () => {
    await sync.ingestBootstrap(FIXTURE)
    const hits = await backend.skillSearch({ query: "debugging", minInstalls: 100000 })
    expect(hits.every((h) => h.installs >= 100000)).toBe(true)
    expect(hits.some((h) => h.id === "jnmetacode/superpowers-zh/systematic-debugging")).toBe(false)
  })

  test("SKB-10: normalizeSkillRecord rejects wrong-typed fields", () => {
    const { normalizeSkillRecord } = require("./skill-hub-sync") as typeof import("./skill-hub-sync")
    expect(normalizeSkillRecord({ id: 1, name: "x" })).toBeNull()
    expect(normalizeSkillRecord({ id: "a/b/c", name: true })).toBeNull()
    expect(normalizeSkillRecord({ id: "a/b/c", name: "ok", installs: "many" })?.installs).toBe(0)
  })

  test("SKB-11: whitespace-padded id is trimmed before storage", async () => {
    const res = await sync.ingestBootstrap([{ id: "  a/b/c  ", name: "padded", installs: 5 }])
    expect(res.invalid).toBe(0)
    expect(res.inserted).toBe(1)
    const got = await backend.skillGet("a/b/c")
    expect(got).not.toBeNull()
    expect(got?.name).toBe("padded")
  })
})
