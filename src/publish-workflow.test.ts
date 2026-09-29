/**
 * B2: the publish workflow must NOT mask real failures with continue-on-error.
 *
 * Regression guard for W2-B2.1: neither the Publish step nor the Create
 * GitHub Release step in .github/workflows/publish.yml may set
 * `continue-on-error` — a real publish/release failure must turn the job red.
 * Idempotence is handled by explicit guards (release-exists check), not by
 * error suppression.
 */

import { describe, expect, it } from "bun:test"
import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

function loadPublishYml(): string {
  const here = dirname(fileURLToPath(import.meta.url))
  return readFileSync(join(here, "..", ".github", "workflows", "publish.yml"), "utf-8")
}

/** Split the steps sequence into per-step blocks keyed by step name. */
function stepBlocks(yml: string): Array<{ name: string; body: string }> {
  const lines = yml.split("\n")
  const blocks: Array<{ name: string; body: string }> = []
  let current: { name: string; lines: string[] } | null = null
  for (const line of lines) {
    const nameMatch = /^\s*-\s*name:\s*(.+?)\s*$/.exec(line)
    if (nameMatch) {
      if (current) blocks.push({ name: current.name, body: current.lines.join("\n") })
      current = { name: nameMatch[1]!.trim(), lines: [] }
    } else if (current) {
      current.lines.push(line)
    }
  }
  if (current) blocks.push({ name: current.name, body: current.lines.join("\n") })
  return blocks
}

describe("B2 publish workflow has no continue-on-error", () => {
  it("neither Publish nor Create GitHub Release sets continue-on-error", () => {
    const yml = loadPublishYml()
    const blocks = stepBlocks(yml)
    const targets = blocks.filter(
      (b) => b.name === "Publish" || b.name === "Create GitHub Release",
    )
    // The guard is vacuous if the steps disappear — pin their existence.
    expect(targets.map((t) => t.name).sort()).toEqual([
      "Create GitHub Release",
      "Publish",
    ])
    for (const t of targets) {
      expect(t.body).not.toMatch(/continue-on-error\s*:/)
    }
  })
})
