/**
 * Lesson quality gate — automatic writers must save lessons WORTH keeping.
 *
 * WHAT WENT WRONG (user report): agentmemory filled with rows like
 *   Action "stop" (score -0.37) after deviations: [grave] memory-first: Asked
 *   a question without first querying memory. Must fire omo_recall or
 *   omo_recall_mcp before asking the user. (×3 repeats this session).
 *   Mistake: memory-first: Asked a question without first querying memory...
 *   WhatToDo: Query memory (`omo_recall`, then `omo_recall_mcp`) before asking
 *   the user — the answer may already be known
 *   WhereToGo: session:ses_e97c83712ffeENWCygpX6kKBoo
 *
 * Nothing in that row was learned: the rule text (protocol-enforcer detail),
 * the remedy (RULE_GUIDANCE) and the score (the decision) were ALL already in
 * the session context, and the "place" was a session id that no longer exists.
 * Dedupe could not help — every session produced a fresh, unique-but-useless
 * row. The fix is a worthiness gate at the write boundary.
 *
 * Contract (v0.65.x):
 * - L1: the reported row (unanchored + static remedy + session scope) is NOT
 *       worth saving.
 * - L2: the same rule IS worth saving once anchored to a real file.
 * - L3: a diagnostic code (TOOL_TIMEOUT) is an anchor — recovery lessons stay.
 * - L4: content is a real lesson (Mistake / What to do / Where), never the
 *       score dump, and it round-trips through parseLessonContent.
 * - L5: end-to-end — a memory-first-only violation writes ZERO lessons, while
 *       a violating write still writes exactly one.
 */
import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PluginInput, PluginOptions } from "@opencode-ai/plugin";
import { createMetaGovernorPlugin } from "./plugin";
import { clearAll, storeDecision } from "./decision-store";
import type { DecisionHandlerOutput, Deviation } from "./types";
import {
  buildConscienceMemoryContent,
  GENERIC_WHAT_TO_DO,
  hasConcretePlace,
  hasDiagnosticAnchor,
  isLessonWorthSaving,
  synthesizeWhatToDo,
} from "./closed-loop-learning";
import { parseLessonContent } from "./agentmemory-bridge";

// ---------------------------------------------------------------------------
// L1 — the reported row is not a lesson
// ---------------------------------------------------------------------------

const REPORTED_DETAIL =
  "Asked a question without first querying memory. Must fire omo_recall or omo_recall_mcp before asking the user.";

describe("lesson quality gate (v0.65.x)", () => {
  it("L1: the reported memory-first row is NOT worth saving [ses_q_lesson_quality_l1]", () => {
    const deviations: Deviation[] = [
      { severity: "grave", category: "memory-first", detail: REPORTED_DETAIL },
    ];
    const result = isLessonWorthSaving({
      mistake: `memory-first: ${REPORTED_DETAIL}`,
      whatToDo: synthesizeWhatToDo(deviations, null),
      whereToGo: "session:ses_e97c83712ffeENWCygpX6kKBoo",
      deviations,
      files: [],
    });

    expect(result.ok).toBe(false);
    expect(result.reason).toContain("static rule directive");
    // The exact ingredients that made it junk:
    expect(hasConcretePlace("session:ses_e97c83712ffeENWCygpX6kKBoo", [])).toBe(false);
    expect(hasConcretePlace("omo-meta-governor", [])).toBe(false);
    expect(hasDiagnosticAnchor(REPORTED_DETAIL)).toBe(false);
  });

  it("L2: the same rule IS worth saving once anchored to a real file", () => {
    const deviations: Deviation[] = [
      { severity: "grave", category: "memory-first", detail: REPORTED_DETAIL },
    ];
    const result = isLessonWorthSaving({
      mistake: `memory-first: ${REPORTED_DETAIL}`,
      whatToDo: synthesizeWhatToDo(deviations, null),
      whereToGo: "recall.ts",
      deviations,
      files: ["src/recall.ts"],
    });
    expect(result.ok).toBe(true);
    expect(hasConcretePlace("src/a.ts, src/b.ts", [])).toBe(true);
    expect(hasConcretePlace("d:\\repo\\a.ts", [])).toBe(true);
  });

  it("L3: a diagnostic code is an anchor — recovery lessons stay saveable", () => {
    const deviations: Deviation[] = [
      { severity: "grave", category: "recovery:retry", detail: "TOOL_TIMEOUT: no context" },
    ];
    const result = isLessonWorthSaving({
      mistake: "recovery:retry: TOOL_TIMEOUT: no context",
      whatToDo: synthesizeWhatToDo(deviations, "oracle"),
      whereToGo: "session:ses_recovery",
      deviations,
      files: [],
    });
    expect(result.ok).toBe(true);
    expect(hasDiagnosticAnchor("JSON_PARSE_ERROR while parsing")).toBe(true);
  });

  it("L4: content is a lesson, not a score dump — and it round-trips", () => {
    const deviations: Deviation[] = [
      { severity: "grave", category: "no-type-suppression", detail: "as any in src/bar.ts" },
    ];
    const typeRemedy = synthesizeWhatToDo(deviations, null);
    const memory = buildConscienceMemoryContent({
      action: "stop",
      mistake: "no-type-suppression: as any in src/bar.ts",
      whatToDo: typeRemedy,
      whereToGo: "bar.ts",
      score: -0.37,
      files: ["src/bar.ts"],
      deviations,
    });

    // The scoring dump that used to BE the title / body of every lesson.
    expect(memory.content.startsWith("Mistake: ")).toBe(true);
    expect(memory.content).not.toContain('Action "');
    expect(memory.content).not.toContain("after deviations:");
    expect(memory.content).toContain("What to do: ");
    expect(memory.content).toContain("Where: bar.ts");
    // The mistake is stated once, not repeated as its own evidence line.
    expect(memory.content.split("as any in src/bar.ts").length - 1).toBe(1);

    // Consumed downstream: labels must match the recall/synthesis parser.
    const parsed = parseLessonContent(memory.content);
    expect(parsed.mistake).toBe("no-type-suppression: as any in src/bar.ts");
    expect(parsed.whatToDo).toBe(typeRemedy);
    expect(parsed.whereToGo).toBe("bar.ts");
  });

  it("L4b: generic remedy + no anchor is rejected; a real anchor keeps it", () => {
    const deviations: Deviation[] = [
      { severity: "media", category: "unknown-rule", detail: "something happened here" },
    ];
    const unanchored = isLessonWorthSaving({
      mistake: "unknown-rule: something happened here",
      whatToDo: GENERIC_WHAT_TO_DO,
      whereToGo: "session:ses_x",
      deviations,
      files: [],
    });
    expect(unanchored.ok).toBe(false);

    const anchored = isLessonWorthSaving({
      mistake: "unknown-rule: something happened here",
      whatToDo: GENERIC_WHAT_TO_DO,
      whereToGo: "plugin.ts",
      deviations,
      files: [],
    });
    expect(anchored.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// L5 — end-to-end through the plugin
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

function makeDecision(sid: string, score: number): DecisionHandlerOutput {
  return {
    action: "escalate",
    message: "[MetaGovernor] lesson quality probe",
    historyEntry: {
      decision: { action: "escalate", score, reasoning: "probe", evidence: [], shouldEscalateTo: null },
      action: "escalate",
      timestampISO: new Date().toISOString(),
      sessionID: sid,
      reasoning: "probe",
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

describe("L5: automatic writers save only anchored lessons", () => {
  it("L5: memory-first-only violation writes 0 lessons; a violating write writes 1 [ses_q_lesson_quality_l5]", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lesson-quality-"));
    writeFileSync(join(dir, "PLAN.md"), "# test");
    const writes: Array<{ content?: string; whereToGo?: string }> = [];
    try {
      clearAll();
      const sid = "ses_q_lesson_quality_l5";
      const plugin = await createMetaGovernorPlugin(
        { graphSync: { enabled: false }, cliAnything: { enabled: false } },
        createHermeticExtra({
          __test_isMainSession: () => true,
          __test_autoRemember: (p: { content?: string; whereToGo?: string }) => {
            writes.push(p);
          },
        }),
      )(mockPluginInput(dir), {
        meta_governor: {
          enabled: true,
          skillPriming: { enabled: false },
          intervention: { mode: "message", minActionForMessage: "warn" },
          protocolEnforcement: { enabled: true, injectIntoSystem: false, auditToolCalls: true },
          closedLoop: { autoRemember: { enabled: true, cooldownMs: 0, dedupe: false } },
        },
      } as PluginOptions);

      const hooks = plugin as unknown as Record<string, unknown>;
      const before = hooks["tool.execute.before"] as unknown as (i: unknown, o: unknown) => Promise<void>;
      const transform = hooks["experimental.chat.messages.transform"] as unknown as (
        i: unknown,
        o: unknown,
      ) => Promise<void>;

      // (1) ONLY a memory-first deviation (asked the user without recall) and
      // no write at all → nothing anchored → no lesson reaches agentmemory.
      await before({ tool: "ask", sessionID: sid, callID: "call-ask" }, { args: {} });
      storeDecision(sid, makeDecision(sid, -0.37));
      await transform({}, midSessionOutput(sid));
      expect(writes.length).toBe(0);

      // (2) A real violating write anchors the lesson to a real file → saved,
      // and the saved body is a lesson, not a scoring dump.
      await before(
        { tool: "write", sessionID: sid, callID: "call-write" },
        { args: { filePath: "/tmp/bad.ts", content: "// @ts-ignore\nconst x: unknown = 1 as never;" } },
      );
      storeDecision(sid, makeDecision(sid, -0.62));
      await transform({}, midSessionOutput(sid));

      expect(writes.length).toBe(1);
      expect(writes[0]!.content ?? "").toContain("Mistake:");
      expect(writes[0]!.content ?? "").not.toContain('Action "');
      expect(writes[0]!.whereToGo ?? "").not.toContain("session:");
    } finally {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // best-effort
      }
    }
  });
});
