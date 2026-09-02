/**
 * FASE 6 — Auditor Restoration: experimental.chat.system.transform with persistent
 * audit trail. Re-enables the system-prompt injection hook that v0.40.0 removed
 * under the false assumption that OpenCode 1.x never invokes it. Empirically verified
 * that the hook IS in the OpenCode 1.18.26 SDK types (`dist/index.d.ts:265`).
 *
 * TDD: tests must FAIL before fix, PASS after.
 */
import { describe, expect, it, beforeEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PluginInput, PluginOptions } from "@opencode-ai/plugin";
import { createMetaGovernorPlugin } from "./plugin";
import { clearAll } from "./decision-store";

const mockBaseInput = {
  client: null as unknown as PluginInput["client"],
  project: null as unknown as PluginInput["project"],
  worktree: "",
  experimental_workspace: { register: () => {} },
  serverUrl: new URL("http://localhost"),
  $: null as unknown as PluginInput["$"],
} as const;

function mockPluginInput(directory = ""): PluginInput {
  return { ...mockBaseInput, directory } as PluginInput;
}

async function makePlugin(dir: string, options: PluginOptions = {}) {
  return await createMetaGovernorPlugin(
    {
      graphSync: { enabled: false, autoInstall: false },
      cliAnything: { enabled: false },
    },
    {
      __test_runGraphSync: async () => ({
        attempted: false,
        codes: ["disabled"] as never,
        availability: { codegraph: false, graphify: false, codegraphIndexExists: false, graphifyIndexExists: false },
        alreadyInitialized: true,
      }),
      __test_runCliAnythingSync: async () => ({
        attempted: false,
        codes: ["cli-hub-version-probed"] as never,
        availability: { cliHub: false, cliHubVersion: null, metaSkill: false },
        alreadyInitialized: true,
      }),
      __test_startSkillsFsWatcher: async () => ({ stop: async () => {} }),
    },
  )(mockPluginInput(dir), options);
}

describe("FASE 6 experimental.chat.system.transform — persistent audit trail", () => {
  beforeEach(() => clearAll());

  it("1/4 the hook is registered as a function on the returned hooks", async () => {
    const dir = mkdtempSync(join(tmpdir(), "fase6-hook-"));
    writeFileSync(join(dir, "PLAN.md"), "# test");
    try {
      const plugin = await makePlugin(dir, {
        meta_governor: {
          enabled: true,
          protocolEnforcement: { enabled: true, auditToolCalls: true },
        },
      } as PluginOptions);
      const hook = plugin["experimental.chat.system.transform"];
      expect(typeof hook).toBe("function");
    } finally {
      try { rmSync(dir, { recursive: true, force: true }); } catch {}
    }
  });

  it("2/4 the hook appends accumulated protocol violations to output.system", async () => {
    const dir = mkdtempSync(join(tmpdir(), "fase6-violation-"));
    writeFileSync(join(dir, "PLAN.md"), "# test");
    try {
      const plugin = await makePlugin(dir, {
        meta_governor: {
          enabled: true,
          protocolEnforcement: { enabled: true, auditToolCalls: true },
        },
      } as PluginOptions);
      const sid = "fase6-violation-1";

      // Trigger tool.execute.before with a write that contains @ts-ignore + as any
      const before = plugin["tool.execute.before"] as unknown as (i: unknown, o: unknown) => Promise<void>;
      await before(
        { tool: "write", sessionID: sid, callID: "c1" },
        {
          args: {
            filePath: "/tmp/bad.ts",
            content: "// @ts-ignore\nconst x: any = 1 as any;",
          },
        },
      );

      // Now fire experimental.chat.system.transform — it should append the violation
      // to output.system (alongside the existing system messages).
      const systemTransform = plugin["experimental.chat.system.transform"] as unknown as (
        input: unknown,
        output: { system: string[] },
      ) => Promise<void>;
      const input = { sessionID: sid, model: { providerID: "test", modelID: "test" } };
      const output: { system: string[] } = { system: [] };
      await systemTransform(input, output);

      expect(output.system.length).toBeGreaterThan(0);
      // Find a line that mentions the violation
      const violationLine = output.system.find((line) =>
        line.includes("@ts-ignore") && line.includes("as any"),
      );
      expect(violationLine).toBeDefined();
      expect(violationLine).toContain("[omo-meta-governor audit]");
      expect(violationLine).toContain("no-type-suppression");
    } finally {
      try { rmSync(dir, { recursive: true, force: true }); } catch {}
    }
  });

  it("3/4 the hook preserves pre-existing system messages (does not clobber)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "fase6-preserve-"));
    writeFileSync(join(dir, "PLAN.md"), "# test");
    try {
      const plugin = await makePlugin(dir, {
        meta_governor: { enabled: true },
      } as PluginOptions);
      const systemTransform = plugin["experimental.chat.system.transform"] as unknown as (
        input: unknown,
        output: { system: string[] },
      ) => Promise<void>;
      const output: { system: string[] } = {
        system: ["EXISTING_SYSTEM_MESSAGE_1", "EXISTING_SYSTEM_MESSAGE_2"],
      };
      await systemTransform(
        { sessionID: "x", model: { providerID: "test", modelID: "test" } },
        output,
      );
      // The plugin must not REMOVE existing system messages.
      expect(output.system).toContain("EXISTING_SYSTEM_MESSAGE_1");
      expect(output.system).toContain("EXISTING_SYSTEM_MESSAGE_2");
    } finally {
      try { rmSync(dir, { recursive: true, force: true }); } catch {}
    }
  });

  it("4/4 the hook is a no-op when governance disabled and no audit data", async () => {
    const dir = mkdtempSync(join(tmpdir(), "fase6-empty-"));
    writeFileSync(join(dir, "PLAN.md"), "# test");
    try {
      const plugin = await makePlugin(dir, {
        meta_governor: { enabled: true },
      } as PluginOptions);
      const systemTransform = plugin["experimental.chat.system.transform"] as unknown as (
        input: unknown,
        output: { system: string[] },
      ) => Promise<void>;
      const output: { system: string[] } = { system: [] };
      await systemTransform(
        { sessionID: "empty", model: { providerID: "test", modelID: "test" } },
        output,
      );
      // No audit data, no violations queued → output.system should remain unchanged.
      expect(output.system).toEqual([]);
    } finally {
      try { rmSync(dir, { recursive: true, force: true }); } catch {}
    }
  });
});
