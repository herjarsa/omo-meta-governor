/**
 * V2 bridge tests (v0.50.0) — hermetic fake V2 context asserting every V1
 * hook gets a V2 registration and the event adapters forward correctly.
 */
import { describe, expect, it } from "bun:test";
import { bridgeHooks } from "./v2/hook-bridge";

type Rec = { domain: string; name: string; cb: (e: any) => unknown };

function fakeCtx() {
  const recs: Rec[] = [];
  const transforms: Array<{ domain: string; cb: (e: any) => void }> = [];
  const reg = () => ({ dispose: async () => {} });
  const ctx: any = {
    tool: {
      hook: async (name: string, cb: (e: any) => unknown) => {
        recs.push({ domain: "tool", name, cb });
        return reg();
      },
      transform: async (cb: (e: any) => void) => {
        transforms.push({ domain: "tool", cb });
        return reg();
      },
    },
    session: {
      hook: async (name: string, cb: (e: any) => unknown) => {
        recs.push({ domain: "session", name, cb });
        return reg();
      },
    },
    permission: {
      hook: async (name: string, cb: (e: any) => unknown) => {
        recs.push({ domain: "permission", name, cb });
        return reg();
      },
    },
    event: { subscribe: async () => ({}) },
  };
  return { ctx, recs, transforms };
}

function find(recs: Rec[], domain: string, name: string) {
  return recs.find((r) => r.domain === domain && r.name === name)?.cb;
}

describe("v2 hook bridge", () => {
  it("1/4 registers every bridgeable V1 hook onto V2", async () => {
    const { ctx, recs, transforms } = fakeCtx();
    const calls: string[] = [];
    const v1: any = {
      "tool.execute.before": async () => { calls.push("before"); },
      "tool.execute.after": async () => { calls.push("after"); },
      "experimental.chat.system.transform": async () => { calls.push("sys"); },
      "experimental.chat.messages.transform": async () => { calls.push("msg"); },
      "experimental.session.compacting": async () => { calls.push("compact"); },
      "permission.ask": async () => { calls.push("perm"); },
      "tool.definition": async () => { calls.push("tooldef"); },
      "command.execute.before": async () => { calls.push("cmd"); },
      "experimental.provider.small_model": async () => { calls.push("small"); },
      "experimental.compaction.autocontinue": async () => { calls.push("auto"); },
      event: async () => { calls.push("event"); },
    };
    const regs = await bridgeHooks(ctx, v1);
    expect(find(recs, "tool", "execute.before")).toBeDefined();
    expect(find(recs, "tool", "execute.after")).toBeDefined();
    expect(find(recs, "session", "context")).toBeDefined();
    expect(find(recs, "session", "compaction")).toBeDefined();
    expect(find(recs, "permission", "evaluate")).toBeDefined();
    expect(transforms.length).toBe(1);
    expect(regs.length).toBeGreaterThanOrEqual(5);
  });

  it("2/4 before-hook rethrows to block; live args view writes back", async () => {
    const { ctx, recs } = fakeCtx();
    const v1: any = {
      "tool.execute.before": async (input: any, output: any) => {
        if (input.tool === "write") throw new Error("blocked");
        output.args = { patched: true };
      },
    };
    await bridgeHooks(ctx, v1);
    const cb = find(recs, "tool", "execute.before")!;
    const e: any = { tool: "read", sessionID: "s", id: "c1", input: { x: 1 } };
    await cb(e);
    expect(e.input).toEqual({ patched: true });
    await expect(cb({ tool: "write", sessionID: "s", id: "c2", input: {} })).rejects.toThrow("blocked");
  });

  it("3/4 context hook wraps system strings as SystemPart objects", async () => {
    const { ctx, recs } = fakeCtx();
    const v1: any = {
      "experimental.chat.system.transform": async (_i: any, o: any) => {
        o.system.push("hello-governor");
      },
      "experimental.chat.messages.transform": async () => {},
    };
    await bridgeHooks(ctx, v1);
    const cb = find(recs, "session", "context")!;
    const e: any = { sessionID: "s", model: {}, system: [], messages: [], options: {}, agent: "a", tools: {} };
    await cb(e);
    expect(e.system).toEqual([{ type: "text", text: "hello-governor" }]);
  });

  it("4/4 after-hook forwards result and never throws", async () => {
    const { ctx, recs } = fakeCtx();
    let seen: any = null;
    const v1: any = {
      "tool.execute.after": async (input: any, output: any) => {
        seen = { input, output };
        throw new Error("must be swallowed");
      },
    };
    await bridgeHooks(ctx, v1);
    const cb = find(recs, "tool", "execute.after")!;
    await cb({ tool: "read", sessionID: "s", agent: "a", messageID: "m", id: "c", input: {}, status: "completed", result: "ok-text" });
    expect(seen.input.tool).toBe("read");
    expect(seen.output.output).toBe("ok-text");
  });

  it("5/6 messages view carries sessionID so the V1 hook fires (B2)", async () => {
    const { ctx, recs } = fakeCtx();
    let seenSid: unknown = "NOT-CALLED";
    const v1: any = {
      // Mimics plugin.ts derivation: lastMsg?.info?.sessionID.
      "experimental.chat.messages.transform": async (_i: any, o: any) => {
        const last = o.messages[o.messages.length - 1];
        seenSid = last?.info?.sessionID;
      },
    };
    await bridgeHooks(ctx, v1);
    const cb = find(recs, "session", "context")!;
    const e: any = {
      sessionID: "sess-9", model: {},
      system: [], messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
      options: {}, agent: "a", tools: {},
    };
    await cb(e);
    expect(seenSid).toBe("sess-9");
  });

  it("6/6 appended V1 synthetic messages become V2 assistant messages", async () => {
    const { ctx, recs } = fakeCtx();
    const v1: any = {
      "experimental.chat.messages.transform": async (_i: any, o: any) => {
        o.messages.push({ info: { role: "assistant" }, parts: [{ type: "text", text: "nudge" }] });
      },
    };
    await bridgeHooks(ctx, v1);
    const cb = find(recs, "session", "context")!;
    const e: any = {
      sessionID: "s", model: {},
      system: [], messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
      options: {}, agent: "a", tools: {},
    };
    await cb(e);
    expect(e.messages.length).toBe(2);
    expect(e.messages[1]).toEqual({ role: "assistant", content: [{ type: "text", text: "nudge" }] });
  });
});
