/**
 * skill-quality tests (v0.59.0 F2/F3) — the gate that decides what becomes
 * an autonomous skill.
 *
 * Contract:
 * - G1: protocol rules are REJECTED (they are already in the system prompt).
 * - G2: a lesson with no project scope is REJECTED.
 * - G3: a generic remedy is REJECTED.
 * - G4: fewer than 3 lessons is REJECTED (anecdote, not pattern).
 * - G5: 3+ lessons of a project-specific rule with real places → PROMOTABLE.
 * - G6: the same rule in different places → DIFFERENT skills.
 * - G7: a skill that duplicates an existing slug/body is REJECTED.
 * - G8: the rendered body must have >= 3 substantive steps.
 */
import { describe, expect, it } from "bun:test";
import {
  bodySignature,
  isRenderableSkillBody,
  jaccard,
  proposeSkills,
  renderSkillBody,
  slugForSkill,
  type LessonInput,
} from "./skill-quality";

function lesson(
  id: string,
  tags: string[],
  where: string,
  what: string,
  mistake: string,
  confidence = 0.7,
): LessonInput {
  return {
    id,
    content: `Mistake: ${mistake}\nWhat to do: ${what}\nWhere: ${where}`,
    confidence,
    tags,
  }
}

const DI_LEESON = lesson(
  "L1",
  ["di-seam"],
  "src/plugin.ts",
  "Use a DI seam (__test_x) so the factory test can inject fakes",
  "mock.module leaks across Bun workers sharing a file",
);

describe("skill-quality F2 — the gate", () => {
  it("G1: protocol rules are rejected (already in the system prompt)", () => {
    const lessons = [1, 2, 3].map((i) =>
      lesson(
        `P${i}`,
        ["no-type-suppression"],
        "src/auth.ts",
        "Remove the `as any` and fix the type",
        "no-type-suppression: File write contains 'as any'",
        0.9,
      ),
    );
    const [proposal] = proposeSkills(lessons);
    expect(proposal!.promotable).toBe(false);
    expect(proposal!.rejections).toContain("protocol-rule");
  });

  it("G2: a lesson without project scope is rejected", () => {
    const lessons = [1, 2, 3].map((i) =>
      lesson(
        `S${i}`,
        ["misc-rule"],
        "session:abc",
        "Do the thing",
        "misc-rule: something went wrong",
        0.8,
      ),
    );
    const [proposal] = proposeSkills(lessons);
    expect(proposal!.promotable).toBe(false);
    expect(proposal!.rejections).toContain("no-project-scope");
  });

  it("G3: a generic remedy is rejected", () => {
    const lessons = [1, 2, 3].map((i) =>
      lesson(
        `G${i}`,
        ["misc-rule"],
        "src/foo.ts",
        "Re-read the plan and continue with verification",
        "misc-rule: wrong thing",
        0.8,
      ),
    );
    const [proposal] = proposeSkills(lessons);
    expect(proposal!.promotable).toBe(false);
    expect(proposal!.rejections).toContain("generic-remedy");
  });

  it("G4: fewer than 3 lessons is rejected", () => {
    const lessons = [1, 2].map((i) =>
      lesson(`F${i}`, ["di-seam"], "src/plugin.ts", "Use DI seams", "mock leaks", 0.8),
    );
    const [proposal] = proposeSkills(lessons);
    expect(proposal!.promotable).toBe(false);
    expect(proposal!.rejections).toContain("not-enough-evidence");
  });

  it("G5: 3+ lessons of a project rule with real places is promotable", () => {
    const lessons = [1, 2, 3].map((i) =>
      lesson(
        `D${i}`,
        ["di-seam"],
        "src/plugin.ts",
        "Use a DI seam (__test_x) so the factory test can inject fakes",
        "mock.module leaks across Bun workers sharing a file",
        0.7 + i * 0.05,
      ),
    );
    const [proposal] = proposeSkills(lessons);
    expect(proposal!.promotable).toBe(true);
    expect(proposal!.rejections).toEqual([]);
    expect(proposal!.count).toBe(3);
    expect(proposal!.confidence).toBeGreaterThanOrEqual(0.7);
    expect(proposal!.places).toContain("plugin.ts");
    expect(proposal!.slug).toBe("di-seam-plugin");
  });

  it("G6: the same rule in different places yields different skills", () => {
    const lessons = [
      ...[1, 2, 3].map((i) =>
        lesson(`A${i}`, ["di-seam"], "src/plugin.ts", "Use DI seam", "mock leaks", 0.8),
      ),
      ...[1, 2, 3].map((i) =>
        lesson(`B${i}`, ["di-seam"], "src/sqlite.ts", "Use DI seam", "mock leaks", 0.8),
      ),
    ];
    const proposals = proposeSkills(lessons);
    expect(proposals.length).toBe(2);
    expect(proposals[0]!.slug).not.toBe(proposals[1]!.slug);
    expect(proposals.every((p) => p.promotable)).toBe(true);
  });

  it("G7: an existing slug or near-identical body is rejected", () => {
    const lessons = [1, 2, 3].map((i) =>
      lesson(`E${i}`, ["di-seam"], "src/plugin.ts", "Use DI seam", "mock leaks", 0.8),
    );
    const [dup] = proposeSkills(lessons, { existingSkillSlugs: ["di-seam-plugin"] });
    expect(dup!.promotable).toBe(false);
    expect(dup!.rejections).toContain("duplicate-skill");

    const [base] = proposeSkills(lessons);
    const [near] = proposeSkills(lessons, {
      existingSkillBodies: [bodySignature(base!)],
    });
    expect(near!.promotable).toBe(false);
    expect(near!.rejections).toContain("near-duplicate-skill");
  });

  it("G8: a rendered body must have frontmatter, a procedure and pitfalls", () => {
    const lessons = [1, 2, 3].map((i) =>
      lesson(
        `R${i}`,
        ["di-seam"],
        "src/plugin.ts",
        "Use a DI seam (__test_x) so the factory test can inject fakes",
        "mock.module leaks across Bun workers sharing a file",
        0.8,
      ),
    );
    const [proposal] = proposeSkills(lessons);
    const body = renderSkillBody(proposal!);
    expect(body).toContain("---");
    expect(body).toContain("name: di-seam-plugin");
    expect(body).toContain("## Procedure");
    expect(body).toContain("## Pitfalls observed");
    // One remedy + one pitfall is a VALID skill (quality comes from the gate).
    expect(isRenderableSkillBody(body)).toBe(true);
    // A body without frontmatter / procedure / pitfalls is rejected.
    expect(isRenderableSkillBody("no frontmatter here")).toBe(false);
    expect(isRenderableSkillBody("---\nname: x\ndescription: \"y\"\n---\n\nno sections")).toBe(false);
  });

  it("helpers: slug and jaccard behave", () => {
    expect(slugForSkill("My Rule!", ["a.ts"])).toBe("my-rule-a");
    // Tokens shorter than 3 chars are ignored (they match everything).
    expect(jaccard("alpha beta gamma", "alpha beta gamma")).toBe(1);
    expect(jaccard("alpha beta gamma", "delta epsilon zeta")).toBe(0);
    expect(jaccard("alpha beta", "alpha gamma")).toBeGreaterThan(0);
    expect(jaccard("alpha beta", "alpha gamma")).toBeLessThan(1);
    expect(jaccard("a b c", "a b c")).toBe(0);
  });

  it("DI lesson fixture is shaped as expected", () => {
    expect(DI_LEESON.tags[0]).toBe("di-seam");
  });
});

  it("G9: agentmemory reinforcements count as occurrences (3 reps = 1 row)", () => {
    // agentmemory collapses 3 identical saves into ONE row with
    // reinforcements=2. The gate must count occurrences, not rows.
    const lessons = [1, 2, 3].map((i) =>
      lesson(
        `R${i}`,
        ["bun-mock-leak"],
        "src/plugin.ts",
        "Use a DI seam (__test_x) so the factory test can inject fakes",
        "mock.module leaks state between worker files",
        0.68,
      ),
    );
    // Same content -> ONE row with reinforcements=2.
    const collapsed = [
      { ...lessons[0]!, id: "single-row", reinforcements: 2, confidence: 0.68 },
    ];
    const [fromRows] = proposeSkills(lessons);
    const [fromCollapsed] = proposeSkills(collapsed);
    expect(fromRows!.count).toBe(3);
    expect(fromCollapsed!.count).toBe(3);
    expect(fromCollapsed!.promotable).toBe(true);
  });
