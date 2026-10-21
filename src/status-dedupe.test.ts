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
 *
 * HERMITICITY: messages.transform also hosts the plan reminder, which fires
 * whenever audit state exists with interventionCount==0 and no PLAN.md is
 * found (and that copy never marks itself sent). An interleaved plan line
 * between the two identical decisions would — correctly — break the
 * consecutiveness the dedupe asserts on. Both tests therefore run with a
 * tmpdir project containing PLAN.md, which makes shouldInjectPlanReminder
 * return false deterministically (same trick as auditor-restoration 4/8).
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "bun:test";
import { createHermeticPlugin } from "./__test-helpers__/hermetic-plugin";
import { clearAll, storeDecision } from "./decision-store";
import type { DecisionHandlerOutput } from "./decision-handler";
import type { PluginInput } from "./plugin";

function mockPluginInput(directory: string): PluginInput {
  return {
    client: null as unknown as PluginInput["client"],
    project: null as unknown as PluginInput["project"],
    directory,
    worktree: "",
    experimental_workspace: { register: () => {} },
    serverUrl: new URL("http://localhost"),
    $: null as unknown as PluginInput["$"],
  };
}

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

/** Tmpdir project with PLAN.md: plan reminder gate deterministically false. */
function planFreeDir(prefix: string): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  writeFileSync(join(dir, "PLAN.md"), "# test plan");
  return { dir, cleanup: () => { try { rmSync(dir, { recursive: true, force: true }); } catch {} } };
}

const TEST_OPTIONS = {
  meta_governor: {
    enabled: true,
    skillPriming: { enabled: false },
    intervention: { mode: "message", minActionForMessage: "warn" },
  },
} as never;

describe("status-dedupe v0.62.0 — identical consecutive status persists once", () => {
  it("D1: identical decision twice -> one status persist", async () => {
    const { dir, cleanup } = planFreeDir("ses-dedupe-");
    try {
    clearAll();
    let persists = 0;
    const plugin = createHermeticPlugin(
      { skillPriming: { enabled: false } },
      // Count ONLY the decision status line; the decision status text
      // always contains "warn (score".
      { __test_persistSessionMessage: async (_sid: string, text: string) => { if (text.includes("warn (score")) persists += 1; return { ok: true, messageID: null, error: null, durationMs: 0 }; } },
    );
    const hooks = await plugin(mockPluginInput(dir), TEST_OPTIONS);
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
    } finally {
      cleanup();
    }
  });

  it("D2: changed message persists again", async () => {
    const { dir, cleanup } = planFreeDir("ses-dedupe2-");
    try {
    clearAll();
    let persists = 0;
    const plugin = createHermeticPlugin(
      { skillPriming: { enabled: false } },
      { __test_persistSessionMessage: async (_sid: string, text: string) => { if (text.includes("warn (score")) persists += 1; return { ok: true, messageID: null, error: null, durationMs: 0 }; } },
    );
    const hooks = await plugin(mockPluginInput(dir), TEST_OPTIONS);
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
    } finally {
      cleanup();
    }
  });
});
