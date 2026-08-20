/**
 * v0.21.0 (post-wave W5): tests for the wave-gate decision helpers.
 * RED phase: these functions are exported from plugin.ts by W5 —
 * before implementation they do not exist (expected module-not-found / undefined).
 */
import { describe, test, expect } from "bun:test"
import {
  shouldInjectPostWaveDirective,
  buildOwnRepoDirective,
  buildThirdPartyDirective,
  resolveRepoMode,
  simpleHash,
} from "./plugin"

const baseConfig = {
  enabled: true,
  maxRetriesPerWave: 1,
  reinjectCooldownMs: 60_000,
}

function state(overrides: Partial<{
  currentWaveN: number | null
  lastInjectedWaveN: number | null
  lastInjectedAtMs: number | null
  postWaveInjectionsThisWave: number
  oracleAfterPhaseAtMs: Record<number, number>
}> = {}) {
  return {
    postWave: {
      currentWaveN: null,
      lastInjectedWaveN: null,
      lastInjectedAtMs: null,
      postWaveInjectionsThisWave: 0,
      oracleAfterPhaseAtMs: {},
      ...overrides,
    },
  }
}

describe("shouldInjectPostWaveDirective", () => {
  test("S1: injects when wave complete + Oracle verified after phase", () => {
    const s = state({
      currentWaveN: 1,
      oracleAfterPhaseAtMs: { 1: 1000 },
    })
    expect(shouldInjectPostWaveDirective(s, baseConfig, 5000)).toBe(true)
  })

  test("S3: does NOT inject when Oracle never verified the wave", () => {
    const s = state({ currentWaveN: 1, oracleAfterPhaseAtMs: {} })
    expect(shouldInjectPostWaveDirective(s, baseConfig, 5000)).toBe(false)
  })

  test("S3b: does NOT inject when there is no current wave", () => {
    const s = state({ currentWaveN: null })
    expect(shouldInjectPostWaveDirective(s, baseConfig, 5000)).toBe(false)
  })

  test("S4: once per wave — suppresses after lastInjectedWaveN reached", () => {
    const s = state({
      currentWaveN: 1,
      lastInjectedWaveN: 1,
      postWaveInjectionsThisWave: 1,
      oracleAfterPhaseAtMs: { 1: 1000 },
    })
    expect(shouldInjectPostWaveDirective(s, baseConfig, 5000)).toBe(false)
  })

  test("S4b: allows a NEW wave after a previous one was injected", () => {
    const s = state({
      currentWaveN: 2,
      lastInjectedWaveN: 1,
      postWaveInjectionsThisWave: 1,
      oracleAfterPhaseAtMs: { 2: 2000 },
    })
    expect(shouldInjectPostWaveDirective(s, baseConfig, 5000)).toBe(true)
  })

  test("S5: respects maxRetriesPerWave cap", () => {
    const s = state({
      currentWaveN: 1,
      lastInjectedWaveN: 1,
      postWaveInjectionsThisWave: 2,
      oracleAfterPhaseAtMs: { 1: 1000 },
    })
    expect(
      shouldInjectPostWaveDirective(s, { ...baseConfig, maxRetriesPerWave: 2 }, 5000),
    ).toBe(false)
  })

  test("S5b: cooldown blocks re-injection within the window", () => {
    const s = state({
      currentWaveN: 1,
      lastInjectedWaveN: 1,
      lastInjectedAtMs: 4000,
      postWaveInjectionsThisWave: 1,
      oracleAfterPhaseAtMs: { 1: 1000 },
    })
    // nowMs=5000, cooldown=60s → 1s elapsed < 60s → blocked
    expect(
      shouldInjectPostWaveDirective(s, { ...baseConfig, maxRetriesPerWave: 3 }, 5000),
    ).toBe(false)
  })

  test("S4c: cooldown does NOT block a NEW wave (cross-wave advance is always eligible)", () => {
    // Wave 1 injected 1s ago (lastInjectedAtMs=4000); wave 2 arrives now.
    // Cooldown (60s) applies only to SAME-wave re-injection (Oracle N1).
    const s = state({
      currentWaveN: 2,
      lastInjectedWaveN: 1,
      lastInjectedAtMs: 4000,
      postWaveInjectionsThisWave: 1,
      oracleAfterPhaseAtMs: { 2: 2000 },
    })
    expect(shouldInjectPostWaveDirective(s, baseConfig, 5000)).toBe(true)
  })

  test("S7: disabled config never injects", () => {
    const s = state({
      currentWaveN: 1,
      oracleAfterPhaseAtMs: { 1: 1000 },
    })
    expect(shouldInjectPostWaveDirective(s, { ...baseConfig, enabled: false }, 5000)).toBe(false)
  })
})

describe("buildOwnRepoDirective", () => {
  test("default template includes push + self-terminating CI watch", () => {
    const text = buildOwnRepoDirective(undefined, 3)
    expect(text).toContain("git push -u origin HEAD")
    expect(text).toContain("gh pr create --fill")
    expect(text).toContain("timeout 600 gh pr checks --watch")
    expect(text).toContain("Wave 3")
    expect(text).toContain("git checkout -b") // clean branch per PR
  })

  test("respects the user-provided override verbatim", () => {
    const text = buildOwnRepoDirective("MY CUSTOM DIRECTIVE", 1)
    expect(text).toBe("MY CUSTOM DIRECTIVE")
  })
})

describe("buildThirdPartyDirective", () => {
  test("S6: default template emphasizes reading contribution rules BEFORE publishing", () => {
    const text = buildThirdPartyDirective(undefined, 7)
    expect(text).toContain("Wave 7")
    expect(text).toContain("CONTRIBUTING")
    expect(text).toContain("read") // "READ FIRST"
    expect(text).toContain("CONTRIBUTING.md")
  })

  test("S2: default template references aas tools and review request", () => {
    const text = buildThirdPartyDirective(undefined, 1, "aas")
    expect(text).toContain("aas")
    expect(text).toContain("review")
    expect(text).toContain("PR")
    expect(text.toLowerCase()).toContain("fork") // push to fork
    expect(text.toLowerCase()).toContain("upstream") // PR against upstream
    expect(text).toContain("git checkout -b") // clean branch per PR
  })

  test("custom aasToolPrefix is honored", () => {
    const text = buildThirdPartyDirective(undefined, 1, "github")
    expect(text).toContain("github")
    expect(text).not.toContain("aas search")
  })

  test("user-provided override wins verbatim", () => {
    const text = buildThirdPartyDirective("THIRD PARTY OVERRIDE", 2)
    expect(text).toBe("THIRD PARTY OVERRIDE")
  })
})

describe("resolveRepoMode", () => {
  test("configured own stays own", () => {
    expect(resolveRepoMode("own", "D:/x")).toBe("own")
  })

  test("configured third-party stays third-party", () => {
    expect(resolveRepoMode("third-party", "D:/x")).toBe("third-party")
  })

  test("auto detects own repo via gh (isFork=false)", () => {
    const runner = (() => {
      throw new Error("gh must not be invoked when mode is explicit")
    }) as unknown as typeof import("node:child_process").execSync
    expect(resolveRepoMode("own", "D:/x", runner)).toBe("own")
  })

  test("auto resolves own when gh reports non-fork", () => {
    const runner = ((cmd: string) => {
      expect(cmd).toContain("gh repo view --json")
      return Buffer.from(JSON.stringify({ isFork: false, parent: null }))
    }) as unknown as typeof import("node:child_process").execSync
    expect(resolveRepoMode("auto", "D:/x", runner)).toBe("own")
  })

  test("auto resolves third-party when gh reports fork with parent", () => {
    const runner = ((_cmd: string) => {
      return Buffer.from(
        JSON.stringify({ isFork: true, parent: { owner: { login: "upstream" }, name: "repo" } }),
      )
    }) as unknown as typeof import("node:child_process").execSync
    expect(resolveRepoMode("auto", "D:/x", runner)).toBe("third-party")
  })

  test("auto falls back to own when gh is unavailable", () => {
    const runner = (() => {
      throw new Error("gh not installed")
    }) as unknown as typeof import("node:child_process").execSync
    expect(resolveRepoMode("auto", "D:/x", runner)).toBe("own")
  })

  test("auto resolves third-party via git upstream remote when gh is unavailable", () => {
    const runner = ((cmd: string) => {
      if (cmd.startsWith("gh")) throw new Error("gh not installed")
      return Buffer.from(
        "origin\thttps://github.com/user/fork.git (fetch)\n" +
          "upstream\thttps://github.com/thirdparty/repo.git (fetch)\n",
      )
    }) as unknown as typeof import("node:child_process").execSync
    expect(resolveRepoMode("auto", "D:/x", runner)).toBe("third-party")
  })

  test("auto stays own when gh unavailable and no upstream remote", () => {
    const runner = ((cmd: string) => {
      if (cmd.startsWith("gh")) throw new Error("gh not installed")
      return Buffer.from("origin\thttps://github.com/user/repo.git (fetch)\n")
    }) as unknown as typeof import("node:child_process").execSync
    expect(resolveRepoMode("auto", "D:/x", runner)).toBe("own")
  })
})

// ─── v0.29.0: simpleHash (Gap F helper) ───────────────────────────────

describe("simpleHash (v0.29.0)", () => {
  test("returns the same hash for the same input (deterministic)", () => {
    const input = "subagent_type=oracle prompt=Verify files"
    expect(simpleHash(input)).toBe(simpleHash(input))
  })

  test("returns different hashes for different inputs", () => {
    const a = simpleHash("subagent_type=oracle prompt=Verify files")
    const b = simpleHash("subagent_type=oracle prompt=Different prompt")
    expect(a).not.toBe(b)
  })

  test("returns a non-empty string", () => {
    expect(simpleHash("").length).toBeGreaterThan(0)
    expect(simpleHash("x").length).toBeGreaterThan(0)
  })

  test("returns a stable, alphanumeric (base36) hash", () => {
    const h = simpleHash("anything")
    expect(h).toMatch(/^[0-9a-z]+$/)
  })

  test("collision rate is low for typical Oracle-call echoes", () => {
    // 100 unique prompts should produce 100 unique hashes (FNV-1a is
    // collision-resistant enough for this size).
    const hashes = new Set<string>()
    for (let i = 0; i < 100; i++) {
      hashes.add(simpleHash(`subagent_type=oracle prompt=Verify task ${i}`))
    }
    expect(hashes.size).toBe(100)
  })

  test("handles unicode (PHASE-N-COMPLETE markers with em-dash)", () => {
    const a = simpleHash("<promise>PHASE-1-COMPLETE</promise>")
    const b = simpleHash("<promise>PHASE-2-COMPLETE</promise>")
    expect(a).not.toBe(b)
    expect(simpleHash("<promise>PHASE-1-COMPLETE</promise>")).toBe(a)
  })
})
