/**
 * SQLite backend implementing agentmemory + boulder-state interfaces.
 *
 * Replaces the stub backends in src/plugin.ts:338-346 so lessons and decisions
 * actually persist. Uses `bun:sqlite` (built into the Bun runtime — no new
 * dependencies). Schema inspired by opencode-telemetry (WAL mode + _meta KV)
 * and opencode-mem0 (FTS5 for semantic search).
 *
 * Design:
 * - Single `entries` table unifies lessons + memories + crystals
 * - FTS5 virtual table for `smartSearch` natural-language query matching
 * - Separate `boulder_tasks` table (different shape, different access pattern)
 * - _meta KV table for schema versioning (PRAGMA table_info guard)
 * - WAL mode + synchronous=NORMAL + busy_timeout for concurrent safety
 * - Prepared statements cached at init
 *
 * Default DB path: `~/.omo-meta-governor/meta-governor.db`
 */

import { Database } from "bun:sqlite"
import { existsSync, mkdirSync } from "node:fs"
import { join } from "node:path"

import { homedir } from "node:os"
import type { AgentmemoryWriteBackend } from "./types"
import type { AgentmemoryBackend, BoulderStateBackend, RawCrystal, RawLesson } from "./memory-aggregator"

// ---------------------------------------------------------------------------
// Internal row shapes
// ---------------------------------------------------------------------------

interface EntryRow {
  id: string
  kind: "lesson" | "memory" | "crystal"
  title: string
  content: string
  context: string
  advice: string | null
  confidence: number
  tags: string
  files: string
  session_id: string
  directory: string
  created_at: number
}

interface BoulderRow {
  id: string
  title: string
  priority: number
  status: string
  description: string
  directory: string
  session_id: string
  created_at_ms: number
  updated_at_ms: number
}

// ---------------------------------------------------------------------------
// Default DB path resolution
// ---------------------------------------------------------------------------

function defaultDbPath(): string {
  const dir = join(homedir(), ".omo-meta-governor")
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  return join(dir, "meta-governor.db")
}

// ---------------------------------------------------------------------------
// Schema migration
// ---------------------------------------------------------------------------

const SCHEMA_VERSION = "1"
const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS _meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS entries (
  id         TEXT PRIMARY KEY,
  kind       TEXT NOT NULL CHECK(kind IN ('lesson', 'memory', 'crystal')),
  title      TEXT NOT NULL DEFAULT '',
  content    TEXT NOT NULL,
  context    TEXT DEFAULT '',
  advice     TEXT CHECK(advice IN ('continue', 'stop', 'warn', 'info')),
  confidence REAL DEFAULT 0.5,
  tags       TEXT DEFAULT '[]',
  files      TEXT DEFAULT '[]',
  session_id TEXT DEFAULT '',
  directory  TEXT DEFAULT '',
  created_at INTEGER NOT NULL
);

CREATE VIRTUAL TABLE IF NOT EXISTS entries_fts USING fts5(
  id UNINDEXED,
  title,
  content,
  tags,
  content=entries,
  content_rowid=rowid
);

CREATE TRIGGER IF NOT EXISTS entries_ai AFTER INSERT ON entries BEGIN
  INSERT INTO entries_fts(rowid, id, title, content, tags)
  VALUES (new.rowid, new.id, new.title, new.content, new.tags);
END;
CREATE TRIGGER IF NOT EXISTS entries_ad AFTER DELETE ON entries BEGIN
  INSERT INTO entries_fts(entries_fts, rowid, id, title, content, tags)
  VALUES ('delete', old.rowid, old.id, old.title, old.content, old.tags);
END;
CREATE TRIGGER IF NOT EXISTS entries_au AFTER UPDATE ON entries BEGIN
  INSERT INTO entries_fts(entries_fts, rowid, id, title, content, tags)
  VALUES ('delete', old.rowid, old.id, old.title, old.content, old.tags);
  INSERT INTO entries_fts(rowid, id, title, content, tags)
  VALUES (new.rowid, new.id, new.title, new.content, new.tags);
END;

CREATE TABLE IF NOT EXISTS boulder_tasks (
  id            TEXT PRIMARY KEY,
  title         TEXT NOT NULL,
  priority      INTEGER DEFAULT 0,
  status        TEXT NOT NULL DEFAULT 'pending',
  description   TEXT DEFAULT '',
  directory     TEXT NOT NULL,
  session_id    TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_entries_kind ON entries(kind);
CREATE INDEX IF NOT EXISTS idx_entries_session ON entries(session_id, directory);
CREATE INDEX IF NOT EXISTS idx_boulder_dir_session ON boulder_tasks(directory, session_id);
`

// ---------------------------------------------------------------------------
// ID generation
// ---------------------------------------------------------------------------

function generateId(prefix: string): string {
  const ts = Date.now().toString(36)
  const rand = Math.floor(Math.random() * 0xffff).toString(36)
  return `${prefix}-${ts}-${rand}`
}

// ---------------------------------------------------------------------------
// SqliteBackend
// ---------------------------------------------------------------------------

export class SqliteBackend implements AgentmemoryWriteBackend, AgentmemoryBackend, BoulderStateBackend {
  private db: Database
  private stmts: {
    insertEntry: ReturnType<Database["prepare"]>
    ftsSearch: ReturnType<Database["prepare"]>
    boulderSelect: ReturnType<Database["prepare"]>
  }

  constructor(dbPath?: string) {
    const path = dbPath ?? defaultDbPath()
    this.db = new Database(path, { create: true })

    // Performance + safety pragmas
    this.db.exec("PRAGMA journal_mode = WAL;")
    this.db.exec("PRAGMA synchronous = NORMAL;")
    this.db.exec("PRAGMA foreign_keys = ON;")
    this.db.exec("PRAGMA busy_timeout = 5000;")

    // Run schema (idempotent)
    this.db.exec(SCHEMA_SQL)

    // Check / set schema version
    const versionRow = this.db
      .query<{ value: string }, []>("SELECT value FROM _meta WHERE key = 'schema_version'")
      .get()
    if (!versionRow) {
      this.db
        .query("INSERT INTO _meta (key, value) VALUES ('schema_version', ?)")
        .run(SCHEMA_VERSION)
    } else if (versionRow.value !== SCHEMA_VERSION) {
      // Future: migration logic. For v1, no migrations needed.
    }

    // Prepare statements once
    this.stmts = {
      insertEntry: this.db.prepare(`
        INSERT INTO entries (id, kind, title, content, context, advice, confidence, tags, files, session_id, directory, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `),
      ftsSearch: this.db.prepare(`
        SELECT e.id, e.title, e.content, e.kind, e.confidence, e.advice, e.tags, e.files, e.session_id
        FROM entries_fts f
        JOIN entries e ON e.id = f.id
        WHERE entries_fts MATCH ? AND e.kind IN ('lesson', 'memory')
        ORDER BY rank
        LIMIT ?
      `),
      boulderSelect: this.db.prepare(`
        SELECT id, title, priority, status, description, directory, session_id, created_at_ms, updated_at_ms
        FROM boulder_tasks
        WHERE directory = ? AND session_id = ?
        ORDER BY priority ASC, updated_at_ms DESC
      `),
    }
  }

  // -------- AgentmemoryWriteBackend --------

  saveMemory(input: {
    content: string
    concepts: string[]
    type: string
    files?: string[]
  }): Promise<{ id: string }> {
    const id = generateId("M")
    const title = (input.concepts[0] ?? "memory").slice(0, 80)
    this.stmts.insertEntry.run(
      id,
      "memory",
      title,
      input.content,
      "",
      null,
      0.5,
      JSON.stringify(input.concepts),
      JSON.stringify(input.files ?? []),
      "",
      "",
      Date.now(),
    )
    return Promise.resolve({ id })
  }

  saveLesson(input: {
    content: string
    context: string
    confidence?: number
    tags?: string[]
  }): Promise<{ id: string }> {
    const id = generateId("L")
    const confidence = input.confidence ?? 0.5
    // Extract title from first line of content (max 80 chars)
    const title = (input.content.split("\n")[0] ?? "lesson").slice(0, 80)
    this.stmts.insertEntry.run(
      id,
      "lesson",
      title,
      input.content,
      input.context,
      null,
      confidence,
      JSON.stringify(input.tags ?? []),
      JSON.stringify([]),
      "",
      "",
      Date.now(),
    )
    return Promise.resolve({ id })
  }

  // -------- AgentmemoryBackend (memory-aggregator interface) --------

  smartSearch(input: { query: string; limit?: number }): Promise<{
    lessons: RawLesson[]
    crystals: RawCrystal[]
  }> {
    const limit = input.limit ?? 10
    // Sanitize query for FTS5 — escape special chars, prefix each token
    const ftsQuery = this.toFtsQuery(input.query)
    const rows = this.stmts.ftsSearch.all(ftsQuery, limit) as Array<{
      id: string
      title: string
      content: string
      kind: string
      confidence: number
      advice: string | null
      tags: string
      files: string
      session_id: string
    }>
    const lessons: RawLesson[] = rows.map((r) => ({
      id: r.id,
      title: r.title,
      content: r.content,
      type: r.kind,
      concepts: safeJsonArray(r.tags),
      confidence: r.confidence,
      files: safeJsonArray(r.files),
      advice: (r.advice as RawLesson["advice"]) ?? "info",
    }))
    return Promise.resolve({ lessons, crystals: [] as RawCrystal[] })
  }

  // -------- BoulderStateBackend --------

  boulderRead(input: {
    directory: string
    sessionID: string
    query?: string
  }): Promise<
    Array<{
      id: string
      title: string
      priority: number
      status: string
      description: string
      createdAtMs: number
      updatedAtMs: number
    }>
  > {
    const rows = this.stmts.boulderSelect.all(input.directory, input.sessionID) as Array<BoulderRow>
    let tasks = rows.map((r) => ({
      id: r.id,
      title: r.title,
      priority: r.priority,
      status: r.status,
      description: r.description,
      createdAtMs: r.created_at_ms,
      updatedAtMs: r.updated_at_ms,
    }))
    if (input.query) {
      const q = input.query.toLowerCase()
      tasks = tasks.filter(
        (t) => t.title.toLowerCase().includes(q) || t.description.toLowerCase().includes(q),
      )
    }
    return Promise.resolve(tasks)
  }

  // -------- Lifecycle --------

  close(): void {
    this.db.close()
  }

  // -------- Helpers --------

  /**
   * Convert a natural-language query to a safe FTS5 MATCH expression.
   * Splits on whitespace, escapes each token, appends `*` for prefix match.
   * Empty / whitespace-only input returns `""` (no matches).
   */
  private toFtsQuery(query: string): string {
    const tokens = query
      .trim()
      .split(/\s+/)
      .filter(Boolean)
      .map((t) => t.replace(/["()*]/g, ""))
      .filter(Boolean)
    if (tokens.length === 0) return '""'
    return tokens.map((t) => `"${t}"*`).join(" ")
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function safeJsonArray(s: string): string[] {
  try {
    const parsed = JSON.parse(s)
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

/**
 * Create a default SqliteBackend for the default DB path. Used as the fallback
 * when the user does not provide custom backends via MetaGovernorPluginDeps.
 *
 * Cached at module level so multiple invocations within the same process share
 * the same DB connection (avoids lock contention from WAL checkpoints).
 */
let _default: SqliteBackend | null = null
export function getDefaultSqliteBackend(): SqliteBackend {
  if (!_default) _default = new SqliteBackend()
  return _default
}
