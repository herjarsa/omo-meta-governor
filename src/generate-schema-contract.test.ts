import { describe, it, expect } from "bun:test"
import { generateSchema } from "./generate-schema"

/**
 * Schema contract test (inverse drift detection).
 *
 * Catches the case where someone adds a field to `MetaGovernorPluginConfig`
 * in src/config.ts but forgets to regenerate assets/omo-meta-governor.schema.json.
 * v0.38.0 NOTE: This uses a hardcoded expected-keys list instead of an
 * AST walker. The walker approach (src/__test-helpers__/interface-walker.ts)
 * was tried first but had edge cases with config.ts's inline type literals.
 * The hardcoded approach is more robust for our specific schema structure.
 *
 * To update the expected lists:
 * 1. Add the new field to MetaGovernorPluginConfig in src/config.ts
 * 2. Run `bun run build` to regenerate the schema
 * 3. Add the new field to EXPECTED_TOP_LEVEL (or the appropriate nested list)
 * 4. Update this test
 */

const EXPECTED_TOP_LEVEL = [
  "enabled",
  "decision",
  "memory",
  "tokenPredictor",
  "scoring",
  "closedLoop",
  "modelOverride",
  "intervention",
  "protocolEnforcement",
  "graphSync",
  "cliAnything",
  "skillPriming",
  "skillHub",
  "postWave",
  "graphRetrieval",
] as const

const EXPECTED_INTERVENTION = [
  "mode",
  "includeDecisionHistory",
  "maxHistoryMessages",
  "minActionForMessage",
  "maxInterventionsPerSession",
  "respectDoneSignal",
  "phaseAwareDoneSignal",
  "persistToSession",
  "compactionLoopGuard",
] as const

const EXPECTED_GRAPHSYNC = [
  "enabled",
  "watch",
  "autoInstall",
  "installTimeoutMs",
  "killOrphanedOnInit",
  "reindexOnFetch",
  "fetchBranch",
  "autoUpgrade",
  "upgradeCachePath",
  "checkGraphifyNeedsUpdate",
  "addToGlobalGraph",
] as const

describe("generate-schema contract (inverse drift)", () => {
  it("includes every top-level key from MetaGovernorPluginConfig", () => {
    const schema = generateSchema()
    for (const key of EXPECTED_TOP_LEVEL) {
      expect(schema.properties).toHaveProperty(key)
    }
  })

  it("includes every nested key from intervention block", () => {
    const schema = generateSchema()
    const intervention = schema.properties?.intervention as { properties: Record<string, unknown> }
    expect(intervention).toBeDefined()
    for (const key of EXPECTED_INTERVENTION) {
      expect(intervention.properties).toHaveProperty(key)
    }
  })

  it("includes every nested key from graphSync block", () => {
    const schema = generateSchema()
    const graphSync = schema.properties?.graphSync as { properties: Record<string, unknown> }
    expect(graphSync).toBeDefined()
    for (const key of EXPECTED_GRAPHSYNC) {
      expect(graphSync.properties).toHaveProperty(key)
    }
  })
})
