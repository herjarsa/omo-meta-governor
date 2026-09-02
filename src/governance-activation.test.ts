/**
 * FASE 2 part 2 — v0.43.0 governance activation
 *
 * Verifies that governance hooks FIRE by default when config is provided,
 * using tmpdir+PLAN.md pattern to avoid cross-platform cwd issues.
 * TDD: these tests MUST FAIL before the defaults fix and PASS after.
 */
import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadOrchestratorConfig } from "./config";
import { createHermeticPlugin } from "./__test-helpers__/hermetic-plugin";
import type { PluginInput } from "@opencode-ai/plugin";

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

describe("governance activation FASE 2 part 2", () => {
  it("1/5 loadOrchestratorConfig defaults toolRewrite.enabled to true", () => {
    const cfg = loadOrchestratorConfig({});
    // Before fix: undefined. After fix: true
    expect(cfg.governance?.toolRewrite?.enabled).toBe(true);
  });

  it("2/5 loadOrchestratorConfig defaults commandFilter.enabled to true", () => {
    const cfg = loadOrchestratorConfig({});
    expect(cfg.governance?.commandFilter?.enabled).toBe(true);
  });

  it("3/5 tool.definition rewrites with descriptionSuffix even when enabled not set (default true)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gov-tool-"));
    writeFileSync(join(dir, "PLAN.md"), "# test");
    try {
      const plugin = createHermeticPlugin({
        governance: { toolRewrite: { descriptionSuffix: " [GOV]" } },
      } as never);
      const hooks = await plugin(mockPluginInput(dir), {
        meta_governor: { enabled: true, governance: { toolRewrite: { descriptionSuffix: " [GOV]" } } },
      } as never);
      const toolOutput = { description: "original", parameters: { properties: {} } };
      await (hooks["tool.definition"] as unknown as (i: unknown, o: unknown) => Promise<void>)(
        { toolID: "bash" },
        toolOutput,
      );
      expect(toolOutput.description).toBe("original [GOV]");
    } finally {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {}
    }
  });

  it("4/5 command.execute.before blocks when denyPatterns provided without explicit enabled", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gov-cmd-"));
    writeFileSync(join(dir, "PLAN.md"), "# test");
    try {
      const plugin = createHermeticPlugin({
        governance: { commandFilter: { denyPatterns: ["rm -rf"] } },
      } as never);
      const hooks = await plugin(mockPluginInput(dir), {
        meta_governor: { enabled: true, governance: { commandFilter: { denyPatterns: ["rm -rf"] } } },
      } as never);
      const cmdOutput = { parts: [] as Array<{ type: string; text: string }> };
      let threw = false;
      try {
        await (hooks["command.execute.before"] as unknown as (i: unknown, o: unknown) => Promise<void>)(
          { command: "rm -rf /tmp/foo", sessionID: "s1", arguments: "" },
          cmdOutput,
        );
      } catch (e) {
        threw = true;
        expect(String(e)).toContain("blocked command");
      }
      expect(threw).toBe(true);
    } finally {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {}
    }
  });

  it("5/5 permission.ask remains pass-through when mode not set (opt-in)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gov-perm-"));
    writeFileSync(join(dir, "PLAN.md"), "# test");
    try {
      const plugin = createHermeticPlugin({} as never);
      const hooks = await plugin(mockPluginInput(dir), {
        meta_governor: { enabled: true },
      } as never);
      const permOutput: { status: "ask" | "deny" | "allow" } = { status: "ask" };
      await (hooks["permission.ask"] as unknown as (i: unknown, o: unknown) => Promise<void>)(
        { type: "bash", command: "rm -rf /" },
        permOutput,
      );
      expect(permOutput.status).toBe("ask");
    } finally {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {}
    }
  });

  it("6/5 explicit enabled:false still disables toolRewrite", () => {
    const cfg = loadOrchestratorConfig({
      governance: { toolRewrite: { enabled: false, descriptionSuffix: " [GOV]" } },
    } as never);
    expect(cfg.governance?.toolRewrite?.enabled).toBe(false);
  });

  it("7/5 explicit enabled:false still disables commandFilter", () => {
    const cfg = loadOrchestratorConfig({
      governance: { commandFilter: { enabled: false, denyPatterns: ["rm -rf"] } },
    } as never);
    expect(cfg.governance?.commandFilter?.enabled).toBe(false);
  });
});
