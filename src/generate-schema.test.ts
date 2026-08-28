/**
 * Tests for the JSON Schema generator.
 *
 * given/when/then style covering:
 * - Schema structure and metadata
 * - All top-level properties present
 * - Type and constraint correctness
 * - Nested property schemas
 */

import { describe, expect, it } from "bun:test"
import { generateSchema, type JsonSchema } from "./generate-schema"

describe("generateSchema", () => {
  const schema: JsonSchema = generateSchema()

  describe("#given a generated schema", () => {
    it("then has correct $schema and $id", () => {
      expect(schema.$schema).toBe("http://json-schema.org/draft-07/schema#")
      expect(schema.$id).toContain("omo-meta-governor.schema.json")
    })

    it("then has correct title and description", () => {
      expect(schema.title).toBe("omo-meta-governor")
      expect(schema.description).toContain("Self-judging agent orchestration")
    })

    it("then is type object with additionalProperties false", () => {
      expect(schema.type).toBe("object")
      expect(schema.additionalProperties).toBe(false)
    })
  })

  describe("#given the properties map", () => {
    const props = schema.properties

    it("then has enabled boolean with default false", () => {
      expect(props.enabled).toBeDefined()
      expect(props.enabled.type).toBe("boolean")
      expect(props.enabled.default).toBe(false)
    })

    it("then has decision object with sub-properties", () => {
      expect(props.decision).toBeDefined()
      expect(props.decision.type).toBe("object")
      expect(props.decision.properties?.maxHistoryPerSession).toBeDefined()
      expect(props.decision.properties?.maxHistoryPerSession.type).toBe("integer")
      expect(props.decision.properties?.maxHistoryPerSession.default).toBe(50)
      expect(props.decision.properties?.forceContinueAfterStops).toBeDefined()
    })

    it("then has memory object with timeout sub-properties", () => {
      expect(props.memory).toBeDefined()
      expect(props.memory.properties?.agentmemoryTimeoutMs).toBeDefined()
      expect(props.memory.properties?.agentmemoryTimeoutMs.default).toBe(2000)
        expect(props.memory.properties?.boulderStateTimeoutMs).toBeDefined()
      expect(props.memory.properties?.query).toBeDefined()
      expect(props.memory.properties?.query.default).toBe("meta_governor_context")
    })

    it("then has tokenPredictor with correct defaults", () => {
      expect(props.tokenPredictor).toBeDefined()
      const tp = props.tokenPredictor.properties!
      expect(tp.compactBurnRateThreshold.default).toBe(500)
      expect(tp.compactUsageThreshold.default).toBe(0.85)
      expect(tp.switchModelUsageThreshold.default).toBe(0.95)
      expect(tp.delegateConsecutiveHighBurn.default).toBe(5)
    })

    it("then has scoring with threshold properties", () => {
      expect(props.scoring).toBeDefined()
      const sc = props.scoring.properties!
      expect(sc.continueThreshold.default).toBe(0.3)
      expect(sc.warnThreshold.default).toBe(0.3)
      expect(sc.escalateThreshold.default).toBe(0.45)
      expect(sc.stopThreshold.default).toBe(0.55)
    })

it("then has intervention with enum constraints", () => {
      expect(props.intervention).toBeDefined()
      const iv = props.intervention.properties!
      expect(iv.mode.enum).toEqual(["silent", "message", "system"])
      expect(iv.mode.default).toBe("silent")
      expect(iv.minActionForMessage.enum).toEqual(["warn", "escalate", "stop"])
      expect(iv.minActionForMessage.default).toBe("stop")
      expect(iv.includeDecisionHistory.default).toBe(true)
      expect(iv.maxHistoryMessages.default).toBe(5)
    })

    it("then has intervention with all v0.10–v0.19 fields", () => {
      const iv = props.intervention.properties!
      // v0.19.0
      expect(iv.persistToSession).toBeDefined()
      expect(iv.persistToSession.type).toBe("boolean")
      expect(iv.persistToSession.default).toBe(true)
      // v0.10.0
      expect(iv.maxInterventionsPerSession).toBeDefined()
      expect(iv.maxInterventionsPerSession.type).toBe("integer")
      expect(iv.maxInterventionsPerSession.default).toBe(3)
      // v0.10.0/0.15.0
      expect(iv.respectDoneSignal).toBeDefined()
      expect(iv.respectDoneSignal.type).toBe("boolean")
      expect(iv.respectDoneSignal.default).toBe(true)
      // v0.15.0
      expect(iv.phaseAwareDoneSignal).toBeDefined()
      expect(iv.phaseAwareDoneSignal.type).toBe("boolean")
      expect(iv.phaseAwareDoneSignal.default).toBe(false)
    })

    it("then has modelOverride with all sub-fields", () => {
      expect(props.modelOverride).toBeDefined()
      const mo = props.modelOverride.properties!
      expect(mo.providerID).toBeDefined()
      expect(mo.modelID).toBeDefined()
      expect(mo.modelLimit).toBeDefined()
      expect(mo.temperature.default).toBe(0.2)
      expect(mo.temperature.minimum).toBe(0)
      expect(mo.temperature.maximum).toBe(2)
      expect(mo.verbosity.enum).toEqual(["silent", "minimal", "verbose"])
      expect(mo.reasoning.default).toBe(false)
    })

    it("then has protocolEnforcement", () => {
      expect(props.protocolEnforcement).toBeDefined()
      const pe = props.protocolEnforcement.properties!
      expect(pe.enabled.default).toBe(false)
      expect(pe.injectIntoSystem.default).toBe(false)
      expect(pe.auditToolCalls.default).toBe(false)
    })

    it("then has graphSync with enabled/watch", () => {
      expect(props.graphSync).toBeDefined()
      const gs = props.graphSync.properties!
      expect(gs.enabled.default).toBe(true)
      expect(gs.watch.default).toBe(false)
    })

it("then has $schema string property", () => {
expect(props.$schema).toBeDefined()
expect(props.$schema.type).toBe("string")
    })

    describe("#given skillPriming block (v0.33.1)", () => {
      it("then exposes router enum including 'registry' and defaults to 'registry'", () => {
        expect(props.skillPriming).toBeDefined()
        const sp = props.skillPriming.properties!
        expect(sp.router.enum).toEqual(["registry", "superpowers", "both", "aas"])
        expect(sp.router.default).toBe("registry")
      })
      it("then defaults enabled to true (v0.33.1: skill workflow fires out of the box)", () => {
        expect(props.skillPriming.properties!.enabled.default).toBe(true)
      })
    })

    describe("#given skillHub block (v0.32.0)", () => {
      it("then is present with enabled default false and all v0.32 sub-properties", () => {
        expect(props.skillHub).toBeDefined()
        const sh = props.skillHub.properties!
        expect(props.skillHub.additionalProperties).toBe(false)
        expect(sh.enabled.default).toBe(false)
        expect(sh.syncIntervalMs.default).toBe(86400000)
        expect(sh.bootstrapUrl.type).toBe("string")
        expect(sh.searchFallbackUrl.type).toBe("string")
        expect(sh.downloadBaseUrl.type).toBe("string")
        expect(sh.embedBaseUrl.type).toBe("string")
        expect(sh.embedModel.default).toBe("bge-m3")
        expect(sh.minInstalls.default).toBe(0)
        expect(sh.filterDuplicates.default).toBe(true)
        expect(sh.depsCheck.default).toBe(true)
      })
    })

    describe("#given postWave block (v0.21.0)", () => {
      it("then is present with enabled default false and all v0.21 sub-properties", () => {
        expect(props.postWave).toBeDefined()
        const pw = props.postWave.properties!
        expect(props.postWave.additionalProperties).toBe(false)
        expect(pw.enabled.default).toBe(false)
        expect(pw.repoMode.enum).toEqual(["auto", "own", "third-party"])
        expect(pw.repoMode.default).toBe("auto")
        expect(pw.aasToolPrefix.default).toBe("aas")
        expect(pw.ciTimeoutMs.default).toBe(600000)
        expect(pw.maxRetriesPerWave.default).toBe(1)
        expect(pw.reinjectCooldownMs.default).toBe(60000)
        expect(pw.respectSilentMode.default).toBe(false)
  })
    })

    describe("#given graphRetrieval block (v0.25.0)", () => {
      it("then exposes preferredTool enum with auto default", () => {
        expect(props.graphRetrieval).toBeDefined()
        const gr = props.graphRetrieval.properties!
        expect(gr.preferredTool.enum).toEqual(["auto", "codegraph", "graphify", "alternate"])
        expect(gr.preferredTool.default).toBe("auto")
        expect(gr.preferLocalCodegraph.default).toBe(false)
        expect(gr.contextRouting.default).toBe(false)
      })
    })
  })
  describe("#given the definitions", () => {
    it("then has verbosity, interventionMode, minAction definitions", () => {
      expect(schema.definitions?.verbosity).toBeDefined()
      expect(schema.definitions?.interventionMode).toBeDefined()
      expect(schema.definitions?.minAction).toBeDefined()
    })
  })

  describe("#given total property count", () => {
    it("then has all expected top-level properties", () => {
const expectedKeys = [
"$schema", "enabled", "decision", "memory", "tokenPredictor",
"scoring", "closedLoop", "modelOverride", "intervention",
        "protocolEnforcement", "skillPriming", "skillHub", "graphSync",
        "postWave", "graphRetrieval",
      ]
      for (const key of expectedKeys) {
        expect(schema.properties[key]).toBeDefined()
      }
    })
  })

  // v0.36.1: contract test — scoring schema defaults must mirror the
  // runtime scoring engine defaults. Single source of truth = src/scoring-engine.ts.
  describe("#given schema-runtime contract", () => {
    it("then scoring schema defaults equal defaultScoringConfig()", async () => {
      const { defaultScoringConfig } = await import("./scoring-engine")
      const rt = defaultScoringConfig()
      const sc = schema.properties.scoring.properties!
      expect(sc.continueThreshold.default).toBe(rt.continueThreshold)
      expect(sc.warnThreshold.default).toBe(rt.warnThreshold)
      expect(sc.escalateThreshold.default).toBe(rt.escalateThreshold)
      expect(sc.stopThreshold.default).toBe(rt.stopThreshold)
    })
  })
})
