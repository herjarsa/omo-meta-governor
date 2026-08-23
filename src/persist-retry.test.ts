/**
 * v0.31.3 Persist retry — GREEN tests.
 *
 * Bug: interventions reach the model via messages.transform, but the
 * best-effort persistSessionMessage() call (which makes the intervention
 * visible in the TUI + session DB) times out whenever the OpenCode server
 * is busy processing the active turn. Log evidence:
 *   "persist intervention failed ... timed out after 10000ms"
 * The intervention was delivered to the model yet invisible in history.
 *
 * Contract: persistIntervention retries ONCE after a short delay, and
 * only for timeout-shaped errors (other failures are terminal — a missing
 * client will not heal by retrying).
 */
import { describe, expect, it, beforeEach } from "bun:test"
import type { PluginInput, PluginOptions } from "@opencode-ai/plugin"
import type { DecisionHandlerOutput } from "./types"
import type { PromptResult } from "./session-bridge"
import { createMetaGovernorPlugin } from "./plugin"
import { clearAll, storeDecision } from "./decision-store"

// ─── Shared helpers (mirrors intervention-fix.test.ts) ──────────

const mockPluginInput = {
  client: null as unknown as PluginInput["client"],
  project: null as unknown as PluginInput["project"],
  directory: "",
  worktree: "",
  experimental_workspace: { register: () => {} },
  serverUrl: new URL("http://localhost"),
  $: null as unknown as PluginInput["$"],
}

function makeDecision(
  action: DecisionHandlerOutput["action"],
  sessionID = "test-session",
): DecisionHandlerOutput {
  return {
    action,
    message: `[MetaGovernor] Test ${action} message`,
    historyEntry: {
      decision: {
        action,
        score: action === "continue" ? 0.5 : -0.5,
        reasoning: `Test ${action}`,
        evidence: [],
        shouldEscalateTo: null,
      },
      action,
      timestampISO: new Date().toISOString(),
      sessionID,
      reasoning: `Test ${action}`,
    },
  }
}

const TIMEOUT_ERR =
  "session.prompt persist for ses_r timed out after 10000ms"

function okResult(): PromptResult {
  return { ok: true, messageID: "m1", error: null, durationMs: 1 }
}
function timeoutResult(): PromptResult {
  return { ok: false, messageID: null, error: TIMEOUT_ERR, durationMs: 10000 }
}
function clientErrorResult(): PromptResult {
  return {
    ok: false,
    messageID: null,
    error: "SessionBridge: no OpenCode client captured",
    durationMs: 0,
  }
}

function makeOpts(): PluginOptions {
  return {
    meta_governor: {
      enabled: true,
      intervention: {
        mode: "message",
        minActionForMessage: "warn",
        persistToSession: true,
      },
      skillPriming: { enabled: false },
    },
  }
}

type PersistStub = (
  sessionID: string,
  text: string,
) => Promise<PromptResult>

async function runTransformWithDeps(
  sessionID: string,
  persist: PersistStub,
  retryDelayMs: number,
): Promise<void> {
  const plugin = createMetaGovernorPlugin(
    { graphSync: { enabled: false, autoInstall: false } },
    {
      __test_persistSessionMessage: persist,
      __test_persistRetryDelayMs: retryDelayMs,
    },
  )
  const hooks = await plugin(mockPluginInput, makeOpts())
  const transform = hooks["experimental.chat.messages.transform"]!
  const output = {
    messages: [
      {
        info: { role: "user", sessionID },
        parts: [{ type: "text", text: "hi" }],
      },
    ] as Array<{ info: unknown; parts: unknown[] }>,
  }
  await transform({}, output)
}

const settle = () => new Promise((r) => setTimeout(r, 120))

// ─── Scenarios ──────────────────────────────────────────────────

describe("persistIntervention timeout retry", () => {
  beforeEach(() => clearAll())

  it("retries once after a timeout error and succeeds", async () => {
    storeDecision("ses_r", makeDecision("warn", "ses_r"))
    const calls: Array<[string, string]> = []
    let n = 0
    await runTransformWithDeps(
      "ses_r",
      async (sessionID, text) => {
        calls.push([sessionID, text])
        n += 1
        return n === 1 ? timeoutResult() : okResult()
      },
      10,
    )
    await settle()
    expect(calls.length).toBe(2)
    expect(calls[0]?.[0]).toBe("ses_r")
    expect(calls[1]?.[0]).toBe("ses_r")
  })

  it("does NOT retry on non-timeout errors (terminal failure)", async () => {
    storeDecision("ses_c", makeDecision("warn", "ses_c"))
    const calls: string[] = []
    await runTransformWithDeps(
      "ses_c",
      async (sessionID) => {
        calls.push(sessionID)
        return clientErrorResult()
      },
      10,
    )
    await settle()
    expect(calls.length).toBe(1)
  })

  it("does NOT retry when the first attempt succeeds", async () => {
    storeDecision("ses_ok", makeDecision("warn", "ses_ok"))
    const calls: string[] = []
    await runTransformWithDeps(
      "ses_ok",
      async (sessionID) => {
        calls.push(sessionID)
        return okResult()
      },
      10,
    )
    await settle()
    expect(calls.length).toBe(1)
  })
})
