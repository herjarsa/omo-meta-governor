/**
 * FASE 11 — Move FASE 1 directive push sites from messages.transform to
 * system.transform (which actually fires per turn in OpenCode 1.x).
 *
 * The previous FASE 1 implementation pushed via output.messages.push which
 * only fires during compaction in OpenCode 1.x. Moving to system.transform
 * (which fires per LLM call in agent.ts:381) ensures directives actually
 * reach the LLM on every turn.
 */
import { describe, expect, it, beforeEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PluginInput, PluginOptions } from "@opencode-ai/plugin";
import { createMetaGovernorPlugin } from "./plugin";
import { clearAll, storeDecision } from "./decision-store";

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

async function makePlugin(dir: string, options: PluginOptions = {}) {
  return await createMetaGovernorPlugin(
    {
      graphSync: { enabled: false, autoInstall: false },
      cliAnything: { enabled: false },
    },
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
    },
  )(mockPluginInput(dir), options);
}

function makeDecision(action: "warn" | "escalate" | "stop", sid: string) {
  return {
    action,
    message: `[MetaGovernor] ${action} test`,
    historyEntry: {
      decision: { action, score: -0.5, reasoning: "no progress", evidence: [], shouldEscalateTo: null },
      action,
      timestampISO: new Date().toISOString(),
      sessionID: sid,
      reasoning: "no progress",
    },
  };
}

describe("FASE 11 active push now fires via system.transform (per turn)", () => {
  beforeEach(() => clearAll());

  it("1/4 plan-reminder fires via system.transform with main agent + not at session start", async () => {
    const dir = mkdtempSync(join(tmpdir(), "fase11-plan-"));
    writeFileSync(join(dir, "PLAN.md"), "# test");
    try {
      const sid = "fase11-plan-1";
      const plugin = await makePlugin(dir, {
        meta_governor: {
          enabled: true,
          skillPriming: { enabled: false },
          protocolEnforcement: { enabled: true, auditToolCalls: true },
          intervention: { mode: "message", minActionForMessage: "warn" },
        },
      } as PluginOptions);
      // Seed audit state via tool.execute.before with read
      const before = plugin["tool.execute.before"] as unknown as (i: unknown, o: unknown) => Promise<void>;
      await before(
        { tool: "read", sessionID: sid, callID: "c1" },
        { args: {} },
      );
      const systemTransform = plugin["experimental.chat.system.transform"] as unknown as (
        input: unknown,
        output: { system: string[] },
      ) => Promise<void>;
      const output: { system: string[] } = { system: ["PRE-EXISTING"] };
      await systemTransform(
        { sessionID: sid, model: { providerID: "test", modelID: "test" } },
        output,
      );
      const allText = output.system.join("\n");
      expect(allText).toMatch(/plan/i);
      expect(allText).toContain("PRE-EXISTING"); // doesn't clobber
    } finally {
      try { rmSync(dir, { recursive: true, force: true }); } catch {}
    }
  });

  it("2/4 decision intervention (warn) fires via system.transform with visual frame", async () => {
    const dir = mkdtempSync(join(tmpdir(), "fase11-decision-"));
    writeFileSync(join(dir, "PLAN.md"), "# test");
    try {
      const sid = "fase11-decision-1";
      storeDecision(sid, makeDecision("warn", sid));
      const plugin = await makePlugin(dir, {
        meta_governor: {
          enabled: true,
          skillPriming: { enabled: false },
          protocolEnforcement: { enabled: true, auditToolCalls: true },
          intervention: { mode: "message", minActionForMessage: "warn" },
        },
      } as PluginOptions);
      const before = plugin["tool.execute.before"] as unknown as (i: unknown, o: unknown) => Promise<void>;
      await before(
        { tool: "read", sessionID: sid, callID: "c1" },
        { args: {} },
      );
      const systemTransform = plugin["experimental.chat.system.transform"] as unknown as (
        input: unknown,
        output: { system: string[] },
      ) => Promise<void>;
      const output: { system: string[] } = { system: [] };
      await systemTransform(
        { sessionID: sid, model: { providerID: "test", modelID: "test" } },
        output,
      );
      const allText = output.system.join("\n");
      expect(allText).toMatch(/warn/i);
      expect(allText).toContain("[MetaGovernor]");
    } finally {
      try { rmSync(dir, { recursive: true, force: true }); } catch {}
    }
  });

  it("3/4 decision intervention does NOT fire via system.transform when isSessionStart", async () => {
    const dir = mkdtempSync(join(tmpdir(), "fase11-start-"));
    writeFileSync(join(dir, "PLAN.md"), "# test");
    try {
      const sid = "fase11-start-1";
      storeDecision(sid, makeDecision("warn", sid));
      const plugin = await makePlugin(dir, {
        meta_governor: { enabled: true },
      } as PluginOptions);
      const systemTransform = plugin["experimental.chat.system.transform"] as unknown as (
        input: unknown,
        output: { system: string[] },
      ) => Promise<void>;
      // session start = only user message, no assistant message
      const output: { system: string[] } = { system: [] };
      await systemTransform(
        { sessionID: sid, model: { providerID: "test", modelID: "test" } },
        output,
      );
      const allText = output.system.join("\n");
      // Session-start directives (FASE 8/9) DO fire; decision intervention does NOT
      expect(allText).not.toMatch(/\[MetaGovernor\] warn/i);
      expect(allText).toMatch(/session-start protocol/i); // FASE 9 fires
    } finally {
      try { rmSync(dir, { recursive: true, force: true }); } catch {}
    }
  });

  it("4/4 messages.transform no longer pushes FASE 1 directives (now in system.transform)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "fase11-messages-"));
    writeFileSync(join(dir, "PLAN.md"), "# test");
    try {
      const sid = "fase11-messages-1";
      storeDecision(sid, makeDecision("escalate", sid));
      const plugin = await makePlugin(dir, {
        meta_governor: {
          enabled: true,
          skillPriming: { enabled: false },
          protocolEnforcement: { enabled: true, auditToolCalls: true },
          intervention: { mode: "message", minActionForMessage: "warn" },
        },
      } as PluginOptions);
      const before = plugin["tool.execute.before"] as unknown as (i: unknown, o: unknown) => Promise<void>;
      await before({ tool: "read", sessionID: sid, callID: "c1" }, { args: {} });
      // messages.transform should NOT push FASE 1 directives anymore (moved to system.transform)
      const messagesTransform = plugin["experimental.chat.messages.transform"] as unknown as (
        input: unknown,
        output: { messages: unknown[] },
      ) => Promise<void>;
      const output: { messages: unknown[] } = {
        messages: [
          { info: { role: "user", sessionID: sid }, parts: [{ type: "text", text: "first" }] },
          { info: { role: "assistant", sessionID: sid, agent: "build" }, parts: [{ type: "text", text: "reply" }] },
          { info: { role: "user", sessionID: sid }, parts: [{ type: "text", text: "hi" }] },
        ],
      };
      await messagesTransform({}, output);
      // After FASE 11, messages.transform does NOT push FASE 1 intervention
      // Only FASE 8/9 session-start directives, never decision interventions
      for (const msg of output.messages as Array<{ info: { agent?: string } }>) {
        if (msg.info?.agent === "meta-governor" || msg.info?.agent === "omo-meta-governor") {
          // No FASE 1 push should remain
        }
      }
      // The messages should be unchanged (only the original 3 user/assistant/user)
      expect(output.messages.length).toBe(3);
    } finally {
      try { rmSync(dir, { recursive: true, force: true }); } catch {}
    }
  });
});
