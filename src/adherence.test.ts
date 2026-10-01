/**
 * v0.53.0 (adherence) — repeat violations of an already-injected rule.
 *
 * Covered:
 * - Pure helpers: recordInjection / countRepeat / adherenceFloor /
 *   parseInjectedRules (no factory needed).
 * - Scoring: grave first → escalate (Wave B floor); grave third strike →
 *   stop; leve/media repeats never escalate alone; paralysis stays supreme.
 * - Plugin (hermetic): first grave → no directives_ignored + escalate;
 *   drained injection + repeat → directives_ignored == 1; third grave →
 *   stop; media repeat → counted but never stop; different rule → not a
 *   reincidencia.
 */
import { describe, expect, it, beforeEach } from "bun:test"
import type { PluginInput, PluginOptions } from "@opencode-ai/plugin"
import { score } from "./scoring-engine"
import type { DecisionContext, Deviation } from "./types"
import {
  recordInjection,
  countRepeat,
  adherenceFloor,
  parseInjectedRules,
  ADHERENCE_STOP_REPEAT_THRESHOLD,
} from "./adherence"
import { createHermeticPlugin } from "./__test-helpers__/hermetic-plugin"
import { __test_metricsCollector } from "./plugin"
import { clearAll, takeDecision } from "./decision-store"

// ─── Fixtures ─────────────────────────────────────────────────────

const mockPluginInput = {
  client: null as unknown as PluginInput["client"],
  project: null as unknown as PluginInput["project"],
  directory: "",
  worktree: "",
  experimental_workspace: { register: () => {} },
  serverUrl: new URL("http://localhost"),
  $: null as unknown as PluginInput["$"],
}

function baseOptions(): PluginOptions {
  return {
    meta_governor: {
      enabled: true,
      protocolEnforcement: { enabled: true, auditToolCalls: true },
      intervention: { mode: "message", minActionForMessage: "warn" },
      skillPriming: { enabled: false },
    },
  } as unknown as PluginOptions
}

type BeforeFn = (i: unknown, o: unknown) => Promise<void>
type AfterFn = (i: unknown, o: unknown) => Promise<void>
type SysFn = (i: unknown, o: unknown) => Promise<void>

function ctxWith(
  deviations: Deviation[],
  consecutiveStops = 0,
  extra: { noProgress?: boolean; iterationRatio?: number } = {},
): DecisionContext {
  return {
    oracleVerified: false,
    noProgress: extra.noProgress ?? false,
    deviations,
    iterationRatio: extra.iterationRatio ?? 0.1,
    lessonsRelevant: [],
    slotMemory: {
      consecutiveStops,
      consecutiveContinues: 0,
      lastUpdatedISO: new Date().toISOString(),
    },
    ambient: {
      sessionID: "ses-adherence",
      directory: "/tmp",
      mode: "simple",
      agentName: "test",
      iteration: 1,
      maxIterations: 10,
    },
  }
}

function ignoredCount(): number {
  return (
    __test_metricsCollector.getMetrics().counters.directives_ignored?.count ??
    0
  )
}

async function violate(
  hooks: Record<string, BeforeFn>,
  tool: string,
  sid: string,
  args: unknown,
): Promise<void> {
  await hooks["tool.execute.before"]?.(
    { tool, sessionID: sid, callID: `c-${Math.random()}` },
    { args },
  )
}

async function drain(hooks: Record<string, SysFn>, sid: string): Promise<void> {
  await hooks["experimental.chat.system.transform"]?.(
    { sessionID: sid, model: { providerID: "t", modelID: "t" } },
    { system: [] as string[] },
  )
}

async function runAfter(
  hooks: Record<string, AfterFn>,
  tool: string,
  sid: string,
): Promise<void> {
  await hooks["tool.execute.after"]?.(
    { tool, sessionID: sid, callID: `c-${Math.random()}`, args: {} },
    { title: "", output: "", metadata: {} },
  )
}

beforeEach(() => {
  clearAll()
  __test_metricsCollector.reset()
})

// ─── Pure helpers ─────────────────────────────────────────────────

describe("adherence helpers", () => {
  it("recordInjection starts at 1 and increments per drain", () => {
    let rules = recordInjection({}, "memory-first")
    expect(countRepeat(rules, "memory-first")).toBe(1)
    rules = recordInjection(rules, "memory-first")
    expect(countRepeat(rules, "memory-first")).toBe(2)
  })

  it("countRepeat is 0 for a never-injected rule", () => {
    expect(countRepeat({}, "no-type-suppression")).toBe(0)
  })

  it("recordInjection does not mutate the input and drops beyond the 50-rule cap", () => {
    let rules: Record<string, number> = {}
    for (let i = 0; i < 50; i++) rules = recordInjection(rules, `rule-${i}`)
    const before = { ...rules }
    const capped = recordInjection(rules, "rule-51")
    expect(rules).toEqual(before)
    expect(countRepeat(capped, "rule-51")).toBe(0)
    expect(Object.keys(capped)).toHaveLength(50)
  })

  it("recordInjection ignores blank rules", () => {
    expect(recordInjection({}, "   ")).toEqual({})
  })

  it("adherenceFloor: grave at threshold → stop, below → null", () => {
    expect(adherenceFloor("grave", ADHERENCE_STOP_REPEAT_THRESHOLD)).toBe(
      "stop",
    )
    expect(adherenceFloor("grave", ADHERENCE_STOP_REPEAT_THRESHOLD - 1)).toBeNull()
    expect(adherenceFloor("grave", 9)).toBe("stop")
  })

  it("adherenceFloor: leve/media NEVER escalate, however high the repeat", () => {
    expect(adherenceFloor("leve", 99)).toBeNull()
    expect(adherenceFloor("media", 99)).toBeNull()
    expect(adherenceFloor("unknown", 99)).toBeNull()
    expect(adherenceFloor("grave", Number.NaN)).toBeNull()
  })

  it("parseInjectedRules extracts distinct rules, skips garbage", () => {
    const items = [
      "[GRAVE] memory-first: Asked a question without memory.",
      "[MEDIA] no-type-suppression: as any found.",
      "[GRAVE] memory-first: same rule, other detail.",
      "not a violation entry",
    ]
    expect(parseInjectedRules(items)).toEqual([
      "memory-first",
      "no-type-suppression",
    ])
  })
})

// ─── Scoring ──────────────────────────────────────────────────────

describe("adherence scoring", () => {
  it("(a) first grave violation → escalate via the Wave B floor", () => {
    const r = score(
      ctxWith([
        { severity: "grave", category: "memory-first", detail: "d", ts: Date.now() },
      ]),
    )
    expect(r.decision.action).toBe("escalate")
  })

  it("(c) grave third strike (adherenceRepeat 2) → stop", () => {
    const r = score(
      ctxWith([
        {
          severity: "grave",
          category: "memory-first",
          detail: "d",
          ts: Date.now(),
          adherenceRepeat: 2,
        },
      ]),
    )
    expect(r.decision.action).toBe("stop")
  })

  it("(d) leve/media repeats NEVER escalate or stop on their own", () => {
    for (const severity of ["leve", "media"] as const) {
      const r = score(
        ctxWith([
          {
            severity,
            category: "some-rule",
            detail: "d",
            ts: Date.now(),
            adherenceRepeat: 99,
          },
        ]),
      )
      expect(r.decision.action).not.toBe("stop")
      expect(r.decision.action).not.toBe("escalate")
    }
  })

  it("paralysis stays supreme over the adherence stop floor", () => {
    const r = score(
      ctxWith(
        [
          {
            severity: "grave",
            category: "memory-first",
            detail: "d",
            ts: Date.now(),
            adherenceRepeat: 5,
          },
        ],
        3,
        { noProgress: true, iterationRatio: 0.9 },
      ),
    )
    expect(r.paralysisOverride).toBe(true)
    expect(r.decision.action).toBe("continue")
  })

  it("stale adherence strikes (beyond the 60s decay) do not stop", () => {
    const r = score(
      ctxWith([
        {
          severity: "grave",
          category: "memory-first",
          detail: "d",
          ts: Date.now() - 120_000,
          adherenceRepeat: 5,
        },
      ]),
    )
    expect(r.decision.action).not.toBe("stop")
  })
})

// ─── Plugin (hermetic) ────────────────────────────────────────────

describe("adherence plugin", () => {
  it(
    "(a) first grave violation → no directives_ignored, decision escalate",
    { timeout: 30000 },
    async () => {
      const sid = "ses-adh-a"
      const plugin = createHermeticPlugin({})
      const hooks = (await plugin(
        mockPluginInput,
        baseOptions(),
      )) as unknown as Record<string, BeforeFn & AfterFn>
      await violate(hooks, "question", sid, {})
      expect(ignoredCount()).toBe(0)
      await runAfter(hooks, "question", sid)
      const d = takeDecision(sid)
      expect(d?.action).toBe("escalate")
    },
  )

  it(
    "(b) drained injection + same-rule repeat → directives_ignored == 1",
    { timeout: 30000 },
    async () => {
      const sid = "ses-adh-b"
      const plugin = createHermeticPlugin({})
      const hooks = (await plugin(
        mockPluginInput,
        baseOptions(),
      )) as unknown as Record<string, BeforeFn & SysFn>
      await violate(hooks, "question", sid, {})
      await drain(hooks, sid)
      await violate(hooks, "question", sid, {})
      expect(ignoredCount()).toBe(1)
    },
  )

  it(
    "(c) third grave occurrence → decision stop",
    { timeout: 30000 },
    async () => {
      const sid = "ses-adh-c"
      const plugin = createHermeticPlugin({})
      const hooks = (await plugin(
        mockPluginInput,
        baseOptions(),
      )) as unknown as Record<string, BeforeFn & AfterFn & SysFn>
      await violate(hooks, "question", sid, {})
      await drain(hooks, sid)
      await violate(hooks, "question", sid, {})
      await drain(hooks, sid)
      await violate(hooks, "question", sid, {})
      expect(ignoredCount()).toBe(2)
      await runAfter(hooks, "question", sid)
      const d = takeDecision(sid)
      expect(d?.action).toBe("stop")
    },
  )

  it(
    "(d) media reincidencia counts but never stops on its own",
    { timeout: 30000 },
    async () => {
      const sid = "ses-adh-d"
      const plugin = createHermeticPlugin({})
      const hooks = (await plugin(
        mockPluginInput,
        baseOptions(),
      )) as unknown as Record<string, BeforeFn & AfterFn & SysFn>
      const asAny = { filePath: "/tmp/x.ts", content: "const x = 1 as any;" }
      await violate(hooks, "write", sid, asAny)
      await drain(hooks, sid)
      await violate(hooks, "write", sid, asAny)
      expect(ignoredCount()).toBe(1)
      await runAfter(hooks, "write", sid)
      const d = takeDecision(sid)
      expect(d?.action).not.toBe("stop")
      expect(d?.action).not.toBe("escalate")
    },
  )

  it(
    "(e) a different rule is not a reincidencia",
    { timeout: 30000 },
    async () => {
      const sid = "ses-adh-e"
      const plugin = createHermeticPlugin({})
      const hooks = (await plugin(
        mockPluginInput,
        baseOptions(),
      )) as unknown as Record<string, BeforeFn & SysFn>
      await violate(hooks, "question", sid, {})
      await drain(hooks, sid)
      await violate(hooks, "write", sid, {
        filePath: "/tmp/x.ts",
        content: "const x = 1 as any;",
      })
      expect(ignoredCount()).toBe(0)
    },
  )
})
