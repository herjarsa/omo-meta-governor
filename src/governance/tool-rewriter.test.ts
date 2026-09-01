import { describe, expect, it, beforeEach } from "bun:test";
import { createMetricsCollector } from "../metrics";
import { handleToolDefinition } from "./tool-rewriter";

describe("handleToolDefinition", () => {
  let metrics: ReturnType<typeof createMetricsCollector>;

  beforeEach(() => {
    metrics = createMetricsCollector({ sessionID: "ses-test" });
  });

  it("no-op when not enabled", async () => {
    const out = {
      description: "Original desc",
      parameters: { properties: { file: { description: "original" } } },
    };
    await handleToolDefinition({ toolID: "read" }, out, {}, metrics);
    expect(out.description).toBe("Original desc");
    expect(out.parameters.properties.file.description).toBe("original");
  });

  it("hides tool by clearing description", async () => {
    const out = {
      description: "Old",
      parameters: { properties: {} },
    };
    const policy = { enabled: true, hideToolIDs: ["read"] };
    await handleToolDefinition({ toolID: "read" }, out, policy, metrics);
    expect(out.description).toBe("");
    expect(metrics.getMetrics().counters.governance_tools_hidden?.count).toBe(1);
  });

  it("does not hide a different tool", async () => {
    const out = { description: "Old", parameters: { properties: {} } };
    const policy = { enabled: true, hideToolIDs: ["other"] };
    await handleToolDefinition({ toolID: "read" }, out, policy, metrics);
    expect(out.description).toBe("Old");
  });

  it("appends descriptionSuffix", async () => {
    const out = { description: "Desc", parameters: { properties: {} } };
    const policy = { enabled: true, descriptionSuffix: " (needs approval)" };
    await handleToolDefinition({ toolID: "bash" }, out, policy, metrics);
    expect(out.description).toBe("Desc (needs approval)");
    expect(metrics.getMetrics().counters.governance_tools_rewritten?.count).toBe(1);
  });

  it("overrides parameter descriptions per tool", async () => {
    const out = {
      description: "Desc",
      parameters: {
        properties: {
          filePath: { description: "old" },
          other: { description: "keep" },
        },
      },
    };
    const policy = {
      enabled: true,
      parameterOverrides: { read: { filePath: "governed: path validation enforced" } },
    };
    await handleToolDefinition({ toolID: "read" }, out, policy, metrics);
    expect(out.parameters.properties.filePath.description).toBe("governed: path validation enforced");
    expect(out.parameters.properties.other.description).toBe("keep");
  });

  it("hide takes precedence over suffix", async () => {
    const out = { description: "Desc", parameters: { properties: {} } };
    const policy = {
      enabled: true,
      hideToolIDs: ["read"],
      descriptionSuffix: " (needs approval)",
    };
    await handleToolDefinition({ toolID: "read" }, out, policy, metrics);
    expect(out.description).toBe("");
    expect(metrics.getMetrics().counters.governance_tools_rewritten?.count ?? 0).toBe(0);
  });
});