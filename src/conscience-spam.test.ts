/**
 * Wave 0 TDD RED — conscience anti-spam contract (`.omo/plans/conscience-fix.md` QA1–QA7).
 *
 * Old-vs-new mapping (D1/D2): the previous `src/auto-remember.test.ts` suite
 * assumed `warn` fires auto-remember and the default was opt-out. The new
 * contract fires ONLY on `escalate|stop`, defaults `closedLoop.autoRemember`
 * to opt-IN (`enabled:false`), routes delivery through structured
 * `omo_remember` content, and dedupes on a score-float-free stable key.
 *
 * These 7 tests MUST be RED on old code and GREEN after the fix.
 * Missing prod APIs (`shouldPersistConscienceMemory`, `conscienceDedupeKey`)
 * are import-guarded so the RED failure names the missing symbol.
 */
import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PluginInput, PluginOptions } from "@opencode-ai/plugin";
import { createMetaGovernorPlugin } from "./plugin";
import { clearAll, storeDecision } from "./decision-store";
import type { DecisionHandlerOutput } from "./types";
import { buildUserStatus, wrapInformational } from "./agent-notifications";
import * as closedLoop from "./closed-loop-learning";

// --- Import-guarded new prod APIs (absent on old code → tests FAIL RED) ---
type ShouldPersistFn = (args: {
  action: string;
  deviations: Array<{ severity: string; category: string; detail: string }>;
  config: { enabled: boolean; saveLessons?: boolean; minSeverityToLearn: string; maxLessonsPerSession: number };
  novelty: boolean;
  lessonCount: number;
}) => boolean;
type DedupeKeyFn = (args: {
  action: string;
  evidenceSources: string[];
  deviationCategories: string[];
}) => string;
const shouldPersistConscienceMemory = (closedLoop as unknown as Record<string, unknown>)
  .shouldPersistConscienceMemory as ShouldPersistFn | undefined;
const conscienceDedupeKey = (closedLoop as unknown as Record<string, unknown>)
  .conscienceDedupeKey as DedupeKeyFn | undefined;

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

function makeDecision(
  action: DecisionHandlerOutput["action"],
  sid: string,
  opts: { score?: number; message?: string; shouldEscalateTo?: "oracle" | "user" | null } = {},
): DecisionHandlerOutput {
  const score = opts.score ?? -0.5;
  return {
    action,
    message: opts.message ?? `[MetaGovernor] Test ${action} message (score ${score.toFixed(2)}) for conscience-spam`,
    historyEntry: {
      decision: {
        action,
        score,
        reasoning: `Test ${action} reasoning (score ${score.toFixed(2)})`,
        evidence: [],
        shouldEscalateTo: opts.shouldEscalateTo ?? null,
      },
      action,
      timestampISO: new Date().toISOString(),
      sessionID: sid,
      reasoning: `Test ${action}`,
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

async function makePlugin(
  dir: string,
  extra: Record<string, unknown>,
  closedLoopOverride?: Record<string, unknown>,
) {
  return createMetaGovernorPlugin(
    { graphSync: { enabled: false }, cliAnything: { enabled: false } },
    createHermeticExtra({ __test_isMainSession: () => true, ...extra }),
  )(mockPluginInput(dir), {
    meta_governor: {
      enabled: true,
      skillPriming: { enabled: false },
      intervention: { mode: "message", minActionForMessage: "warn" },
      ...(closedLoopOverride ? { closedLoop: closedLoopOverride } : {}),
    },
  } as PluginOptions);
}

type TransformFn = (i: unknown, o: unknown) => Promise<void>;
function getTransform(plugin: unknown): TransformFn {
  return (plugin as Record<string, unknown>)["experimental.chat.messages.transform"] as unknown as TransformFn;
}

describe("Wave 0 RED — conscience anti-spam contract (QA1–QA7)", () => {
  it("QA1 spam-storm: 10x score-jittered escalate for ses_q_spam_storm writes <= 1", async () => {
    const dir = mkdtempSync(join(tmpdir(), "conscience-spam-storm-"));
    const writes: unknown[] = [];
    try {
      clearAll();
      const sid = "ses_q_spam_storm";
      const plugin = await makePlugin(dir, {
        __test_autoRemember: (p: unknown) => { writes.push(p); },
      }, { autoRemember: { enabled: true, cooldownMs: 0, dedupe: true } });
      const transform = getTransform(plugin);
      for (let i = 0; i < 10; i++) {
        const score = -0.5 - i * 0.01;
        storeDecision(sid, makeDecision("escalate", sid, { score }));
        await transform({}, midSessionOutput(sid));
      }
      // RED on old code: content-hash dedupe leaks on score jitter (receives 10).
      // GREEN after fix: stable conscienceDedupeKey ignores score floats (receives 1).
      expect(writes.length).toBeLessThanOrEqual(1);
    } finally {
      try { rmSync(dir, { recursive: true, force: true }); } catch {}
    }
  });

  it("QA2 warn-never: warn for ses_q_warn_never fires 0 auto-remember calls", async () => {
    const dir = mkdtempSync(join(tmpdir(), "conscience-warn-never-"));
    const writes: unknown[] = [];
    try {
      clearAll();
      const sid = "ses_q_warn_never";
      const plugin = await makePlugin(dir, {
        __test_autoRemember: (p: unknown) => { writes.push(p); },
      }, { autoRemember: { enabled: true, cooldownMs: 0, dedupe: true } });
      storeDecision(sid, makeDecision("warn", sid));
      await getTransform(plugin)({}, midSessionOutput(sid));
      // RED on old code: warn is in the notable set (receives 1). D1 removes warn.
      expect(writes.length).toBe(0);
    } finally {
      try { rmSync(dir, { recursive: true, force: true }); } catch {}
    }
  });

  it("QA3 disabled-never: enabled:false + escalate for ses_q_disabled_never fires 0 writes", async () => {
    // Import guard FIRST so RED names the missing gate on old code.
    expect(typeof shouldPersistConscienceMemory).toBe("function");
    const dir = mkdtempSync(join(tmpdir(), "conscience-disabled-"));
    const writes: unknown[] = [];
    try {
      clearAll();
      const sid = "ses_q_disabled_never";
      const plugin = await makePlugin(dir, {
        __test_autoRemember: (p: unknown) => { writes.push(p); },
      }, { autoRemember: { enabled: false } });
      storeDecision(sid, makeDecision("escalate", sid, { shouldEscalateTo: "oracle" }));
      await getTransform(plugin)({}, midSessionOutput(sid));
      expect(writes.length).toBe(0);
    } finally {
      try { rmSync(dir, { recursive: true, force: true }); } catch {}
    }
  });

  it("QA4 marker-present: agent text has DO NOT TREAT AS TASK, TUI status short without marker", async () => {
    const dir = mkdtempSync(join(tmpdir(), "conscience-marker-"));
    const writes: Array<{ promptText: string }> = [];
    try {
      clearAll();
      const sid = "ses_q_marker";
      const plugin = await makePlugin(dir, {
        __test_autoRemember: (p: { promptText: string }) => { writes.push(p); },
      }, { autoRemember: { enabled: true, cooldownMs: 0, dedupe: true } });
      storeDecision(sid, makeDecision("escalate", sid, { shouldEscalateTo: "oracle" }));
      await getTransform(plugin)({}, midSessionOutput(sid));
      expect(writes.length).toBeGreaterThan(0);
      const agentText = writes[0]!.promptText;
      // RED on old code: raw prompt has no marker (D7 requires wrapInformational).
      expect(agentText).toContain("DO NOT TREAT AS TASK");
      // Contract pins (pass on old + new): wrapper carries the marker...
      expect(wrapInformational("probe", { kind: "intervention" })).toContain("DO NOT TREAT AS TASK");
      // ...while the TUI surface stays short and marker-free.
      const tui = buildUserStatus("intervention", "escalate — conscience digest ready");
      expect(tui.length).toBeLessThan(200);
      expect(tui).not.toContain("DO NOT TREAT AS TASK");
    } finally {
      try { rmSync(dir, { recursive: true, force: true }); } catch {}
    }
  });

  it("QA5 structured-content: remember prompt has mistake/whatToDo/whereToGo/toolRoute/omo_remember, no dump", async () => {
    const dir = mkdtempSync(join(tmpdir(), "conscience-structured-"));
    const writes: Array<{ promptText: string }> = [];
    try {
      clearAll();
      const sid = "ses_q_structured";
      const plugin = await makePlugin(dir, {
        __test_autoRemember: (p: { promptText: string }) => { writes.push(p); },
      }, { autoRemember: { enabled: true, cooldownMs: 0, dedupe: true } });
      storeDecision(sid, makeDecision("escalate", sid, { shouldEscalateTo: "oracle" }));
      await getTransform(plugin)({}, midSessionOutput(sid));
      expect(writes.length).toBeGreaterThan(0);
      const txt = writes[0]!.promptText;
      // RED on old code: raw `MetaGovernor escalate:` dump + agentmemory_memory_save instruction.
      expect(txt).toContain("mistake");
      expect(txt).toContain("whatToDo");
      expect(txt).toContain("whereToGo");
      expect(txt).toContain("toolRoute");
      expect(txt).toContain("omo_remember");
      expect(txt).not.toContain("agentmemory_memory_save");
      expect(txt).not.toContain("MetaGovernor escalate:");
    } finally {
      try { rmSync(dir, { recursive: true, force: true }); } catch {}
    }
  });

  it("QA6 score-jitter dedupe: same action+sources+categories at -0.51 vs -0.53 share one key, 1 write", async () => {
    // Import guard FIRST so RED names the missing stable key on old code.
    expect(typeof conscienceDedupeKey).toBe("function");
    const k1 = conscienceDedupeKey!({
      action: "escalate",
      evidenceSources: ["deviation-detector"],
      deviationCategories: ["no-progress"],
    });
    const k2 = conscienceDedupeKey!({
      action: "escalate",
      evidenceSources: ["deviation-detector"],
      deviationCategories: ["no-progress"],
    });
    // Same stable fields (scores -0.51 vs -0.53 excluded per D5) → same key.
    expect(k1).toBe(k2);

    const dir = mkdtempSync(join(tmpdir(), "conscience-jitter-"));
    const writes: unknown[] = [];
    try {
      clearAll();
      const sid = "ses_q_jitter";
      const plugin = await makePlugin(dir, {
        __test_autoRemember: (p: unknown) => { writes.push(p); },
      }, { autoRemember: { enabled: true, cooldownMs: 0, dedupe: true } });
      storeDecision(sid, makeDecision("escalate", sid, { score: -0.51, shouldEscalateTo: "oracle" }));
      await getTransform(plugin)({}, midSessionOutput(sid));
      storeDecision(sid, makeDecision("escalate", sid, { score: -0.53, shouldEscalateTo: "oracle" }));
      await getTransform(plugin)({}, midSessionOutput(sid));
      // RED on old code: float jitter defeats the content hash (receives 2).
      expect(writes.length).toBe(1);
    } finally {
      try { rmSync(dir, { recursive: true, force: true }); } catch {}
    }
  });

  it("QA7 reflection throttle: null target reflects never; 2 escalates 30s apart reflect once", async () => {
    const dir = mkdtempSync(join(tmpdir(), "conscience-reflect-"));
    const reflections: Array<{ text: string }> = [];
    const realNow = Date.now;
    let now = realNow();
    Date.now = () => now;
    try {
      clearAll();
      // Part A (RED on old code): no escalation target → no reflection (D8).
      const nullSid = "ses_q_reflect_null";
      const pluginNull = await makePlugin(dir, {
        __test_reflectionPrompt: (p: { text: string }) => { reflections.push(p); },
      });
      storeDecision(nullSid, makeDecision("escalate", nullSid, { shouldEscalateTo: null }));
      await getTransform(pluginNull)({}, midSessionOutput(nullSid));
      expect(reflections.length).toBe(0);

      // Part B: two escalates with target 30s apart → exactly 1 reflection section.
      const sid = "ses_q_reflect";
      const plugin = await makePlugin(dir, {
        __test_reflectionPrompt: (p: { text: string }) => { reflections.push(p); },
      });
      storeDecision(sid, makeDecision("escalate", sid, { shouldEscalateTo: "oracle" }));
      await getTransform(plugin)({}, midSessionOutput(sid));
      now += 30_000;
      storeDecision(sid, makeDecision("escalate", sid, { shouldEscalateTo: "oracle" }));
      await getTransform(plugin)({}, midSessionOutput(sid));
      expect(reflections.length).toBe(1);
      // TUI stays short even when reflection fires.
      const tui = buildUserStatus("intervention", "escalate — reflection queued");
      expect(tui.length).toBeLessThan(200);
    } finally {
      Date.now = realNow;
      try { rmSync(dir, { recursive: true, force: true }); } catch {}
    }
  });
});
