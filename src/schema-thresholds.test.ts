/**
 * v0.36.0 (audit P1-5) — schema thresholds must mirror runtime defaults.
 *
 * Bug: assets/omo-meta-governor.schema.json had escalateThreshold 0.6 /
 * stopThreshold 0.8 while src/scoring-engine.ts:77-78 defaults were 0.45 /
 * 0.55. An operator editing config against the schema would get unreachable
 * escalation thresholds.
 */
import { describe, expect, it } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { defaultScoringConfig } from "./scoring-engine"

const SCHEMA = JSON.parse(
  readFileSync(join(import.meta.dir, "..", "assets", "omo-meta-governor.schema.json"), "utf-8"),
) as { properties: { scoring: { properties: { continueThreshold: { default: number }; warnThreshold: { default: number }; escalateThreshold: { default: number }; stopThreshold: { default: number } } } } }

describe("P1-5 schema thresholds mirror runtime defaults", () => {
  it("then continueThreshold matches", () => {
    const rt = defaultScoringConfig()
    expect(SCHEMA.properties.scoring.properties.continueThreshold.default).toBe(rt.continueThreshold)
  })
  it("then warnThreshold matches", () => {
    const rt = defaultScoringConfig()
    expect(SCHEMA.properties.scoring.properties.warnThreshold.default).toBe(rt.warnThreshold)
  })
  it("then escalateThreshold matches", () => {
    const rt = defaultScoringConfig()
    expect(SCHEMA.properties.scoring.properties.escalateThreshold.default).toBe(rt.escalateThreshold)
  })
  it("then stopThreshold matches", () => {
    const rt = defaultScoringConfig()
    expect(SCHEMA.properties.scoring.properties.stopThreshold.default).toBe(rt.stopThreshold)
  })
})
