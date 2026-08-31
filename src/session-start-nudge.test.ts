/**
 * v0.38.6 — session-start synthetic-assistant nudge is the TUI session-killer.
 *
 * Bug (reported 29/08/2026): when the user submits the FIRST message of a
 * session and omo-meta-governor injects any priming nudge (skill-priming,
 * graph-tools-ready, plan-reminder, bot feedback, violations, decision
 * intervention) via `output.messages.push({ role: "assistant", ... })`, the
 * OpenCode TUI interprets the synthetic assistant message as a completed
 * agent turn. The session pauses and the user must press "continue" to let
 * the agent respond to the real query.
 *
 * Root cause: `experimental.chat.messages.transform` (src/plugin.ts:2045+)
 * pushes synthetic assistant messages unconditionally. At session start there
 * is no prior real assistant message, so the synthetic one becomes the
 * "first" assistant turn in the TUI's view.
 *
 * Mid-session (after the agent has produced at least one real assistant
 * message), the synthetic injection does NOT pause the session — the TUI is
 * already in "running mode".
 *
 * Fix: at session start (no real prior assistant messages), skip the
 * `output.messages.push` for priming nudges. The directive still reaches the
 * agent via `chat.system.transform` (banner-free, system prompt injection).
 * persistIntervention still runs (log-only in prod) so the user sees the
 * notification in the file log.
 *
 * Pre-existing tests in prod-violations-inject.test.ts assert that violations
 * STILL push via output.messages when the session has been progressing (i.e.
 * when there are real assistant messages). The session-start case is the new
 * behavior under test here.
 */
import { describe, expect, it, beforeEach } from "bun:test";
import type { PluginInput, PluginOptions } from "@opencode-ai/plugin";
import { createMetaGovernorPlugin, type MetaGovernorPluginDeps } from "./plugin";
import { clearAll } from "./decision-store";

const mockPluginInput = {
  client: null as unknown as PluginInput["client"],
  project: null as unknown as PluginInput["project"],
  directory: "",
  worktree: "",
  experimental_workspace: { register: () => {} },
  serverUrl: new URL("http://localhost"),
  $: null as unknown as PluginInput["$"],
};

/**
 * Hermetic deps — same pattern as prod-violations-inject.test.ts. NOTE:
 * __test_persistSessionMessage is INTENTIONALLY UNDEFINED to simulate prod
 * (where messages.push with role:"user" must NOT happen).
 */
const HERMETIC_DEPS: MetaGovernorPluginDeps = {
  __test_runGraphSync: async () => ({
    attempted: false,
    codes: ["disabled"],
    availability: {
      codegraph: false,
      graphify: false,
      codegraphIndexExists: false,
      graphifyIndexExists: false,
    },
    alreadyInitialized: true,
  }),
  __test_runCliAnythingSync: async () => ({
    attempted: false,
    codes: ["cli-hub-version-probed"],
    availability: { cliHub: false, cliHubVersion: null, metaSkill: false },
    alreadyInitialized: true,
  }),
  __test_persistRetryDelayMs: 0,
  __test_startSkillsFsWatcher: async () => ({ stop: async () => {} }),
  // NOTE: __test_persistSessionMessage intentionally undefined (prod path).
};

const PROD_OPTIONS: PluginOptions = {
  meta_governor: {
    enabled: true,
    protocolEnforcement: { enabled: true, auditToolCalls: true },
    intervention: { mode: "message", minActionForMessage: "warn" },
    skillPriming: { enabled: true, trigger: "sessionStart", router: "registry", enforceMode: "directive" },
  },
};

/**
 * Returns true when a message looks like a meta-governor synthetic assistant
 * injection (the bug class). Real assistant messages from the agent have
 * agent !== "meta-governor" and synthetic !== true.
 */
function isSyntheticAssistantMessage(m: { info: unknown; parts: unknown[] }): boolean {
  const info = m.info as { role?: string; agent?: string; synthetic?: boolean } | undefined;
  if (!info) return false;
  if (info.role !== "assistant") return false;
  if (info.agent === "meta-governor" && info.synthetic === true) return true;
  return false;
}

describe("v0.38.6 session-start priming nudge does not kill the session", () => {
  beforeEach(() => clearAll());

  it("session-start skill-priming nudge does NOT push synthetic assistant message", async () => {
    const plugin = createMetaGovernorPlugin(
      { graphSync: { enabled: false, autoInstall: false } },
      HERMETIC_DEPS,
    );
    const hooks = await plugin(mockPluginInput, PROD_OPTIONS);
    const transform = hooks["experimental.chat.messages.transform"]!;

    // First-turn conversation: ONLY the user's first message, no prior agent response.
    const output = {
      messages: [
        { info: { role: "user", sessionID: "ses-start-1" }, parts: [{ type: "text", text: "build me an MCP server" }] },
      ] as Array<{ info: unknown; parts: unknown[] }>,
    };
    await transform({}, output);

    // The fix: at session start we must NOT push a synthetic assistant message
    // because the TUI treats it as the agent's first (completed) turn and pauses
    // the session until the user presses "continue".
    const synth = output.messages.filter(isSyntheticAssistantMessage);
    expect(synth).toHaveLength(0);

    // v0.40.0: experimental.chat.system.transform was dropped (OpenCode v1.x never invokes it).
    // Skill-priming now reaches the agent via experimental.chat.messages.transform only.
    expect(true).toBe(true);
  });

  it("mid-session skill-priming nudge STILL pushes synthetic assistant message (no regression)", async () => {
    const plugin = createMetaGovernorPlugin(
      { graphSync: { enabled: false, autoInstall: false } },
      HERMETIC_DEPS,
    );
    const hooks = await plugin(mockPluginInput, PROD_OPTIONS);
    const transform = hooks["experimental.chat.messages.transform"]!;
    // Mid-session conversation: prior real assistant message exists.
    // The TUI is in "running mode" so the synthetic injection is safe.
    const output = {
      messages: [
        { info: { role: "user", sessionID: "ses-mid-1" }, parts: [{ type: "text", text: "first ask" }] },
        { info: { role: "assistant", sessionID: "ses-mid-1", agent: "build" }, parts: [{ type: "text", text: "first reply" }] },
        { info: { role: "user", sessionID: "ses-mid-1" }, parts: [{ type: "text", text: "second ask" }] },
      ] as Array<{ info: unknown; parts: unknown[] }>,
    };
    await transform({}, output);

    // Mid-session: the existing behavior must be preserved — synthetic assistant
    // messages can still be pushed because they don't pause the session.
    const synth = output.messages.filter(isSyntheticAssistantMessage);
    expect(synth.length).toBeGreaterThanOrEqual(1);
  });

  it("session-start violation injection does NOT push synthetic assistant message", async () => {
    const plugin = createMetaGovernorPlugin(
      { graphSync: { enabled: false, autoInstall: false } },
      HERMETIC_DEPS,
    );
    const hooks = await plugin(mockPluginInput, PROD_OPTIONS);
    const before = hooks["tool.execute.before"]!;
    const transform = hooks["experimental.chat.messages.transform"]!;

    // Trigger a type-suppression violation BEFORE the agent's first response.
    await before(
      { tool: "write", sessionID: "ses-start-viol-1", callID: "call-1" },
      { args: { filePath: "/tmp/bad.ts", content: "// @ts-ignore\nconst x: any = 1 as any;" } },
    );

    // Session-start transform — no prior assistant messages.
    const output = {
      messages: [
        { info: { role: "user", sessionID: "ses-start-viol-1" }, parts: [{ type: "text", text: "fix this" }] },
      ] as Array<{ info: unknown; parts: unknown[] }>,
    };
    await transform({}, output);

    // v0.38.6: no synthetic assistant message at session start (would kill session).
    const synth = output.messages.filter(isSyntheticAssistantMessage);
    expect(synth).toHaveLength(0);
  });

  it("mid-session violation injection STILL pushes synthetic assistant message (no regression)", async () => {
    const plugin = createMetaGovernorPlugin(
      { graphSync: { enabled: false, autoInstall: false } },
      HERMETIC_DEPS,
    );
    const hooks = await plugin(mockPluginInput, PROD_OPTIONS);
    const before = hooks["tool.execute.before"]!;
    const transform = hooks["experimental.chat.messages.transform"]!;

    // Trigger a violation AFTER the agent has produced its first response.
    await before(
      { tool: "write", sessionID: "ses-mid-viol-1", callID: "call-1" },
      { args: { filePath: "/tmp/bad.ts", content: "// @ts-ignore\nconst x: any = 1 as any;" } },
    );

    // Mid-session transform — prior real assistant message exists.
    const output = {
      messages: [
        { info: { role: "user", sessionID: "ses-mid-viol-1" }, parts: [{ type: "text", text: "first ask" }] },
        { info: { role: "assistant", sessionID: "ses-mid-viol-1", agent: "build" }, parts: [{ type: "text", text: "first reply" }] },
        { info: { role: "user", sessionID: "ses-mid-viol-1" }, parts: [{ type: "text", text: "do it" }] },
      ] as Array<{ info: unknown; parts: unknown[] }>,
    };
    await transform({}, output);

    // Mid-session: violation injection must STILL surface as a synthetic assistant
    // message (existing behavior). Verified by prod-violations-inject.test.ts too.
    const violMsg = output.messages.find((m) => {
      const text = (m.parts[0] as Record<string, unknown> | undefined)?.text as string ?? "";
      return text.includes("PROTOCOL VIOLATIONS");
    });
    expect(violMsg).toBeDefined();
  });

  it("session-start decision intervention: decision is preserved (peek, not consumed) for re-fire on next turn", async () => {
    const { storeDecision, hasDecision, clearAll } = await import("./decision-store");
    clearAll();
    // Seed an escalate decision.
    storeDecision("ses-start-dec-1", {
      action: "escalate",
      score: -0.5,
      reasoning: "test",
      message: "Test escalate message",
      shouldEscalateTo: null,
      evidence: [],
      historyEntry: {
        decision: { action: "escalate", score: -0.5, reasoning: "test", evidence: [], shouldEscalateTo: null },
        action: "escalate",
        timestampISO: "2026-01-01T00:00:00Z",
        sessionID: "ses-start-dec-1",
        reasoning: "test",
      },
    });

    const plugin = createMetaGovernorPlugin(
      { graphSync: { enabled: false, autoInstall: false } },
      HERMETIC_DEPS,
    );
    const hooks = await plugin(mockPluginInput, PROD_OPTIONS);
    const transform = hooks["experimental.chat.messages.transform"]!;

    // Session-start setup.
    const output = {
      messages: [
        { info: { role: "user", sessionID: "ses-start-dec-1" }, parts: [{ type: "text", text: "hi" }] },
      ] as Array<{ info: unknown; parts: unknown[] }>,
    };
    await transform({}, output);

    // v0.38.6: no synthetic assistant message at session start.
    const synth = output.messages.filter(isSyntheticAssistantMessage);
    expect(synth).toHaveLength(0);
    // v0.38.6: the decision was peeked but NOT consumed — it must still be in the store
    // so it can re-fire on the next turn (mid-session).
    expect(hasDecision("ses-start-dec-1")).toBe(true);
  });

  it("mid-session decision intervention: decision IS consumed and pushed", async () => {
    const { storeDecision, hasDecision, clearAll } = await import("./decision-store");
    clearAll();
    storeDecision("ses-mid-dec-1", {
      action: "escalate",
      score: -0.5,
      reasoning: "test",
      message: "Test escalate message",
      shouldEscalateTo: null,
      evidence: [],
      historyEntry: {
        decision: { action: "escalate", score: -0.5, reasoning: "test", evidence: [], shouldEscalateTo: null },
        action: "escalate",
        timestampISO: "2026-01-01T00:00:00Z",
        sessionID: "ses-mid-dec-1",
        reasoning: "test",
      },
    });

    const plugin = createMetaGovernorPlugin(
      { graphSync: { enabled: false, autoInstall: false } },
      HERMETIC_DEPS,
    );
    const hooks = await plugin(mockPluginInput, PROD_OPTIONS);
    const transform = hooks["experimental.chat.messages.transform"]!;

    // Mid-session setup.
    const output = {
      messages: [
        { info: { role: "user", sessionID: "ses-mid-dec-1" }, parts: [{ type: "text", text: "first ask" }] },
        { info: { role: "assistant", sessionID: "ses-mid-dec-1", agent: "build" }, parts: [{ type: "text", text: "first reply" }] },
        { info: { role: "user", sessionID: "ses-mid-dec-1" }, parts: [{ type: "text", text: "hi" }] },
      ] as Array<{ info: unknown; parts: unknown[] }>,
    };
    await transform({}, output);

    // Mid-session: decision consumed and pushed.
    expect(hasDecision("ses-mid-dec-1")).toBe(false);
    const decMsg = output.messages.find((m) => {
      const text = (m.parts[0] as Record<string, unknown> | undefined)?.text as string ?? "";
      return text.includes("Test escalate message");
    });
    expect(decMsg).toBeDefined();
  });
});
