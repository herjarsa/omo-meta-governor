/**
 * Post-wave config projection tests — Wave 1 (RED).
 *
 * given/when/then style, mirroring config.test.ts. These tests pin the
 * contract that Wave 2 will implement: loadOrchestratorConfig must project
 * a `postWave` sub-config with derived defaults. Until the projection lands,
 * `result.postWave` is undefined, so every assertion below fails RED.
 */

import { describe, expect, it } from "bun:test"
import type { MetaGovernorPluginConfig } from "./config"
import { loadOrchestratorConfig } from "./config"

/**
 * Local structural view of the projected postWave shape. Defined here so
 * this RED test compiles while `OrchestratorConfig` has no `postWave` yet
 * (the projection lands in a later wave).
 */
interface PostWaveProjectedShape {
  enabled?: boolean
  repoMode?: "auto" | "third-party"
  ciTimeoutMs?: number
  maxRetriesPerWave?: number
  reinjectCooldownMs?: number
  aasToolPrefix?: string
  respectSilentMode?: boolean
}

/** User-facing postWave input the loader will accept (Wave 2). */
interface PostWaveUserInput {
  postWave?: {
    repoMode?: "auto" | "third-party"
    maxRetriesPerWave?: number
  }
}

type LoadablePostWaveConfig = Partial<MetaGovernorPluginConfig> & PostWaveUserInput

describe("loadOrchestratorConfig", () => {
  describe("#given phaseAwareDoneSignal true", () => {
    const result = loadOrchestratorConfig({ intervention: { phaseAwareDoneSignal: true } })

    it("then postWave.enabled defaults to true (derived from phaseAwareDoneSignal)", () => {
      expect((result as { postWave?: PostWaveProjectedShape }).postWave?.enabled).toBe(true)
    })
  })

  describe("#given phaseAwareDoneSignal false", () => {
    const result = loadOrchestratorConfig({ intervention: { phaseAwareDoneSignal: false } })

    it("then postWave.enabled defaults to false", () => {
      expect((result as { postWave?: PostWaveProjectedShape }).postWave?.enabled).toBe(false)
    })
  })

  describe("#given no options", () => {
    const result = loadOrchestratorConfig({})

    it("then postWave.repoMode defaults to 'auto'", () => {
      expect((result as { postWave?: PostWaveProjectedShape }).postWave?.repoMode).toBe("auto")
    })
    it("then postWave.ciTimeoutMs defaults to 600000", () => {
      expect((result as { postWave?: PostWaveProjectedShape }).postWave?.ciTimeoutMs).toBe(600000)
    })
    it("then postWave.maxRetriesPerWave defaults to 1", () => {
      expect((result as { postWave?: PostWaveProjectedShape }).postWave?.maxRetriesPerWave).toBe(1)
    })
    it("then postWave.reinjectCooldownMs defaults to 60000", () => {
      expect((result as { postWave?: PostWaveProjectedShape }).postWave?.reinjectCooldownMs).toBe(60000)
    })
    it("then postWave.aasToolPrefix defaults to 'aas'", () => {
      expect((result as { postWave?: PostWaveProjectedShape }).postWave?.aasToolPrefix).toBe("aas")
    })
    it("then postWave.respectSilentMode defaults to false", () => {
      expect((result as { postWave?: PostWaveProjectedShape }).postWave?.respectSilentMode).toBe(false)
    })
  })

  describe("#given explicit postWave overrides", () => {
    const input: LoadablePostWaveConfig = {
      postWave: { repoMode: "third-party", maxRetriesPerWave: 3 },
    }
    const result = loadOrchestratorConfig(input)

    it("then postWave.repoMode respects the user override", () => {
      expect((result as { postWave?: PostWaveProjectedShape }).postWave?.repoMode).toBe("third-party")
    })
    it("then postWave.maxRetriesPerWave respects the user override", () => {
      expect((result as { postWave?: PostWaveProjectedShape }).postWave?.maxRetriesPerWave).toBe(3)
    })
  })
})
