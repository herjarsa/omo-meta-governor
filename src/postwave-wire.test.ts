/**
 * v0.21.0 (post-wave W6): end-to-end wire test — the full pipeline:
 * PHASE-N-COMPLETE signal → Oracle verification → post-wave directive
 * injected via promptAgentText (captured through the session client mock).
 *
 * NOTE: the client must be passed in mockInput.client — the plugin hydrates
 * the session bridge from `_input.client` at factory invocation, which would
 * overwrite any setSessionClient() call made before creation.
 */
import { describe, test, expect } from "bun:test"
import { createMetaGovernorPlugin } from "./plugin"
import { setSessionClient } from "./session-bridge"

type CapturedPrompt = { sessionID: string; text: string }

function makeMockInput(prompts: CapturedPrompt[]) {
  return {
    client: {
      // plugin.ts:254-262 requires `"tool" in client` for hydration.
      tool: {},
      session: {
        prompt: async (args: unknown) => {
          const a = args as {
            sessionID?: string
            path?: { id?: string }
            body: { parts: Array<{ type: string; text: string }> }
          }
          // v0.24.0: session-bridge uses the SDK v1 shape { path: { id }, body }.
          const sessionID = a.path?.id ?? a.sessionID
          prompts.push({ sessionID: sessionID ?? "", text: a.body.parts[0]?.text ?? "" })
          return { data: { info: { id: "msg-x" } } }
        },
      },
    },
    project: null,
    directory: "D:/test/postwave-proj",
    worktree: "",
    experimental_workspace: { register: () => {} },
    serverUrl: new URL("http://localhost"),
    $: null,
  }
}

function pwOptions(overrides: Record<string, unknown> = {}) {
  return {
    meta_governor: {
      enabled: true,
      intervention: {
        phaseAwareDoneSignal: true,
        respectDoneSignal: true,
      },
      postWave: {
        enabled: true,
        repoMode: "own",
        ...overrides,
      },
    },
  }
}

describe("post-wave wire (tool.execute.after)", () => {
  test("S1: PHASE-1-COMPLETE + oracle call → own-repo directive injected once", async () => {
    setSessionClient(null)
    const prompts: CapturedPrompt[] = []
    const plugin = createMetaGovernorPlugin({
      graphSync: { enabled: false, autoInstall: false },
    })
    const hooks = await plugin(makeMockInput(prompts) as never, pwOptions() as never)
    const after = hooks["tool.execute.after"]!

    // 1. Phase completes → no directive yet (Oracle has not verified).
    await after(
      { tool: "bash", sessionID: "s-pw", callID: "c1", args: {} },
      { title: "ok", output: "PHASE-1-COMPLETE", metadata: {} },
    )
    expect(prompts.length).toBe(0)

    // 2. Oracle call lands → gate flips → directive injected.
    await after(
      { tool: "task", sessionID: "s-pw", callID: "c2", args: {} },
      {
        title: "oracle",
        output: "subagent_type=oracle\nVERDICT: APPROVE",
        metadata: {},
      },
    )
    expect(prompts.length).toBe(1)
    expect(prompts[0]!.sessionID).toBe("s-pw")
    expect(prompts[0]!.text).toContain("Wave 1")
    expect(prompts[0]!.text).toContain("git push -u origin HEAD")

    // 3. Second oracle call → NOT re-injected (once per wave).
    await after(
      { tool: "task", sessionID: "s-pw", callID: "c3", args: {} },
      { title: "oracle", output: "subagent_type=oracle", metadata: {} },
    )
    expect(prompts.length).toBe(1)
  })

  test("disabled postWave → no directive even with phase + oracle", async () => {
    setSessionClient(null)
    const prompts: CapturedPrompt[] = []
    const plugin = createMetaGovernorPlugin({
      graphSync: { enabled: false, autoInstall: false },
    })
    const hooks = await plugin(
      makeMockInput(prompts) as never,
      pwOptions({ enabled: false }) as never,
    )
    const after = hooks["tool.execute.after"]!

    await after(
      { tool: "bash", sessionID: "s-pw2", callID: "c1", args: {} },
      { title: "ok", output: "PHASE-2-COMPLETE", metadata: {} },
    )
    await after(
      { tool: "task", sessionID: "s-pw2", callID: "c2", args: {} },
      { title: "oracle", output: "subagent_type=oracle", metadata: {} },
    )
    expect(prompts.length).toBe(0)
  })

  test("third-party repoMode → third-party directive with aas prefix", async () => {
    setSessionClient(null)
    const prompts: CapturedPrompt[] = []
    const plugin = createMetaGovernorPlugin({
      graphSync: { enabled: false, autoInstall: false },
    })
    const hooks = await plugin(
      makeMockInput(prompts) as never,
      pwOptions({ repoMode: "third-party" }) as never,
    )
    const after = hooks["tool.execute.after"]!

    await after(
      { tool: "bash", sessionID: "s-pw3", callID: "c1", args: {} },
      { title: "ok", output: "PHASE-3-COMPLETE", metadata: {} },
    )
    await after(
      { tool: "task", sessionID: "s-pw3", callID: "c2", args: {} },
      { title: "oracle", output: "subagent_type=oracle", metadata: {} },
    )
    expect(prompts.length).toBe(1)
    expect(prompts[0]!.text).toContain("THIRD-PARTY")
    expect(prompts[0]!.text).toContain("CONTRIBUTING.md")
  })
})
