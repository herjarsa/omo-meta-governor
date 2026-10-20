/**
 * model-context tests (v0.61.0 F6).
 *
 * Contract:
 * - M1: an explicit override always wins over the registry.
 * - M2: the registry's limit.context is used for a bare model id.
 * - M3: the registry is used for a provider-qualified model id.
 * - M4: the model is looked up across providers when the provider is unknown.
 * - M5: an unknown model falls back to 200k.
 * - M6: a missing/unparseable registry falls back to 200k.
 * - M7: a malformed limit (0, negative, non-numeric) is ignored.
 */
import { describe, expect, it } from "bun:test";
import {
  FALLBACK_MODEL_LIMIT,
  lookupContextWindow,
  resolveModelLimit,
  type ModelRegistry,
} from "./model-context";

const registry: ModelRegistry = {
  "opencode-go": {
    models: {
      "muse-spark-1.3-contributor": { limit: { context: 1048576, output: 131072 } },
      "small-model": { limit: { context: 32768 } },
    },
  },
  anthropic: {
    models: {
      "claude-sonnet-4-5": { limit: { context: 200000 } },
    },
  },
};

describe("model-context F6 — the real context window", () => {
  it("M1: an explicit override wins over the registry", () => {
    expect(
      resolveModelLimit({ override: 123456, modelID: "muse-spark-1.3-contributor", registry }),
    ).toBe(123456);
  });

  it("M2: a bare model id resolves through the registry", () => {
    expect(resolveModelLimit({ modelID: "muse-spark-1.3-contributor", registry })).toBe(1048576);
    expect(resolveModelLimit({ modelID: "small-model", registry })).toBe(32768);
  });

  it("M3: a provider-qualified model id resolves", () => {
    expect(
      resolveModelLimit({
        modelID: "opencode-go/muse-spark-1.3-contributor",
        providerID: "opencode-go",
        registry,
      }),
    ).toBe(1048576);
  });

  it("M4: the model is found across providers when the provider is unknown", () => {
    // A gateway with a different name, serving the same model.
    expect(
      resolveModelLimit({
        modelID: "some-gateway/muse-spark-1.3-contributor",
        providerID: "some-gateway",
        registry,
      }),
    ).toBe(1048576);
  });

  it("M5: an unknown model falls back to 200k", () => {
    expect(resolveModelLimit({ modelID: "not-a-model", registry })).toBe(FALLBACK_MODEL_LIMIT);
    expect(resolveModelLimit({ registry })).toBe(FALLBACK_MODEL_LIMIT);
  });

  it("M6: a missing registry falls back to 200k", () => {
    expect(resolveModelLimit({ modelID: "x", registry: null })).toBe(FALLBACK_MODEL_LIMIT);
  });

  it("M7: a malformed limit is ignored", () => {
    const bad: ModelRegistry = {
      p: {
        models: {
          a: { limit: { context: 0 } },
          b: { limit: { context: -5 } },
          c: { limit: {} },
          d: {},
        },
      },
    };
    expect(lookupContextWindow(bad, "a")).toBeUndefined();
    expect(lookupContextWindow(bad, "b")).toBeUndefined();
    expect(lookupContextWindow(bad, "c")).toBeUndefined();
    expect(lookupContextWindow(bad, "d")).toBeUndefined();
  });
});
