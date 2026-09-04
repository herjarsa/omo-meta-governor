/**
 * FASE 8 — Proactive session-start directives.
 *
 * At session start, the plugin injects a directive block into the agent's
 * system prompt via `experimental.chat.system.transform` that:
 *  1. Tells the LLM to query `omo_recall` BEFORE starting any task
 *  2. Lists the available chore skills and tells the LLM to use the
 *     `using-superpowers` / `find-skills` flow to pick the right one
 */
import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PluginInput, PluginOptions } from "@opencode-ai/plugin";
import { createMetaGovernorPlugin } from "./plugin";

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

describe("FASE 8 session-start directives", () => {
  it("1/3 system.transform injects an auto-recall directive at session start", async () => {
    const dir = mkdtempSync(join(tmpdir(), "fase8-recall-"));
    writeFileSync(join(dir, "PLAN.md"), "# test");
    try {
      const sid = "fase8-recall-1";
      const plugin = await makePlugin(dir, {
        meta_governor: { enabled: true },
      } as PluginOptions);
      const before = plugin["tool.execute.before"] as unknown as (i: unknown, o: unknown) => Promise<void>;
      await before(
        { tool: "read", sessionID: sid, callID: "c1" },
        { args: {} },
      );
      const systemTransform = plugin["experimental.chat.system.transform"] as unknown as (
        input: unknown,
        output: { system: string[] },
      ) => Promise<void>;
      const output: { system: string[] } = { system: [] };
      await systemTransform(
        { sessionID: sid, model: { providerID: "test", modelID: "test" } },
        output,
      );
      const allText = output.system.join("\n");
      // FASE 9 updated wording: "BEFORE any response or action" / "before entering plan mode"
      expect(allText.toLowerCase()).toMatch(/before|prior to|first step/i);
    } finally {
      try { rmSync(dir, { recursive: true, force: true }); } catch {}
    }
  });

  it("2/3 system.transform injects a full superpowers-style protocol (Red Flags + skill priority + mandatory invocation)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "fase9-super-"));
    writeFileSync(join(dir, "PLAN.md"), "# test");
    try {
      const sid = "fase9-super-1";
      const plugin = await makePlugin(dir, {
        meta_governor: { enabled: true },
      } as PluginOptions);
      const before = plugin["tool.execute.before"] as unknown as (i: unknown, o: unknown) => Promise<void>;
      await before(
        { tool: "read", sessionID: sid, callID: "c1" },
        { args: {} },
      );
      const systemTransform = plugin["experimental.chat.system.transform"] as unknown as (
        input: unknown,
        output: { system: string[] },
      ) => Promise<void>;
      const output: { system: string[] } = { system: [] };
      await systemTransform(
        { sessionID: sid, model: { providerID: "test", modelID: "test" } },
        output,
      );
      const allText = output.system.join("\n");
      const allTextLower = allText.toLowerCase();
      // 1. Lists available skills (chore skills from bundled-skills/)
      expect(allTextLower).toMatch(/using-superpowers|find-skills|chore|skill/i);
      // 2. Mentions specific skill names
      expect(allText).toMatch(/brainstorming|test-driven-development|systematic-debugging/);
      // 3. FASE 9 ENFORCEMENT: contains the mandatory-invocation language
      expect(allTextLower).toMatch(/must use|absolutely must|not negotiable|mandatory/i);
      // 4. FASE 9 ENFORCEMENT: contains anti-rationalization red flags
      expect(allTextLower).toMatch(/red flag|simple question|just doing/i);
      // 5. FASE 9 ENFORCEMENT: contains brainstorming-first rule
      expect(allTextLower).toMatch(/brainstorm.*first|plan mode/i);
      // 6. FASE 9 ENFORCEMENT: contains skill priority (process before implementation)
      expect(allTextLower).toMatch(/process skill|implementation skill|priority/i);
      // 7. FASE 9 ENFORCEMENT: contains announcement requirement
      expect(allTextLower).toMatch(/announce|using \[skill\]/i);
    } finally {
      try { rmSync(dir, { recursive: true, force: true }); } catch {}
    }
  });

  it("3/3 system.transform pre-existing system messages are preserved (does not clobber)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "fase8-preserve-"));
    writeFileSync(join(dir, "PLAN.md"), "# test");
    try {
      const sid = "fase8-preserve-1";
      const plugin = await makePlugin(dir, {
        meta_governor: { enabled: true },
      } as PluginOptions);
      const before = plugin["tool.execute.before"] as unknown as (i: unknown, o: unknown) => Promise<void>;
      await before(
        { tool: "read", sessionID: sid, callID: "c1" },
        { args: {} },
      );
      const systemTransform = plugin["experimental.chat.system.transform"] as unknown as (
        input: unknown,
        output: { system: string[] },
      ) => Promise<void>;
      const output: { system: string[] } = {
        system: ["PRE_EXISTING_SYSTEM_LINE"],
      };
      await systemTransform(
        { sessionID: sid, model: { providerID: "test", modelID: "test" } },
        output,
      );
      expect(output.system).toContain("PRE_EXISTING_SYSTEM_LINE");
      expect(output.system.length).toBeGreaterThan(1);
    } finally {
      try { rmSync(dir, { recursive: true, force: true }); } catch {}
    }
  });
});
