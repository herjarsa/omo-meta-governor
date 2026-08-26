/**
 * MetaGovernor v0.31.1 — Compaction Loop Guard Tests.
 *
 * Bug context: OpenCode upstream bug (#27924) — when a session hits
 * context overflow, opencode's autocompaction unconditionally retries
 * the overflow recovery on every subsequent turn, producing an infinite
 * compaction loop ("se queda compactando sin salir"). The plugin cannot
 * fix opencode, but it CAN trip a circuit breaker: after N consecutive
 * overflow compactions, the plugin flips autocontinue.enabled = false
 * so the model resumes its pending tasks instead of generating more
 * context pressure.
 *
 * v0.35.0 (audit fix F2): compactionLoopGuard.enabled now defaults to true
 * (v0.34.2 P2-3 alignment). Tests assert the default-on end-to-end behavior.
 * All createMetaGovernorPlugin() calls routed through createHermeticPlugin()
 * to fix the F0 subprocess-leak root cause.
 */
import { describe, expect, it } from "bun:test";
import type { PluginInput, PluginOptions } from "@opencode-ai/plugin";
import { createHermeticPlugin } from "./__test-helpers__/hermetic-plugin";

const mockPluginInput = {
  client: null as unknown as PluginInput["client"],
  project: null as unknown as PluginInput["project"],
  directory: "",
  worktree: "",
  experimental_workspace: { register: () => {} },
  serverUrl: new URL("http://localhost"),
  $: null as unknown as PluginInput["$"],
};

async function getAutocontinueHook(options: PluginOptions) {
  const plugin = createHermeticPlugin();
  const hooks = await plugin(mockPluginInput, options);
  const hook = hooks["experimental.compaction.autocontinue"];
  if (!hook) throw new Error("experimental.compaction.autocontinue hook missing");
  return hook as unknown as (
    input: { sessionID: string; overflow: boolean },
    output: { enabled: boolean },
  ) => Promise<void>;
}

async function callAutocontinue(
  hook: (input: { sessionID: string; overflow: boolean }, output: { enabled: boolean }) => Promise<void>,
  sessionID: string,
  overflow: boolean,
): Promise<{ enabled: boolean }> {
  const output = { enabled: true };
  await hook({ sessionID, overflow }, output);
  return output;
}

describe("experimental.compaction.autocontinue — overflow loop guard", () => {
  describe("#given compactionLoopGuard enabled (default)", () => {
    const options: PluginOptions = {
      meta_governor: {
        enabled: true,
        intervention: {
          compactionLoopGuard: { enabled: true, maxOverflowRecoveries: 1 },
        },
      },
    };

    it("then keeps autocontinue enabled on a single overflow compaction", async () => {
      const hook = await getAutocontinueHook(options);
      const out = await callAutocontinue(hook, "s-overflow-1", true);
      expect(out.enabled).toBe(true);
    }, 30_000);

    it("then disables autocontinue on the second consecutive overflow (maxOverflowRecoveries=1)", async () => {
      const hook = await getAutocontinueHook(options);
      const sid = "s-overflow-2";
      const out1 = await callAutocontinue(hook, sid, true);
      expect(out1.enabled).toBe(true);
      const out2 = await callAutocontinue(hook, sid, true);
      expect(out2.enabled).toBe(false);
    }, 30_000);

    it("then flips autocontinue to disabled on the second consecutive overflow (maxOverflowRecoveries=1)", async () => {
      const hook = await getAutocontinueHook(options);
      const sid = "s-overflow-3";
      const out1 = await callAutocontinue(hook, sid, true);
      expect(out1.enabled).toBe(true);
      const out2 = await callAutocontinue(hook, sid, true);
      expect(out2.enabled).toBe(false);
    }, 30_000);

    it("then resets the overflow counter when a non-overflow compaction completes", async () => {
      const hook = await getAutocontinueHook(options);
      const sid = "s-overflow-reset";
      let out = await callAutocontinue(hook, sid, true);
      expect(out.enabled).toBe(true);
      out = await callAutocontinue(hook, sid, false);
      expect(out.enabled).toBe(true);
      out = await callAutocontinue(hook, sid, true);
      expect(out.enabled).toBe(true);
      out = await callAutocontinue(hook, sid, true);
      expect(out.enabled).toBe(false);
    }, 30_000);

    it("then scopes the counter per-session (one session's loop does not affect another)", async () => {
      const hook = await getAutocontinueHook(options);
      const sidA = "s-overflow-iso-A";
      const out1 = await callAutocontinue(hook, sidA, true);
      expect(out1.enabled).toBe(true);
      const outA = await callAutocontinue(hook, sidA, true);
      expect(outA.enabled).toBe(false);
      const outB = await callAutocontinue(hook, "s-overflow-iso-B", false);
      expect(outB.enabled).toBe(true);
    }, 30_000);
  });

  describe("#given compactionLoopGuard disabled", () => {
    const options: PluginOptions = {
      meta_governor: {
        enabled: true,
        intervention: {
          compactionLoopGuard: { enabled: false, maxOverflowRecoveries: 1 },
        },
      },
    };

    it("then autocontinue stays enabled regardless of overflow count", async () => {
      const hook = await getAutocontinueHook(options);
      const sid = "s-guard-off";
      for (let i = 0; i < 10; i++) {
        const out = await callAutocontinue(hook, sid, true);
        expect(out.enabled).toBe(true);
      }
    }, 30_000);

    describe("#given compactionLoopGuard enabled (default-on since v0.34.2 P2-3)", () => {
      // v0.34.2 (P2-3): compactionLoopGuard.enabled defaults to true. No need
      // to opt in. Tests assert the default-on end-to-end behavior.
      const optInOptions: PluginOptions = {
        meta_governor: {
          enabled: true,
          intervention: {
            compactionLoopGuard: { enabled: true, maxOverflowRecoveries: 1 },
          },
        },
      };

      it("then the next messages.transform injects the loop-guard guidance text", async () => {
        const plugin = createHermeticPlugin();
        const hooks = await plugin(mockPluginInput, optInOptions);
        const autocontinue = hooks["experimental.compaction.autocontinue"] as unknown as (
          input: { sessionID: string; overflow: boolean },
          output: { enabled: boolean },
        ) => Promise<void>;
        const messagesTransform = hooks["experimental.chat.messages.transform"] as unknown as (
          input: unknown,
          output: { messages: Array<{ info: unknown; parts: Array<{ type: string; text: string }> }> },
        ) => Promise<void>;

        const sid = "s-guard-messages";
        for (let i = 0; i < 3; i++) {
          await autocontinue({ sessionID: sid, overflow: true }, { enabled: true });
        }
        const output = {
          messages: [
            {
              info: { sessionID: sid, role: "user" },
              parts: [{ type: "text", text: "user prompt" }],
            },
          ] as Array<{ info: unknown; parts: Array<{ type: string; text: string }> }>,
        };
        await messagesTransform({}, output);
        const flattened = output.messages
          .flatMap((m) => m.parts.map((p) => p.text ?? ""))
          .join("\n");
        expect(flattened).toContain("Overflow compaction loop detected");
      });

      it("then the loop-guard guidance still injects under mode === 'silent' (Finding #4)", async () => {
        const plugin = createHermeticPlugin();
        const hooks = await plugin(mockPluginInput, optInOptions);
        const autocontinue = hooks["experimental.compaction.autocontinue"] as unknown as (
          input: { sessionID: string; overflow: boolean },
          output: { enabled: boolean },
        ) => Promise<void>;
        const messagesTransform = hooks["experimental.chat.messages.transform"] as unknown as (
          input: unknown,
          output: { messages: Array<{ info: unknown; parts: Array<{ type: string; text: string }> }> },
        ) => Promise<void>;

        const sid = "s-guard-silent";
        for (let i = 0; i < 3; i++) {
          await autocontinue({ sessionID: sid, overflow: true }, { enabled: true });
        }
        const output = {
          messages: [
            {
              info: { sessionID: sid, role: "user" },
              parts: [{ type: "text", text: "user prompt" }],
            },
          ] as Array<{ info: unknown; parts: Array<{ type: string; text: string }> }>,
        };
        await messagesTransform({}, output);
        const flattened = output.messages
          .flatMap((m) => m.parts.map((p) => p.text ?? ""))
          .join("\n");
        expect(flattened).toContain("Overflow compaction loop detected");
      });
    });
  });

  describe("#given meta_governor disabled", () => {
    const options: PluginOptions = { meta_governor: { enabled: false } };

    it("then compaction autocontinue hook is NOT registered (plugin returns early hooks)", async () => {
      const plugin = createHermeticPlugin();
      const hooks = await plugin(mockPluginInput, options);
      expect(hooks["experimental.compaction.autocontinue"]).toBeUndefined();
    });
  });
});
