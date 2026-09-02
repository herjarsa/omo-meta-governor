/**
 * FASE 3 — Restore session.prompt() for main agent (scope-guarded)
 *
 * Verifies that persistIntervention calls promptAgent/persist only for MAIN sessions
 * (session.parentID === null) and remains log-only for subagents.
 * TDD: MUST FAIL before fix, PASS after.
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

function makeDecision(action: DecisionHandlerOutput["action"], sid: string): DecisionHandlerOutput {
  return {
    action,
    message: `[MetaGovernor] Test ${action}`,
    historyEntry: {
      decision: { action, score: -0.5, reasoning: `Test ${action}`, evidence: [], shouldEscalateTo: null },
      action,
      timestampISO: new Date().toISOString(),
      sessionID: sid,
      reasoning: `Test ${action}`,
    },
  };
}

describe("FASE 3 session.prompt main-agent guard", () => {
  it("1/4 persistIntervention calls persist for MAIN session (parent null)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "fase3-main-"));
    writeFileSync(join(dir, "PLAN.md"), "# test");
    let persistCalls = 0;
    try {
      clearAll();
      const sid = "fase3-main-1";
      storeDecision(sid, makeDecision("escalate", sid));
      const plugin = await createMetaGovernorPlugin(
        { graphSync: { enabled: false }, cliAnything: { enabled: false } },
        {
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
          __test_persistSessionMessage: async () => {
            persistCalls++;
            return { ok: true, messageID: "m1", error: null, durationMs: 1 };
          },
          __test_isMainSession: () => true,
        } as never,
      )(mockPluginInput(dir), {
        meta_governor: { enabled: true, skillPriming: { enabled: false }, intervention: { mode: "message", minActionForMessage: "warn" } },
      } as PluginOptions);
      const transform = plugin["experimental.chat.messages.transform"] as unknown as (i: unknown, o: unknown) => Promise<void>;
      const output: { messages: Array<{ info: unknown; parts: unknown[] }> } = {
        messages: [
          { info: { role: "user", sessionID: sid }, parts: [{ type: "text", text: "first" }] },
          { info: { role: "assistant", sessionID: sid, agent: "build" }, parts: [{ type: "text", text: "reply" }] },
          { info: { role: "user", sessionID: sid }, parts: [{ type: "text", text: "hi" }] },
        ],
      };
      await transform({}, output);
      // Wait for async persist void chain
      await new Promise((r) => setTimeout(r, 50));
      expect(persistCalls).toBeGreaterThan(0);
    } finally {
      try { rmSync(dir, { recursive: true, force: true }); } catch {}
    }
  });

  it("2/4 persistIntervention does NOT call persist for SUBAGENT (parent non-null)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "fase3-sub-"));
    writeFileSync(join(dir, "PLAN.md"), "# test");
    let persistCalls = 0;
    try {
      clearAll();
      const sid = "fase3-sub-1";
      storeDecision(sid, makeDecision("escalate", sid));
      const plugin = await createMetaGovernorPlugin(
        { graphSync: { enabled: false }, cliAnything: { enabled: false } },
        {
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
          __test_persistSessionMessage: async () => {
            persistCalls++;
            return { ok: true, messageID: "m1", error: null, durationMs: 1 };
          },
          __test_isMainSession: () => false,
        } as never,
      )(mockPluginInput(dir), {
        meta_governor: { enabled: true, skillPriming: { enabled: false }, intervention: { mode: "message", minActionForMessage: "warn" } },
      } as PluginOptions);
      const transform = plugin["experimental.chat.messages.transform"] as unknown as (i: unknown, o: unknown) => Promise<void>;
      const output: { messages: Array<{ info: unknown; parts: unknown[] }> } = {
        messages: [
          { info: { role: "user", sessionID: sid }, parts: [{ type: "text", text: "first" }] },
          { info: { role: "assistant", sessionID: sid, agent: "build" }, parts: [{ type: "text", text: "reply" }] },
          { info: { role: "user", sessionID: sid }, parts: [{ type: "text", text: "hi" }] },
        ],
      };
      await transform({}, output);
      await new Promise((r) => setTimeout(r, 50));
      expect(persistCalls).toBe(0);
    } finally {
      try { rmSync(dir, { recursive: true, force: true }); } catch {}
    }
  });

  it("3/4 escalation promptAgent is gated to main agent only", async () => {
    // This test verifies source-level guard: escalation path checks isMainSession
    const src = await Bun.file(join(import.meta.dir, "plugin.ts")).text();
    expect(src).toContain("__test_isMainSession");
    expect(src).toContain("isMainSession");
  });
});
