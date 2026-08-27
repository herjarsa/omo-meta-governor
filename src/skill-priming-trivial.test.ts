/**
 * v0.35.2 regression tests for isTrivialWrite + suggestSkillFindQuery.
 *
 * The skill-priming enforcement gate was over-restrictive in v0.35.0:
 * it blocked ANY implementation tool until omo_skill_find was called,
 * including throwaway scripts and small in-place edits. This caused agents
 * to stall on benign writes (the user-reported "small_caps_monitor/scanner/ws.py"
 * case). These tests pin the v0.35.2 bypass behavior.
 */
import { describe, expect, it } from "bun:test";
import {
  isTrivialWrite,
  suggestSkillFindQuery,
  TRIVIAL_PATH_PATTERNS,
  TRIVIAL_MAX_LINES,
} from "./skill-priming";

describe("isTrivialWrite (v0.35.2)", () => {
  it("treats edit_block as trivial regardless of args", () => {
    expect(isTrivialWrite("edit_block", {})).toBe(true);
    expect(isTrivialWrite("edit_block", { filePath: "/app/src/core.ts" })).toBe(true);
  });

  it("treats multi_edit as trivial", () => {
    expect(isTrivialWrite("multi_edit", { filePath: "/app/src/big-module.ts" })).toBe(true);
  });

  it("treats desktop-commander_edit_block as trivial", () => {
    expect(isTrivialWrite("desktop-commander_edit_block", {})).toBe(true);
  });

  it("treats apply_patch / ast_grep_replace / refactor as trivial", () => {
    expect(isTrivialWrite("apply_patch", {})).toBe(true);
    expect(isTrivialWrite("ast_grep_replace", {})).toBe(true);
    expect(isTrivialWrite("refactor", {})).toBe(true);
  });

  it("bypasses a small write under TRIVIAL_MAX_LINES lines", () => {
    const small = "import os\nprint('hi')\n".padEnd(10, "x");
    const lines = small.split("\n").slice(0, TRIVIAL_MAX_LINES).join("\n");
    expect(isTrivialWrite("write", { filePath: "/app/scratch/ws.py", content: lines })).toBe(true);
  });

  it("does NOT bypass a large write to a non-trivial path", () => {
    const big = Array.from({ length: TRIVIAL_MAX_LINES + 10 }, (_, i) => `line ${i}`).join("\n");
    expect(
      isTrivialWrite("write", { filePath: "/app/src/core/engine.ts", content: big }),
    ).toBe(false);
  });

  it("bypasses writes to trivial paths even with large content", () => {
    const big = Array.from({ length: 500 }, (_, i) => `line ${i}`).join("\n");
    expect(
      isTrivialWrite("write", { filePath: "/app/.tmp/notes.md", content: big }),
    ).toBe(true);
    expect(
      isTrivialWrite("write", { filePath: "/app/scratch/experiment.py", content: big }),
    ).toBe(true);
  });

  it("bypasses writes to test paths", () => {
    expect(
      isTrivialWrite("write", { filePath: "/app/tests/test_foo.py", content: "x" }),
    ).toBe(true);
    expect(
      isTrivialWrite("write", { filePath: "/app/__tests__/bar.test.ts", content: "x" }),
    ).toBe(true);
    expect(
      isTrivialWrite("write", { filePath: "/app/src/foo.test.ts", content: "x" }),
    ).toBe(true);
    expect(
      isTrivialWrite("write", { filePath: "/app/src/foo.spec.ts", content: "x" }),
    ).toBe(true);
  });

  it("bypasses writes to fixtures and examples", () => {
    expect(isTrivialWrite("write", { filePath: "/app/fixtures/data.json", content: "{}" })).toBe(true);
    expect(isTrivialWrite("write", { filePath: "/app/examples/demo.go", content: "// hi" })).toBe(true);
  });

  it("does NOT bypass omo_skill_find (not an implementation tool at all)", () => {
    expect(isTrivialWrite("omo_skill_find", {})).toBe(false);
  });

  it("does NOT bypass bash tool calls (bash redirect gate is upstream)", () => {
    expect(isTrivialWrite("bash", {})).toBe(false);
  });

  it("does NOT bypass a read call", () => {
    expect(isTrivialWrite("read", { filePath: "/app/src/core.ts" })).toBe(false);
  });

  it("handles write args with `path` instead of `filePath`", () => {
    expect(
      isTrivialWrite("write", { path: "/app/.tmp/note.txt", content: "hi" }),
    ).toBe(true);
    const sixtyLines = Array.from({ length: 60 }, () => "x").join("\n");
    expect(
      isTrivialWrite("write", { path: "/app/src/core.ts", content: sixtyLines }),
    ).toBe(false);
  });

  it("handles missing content by NOT bypassing (write would replace file)", () => {
    // No content arg \u2014 we cannot prove this is a trivial write; refuse the bypass.
    expect(
      isTrivialWrite("write", { filePath: "/app/src/core.ts" }),
    ).toBe(false);
  });

  it("TRIVIAL_PATH_PATTERNS covers the documented set", () => {
    expect(TRIVIAL_PATH_PATTERNS.length).toBeGreaterThanOrEqual(5);
  });
});

describe("suggestSkillFindQuery (v0.35.2)", () => {
  it("returns a python query for a .py file", () => {
    const q = suggestSkillFindQuery("write", { filePath: "/app/scanner/ws.py" });
    expect(q).toContain("omo_skill_find");
    expect(q.toLowerCase()).toContain("python");
  });

  it("returns a typescript query for a .ts file", () => {
    const q = suggestSkillFindQuery("write", { filePath: "/app/src/core.ts" });
    expect(q.toLowerCase()).toContain("typescript");
  });

  it("returns a bash query for shell redirects", () => {
    const q = suggestSkillFindQuery("bash", { command: "echo > file.txt" });
    expect(q.toLowerCase()).toContain("bash");
  });

  it("returns a generic code query when path has no extension", () => {
    const q = suggestSkillFindQuery("write", { filePath: "/app/Makefile" });
    expect(q).toContain("omo_skill_find");
  });

  it("includes --limit 5 to bound skill-hub lookup cost", () => {
    expect(suggestSkillFindQuery("write", { filePath: "/app/x.ts" })).toContain("--limit");
  });
});
