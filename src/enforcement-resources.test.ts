/**
 * v0.37.0 (audit enforcement) — TDD test for MCP enforcement resources.
 *
 * Bug (audit v2 P0-2): In OpenChamber (HTTP mode), the plugin factory never
 * runs. Only MCP tools are exposed. All text-based instructions (Oracle rule 4,
 * agentmemory rule 8, skill-priming) live in `output.messages.push` /
 * `system.transform` which require plugin hooks. OpenChamber receives ZERO
 * enforcement.
 *
 * Fix: expose the rules as MCP resources that the agent can `resources/read`
 * at startup. Works in both plugin-CLI and OpenChamber modes.
 *
 * Contract:
 * - `meta-governor://rules/oracle` → Oracle gate rule text
 * - `meta-governor://rules/agentmemory` → omo_remember rule text
 * - `meta-governor://rules/skill-priming` → skill discovery rule text
 * - `meta-governor://rules/protocol` → Sisyphus protocol enforcement rules
 *
 * The returned text uses a `[SYSTEM-NUDGE]` prefix the LLM can detect.
 */
import { describe, expect, it } from "bun:test"
import {
  buildOracleRule,
  buildAgentMemoryRule,
  buildSkillPrimingRule,
  buildProtocolRule,
  ENFORCEMENT_RESOURCE_URIS,
} from "./enforcement-resources"

describe("P0-2 enforcement rules for OpenChamber MCP mode", () => {
  describe("resource URI registry", () => {
    it("then exposes 4 enforcement resources", () => {
      expect(ENFORCEMENT_RESOURCE_URIS).toContain("meta-governor://rules/oracle")
      expect(ENFORCEMENT_RESOURCE_URIS).toContain("meta-governor://rules/agentmemory")
      expect(ENFORCEMENT_RESOURCE_URIS).toContain("meta-governor://rules/skill-priming")
      expect(ENFORCEMENT_RESOURCE_URIS).toContain("meta-governor://rules/protocol")
    })
  })

  describe("Oracle gate rule (P0-1 enforcement)", () => {
    // v0.38.4 Option D: Oracle gate is now frequency-based, not file-count-based.
    // per-stop/final-only/off control mid-work Oracle; the final-gate ALWAYS fires.
    it("then documents the v0.38.4 Option D oracle.frequency semantics", () => {
      const text = buildOracleRule()
      expect(text).toContain('subagent_type="oracle"')
      expect(text).toContain("oracle.frequency")
      expect(text).toContain("per-stop")
      expect(text).toContain("final-only")
      expect(text).toContain('off')
      expect(text).toMatch(/run_in_background=false/)
    })

    it("then states the final-gate is ALWAYS Oracle-verified regardless of frequency", () => {
      const text = buildOracleRule()
      expect(text).toMatch(/final-gate.*ALWAYS.*Oracle/i)
    })

    it("then has SYSTEM-NUDGE prefix so the LLM can detect it", () => {
      const text = buildOracleRule()
      expect(text).toMatch(/^\[SYSTEM-NUDGE\]/)
    })

    it("then lists the INVOKE triggers (Oracle N4 protocol)", () => {
      const text = buildOracleRule()
      expect(text).toContain("created 1+ new file")
      expect(text).toContain("modified abstraction")
      expect(text).toContain("modified CI/CD")
      expect(text).toContain("added/removed dependency")
    })

    it("then says SKIP only when files touched <= 2 with no dependency change", () => {
      const text = buildOracleRule()
      expect(text).toMatch(/SKIP[\s\S]*?files touched <= 2/)
    })
  })

  describe("agentmemory / omo_remember rule (P0 audit)", () => {
    it("then instructs to call omo_remember when learning non-obvious facts", () => {
      const text = buildAgentMemoryRule()
      expect(text).toContain("omo_remember")
      expect(text).toMatch(/non-obvious|non-obvious/)
      expect(text).toContain("cross-session")
    })

    it("then says DO NOT save routine operations (F3.6 anti-pattern)", () => {
      const text = buildAgentMemoryRule()
      expect(text).toMatch(/DO NOT save.*routine/i)
    })

    it("then has SYSTEM-NUDGE prefix", () => {
      const text = buildAgentMemoryRule()
      expect(text).toMatch(/^\[SYSTEM-NUDGE\]/)
    })
  })

  describe("skill-priming rule (P1 audit)", () => {
    it("then instructs to call omo_skill_find before writing code", () => {
      const text = buildSkillPrimingRule()
      expect(text).toContain("omo_skill_find")
      expect(text).toMatch(/before writing code|before implementation/i)
    })

    it("then names graphify and codegraph as primary discovery tools", () => {
      const text = buildSkillPrimingRule()
      expect(text).toContain("codegraph")
      expect(text).toContain("graphify")
    })

    it("then has SYSTEM-NUDGE prefix", () => {
      const text = buildSkillPrimingRule()
      expect(text).toMatch(/^\[SYSTEM-NUDGE\]/)
    })
  })

  describe("protocol enforcement rule", () => {
    it("then contains the Sisyphus hard rules", () => {
      const text = buildProtocolRule()
      expect(text).toContain("Sisyphus")
      expect(text).toContain("as any") // forbidden
      expect(text).toContain("@ts-ignore") // forbidden
    })

    it("then says to use codegraph/graphify before grep", () => {
      const text = buildProtocolRule()
      expect(text).toMatch(/codegraph.*graphify.*before.*grep|grep.*last resort/i)
    })
  })
})