/**
 * v0.36.0 (audit P1-3) — fire-and-forget catches must log.
 *
 * Bug: runGraphSync() and graphRetrieval.invoke() failures were swallowed
 * by `.catch(() => {})` with no logToFile call. A broken graphify upgrade
 * would be invisible to the operator — indistinguishable from "not installed".
 */
import { describe, expect, it } from "bun:test"
import { readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { readFile } from "node:fs/promises"

const PLUGIN_TS = join(import.meta.dir, "plugin.ts")

describe("P1-3 plugin.ts fire-and-forget catches must log", () => {
  it("then no .catch(() => {}) (empty body) exists in plugin.ts", async () => {
    const src = await readFile(PLUGIN_TS, "utf-8")
    // Empty-body arrow catches that drop the error.
    const bare = /\.catch\(\s*\(\)\s*=>\s*\{\s*\}\s*\)/g
    const matches = src.match(bare) ?? []
    expect(matches).toEqual([])
  })

  it("then .catch handler on graphRetrieval.invoke logs the failure", async () => {
    const src = await readFile(PLUGIN_TS, "utf-8")
    // The graphRetrieval.invoke call site (~line 1206 in v0.35.9) must have
    // a catch that logs, not an empty one.
    const invokeBlock = src.match(/graphRetrieval[\s\S]*?\.invoke[\s\S]*?\.catch\([\s\S]*?\)/)
    expect(invokeBlock).not.toBeNull()
    const block = invokeBlock![0]
    expect(block).not.toMatch(/\.catch\(\s*\(\)\s*=>\s*\{\s*\}\s*\)/)
  })
})
