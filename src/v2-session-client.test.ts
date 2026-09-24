/**
 * V2 session-client tests (v0.50.0 Oracle B1) — assert the REAL V2 wire
 * shape: flat prompt({ sessionID, text }) resolving to SessionInboxUser {id}.
 */
import { describe, expect, it } from "bun:test";
import { V2SessionClient } from "./v2/session-client";

function fakeCtx(promptImpl: (arg: unknown) => Promise<unknown>) {
  return { session: { prompt: promptImpl } } as never;
}

describe("v2 session client wire shape", () => {
  it("1/2 calls prompt with flat { sessionID, text } and extracts flat id", async () => {
    let seen: unknown = null;
    const client = new V2SessionClient(
      fakeCtx(async (arg: unknown) => {
        seen = arg;
        return { id: "msg-123", sessionID: "s1", type: "user" };
      }),
    );
    const res = await client.session.prompt({
      path: { id: "s1" },
      body: { parts: [{ type: "text", text: "hello" }] },
    });
    expect(seen).toEqual({ sessionID: "s1", text: "hello" });
    expect(res).toEqual({ data: { info: { id: "msg-123" } } });
  });

  it("2/2 multi-part bodies join into one text; failure resolves null", async () => {
    let seen: unknown = null;
    const client = new V2SessionClient(
      fakeCtx(async (arg: unknown) => {
        seen = arg;
        return { id: "m2", sessionID: "s2" };
      }),
    );
    await client.session.prompt({
      path: { id: "s2" },
      body: { parts: [{ type: "text", text: "a" }, { type: "text", text: "b" }] },
    });
    expect(seen).toEqual({ sessionID: "s2", text: "a\n\nb" });

    const failing = new V2SessionClient(
      fakeCtx(async () => {
        throw new Error("boom");
      }),
    );
    // Primary fails, legacy fallback also fails → null, never throws.
    const res = await failing.session.prompt({
      path: { id: "s3" },
      body: { parts: [{ type: "text", text: "x" }] },
    });
    expect(res).toBeNull();
  });
});
