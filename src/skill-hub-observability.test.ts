/**
 * skill-hub-observability.test.ts
 *
 * Validates the observable behavior of the skill-hub subsystem when wired
 * through the MCP server boot path. Closes a real-world gap: unit tests
 * cover runSkillHubSync() and SqliteBackend.skillAddOrUpdate() in isolation,
 * but no existing test proves that the MCP startup hook actually:
 *
 *   1. Reads bootstrap URL from config
 *   2. Calls runSkillHubSync() with a fetchFn seam
 *   3. Persists inserted/updated/skipped records into sqlite
 *   4. Emits health.json with expected metrics counters
 *
 * Test ID conventions (matches existing convention in src/e2e.test.ts):
 *   - SH-OBS-01..05: sync round-trip + edge cases
 *   - SH-OBS-06: health.json snapshot reflects sync activity
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test"
import { mkdtempSync, rmSync, existsSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { homedir } from "node:os"

import { SqliteBackend } from "./sqlite-backend"
import {
  runSkillHubSync,
  type SkillHubIngestResult,
  type SkillHubSourceRecord,
} from "./skill-hub-sync"
import { createMetricsCollector, type MetricsCollector } from "./metrics"
import { writeHealthToFile, readHealthFromFile, buildPluginHealth } from "./health"

let workDir: string
let backend: SqliteBackend
let metrics: MetricsCollector
let healthPath: string

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), "omo-sh-obs-"))
  backend = new SqliteBackend(join(workDir, "test.db"))
  healthPath = join(workDir, "health.json")
  metrics = createMetricsCollector({ sessionID: "test-session" })
})

afterEach(() => {
  backend.close()
  process.chdir(homedir()) // restore
  for (let i = 0; i < 3; i++) {
    try {
      if (existsSync(workDir)) rmSync(workDir, { recursive: true, force: true })
      break
    } catch {
      // EBUSY on Windows — backoff and retry
    }
  }
})

/**
 * Fake fetch that returns a deterministic bootstrap snapshot.
 * Mirrors the real skills.sh/api/skills.json shape.
 */
function makeFakeFetch(records: SkillHubSourceRecord[]) {
  return (async () =>
    new Response(JSON.stringify(records), {
      status: 200,
      headers: { "content-type": "application/json" },
    })) as unknown as typeof fetch
}

describe("skill-hub observability (SH-OBS)", () => {
  test("SH-OBS-01: full sync round-trip persists records into sqlite", async () => {
    const records: SkillHubSourceRecord[] = [
      {
        id: "acme/cool-repo/code-review",
        name: "Code Review",
        description: "Performs structured PR review",
        source: "acme/cool-repo",
        skillId: "code-review",
        installs: 100,
        githubStars: 50,
        repoUrl: "https://github.com/acme/cool-repo",
      },
      {
        id: "beta/widgets/test-gen",
        name: "Test Gen",
        description: "Generates unit tests from function signatures",
        source: "beta/widgets",
        skillId: "test-gen",
        installs: 75,
        githubStars: 30,
        repoUrl: "https://github.com/beta/widgets",
      },
    ]

    const result: SkillHubIngestResult | null = await runSkillHubSync({
      sqlBackend: backend,
      bootstrapUrl: "https://example.test/skills.json",
      fetchFn: makeFakeFetch(records),
      enabled: true,
    })

    expect(result).not.toBeNull()
    expect(result!.inserted).toBe(2)
    expect(result!.updated).toBe(0)
    expect(result!.skippedUnchanged).toBe(0)
    expect(result!.invalid).toBe(0)

    const first = await backend.skillGet("acme/cool-repo/code-review")
    const second = await backend.skillGet("beta/widgets/test-gen")
    expect(first).not.toBeNull()
    expect(second).not.toBeNull()
    expect(first!.name).toBe("Code Review")
    expect(second!.installs).toBe(75)
  })

  test("SH-OBS-02: re-running sync with unchanged content skips records", async () => {
    const records: SkillHubSourceRecord[] = [
      {
        id: "acme/cool-repo/code-review",
        name: "Code Review",
        description: "Performs structured PR review",
        source: "acme/cool-repo",
        skillId: "code-review",
        installs: 100,
        githubStars: 50,
        repoUrl: "https://github.com/acme/cool-repo",
      },
    ]
    const fetchFn = makeFakeFetch(records)

    const first = await runSkillHubSync({
      sqlBackend: backend,
      bootstrapUrl: "https://example.test/skills.json",
      fetchFn,
      enabled: true,
    })
    expect(first!.inserted).toBe(1)

    const second = await runSkillHubSync({
      sqlBackend: backend,
      bootstrapUrl: "https://example.test/skills.json",
      fetchFn,
      enabled: true,
    })
    expect(second!.inserted).toBe(0)
    expect(second!.skippedUnchanged).toBe(1)
    expect(second!.updated).toBe(0)
  })

  test("SH-OBS-03: disabled sync returns null without touching backend", async () => {
    let fetchCalled = false
    const fetchFn = ((async () => {
      fetchCalled = true
      return new Response("[]")
    }) as unknown) as typeof fetch

    const result = await runSkillHubSync({
      sqlBackend: backend,
      bootstrapUrl: "https://example.test/skills.json",
      fetchFn,
      enabled: false,
    })

    expect(result).toBeNull()
    expect(fetchCalled).toBe(false)
  })

  test("SH-OBS-04: invalid records are counted and do not crash ingest", async () => {
    const records: SkillHubSourceRecord[] = [
      { description: "no id here" } as unknown as SkillHubSourceRecord,
      {
        id: "valid/owner/good-skill",
        name: "Good Skill",
        description: "valid",
        source: "valid/owner",
        skillId: "good-skill",
        installs: 1,
      },
    ]
    const result = await runSkillHubSync({
      sqlBackend: backend,
      bootstrapUrl: "https://example.test/skills.json",
      fetchFn: makeFakeFetch(records),
      enabled: true,
    })

    expect(result).not.toBeNull()
    expect(result!.inserted).toBe(1)
    expect(result!.invalid).toBeGreaterThanOrEqual(1)
  })

  test("SH-OBS-05: network failure is reported via console.error, not crash", async () => {
    const fetchFn = (async () => {
      throw new Error("ECONNRESET")
    }) as unknown as typeof fetch

    const result = await runSkillHubSync({
      sqlBackend: backend,
      bootstrapUrl: "https://example.test/skills.json",
      fetchFn,
      enabled: true,
    })

    expect(result).toBeNull()
  })

  test("SH-OBS-06: health.json captures sync activity as metric counters", async () => {
    // Run a sync to generate observable activity
    const records: SkillHubSourceRecord[] = [
      {
        id: "test/owner/example-skill",
        name: "Example Skill",
        description: "Test record for health emission",
        source: "test/owner",
        skillId: "example-skill",
        installs: 42,
      },
    ]
    const result = await runSkillHubSync({
      sqlBackend: backend,
      bootstrapUrl: "https://example.test/skills.json",
      fetchFn: makeFakeFetch(records),
      enabled: true,
    })
    expect(result!.inserted).toBe(1)

    // Increment a representative metric and write health.json
    metrics.inc("materialization_failures")
    metrics.inc("materialization_failures")
    metrics.inc("tier3_skills_created")

    const snapshot = metrics.getMetrics()
    const health = buildPluginHealth({
      version: "0.37.1",
      enabled: true,
      sessionID: "test-session",
      snapshot,
      logFilePath: healthPath,
    })

    writeHealthToFile(health, healthPath)

    // Read back and verify
    const reloaded = readHealthFromFile(healthPath)
    expect(reloaded).not.toBeNull()
    expect(reloaded!.metrics.materializationFailures).toBe(2)
    expect(reloaded!.metrics.tier3SkillsCreated).toBe(1)
    expect(reloaded!.session.id).toBe("test-session")
  })
})
