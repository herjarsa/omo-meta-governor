/**
 * v0.31.3 SQLite driver portability — RED tests.
 *
 * Bug: dist/mcp-server.js statically imports "bun:sqlite" (via
 * sqlite-backend.ts). The MCP server is spawned by Node through npx, and
 * Node's ESM loader rejects the `bun:` URL scheme:
 *
 *   Error [ERR_UNSUPPORTED_ESM_URL_SCHEME]: Only URLs with a scheme in:
 *   file, data, and node are supported. Received protocol 'bun:'
 *
 * Result: the v0.31.0 Desktop fix (MCP mode) never booted — exactly the
 * surface it was built for.
 *
 * Fix under test: src/sqlite-driver.ts resolves the sqlite module at
 * RUNTIME via createRequire — bun:sqlite under Bun, node:sqlite
 * (DatabaseSync) under Node >= 23.4 — so no bundler-visible static
 * `bun:` import ever reaches dist/.
 *
 * These tests SHOULD FAIL until the fix lands (RED), then pass (GREEN).
 */
import { describe, expect, it, afterEach } from "bun:test"
import { mkdtempSync, rmSync, existsSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { openDatabase, type OmoDatabase } from "./sqlite-driver"

const dirs: string[] = []
function tempDbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "omo-driver-"))
  dirs.push(dir)
  return join(dir, "test.db")
}
afterEach(() => {
  for (const d of dirs) {
    try {
      if (existsSync(d)) rmSync(d, { recursive: true, force: true })
    } catch (err) {
      // Windows can hold WAL file handles briefly after close(); the
      // leftover lives in the OS temp dir and is reclaimed later.
      console.warn(`[sqlite-driver.test] temp dir not removed: ${d}`, err)
    }
  }
  dirs.length = 0
})

describe("openDatabase", () => {
  it("opens/creates a database file at the given path", () => {
    const p = tempDbPath()
    const db = openDatabase(p)
    expect(existsSync(p)).toBe(true)
    db.close()
  })

  it("exec() runs pragmas and multi-statement SQL", () => {
    const db = openDatabase(tempDbPath())
    expect(() =>
      db.exec("PRAGMA journal_mode = WAL; CREATE TABLE t (id INTEGER);"),
    ).not.toThrow()
    db.close()
  })

  it("prepare().run/get/all roundtrip positional params", () => {
    const db = openDatabase(tempDbPath())
    db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT);")
    db.prepare("INSERT INTO t (name) VALUES (?)").run("alpha")
    db.prepare("INSERT INTO t (name) VALUES (?)").run("beta")

    const row = db.prepare("SELECT id, name FROM t WHERE name = ?").get("alpha") as
      | { id: number; name: string }
      | undefined
    expect(row?.name).toBe("alpha")

    const rows = db.prepare("SELECT name FROM t ORDER BY id").all() as Array<{
      name: string
    }>
    expect(rows.length).toBe(2)
    expect(rows[1]?.name).toBe("beta")
    db.close()
  })

  it("query() behaves like prepare() (bun sugar alias)", () => {
    const db = openDatabase(tempDbPath())
    db.exec("CREATE TABLE m (k TEXT, v TEXT); INSERT INTO m VALUES ('a','1');")
    const row = db.query(
      "SELECT k, v FROM m WHERE k = ?",
    ).get("a") as { k: string; v: string } | undefined
    expect(row?.v).toBe("1")
    db.close()
  })

  it("persists data across close/reopen (WAL-safe)", () => {
    const p = tempDbPath()
    const db1 = openDatabase(p)
    db1.exec("CREATE TABLE p (v TEXT);")
    db1.prepare("INSERT INTO p (v) VALUES (?)").run("durable")
    db1.close()

    const db2 = openDatabase(p)
    const row = db2.prepare("SELECT v FROM p").get() as { v: string } | undefined
    expect(row?.v).toBe("durable")
    db2.close()
  })

  it("returns an object exposing the OmoDatabase surface", () => {
    const db: OmoDatabase = openDatabase(tempDbPath())
    for (const fn of ["exec", "prepare", "query", "close"]) {
      expect(typeof (db as unknown as Record<string, unknown>)[fn]).toBe("function")
    }
    db.close()
  })
})
