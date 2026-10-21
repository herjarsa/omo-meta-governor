/**
 * status-dedupe tests (v0.62.0).
 *
 * Contract: the TUI status line (persistIntervention) is a human aid — the
 * agent already receives every decision via system.transform. A byte-identical
 * repeat of the previous status carries zero information.
 * - D1: two identical consecutive decisions persist the status ONCE.
 * - D2: a changed message persists again (no swallowing of new info).
 *
 * WHY: 2 days live produced 448 IDENTICAL "persist intervention" log lines
 * for one stuck session (same stop every turn) — log spam that also
 * inflated interventions_delivered.
 */
import { describe, expect, it } from "bun:test";
import { createHermeticPlugin } from "./__test-helpers__/hermetic-plugin";
import { clearAll, storeDecision } from "./decision-store";
import type { DecisionHandlerOutput } from "./decision-handler";
import type { PluginInput } from "./plugin";

const mockPluginInput = {
  client: null as unknown as PluginInput["client"],
  project: null as unknown as PluginInput["project"],
  directory: "",
  worktree: "",
  experimental_workspace: { register: () => {} },
  serverUrl: new URL("http://localhost"),
  $: null as unknown as PluginInput["$"],
};

function makeWarn(message: string): DecisionHandlerOutput {
  return {
    action: "warn",
    message,
    historyEntry: {
      decision: { action: "warn", score: -0.2, evidence: [] },
      reasoning: message,
    },
  } as unknown as DecisionHandlerOutput;
}

describe("status-dedupe v0.62.0 — identical consecutive status persists once", () => {
  it("D1: identical decision twice -> one status persist", async () => {
    clearAll();
    let persists = 0;
    const plugin = createHermeticPlugin(
      { skillPriming: { enabled: false } },
      { __test_persistSessionMessage: async () => { persists += 1; return { ok: true, messageID: null, error: null, durationMs: 0 }; } },
    );
    const hooks = await plugin(mockPluginInput, { meta_governor: { enabled: true, skillPriming: { enabled: false } } });
    const transform = hooks["experimental.chat.messages.transform"] as unknown as (
      input: unknown,
      output: { messages: { info: unknown; parts: unknown[] }[] },
    ) => Promise<void>;
    if (!transform) throw new Error("messages.transform not registered");

    storeDecision("ses_dedupe", makeWarn("[MetaGovernor] Test warn message — identical"));
    await transform({ sessionID: "ses_dedupe" }, { messages: [{ info: { sessionID: "ses_dedupe" }, parts: [] }] });
    const afterFirst = persists;
    expect(afterFirst).toBe(1);

    storeDecision("ses_dedupe", makeWarn("[MetaGovernor] Test warn message — identical"));
    await transform({ sessionID: "ses_dedupe" }, { messages: [{ info: { sessionID: "ses_dedupe" }, parts: [] }] });
    expect(persists).toBe(afterFirst);
  });

  it("D2: changed message persists again", async () => {
    clearAll();
    let persists = 0;
    const plugin = createHermeticPlugin(
      { skillPriming: { enabled: false } },
      { __test_persistSessionMessage: async () => { persists += 1; return { ok: true, messageID: null, error: null, durationMs: 0 }; } },
    );
    const hooks = await plugin(mockPluginInput, { meta_governor: { enabled: true, skillPriming: { enabled: false } } });
    const transform = hooks["experimental.chat.messages.transform"] as unknown as (
      input: unknown,
      output: { messages: { info: unknown; parts: unknown[] }[] },
    ) => Promise<void>;
    if (!transform) throw new Error("messages.transform not registered");

    storeDecision("ses_dedupe2", makeWarn("[MetaGovernor] First message"));
    await transform({ sessionID: "ses_dedupe2" }, { messages: [{ info: { sessionID: "ses_dedupe2" }, parts: [] }] });
    expect(persists).toBe(1);

    storeDecision("ses_dedupe2", makeWarn("[MetaGovernor] Second message — different"));
    await transform({ sessionID: "ses_dedupe2" }, { messages: [{ info: { sessionID: "ses_dedupe2" }, parts: [] }] });
    expect(persists).toBe(2);
  });
});
