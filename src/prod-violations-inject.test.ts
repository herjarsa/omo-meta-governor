/**
 * v0.36.0 (audit P0-1) — violations must be observable in PROD.
 *
 * Bug: experimental.chat.messages.transform gated the violation-injection
 * branch on `isTestRun = Boolean(deps.__test_persistSessionMessage)`. In prod
 * that dep is undefined, so `isTestRun === false` and the entire block
 * (2177-2208 in v0.35.9) was skipped — `pendingViolations` accumulated, hit
 * TTL, expired silently. The protocol appeared to be a no-op for end users.
 *
 * Fix: split the guard so `persistIntervention` (log-only TUI surface) and
 * the `output.messages.push({ role: "assistant" })` injection always run for
 * a non-empty `pendingViolations`, regardless of `__test_persistSessionMessage`.
 * The `role: "user"` push stays gated by isTestRun (session-killer avoidance).
 */
import { describe, expect, it, beforeEach } from "bun:test"
import type { PluginInput, PluginOptions } from "@opencode-ai/plugin"
import { createMetaGovernorPlugin, type MetaGovernorPluginDeps } from "./plugin"
import { clearAll } from "./decision-store"

const mockPluginInput = {
  client: null as unknown as PluginInput["client"],
  project: null as unknown as PluginInput["project"],
  directory: "",
  worktree: "",
  experimental_workspace: { register: () => {} },
  serverUrl: new URL("http://localhost"),
  $: null as unknown as PluginInput["$"],
}

const PROD_OPTIONS: PluginOptions = {
  meta_governor: {
    enabled: true,
    protocolEnforcement: { enabled: true, auditToolCalls: true },
    intervention: { mode: "message", minActionForMessage: "warn" },
    skillPriming: { enabled: false, trigger: "sessionStart", router: "registry", enforceMode: "directive" },
  },
}

const HERMETIC_DEPS: MetaGovernorPluginDeps = {
  __test_runGraphSync: async () => ({
    attempted: false,
    codes: ["disabled"],
    availability: {
      codegraph: false,
      graphify: false,
      codegraphIndexExists: false,
      graphifyIndexExists: false,
    },
    alreadyInitialized: true,
  }),
  __test_runCliAnythingSync: async () => ({
    attempted: false,
    codes: ["cli-hub-version-probed"],
    availability: { cliHub: false, cliHubVersion: null, metaSkill: false },
    alreadyInitialized: true,
  }),
  __test_persistRetryDelayMs: 0,
  // NOTE: __test_persistSessionMessage is intentionally undefined to simulate prod.
}

describe("P0-1 violations inject in PROD (no __test_persistSessionMessage)", () => {
  beforeEach(() => clearAll())

  it("then a type-suppression violation is surfaced as assistant message", async () => {
    const plugin = createMetaGovernorPlugin(
      { graphSync: { enabled: false, autoInstall: false } },
      HERMETIC_DEPS,
    )
    const hooks = await plugin(mockPluginInput, PROD_OPTIONS)
    const before = hooks["tool.execute.before"]!
    const transform = hooks["experimental.chat.messages.transform"]!

    await before(
      { tool: "write", sessionID: "ses-prod-1", callID: "call-1" },
      { args: { filePath: "/tmp/bad.ts", content: "// @ts-ignore\nconst x: any = 1 as any;" } },
    )

    const output = {
      messages: [
        { info: { role: "user", sessionID: "ses-prod-1" }, parts: [{ type: "text", text: "ok" }] },
      ] as Array<{ info: unknown; parts: unknown[] }>,
    }
    await transform({}, output)

    const allText = output.messages
      .map((m) => (m.parts[0] as Record<string, unknown> | undefined)?.text as string ?? "")
      .join("\n")
    // The violation text MUST appear in messages even without __test_persistSessionMessage.
    expect(allText).toContain("PROTOCOL VIOLATIONS")
    expect(allText).toContain("no-type-suppression")
  })

  it("then the injection role is assistant (non-blocking), not user", async () => {
    const plugin = createMetaGovernorPlugin(
      { graphSync: { enabled: false, autoInstall: false } },
      HERMETIC_DEPS,
    )
    const hooks = await plugin(mockPluginInput, PROD_OPTIONS)
    const before = hooks["tool.execute.before"]!
    const transform = hooks["experimental.chat.messages.transform"]!

    await before(
      { tool: "write", sessionID: "ses-prod-2", callID: "call-2" },
      { args: { filePath: "/tmp/empty.ts", content: "try { throw 1 } catch(e) {}" } },
    )

    const output = {
      messages: [
        { info: { role: "user", sessionID: "ses-prod-2" }, parts: [{ type: "text", text: "ok" }] },
      ] as Array<{ info: unknown; parts: unknown[] }>,
    }
    await transform({}, output)

    const violationMsg = output.messages.find((m) => {
      const text = (m.parts[0] as Record<string, unknown> | undefined)?.text as string ?? ""
      return text.includes("PROTOCOL VIOLATIONS")
    })
    expect(violationMsg).toBeDefined()
    // role:"user" is the session-killer banner; in prod we MUST use assistant.
    expect((violationMsg!.info as { role: string }).role).toBe("assistant")
  })
})
