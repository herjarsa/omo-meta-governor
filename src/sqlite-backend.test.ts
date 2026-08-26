/**
 * Tests for SqliteBackend — the implementation that replaces the stub backends
 * in src/plugin.ts:338-346. Validates the 3 interfaces:
 *
 * - AgentmemoryWriteBackend (types.ts:280-294): saveMemory, saveLesson
 * - AgentmemoryBackend (memory-aggregator.ts:82-84): smartSearch
 * - BoulderStateBackend (memory-aggregator.ts:90-92): boulderRead
 *
 * Each test uses a temporary DB file so tests are isolated and concurrent.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test"
import { unlinkSync, existsSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { SqliteBackend } from "./sqlite-backend"

let backend: SqliteBackend
let dbPath: string

beforeEach(() => {
  dbPath = join(tmpdir(), `omo-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`)
  backend = new SqliteBackend(dbPath)
})

afterEach(() => {
  try {
    backend.close()
  } catch {
    // best-effort
  }
  // Windows may hold WAL/SHM sidecars locked briefly. Retry + ignore.
  for (const p of [dbPath, dbPath + "-wal", dbPath + "-shm", dbPath + "-journal"]) {
    for (let i = 0; i < 3; i++) {
      try {
        if (existsSync(p)) unlinkSync(p)
        break
      } catch {
        // EBUSY on Windows — backoff and retry
      }
    }
  }
})

describe("SqliteBackend", () => {
  describe("#saveMemory", () => {
    test("returns id with M- prefix", async () => {
      const result = await backend.saveMemory({
        content: "Use SQLite for persistence",
        concepts: ["storage", "sqlite"],
        type: "fact",
      })
      expect(result.id).toMatch(/^M-/)
    })

    test("stores content in DB and round-trips via smartSearch", async () => {
      await backend.saveMemory({
        content: "Always use WAL mode for SQLite",
        concepts: ["sqlite", "wal"],
        type: "fact",
      })
      const found = await backend.smartSearch({ query: "WAL mode" })
      expect(found.lessons.length).toBeGreaterThan(0)
      expect(found.lessons[0]?.content).toContain("WAL")
    })
  })

  describe("#saveLesson", () => {
    test("returns id with L- prefix", async () => {
      const result = await backend.saveLesson({
        content: "When closing plugins, call dispose() to clean up watches",
        context: "session:abc dir:/tmp",
        confidence: 0.7,
        tags: ["plugins", "lifecycle"],
      })
      expect(result.id).toMatch(/^L-/)
    })

    test("persists content with confidence and tags", async () => {
      await backend.saveLesson({
        content: "Closed-loop learning requires writable backend",
        context: "session:test",
        confidence: 0.8,
        tags: ["learning", "backend"],
      })
      const found = await backend.smartSearch({ query: "closed-loop backend" })
      expect(found.lessons.length).toBeGreaterThan(0)
      expect(found.lessons[0]?.confidence).toBe(0.8)
      expect(found.lessons[0]?.concepts).toContain("learning")
    })
  })

  describe("#smartSearch", () => {
    beforeEach(async () => {
      await backend.saveLesson({
        content: "Authentication tokens should use httpOnly cookies",
        context: "session:auth",
        confidence: 0.9,
        tags: ["security", "auth"],
      })
      await backend.saveLesson({
        content: "Database migrations need WAL pragma for safety",
        context: "session:db",
        confidence: 0.6,
        tags: ["database", "sqlite"],
      })
      await backend.saveMemory({
        content: "Tool execution routes through plugin hooks",
        concepts: ["opencode", "plugin"],
        type: "fact",
      })
    })

    test("finds lessons by content keyword", async () => {
      const result = await backend.smartSearch({ query: "authentication" })
      expect(result.lessons.some((l) => l.content.includes("httpOnly"))).toBe(true)
    })

    test("respects limit parameter", async () => {
      const result = await backend.smartSearch({ query: "session", limit: 1 })
      expect(result.lessons.length).toBeLessThanOrEqual(1)
    })

    test("returns empty for non-matching query", async () => {
      const result = await backend.smartSearch({ query: "nonexistentkeyword12345" })
      expect(result.lessons.length).toBe(0)
    })

    test("FTS5 is safe against special characters in query", async () => {
      // Should not throw even with FTS5 special chars
      const result = await backend.smartSearch({ query: 'test "with" (special) *chars*' })
      expect(result).toBeDefined()
    })

    test("empty query returns empty results", async () => {
      const result = await backend.smartSearch({ query: "" })
      expect(result.lessons.length).toBe(0)
    })

    test("end-to-end: saveLesson + smartSearch round-trips with FTS5 matching", async () => {
      // v0.13.0: this is the core proof that the closed learning loop works.
      // Previously the plugin used stub backends that returned empty data,
      // so lessons never persisted. With SqliteBackend the round-trip works.
      const id = await backend.saveLesson({
        content: "When closing plugins, call dispose() to clean up watches",
        context: "session:integration-test dir:/tmp",
        confidence: 0.7,
        tags: ["plugins", "lifecycle"],
      })
      expect(id.id).toMatch(/^L-/)

      const found = await backend.smartSearch({ query: "dispose plugin" })
      expect(found.lessons.length).toBe(1)
      expect(found.lessons[0]?.id).toBe(id.id)
      expect(found.lessons[0]?.content).toContain("dispose")
      expect(found.lessons[0]?.confidence).toBe(0.7)
      expect(found.lessons[0]?.concepts).toContain("plugins")
    })
  })

  describe("#boulderRead", () => {
    // boulderRead is for a different table — we use raw DB exec to seed
    // because the public API for writing boulder tasks is not exposed
    // (the aggregator only reads).
    beforeEach(() => {
      // Reach into the backend's DB via a workaround: write directly via
      // a second connection to test the read path in isolation.
      const { Database } = require("bun:sqlite")
      const conn = new Database(dbPath)
      conn.exec(`
        INSERT INTO boulder_tasks (id, title, priority, status, description, directory, session_id, created_at_ms, updated_at_ms)
        VALUES ('t1', 'Implement FTS5 search', 1, 'pending', 'Add full-text search', '/proj', 'sess1', 1000, 2000),
               ('t2', 'Write tests', 2, 'done', 'Add unit tests', '/proj', 'sess1', 1100, 2100),
               ('t3', 'Other session task', 1, 'pending', 'noise', '/other', 'sess2', 1200, 2200)
      `)
      conn.close()
    })

    test("filters by directory and sessionID", async () => {
      const tasks = await backend.boulderRead({ directory: "/proj", sessionID: "sess1" })
      expect(tasks.length).toBe(2)
      expect(tasks.every((t) => t.id === "t1" || t.id === "t2")).toBe(true)
    })

    test("respects optional query filter", async () => {
      const tasks = await backend.boulderRead({
        directory: "/proj",
        sessionID: "sess1",
        query: "FTS5",
      })
      expect(tasks.length).toBe(1)
      expect(tasks[0]?.id).toBe("t1")
    })

    test("sorts by priority ASC then updatedAtMs DESC", async () => {
      const tasks = await backend.boulderRead({ directory: "/proj", sessionID: "sess1" })
      expect(tasks[0]?.priority).toBeLessThanOrEqual(tasks[1]?.priority ?? 0)
    })
  })

  describe("DB initialization", () => {
    test("creates entries, entries_fts, boulder_tasks, _meta tables", () => {
      const tables = (backend as unknown as { db: { query: Function } }).db
        .query<{ name: string }, []>(
          "SELECT name FROM sqlite_master WHERE type IN ('table') ORDER BY name",
        )
        .all() as Array<{ name: string }>
      const names = tables.map((t) => t.name)
      expect(names).toContain("entries")
      expect(names).toContain("entries_fts")
      expect(names).toContain("boulder_tasks")
      expect(names).toContain("_meta")
    })

    test("schema_version is set to 1", () => {
      const { Database } = require("bun:sqlite")
      const conn = new Database(dbPath, { readonly: true })
      const row = conn
        .query<{ value: string }, []>("SELECT value FROM _meta WHERE key = 'schema_version'")
        .get()
      conn.close()
      expect(row?.value).toBe("1")
    })

    test("WAL mode is enabled", () => {
      const { Database } = require("bun:sqlite")
      const conn = new Database(dbPath, { readonly: true })
      const row = conn.query<{ journal_mode: string }, []>("PRAGMA journal_mode").get()
      conn.close()
      expect(row?.journal_mode).toBe("wal")
    })
  })

  describe("concurrent writes", () => {
    test("WAL mode allows concurrent saveLesson calls", async () => {
      const promises = Array.from({ length: 20 }, (_, i) =>
        backend.saveLesson({
          content: `Concurrent lesson ${i}: pattern about test ${i}`,
          context: `session:concurrent dir:/tmp`,
          confidence: 0.5,
          tags: ["concurrency"],
        }),
      )
      const results = await Promise.all(promises)
      expect(results.length).toBe(20)
      expect(new Set(results.map((r) => r.id)).size).toBe(20) // all unique
    })
  })

  // v0.35.0 (Tier 2 materialization): last_materialized_at column +
  // setSkillMaterializedAt() + getSkillMaterializedAt() round-trip.
  describe("skills last_materialized_at (v0.35.0)", () => {
    test("setSkillMaterializedAt writes the timestamp and getSkillMaterializedAt reads it back", async () => {
      const id = "owner/repo/sample-skill"
      await backend.skillAddOrUpdate({
        id,
        name: "Sample",
        description: "Sample skill for materialization test",
        installs: 0,
        download_count: 0,
        last_synced: Date.now(),
        content_hash: "abc",
      })
      const ts = "2026-08-26T18:00:00.000Z"
      backend.setSkillMaterializedAt(id, ts)
      expect(backend.getSkillMaterializedAt(id)).toBe(ts)
    })

    test("setSkillMaterializedAt is a no-op for unknown slugs (no row created)", () => {
      const before = backend.getSkillMaterializedAt("does/not/exist")
      backend.setSkillMaterializedAt("does/not/exist", "2026-08-26T00:00:00.000Z")
      const after = backend.getSkillMaterializedAt("does/not/exist")
      expect(before).toBeNull()
      expect(after).toBeNull()
    })
  })
})
