/**
 * Skill synthesis — Nivel 2 self-improvement (PLAN-skill-synthesis.md, v0.57).
 *
 * S1: findSkillCandidates() groups consolidated lesson patterns (N>=3,
 *     avgConfidence>=0.6) as skill candidates.
 * S2: draftSkillBody() + writeDraftSkill() synthesize DRAFT-SKILL.md
 *     (NEVER SKILL.md directly — human approval required).
 * S3: omo_skill_propose lists candidates; omo_skill_promote moves
 *     DRAFT-SKILL.md -> SKILL.md ONLY with explicit confirmed=true.
 *     No auto-promotion, no exceptions.
 */
import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteBackend } from "./sqlite-backend";
import {
  buildOmoSkillPromoteTool,
  buildOmoSkillProposeTool,
  draftSkillBody,
  findSkillCandidates,
  promoteDraftSkill,
  synthesizeSlug,
  writeDraftSkill,
} from "./skill-synthesis";

function tmpDb(): string {
  return join(tmpdir(), `omo-synth-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
}

async function seedPattern(dbPath: string, tags: string[], n = 3): Promise<SqliteBackend> {
  const backend = new SqliteBackend(dbPath);
  for (let i = 0; i < n; i++) {
    await backend.saveLesson({
      content: `Lesson ${i} about ${tags[0]}: concrete mistake and remedy number ${i} with enough detail`,
      context: "c",
      confidence: 0.6 + i * 0.1,
      tags,
      dedupeKey: `synth-${tags[0]}-${i}-${Date.now()}`,
    });
  }
  return backend;
}

describe("skill synthesis S1 — candidate detection", () => {
  it("S1a: groups N>=3 same-signature lessons into one candidate", async () => {
    const dbPath = tmpDb();
    const backend = await seedPattern(dbPath, ["codebase-graph-first", "search.ts"], 3);
    try {
      await backend.saveLesson({
        content: "unrelated memory-first lesson with sufficient detail here",
        context: "c",
        confidence: 0.7,
        tags: ["memory-first"],
        dedupeKey: `synth-other-${Date.now()}`,
      });
      const candidates = findSkillCandidates(await backend.listLessons(), { minGroupSize: 3, minAvgConfidence: 0.6 });
      expect(candidates.length).toBe(1);
      expect(candidates[0]!.count).toBe(3);
      expect(candidates[0]!.avgConfidence).toBeGreaterThanOrEqual(0.6);
      expect(candidates[0]!.tags).toContain("codebase-graph-first");
      expect(candidates[0]!.lessonIds.length).toBe(3);
    } finally {
      try { backend.close(); } catch {}
    }
  });

  it("S1b: minGroupSize filters small groups", async () => {
    const dbPath = tmpDb();
    const backend = await seedPattern(dbPath, ["codebase-graph-first"], 2);
    try {
      const rows = await backend.listLessons();
      expect(findSkillCandidates(rows, { minGroupSize: 3, minAvgConfidence: 0.5 }).length).toBe(0);
      expect(findSkillCandidates(rows, { minGroupSize: 2, minAvgConfidence: 0.5 }).length).toBe(1);
    } finally {
      try { backend.close(); } catch {}
    }
  });
});

describe("skill synthesis S2 — draft generation (never SKILL.md)", () => {
  it("S2a: slug is kebab-case from primary tag", () => {
    expect(synthesizeSlug(["codebase-graph-first", "search.ts"])).toBe("codebase-graph-first");
    expect(synthesizeSlug(["Memory First!"])).toBe("memory-first");
    expect(synthesizeSlug([])).toMatch(/^lesson-[a-z0-9]+$/);
  });

  it("S2b: draft body has frontmatter, sections, source lesson ids", () => {
    const body = draftSkillBody(
      { slug: "codebase-graph-first", tags: ["codebase-graph-first"], count: 3, avgConfidence: 0.7, lessonIds: ["L-1", "L-2"] },
      ["Query the code graph before grep", "Use omo_search for symbols"],
    );
    expect(body).toContain("name: codebase-graph-first");
    expect(body).toContain("description:");
    expect(body).toContain("L-1");
    expect(body).not.toContain("omo_remember");
  });

  it("S2c: writeDraftSkill writes DRAFT-SKILL.md, never SKILL.md; refuses over real skills", async () => {
    const dir = mkdtempSync(join(tmpdir(), "synth-draft-"));
    try {
      const r1 = await writeDraftSkill(dir, "my-rule", "# draft body here");
      expect(r1.written).toBe(true);
      expect(r1.path!.endsWith("DRAFT-SKILL.md")).toBe(true);
      const r2 = await writeDraftSkill(dir, "my-rule", "# draft body here");
      expect(r2.written).toBe(false);
      // A real SKILL.md blocks drafts (never clobber human-approved skills).
      const { mkdirSync, writeFileSync } = await import("node:fs");
      const otherDir = join(dir, ".agents", "skills", "other-rule");
      mkdirSync(otherDir, { recursive: true });
      writeFileSync(join(otherDir, "SKILL.md"), "# real skill");
      const r3 = await writeDraftSkill(dir, "other-rule", "# draft");
      expect(r3.written).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("S2d: promote moves DRAFT->SKILL only; fails without draft", async () => {
    const dir = mkdtempSync(join(tmpdir(), "synth-promote-"));
    try {
      const missing = await promoteDraftSkill(dir, "nope", true);
      expect(missing.promoted).toBe(false);
      await writeDraftSkill(dir, "my-rule", "# draft body here");
      const unconfirmed = await promoteDraftSkill(dir, "my-rule", false);
      expect(unconfirmed.promoted).toBe(false);
      const ok = await promoteDraftSkill(dir, "my-rule", true);
      expect(ok.promoted).toBe(true);
      expect(ok.path!.endsWith("SKILL.md")).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("skill synthesis S3 — propose/promote tools", () => {
  it("S3a: propose lists candidates and writes drafts; empty when none", async () => {
    const dbPath = tmpDb();
    const backend = await seedPattern(dbPath, ["codebase-graph-first", "search.ts"], 3);
    const cwd = mkdtempSync(join(tmpdir(), "synth-propose-"));
    try {
      const t = buildOmoSkillProposeTool({ sqlite: backend, cwd });
      const result = await (t.execute as any)({ minGroupSize: 3, minAvgConfidence: 0.6 }, { sessionID: "x" });
      expect(result.title).toContain("1 candidate");
      expect(result.output).toContain("DRAFT-SKILL.md");
      const empty = await (t.execute as any)({ minGroupSize: 99, minAvgConfidence: 0.6 }, { sessionID: "x" });
      expect(empty.title).toContain("no candidates");
    } finally {
      try { backend.close(); } catch {}
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("S3b: promote refuses without confirmation; full flow works after approval", async () => {
    const dbPath = tmpDb();
    const backend = await seedPattern(dbPath, ["memory-first"], 3);
    const cwd = mkdtempSync(join(tmpdir(), "synth-flow-"));
    try {
      const propose = buildOmoSkillProposeTool({ sqlite: backend, cwd });
      await (propose.execute as any)({ minGroupSize: 3, minAvgConfidence: 0.5 }, { sessionID: "x" });
      const promote = buildOmoSkillPromoteTool({ cwd });
      const refused = await (promote.execute as any)({ slug: "memory-first", confirmed: false }, { sessionID: "x" });
      expect(refused.title).toContain("refused");
      const ok = await (promote.execute as any)({ slug: "memory-first", confirmed: true }, { sessionID: "x" });
      expect(ok.title).toContain("promoted");
      const { existsSync } = await import("node:fs");
      expect(existsSync(join(cwd, ".agents", "skills", "memory-first", "SKILL.md"))).toBe(true);
    } finally {
      try { backend.close(); } catch {}
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});
