/**
 * agentmemory-client tests (v0.58.0 F1) — hermetic, no network.
 *
 * Contract:
 * - T1: auth resolution (explicit > env > file fallback; no file fallback for
 *   remote URLs).
 * - T2: URL resolution (explicit > env > loopback default).
 * - T3: every call degrades to null on error/timeout (never throws).
 * - T4: context/enrich/search map agentmemory responses.
 * - T5: saveLesson posts to /lessons (NOT /remember — that endpoint is 500 on
 *   v0.9.30) and maps the strengthen/create action.
 */
import { describe, expect, it } from "bun:test";
import {
  AgentmemoryClient,
  resolveAgentmemorySecret,
  resolveAgentmemoryUrl,
  type FetchFn,
} from "./agentmemory-client";

function jsonResponse(body: unknown, ok = true, status = 200) {
  return {
    ok,
    status,
    json: async () => body,
  };
}

describe("agentmemory-client F1 — auth + url resolution", () => {
  it("T1a: explicit secret wins over env", () => {
    expect(
      resolveAgentmemorySecret("explicit", "http://localhost:3111", {
        AGENTMEMORY_SECRET: "from-env",
      }),
    ).toBe("explicit");
  });

  it("T1b: env secret used when explicit missing", () => {
    expect(
      resolveAgentmemorySecret(undefined, "http://localhost:3111", {
        AGENTMEMORY_SECRET: "from-env",
      }),
    ).toBe("from-env");
  });

  it("T1c: unresolved ${VAR} placeholders are not used verbatim", () => {
    // A placeholder is rejected as a literal, then resolution falls through to
    // the file fallback (same order as the agentmemory-capture plugin). The
    // assertion is that the placeholder itself is never the secret.
    const resolved = resolveAgentmemorySecret(
      "${AGENTMEMORY_SECRET}",
      "http://localhost:3111",
      {},
    );
    expect(resolved).not.toBe("${AGENTMEMORY_SECRET}");
  });

  it("T1e: placeholder without file fallback resolves to empty (remote url)", () => {
    expect(resolveAgentmemorySecret("${AGENTMEMORY_SECRET}", "https://mem.example.com", {})).toBe("");
  });

  it("T1d: remote URL never falls back to the local secret file", () => {
    expect(resolveAgentmemorySecret(undefined, "https://mem.example.com", {})).toBe("");
  });

  it("T2a: url explicit > env > loopback default", () => {
    expect(resolveAgentmemoryUrl("http://a:1/", { AGENTMEMORY_URL: "http://b:2" })).toBe("http://a:1");
    expect(resolveAgentmemoryUrl(undefined, { AGENTMEMORY_URL: "http://b:2" })).toBe("http://b:2");
    expect(resolveAgentmemoryUrl(undefined, {})).toBe("http://localhost:3111");
  });
});

describe("agentmemory-client F1 — degradation + mapping", () => {
  it("T3a: network failure returns null, never throws", async () => {
    const client = new AgentmemoryClient({
      url: "http://localhost:3111",
      secret: "s",
      fetch: async () => {
        throw new Error("ECONNREFUSED");
      },
    });
    expect(await client.context({ sessionId: "s1" })).toEqual({ context: "", tokens: 0, blocks: 0 });
    expect(await client.enrich({ sessionId: "s1", files: ["a.ts"] })).toBe("");
    expect(await client.search({ query: "x" })).toEqual({ results: [], lessons: [], mode: undefined });
    expect((await client.saveLesson({ content: "x" })).saved).toBe(false);
  });

  it("T3b: non-ok response degrades to null (no partial data)", async () => {
    const client = new AgentmemoryClient({
      url: "http://localhost:3111",
      secret: "s",
      fetch: async () => jsonResponse({ error: "boom" }, false, 500),
    });
    expect(await client.listLessons({ project: "p" })).toEqual([]);
    expect(await client.insights("p")).toEqual([]);
  });

  it("T4a: context maps agentmemory payload", async () => {
    let seenUrl = "";
    const client = new AgentmemoryClient({
      url: "http://localhost:3111",
      secret: "sec",
      fetch: async (url) => {
        seenUrl = url;
        return jsonResponse({ context: "<ctx>hello</ctx>", tokens: 42, blocks: 2 });
      },
    });
    const res = await client.context({ sessionId: "s1", project: "p", files: ["a.ts"] });
    expect(res.context).toBe("<ctx>hello</ctx>");
    expect(res.tokens).toBe(42);
    expect(seenUrl).toContain("/agentmemory/context");
    expect(seenUrl).not.toContain("?");
  });

  it("T4b: enrich returns the context string", async () => {
    const client = new AgentmemoryClient({
      url: "http://localhost:3111",
      secret: "sec",
      fetch: async () => jsonResponse({ context: "file ctx" }),
    });
    expect(await client.enrich({ sessionId: "s1", files: ["a.ts"] })).toBe("file ctx");
  });

  it("T4c: search maps results + lessons", async () => {
    const client = new AgentmemoryClient({
      url: "http://localhost:3111",
      secret: "sec",
      fetch: async () => jsonResponse({ results: [{ id: "m1" }], lessons: [{ id: "l1" }], mode: "compact" }),
    });
    const res = await client.search({ query: "x", limit: 3 });
    expect(res.results.length).toBe(1);
    expect(res.lessons.length).toBe(1);
    expect(res.mode).toBe("compact");
  });

  it("T5a: saveLesson posts to /lessons with tags joined", async () => {
    let seenUrl = "";
    let seenBody: unknown = null;
    const client = new AgentmemoryClient({
      url: "http://localhost:3111",
      secret: "sec",
      fetch: async (url, init) => {
        seenUrl = url;
        seenBody = init?.body ? JSON.parse(init.body) : null;
        return jsonResponse({ success: true, action: "created", lesson: { id: "lsn_1", confidence: 0.7 } });
      },
    });
    const res = await client.saveLesson({
      content: "lesson body",
      context: "where",
      confidence: 0.7,
      project: "p",
      tags: ["a", "b"],
    });
    expect(seenUrl).toContain("/agentmemory/lessons");
    expect(seenUrl).not.toContain("/remember");
    expect((seenBody as { tags: string }).tags).toBe("a,b");
    expect(res.saved).toBe(true);
    expect(res.id).toBe("lsn_1");
  });

  it("T5b: reinforced duplicate is reported as strengthened", async () => {
    const client = new AgentmemoryClient({
      url: "http://localhost:3111",
      secret: "sec",
      fetch: async () =>
        jsonResponse({ success: true, action: "strengthened", lesson: { id: "lsn_1", confidence: 0.73 } }),
    });
    const res = await client.saveLesson({ content: "same lesson" });
    expect(res.action).toBe("strengthened");
    expect(res.confidence).toBe(0.73);
  });
});
