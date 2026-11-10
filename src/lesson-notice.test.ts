/**
 * Session-end lesson notice (v0.66.0).
 *
 * The session-end path writes lessons to agentmemory automatically. The agent
 * used to finish the session without knowing what had been learned on its
 * behalf, while the DONE-gate nudge told it "no memory saved — consider one
 * lesson via omo_remember". Both statements are wrong together: the agent
 * re-saves a lesson that already exists, or it never learns what it learned.
 *
 * Contract:
 * - N1: the agent notice carries the lesson, inside the informational frame.
 * - N2: the user status is brief and contains no agent instructions.
 * - N3: end-to-end — a lesson persisted at session end is announced on the
 *       next turn AND the contradictory memory nudge is cancelled.
 * - N4: an unanchored deviation (memory-first only) saves nothing, so there is
 *       nothing to announce.
 */
import { describe, expect, it } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { PluginInput, PluginOptions } from "@opencode-ai/plugin"
import { createHermeticPlugin } from "./__test-helpers__/hermetic-plugin"
import { NullAgentmemoryClient } from "./agentmemory-client"
import { clearAll } from "./decision-store"
import {
  buildLessonLearnedAgentMessage,
  buildLessonLearnedUserStatus,
  type LearnedLessonNotice,
} from "./lesson-notice"

const DONE_MARKER = "<promise>DONE</promise>"

const SAMPLE: LearnedLessonNotice[] = [
  {
    mistake: "no-type-suppression: `as any` in src/bar.ts",
    whatToDo: "Type the value instead of suppressing the error",
    whereToGo: "src/bar.ts",
  },
]

describe("session-end lesson notice builders", () => {
  it("N1: agent text carries the learned lesson inside the informational frame", () => {
    const text = buildLessonLearnedAgentMessage(SAMPLE, { saved: 1, strengthened: 0 })
    expect(text).toContain("DO NOT TREAT AS TASK")
    expect(text).toContain("LESSON LEARNED")
    expect(text).toContain("no-type-suppression: `as any` in src/bar.ts")
    expect(text).toContain("What to do: Type the value")
    expect(text).toContain("Where: src/bar.ts")
    expect(text).toContain("do NOT re-save")
  })

  it("N2: user status is brief and carries no agent instructions", () => {
    const text = buildLessonLearnedUserStatus(SAMPLE, 1)
    expect(text.length).toBeLessThan(200)
    expect(text).not.toContain("omo_remember")
    expect(text).not.toContain("DO NOT TREAT AS TASK")
  })
})

// ---------------------------------------------------------------------------
// N3/N4 — end-to-end through the plugin
// ---------------------------------------------------------------------------

const mockBaseInput = {
  client: null as unknown as PluginInput["client"],
  project: null as unknown as PluginInput["project"],
  worktree: "",
  experimental_workspace: { register: () => {} },
  serverUrl: new URL("http://localhost"),
  $: null as unknown as PluginInput["$"],
} as const

function midSessionOutput(sid: string) {
  return {
    messages: [
      { info: { role: "user", sessionID: sid }, parts: [{ type: "text", text: "do the task" }] },
      { info: { role: "assistant", sessionID: sid, agent: "build" }, parts: [{ type: "text", text: "working" }] },
      { info: { role: "user", sessionID: sid }, parts: [{ type: "text", text: "continue" }] },
    ] as Array<{ info: unknown; parts: unknown[] }>,
  }
}

function agentTexts(output: { messages: Array<{ info: unknown; parts: unknown[] }> }): string[] {
  return output.messages.map((m) => {
    const p = m.parts[0] as { text?: string } | undefined
    return typeof p?.text === "string" ? p.text : ""
  })
}

function options(): PluginOptions {
  return {
    meta_governor: {
      enabled: true,
      skillPriming: { enabled: false },
      intervention: { mode: "message", minActionForMessage: "warn" },
      protocolEnforcement: { enabled: true, injectIntoSystem: false, auditToolCalls: true },
      workflowGates: { enabled: false, requirePlan: false },
      oracle: { frequency: "off" },
      closedLoop: {
        autoRemember: { enabled: false, cooldownMs: 0, dedupe: false },
        autonomousSkills: { enabled: false },
      },
    },
  } as unknown as PluginOptions
}

class RecordingClient extends NullAgentmemoryClient {
  saved: Array<{ content: string; project: string }> = []
  ended = false

  override async startSession(): Promise<boolean> {
    return true
  }

  override async saveLesson(
    input: Parameters<NullAgentmemoryClient["saveLesson"]>[0],
  ): Promise<{ saved: boolean; action?: string; id?: string; confidence?: number }> {
    this.saved.push({ content: input.content, project: input.project ?? "" })
    return { saved: true, action: "created", id: `lesson-${this.saved.length}`, confidence: 0.8 }
  }

  override async summarize(): Promise<boolean> {
    return true
  }

  override async endSession(): Promise<boolean> {
    this.ended = true
    return true
  }
}

async function waitFor(predicate: () => boolean, timeoutMs = 3000): Promise<boolean> {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    if (predicate()) return true
    await new Promise((r) => setTimeout(r, 25))
  }
  return predicate()
}

type Hook = (i: unknown, o: unknown) => Promise<void>

interface Harness {
  readonly before: Hook
  readonly after: Hook
  readonly transform: Hook
  readonly client: RecordingClient
  readonly userTexts: string[]
}

async function makeHarness(dir: string): Promise<Harness> {
  const client = new RecordingClient()
  const userTexts: string[] = []
  const plugin = createHermeticPlugin({}, {
    __test_isMainSession: () => true,
    __test_agentmemoryClient: client,
    __test_persistSessionMessage: async (_sid: string, text: string) => {
      userTexts.push(text)
      return { ok: true, messageID: null, error: null, durationMs: 0 }
    },
  })
  const hooks = (await plugin(
    { ...mockBaseInput, directory: dir } as PluginInput,
    options(),
  )) as unknown as Record<string, Hook>
  return {
    before: hooks["tool.execute.before"]!,
    after: hooks["tool.execute.after"]!,
    transform: hooks["experimental.chat.messages.transform"]!,
    client,
    userTexts,
  }
}

describe("session-end lesson notice (end to end)", () => {
  it("N3: a persisted lesson is announced to the agent and cancels the memory nudge", { timeout: 30000 }, async () => {
    const dir = mkdtempSync(join(tmpdir(), "lesson-notice-"))
    writeFileSync(join(dir, "PLAN.md"), "# test")
    try {
      clearAll()
      const sid = "ses_q_lesson_notice_n3"
      const h = await makeHarness(dir)

      // A violating write anchors the deviation to a real file. The path must
      // ride on toolInput.args: that is where the plugin records
      // recentWriteFilePaths (used as the session-end `Where:`).
      const writeArgs = { filePath: "/tmp/bad.ts", content: "// @ts-ignore\nconst x = 1 as never;" }
      await h.before(
        { tool: "write", sessionID: sid, callID: "c-write", args: writeArgs },
        { args: { filePath: "/tmp/bad.ts", content: "// @ts-ignore\nconst x = 1 as never;" } },
      )
      await h.after(
        { tool: "write", sessionID: sid, callID: "c-write", args: writeArgs },
        { title: "", output: `${DONE_MARKER} finished`, metadata: {} },
      )

      expect(await waitFor(() => h.client.saved.length > 0)).toBe(true)
      expect(h.client.saved[0]!.content).toContain("Mistake:")
      expect(h.client.saved[0]!.content).toContain("Where: /tmp/bad.ts")
      expect(h.client.ended).toBe(true)

      const out = midSessionOutput(sid)
      await h.transform({}, out)
      const texts = agentTexts(out)
      const notice = texts.find((t) => t.includes("LESSON LEARNED"))
      expect(notice).toBeDefined()
      expect(notice!).toContain("DO NOT TREAT AS TASK")
      expect(notice!).toContain("Where: /tmp/bad.ts")
      // The write already happened: the "no memory saved" nudge would lie.
      expect(texts.some((t) => t.includes("MEMORY NUDGE"))).toBe(false)

      const status = h.userTexts.find((t) => t.includes("guardada"))
      expect(status).toBeDefined()
      expect(status!.length).toBeLessThan(200)
    } finally {
      try {
        rmSync(dir, { recursive: true, force: true })
      } catch {
        // best-effort
      }
    }
  })

  it("N4: an unanchored deviation saves nothing, so nothing is announced", { timeout: 30000 }, async () => {
    const dir = mkdtempSync(join(tmpdir(), "lesson-notice-"))
    writeFileSync(join(dir, "PLAN.md"), "# test")
    try {
      clearAll()
      const sid = "ses_q_lesson_notice_n4"
      const h = await makeHarness(dir)

      // Asked the user without querying memory: no file, no diagnostic code.
      await h.before(
        { tool: "ask", sessionID: sid, callID: "c-ask", args: {} },
        { args: {} },
      )
      await h.after(
        { tool: "ask", sessionID: sid, callID: "c-ask", args: {} },
        { title: "", output: `${DONE_MARKER} done`, metadata: {} },
      )

      await new Promise((r) => setTimeout(r, 300))
      expect(h.client.saved.length).toBe(0)

      const out = midSessionOutput(sid)
      await h.transform({}, out)
      expect(agentTexts(out).some((t) => t.includes("LESSON LEARNED"))).toBe(false)
    } finally {
      try {
        rmSync(dir, { recursive: true, force: true })
      } catch {
        // best-effort
      }
    }
  })
})
