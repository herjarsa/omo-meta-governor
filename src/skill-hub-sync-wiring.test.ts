/**
 * v0.33.6: regression guard for skill-hub bootstrap wiring.
 *
 * Pre-v0.33.6 the SkillHubSync.ingestBootstrap() was implemented and
 * tested in isolation, but nothing in the plugin runtime called it.
 * Result: the `skills` table existed (created by SqliteBackend's
 * SCHEMA_SQL) but had 0 rows forever. The omo_skill_find MCP tool
 * existed but always returned empty.
 *
 * This test asserts that runSkillHubSync:
 *   1. Reads a fetch function and SqliteBackend via DI (testable).
 *   2. Fetches the bootstrap URL once.
 *   3. Calls ingestBootstrap on the records.
 *   4. Returns a result that records inserted/skipped counts.
 *   5. Swallows network errors gracefully (logs + returns null).
 *
 * The plugin in mcp-server.ts calls runSkillHubSync on startup with
 * fire-and-forget semantics (does not block MCP tool serving).
 */
import { describe, expect, it } from "bun:test"
import { runSkillHubSync } from "./skill-hub-sync"
import { SqliteBackend } from "./sqlite-backend"
import { mkdtempSync, rmSync, unlinkSync, existsSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
const VALID_FIXTURE = [
  {
    id: "owner/repo/skill-a",
    name: "Skill A",
    description: "First test skill",
    installs: 100,
    repo_url: "https://github.com/owner/repo",
  },
  {
    id: "owner/repo/skill-b",
    name: "Skill B",
    description: "Second test skill",
    installs: 200,
    repo_url: "https://github.com/owner/repo",
  },
]

function freshBackend(): { backend: SqliteBackend; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "skill-hub-sync-wiring-"))
  const dbPath = join(dir, "test.db")
  const backend = new SqliteBackend(dbPath)
  return {
    backend,
cleanup: () => {
      backend.close()
      // Remove WAL/SHM/journal files first so Windows releases the lock.
      for (const suffix of ["", "-wal", "-shm", "-journal"]) {
        const p = dbPath + suffix
        if (existsSync(p)) {
          try { unlinkSync(p) } catch { /* best-effort */ }
        }
      }
      try {
      rmSync(dir, { recursive: true, force: true }) } catch { /* best-effort */ }
},
  }
}

describe("runSkillHubSync wiring (v0.33.6)", () => {
  describe("#given a valid bootstrap response and skillHub.enabled=true", () => {
    it("then populates the skills table and returns the ingest result", async () => {
      const { backend, cleanup } = freshBackend()
      try {
        const fetchMock = async () =>
          new Response(JSON.stringify(VALID_FIXTURE), {
            status: 200,
            headers: { "content-type": "application/json" },
          })

        const result = await runSkillHubSync({
          sqlBackend: backend,
          bootstrapUrl: "https://example.test/skills.json",
          fetchFn: fetchMock,
          enabled: true,
          timeoutMs: 5_000,
        })

        expect(result).not.toBeNull()
        expect(result!.inserted).toBe(2)
        expect(result!.skippedUnchanged).toBe(0)

        const rowA = await backend.skillGet("owner/repo/skill-a")
        const rowB = await backend.skillGet("owner/repo/skill-b")
        expect(rowA).not.toBeNull()
        expect(rowB).not.toBeNull()
        expect(rowA!.name).toBe("Skill A")
        expect(rowB!.name).toBe("Skill B")
      } finally {
        cleanup()
      }
    })
  })

  describe("#given skillHub.enabled=false", () => {
    it("then skips fetch entirely and returns null without touching the db", async () => {
      const { backend, cleanup } = freshBackend()
      try {
        let fetchCalled = false
        const fetchMock = async () => {
          fetchCalled = true
          return new Response("[]", { status: 200 })
        }

        const result = await runSkillHubSync({
          sqlBackend: backend,
          bootstrapUrl: "https://example.test/skills.json",
          fetchFn: fetchMock,
          enabled: false,
          timeoutMs: 5_000,
        })

        expect(result).toBeNull()
        expect(fetchCalled).toBe(false)
      } finally {
        cleanup()
      }
    })
  })

  describe("#given a network error", () => {
    it("then swallows the error and returns null (does not throw)", async () => {
      const { backend, cleanup } = freshBackend()
      try {
        const fetchMock = async () => {
          throw new Error("ECONNREFUSED")
        }

        const result = await runSkillHubSync({
          sqlBackend: backend,
          bootstrapUrl: "https://example.test/skills.json",
          fetchFn: fetchMock,
          enabled: true,
          timeoutMs: 1_000,
        })

        expect(result).toBeNull()
      } finally {
        cleanup()
      }
    })
  })

  describe("#given an HTTP non-2xx", () => {
    it("then returns null without ingesting", async () => {
      const { backend, cleanup } = freshBackend()
      try {
        const fetchMock = async () =>
          new Response("not found", { status: 404, statusText: "Not Found" })

        const result = await runSkillHubSync({
          sqlBackend: backend,
          bootstrapUrl: "https://example.test/skills.json",
          fetchFn: fetchMock,
          enabled: true,
          timeoutMs: 1_000,
        })

        expect(result).toBeNull()
        const rowA = await backend.skillGet("owner/repo/skill-a")
        expect(rowA).toBeNull()
      } finally {
        cleanup()
      }
    })
  })

  describe("#given a non-array response body", () => {
    it("then returns null (SkillHubSync.ingestBootstrap handles non-array gracefully)", async () => {
      const { backend, cleanup } = freshBackend()
      try {
        const fetchMock = async () =>
          new Response(JSON.stringify({ unexpected: "shape" }), { status: 200 })

        const result = await runSkillHubSync({
          sqlBackend: backend,
          bootstrapUrl: "https://example.test/skills.json",
          fetchFn: fetchMock,
          enabled: true,
          timeoutMs: 1_000,
        })

        expect(result).not.toBeNull()
        expect(result!.inserted).toBe(0)
        expect(result!.skippedUnchanged).toBe(0)
      } finally {
        cleanup()
      }
    })
  })

  describe("#given re-running sync with same data", () => {
    it("then the second run reports all-skipped (hash dedup)", async () => {
      const { backend, cleanup } = freshBackend()
      try {
        const fetchMock = async () =>
          new Response(JSON.stringify(VALID_FIXTURE), { status: 200 })

        const opts = {
          sqlBackend: backend,
          bootstrapUrl: "https://example.test/skills.json",
          fetchFn: fetchMock,
          enabled: true,
          timeoutMs: 5_000,
        }

        const r1 = await runSkillHubSync(opts)
        const r2 = await runSkillHubSync(opts)

        expect(r1!.inserted).toBe(2)
        expect(r2!.inserted).toBe(0)
        expect(r2!.skippedUnchanged).toBe(2)
      } finally {
        cleanup()
      }
    })
  })
})
