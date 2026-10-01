import { describe, test, expect } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMetricsCollector } from "./metrics";
import { buildPluginHealth } from "./health";
import { buildOmoHealthTool } from "./custom-tools";

function tempPaths() {
  const dir = mkdtempSync(join(tmpdir(), "health-adh-"));
  return { logFilePath: join(dir, "meta.log"), healthFilePath: join(dir, "health.json") };
}

describe("health adherence — directivesIgnored", () => {
  test("directivesIgnored is 0 by default", async () => {
    const metrics = createMetricsCollector({ sessionID: "s-adh-0" });
    const snap = metrics.getMetrics();
    const { logFilePath } = tempPaths();
    const health = buildPluginHealth({
      version: "test",
      enabled: true,
      sessionID: "s-adh-0",
      snapshot: snap,
      logFilePath,
    });
    expect(health.metrics.directivesIgnored).toBe(0);
  });

  test("directivesIgnored reflects inc('directives_ignored') count", async () => {
    const metrics = createMetricsCollector({ sessionID: "s-adh-1" });
    metrics.inc("directives_ignored");
    metrics.inc("directives_ignored");
    metrics.inc("directives_ignored");
    const snap = metrics.getMetrics();
    const { logFilePath, healthFilePath } = tempPaths();
    const health = buildPluginHealth({
      version: "test",
      enabled: true,
      sessionID: "s-adh-1",
      snapshot: snap,
      logFilePath,
    });
    expect(health.metrics.directivesIgnored).toBe(3);

    const tool = buildOmoHealthTool({ metrics, logFilePath, healthFilePath });
    const result = (await (tool.execute as any)({}, { sessionID: "s-adh-1" })) as {
      output: string;
    };
    expect(result.output).toContain("Directives ignored");
    expect(result.output).toContain("| Directives ignored | 3 |");
  });
});
