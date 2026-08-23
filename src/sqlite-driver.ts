/**
 * Runtime-selectable SQLite driver (v0.31.3).
 *
 * WHY THIS EXISTS
 * ---------------
 * The MCP server entry (dist/mcp-server.js) is spawned by Node via npx,
 * while the plugin entry runs inside opencode's Bun runtime. The previous
 * implementation imported `bun:sqlite` statically, so the bundler inlined
 * it into every dist chunk — and Node's ESM loader rejected the bundle:
 *
 *   Error [ERR_UNSUPPORTED_ESM_URL_SCHEME]: Received protocol 'bun:'
 *
 * Fix: resolve the sqlite module at RUNTIME through createRequire, which
 * the bundler cannot see or rewrite. Under Bun we load the native
 * `bun:sqlite`; under Node we load `node:sqlite` (DatabaseSync), whose
 * synchronous API covers everything SqliteBackend needs.
 *
 * Supported runtimes:
 *   - Bun (any version)            -> bun:sqlite
 *   - Node >= 23.4                 -> node:sqlite (unflagged)
 *   - Node 22.5 – 23.3             -> node:sqlite behind --experimental-sqlite
 *
 * Surface parity notes (see bun-shim.d.ts for the historical contract):
 *   - exec(sql)               identical on both drivers
 *   - prepare(sql)            -> { run, get, all } positional params
 *   - query(sql)              Bun sugar; aliased to prepare() here so
 *                             call sites stay portable
 *   - close()                 identical
 *   - { create: true }        honored by bun:sqlite; node:sqlite always
 *                             creates missing files, so the option is
 *                             accepted and ignored there.
 */

import { createRequire } from "node:module"

/** Minimal prepared-statement surface shared by both drivers. */
export interface OmoStatement {
  run(...params: unknown[]): unknown
  get(...params: unknown[]): unknown
  all(...params: unknown[]): unknown[]
}

/** Minimal database surface required by SqliteBackend. */
export interface OmoDatabase {
  exec(sql: string): void
  prepare(sql: string): OmoStatement
  /** Alias for prepare() — keeps bun-style call sites portable. */
  query(sql: string): OmoStatement
  close(): void
}

/** Structural shape both driver modules satisfy after selection. */
interface RawStatement {
  run(...params: unknown[]): unknown
  get(...params: unknown[]): unknown
  all(...params: unknown[]): unknown[]
}
interface RawDatabase {
  exec(sql: string): void
  prepare(sql: string): RawStatement
  close(): void
}

const require_ = createRequire(import.meta.url)

function loadRawDatabase(path: string): RawDatabase {
  if (typeof process !== "undefined" && process.versions?.bun) {
    const mod: { Database?: new (path: string, opts?: { create?: boolean }) => RawDatabase } =
      require_("bun:sqlite")
    if (!mod.Database) {
      throw new Error("sqlite-driver: bun:sqlite loaded but Database export missing")
    }
    return new mod.Database(path, { create: true })
  }

  let mod: { DatabaseSync?: new (path: string) => RawDatabase }
  try {
    mod = require_("node:sqlite")
  } catch {
    throw new Error(
      "sqlite-driver: node:sqlite is unavailable. " +
        "omo-meta-governor MCP mode requires Bun, or Node >= 23.4 " +
        "(Node 22.5-23.3 needs --experimental-sqlite).",
    )
  }
  if (!mod.DatabaseSync) {
    throw new Error(
      "sqlite-driver: node:sqlite loaded but DatabaseSync export missing " +
        "(Node too old?). Use Bun or Node >= 23.4.",
    )
  }
  // node:sqlite always creates the file when missing; the bun-only
  // `{ create: true }` option has no equivalent knob here.
  return new mod.DatabaseSync(path)
}

class SharedStatement implements OmoStatement {
  constructor(private readonly raw: RawStatement) {}
  run(...params: unknown[]): unknown {
    return this.raw.run(...params)
  }
  get(...params: unknown[]): unknown {
    return this.raw.get(...params)
  }
  all(...params: unknown[]): unknown[] {
    const rows = this.raw.all(...params)
    return Array.isArray(rows) ? rows : []
  }
}

class DriverDatabase implements OmoDatabase {
  constructor(private readonly raw: RawDatabase) {}

  exec(sql: string): void {
    this.raw.exec(sql)
  }

  prepare(sql: string): OmoStatement {
    return new SharedStatement(this.raw.prepare(sql))
  }

  query(sql: string): OmoStatement {
    return this.prepare(sql)
  }

  close(): void {
    this.raw.close()
  }
}

/**
 * Open (and create, when missing) a SQLite database using whichever
 * engine the current runtime provides. See module docs for runtime
 * support matrix.
 */
export function openDatabase(path: string): OmoDatabase {
  return new DriverDatabase(loadRawDatabase(path))
}
