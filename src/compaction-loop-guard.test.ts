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
 * RED tests pin the desired behavior. They MUST FAIL until the fix lands.
 */
import { describe, expect, it, beforeEach } from "bun:test";
import type { PluginInput, PluginOptions } from "@opencode-ai/plugin";
import { createMetaGovernorPlugin } from "./plugin";

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
  const plugin = createMetaGovernorPlugin({
    graphSync: { enabled: false, autoInstall: false },
  });
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
  beforeEach(() => {
    // Each test uses unique sessionIDs so the per-session counter in
    // AuditState stays isolated across tests.
  });

  describe("#given compactionLoopGuard enabled (default)", () => {
    const options: PluginOptions = {
      meta_governor: {
        enabled: true,
        intervention: {
          compactionLoopGuard: { enabled: true, maxOverflowRecoveries: 2 },
        },
      },
    };

    it("then keeps autocontinue enabled on a single overflow compaction", async () => {
      const hook = await getAutocontinueHook(options);
      const out = await callAutocontinue(hook, "s-overflow-1", true);
      expect(out.enabled).toBe(true);
    }, 30_000);

    it("then keeps autocontinue enabled on the second consecutive overflow", async () => {
      const hook = await getAutocontinueHook(options);
      const sid = "s-overflow-2";
      for (let i = 0; i < 2; i++) {
        const out = await callAutocontinue(hook, sid, true);
        expect(out.enabled).toBe(true);
      }
    }, 30_000);

    it("then flips autocontinue to disabled on the third consecutive overflow (>=2 default)", async () => {
      const hook = await getAutocontinueHook(options);
      const sid = "s-overflow-3";
      // First two overflow compactions should still allow auto-continue
      for (let i = 0; i < 2; i++) {
        const out = await callAutocontinue(hook, sid, true);
        expect(out.enabled).toBe(true);
      }
      // Third overflow breaks the loop
      const out3 = await callAutocontinue(hook, sid, true);
      expect(out3.enabled).toBe(false);
    }, 30_000);

    it("then resets the overflow counter when a non-overflow compaction completes", async () => {
      const hook = await getAutocontinueHook(options);
      const sid = "s-overflow-reset";
      // First overflow
      let out = await callAutocontinue(hook, sid, true);
      expect(out.enabled).toBe(true);
      // Non-overflow compaction resets the counter
      out = await callAutocontinue(hook, sid, false);
      expect(out.enabled).toBe(true);
      // Now overflow again — counter restarts at 0
      out = await callAutocontinue(hook, sid, true);
      expect(out.enabled).toBe(true);
      // Still only 1 overflow since reset
      out = await callAutocontinue(hook, sid, true);
      expect(out.enabled).toBe(true);
    }, 30_000);

    it("then scopes the counter per-session (one session's loop does not affect another)", async () => {
      const hook = await getAutocontinueHook(options);
      const sidA = "s-overflow-iso-A";
      // Drive session A into the loop
      for (let i = 0; i < 2; i++) {
        const out = await callAutocontinue(hook, sidA, true);
      }
      const outA = await callAutocontinue(hook, sidA, true);
      expect(outA.enabled).toBe(false);
      // Session B is unaffected
      const outB = await callAutocontinue(hook, "s-overflow-iso-B", false);
      expect(outB.enabled).toBe(true);
    }, 30_000);
  });

  describe("#given compactionLoopGuard disabled", () => {
    const options: PluginOptions = {
      meta_governor: {
        enabled: true,
        intervention: {
          compactionLoopGuard: { enabled: false, maxOverflowRecoveries: 2 },
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

    describe("#given compactionLoopGuard enabled (opt-in default false → enable here)", () => {
      // Finding #7 (Oracle): verify the guidance message reaches the model
      // via the next experimental.chat.messages.transform call.
      const optInOptions: PluginOptions = {
        meta_governor: {
          enabled: true,
          intervention: {
            compactionLoopGuard: { enabled: true, maxOverflowRecoveries: 2 },
          },
        },
      };

      it("then the next messages.transform injects the loop-guard guidance text", async () => {
        const plugin = createMetaGovernorPlugin({
          graphSync: { enabled: false, autoInstall: false },
    }, 30_000);
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
        // Trip the guard
        for (let i = 0; i < 3; i++) {
          await autocontinue({ sessionID: sid, overflow: true }, { enabled: true });
        }
        // Now drive messages.transform: the guidance message must be
        // appended to output.messages, even though the guard may have
        // flipped interventionDisabled=true.
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
        // v0.31.1: the drain must run even when intervention.mode === 'silent',
        // which is the DEFAULT mode. This is the Finding #4 fix.
        const plugin = createMetaGovernorPlugin({
          graphSync: { enabled: false, autoInstall: false },
    }, 30_000);
        // optInOptions has no explicit mode -> defaults to 'silent'
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
      // When the plugin is disabled, no governance hooks are returned at
      // all — only the custom omo_* tools. This is intentional: an enabled
      // loop guard requires the plugin to be on. Operators who want the
      // loop guard without other features should leave enabled=true and
      // disable the specific subsystems.
      const plugin = createMetaGovernorPlugin({
        graphSync: { enabled: false, autoInstall: false },
    }, 30_000);
      const hooks = await plugin(mockPluginInput, options);
      expect(hooks["experimental.compaction.autocontinue"]).toBeUndefined();
    });
  });
});