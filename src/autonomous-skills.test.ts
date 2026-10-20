/**
 * autonomous-skills tests (v0.59.0 F5) — the agent writes its own skills.
 *
 * Contract:
 * - A1: a promotable pattern becomes SKILL.md on disk (no human step).
 * - A2: protocol-rule garbage is NOT written.
 * - A3: the same pattern twice does not create two skills.
 * - A4: the report lists the rejection reasons (auditable).
 * - A5: enabled:false writes nothing (kill-switch).
 * - A6: a body that fails the render check is never written.
 */
import { describe, expect, it } from "bun:test";
import { mkdtempSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  formatSynthesisReport,
  readExistingSkills,
  runAutonomousSynthesis,
  writeSkill,
} from "./autonomous-skills";
import type { LessonInput } from "./skill-quality";

function lesson(id: string, opts: Partial<LessonInput> = {}): LessonInput {
  return {
    id,
    content:
      "Mistake: mock.module leaks across Bun workers sharing a file\n" +
      "What to do: Use a DI seam (__test_x) so the factory test can inject fakes\n" +
      "Where: src/plugin.ts",
    confidence: 0.8,
    tags: ["di-seam"],
    ...opts,
  }
}

function pattern(n = 3): LessonInput[] {
  return Array.from({ length: n }, (_, i) => lesson(`L${i}`));
}

describe("autonomous-skills F5 — autonomous creation with gates", () => {
  it("A1: a promotable pattern becomes SKILL.md on disk", async () => {
    const dir = mkdtempSync(join(tmpdir(), "autonomous-skill-"));
    const projectDir = join(dir, ".agents", "skills");
    try {
      const res = await runAutonomousSynthesis({
        lessons: pattern(),
        cwd: dir,
        projectDir,
      });
      expect(res.written.length).toBe(1);
      expect(res.written[0]!.slug).toBe("di-seam-plugin");
      expect(existsSync(join(projectDir, "di-seam-plugin", "SKILL.md"))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("A2: protocol-rule garbage is NOT written", async () => {
    const dir = mkdtempSync(join(tmpdir(), "autonomous-garbage-"));
    const projectDir = join(dir, ".agents", "skills");
    try {
      const lessons = Array.from({ length: 5 }, (_, i) =>
        lesson(`G${i}`, {
          tags: ["no-type-suppression"],
          content:
            "Mistake: no-type-suppression: File write contains 'as any'\n" +
            "What to do: Remove the `as any` and fix the underlying type\n" +
            "Where: src/auth.ts",
          confidence: 0.95,
        }),
      );
      const res = await runAutonomousSynthesis({ lessons, cwd: dir, projectDir });
      expect(res.written.length).toBe(0);
      expect(res.rejected.some((r) => r.reasons.includes("protocol-rule"))).toBe(true);
      expect(existsSync(join(projectDir, "no-type-suppression-auth", "SKILL.md"))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("A3: running twice does not create a second skill", async () => {
    const dir = mkdtempSync(join(tmpdir(), "autonomous-idempotent-"));
    const projectDir = join(dir, ".agents", "skills");
    try {
      const first = await runAutonomousSynthesis({ lessons: pattern(), cwd: dir, projectDir });
      expect(first.written.length).toBe(1);
      const second = await runAutonomousSynthesis({ lessons: pattern(), cwd: dir, projectDir });
      expect(second.written.length).toBe(0);
      expect(second.rejected.some((r) => r.reasons.includes("duplicate-skill"))).toBe(true);
      expect(readExistingSkills(projectDir).length).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("A4: the report lists rejection reasons (auditable)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "autonomous-report-"));
    try {
      const res = await runAutonomousSynthesis({
        lessons: pattern(),
        cwd: dir,
        projectDir: join(dir, ".agents", "skills"),
      });
      const report = formatSynthesisReport(res);
      expect(report).toContain("SKILLS CREATED");
      expect(report).toContain("di-seam-plugin");
      expect(report).toContain("Scanned 3 lesson");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("A5: enabled:false writes nothing (kill-switch)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "autonomous-kill-"));
    const projectDir = join(dir, ".agents", "skills");
    try {
      const res = await runAutonomousSynthesis({
        lessons: pattern(),
        cwd: dir,
        projectDir,
        config: { enabled: false },
      });
      expect(res.written.length).toBe(0);
      expect(res.rejected[0]!.reasons).toContain("autonomous-disabled");
      expect(existsSync(join(projectDir, "di-seam-plugin", "SKILL.md"))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("A6: a non-renderable body is never written", () => {
    const dir = mkdtempSync(join(tmpdir(), "autonomous-render-"));
    try {
      const res = writeSkill(dir, "bad-skill", "too short");
      expect(res.written).toBe(false);
      expect(res.reason).toBe("not-renderable");
      expect(existsSync(join(dir, "bad-skill", "SKILL.md"))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
