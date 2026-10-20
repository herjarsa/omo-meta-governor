/**
 * project-signals tests (v0.60.0 F5).
 *
 * Contract:
 * - S1: patterns below the frequency threshold are ignored (noise).
 * - S2: recurring errors and co-changes are separated and sorted.
 * - S3: profile commonErrors/conventions and insights are carried through.
 * - S4: the score contribution is negative only with real signals, and capped.
 * - S5: the digest is capped so a noisy project cannot flood the context.
 * - S6: the cache reads once per project per TTL (not per tool call).
 */
import { describe, expect, it } from "bun:test";
import {
  buildProjectSignals,
  EMPTY_PROJECT_SIGNALS,
  formatProjectSignals,
  ProjectSignalCache,
  scoreProjectSignals,
} from "./project-signals";
import type { AgentmemoryClient } from "./agentmemory-client";

function pattern(over: Record<string, unknown>) {
  return over as never;
}

describe("project-signals F5 — building the signals", () => {
  it("S1: patterns below the frequency threshold are ignored", () => {
    const signals = buildProjectSignals(
      [
        pattern({ type: "error_repeat", description: "rare error", frequency: 1 }),
        pattern({ type: "error_repeat", description: "common error", frequency: 4 }),
      ],
      null,
      [],
      3,
    );
    expect(signals.recurringErrors.length).toBe(1);
    expect(signals.recurringErrors[0]!.description).toBe("common error");
  });

  it("S2: recurring errors and co-changes are separated and sorted by frequency", () => {
    const signals = buildProjectSignals(
      [
        pattern({ type: "error_repeat", description: "err-a", frequency: 3 }),
        pattern({ type: "error_repeat", description: "err-b", frequency: 7 }),
        pattern({ type: "co_change", description: "a.ts + b.ts", frequency: 5 }),
        pattern({ type: "co_change", description: "c.ts + d.ts", frequency: 2 }),
      ],
      null,
      [],
      3,
    );
    expect(signals.recurringErrors.map((e) => e.description)).toEqual(["err-b", "err-a"]);
    expect(signals.coChanges.map((c) => c.description)).toEqual(["a.ts + b.ts"]);
  });

  it("S3: profile and insights are carried through", () => {
    const signals = buildProjectSignals(
      [],
      {
        commonErrors: ["SQLite query failed: no such table 'session'", "  "],
        conventions: ["use DI seams"],
        topConcepts: [{ concept: "pm2", frequency: 3 }],
      },
      [{ text: "insight one" }, { title: "insight two" }, { text: "   " }],
      3,
    );
    expect(signals.commonErrors.length).toBe(1);
    expect(signals.conventions).toEqual(["use DI seams"]);
    expect(signals.insights).toEqual(["insight one", "insight two"]);
    expect(signals.empty).toBe(false);
    expect(signals.projectScoped).toBe(false);
  });

  it("S4: the score is negative only with real signals and is capped", () => {
    expect(scoreProjectSignals(EMPTY_PROJECT_SIGNALS)).toBe(0);
    const one = buildProjectSignals(
      [pattern({ type: "error_repeat", description: "e", frequency: 3 })],
      null,
      [],
      3,
    );
    expect(scoreProjectSignals(one)).toBeLessThan(0);
    const many = buildProjectSignals(
      Array.from({ length: 20 }, (_, i) =>
        pattern({ type: "error_repeat", description: `e${i}`, frequency: 5 }),
      ),
      null,
      [],
      3,
    );
    expect(scoreProjectSignals(many)).toBeGreaterThanOrEqual(-0.6);
  });

  it("S5: the digest is capped", () => {
    const signals = buildProjectSignals(
      Array.from({ length: 20 }, (_, i) =>
        pattern({ type: "error_repeat", description: `error ${i}`, frequency: 5 }),
      ),
      { commonErrors: Array.from({ length: 10 }, (_, i) => `err ${i}`) },
      [],
      3,
    );
    const digest = formatProjectSignals(signals, 8);
    const lines = digest.split("\n");
    expect(lines.length).toBeLessThanOrEqual(9);
    expect(digest).toContain("PROJECT HISTORY");
  });

  it("S6: empty signals render nothing", () => {
    expect(formatProjectSignals(EMPTY_PROJECT_SIGNALS)).toBe("");
  });
});

describe("project-signals F5 — the cache", () => {
  it("S6b: the client is read ONCE per project per TTL", async () => {
    let patternCalls = 0;
    let profileCalls = 0;
    const client = {
      patterns: async () => {
        patternCalls++;
        return [pattern({ type: "error_repeat", description: "e", frequency: 4 })];
      },
      projectProfile: async () => {
        profileCalls++;
        return null;
      },
      projectInsights: async () => [],
    } as unknown as AgentmemoryClient;

    const cache = new ProjectSignalCache(300_000);
    const first = await cache.getOrFetch(client, "proj", { minFrequency: 3 });
    const second = await cache.getOrFetch(client, "proj", { minFrequency: 3 });
    expect(patternCalls).toBe(1);
    expect(profileCalls).toBe(1);
    expect(first.recurringErrors.length).toBe(1);
    expect(second.recurringErrors.length).toBe(1);
  });

  it("S6c: a disabled config never touches the client", async () => {
    let calls = 0;
    const client = {
      patterns: async () => {
        calls++;
        return [];
      },
    } as unknown as AgentmemoryClient;
    const cache = new ProjectSignalCache(300_000);
    const res = await cache.getOrFetch(client, "proj", { enabled: false });
    expect(calls).toBe(0);
    expect(res.empty).toBe(true);
  });
});

describe("project-signals F5 — effect on the score", () => {
  it("S7: with weight 0 the score is untouched; with weight > 0 it drops", () => {
    const { score } = require("./scoring-engine");
    const baseCtx = {
      oracleVerified: false,
      noProgress: false,
      deviations: [],
      iterationRatio: 0.1,
      lessonsRelevant: [],
      slotMemory: { consecutiveStops: 0, consecutiveContinues: 0, lastUpdatedISO: new Date().toISOString() },
      ambient: { sessionID: "s", directory: ".", mode: "simple", agentName: "a", iteration: 1, maxIterations: 10 },
    };
    const signals = {
      recurringErrors: [{ description: "SQLite query failed: no such table 'session'", frequency: 4 }],
      coChanges: [],
      derivedRules: [],
      commonErrors: ["SQLite query failed"],
      conventions: [],
      insights: [],
      empty: false,
    };
    const neutral = score({ ...baseCtx });
    const informative = score({ ...baseCtx, projectSignals: signals, projectSignalsWeight: 0 });
    const weighted = score({ ...baseCtx, projectSignals: signals, projectSignalsWeight: 0.2 });
    // Weight 0 = informative only: the score MUST NOT move.
    expect(informative.decision.score).toBe(neutral.decision.score);
    // With a real weight the score drops.
    expect(weighted.decision.score).toBeLessThan(neutral.decision.score);
    // The contribution only exists when it carries weight.
    expect(informative.contributions.some((c: any) => c.source === "project-signals")).toBe(false);
    expect(weighted.contributions.some((c: any) => c.source === "project-signals")).toBe(true);
  });
});

describe("project-signals F5 — project scope", () => {
  it("S8: a pattern mentioning the project's files is marked project-scoped", () => {
    const scoped = buildProjectSignals(
      [pattern({ type: "error_repeat", description: "error in src/omo-meta-governor/plugin.ts", frequency: 4 })],
      null,
      [],
      3,
      "omo-meta-governor",
    );
    expect(scoped.projectScoped).toBe(true);
    const unscoped = buildProjectSignals(
      [pattern({ type: "error_repeat", description: "post-tool failure hook triggered", frequency: 16 })],
      null,
      [],
      3,
      "omo-meta-governor",
    );
    expect(unscoped.projectScoped).toBe(false);
    // The digest marks unscoped patterns so the agent knows the scope.
    expect(formatProjectSignals(unscoped)).toContain("machine-wide");
  });
});
