/**
 * oracle-lesson tests (v0.61.0 F0).
 *
 * Contract:
 * - L1: the exact shape asked of the Oracle parses.
 * - L2: the variants (no "LESSON |" prefix, "What to do:" wording) parse.
 * - L3: text with no lesson returns null.
 * - L4: empty fields return null.
 * - L5: the generic whatToDo is rejected (it teaches nothing).
 * - L6: a lesson with a real mistake + real remedy survives the value gate.
 * - L7: the parser is pure — same input, same output.
 */
import { describe, expect, it } from "bun:test";
import { parseOracleLesson, looksLikeOracleLesson } from "./oracle-lesson";
import { GENERIC_WHAT_TO_DO, isActionableConscienceLesson } from "./closed-loop-learning";

describe("oracle-lesson F0 — parsing the Oracle verdict", () => {
  it("L1: the exact shape asked of the Oracle parses", () => {
    const text = [
      "The task is done. Files changed: 3.",
      "LESSON | Mistake: Did not run the Oracle verification after editing 3 files. | WhatToDo: Invoke the Oracle before declaring the change complete. | WhereToGo: src/plugin.ts",
    ].join("\n");
    const lesson = parseOracleLesson(text);
    expect(lesson).not.toBeNull();
    expect(lesson!.mistake).toBe("Did not run the Oracle verification after editing 3 files.");
    expect(lesson!.whatToDo).toBe("Invoke the Oracle before declaring the change complete.");
    expect(lesson!.whereToGo).toBe("src/plugin.ts");
  });

  it("L2: the variants parse (no prefix, 'What to do:' wording)", () => {
    const noPrefix = parseOracleLesson(
      "Mistake: forgot the migration step. What to do: write the migration. Where: db/migrate.ts",
    );
    expect(noPrefix?.mistake).toBe("forgot the migration step.");
    expect(noPrefix?.whatToDo).toBe("write the migration.");
    expect(noPrefix?.whereToGo).toBe("db/migrate.ts");

    const withPipe = parseOracleLesson(
      "LESSON | Mistake: a | WhatToDo: b | WhereToGo: c",
    );
    expect(withPipe).toEqual({ mistake: "a", whatToDo: "b", whereToGo: "c" });
  });

  it("L3: text with no lesson returns null", () => {
    expect(parseOracleLesson("All good. The tests pass. Nothing to report.")).toBeNull();
    expect(parseOracleLesson("")).toBeNull();
    expect(parseOracleLesson(undefined)).toBeNull();
  });

  it("L4: empty fields return null", () => {
    expect(parseOracleLesson("LESSON | Mistake:   | WhatToDo: b | WhereToGo: c")).toBeNull();
    expect(parseOracleLesson("LESSON | Mistake: a | WhatToDo:   | WhereToGo: c")).toBeNull();
    expect(parseOracleLesson("LESSON | Mistake: a | WhatToDo: b | WhereToGo:   ")).toBeNull();
  });

  it("L5: the generic whatToDo is rejected", () => {
    const res = parseOracleLesson(
      `LESSON | Mistake: some genuine rule violation happened here. | WhatToDo: ${GENERIC_WHAT_TO_DO} | WhereToGo: src/x.ts`,
    );
    expect(res).toBeNull();
  });

  it("L6: a real lesson survives the value gate", () => {
    const lesson = parseOracleLesson(
      "LESSON | Mistake: Skipped the post-task Oracle verification on a multi-file change. | WhatToDo: Invoke the Oracle verification protocol before marking the wave complete. | WhereToGo: src/scoring-engine.ts",
    );
    expect(lesson).not.toBeNull();
    expect(
      isActionableConscienceLesson(lesson!.mistake, lesson!.whatToDo, [], ["src/scoring-engine.ts"]),
    ).toBe(true);
  });

  it("L7: the parser is pure", () => {
    const text = "LESSON | Mistake: a | WhatToDo: b | WhereToGo: c";
    expect(parseOracleLesson(text)).toEqual(parseOracleLesson(text));
  });

  it("L8: looksLikeOracleLesson is a cheap pre-filter", () => {
    expect(looksLikeOracleLesson("LESSON | Mistake: a | WhatToDo: b | WhereToGo: c")).toBe(true);
    expect(looksLikeOracleLesson("Mistake: a. What to do: b. Where: c.")).toBe(true);
    expect(looksLikeOracleLesson("the build passed")).toBe(false);
  });

  it("L9: the WhereToGo is optional (a lesson can omit the place)", () => {
    const res = parseOracleLesson("LESSON | Mistake: a real mistake here | WhatToDo: a real remedy here");
    expect(res).not.toBeNull();
    expect(res!.whereToGo).toBe("");
  });
});
