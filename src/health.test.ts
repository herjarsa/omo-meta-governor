/**
 * Tests for health module — writes plugin health state to JSON file and
 * exports a programmatic API. Closes the observability gap (C3/C4): the
 * user can `cat ~/.config/opencode/meta-governor-health.json` to see
 * exactly what the plugin is doing.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test"
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { writeHealthToFile, readHealthFromFile, type PluginHealth } from "./health"

let workDir: string
let healthPath: string

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), "health-test-"))
  healthPath = join(workDir, "health.json")
})

afterEach(() => {
  if (existsSync(workDir)) rmSync(workDir, { recursive: true, force: true })
})

describe("health module", () => {
  describe("#writeHealthToFile / #readHealthFromFile", () => {
    test("writes valid JSON to the specified path", () => {
      const health: PluginHealth = {
        version: "0.13.0",
        status: "healthy",
        enabled: true,
        startedAtISO: new Date().toISOString(),
        uptimeMs: 1000,
        metrics: {
          decisionsTaken: 5,
          decisionsStored: 3,
          interventionsDelivered: 1,
          orchestratorRuns: 42,
          orchestratorErrors: 0,
          lastDecisionISO: new Date().toISOString(),
          lastInterventionISO: new Date().toISOString(),
        },
        logFile: { path: "/tmp/test.log", sizeBytes: 1024, rotatedFiles: 0 },
        session: {
          id: "test-session",
          toolCallsObserved: 10,
          violationsDetected: 0,
          interventionsSkipped: 0,
          firstSeenISO: new Date().toISOString(),
          lastSeenISO: new Date().toISOString(),
        },
      }
      writeHealthToFile(health, healthPath)
      expect(existsSync(healthPath)).toBe(true)
      const read = readHealthFromFile(healthPath)
      expect(read).toEqual(health)
    })

    test("round-trips a complex health object", () => {
      const original: PluginHealth = {
        version: "0.13.0",
        status: "degraded",
        enabled: true,
        startedAtISO: "2026-07-20T15:00:00.000Z",
        uptimeMs: 60000,
        metrics: {
          decisionsTaken: 100,
          decisionsStored: 80,
          interventionsDelivered: 25,
          orchestratorRuns: 500,
          orchestratorErrors: 3,
          lastDecisionISO: "2026-07-20T15:01:00.000Z",
          lastInterventionISO: "2026-07-20T15:00:30.000Z",
        },
        logFile: { path: "/var/log/meta.log", sizeBytes: 5242880, rotatedFiles: 2 },
        session: {
          id: "sess-abc",
          toolCallsObserved: 47,
          violationsDetected: 2,
          interventionsSkipped: 5,
          firstSeenISO: "2026-07-20T15:00:01.000Z",
          lastSeenISO: "2026-07-20T15:01:30.000Z",
        },
      }
      writeHealthToFile(original, healthPath)
      const restored = readHealthFromFile(healthPath)
      expect(restored).toEqual(original)
    })

    test("returns null when file does not exist", () => {
      const missing = join(workDir, "nonexistent.json")
      const result = readHealthFromFile(missing)
      expect(result).toBeNull()
    })

    test("returns null when file is malformed JSON", () => {
      writeFileSync(healthPath, "{ this is not valid json")
      const result = readHealthFromFile(healthPath)
      expect(result).toBeNull()
    })
  })
})
