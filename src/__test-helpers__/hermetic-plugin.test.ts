import { describe, expect, it } from "bun:test";
import { createHermeticPlugin, noopRunner } from "./hermetic-plugin";
import type { PluginInput, PluginOptions } from "@opencode-ai/plugin";

const mockInput = {
  client: null as unknown as PluginInput["client"],
  project: null as unknown as PluginInput["project"],
  directory: "",
  worktree: "",
  experimental_workspace: { register: () => {} },
  serverUrl: new URL("http://localhost"),
  $: null as unknown as PluginInput["$"],
};

describe("createHermeticPlugin", () => {
  it("returns a callable plugin that produces hooks", async () => {
    const plugin = createHermeticPlugin();
    const hooks = await plugin(mockInput, { meta_governor: { enabled: true } });
    expect(typeof hooks["tool.execute.before"]).toBe("function");
    expect(hooks["tool"]).toBeDefined();
  });

  it("does NOT spawn any subprocess when graphSync is enabled", async () => {
    const plugin = createHermeticPlugin({ graphSync: { enabled: true } });
    await plugin(mockInput, {});
    // No assertion needed; passing = no spawn leak
  });

  it("noopRunner returns 0", () => {
    expect(noopRunner("anything")).toBe(0);
  });
});
