/**
 * FASE 7 — Reflection trigger via session.prompt().
 *
 * When the auditor detects the agent going off-track (decision is escalate/stop),
 * inject a self-reflection directive via session.prompt() that asks the main LLM
 * to reason about what's going wrong. This is the closest approximation to an
 * independent auditor in OpenCode 1.x (plugins cannot spawn subagents).
 *
 * TDD: tests must FAIL before fix, PASS after.
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

function makeDecision(action: "warn" | "escalate" | "stop", sid: string, reasoning = "no progress") {
  return {
    action,
    message: `[MetaGovernor] ${action} test`,
    historyEntry: {
      decision: { action, score: -0.5, reasoning, evidence: [], shouldEscalateTo: null },
      action,
      timestampISO: new Date().toISOString(),
      sessionID: sid,
      reasoning,
    },
  };
}

async function makePlugin(
  dir: string,
  options: PluginOptions,
  extraDeps: Record<string, unknown> = {},
) {
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
      ...extraDeps,
    },
  )(mockPluginInput(dir), options);
}

describe("FASE 7 reflection trigger via session.prompt", () => {
  beforeEach(() => clearAll());

  it("1/5 triggers reflection on escalate for main agent via __test_reflectionPrompt seam", { timeout: 30000 }, async () => {
    const dir = mkdtempSync(join(tmpdir(), "fase7-reflect-"));
    writeFileSync(join(dir, "PLAN.md"), "# test");
    const reflectionCaptured: string[] = [];
    try {
      const sid = "fase7-reflect-1";
      storeDecision(sid, makeDecision("escalate", sid));
      const plugin = await makePlugin(
        dir,
        {
          meta_governor: {
            enabled: true,
            skillPriming: { enabled: false },
            intervention: { mode: "message", minActionForMessage: "warn" },
          },
        } as PluginOptions,
        {
          __test_isMainSession: () => true,
          __test_reflectionPrompt: (payload) => { reflectionCaptured.push(payload.text); },
        },
      );
      const transform = plugin["experimental.chat.messages.transform"] as unknown as (
        input: unknown,
        output: unknown,
      ) => Promise<void>;
      const output = {
        messages: [
          { info: { role: "user", sessionID: sid }, parts: [{ type: "text", text: "first" }] },
          { info: { role: "assistant", sessionID: sid, agent: "build" }, parts: [{ type: "text", text: "reply" }] },
          { info: { role: "user", sessionID: sid }, parts: [{ type: "text", text: "hi" }] },
        ],
      };
      await transform({}, output);
      expect(reflectionCaptured.length).toBeGreaterThanOrEqual(1);
      const text = reflectionCaptured.join("\n");
      expect(text.toLowerCase()).toContain("reflect");
      expect(text.toLowerCase()).toMatch(/escalate|stuck|wrong|redirect|audit/);
    } finally {
      try { rmSync(dir, { recursive: true, force: true }); } catch {}
    }
  });

  it("2/5 does NOT trigger reflection for subagent sessions (FASE 3 scope guard)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "fase7-subagent-"));
    writeFileSync(join(dir, "PLAN.md"), "# test");
    const reflectionCaptured: string[] = [];
    try {
      const sid = "fase7-subagent-1";
      storeDecision(sid, makeDecision("escalate", sid));
      const plugin = await makePlugin(
        dir,
        {
          meta_governor: {
            enabled: true,
            skillPriming: { enabled: false },
            intervention: { mode: "message", minActionForMessage: "warn" },
          },
        } as PluginOptions,
        {
          __test_isMainSession: () => false,
          __test_reflectionPrompt: (payload) => { reflectionCaptured.push(payload.text); },
        },
      );
      const transform = plugin["experimental.chat.messages.transform"] as unknown as (
        input: unknown,
        output: unknown,
      ) => Promise<void>;
      const output = {
        messages: [
          { info: { role: "user", sessionID: sid }, parts: [{ type: "text", text: "first" }] },
          { info: { role: "assistant", sessionID: sid, agent: "build" }, parts: [{ type: "text", text: "reply" }] },
        ],
      };
      await transform({}, output);
      expect(reflectionCaptured.length).toBe(0);
    } finally {
      try { rmSync(dir, { recursive: true, force: true }); } catch {}
    }
  });

  it("3/5 does NOT trigger reflection for 'continue' decisions", async () => {
    const dir = mkdtempSync(join(tmpdir(), "fase7-continue-"));
    writeFileSync(join(dir, "PLAN.md"), "# test");
    const reflectionCaptured: string[] = [];
    try {
      const sid = "fase7-continue-1";
      storeDecision(sid, makeDecision("continue", sid));
      const plugin = await makePlugin(
        dir,
        {
          meta_governor: {
            enabled: true,
            skillPriming: { enabled: false },
            intervention: { mode: "message", minActionForMessage: "warn" },
          },
        } as PluginOptions,
        {
          __test_isMainSession: () => true,
          __test_reflectionPrompt: (payload) => { reflectionCaptured.push(payload.text); },
        },
      );
      const transform = plugin["experimental.chat.messages.transform"] as unknown as (
        input: unknown,
        output: unknown,
      ) => Promise<void>;
      const output = {
        messages: [
          { info: { role: "user", sessionID: sid }, parts: [{ type: "text", text: "first" }] },
          { info: { role: "assistant", sessionID: sid, agent: "build" }, parts: [{ type: "text", text: "reply" }] },
        ],
      };
      await transform({}, output);
      expect(reflectionCaptured.length).toBe(0);
    } finally {
      try { rmSync(dir, { recursive: true, force: true }); } catch {}
    }
  });

  it("4/5 the reflection prompt contains recent decision context (auditor reasoning)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "fase7-context-"));
    writeFileSync(join(dir, "PLAN.md"), "# test");
    const reflectionCaptured: string[] = [];
    try {
      const sid = "fase7-context-1";
      storeDecision(sid, makeDecision("stop", sid, "3 consecutive violations"));
      const plugin = await makePlugin(
        dir,
        {
          meta_governor: {
            enabled: true,
            skillPriming: { enabled: false },
            intervention: { mode: "message", minActionForMessage: "warn" },
          },
        } as PluginOptions,
        {
          __test_reflectionPrompt: (payload) => { reflectionCaptured.push(payload.text); },
          __test_isMainSession: () => true,
        },
      );
      const transform = plugin["experimental.chat.messages.transform"] as unknown as (
        input: unknown,
        output: unknown,
      ) => Promise<void>;
      const output = {
        messages: [
          { info: { role: "user", sessionID: sid }, parts: [{ type: "text", text: "first" }] },
          { info: { role: "assistant", sessionID: sid, agent: "build" }, parts: [{ type: "text", text: "reply" }] },
        ],
      };
      await transform({}, output);
      const text = reflectionCaptured.join("\n");
      expect(text.length).toBeGreaterThan(50);
      expect(text).toMatch(/audit|reflect|wrong|stuck|redirect|review/i);
    } finally {
      try { rmSync(dir, { recursive: true, force: true }); } catch {}
    }
  });

  it("5/5 the reflection prompt asks the LLM to reason (3 specific questions)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "fase7-questions-"));
    writeFileSync(join(dir, "PLAN.md"), "# test");
    const reflectionCaptured: string[] = [];
    try {
      const sid = "fase7-questions-1";
      storeDecision(sid, makeDecision("escalate", sid));
      const plugin = await makePlugin(
        dir,
        {
          meta_governor: {
            enabled: true,
            skillPriming: { enabled: false },
            intervention: { mode: "message", minActionForMessage: "warn" },
          },
        } as PluginOptions,
        {
          __test_reflectionPrompt: (payload) => { reflectionCaptured.push(payload.text); },
          __test_isMainSession: () => true,
        },
      );
      const transform = plugin["experimental.chat.messages.transform"] as unknown as (
        input: unknown,
        output: unknown,
      ) => Promise<void>;
      const output = {
        messages: [
          { info: { role: "user", sessionID: sid }, parts: [{ type: "text", text: "first" }] },
          { info: { role: "assistant", sessionID: sid, agent: "build" }, parts: [{ type: "text", text: "reply" }] },
        ],
      };
      await transform({}, output);
      const text = reflectionCaptured.join("\n");
      // The reflection should ask specific reasoning questions
      expect(text).toMatch(/going wrong/i);
      expect(text).toMatch(/stuck|loop/i);
      expect(text).toMatch(/path forward|redirect|pivot/i);
    } finally {
      try { rmSync(dir, { recursive: true, force: true }); } catch {}
    }
  });
});
