/**
 * Oracle default pin — final-only everywhere.
 *
 * Pins the conscious decision: zero mid-work Oracle
 * prompts by default; Oracle fires ONLY at the
 * DONE final-gate. Any drift back to per-stop
 * default must fail loudly here.
 */

import { describe, expect, it } from "bun:test"
import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { loadOrchestratorConfig } from "./config"
import { defaultScoringConfig, score } from "./scoring-engine"
import { defaultOrchestratorConfig } from "./orchestrator"
import { generateSchema } from "./generate-schema"
import type { DecisionContext } from "./types"
describe("oracle default pin — final-only", () => {
  it("then defaultScoringConfig is final-only", () => {
    expect(defaultScoringConfig().oracleFrequency).toBe("final-only")
  })

  it("then defaultOrchestratorConfig is final-only", () => {
    const cfg = defaultOrchestratorConfig()
    expect(cfg.oracle?.frequency).toBe("final-only")
    expect(cfg.scoring.oracleFrequency).toBe("final-only")
  })

  it("then loadOrchestratorConfig(undefined) is final-only", () => {
    expect(loadOrchestratorConfig(undefined).scoring.oracleFrequency).toBe("final-only")
  })

  it("then loadOrchestratorConfig({}) is final-only", () => {
    expect(loadOrchestratorConfig({}).scoring.oracleFrequency).toBe("final-only")
  })

  it("then explicit oracle.frequency off is respected", () => {
    const r = loadOrchestratorConfig({ enabled: true, oracle: { frequency: "off" } })
    expect(r.scoring.oracleFrequency).toBe("off")
  })
  it("then deprecated scoring.oracleFrequency fallback is respected", () => {
    const r = loadOrchestratorConfig({ enabled: true, scoring: { oracleFrequency: "per-stop" } })
    expect(r.scoring.oracleFrequency).toBe("per-stop")
  })

  it("then oracle.frequency wins over deprecated scoring.oracleFrequency", () => {
    const r = loadOrchestratorConfig({
      enabled: true,
      oracle: { frequency: "off" },
      scoring: { oracleFrequency: "per-stop" },
    })
    expect(r.scoring.oracleFrequency).toBe("off")
  })

  it("then generateSchema default is final-only", () => {
    const schema = generateSchema()
    const freq = (schema.properties.oracle as any).properties.frequency
    expect(freq.default).toBe("final-only")
  })
  it("then committed schema.json default is final-only", async () => {
    const p = join(import.meta.dir, "..", "assets", "omo-meta-governor.schema.json")
    const raw = JSON.parse(await readFile(p, "utf-8"))
    expect(raw.properties.oracle.properties.frequency.default).toBe("final-only")
  })

  it("then score() default never escalates to oracle mid-work", () => {
    const ctx: DecisionContext = {
      oracleVerified: false,
      noProgress: true,
      deviations: [
        { severity: "grave", category: "t", detail: "s1" },
        { severity: "grave", category: "t", detail: "s2" },
        { severity: "grave", category: "t", detail: "s3" },
      ],
      iterationRatio: 1.5,
      lessonsRelevant: [],
      slotMemory: { consecutiveStops: 0, consecutiveContinues: 0, lastUpdatedISO: new Date().toISOString() },
      ambient: { sessionID: "pin", directory: "/tmp", mode: "ultrawork", agentName: "a", iteration: 9, maxIterations: 10 },
    }
    expect(score(ctx).decision.shouldEscalateTo).toBeNull()
  })
})
