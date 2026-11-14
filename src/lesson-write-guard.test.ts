/**
 * Write-boundary lesson guard (v0.67.0).
 *
 * The user reported agentmemory rows shaped like:
 *   Action "stop" (score -0.57) after deviations: [grave] memory-first: ...
 *   Reasoning: Query memory (...) -> session:ses_ea836...
 *   Mistake: memory-first: ...
 *   WhatToDo: Query memory (`omo_recall`, then `omo_recall_mcp`) ...
 *   WhereToGo: session:ses_ea836...
 *
 * `omo_remember` forwarded the agent's text verbatim, so pasting the
 * intervention text created that row. The gate now lives at the single HTTP
 * write boundary, so every writer is covered.
 *
 * Contract:
 * - W1: the reported payload never reaches the network (rejected, no fetch).
 * - W2: the same payload anchored to a real file IS saved, canonicalized
 *       (no score dump, no WhatToDo:/WhereToGo: legacy labels).
 * - W3: a genuine free-form note is saved byte-identical.
 * - W4: a bare score dump with no lesson body is rejected.
 * - W5: `omo_remember` tells the agent the truth when the gate refuses.
 */
import { describe, expect, it } from "bun:test";
import { AgentmemoryClient } from "./agentmemory-client";
import { canonicalizeLessonForWrite } from "./closed-loop-learning";
import { buildOmoRememberTool } from "./custom-tools";

const REPORTED = `Action "stop" (score -0.57) after deviations: [grave] memory-first: Asked a question without first querying memory. Must fire omo_recall or omo_recall_mcp before asking the user.. Reasoning: Query memory (\`omo_recall\`, then \`omo_recall_mcp\`) before asking the user — the answer may already be known -> session:ses_ea836be31ffeRFN4PMGBbef0Sv
Mistake: memory-first: Asked a question without first querying memory. Must fire omo_recall or omo_recall_mcp before asking the user.
WhatToDo: Query memory (\`omo_recall\`, then \`omo_recall_mcp\`) before asking the user — the answer may already be known
WhereToGo: session:ses_ea836be31ffeRFN4PMGBbef0Sv`;

function recordingClient() {
  const seen: Array<Record<string, unknown>> = [];
  const client = new AgentmemoryClient({
    url: "http://localhost:3111",
    secret: "sec",
    fetch: async (_url, init) => {
      seen.push(JSON.parse(init?.body ?? "{}") as Record<string, unknown>);
      return {
        ok: true,
        status: 200,
        json: async () => ({ success: true, action: "created", lesson: { id: "lsn_1", confidence: 0.7 } }),
      };
    },
  });
  return { client, seen };
}

describe("lesson write guard (v0.67.0)", () => {
  it("W1: the reported spam payload never reaches agentmemory", async () => {
    const { client, seen } = recordingClient();
    const res = await client.saveLesson({ content: REPORTED, project: "p" });
    expect(res.saved).toBe(false);
    expect(res.rejected).toBe(true);
    expect(res.reason).toContain("static rule");
    expect(seen.length).toBe(0);
  });

  it("W2: the same lesson anchored to a real file is saved canonically", async () => {
    const { client, seen } = recordingClient();
    const anchored = REPORTED.replace(
      "WhereToGo: session:ses_ea836be31ffeRFN4PMGBbef0Sv",
      "WhereToGo: src/tooling/kill-port.ts",
    );
    const res = await client.saveLesson({ content: anchored, project: "p" });
    expect(res.saved).toBe(true);
    expect(seen.length).toBe(1);
    const body = String(seen[0]!.content);
    expect(body).not.toContain("after deviations");
    expect(body).not.toContain("WhatToDo:");
    expect(body).not.toContain("WhereToGo:");
    expect(body).toContain("Mistake: memory-first:");
    expect(body).toContain("What to do: Query memory");
    expect(body).toContain("Where: src/tooling/kill-port.ts");
  });

  it("W3: a genuine free-form note passes unchanged", async () => {
    const { client, seen } = recordingClient();
    const note = "Always use bun:sqlite (not better-sqlite3) in this repo.";
    const res = await client.saveLesson({ content: note, project: "p" });
    expect(res.saved).toBe(true);
    expect(seen[0]!.content).toBe(note);
  });

  it("W4: a bare score dump without a lesson body is rejected", () => {
    const verdict = canonicalizeLessonForWrite(
      'Action "stop" (score -1.00) after deviations: [grave] memory-first: x\nReasoning: y',
    );
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toContain("scoring dump");
  });

  it("W5: omo_remember reports the rejection instead of claiming a save", async () => {
    const tool = buildOmoRememberTool({
      agentmemory: {
        saveLesson: async () => ({ saved: false, rejected: true, reason: "restates the static rule directive" }),
      } as never,
      project: "p",
    });
    const res = await tool.execute({ content: REPORTED } as never, { sessionID: "ses_guard" } as never);
    expect(res.title).toContain("rejected");
    expect(String(res.output)).toContain("NOT saved");
    expect(String(res.output)).toContain("Mistake:");
  });
});
