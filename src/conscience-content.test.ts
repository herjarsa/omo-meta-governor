/**
 * Conscience content — real lesson, not verbatim dump (v0.53.1).
 *
 * WHY: the auto-remember path built `mistake` from raw scoring reasoning
 * (`reasoning.slice(0,500)` → 'Stop (score: -0.552): primary concern:
 * Iteration ratio...') and `whereToGo` as meta-instructions
 * ('Persist via omo_remember; recall via omo_recall...'). The saved CONTENT
 * was a judge dump + self-reference (`ToolRoute: omo_remember`) with generic
 * concepts ['conscience','media'] — noise that re-created the lesson spam the
 * P1 guards (0.5 threshold, dedupe) were meant to kill.
 *
 * New contract:
 * - mistake derives from REAL deviations (`${category}: ${detail}`, joined
 *   with '; ', ~300 chars), never raw reasoning.
 * - whereToGo is a PLACE (file basenames or `session:<id>`), never mentions
 *   omo_remember/omo_recall.
 * - Final content has no `ToolRoute:` self-reference (preamble already names
 *   the tool; saved lesson must be pure).
 * - No real rule deviation → no prompt (a stop by iteration-ratio alone means
 *   'the session is long', not a learnable rule violation).
 * - Concepts derive from real categories + basenames via extractConcepts.
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
  conscienceMistakeFromDeviations,
  conscienceWhereToGo,
} from "./closed-loop-learning";

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

function makeDumpDecision(sid: string, action: "escalate" | "stop" = "escalate"): DecisionHandlerOutput {
  const dump = "Stop (score: -0.550): primary concern: Iteration ratio: 2.80 (56/20)";
  return {
    action,
    message: `[MetaGovernor] Test ${action} with dump reasoning`,
    historyEntry: {
      decision: { action, score: -0.55, reasoning: dump, evidence: [], shouldEscalateTo: null },
      action,
      timestampISO: new Date().toISOString(),
      sessionID: sid,
      reasoning: dump,
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

const realDeviations: Deviation[] = [
  { severity: "media", category: "no-progress", detail: "agent stalled reading without edits", filePath: "src/foo.ts" },
  { severity: "grave", category: "type-suppression", detail: "as any in src/bar.ts", filePath: "src/bar.ts" },
];

describe("conscience content — real lesson, not verbatim dump", () => {
  it("(a) mistake derives from the deviation, never the raw scoring dump", () => {
    const mistake = conscienceMistakeFromDeviations(realDeviations);
    expect(mistake).toContain("no-progress");
    expect(mistake).toContain("agent stalled");
    expect(mistake).not.toContain("score:");
    expect(mistake).not.toContain("Iteration ratio");

    const memory = buildConscienceMemoryContent({
      action: "escalate",
      mistake,
      whatToDo: "Re-read the plan and continue with verification",
      whereToGo: conscienceWhereToGo(["src/foo.ts"], "ses_x"),
      score: -0.55,
      files: ["src/foo.ts"],
      deviations: realDeviations,
    });
    expect(memory.content).toContain("no-progress");
    expect(memory.content).not.toContain("ToolRoute:");
    expect(memory.content).not.toContain("Iteration ratio");
  });

  it("(b) whereToGo is a PLACE — never mentions omo_remember/omo_recall", () => {
    const place = conscienceWhereToGo(["src/foo.ts", "src/bar.ts"], "ses_place");
    expect(place).toContain("foo.ts");
    expect(place).not.toContain("omo_remember");
    expect(place).not.toContain("omo_recall");

    const fallback = conscienceWhereToGo([], "ses_empty");
    expect(fallback).toBe("session:ses_empty");
    expect(fallback).not.toContain("omo_remember");
    expect(fallback).not.toContain("omo_recall");

    const memory = buildConscienceMemoryContent({
      action: "stop",
      mistake: "type-suppression: as any in src/bar.ts",
      whatToDo: "Remove the suppression",
      whereToGo: place,
      score: -0.6,
      files: ["src/foo.ts"],
      deviations: realDeviations,
    });
    expect(memory.content).not.toContain("omo_remember");
    expect(memory.content).not.toContain("omo_recall");
    expect(memory.content).not.toContain("ToolRoute:");
  });

  it("(c) without REAL deviations no auto-remember prompt fires", async () => {
    const dir = mkdtempSync(join(tmpdir(), "conscience-noreal-"));
    writeFileSync(join(dir, "PLAN.md"), "# test");
    const calls: Array<{ promptText: string }> = [];
    try {
      clearAll();
      const sid = `ses_noreal_${Date.now()}`;
      const plugin = await createMetaGovernorPlugin(
        { graphSync: { enabled: false }, cliAnything: { enabled: false } },
        createHermeticExtra({
          __test_isMainSession: () => true,
          __test_autoRemember: (p: { promptText: string }) => { calls.push(p); },
        }),
      )(mockPluginInput(dir), {
        meta_governor: {
          enabled: true,
          skillPriming: { enabled: false },
          intervention: { mode: "message", minActionForMessage: "warn" },
          // Hermetic pin: auditToolCalls true inline so CI (no dev config file,
          // default false) matches dev. Same pattern as plugin.test.ts / memory-nudge.test.ts.
          protocolEnforcement: { enabled: true, injectIntoSystem: false, auditToolCalls: true },
          closedLoop: { autoRemember: { enabled: true, cooldownMs: 0, dedupe: false } },
        },
      } as PluginOptions);
      const transform = plugin["experimental.chat.messages.transform"] as unknown as (i: unknown, o: unknown) => Promise<void>;
      // No tool.execute.before → accumulatedDeviations empty → only the
      // synthetic 'conscience' wrapper would exist. A bare iteration-ratio
      // stop ('the session is long') must NOT become a lesson.
      storeDecision(sid, makeDumpDecision(sid, "stop"));
      await transform({}, midSessionOutput(sid));
      expect(calls.length).toBe(0);
    } finally {
      try { rmSync(dir, { recursive: true, force: true }); } catch {}
    }
  });

  it("(d) concepts include the REAL rule category, not just conscience/media", async () => {
    const dir = mkdtempSync(join(tmpdir(), "conscience-concepts-"));
    writeFileSync(join(dir, "PLAN.md"), "# test");
    const calls: Array<{ promptText: string }> = [];
    try {
      clearAll();
      const sid = `ses_concepts_${Date.now()}`;
      const plugin = await createMetaGovernorPlugin(
        { graphSync: { enabled: false }, cliAnything: { enabled: false } },
        createHermeticExtra({
          __test_isMainSession: () => true,
          __test_autoRemember: (p: { promptText: string }) => { calls.push(p); },
        }),
      )(mockPluginInput(dir), {
        meta_governor: {
          enabled: true,
          skillPriming: { enabled: false },
          intervention: { mode: "message", minActionForMessage: "warn" },
          // Hermetic pin: auditToolCalls true inline so the seeded write deviation
          // is recorded in CI (dev config file absent -> default false).
          protocolEnforcement: { enabled: true, injectIntoSystem: false, auditToolCalls: true },
          closedLoop: { autoRemember: { enabled: true, cooldownMs: 0, dedupe: false } },
        },
      } as PluginOptions);
      const hooks = plugin as unknown as Record<string, unknown>;
      const before = hooks["tool.execute.before"] as unknown as (i: unknown, o: unknown) => Promise<void>;
      const transform = hooks["experimental.chat.messages.transform"] as unknown as (i: unknown, o: unknown) => Promise<void>;
      // Seed a REAL rule deviation via a violating write (type-suppression).
      await before(
        { tool: "write", sessionID: sid, callID: "call-1" },
        { args: { filePath: "/tmp/bad.ts", content: "// @ts-ignore\nconst x: unknown = 1 as never;" } },
      );
      // Dump reasoning on purpose — mistake must still come from the deviation.
      storeDecision(sid, makeDumpDecision(sid, "escalate"));
      await transform({}, midSessionOutput(sid));
      expect(calls.length).toBe(1);
      const txt = calls[0]!.promptText;
      const mistakeLine = txt.split("\n").find((l) => l.startsWith("mistake:")) ?? "";
      expect(mistakeLine).not.toContain("score:");
      expect(mistakeLine).not.toContain("Iteration ratio");
      const whereLine = txt.split("\n").find((l) => l.startsWith("whereToGo:")) ?? "";
      expect(whereLine).not.toContain("omo_remember");
      expect(whereLine).not.toContain("omo_recall");
      expect(txt).toContain("concepts:");
    } finally {
      try { rmSync(dir, { recursive: true, force: true }); } catch {}
    }
  });
});
