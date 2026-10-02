/**
 * Conscience auto-remember — omo_remember on escalate|stop for main agent only (v0.50.x).
 *
 * NEW CONTRACT (Wave 0 RED, per .omo/plans/conscience-fix.md):
 * - Trigger = `escalate|stop` ONLY. `warn` NEVER fires (D1 — warn is high-volume
 *   noise; conscience fires only on notable decisions). `continue` never fires.
 * - Main session only: subagent decisions never fire (avoid memory bloat).
 * - Delivery instructs `omo_remember` (D6), NEVER raw `agentmemory_memory_save`
 *   verbatim instruction. Prompt carries structured lesson fields (D4):
 *   { mistake, whatToDo, whereToGo, toolRoute, score, files }.
 * - Guards: dedupe identical escalate twice -> 1 write; cooldown (600s) second
 *   distinct escalate inside window -> 1 write; enabled:false -> 0 writes (D2 opt-in).
 *
 * OLD-vs-NEW mapping (old expectations deleted by design, NOT regressions):
 * | # | OLD (v0.43.0/v0.49.1)                          | NEW (conscience)                              |
 * |---|------------------------------------------------|-----------------------------------------------|
 * | 1 | warn MAIN -> 1 call (agentmemory_memory_save)  | warn MAIN -> 0 calls (D1 warn removal)        |
 * | 2 | continue -> 0                                  | continue -> 0 (unchanged)                     |
 * | 3 | warn SUBAGENT -> 0                             | escalate SUBAGENT -> 0 (same rule, new action)|
 * | 4 | identical warn x2 -> 1 (dedupe)                | identical escalate x2 -> 1 (stable key, D5)   |
 * | 5 | distinct warn x2 in cooldown -> 1              | distinct escalate x2 in 600s -> 1 (cooldown)  |
 * | 6 | warn + enabled:false -> 0                      | escalate + enabled:false -> 0 (same kill-switch)|
 * | 7 | (did not exist)                                | escalate MAIN -> 1 structured omo_remember    |
 * | 8 | (did not exist)                                | stop MAIN -> 1 structured omo_remember        |
 *
 * TDD: these tests MUST be RED before the fix (old prod code: warn still fires,
 * structured fields missing, agentmemory_memory_save verbatim present) and GREEN after.
 */
import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PluginInput, PluginOptions } from "@opencode-ai/plugin";
import { createMetaGovernorPlugin } from "./plugin";
import { clearAll, storeDecision } from "./decision-store";
import type { DecisionHandlerOutput } from "./types";

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

function makeDecision(action: DecisionHandlerOutput["action"], sid: string): DecisionHandlerOutput {
  return {
    action,
    message: `[MetaGovernor] Test ${action} message for auto-remember`,
    historyEntry: {
      decision: { action, score: -0.5, reasoning: `Test ${action}`, evidence: [], shouldEscalateTo: null },
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

type RememberCall = { sessionID: string; decision: DecisionHandlerOutput; promptText: string };

function baseOptionsWithIntervention(extra?: Record<string, unknown>): PluginOptions {
  return {
    meta_governor: {
      enabled: true,
      skillPriming: { enabled: false },
      intervention: { mode: "message", minActionForMessage: "warn" },
      // Hermetic pin: auditToolCalls must be true inline so tool.execute.before
      // accumulates deviations in CI (where the dev config file is absent and
      // the default is false). Same pattern as plugin.test.ts / memory-nudge.test.ts.
      protocolEnforcement: { enabled: true, injectIntoSystem: false, auditToolCalls: true },
      closedLoop: { autoRemember: { enabled: true } },
      ...extra,
    },
  } as PluginOptions;
}

describe("conscience auto-remember — escalate|stop fire for main agent only (structured omo_remember)", () => {
  it("1/8 warn for MAIN agent NEVER fires (D1 removal by design) [ses_q_warn_never]", async () => {
    const dir = mkdtempSync(join(tmpdir(), "auto-remember-warn-never-"));
    writeFileSync(join(dir, "PLAN.md"), "# test");
    const autoRememberCalls: RememberCall[] = [];
    try {
      clearAll();
      const sid = "ses_q_warn_never";
      storeDecision(sid, makeDecision("warn", sid));
      const plugin = await createMetaGovernorPlugin(
        { graphSync: { enabled: false }, cliAnything: { enabled: false } },
        createHermeticExtra({
          __test_isMainSession: () => true,
          __test_autoRemember: (payload: RememberCall) => {
            autoRememberCalls.push(payload);
          },
        }),
      )(mockPluginInput(dir), baseOptionsWithIntervention());
      const transform = plugin["experimental.chat.messages.transform"] as unknown as (i: unknown, o: unknown) => Promise<void>;
      await transform({}, midSessionOutput(sid));
      // D1: warn NEVER queues auto-remember even when explicitly enabled.
      expect(autoRememberCalls.length).toBe(0);
    } finally {
      try { rmSync(dir, { recursive: true, force: true }); } catch {}
    }
  });

  it("2/8 continue decision does NOT queue auto-remember", async () => {
    const dir = mkdtempSync(join(tmpdir(), "auto-remember-continue-"));
    writeFileSync(join(dir, "PLAN.md"), "# test");
    const autoRememberCalls: unknown[] = [];
    try {
      clearAll();
      const sid = "ses_q_continue_never";
      storeDecision(sid, makeDecision("continue", sid));
      const plugin = await createMetaGovernorPlugin(
        { graphSync: { enabled: false }, cliAnything: { enabled: false } },
        createHermeticExtra({
          __test_isMainSession: () => true,
          __test_autoRemember: (payload: unknown) => { autoRememberCalls.push(payload); },
        }),
      )(mockPluginInput(dir), baseOptionsWithIntervention());
      const transform = plugin["experimental.chat.messages.transform"] as unknown as (i: unknown, o: unknown) => Promise<void>;
      await transform({}, midSessionOutput(sid));
      expect(autoRememberCalls.length).toBe(0);
    } finally {
      try { rmSync(dir, { recursive: true, force: true }); } catch {}
    }
  });

  it("3/8 escalate for SUBAGENT does NOT queue auto-remember (avoid bloat)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "auto-remember-sub-"));
    writeFileSync(join(dir, "PLAN.md"), "# test");
    const autoRememberCalls: unknown[] = [];
    try {
      clearAll();
      const sid = "ses_q_subagent_never";
      storeDecision(sid, makeDecision("escalate", sid));
      const plugin = await createMetaGovernorPlugin(
        { graphSync: { enabled: false }, cliAnything: { enabled: false } },
        createHermeticExtra({
          __test_isMainSession: () => false,
          __test_autoRemember: (payload: unknown) => { autoRememberCalls.push(payload); },
        }),
      )(mockPluginInput(dir), baseOptionsWithIntervention());
      const transform = plugin["experimental.chat.messages.transform"] as unknown as (i: unknown, o: unknown) => Promise<void>;
      await transform({}, midSessionOutput(sid));
      expect(autoRememberCalls.length).toBe(0);
    } finally {
      try { rmSync(dir, { recursive: true, force: true }); } catch {}
    }
  });

  it("4/8 identical escalate twice in a row fires only ONCE (dedupe guard)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "auto-remember-dedupe-"));
    writeFileSync(join(dir, "PLAN.md"), "# test");
    const autoRememberCalls: unknown[] = [];
    try {
      clearAll();
      const sid = "ses_q_dedupe_escalate";
      const plugin = await createMetaGovernorPlugin(
        { graphSync: { enabled: false }, cliAnything: { enabled: false } },
        createHermeticExtra({
          __test_isMainSession: () => true,
          __test_autoRemember: (payload: unknown) => { autoRememberCalls.push(payload); },
        }),
      )(mockPluginInput(dir), baseOptionsWithIntervention());
      const transform = plugin["experimental.chat.messages.transform"] as unknown as (i: unknown, o: unknown) => Promise<void>;
      // v0.53.1: seed a REAL rule deviation — bare escalate without a violated
      // rule is 'the session is long', not a learnable lesson (SKIP).
      const before = (plugin as unknown as Record<string, unknown>)["tool.execute.before"] as unknown as (i: unknown, o: unknown) => Promise<void>;
      await before({ tool: "write", sessionID: sid, callID: "call-seed" }, { args: { filePath: "/tmp/seed.ts", content: "// @ts-ignore\nconst x = 1 as any;" } });
      storeDecision(sid, makeDecision("escalate", sid));
      await transform({}, midSessionOutput(sid));
      storeDecision(sid, makeDecision("escalate", sid));
      await transform({}, midSessionOutput(sid));
      expect(autoRememberCalls.length).toBe(1);
    } finally {
      try { rmSync(dir, { recursive: true, force: true }); } catch {}
    }
  });

  it("5/8 second DISTINCT escalate inside 600s cooldown is suppressed", async () => {
    const dir = mkdtempSync(join(tmpdir(), "auto-remember-cooldown-"));
    writeFileSync(join(dir, "PLAN.md"), "# test");
    const autoRememberCalls: unknown[] = [];
    try {
      clearAll();
      const sid = "ses_q_cooldown_escalate";
      const plugin = await createMetaGovernorPlugin(
        { graphSync: { enabled: false }, cliAnything: { enabled: false } },
        createHermeticExtra({
          __test_isMainSession: () => true,
          __test_autoRemember: (payload: unknown) => { autoRememberCalls.push(payload); },
        }),
      )(mockPluginInput(dir), {
        meta_governor: {
          enabled: true,
          skillPriming: { enabled: false },
          intervention: { mode: "message", minActionForMessage: "warn" },
          // Hermetic pin (see baseOptionsWithIntervention): auditToolCalls true so the seeded deviation is recorded in CI.
          protocolEnforcement: { enabled: true, injectIntoSystem: false, auditToolCalls: true },
          closedLoop: { autoRemember: { enabled: true, cooldownMs: 600_000, dedupe: false } },
        },
      } as PluginOptions);
      const transform = plugin["experimental.chat.messages.transform"] as unknown as (i: unknown, o: unknown) => Promise<void>;
      // v0.53.1: seed a REAL rule deviation (SKIP otherwise).
      const before5 = (plugin as unknown as Record<string, unknown>)["tool.execute.before"] as unknown as (i: unknown, o: unknown) => Promise<void>;
      await before5({ tool: "write", sessionID: sid, callID: "call-seed" }, { args: { filePath: "/tmp/seed.ts", content: "// @ts-ignore\nconst x = 1 as any;" } });
      storeDecision(sid, makeDecision("escalate", sid));
      await transform({}, midSessionOutput(sid));
      const second = makeDecision("escalate", sid);
      (second as unknown as { message: string }).message = "[MetaGovernor] Test escalate message DIFFERENT for cooldown";
      storeDecision(sid, second);
      await transform({}, midSessionOutput(sid));
      expect(autoRememberCalls.length).toBe(1);
    } finally {
      try { rmSync(dir, { recursive: true, force: true }); } catch {}
    }
  });

  it("6/8 autoRemember.enabled=false never fires even on escalate (kill-switch)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "auto-remember-off-"));
    writeFileSync(join(dir, "PLAN.md"), "# test");
    const autoRememberCalls: unknown[] = [];
    try {
      clearAll();
      const sid = "ses_q_disabled_never";
      storeDecision(sid, makeDecision("escalate", sid));
      const plugin = await createMetaGovernorPlugin(
        { graphSync: { enabled: false }, cliAnything: { enabled: false } },
        createHermeticExtra({
          __test_isMainSession: () => true,
          __test_autoRemember: (payload: unknown) => { autoRememberCalls.push(payload); },
        }),
      )(mockPluginInput(dir), {
        meta_governor: {
          enabled: true,
          skillPriming: { enabled: false },
          intervention: { mode: "message", minActionForMessage: "warn" },
          // Hermetic pin (see baseOptionsWithIntervention): keep audit path identical in CI and dev.
          protocolEnforcement: { enabled: true, injectIntoSystem: false, auditToolCalls: true },
          closedLoop: { autoRemember: { enabled: false } },
        },
      } as PluginOptions);
      const transform = plugin["experimental.chat.messages.transform"] as unknown as (i: unknown, o: unknown) => Promise<void>;
      await transform({}, midSessionOutput(sid));
      expect(autoRememberCalls.length).toBe(0);
    } finally {
      try { rmSync(dir, { recursive: true, force: true }); } catch {}
    }
  });

  it("7/8 escalate for MAIN agent queues STRUCTURED omo_remember (D4+D6) [ses_q_escalate_main]", async () => {
    const dir = mkdtempSync(join(tmpdir(), "auto-remember-escalate-main-"));
    writeFileSync(join(dir, "PLAN.md"), "# test");
    const autoRememberCalls: RememberCall[] = [];
    try {
      clearAll();
      const sid = "ses_q_escalate_main";
      storeDecision(sid, makeDecision("escalate", sid));
      const plugin = await createMetaGovernorPlugin(
        { graphSync: { enabled: false }, cliAnything: { enabled: false } },
        createHermeticExtra({
          __test_isMainSession: () => true,
          __test_autoRemember: (payload: RememberCall) => {
            autoRememberCalls.push(payload);
          },
        }),
      )(mockPluginInput(dir), baseOptionsWithIntervention());
      const transform = plugin["experimental.chat.messages.transform"] as unknown as (i: unknown, o: unknown) => Promise<void>;
      // v0.53.1: seed a REAL rule deviation (SKIP otherwise).
      const before7 = (plugin as unknown as Record<string, unknown>)["tool.execute.before"] as unknown as (i: unknown, o: unknown) => Promise<void>;
      await before7({ tool: "write", sessionID: sid, callID: "call-seed" }, { args: { filePath: "/tmp/seed.ts", content: "// @ts-ignore\nconst x = 1 as any;" } });
      await transform({}, midSessionOutput(sid));
      expect(autoRememberCalls.length).toBe(1);
      expect(autoRememberCalls[0]!.sessionID).toBe(sid);
      expect(autoRememberCalls[0]!.decision.action).toBe("escalate");
      const txt = autoRememberCalls[0]!.promptText;
      // D6: route via omo_remember, never raw agentmemory_memory_save verbatim.
      expect(txt).toContain("omo_remember");
      expect(txt).not.toContain("agentmemory_memory_save");
      // D4: structured lesson fields required.
      expect(txt).toContain("mistake");
      expect(txt).toContain("whatToDo");
      expect(txt).toContain("whereToGo");
      expect(txt).toContain("toolRoute");
    } finally {
      try { rmSync(dir, { recursive: true, force: true }); } catch {}
    }
  });

  it("8/8 stop for MAIN agent queues STRUCTURED omo_remember (D4+D6) [ses_q_stop_main]", async () => {
    const dir = mkdtempSync(join(tmpdir(), "auto-remember-stop-main-"));
    writeFileSync(join(dir, "PLAN.md"), "# test");
    const autoRememberCalls: RememberCall[] = [];
    try {
      clearAll();
      const sid = "ses_q_stop_main";
      storeDecision(sid, makeDecision("stop", sid));
      const plugin = await createMetaGovernorPlugin(
        { graphSync: { enabled: false }, cliAnything: { enabled: false } },
        createHermeticExtra({
          __test_isMainSession: () => true,
          __test_autoRemember: (payload: RememberCall) => {
            autoRememberCalls.push(payload);
          },
        }),
      )(mockPluginInput(dir), baseOptionsWithIntervention());
      const transform = plugin["experimental.chat.messages.transform"] as unknown as (i: unknown, o: unknown) => Promise<void>;
      // v0.53.1: seed a REAL rule deviation (SKIP otherwise).
      const before8 = (plugin as unknown as Record<string, unknown>)["tool.execute.before"] as unknown as (i: unknown, o: unknown) => Promise<void>;
      await before8({ tool: "write", sessionID: sid, callID: "call-seed" }, { args: { filePath: "/tmp/seed.ts", content: "// @ts-ignore\nconst x = 1 as any;" } });
      await transform({}, midSessionOutput(sid));
      expect(autoRememberCalls.length).toBe(1);
      expect(autoRememberCalls[0]!.sessionID).toBe(sid);
      expect(autoRememberCalls[0]!.decision.action).toBe("stop");
      const txt = autoRememberCalls[0]!.promptText;
      // D6: route via omo_remember, never raw agentmemory_memory_save verbatim.
      expect(txt).toContain("omo_remember");
      expect(txt).not.toContain("agentmemory_memory_save");
      // D4: structured lesson fields required.
      expect(txt).toContain("mistake");
      expect(txt).toContain("whatToDo");
      expect(txt).toContain("whereToGo");
      expect(txt).toContain("toolRoute");
    } finally {
      try { rmSync(dir, { recursive: true, force: true }); } catch {}
    }
  });
});
