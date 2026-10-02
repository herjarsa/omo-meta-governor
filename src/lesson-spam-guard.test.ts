/**
 * Lesson-spam guard — Wave A P1 (T-5df16a0e).
 *
 * Root cause: 5,311 `Action "continue"` lessons at confidence ~0.3 flooded
 * agentmemory recall. Every turn ran observeAndLearn() with a neutral
 * `continue` decision + non-empty evidence, and nothing filtered by action,
 * confidence, or content identity — so noise persisted row after row.
 *
 * Contract pinned here (v0.51.1):
 * - T1: neutral `continue` (action=continue, |score| < 0.5) with evidence
 *       NEVER persists a lesson (decision records still save).
 * - T2: real dedupe in save — identical lessons persist exactly once via
 *       the stable conscienceDedupeKey (score floats excluded), and both
 *       observeAndLearn() and recordRecovery() forward the key.
 * - T3: autoRemember 5-minute cooldown is genuinely wired — the projected
 *       default (cooldownMs omitted) suppresses a second distinct escalate
 *       inside the window and fires again once it elapses.
 * - T4: backfill — purgeNoiseLessons() deletes exactly
 *       `kind='lesson' AND confidence < 0.5 AND title LIKE 'Action "continue"%'`
 *       and post-purge recall returns high-value lessons, not [] and not noise.
 *
 * SCOPE WARNING (T4): purge runs ONLY against a tmp DB file created in this
 * file. NEVER point purgeNoiseLessons() at the prod DB
 * (~/.omo-meta-governor/meta-governor.db) outside an explicit, reviewed
 * ops runbook.
 */
import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, unlinkSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PluginInput, PluginOptions } from "@opencode-ai/plugin";
import { createMetaGovernorPlugin } from "./plugin";
import { clearAll, storeDecision } from "./decision-store";
import type {
  AgentmemoryWriteBackend,
  Decision,
  DecisionHandlerOutput,
  LearnFromOutcomeInput,
} from "./types";
import {
  conscienceDedupeKey,
  defaultClosedLoopConfig,
  MIN_LESSON_CONFIDENCE,
  observeAndLearn,
} from "./closed-loop-learning";
import { recordRecovery } from "./post-repair-recorder";
import { SqliteBackend } from "./sqlite-backend";
import { openDatabase } from "./sqlite-driver";

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

function makeMemoryRead() {
  return {
    query: "test",
    timestampISO: "2026-09-29T00:00:00.000Z",
    agentmemory: { available: true, lessons: [] },
    boulderState: { available: true, tasks: [], planProgress: 0 },
    degradedSources: [],
  };
}

function makeWarnInput(): LearnFromOutcomeInput {
  const decision: Decision = {
    action: "warn",
    score: -0.7,
    reasoning: "test reasoning",
    evidence: [
      { source: "deviation-detector", value: "config-change", confidence: 0.9, weight: 0.5 },
    ],
    shouldEscalateTo: null,
  };
  return {
    decision,
    memoryRead: makeMemoryRead(),
    config: defaultClosedLoopConfig(),
    sessionID: "ses_p1_guard",
    directory: "/tmp/test",
    filesChanged: ["src/foo.ts"],
  };
}

// ---------------------------------------------------------------------------
// T1: neutral continue never persists a lesson
// ---------------------------------------------------------------------------

describe("P1 lesson-spam guard", () => {
  it("T1: neutral continue WITH evidence persists NO lesson (decision still saves) [ses_p1_neutral_continue]", async () => {
    const lessonCalls: Array<{ content: string }> = [];
    const backend: AgentmemoryWriteBackend = {
      saveMemory: async () => ({ id: "mem-1" }),
      saveLesson: async (input) => {
        lessonCalls.push(input);
        return { id: "les-1" };
      },
    };
    // Neutral continue (score ~0) WITH deviation evidence: this exact shape
    // produced the 5311-row spam class. Evidence confidence is HIGH (0.8) on
    // purpose — the action filter (not the confidence gate) must block it.
    const decision: Decision = {
      action: "continue",
      score: 0.05,
      reasoning: "idle wait, nothing to do",
      evidence: [
        { source: "deviation-detector", value: "idle-wait", confidence: 0.8, weight: 0.3 },
      ],
      shouldEscalateTo: null,
    };
    const input: LearnFromOutcomeInput = {
      decision,
      memoryRead: makeMemoryRead(),
      config: defaultClosedLoopConfig(),
      sessionID: "ses_p1_neutral_continue",
      directory: "/tmp/test",
      filesChanged: [],
    };

    const result = await observeAndLearn(input, backend);

    expect(result.lessonSaved).toBeNull();
    expect(lessonCalls.length).toBe(0);
    expect(result.decisionSaved).not.toBeNull();
    expect(result.reason).toContain("continue");
  });

  // -------------------------------------------------------------------------
  // T2: duplicate lessons persist exactly once (real dedupe in save)
  // -------------------------------------------------------------------------

  it("T2: saveLesson with the same dedupeKey persists ONE row; callers forward the key", async () => {
    const dbPath = join(tmpdir(), `omo-spam-guard-dedupe-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
    const backend = new SqliteBackend(dbPath);
    try {
      const key = conscienceDedupeKey({
        action: "escalate",
        evidenceSources: ["deviation-detector"],
        deviationCategories: ["conscience"],
      });
      const lesson = {
        content: "Action escalate after conscience: repeated storm",
        context: "session:ses_p1_dedupe dir:/tmp",
        confidence: 0.8,
        tags: ["conscience"],
        dedupeKey: key,
      };
      const r1 = await backend.saveLesson(lesson);
      const r2 = await backend.saveLesson(lesson);

      expect(r2.deduped).toBe(true);
      expect(r2.id).toBe(r1.id);
      const counter = openDatabase(dbPath);
      try {
        const row = counter.prepare("SELECT COUNT(*) AS n FROM entries WHERE kind = 'lesson'").get() as { n: number } | undefined;
        expect(row?.n).toBe(1);
      } finally {
        counter.close();
      }

      // observeAndLearn forwards a stable key (score jitter must not change it).
      let forwardedObserve: string | undefined;
      const capturingObserve: AgentmemoryWriteBackend = {
        saveMemory: async () => ({ id: "m" }),
        saveLesson: async (i) => {
          forwardedObserve = i.dedupeKey;
          return { id: "l" };
        },
      };
      await observeAndLearn(makeWarnInput(), capturingObserve);
      expect(forwardedObserve).toBe(
        conscienceDedupeKey({
          action: "warn",
          evidenceSources: ["deviation-detector"],
          deviationCategories: ["deviation-detector"],
        }),
      );

      // recordRecovery forwards a stable key per recovery category.
      let forwardedRecovery: string | undefined;
      const capturingRecovery: AgentmemoryWriteBackend = {
        saveMemory: async () => ({ id: "m" }),
        saveLesson: async (i) => {
          forwardedRecovery = i.dedupeKey;
          return { id: "l" };
        },
      };
      await recordRecovery(
        {
          errorCode: "TOOL_TIMEOUT",
          fixStrategy: "retry",
          success: false,
          sessionID: "ses_p1_dedupe",
          directory: "/tmp",
        },
        capturingRecovery,
      );
      expect(forwardedRecovery).toBe(
        conscienceDedupeKey({
          action: "warn",
          evidenceSources: ["deviation-detector"],
          deviationCategories: ["recovery:retry"],
        }),
      );
    } finally {
      try {
        backend.close();
      } catch {
        // best-effort
      }
      for (const p of [dbPath, dbPath + "-wal", dbPath + "-shm", dbPath + "-journal"]) {
        try {
          if (existsSync(p)) unlinkSync(p);
        } catch {
          // EBUSY on Windows — best-effort cleanup
        }
      }
    }
  });

  // -------------------------------------------------------------------------
  // T4: backfill purge on a tmp DB only (placed before T3: no plugin harness)
  // -------------------------------------------------------------------------

  it("T4: purgeNoiseLessons deletes Action-continue<0.5 noise, keeps high value (tmp DB only)", async () => {
    expect(MIN_LESSON_CONFIDENCE).toBe(0.5);
    const dbPath = join(tmpdir(), `omo-spam-guard-purge-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
    const backend = new SqliteBackend(dbPath);
    try {
      // Seed via a second connection (same precedent as the boulderRead test).
      // These rows simulate the 5311-row prod noise class + one keeper.
      const seed = openDatabase(dbPath);
      try {
        seed.exec(
          "INSERT INTO entries (id, kind, title, content, confidence, tags, files, session_id, directory, created_at) VALUES " +
            "('n1', 'lesson', 'Action \"continue\" (score 0.10) after deviations: idle', 'Action \"continue\" (score 0.10) spam body', 0.3, '[]', '[]', '', '', 1000)," +
            "('n2', 'lesson', 'Action \"continue\" (score 0.05) after deviations: idle', 'Action \"continue\" (score 0.05) spam body', 0.2, '[]', '[]', '', '', 1001)," +
            "('g1', 'lesson', 'escalate after conscience: omo-meta-governor publish', 'High-value lesson: verify the publish workflow via omo_recall before release', 0.9, '[\"omo-meta-governor\",\"publish\"]', '[]', '', '', 1002)",
        );
      } finally {
        seed.close();
      }

      const purged = backend.purgeNoiseLessons();
      expect(purged).toBe(2);

      // Noise is gone from recall...
      const noise = await backend.smartSearch({ query: "continue deviations idle" });
      expect(noise.lessons.length).toBe(0);

      // ...and recall returns the high-value lesson, not [].
      const good = await backend.smartSearch({ query: "omo-meta-governor publish" });
      expect(good.lessons.length).toBe(1);
      expect(good.lessons[0]?.confidence).toBe(0.9);
      expect(good.lessons[0]?.content).toContain("publish workflow");
    } finally {
      try {
        backend.close();
      } catch {
        // best-effort
      }
      for (const p of [dbPath, dbPath + "-wal", dbPath + "-shm", dbPath + "-journal"]) {
        try {
          if (existsSync(p)) unlinkSync(p);
        } catch {
          // EBUSY on Windows — best-effort cleanup
        }
      }
    }
  });
});

// ---------------------------------------------------------------------------
// T3: autoRemember 5-minute cooldown is really wired (plugin harness)
// ---------------------------------------------------------------------------

const mockBaseInput = {
  client: null as unknown as PluginInput["client"],
  project: null as unknown as PluginInput["project"],
  worktree: "",
  experimental_workspace: { register: () => {} },
  serverUrl: new URL("http://localhost"),
  $: null as unknown as PluginInput["$"],
} as const;

function mockPluginInput(directory = ""): PluginInput {
  return { ...mockBaseInput, directory } as PluginInput;
}

function midSessionOutput(sid: string) {
  return {
    messages: [
      { info: { role: "user", sessionID: sid }, parts: [{ type: "text", text: "first ask" }] },
      { info: { role: "assistant", sessionID: sid, agent: "build" }, parts: [{ type: "text", text: "first reply" }] },
      { info: { role: "user", sessionID: sid }, parts: [{ type: "text", text: "hi" }] },
    ] as Array<{ info: unknown; parts: unknown[] }>,
  };
}

function makePluginDecision(action: DecisionHandlerOutput["action"], sid: string, message: string): DecisionHandlerOutput {
  return {
    action,
    message,
    historyEntry: {
      decision: { action, score: -0.5, reasoning: message, evidence: [], shouldEscalateTo: null },
      action,
      timestampISO: new Date().toISOString(),
      sessionID: sid,
      reasoning: message,
    },
  };
}

function createHermeticExtra(deps: Record<string, unknown> = {}) {
  return {
    __test_runGraphSync: async () => ({
      attempted: false,
      codes: ["disabled"] as never,
      availability: { codegraph: false, graphify: false, codegraphIndexExists: false, graphifyIndexExists: false },
      alreadyInitialized: true,
    }),
    __test_runCliAnythingSync: async () => ({
      attempted: false,
      codes: ["cli-hub-version-probed"] as never,
      availability: { cliHub: false, cliHubVersion: null, metaSkill: false },
      alreadyInitialized: true,
    }),
    __test_startSkillsFsWatcher: async () => ({ stop: async () => {} }),
    __test_persistSessionMessage: async () => ({ ok: true, messageID: null, error: null, durationMs: 0 }),
    ...deps,
  } as never;
}

describe("P1 autoRemember 5-minute cooldown wiring", () => {
  it("T3: default cooldownMs (omitted -> 300000) suppresses a 2nd escalate, fires after 5min [ses_p1_cooldown_5min]", async () => {
    const dir = mkdtempSync(join(tmpdir(), "spam-guard-cooldown-"));
    const { writeFileSync } = await import("node:fs");
    writeFileSync(join(dir, "PLAN.md"), "# test");
    const calls: Array<{ sessionID: string; promptText: string }> = [];
    const realNow = Date.now;
    let now = realNow();
    Date.now = () => now;
    try {
      clearAll();
      const sid = "ses_p1_cooldown_5min";
      const plugin = await createMetaGovernorPlugin(
        { graphSync: { enabled: false }, cliAnything: { enabled: false } },
        createHermeticExtra({
          __test_isMainSession: () => true,
          __test_autoRemember: (payload: { sessionID: string; promptText: string }) => {
            calls.push(payload);
          },
        }),
      )(mockPluginInput(dir), {
        meta_governor: {
          enabled: true,
          skillPriming: { enabled: false },
          intervention: { mode: "message", minActionForMessage: "warn" },
          // Hermetic pin: auditToolCalls true inline so tool.execute.before
          // accumulates deviations in CI (dev config file absent -> default false).
          // Same pattern as plugin.test.ts / memory-nudge.test.ts.
          protocolEnforcement: { enabled: true, injectIntoSystem: false, auditToolCalls: true },
          // cooldownMs deliberately OMITTED: the projected default (300000
          // = 5min) must apply. dedupe:false isolates the cooldown gate
          // from the content-dedupe gate.
          closedLoop: { autoRemember: { enabled: true, dedupe: false } },
        },
      } as PluginOptions);
      const transform = plugin["experimental.chat.messages.transform"] as unknown as (
        i: unknown,
        o: unknown,
      ) => Promise<void>;
      // Seed a REAL rule deviation (grave double-suppression) so the SKIP guard
      // does not swallow the escalates — same pattern as auto-remember 4/8 and QA4-QA6.
      const beforeT3 = (plugin as unknown as Record<string, unknown>)["tool.execute.before"] as unknown as (i: unknown, o: unknown) => Promise<void>;
      await beforeT3({ tool: "write", sessionID: sid, callID: "call-seed" }, { args: { filePath: "/tmp/seed.ts", content: "// @ts-ignore\nconst x = 1 as any;" } });

      storeDecision(sid, makePluginDecision("escalate", sid, "[MetaGovernor] first escalate alpha"));
      await transform({}, midSessionOutput(sid));
      expect(calls.length).toBe(1);

      // Second DISTINCT escalate inside the 5-minute window -> suppressed.
      storeDecision(sid, makePluginDecision("escalate", sid, "[MetaGovernor] second escalate beta distinct"));
      await transform({}, midSessionOutput(sid));
      expect(calls.length).toBe(1);

      // Past the 5-minute window -> fires again.
      now += 300_001;
      storeDecision(sid, makePluginDecision("escalate", sid, "[MetaGovernor] third escalate gamma distinct"));
      await transform({}, midSessionOutput(sid));
      expect(calls.length).toBe(2);
      expect(calls[0]!.promptText).toContain("omo_remember");
    } finally {
      Date.now = realNow;
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // best-effort
      }
    }
  });
});
