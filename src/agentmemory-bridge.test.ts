/**
 * agentmemory-bridge tests (v0.58.0 F2/F3) — hermetic, fake client.
 *
 * Contract:
 * - T1: empty context → empty block (zero noise).
 * - T2: non-empty context → block with the memory marker + no task framing.
 * - T3: file enrichment is used when files are given.
 * - T4: session end writes lessons, counts created vs strengthened, and
 *       closes the session.
 * - T5: session end with a down client → 0 saved, no throw.
 * - T6: lesson extraction collapses repeated rules into one lesson.
 */
import { describe, expect, it } from "bun:test";
import {
  createBridgeState,
  ensureAgentmemorySession,
  extractLessonsForSession,
  fetchTaskContext,
  fileSetKey,
  formatTaskContextBlock,
  persistSessionEnd,
} from "./agentmemory-bridge";
import { collapseDeviationsForLesson } from "./closed-loop-learning";
import type { AgentmemoryClient } from "./agentmemory-client";
import type { Deviation } from "./types";

type FakeClient = {
  context: (input: { sessionId: string; project?: string; files?: string[] }) => Promise<{
    context: string
    tokens: number
    blocks: number
  }>;
  enrich: (input: { sessionId: string; files: string[] }) => Promise<string>;
  saveLesson: (input: {
    content: string
    context?: string
    confidence?: number
    project?: string
    tags?: string[]
  }) => Promise<{ saved: boolean; action?: string; id?: string; confidence?: number }>;
  summarize: (sessionId: string) => Promise<boolean>;
  endSession: (sessionId: string) => Promise<boolean>;
  startSession: (input: { sessionId: string; project: string; cwd: string }) => Promise<boolean>;
} & Partial<AgentmemoryClient>;

function fakeClient(overrides: Partial<FakeClient> = {}): FakeClient {
  return {
    context: async () => ({ context: "", tokens: 0, blocks: 0 }),
    enrich: async () => "",
    saveLesson: async () => ({ saved: true, action: "created", id: "lsn_1" }),
    summarize: async () => true,
    endSession: async () => true,
    startSession: async () => true,
    ...overrides,
  } as FakeClient;
}

describe("agentmemory-bridge F2 — task context", () => {
  it("T1: empty context produces an empty block (zero noise)", () => {
    expect(formatTaskContextBlock("")).toBe("");
    expect(formatTaskContextBlock("   \n ")).toBe("");
  });

  it("T2: non-empty context produces a memory block, not a task instruction", () => {
    const block = formatTaskContextBlock("Prior work fixed the auth race.");
    expect(block).toContain("MEMORY CONTEXT");
    expect(block).toContain("Prior work fixed the auth race.");
    expect(block.toLowerCase()).not.toContain("you must");
  });

  it("T3: fetchTaskContext merges file enrichment and session context", async () => {
    const client = fakeClient({
      enrich: async () => "file ctx",
      context: async () => ({ context: "session ctx", tokens: 12, blocks: 1 }),
    });
    const res = await fetchTaskContext(client as unknown as AgentmemoryClient, {
      sessionID: "s1",
      project: "p",
      cwd: "/tmp",
      files: ["a.ts"],
    });
    expect(res.text).toContain("file ctx");
    expect(res.text).toContain("session ctx");
    expect(res.fromFiles).toBe(true);
    expect(res.tokens).toBe(12);
  });

  it("T3b: a down client yields empty context, never a throw", async () => {
    const client = fakeClient({
      context: async () => {
        throw new Error("down");
      },
      enrich: async () => {
        throw new Error("down");
      },
    });
    const res = await fetchTaskContext(client as unknown as AgentmemoryClient, {
      sessionID: "s1",
      project: "p",
      cwd: "/tmp",
    });
    expect(res.text).toBe("");
  });

  it("T3c: file set key is order-independent and deduped", () => {
    expect(fileSetKey(["b.ts", "a.ts", "b.ts"])).toBe(fileSetKey(["a.ts", "b.ts"]));
  });

  it("T3d: ensureAgentmemorySession starts once per session", async () => {
    let starts = 0;
    const client = fakeClient({
      startSession: async () => {
        starts++;
        return true;
      },
    });
    const state = createBridgeState();
    await ensureAgentmemorySession(client as unknown as AgentmemoryClient, state, "s1", "p", "/tmp");
    await ensureAgentmemorySession(client as unknown as AgentmemoryClient, state, "s1", "p", "/tmp");
    expect(starts).toBe(1);
  });
});

describe("agentmemory-bridge F3 — session end", () => {
  it("T4: writes lessons, counts created vs strengthened, closes session", async () => {
    const saved: string[] = [];
    let summarized = false;
    let ended = false;
    const client = fakeClient({
      saveLesson: async (input) => {
        saved.push(input.content);
        return input.content.includes("second")
          ? { saved: true, action: "strengthened", id: "lsn_2" }
          : { saved: true, action: "created", id: "lsn_1" };
      },
      summarize: async () => {
        summarized = true;
        return true;
      },
      endSession: async () => {
        ended = true;
        return true;
      },
    });
    const res = await persistSessionEnd(client as unknown as AgentmemoryClient, {
      sessionID: "s1",
      project: "p",
      lessons: [
        { content: "first lesson", confidence: 0.7 },
        { content: "second lesson", confidence: 0.7 },
      ],
    });
    expect(saved.length).toBe(2);
    expect(res.lessonsSaved).toBe(1);
    expect(res.lessonsStrengthened).toBe(1);
    expect(res.lessonsFailed).toBe(0);
    expect(summarized).toBe(true);
    expect(ended).toBe(true);
  });

  it("T5: a failing client yields 0 saved and no throw", async () => {
    const client = fakeClient({
      saveLesson: async () => {
        throw new Error("down");
      },
      summarize: async () => {
        throw new Error("down");
      },
      endSession: async () => {
        throw new Error("down");
      },
    });
    const res = await persistSessionEnd(client as unknown as AgentmemoryClient, {
      sessionID: "s1",
      project: "p",
      lessons: [{ content: "x" }],
    });
    expect(res.lessonsSaved).toBe(0);
    expect(res.lessonsFailed).toBe(1);
    expect(res.sessionEnded).toBe(false);
  });

  it("T6: extraction collapses repeated rules into one lesson", () => {
    const deviations: Deviation[] = [
      { severity: "media", category: "oracle-verification", detail: "files changed (3)" },
      { severity: "media", category: "oracle-verification", detail: "files changed (4)" },
      { severity: "grave", category: "memory-first", detail: "asked without recall" },
    ];
    const lessons = extractLessonsForSession(
      {
        deviations,
        filesChanged: ["src/a.ts"],
        whatToDo: "Request Oracle review before proceeding",
        whereToGo: "a.ts",
      },
      collapseDeviationsForLesson,
    );
    expect(lessons.length).toBe(2);
    expect(lessons[0]!.content).toContain("×2");
    expect(lessons[0]!.content).toContain("What to do:");
    expect(lessons[0]!.content).toContain("Where:");
    // grave deviation carries higher confidence
    const grave = lessons.find((l) => l.tags.includes("memory-first"))!;
    expect(grave.confidence).toBe(0.8);
  });
});
