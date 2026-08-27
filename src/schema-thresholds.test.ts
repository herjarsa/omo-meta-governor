/**
 * v0.36.1 (audit P1-5 + Oracle review) — schema thresholds mirror runtime.
 *
 * Bug (v0.35.9): assets/omo-meta-governor.schema.json had
 * escalateThreshold 0.6 / stopThreshold 0.8 while src/scoring-engine.ts
 * defaults were 0.45 / 0.55. Config edited against the schema would
 * silently use unreachable thresholds.
 *
 * v0.36.1: contract test that reads the canonical schema file via a
 * deterministic path (import.meta.dir relative) and compares against
 * defaultScoringConfig(). No process.cwd() in the resolver.
 */
import { describe, expect, it } from "bun:test"
import { readFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { defaultScoringConfig } from "./scoring-engine"

const SCHEMA_PATH = resolve(import.meta.dir, "..", "assets", "omo-meta-governor.schema.json")

interface ScoringProps {
  continueThreshold: { default: number }
  warnThreshold: { default: number }
  escalateThreshold: { default: number }
  stopThreshold: { default: number }
}

function loadSchema(): ScoringProps {
  const raw = readFileSync(SCHEMA_PATH, "utf-8")
  const parsed = JSON.parse(raw) as { properties: { scoring: { properties: ScoringProps } } }
  return parsed.properties.scoring.properties
}

describe("P1-5 schema thresholds mirror runtime defaults", () => {
  const rt = defaultScoringConfig()
  const schema = loadSchema()

  it("then continueThreshold matches", () => {
    expect(schema.continueThreshold.default).toBe(rt.continueThreshold)
  })
  it("then warnThreshold matches", () => {
    expect(schema.warnThreshold.default).toBe(rt.warnThreshold)
  })
  it("then escalateThreshold matches", () => {
    expect(schema.escalateThreshold.default).toBe(rt.escalateThreshold)
  })
  it("then stopThreshold matches", () => {
    expect(schema.stopThreshold.default).toBe(rt.stopThreshold)
  })
})