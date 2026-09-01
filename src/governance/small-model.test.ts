import { describe, expect, it } from "bun:test";
import { handleSmallModel } from "./small-model";

describe("handleSmallModel", () => {
  const fakeModel = { id: "haiku", providerID: "anthropic", description: "fast", cost: 0.1 };
  const fakeProvider = { models: { haiku: fakeModel, opus: { id: "opus", providerID: "anthropic" } } as unknown as Record<string, unknown> };

  it("no-op when not enabled", async () => {
    const out = {} as { model?: unknown };
    await handleSmallModel({ provider: fakeProvider } as never, out, {});
    expect(out.model).toBeUndefined();
  });

  it("forces model when found in provider list", async () => {
    const out = {} as { model?: unknown };
    const policy = { enabled: true, modelID: "haiku", providerID: "anthropic" };
    await handleSmallModel({ provider: fakeProvider } as never, out, policy);
    expect(out.model).toBe(fakeModel);
  });

  it("no-op when model not in provider list (graceful fallback)", async () => {
    const out = {} as { model?: unknown };
    const policy = { enabled: true, modelID: "phantom", providerID: "anthropic" };
    await handleSmallModel({ provider: fakeProvider } as never, out, policy);
    expect(out.model).toBeUndefined();
  });

  it("no-op when providerID missing", async () => {
    const out = {} as { model?: unknown };
    await handleSmallModel({ provider: fakeProvider } as never, out, { enabled: true, modelID: "haiku" });
    expect(out.model).toBeUndefined();
  });
});