import { describe, expect, it, beforeEach } from "bun:test";
import { createMetricsCollector } from "../metrics";
import { handleCommandFilter } from "./command-filter";

describe("handleCommandFilter", () => {
  let metrics: ReturnType<typeof createMetricsCollector>;

  beforeEach(() => {
    metrics = createMetricsCollector({ sessionID: "ses-test" });
  });

  it("no-op when not enabled", async () => {
    const out = { parts: [] as Array<{ type: string; text: string; synthetic?: boolean }> };
    await handleCommandFilter(
      { command: "rm -rf /", sessionID: "ses1", arguments: "" },
      out,
      {},
      metrics,
    );
    expect(out.parts.length).toBe(0);
    expect(metrics.getMetrics().counters.governance_commands_blocked?.count ?? 0).toBe(0);
  });

  it("blocks command matching deny pattern", async () => {
    const out = { parts: [] as Array<{ type: string; text: string; synthetic?: boolean }> };
    const policy = { enabled: true, denyPatterns: ["rm\\s+-rf\\s+/"] };
    await expect(
      handleCommandFilter({ command: "rm -rf /tmp/foo", sessionID: "ses1", arguments: "" }, out, policy, metrics),
    ).rejects.toThrow("blocked command");
    expect(metrics.getMetrics().counters.governance_commands_blocked?.count).toBe(1);
  });

  it("allows command not matching any deny pattern", async () => {
    const out = { parts: [] as Array<{ type: string; text: string; synthetic?: boolean }> };
    const policy = { enabled: true, denyPatterns: ["rm\\s+-rf\\s+/"] };
    await handleCommandFilter({ command: "ls -la", sessionID: "ses1", arguments: "" }, out, policy, metrics);
    expect(out.parts.length).toBe(0);
    expect(metrics.getMetrics().counters.governance_commands_blocked?.count ?? 0).toBe(0);
  });

  it("skips invalid regex without blocking", async () => {
    const out = { parts: [] as Array<{ type: string; text: string; synthetic?: boolean }> };
    const policy = { enabled: true, denyPatterns: ["[invalid("] };
    await handleCommandFilter({ command: "ls", sessionID: "ses1", arguments: "" }, out, policy, metrics);
    expect(metrics.getMetrics().counters.governance_commands_blocked?.count ?? 0).toBe(0);
  });

  it("appends replacementPrefix as warning part when not blocked", async () => {
    const out = { parts: [] as Array<{ type: string; text: string; synthetic?: boolean }> };
    const policy = { enabled: true, replacementPrefix: "[governed]" };
    await handleCommandFilter({ command: "ls -la", sessionID: "ses1", arguments: "" }, out, policy, metrics);
    expect(out.parts.length).toBe(1);
    expect(out.parts[0].text).toContain("[governed]");
  });
});