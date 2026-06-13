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
      expect(props.memory.properties?.magicContextTimeoutMs).toBeDefined()
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
      expect(sc.escalateThreshold.default).toBe(0.6)
      expect(sc.stopThreshold.default).toBe(0.8)
    })

    it("then has intervention with enum constraints", () => {
      expect(props.intervention).toBeDefined()
      const iv = props.intervention.properties!
      expect(iv.mode.enum).toEqual(["silent", "message", "system"])
      expect(iv.mode.default).toBe("silent")
      expect(iv.minActionForMessage.enum).toEqual(["warn", "escalate", "stop"])
      expect(iv.minActionForMessage.default).toBe("warn")
      expect(iv.includeDecisionHistory.default).toBe(true)
      expect(iv.maxHistoryMessages.default).toBe(5)
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
        "protocolEnforcement", "graphSync",
      ]
      for (const key of expectedKeys) {
        expect(schema.properties[key]).toBeDefined()
      }
    })
  })
})
