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

import { openDatabase, type OmoDatabase, type OmoStatement } from "./sqlite-driver"
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

CREATE TABLE IF NOT EXISTS skills (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  repo_url TEXT,
  installs INTEGER DEFAULT 0,
  skill_id TEXT,
  download_count INTEGER DEFAULT 0,
  last_synced INTEGER,
  content_hash TEXT,
  last_materialized_at TEXT
);

CREATE VIRTUAL TABLE IF NOT EXISTS skills_fts USING fts5(name, description, content='skills', content_rowid='rowid');

CREATE TRIGGER IF NOT EXISTS skills_ai AFTER INSERT ON skills BEGIN
  INSERT INTO skills_fts(rowid, name, description) VALUES (new.rowid, new.name, new.description);
END;

CREATE TRIGGER IF NOT EXISTS skills_ad AFTER DELETE ON skills BEGIN
  INSERT INTO skills_fts(skills_fts, rowid, name, description) VALUES ('delete', old.rowid, old.name, old.description);
END;

CREATE TRIGGER IF NOT EXISTS skills_au AFTER UPDATE ON skills BEGIN
  INSERT INTO skills_fts(skills_fts, rowid, name, description) VALUES ('delete', old.rowid, old.name, old.description);
  INSERT INTO skills_fts(rowid, name, description) VALUES (new.rowid, new.name, new.description);
END;

CREATE TABLE IF NOT EXISTS skill_deps (
  skill_id TEXT NOT NULL,
  dep_type TEXT NOT NULL,
  dep_name TEXT NOT NULL,
  PRIMARY KEY (skill_id, dep_type, dep_name)
);
CREATE INDEX IF NOT EXISTS idx_skill_deps_dep ON skill_deps(dep_type, dep_name);

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
  private db: OmoDatabase
  private stmts: {
    insertEntry: OmoStatement
    ftsSearch: OmoStatement
    boulderSelect: OmoStatement
  }

  constructor(dbPath?: string) {
    const path = dbPath ?? defaultDbPath()
    this.db = openDatabase(path)

    // Performance + safety pragmas
    this.db.exec("PRAGMA journal_mode = WAL;")
    this.db.exec("PRAGMA synchronous = NORMAL;")
    this.db.exec("PRAGMA foreign_keys = ON;")
    this.db.exec("PRAGMA busy_timeout = 5000;")

    // Run schema (idempotent)
    this.db.exec(SCHEMA_SQL)

    // Check / set schema version
    const versionRow = this.db
      .prepare("SELECT value FROM _meta WHERE key = 'schema_version'")
      .get() as { value: string } | undefined
    if (!versionRow) {
      this.db
        .prepare("INSERT INTO _meta (key, value) VALUES ('schema_version', ?)")
        .run(SCHEMA_VERSION)
    } else if (versionRow.value !== SCHEMA_VERSION) {
      // Additive migration: v1 → v2 adds skills.last_materialized_at.
      // Existing rows survive — ALTER TABLE ADD COLUMN with no DEFAULT
      // leaves them as NULL, which is what we want.
      if (versionRow.value === "1") {
        const cols = this.db
          .prepare("PRAGMA table_info(skills)")
          .all() as Array<{ name: string }>
        if (!cols.some((c) => c.name === "last_materialized_at")) {
          this.db.exec("ALTER TABLE skills ADD COLUMN last_materialized_at TEXT")
        }
        this.db
          .prepare("UPDATE _meta SET value = ? WHERE key = 'schema_version'")
          .run(SCHEMA_VERSION)
      }
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

  // -------- Skill catalog --------

  /**
   * Search skills by name/description using FTS5.
   * Supports optional minInstalls filter and duplicate filtering.
   */
  skillSearch(input: {
    query: string
    minInstalls?: number
    filterDuplicates?: boolean
  }): Promise<Array<{
    id: string
    name: string
    description: string | null
    installs: number
    skill_id: string | null
    repo_url: string | null
    download_count: number
  }>> {
    const whereClauses: string[] = []
    const params: unknown[] = []

    if (input.query) {
      // v0.35.0 (audit fix F1): sanitize FTS5 input to block operator injection
      const sanitized = this.toFtsQuery(input.query)
      if (sanitized && sanitized !== '""') {
        whereClauses.push(`skills_fts MATCH ?`)
        params.push(sanitized)
      }
    }
    if (input.minInstalls !== undefined) {
      whereClauses.push(`installs >= ?`)
      params.push(input.minInstalls)
    }

    const where = whereClauses.length > 0 ? `WHERE ${whereClauses.join(' AND ')}` : ''
    const limit = input.filterDuplicates !== false ? 50 : 100

    const rows = this.db.prepare(
      `SELECT s.id, s.name, s.description, s.installs, s.skill_id, s.repo_url, s.download_count
       FROM skills s
       JOIN skills_fts f ON f.rowid = (SELECT rowid FROM skills WHERE id = s.id)
       ${where}
       ORDER BY rank
       LIMIT ?`
    ).all(...params, limit) as Array<{
      id: string
      name: string
      description: string | null
      installs: number
      skill_id: string | null
      repo_url: string | null
      download_count: number
    }>

    return Promise.resolve(rows)
  }

  /**
   * Get a specific skill by ID.
   */
  skillGet(id: string): Promise<{
    id: string
    name: string
    description: string | null
    repo_url: string | null
    installs: number
    skill_id: string | null
    download_count: number
    last_synced: number | null
    content_hash: string | null
  } | null> {
    const row = this.db.prepare(
      `SELECT s.id, s.name, s.description, s.repo_url, s.installs, s.skill_id, s.download_count, s.last_synced, s.content_hash
       FROM skills s
       WHERE s.id = ?`
    ).get(id) as {
      id: string
      name: string
      description: string | null
      repo_url: string | null
      installs: number
      skill_id: string | null
      download_count: number
      last_synced: number | null
      content_hash: string | null
    } | undefined

    return Promise.resolve(row ?? null)
  }

  /**
   * Add or update a skill in the catalog.
   * Returns the skill ID if successful.
   */
  skillAddOrUpdate(skill: {
    id: string
    name: string
    description: string
    repo_url?: string
    installs?: number
    skill_id?: string
    download_count?: number
    last_synced?: number
    content_hash?: string
  }): Promise<string> {
    const now = Date.now()

    this.db.prepare(`
      INSERT INTO skills (id, name, description, repo_url, installs, skill_id, download_count, last_synced, content_hash)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        name = excluded.name,
        description = excluded.description,
        repo_url = excluded.repo_url,
        installs = excluded.installs,
        skill_id = excluded.skill_id,
        download_count = excluded.download_count,
        last_synced = excluded.last_synced,
        content_hash = excluded.content_hash
    `).run(
      skill.id,
      skill.name,
      skill.description,
      skill.repo_url,
      skill.installs ?? 0,
      skill.skill_id,
      skill.download_count ?? 0,
      skill.last_synced ?? now,
      skill.content_hash
    )

    return Promise.resolve(skill.id)
  }

  /**
   * Record that a skill's SKILL.md has been materialized to disk at the
   * given ISO timestamp. Used by omo_skill_get after a successful write
   * to <projectDir>/.agents/skills/<slug>/SKILL.md so the resolver can
   * label the slug as `source: 'hub-materialized'` vs `source: 'custom'`.
   * The slug matches the trailing component of `skills.id` (format
   * `owner/repo/slug`). The caller passes the short slug; this method
   * matches it against the trailing path segment because hub sync stores
   * the full id form. This is a no-op when no row matches, since
   * materialization must not create a catalog row out of thin air
   * (the row was already created by skillAddOrUpdate during hub sync).
   */
  setSkillMaterializedAt(slug: string, ts: string): void {
    this.db.prepare(
      "UPDATE skills SET last_materialized_at = ? WHERE id LIKE ? OR id = ?"
    ).run(ts, `%/${slug}`, slug)
  }
  /** Lookup the last_materialized_at timestamp for a skill row, or null. */
  getSkillMaterializedAt(slug: string): string | null {
    const row = this.db
      .prepare("SELECT last_materialized_at FROM skills WHERE id = ?")
      .get(slug) as { last_materialized_at: string | null } | undefined
    return row?.last_materialized_at ?? null
  }

  // -------- Skill dependencies --------

  /** Replace all dependency rows for one skill (idempotent). */
  skillReplaceDeps(
    skillId: string,
    deps: Array<{ depType: string; depName: string }>,
  ): Promise<number> {
    this.db.exec("BEGIN")
    try {
      this.db.prepare(`DELETE FROM skill_deps WHERE skill_id = ?`).run(skillId)
      const ins = this.db.prepare(
        `INSERT OR IGNORE INTO skill_deps (skill_id, dep_type, dep_name) VALUES (?, ?, ?)`,
      )
      let written = 0
      for (const d of deps) {
        if (
          typeof d.depType === "string" && d.depType.length > 0 &&
          typeof d.depName === "string" && d.depName.length > 0
        ) {
          ins.run(skillId, d.depType, d.depName)
          written++
        }
      }
      this.db.exec("COMMIT")
      return Promise.resolve(written)
    } catch (err) {
      this.db.exec("ROLLBACK")
      throw err
    }
  }

  /** Get dependency rows for one skill, sorted by type then name. */
  skillGetDeps(skillId: string): Promise<Array<{ depType: string; depName: string }>> {
    const rows = this.db
      .prepare(
        `SELECT dep_type AS depType, dep_name AS depName FROM skill_deps WHERE skill_id = ? ORDER BY dep_type ASC, dep_name ASC`,
      )
      .all(skillId) as Array<{ depType: string; depName: string }>
    return Promise.resolve(rows)
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
  toFtsQuery(query: string): string {
    const tokens = query
      .trim()
      .split(/\s+/)
      .filter(Boolean)
      .map((t) => t.replace(/["()*:^]/g, ""))
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
