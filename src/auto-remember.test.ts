/**
 * FASE 4 — Auto-trigger omo_remember on notable decisions (v0.43.0)
 *
 * Verifies that when a non-trivial decision (warn|escalate|stop) fires for
 * the main agent, the plugin queues an agentmemory_memory_save directive.
 * continue → no remember, subagent → no remember.
 *
 * TDD: these tests MUST be RED before the fix and GREEN after.
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

describe("FASE 4 auto-remember — omo_remember on warn/escalate/stop for main agent", () => {
  it("1/3 warn decision for MAIN agent queues auto-remember (agentmemory_memory_save)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "auto-remember-warn-"));
    writeFileSync(join(dir, "PLAN.md"), "# test");
    let autoRememberCalls: Array<{ sessionID: string; decision: DecisionHandlerOutput; promptText: string }> = [];
    try {
      clearAll();
      const sid = "auto-remember-warn-main";
      storeDecision(sid, makeDecision("warn", sid));
      const plugin = await createMetaGovernorPlugin(
        { graphSync: { enabled: false }, cliAnything: { enabled: false } },
        createHermeticExtra({
          __test_isMainSession: () => true,
          __test_autoRemember: (payload: { sessionID: string; decision: DecisionHandlerOutput; promptText: string }) => {
            autoRememberCalls.push(payload);
          },
        }),
      )(mockPluginInput(dir), {
        meta_governor: { enabled: true, skillPriming: { enabled: false }, intervention: { mode: "message", minActionForMessage: "warn" } },
      } as PluginOptions);
      const transform = plugin["experimental.chat.messages.transform"] as unknown as (i: unknown, o: unknown) => Promise<void>;
      const output = midSessionOutput(sid);
      await transform({}, output);
      // allow synchronous DI path to have fired (no need for setTimeout wait — test seam is sync)
      expect(autoRememberCalls.length).toBe(1);
      expect(autoRememberCalls[0]!.sessionID).toBe(sid);
      expect(autoRememberCalls[0]!.decision.action).toBe("warn");
      const txt = autoRememberCalls[0]!.promptText;
      expect(txt).toContain("agentmemory_memory_save");
      expect(txt).toContain("warn");
    } finally {
      try { rmSync(dir, { recursive: true, force: true }); } catch {}
    }
  });

  it("2/3 continue decision does NOT queue auto-remember", async () => {
    const dir = mkdtempSync(join(tmpdir(), "auto-remember-continue-"));
    writeFileSync(join(dir, "PLAN.md"), "# test");
    let autoRememberCalls: unknown[] = [];
    try {
      clearAll();
      const sid = "auto-remember-continue";
      storeDecision(sid, makeDecision("continue", sid));
      const plugin = await createMetaGovernorPlugin(
        { graphSync: { enabled: false }, cliAnything: { enabled: false } },
        createHermeticExtra({
          __test_isMainSession: () => true,
          __test_autoRemember: (payload: unknown) => { autoRememberCalls.push(payload); },
        }),
      )(mockPluginInput(dir), {
        meta_governor: { enabled: true, skillPriming: { enabled: false }, intervention: { mode: "message", minActionForMessage: "warn" } },
      } as PluginOptions);
      const transform = plugin["experimental.chat.messages.transform"] as unknown as (i: unknown, o: unknown) => Promise<void>;
      const output = midSessionOutput(sid);
      await transform({}, output);
      expect(autoRememberCalls.length).toBe(0);
    } finally {
      try { rmSync(dir, { recursive: true, force: true }); } catch {}
    }
  });

  it("3/3 warn decision for SUBAGENT does NOT queue auto-remember (avoid bloat)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "auto-remember-sub-"));
    writeFileSync(join(dir, "PLAN.md"), "# test");
    let autoRememberCalls: unknown[] = [];
    try {
      clearAll();
      const sid = "auto-remember-warn-sub";
      storeDecision(sid, makeDecision("warn", sid));
      const plugin = await createMetaGovernorPlugin(
        { graphSync: { enabled: false }, cliAnything: { enabled: false } },
        createHermeticExtra({
          __test_isMainSession: () => false,
          __test_autoRemember: (payload: unknown) => { autoRememberCalls.push(payload); },
        }),
      )(mockPluginInput(dir), {
        meta_governor: { enabled: true, skillPriming: { enabled: false }, intervention: { mode: "message", minActionForMessage: "warn" } },
      } as PluginOptions);
      const transform = plugin["experimental.chat.messages.transform"] as unknown as (i: unknown, o: unknown) => Promise<void>;
      const output = midSessionOutput(sid);
      await transform({}, output);
      expect(autoRememberCalls.length).toBe(0);
    } finally {
      try { rmSync(dir, { recursive: true, force: true }); } catch {}
    }
  });
});
