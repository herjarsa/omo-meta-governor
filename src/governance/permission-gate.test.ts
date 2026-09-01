import { describe, expect, it, beforeEach } from "bun:test";
import { createMetricsCollector } from "../metrics";
import { handlePermissionAsk } from "./permission-gate";

describe("handlePermissionAsk", () => {
  let metrics: ReturnType<typeof createMetricsCollector>;

  beforeEach(() => {
    metrics = createMetricsCollector({ sessionID: "ses-test" });
  });

  it("no-op when policy.mode is undefined (preserves v0.40 behavior)", async () => {
    const out = { status: "ask" as "ask" | "deny" | "allow" };
    await handlePermissionAsk(
      { type: "bash", command: "rm -rf /" } as never,
      out,
      {},
      metrics,
    );
    expect(out.status).toBe("ask");
    expect(metrics.getMetrics().counters.governance_blocks?.count ?? 0).toBe(0);
  });

  it("denies bash command matching deny pattern", async () => {
    const out = { status: "ask" as "ask" | "deny" | "allow" };
    await handlePermissionAsk(
      { type: "bash", command: "rm -rf /tmp/foo" } as never,
      out,
      { mode: "allow", bashDenyPatterns: ["rm\\s+-rf\\s+/"] },
      metrics,
    );
    expect(out.status).toBe("deny");
    expect(metrics.getMetrics().counters.governance_blocks?.count).toBe(1);
  });

  it("asks for confirmation on ask pattern match", async () => {
    const out = { status: "deny" as "ask" | "deny" | "allow" };
    await handlePermissionAsk(
      { type: "bash", command: "git push origin main" } as never,
      out,
      { mode: "allow", bashAskPatterns: ["git\\s+push"] },
      metrics,
    );
    expect(out.status).toBe("ask");
    expect(metrics.getMetrics().counters.governance_asks?.count).toBe(1);
  });

  it("passes through bash with no pattern match", async () => {
    const out = { status: "ask" as "ask" | "deny" | "allow" };
    await handlePermissionAsk(
      { type: "bash", command: "ls -la" } as never,
      out,
      { mode: "allow", bashDenyPatterns: ["rm\\s+-rf"] },
      metrics,
    );
    expect(out.status).toBe("ask");
    expect(metrics.getMetrics().counters.governance_blocks?.count ?? 0).toBe(0);
  });

  it("denies edit on matching deny path", async () => {
    const out = { status: "ask" as "ask" | "deny" | "allow" };
    await handlePermissionAsk(
      { type: "edit", pattern: ".env" } as never,
      out,
      { mode: "allow", editDenyPaths: ["**/.env"] },
      metrics,
    );
    expect(out.status).toBe("deny");
    expect(metrics.getMetrics().counters.governance_blocks?.count).toBe(1);
  });

  it("denies webfetch on matching deny host", async () => {
    const out = { status: "ask" as "ask" | "deny" | "allow" };
    await handlePermissionAsk(
      { type: "webfetch", url: "https://evil.com/path" } as never,
      out,
      { mode: "allow", webfetchDenyHosts: ["evil.com"] },
      metrics,
    );
    expect(out.status).toBe("deny");
    expect(metrics.getMetrics().counters.governance_blocks?.count).toBe(1);
  });

  it("passes through unknown permission types (e.g. doom_loop)", async () => {
    const out = { status: "ask" as "ask" | "deny" | "allow" };
    await handlePermissionAsk(
      { type: "doom_loop" } as never,
      out,
      { mode: "allow", bashDenyPatterns: ["dangerous"] },
      metrics,
    );
    expect(out.status).toBe("ask");
  });
});