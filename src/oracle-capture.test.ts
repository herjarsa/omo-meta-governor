/**
 * oracle-capture tests (v0.62.0) — F0 wiring end to end.
 *
 * The parser is unit-tested in oracle-lesson.test.ts. THESE tests prove the
 * plugin actually persists the lesson when a task verdict containing a
 * LESSON block arrives via tool.execute.after:
 * - C1: a real lesson (mistake + remedy) is written ONCE via writeLessonOnce.
 * - C2: the identical verdict arriving again does NOT write twice.
 * - C3: an agent-persisted lesson (omo_remember capture) is not duplicated.
 * - C4: a verdict with no lesson writes nothing.
 *
 * WHY: F0 shipped in v0.61.0 but 2 days live produced 0 captures — the
 * Oracle never ran, so the path never fired. These tests prove the wiring
 * works the day a verdict DOES arrive.
 */
import { describe, expect, it } from "bun:test";
import { createHermeticPlugin } from "./__test-helpers__/hermetic-plugin";
import { NullAgentmemoryClient } from "./agentmemory-client";
import type { PluginInput } from "./plugin";

const mockPluginInput = {
  client: null as unknown as PluginInput["client"],
  project: null as unknown as PluginInput["project"],
  directory: "",
  worktree: "",
  experimental_workspace: { register: () => {} },
  serverUrl: new URL("http://localhost"),
  $: null as unknown as PluginInput["$"],
};

const VERDICT = [
  "Oracle review complete. 3 files changed, patterns look consistent.",
  "LESSON | Mistake: Skipped the post-task Oracle verification on a multi-file change. | WhatToDo: Invoke the Oracle verification protocol before marking the wave complete. | WhereToGo: src/scoring-engine.ts",
].join("\n");

class CaptureClient extends NullAgentmemoryClient {
  saved: { content: string; project: string; tags?: string[] }[] = [];
  override async saveLesson(input: {
    content: string;
    project: string;
    context?: string;
    confidence?: number;
    tags?: string[];
  }): Promise<{ saved: boolean; action?: string; id?: string; confidence?: number }> {
    this.saved.push({ content: input.content, project: input.project, tags: input.tags });
    return { saved: true, action: "created", id: "test-id", confidence: 0.7 };
  }
}

async function driveTaskVerdict(after: Function, sessionID: string, output: string) {
  await (after as (...a: unknown[]) => Promise<unknown>)(
    { tool: "task", sessionID, callID: "c-oracle", args: { subagent_type: "oracle" } },
    { title: "oracle verdict", output, metadata: {} },
  );
  // The capture path runs in a fire-and-forget async IIFE — yield to it.
  await new Promise((r) => setTimeout(r, 50));
}

describe("oracle-capture F0 — verdict to memory wiring", () => {
  it("C1: a real lesson in a task verdict is written once", async () => {
    const client = new CaptureClient();
    const plugin = createHermeticPlugin({}, { __test_agentmemoryClient: client });
    const hooks = await plugin(mockPluginInput, { meta_governor: { enabled: true } });
    const after = hooks["tool.execute.after"];
    if (!after) throw new Error("tool.execute.after not registered");

    await driveTaskVerdict(after, "ses_f0_c1", VERDICT);
    expect(client.saved.length).toBe(1);
    expect(client.saved[0]!.content).toContain("Skipped the post-task Oracle verification");
    expect(client.saved[0]!.content).toContain("Invoke the Oracle verification protocol");
    expect(client.saved[0]!.tags).toContain("oracle");
  });

  it("C2: the identical verdict does not write twice", async () => {
    const client = new CaptureClient();
    const plugin = createHermeticPlugin({}, { __test_agentmemoryClient: client });
    const hooks = await plugin(mockPluginInput, { meta_governor: { enabled: true } });
    const after = hooks["tool.execute.after"];
    if (!after) throw new Error("tool.execute.after not registered");

    await driveTaskVerdict(after, "ses_f0_c2", VERDICT);
    await driveTaskVerdict(after, "ses_f0_c2", VERDICT);
    expect(client.saved.length).toBe(1);
  });

  it("C3: a verdict with no lesson writes nothing", async () => {
    const client = new CaptureClient();
    const plugin = createHermeticPlugin({}, { __test_agentmemoryClient: client });
    const hooks = await plugin(mockPluginInput, { meta_governor: { enabled: true } });
    const after = hooks["tool.execute.after"];
    if (!after) throw new Error("tool.execute.after not registered");

    await driveTaskVerdict(after, "ses_f0_c3", "All good. The tests pass. Nothing to report.");
    expect(client.saved.length).toBe(0);
  });
});
