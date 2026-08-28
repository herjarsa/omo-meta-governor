/**
 * Schema sync contract tests — pin generate-schema.ts to the live runtime config.
 *
 * given/when/then style. Two contracts:
 * 1. The committed assets/omo-meta-governor.schema.json MUST equal what
 *    generateSchema() returns (byte-for-byte after stable serialization).
 *    Drift between the two has caused silent IDE hints to lie (P0 drift fixed
 *    in this commit).
 * 2. The schema MUST expose every field the runtime actually reads in
 *    loadOrchestratorConfig, plus the v0.25.0 ciMonitor block.
 */

import { describe, expect, it } from "bun:test"
import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { generateSchema, type JsonSchema } from "./generate-schema"

const SCHEMA_PATH = join(import.meta.dir, "..", "assets", "omo-meta-governor.schema.json")

async function loadCommittedSchema(): Promise<JsonSchema> {
  const text = await readFile(SCHEMA_PATH, "utf-8")
  return JSON.parse(text) as JsonSchema
}

describe("generateSchema — committed-asset sync contract", () => {
  it("then generateSchema() output equals assets/omo-meta-governor.schema.json byte-for-byte", async () => {
    const generated = JSON.stringify(generateSchema(), null, 2) + "\n"
    const committed = await readFile(SCHEMA_PATH, "utf-8")
    expect(generated).toBe(committed)
  })

  it("then committed JSON parses and re-serializes to the same shape", async () => {
    const generated = JSON.stringify(generateSchema())
    const committed = JSON.stringify(await loadCommittedSchema())
    expect(generated).toBe(committed)
  })
})

describe("generateSchema — ciMonitor block (v0.25.0)", () => {
  it("then exposes ciMonitor top-level with all CIMonitorConfig fields", () => {
    const schema = generateSchema()
    expect(schema.properties.ciMonitor).toBeDefined()
    const cm = schema.properties.ciMonitor.properties!
    expect(cm.enabled).toBeDefined()
    expect(cm.enabled.type).toBe("boolean")
    expect(cm.enabled.default).toBe(false)
    expect(cm.workflow).toBeDefined()
    expect(cm.workflow.type).toBe("string")
    expect(cm.pollIntervalMs).toBeDefined()
    expect(cm.pollIntervalMs.type).toBe("integer")
    expect(cm.pollIntervalMs.minimum).toBeGreaterThanOrEqual(0)
    expect(cm.maxWaitMs).toBeDefined()
    expect(cm.maxWaitMs.type).toBe("integer")
    expect(cm.failOnly).toBeDefined()
    expect(cm.failOnly.type).toBe("boolean")
    expect(cm.failOnly.default).toBe(true)
  })
})

describe("generateSchema — v0.18.0 config-drop fixes", () => {
  it("then decision exposes the three message-template fields (v0.18.0)", () => {
    const props = generateSchema().properties.decision.properties!
    expect(props.warnMessageTemplate).toBeDefined()
    expect(props.warnMessageTemplate.type).toBe("string")
    expect(props.escalateMessageTemplate).toBeDefined()
    expect(props.escalateMessageTemplate.type).toBe("string")
    expect(props.stopMessageTemplate).toBeDefined()
    expect(props.stopMessageTemplate.type).toBe("string")
  })

  it("then memory exposes the timeoutMs alias (v0.18.0)", () => {
    const props = generateSchema().properties.memory.properties!
    expect(props.timeoutMs).toBeDefined()
    expect(props.timeoutMs.type).toBe("integer")
    expect(props.timeoutMs.minimum).toBeGreaterThanOrEqual(100)
  })

  it("then scoring exposes paralysisThreshold and defaultEscalationTarget (v0.18.0)", () => {
    const props = generateSchema().properties.scoring.properties!
    expect(props.paralysisThreshold).toBeDefined()
    expect(props.paralysisThreshold.type).toBe("number")
    expect(props.paralysisThreshold.minimum).toBe(0)
    expect(props.paralysisThreshold.maximum).toBe(1)
    expect(props.defaultEscalationTarget).toBeDefined()
    expect(props.defaultEscalationTarget.enum).toEqual(["oracle", "user"])
  })

  it("then closedLoop exposes enabled, minSeverityToLearn, maxLessonsPerSession (v0.18.0)", () => {
    const props = generateSchema().properties.closedLoop.properties!
    expect(props.enabled).toBeDefined()
    expect(props.enabled.type).toBe("boolean")
    expect(props.enabled.default).toBe(true)
    expect(props.minSeverityToLearn).toBeDefined()
    expect(props.minSeverityToLearn.enum).toEqual(["leve", "media", "grave"])
    expect(props.minSeverityToLearn.default).toBe("media")
    expect(props.maxLessonsPerSession).toBeDefined()
    expect(props.maxLessonsPerSession.type).toBe("integer")
    expect(props.maxLessonsPerSession.default).toBe(20)
  })
})

describe("generateSchema — graphSync v0.25.1 / v0.26.0 fields", () => {
  it("then exposes autoInstall, installTimeoutMs, reindexOnFetch, fetchBranch", () => {
    const props = generateSchema().properties.graphSync.properties!
    expect(props.autoInstall).toBeDefined()
    expect(props.autoInstall.type).toBe("boolean")
    expect(props.autoInstall.default).toBe(true)
    expect(props.installTimeoutMs).toBeDefined()
    expect(props.installTimeoutMs.type).toBe("integer")
    expect(props.reindexOnFetch).toBeDefined()
    expect(props.reindexOnFetch.type).toBe("boolean")
    expect(props.reindexOnFetch.default).toBe(true)
    expect(props.fetchBranch).toBeDefined()
    expect(props.fetchBranch.type).toBe("string")
    expect(props.fetchBranch.default).toBe("main")
  })
})

describe("generateSchema — defaults must match runtime loadOrchestratorConfig", () => {
  it("then intervention.minActionForMessage defaults to 'stop' (not 'warn')", () => {
    // P0 drift fixed: config.ts:318 applies "stop"; the previous schema asserted "warn".
    // The runtime default IS the source of truth — schema must mirror it so IDE
    // hints do not lie.
    const iv = generateSchema().properties.intervention.properties!
    expect(iv.minActionForMessage.default).toBe("stop")
  })
})
