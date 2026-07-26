/**
 * Type declarations for the Bun runtime. The project targets both Bun
 * (production — `bun:sqlite` built-in) and Node (dev tooling / CI).
 *
 * The `bun:sqlite` module is a built-in in Bun; this shim lets tsc
 * typecheck code that imports it without requiring `@types/bun` as a
 * devDependency.
 *
 * The class below mirrors the actual Bun API we use:
 *   - new Database(path, { create?: boolean })
 *   - db.exec(sql) — run multiple statements
 *   - db.query<Row, Params>(sql).get(...params) / .all(...params)
 *   - db.prepare(sql).run(...params) / .all(...params)
 *   - db.close()
 *
 * At runtime, Bun's native `bun:sqlite` provides this; the shim is only
 * for the typechecker.
 */

declare module "bun:sqlite" {
  export interface DatabaseOptions {
    create?: boolean
    readonly?: boolean
  }

  export type BindParameter = number | string | bigint | Buffer | null | boolean | Date

  export interface QueryFunction<Row = unknown, Params extends unknown[] = unknown[]> {
    get(...params: Params): Row | null
    all(...params: Params): Row[]
    run(...params: Params): void
  }

  export interface Statement<Params extends unknown[] = unknown[], Result = unknown> {
    run(...params: Params): void
    all(...params: Params): Result[]
    get(...params: Params): Result | null
  }

  export class Database {
    constructor(path: string, options?: DatabaseOptions)
    exec(sql: string): void
    query<Row = unknown, Params extends unknown[] = unknown[]>(
      sql: string,
    ): QueryFunction<Row, Params>
    prepare<Params extends unknown[] = unknown[], Result = unknown>(
      sql: string,
    ): Statement<Params, Result>
    close(): void
  }
}
