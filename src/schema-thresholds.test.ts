import { describe, expect, it } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { defaultScoringConfig } from "./scoring-engine"

const SCHEMA = JSON.parse(
  (() => {
    try {
      return readFileSync(join(process.cwd(), "assets", "omo-meta-governor.schema.json"), "utf-8")
    } catch {
      return readFileSync(join(import.meta.dir, "..", "assets", "omo-meta-governor.schema.json"), "utf-8")
    }
  })(),
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
