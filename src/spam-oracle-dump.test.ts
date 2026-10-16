/**
 * Spam-oracle-dump reproduction (PLAN-spam-fix F1).
 *
 * Reproduces the user-reported AgentMemory garbage:
 *   Action "stop" (score -0.69) after deviations: [media] oracle-verification:
 *   Files changed (3)... (4)... (5)... (6)..., concepts ["oracle-verification","media",...]
 *
 * Contract pinned here:
 * - T1: with oracle.frequency="final-only" (default), mid-work writes with
 *       filesChanged>=3 and no Oracle invoked produce ZERO oracle-verification
 *       deviations (the plugin itself suppresses mid-work Oracle).
 * - T2: repeated identical deviations collapse to ONE lesson line with a ×N
 *       count instead of N verbatim dumps.
 * - T3: extractConcepts NEVER emits severity tokens ("media"/"leve"/"grave").
 * - T4: conscienceDedupeKey is multiplicity-insensitive (set, not multiset).
 */
import { describe, expect, it } from "bun:test";
import { auditToolCall } from "./protocol-enforcer";
import {
  buildConscienceMemoryContent,
  collapseDeviationsForLesson,
  conscienceDedupeKey,
  extractConcepts,
  GENERIC_WHAT_TO_DO,
  isActionableConscienceLesson,
  isNovelAgainstRecall,
  synthesizeWhatToDo,
} from "./closed-loop-learning";
import { buildEscalationPrompt } from "./session-bridge";
import { score } from "./scoring-engine";
import { SqliteBackend } from "./sqlite-backend";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Deviation } from "./types";

function oracleDeviation(filesChanged: number): Deviation {
  return {
    severity: "media",
    category: "oracle-verification",
    detail:
      `Files changed (${filesChanged}) >= 3 but Oracle was not invoked. ` +
      "The POST-TASK ORACLE VERIFICATION protocol requires Oracle invocation on multi-file changes.",
  };
}

describe("spam-oracle-dump reproduction (F1)", () => {
  it("T1: final-only mid-work writes emit NO oracle-verification deviation", () => {
    for (const filesChanged of [3, 4, 5, 6]) {
      const violations = auditToolCall("write", { path: "src/a.ts" }, {
        memoryToolsUsed: [],
        hasCodegraphDir: false,
        hasGraphifyDir: false,
        oracleInvoked: false,
        filesChanged,
        emptyRecall: false,
        escalationAttempted: false,
        oracleFrequency: "final-only",
      });
      expect(violations.filter((v) => v.rule === "oracle-verification")).toEqual([]);
    }
  });

  it("T1b: per-stop still emits (agent must invoke Oracle manually at stop band)", () => {
    const violations = auditToolCall("write", { path: "src/a.ts" }, {
      memoryToolsUsed: [],
      hasCodegraphDir: false,
      hasGraphifyDir: false,
      oracleInvoked: false,
      filesChanged: 3,
      emptyRecall: false,
      escalationAttempted: false,
      oracleFrequency: "per-stop",
    });
    expect(violations.some((v) => v.rule === "oracle-verification")).toBe(true);
  });

  it("T2: 4 identical deviations collapse to ONE line with ×4", () => {
    const deviations = [3, 4, 5, 6].map(oracleDeviation);
    const memory = buildConscienceMemoryContent({
      action: "stop",
      mistake: "oracle-verification: multi-file change without Oracle",
      whatToDo: "Request Oracle review before proceeding",
      whereToGo: "newblock.ts, patch-edges.cjs",
      score: -0.69,
      files: ["src/newblock.ts", "src/patch-edges.cjs"],
      deviations,
    });
    const occurrences = memory.content.split("Oracle was not invoked").length - 1;
    expect(occurrences).toBe(1);
    expect(memory.content).toContain("×4");
  });

  it("T3: concepts exclude severity tokens", () => {
    const concepts = extractConcepts([oracleDeviation(3)], ["src/newblock.ts"]);
    expect(concepts).not.toContain("media");
    expect(concepts).not.toContain("leve");
    expect(concepts).not.toContain("grave");
    expect(concepts).toContain("oracle-verification");
    expect(concepts).toContain("newblock.ts");
  });

  it("T4: dedupe key ignores deviation multiplicity", () => {
    const once = conscienceDedupeKey({
      action: "stop",
      evidenceSources: ["deviation-detector"],
      deviationCategories: ["oracle-verification"],
    });
    const fourTimes = conscienceDedupeKey({
      action: "stop",
      evidenceSources: ["deviation-detector"],
      deviationCategories: [
        "oracle-verification",
        "oracle-verification",
        "oracle-verification",
        "oracle-verification",
      ],
    });
    expect(fourTimes).toBe(once);
  });
});

describe("spam-fix F3/F4 gates", () => {
  const mediaOracle = (n: number): Deviation => ({
    severity: "media",
    category: "oracle-verification",
    detail: `Files changed (${n}) >= 3 but Oracle was not invoked.`,
  });

  it("T5: generic whatToDo + ungrounded lesson is NOT actionable; grounded IS", () => {
    const mistake = "oracle-verification: multi-file change without Oracle review";
    expect(isActionableConscienceLesson(mistake, GENERIC_WHAT_TO_DO, [mediaOracle(3)], [])).toBe(false);
    expect(
      isActionableConscienceLesson(mistake, GENERIC_WHAT_TO_DO, [mediaOracle(3)], ["newblock.ts"]),
    ).toBe(true);
    expect(
      isActionableConscienceLesson(mistake, "Request Oracle review before proceeding", [mediaOracle(3)], []),
    ).toBe(true);
    expect(isActionableConscienceLesson("too short", GENERIC_WHAT_TO_DO, [mediaOracle(3)], ["a.ts"])).toBe(false);
  });

  it("T6: restated recalled lesson is NOT novel; new lesson IS", () => {
    const recalled = [{ title: 'Action "stop" after oracle-verification', concepts: ["oracle-verification"] }];
    expect(
      isNovelAgainstRecall("Action stop after oracle-verification deviation in session", recalled),
    ).toBe(false);
    expect(
      isNovelAgainstRecall("no-type-suppression: file write contains as any cast in auth module", recalled),
    ).toBe(true);
  });

  it("T7: collapse keeps distinct rules, merges repeats", () => {
    const collapsed = collapseDeviationsForLesson([
      mediaOracle(3),
      mediaOracle(4),
      { severity: "grave", category: "memory-first", detail: "Asked without recall" },
    ]);
    expect(collapsed.length).toBe(2);
    expect(collapsed.find((d) => d.category === "oracle-verification")!.detail).toContain("×2");
    expect(collapsed.find((d) => d.category === "memory-first")!.severity).toBe("grave");
  });

  it("T8: goal-progress rewards near-complete plans, absent signal is neutral", () => {
    const baseCtx = {
      oracleVerified: false,
      noProgress: false,
      deviations: [],
      iterationRatio: 0.2,
      lessonsRelevant: [],
      slotMemory: { consecutiveStops: 0, consecutiveContinues: 0, lastUpdatedISO: new Date().toISOString() },
      ambient: { sessionID: "s", directory: ".", mode: "simple", agentName: "a", iteration: 2, maxIterations: 10 },
    } as const;
    const noSignal = score({ ...baseCtx, deviations: [], lessonsRelevant: [], slotMemory: baseCtx.slotMemory });
    const advanced = score({ ...baseCtx, planProgress: 0.9 });
    const goalContrib = (r: { contributions: Array<{ source: string; weightedScore: number }> }) =>
      r.contributions.find((c) => c.source === "goal-progress")!.weightedScore;
    expect(goalContrib(noSignal)).toBe(0);
    expect(goalContrib(advanced)).toBeGreaterThan(0);
    expect(advanced.decision.score).toBeGreaterThan(noSignal.decision.score);
  });

  it("T9: expireUnusedLessons deletes stale unused, keeps recalled", async () => {
    const dbPath = join(tmpdir(), `omo-spam-expire-${Date.now()}.db`);
    const backend = new SqliteBackend(dbPath);
    try {
      const old1 = await backend.saveLesson({ content: "stale unused lesson one", context: "c", confidence: 0.8 });
      const old2 = await backend.saveLesson({ content: "stale recalled lesson two", context: "c", confidence: 0.8 });
      // Backdate both, then simulate recall of old2 only.
      const past = Date.now() - 30 * 24 * 60 * 60 * 1000;
      backend.recordLessonUse([old2.id]);
      const { openDatabase } = await import("./sqlite-driver");
      const db = openDatabase(dbPath);
      try {
        db.prepare("UPDATE entries SET created_at = ? WHERE id IN (?, ?)").run(past, old1.id, old2.id);
        db.prepare("UPDATE entries SET last_used = ? WHERE id = ?").run(Date.now(), old2.id);
      } finally {
        db.close();
      }
      const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
      expect(backend.expireUnusedLessons(cutoff)).toBe(1);
    } finally {
      try { backend.close(); } catch {}
    }
  });
});

describe("spam-fix F5 judge-synthesis", () => {
  it("T10: whatToDo is rule-specific, never the generic template", () => {
    expect(
      synthesizeWhatToDo(
        [{ severity: "media", category: "no-type-suppression", detail: "as any in auth.ts" }],
        null,
      ),
    ).toContain("proper narrowing");
    expect(
      synthesizeWhatToDo(
        [{ severity: "media", category: "codebase-graph-first", detail: "grep instead of graph" }],
        null,
      ),
    ).toContain("omo_search");
    expect(
      synthesizeWhatToDo(
        [{ severity: "media", category: "oracle-verification", detail: "files changed" }],
        null,
      ),
    ).toContain("Oracle review");
    // Escalation targets keep their directives.
    expect(synthesizeWhatToDo([], "oracle")).toContain("Oracle review");
    expect(synthesizeWhatToDo([], "user")).toContain("user");
    // Unknown rule only -> generic fallback (value gate rejects it ungrounded).
    expect(
      synthesizeWhatToDo([{ severity: "media", category: "unknown-rule", detail: "x".repeat(50) }], null),
    ).toBe(GENERIC_WHAT_TO_DO);
  });

  it("T11: Oracle escalation prompt piggybacks a structured LESSON block", () => {
    const prompt = buildEscalationPrompt({
      reasoning: "score -0.65",
      target: "oracle",
      evidenceCount: 2,
      sessionID: "ses-1",
    });
    expect(prompt).toContain("LESSON");
    expect(prompt).toContain("omo_remember");
    expect(prompt).toContain("PASS with no findings");
  });
});

describe("Nivel 1 self-curation", () => {
  it("T12: consolidateLessons merges same-signature lessons, bumps confidence", async () => {
    const dbPath = join(tmpdir(), `omo-spam-consolidate-${Date.now()}.db`);
    const backend = new SqliteBackend(dbPath);
    try {
      await backend.saveLesson({ content: "short lesson about graph-first rule", context: "c", confidence: 0.6, tags: ["codebase-graph-first", "search.ts"], dedupeKey: "k1" });
      await backend.saveLesson({ content: "a much longer lesson about the codebase-graph-first rule with extra detail on when it applies", context: "c", confidence: 0.7, tags: ["search.ts", "codebase-graph-first"], dedupeKey: "k2" });
      await backend.saveLesson({ content: "unrelated memory-first lesson", context: "c", confidence: 0.6, tags: ["memory-first"], dedupeKey: "k3" });
      const result = backend.consolidateLessons();
      expect(result.groups).toBe(1);
      expect(result.merged).toBe(1);
      const top = await backend.topLessons(10);
      expect(top.length).toBe(2);
      const keeper = top.find((l) => l.concepts.includes("codebase-graph-first"))!;
      expect(keeper.confidence).toBeGreaterThan(0.7);
      expect(keeper.content).toContain("Consolidated from 2 similar lessons");
    } finally {
      try { backend.close(); } catch {}
    }
  });
});
