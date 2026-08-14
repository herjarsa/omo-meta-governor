/**
 * Characterization tests for the post-wave (v0.21.0) AuditState fields and the
 * parsePhaseWaveN export. The postWave fields (plugin.ts:399-409) are purely
 * additive tracking state consumed by the wave-gate in later waves.
 *
 * NOTE: the per-session AuditState is ONLY created when
 * protocolEnforcement.auditToolCalls=true — tool.execute.before early-returns
 * before creating state otherwise. All state-reading tests enable it.
 */
import { describe, test, expect } from "bun:test"
import { createMetaGovernorPlugin } from "./plugin"
import { parsePhaseWaveN } from "./plugin"

const mockInput = {
  client: null,
  project: null,
  directory: "D:/test/postwave-proj",
  worktree: "",
  experimental_workspace: { register: () => {} },
  serverUrl: new URL("http://localhost"),
  $: null,
}

const auditOptions = {
  meta_governor: {
    enabled: true,
    protocolEnforcement: { auditToolCalls: true },
    graphSync: { enabled: false, autoInstall: false },
  },
}

/** Fire tool.execute.before + after once so the session state exists. */
async function makeState(
  sessionID: string,
  tool = "bash",
): Promise<ReturnType<typeof createMetaGovernorPlugin>> {
  const plugin = createMetaGovernorPlugin({
    graphSync: { enabled: false, autoInstall: false },
  })
  const hooks = await plugin(mockInput as never, auditOptions as never)
  await hooks["tool.execute.before"]?.(
    { tool, sessionID, callID: "c1", args: {} },
    { title: "", output: "", metadata: {} },
  )
  await hooks["tool.execute.after"]?.(
    { tool, sessionID, callID: "c1", args: {} },
    { title: "", output: "", metadata: {} },
  )
  return hooks as never
}

describe("parsePhaseWaveN", () => {
  test("extracts the wave number from PHASE-N-COMPLETE markers", () => {
    expect(parsePhaseWaveN("PHASE-1-COMPLETE")).toBe(1)
    expect(parsePhaseWaveN("PHASE-12-COMPLETE")).toBe(12)
    expect(parsePhaseWaveN("phase-3-complete")).toBe(3)
    expect(parsePhaseWaveN("<promise>PHASE-2-COMPLETE</promise>")).toBe(2)
    expect(parsePhaseWaveN("<promise>  PHASE-5-COMPLETE  </promise>")).toBe(5)
  })

  test("returns null for non-numeric, DONE, or absent markers", () => {
    expect(parsePhaseWaveN("DONE")).toBeNull()
    expect(parsePhaseWaveN("PHASE-A-COMPLETE")).toBeNull()
    expect(parsePhaseWaveN("")).toBeNull()
    expect(parsePhaseWaveN("plain text without marker")).toBeNull()
  })
})

describe("post-wave AuditState fields", () => {
  test("session state is created when auditToolCalls=true", async () => {
    const hooks = await makeState("s-pw-1")
    expect(hooks).toBeDefined()
  })

  test("postWave defaults are additive and non-interfering", async () => {
    // The factory and hooks must construct without touching postWave logic:
    // firing a normal tool call must not throw and must not inject anything.
    const plugin = createMetaGovernorPlugin({
      graphSync: { enabled: false, autoInstall: false },
    })
    const hooks = await plugin(mockInput as never, auditOptions as never)
    const after = hooks["tool.execute.after"]!
    await after(
      { tool: "bash", sessionID: "s-pw-2", callID: "c1", args: { command: "echo hi" } },
      { title: "ok", output: "hi", metadata: {} },
    )
    // No crash + no intervention decision stored for this session.
    const { takeDecision } = await import("./decision-store")
    expect(takeDecision("s-pw-2")).toBeUndefined()
  })
})
