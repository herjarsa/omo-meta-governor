/**
 * Skill priming (v0.20.0) — RED→GREEN tests.
 *
 * Feature: the plugin injects ONE synthetic user message at session start
 * (trigger "sessionStart") or once implementation work begins (trigger
 * "firstImplement") that nudges the agent to select precise skills for the
 * task — querying the AAS skill catalog (aas search_skills / get_skill /
 * compose_stack) and/or loading the task-appropriate superpowers skill —
 * before writing code.
 *
 * Config-gated (skillPriming.enabled), once per session, minimal context
 * cost: the directive explicitly forbids enumerating the full catalog
 * (past token-bloat incident, memory #1084).
 */
import { describe, expect, it, beforeEach } from "bun:test"
import type { PluginInput, PluginOptions } from "@opencode-ai/plugin"
import type { MetaGovernorPluginConfig } from "./config"
import { createMetaGovernorPlugin } from "./plugin"
import { buildSkillPrimingMessage, shouldInjectSkillPriming } from "./skill-priming"
import { clearAll } from "./decision-store"

// ─── Mocks ─────────────────────────────────────────────────────────

const mockPluginInput = {
  client: null as unknown as PluginInput["client"],
  project: null as unknown as PluginInput["project"],
  directory: "",
  worktree: "",
  experimental_workspace: { register: () => {} },
  serverUrl: new URL("http://localhost"),
  $: null as unknown as PluginInput["$"],
}

// Hermetic backends so tool.execute.after's orchestrator run is instant
// and has zero filesystem/network side effects.
const stubBackends = {
  agentmemory: { smartSearch: async () => ({ lessons: [], crystals: [] }) },
  magicContext: { slotList: async () => [] },
  boulderState: { boulderRead: async () => [] },
}
const stubWrite = {
  saveMemory: async () => ({ id: "x" }),
  saveLesson: async () => ({ id: "x" }),
}

type SkillPrimingOpts = NonNullable<MetaGovernorPluginConfig["skillPriming"]>

function makeOptions(skillPriming: SkillPrimingOpts): PluginOptions {
  return {
    meta_governor: {
      enabled: true,
      // Silent mode isolates the priming injection: the intervention-mode
      // gate suppresses every other message injection (plan reminder,
      // violations, decisions), so message counts stay deterministic.
      intervention: { mode: "silent" },
      skillPriming,
    },
  }
}

async function makeTransform(skillPriming: SkillPrimingOpts) {
  const plugin = createMetaGovernorPlugin(
    { graphSync: { enabled: false, autoInstall: false } },
    { backends: stubBackends as never, writeBackend: stubWrite as never },
  )
  const hooks = await plugin(mockPluginInput, makeOptions(skillPriming))
  return hooks["experimental.chat.messages.transform"]!
}

function transformOutput(sessionID = "s1") {
  return {
    messages: [
      { info: { role: "user", sessionID }, parts: [{ type: "text", text: "hi" }] },
    ] as Array<{ info: unknown; parts: unknown[] }>,
  }
}

function allText(output: { messages: Array<{ info: unknown; parts: unknown[] }> }): string {
  return output.messages
    .map((m) => (m.parts[0] as Record<string, unknown> | undefined)?.text as string ?? "")
    .join("\n")
}

// ─── Pure: buildSkillPrimingMessage ───────────────────────────────

describe("buildSkillPrimingMessage", () => {
  it("router aas → catalog instructions, no superpowers wording", () => {
    const msg = buildSkillPrimingMessage("aas")
    expect(msg).toContain("[SKILL PRIMING]")
    expect(msg).toContain("aas search_skills")
    expect(msg).toContain("aas get_skill")
    expect(msg).toContain("aas compose_stack")
    expect(msg).toContain("Do NOT enumerate the full catalog")
    expect(msg).not.toContain("superpowers")
  })

  it("router superpowers → superpowers skill names, no catalog wording", () => {
    const msg = buildSkillPrimingMessage("superpowers")
    expect(msg).toContain("superpowers")
    expect(msg).toContain("test-driven-development")
    expect(msg).toContain("Do NOT enumerate the full catalog")
    expect(msg).not.toContain("aas search_skills")
  })

  it("router both → catalog + superpowers + skip guidance", () => {
    const msg = buildSkillPrimingMessage("both")
    expect(msg).toContain("aas search_skills")
    expect(msg).toContain("superpowers")
    expect(msg).toContain("skip the catalog")
    expect(msg).toContain("Do NOT enumerate the full catalog")
  })
})

// ─── Pure: shouldInjectSkillPriming ────────────────────────────────

describe("shouldInjectSkillPriming", () => {
  it("sessionStart → always true", () => {
    expect(shouldInjectSkillPriming({ trigger: "sessionStart", recentToolCalls: [] })).toBe(true)
    expect(shouldInjectSkillPriming({ trigger: "sessionStart", recentToolCalls: ["grep"] })).toBe(true)
  })

  it("firstImplement → false with no implementation tools", () => {
    expect(shouldInjectSkillPriming({ trigger: "firstImplement", recentToolCalls: [] })).toBe(false)
    expect(
      shouldInjectSkillPriming({ trigger: "firstImplement", recentToolCalls: ["grep", "bash", "read"] }),
    ).toBe(false)
  })

  it("firstImplement → true when an implementation tool was called", () => {
    expect(shouldInjectSkillPriming({ trigger: "firstImplement", recentToolCalls: ["edit"] })).toBe(true)
    expect(
      shouldInjectSkillPriming({ trigger: "firstImplement", recentToolCalls: ["grep", "desktop-commander_write_file"] }),
    ).toBe(true)
    expect(shouldInjectSkillPriming({ trigger: "firstImplement", recentToolCalls: ["apply_patch"] })).toBe(true)
  })

  it("firstImplement → true via implementationToolSeen even with empty recentToolCalls", () => {
    expect(
      shouldInjectSkillPriming({ trigger: "firstImplement", recentToolCalls: [], implementationToolSeen: true }),
    ).toBe(true)
  })
})

// ─── Plugin-level: messages.transform injection ────────────────────

describe("experimental.chat.messages.transform — skill priming", () => {
  beforeEach(() => {
    clearAll()
  })

  it("disabled → no priming message injected", async () => {
    const transform = await makeTransform({ enabled: false, trigger: "sessionStart", router: "both" })
    const output = transformOutput()
    await transform({}, output)
    expect(output.messages.length).toBe(1)
    expect(allText(output)).not.toContain("[SKILL PRIMING]")
  })

  it("sessionStart → injects once, then never again for the session", async () => {
    const transform = await makeTransform({ enabled: true, trigger: "sessionStart", router: "both" })
    const output = transformOutput()
    await transform({}, output)

    expect(output.messages.length).toBe(2)
    const msg = output.messages[1]!
    expect((msg.info as Record<string, unknown>).role).toBe("user")
    expect((msg.info as Record<string, unknown>).agent).toBe("meta-governor")
    const part = msg.parts[0] as Record<string, unknown>
    expect(part.type).toBe("text")
    expect(part.text).toContain("[SKILL PRIMING]")
    expect(part.text).toContain("aas search_skills")
    expect(part.synthetic).toBe(true)

    // Second transform call for the same session: no new injection.
    const output2 = transformOutput()
    await transform({}, output2)
    expect(output2.messages.length).toBe(1)
  })

  it("firstImplement → no injection before implementation, fires after a write tool", async () => {
    const plugin = createMetaGovernorPlugin(
      { graphSync: { enabled: false, autoInstall: false } },
      { backends: stubBackends as never, writeBackend: stubWrite as never },
    )
    const hooks = await plugin(mockPluginInput, makeOptions({ enabled: true, trigger: "firstImplement", router: "both" }))
    const transform = hooks["experimental.chat.messages.transform"]!
    const after = hooks["tool.execute.after"]!

    // No state yet → no priming.
    const output = transformOutput("s2")
    await transform({}, output)
    expect(allText(output)).not.toContain("[SKILL PRIMING]")

    // First write tool call → recentToolCalls gains "write".
    await after(
      { tool: "write", sessionID: "s2", callID: "c1", args: { filePath: "/tmp/x.ts" } },
      { title: "", output: "wrote", metadata: {} },
    )

    // Next transform call → priming fires.
    const output2 = transformOutput("s2")
    await transform({}, output2)
    expect(allText(output2)).toContain("[SKILL PRIMING]")
  })

  it("router aas → catalog wording only; router superpowers → superpowers wording only", async () => {
    const t1 = await makeTransform({ enabled: true, trigger: "sessionStart", router: "aas" })
    const o1 = transformOutput("s3")
    await t1({}, o1)
    const text1 = allText(o1)
    expect(text1).toContain("aas search_skills")
    expect(text1).not.toContain("superpowers")

    const t2 = await makeTransform({ enabled: true, trigger: "sessionStart", router: "superpowers" })
    const o2 = transformOutput("s4")
    await t2({}, o2)
    const text2 = allText(o2)
    expect(text2).toContain("superpowers")
    expect(text2).not.toContain("aas search_skills")
  })
})
