/**
 * DONE-gate memory nudge (v0.51.x).
 *
 * DONE is the only moment with full context of what was done; without a nudge
 * almost no session leaves useful memory. Fires once per session when DONE
 * arrives with no memory saved.
 */
import { describe, expect, it, beforeEach } from "bun:test";
import type { PluginInput, PluginOptions } from "@opencode-ai/plugin";
import { createHermeticPlugin } from "./__test-helpers__/hermetic-plugin";
import { clearAll } from "./decision-store";
import { buildMemoryNudgeUserStatus } from "./plugin";

const mockBaseInput = {
  client: null as unknown as PluginInput["client"],
  project: null as unknown as PluginInput["project"],
  worktree: "",
  experimental_workspace: { register: () => {} },
  serverUrl: new URL("http://localhost"),
  $: null as unknown as PluginInput["$"],
} as const;

function mockPluginInput(directory = ""): PluginInput {
  return { ...mockBaseInput, directory } as unknown as PluginInput;
}
function midSessionOutput(sid: string) {
  return {
    messages: [
      { info: { role: "user", sessionID: sid }, parts: [{ type: "text", text: "first ask" }] },
      { info: { role: "assistant", sessionID: sid, agent: "build" }, parts: [{ type: "text", text: "first reply" }] },
      { info: { role: "user", sessionID: sid }, parts: [{ type: "text", text: "hi" }] },
    ] as Array<{ info: unknown; parts: unknown[] }>,
  };
}

const DONE_MARKER = "<promise>DONE</promise>";

function baseOptions(): PluginOptions {
  return {
    meta_governor: {
      enabled: true,
      skillPriming: { enabled: false },
      protocolEnforcement: { enabled: true, auditToolCalls: true },
      intervention: { mode: "message", minActionForMessage: "warn" },
      // Pin workflowGates off inline: only options.meta_governor beats the real
      // dev file config (~/.config/opencode/omo-meta-governor.jsonc), so without
      // this the requirePlan gate throws and breaks these hermetic tests.
      workflowGates: { enabled: false, requirePlan: false },
    },
  } as unknown as PluginOptions;
}
type AfterFn = (i: unknown, o: unknown) => Promise<void>;
type TransformFn = (i: unknown, o: unknown) => Promise<void>;

async function makeHooks(persisted: string[], extraDeps: Record<string, unknown> = {}) {
  const plugin = createHermeticPlugin({}, {
    __test_isMainSession: () => true,
    __test_persistSessionMessage: async (_sid: string, text: string) => {
      persisted.push(text);
      return { ok: true, messageID: null, error: null, durationMs: 0 };
    },
    ...extraDeps,
  });
  return plugin(mockPluginInput(""), baseOptions());
}

async function fireAfter(hooks: Record<string, AfterFn>, tool: string, sid: string, output: string): Promise<void> {
  await hooks["tool.execute.before"]?.(
    { tool, sessionID: sid, callID: "c1", args: {} },
    { title: "", output: "", metadata: {} },
  );
  await hooks["tool.execute.after"]?.(
    { tool, sessionID: sid, callID: "c1", args: {} },
    { title: "", output, metadata: {} },
  );
}

function agentTexts(output: { messages: Array<{ info: unknown; parts: unknown[] }> }): string[] {
  return output.messages.map((m) => {
    const p = m.parts[0] as { text?: string } | undefined;
    return typeof p?.text === "string" ? p.text : "";
  });
}

beforeEach(() => clearAll());
describe("DONE-gate memory nudge", () => {
  it("(a) DONE sin omo_remember -> agente recibe 1 nudge con omo_remember y template", { timeout: 30000 }, async () => {
    const persisted: string[] = [];
    const sid = "ses_q_mem_nudge_a";
    const hooks = await makeHooks(persisted) as unknown as Record<string, AfterFn & TransformFn>;
    await fireAfter(hooks as Record<string, AfterFn>, "write", sid, `${DONE_MARKER} finished`);
    const out = midSessionOutput(sid);
    const before = out.messages.length;
    await (hooks["experimental.chat.messages.transform"] as TransformFn)({}, out);
    const pushed = out.messages.slice(before);
    expect(pushed.length).toBe(1);
    const info = pushed[0]?.info as Record<string, unknown>;
    expect(info.role).toBe("assistant");
    const text = agentTexts({ messages: pushed })[0] ?? "";
    expect(text).toContain("omo_remember");
    expect(text).toContain("Mistake:");
    expect(text).toContain("What to do:");
    expect(text).toContain("Where:");
    expect(text).toContain("DO NOT TREAT AS TASK");
  });

  it("(b) segundo DONE no repite", { timeout: 30000 }, async () => {
    const persisted: string[] = [];
    const sid = "ses_q_mem_nudge_b";
    const hooks = await makeHooks(persisted) as unknown as Record<string, AfterFn & TransformFn>;
    await fireAfter(hooks as Record<string, AfterFn>, "write", sid, `${DONE_MARKER} finished`);
    const out1 = midSessionOutput(sid);
    await (hooks["experimental.chat.messages.transform"] as TransformFn)({}, out1);
    expect(out1.messages.length).toBe(4);
    await fireAfter(hooks as Record<string, AfterFn>, "write", sid, `${DONE_MARKER} again`);
    const out2 = midSessionOutput(sid);
    await (hooks["experimental.chat.messages.transform"] as TransformFn)({}, out2);
    expect(out2.messages.length).toBe(3);
  });
  it("(c) DONE tras omo_remember no hay nudge", { timeout: 30000 }, async () => {
    const persisted: string[] = [];
    const sid = "ses_q_mem_nudge_c";
    const hooks = await makeHooks(persisted) as unknown as Record<string, AfterFn & TransformFn>;
    await fireAfter(hooks as Record<string, AfterFn>, "omo_remember", sid, "saved");
    await fireAfter(hooks as Record<string, AfterFn>, "write", sid, `${DONE_MARKER} finished`);
    const out = midSessionOutput(sid);
    await (hooks["experimental.chat.messages.transform"] as TransformFn)({}, out);
    expect(out.messages.length).toBe(3);
  });

  it("(d) texto usuario < 200 chars y NO contiene omo_remember", { timeout: 30000 }, async () => {
    const text = buildMemoryNudgeUserStatus();
    expect(text.length).toBeLessThan(200);
    expect(text).not.toContain("omo_remember");
    const persisted: string[] = [];
    const sid = "ses_q_mem_nudge_d";
    const hooks = await makeHooks(persisted) as unknown as Record<string, AfterFn & TransformFn>;
    await fireAfter(hooks as Record<string, AfterFn>, "write", sid, `${DONE_MARKER} finished`);
    const userText = persisted.find((t) => t.includes("memoria") || t.includes("memory")) ?? persisted[0] ?? "";
    expect(userText.length).toBeGreaterThan(0);
    expect(userText.length).toBeLessThan(200);
    expect(userText).not.toContain("omo_remember");
  });

  it("(e) DONE en subagente (isMainSession=false) -> NO hay nudge de agente ni persist", { timeout: 30000 }, async () => {
    const persisted: string[] = [];
    const sid = "ses_q_mem_nudge_e_sub";
    const hooks = await makeHooks(persisted, { __test_isMainSession: () => false }) as unknown as Record<string, AfterFn & TransformFn>;
    await fireAfter(hooks as Record<string, AfterFn>, "write", sid, `${DONE_MARKER} finished`);
    const out = midSessionOutput(sid);
    await (hooks["experimental.chat.messages.transform"] as TransformFn)({}, out);
    expect(out.messages.length).toBe(3);
    expect(persisted.length).toBe(0);
  });

  it("(f-bg) DONE con backgroundTaskInFlight -> NO hay nudge", { timeout: 30000 }, async () => {
    const persisted: string[] = [];
    const sid = "ses_q_mem_nudge_f_bg";
    const hooks = await makeHooks(persisted) as unknown as Record<string, AfterFn & TransformFn>;
    const before = hooks["tool.execute.before"] as unknown as AfterFn;
    const after = hooks["tool.execute.after"] as unknown as AfterFn;
    await before({ tool: "task", sessionID: sid, callID: "c-bg", args: { subagent_type: "explore", run_in_background: true } }, { title: "", output: "", metadata: {} });
    await after({ tool: "task", sessionID: sid, callID: "c-bg", args: { subagent_type: "explore", run_in_background: true } }, { title: "", output: "started background", metadata: {} });
    await fireAfter(hooks as Record<string, AfterFn>, "write", sid, `${DONE_MARKER} finished`);
    const out = midSessionOutput(sid);
    await (hooks["experimental.chat.messages.transform"] as TransformFn)({}, out);
    expect(out.messages.length).toBe(3);
  });

  it("(f-oracle) DONE con oracleInFlight -> NO hay nudge", { timeout: 30000 }, async () => {
    const persisted: string[] = [];
    const sid = "ses_q_mem_nudge_f_or";
    const hooks = await makeHooks(persisted) as unknown as Record<string, AfterFn & TransformFn>;
    const before = hooks["tool.execute.before"] as unknown as AfterFn;
    const after = hooks["tool.execute.after"] as unknown as AfterFn;
    await before({ tool: "task", sessionID: sid, callID: "c-or", args: { subagent_type: "oracle", run_in_background: true } }, { title: "", output: "", metadata: {} });
    await after({ tool: "task", sessionID: sid, callID: "c-or", args: { subagent_type: "oracle", run_in_background: true } }, { title: "", output: "oracle started", metadata: {} });
    await fireAfter(hooks as Record<string, AfterFn>, "write", sid, `${DONE_MARKER} finished`);
    const out = midSessionOutput(sid);
    await (hooks["experimental.chat.messages.transform"] as TransformFn)({}, out);
    expect(out.messages.length).toBe(3);
  });

  it("(g) drain en subagente tras encolar en principal -> NO drena (defensa)", { timeout: 30000 }, async () => {
    const persisted: string[] = [];
    const sid = "ses_q_mem_nudge_g_drain";
    let isMain = true;
    const plugin = createHermeticPlugin({}, {
      __test_isMainSession: () => isMain,
      __test_persistSessionMessage: async (_sid: string, text: string) => {
        persisted.push(text);
        return { ok: true, messageID: null, error: null, durationMs: 0 };
      },
    });
    const hooks = await plugin(mockPluginInput(""), baseOptions()) as unknown as Record<string, AfterFn & TransformFn>;
    await fireAfter(hooks as Record<string, AfterFn>, "write", sid, `${DONE_MARKER} finished`);
    isMain = false;
    const out = midSessionOutput(sid);
    await (hooks["experimental.chat.messages.transform"] as TransformFn)({}, out);
    expect(out.messages.length).toBe(3);
  });
});
