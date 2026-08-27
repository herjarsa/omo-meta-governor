/**
 * v0.36.1 (audit P2-1 + Oracle review) — rawCliAnything precedence: options > file.
 *
 * Bug (v0.35.9): rawCliAnything used `file ?? options` (file wins), opposite
 * to rawGraphSync (`options ?? file`) and to rawConfig (spread options > file
 * > factory). An operator disabling cliAnything inline was silently
 * re-enabled by the user-level file.
 *
 * v0.36.1: behavioral test using __test_runCliAnythingSync DI seam. The
 * stub exposes a Promise that resolves on call, so the test can await
 * the microtask deterministically (no setImmediate race on Windows CI).
 */
import { describe, expect, it, beforeEach } from "bun:test"
import type { PluginInput, PluginOptions } from "@opencode-ai/plugin"
import { createMetaGovernorPlugin, type MetaGovernorPluginDeps } from "./plugin"
import { clearAll } from "./decision-store"

const mockPluginInput = {
  client: null as unknown as PluginInput["client"],
  project: null as unknown as PluginInput["project"],
  directory: "",
  worktree: "",
  experimental_workspace: { register: () => {} },
  serverUrl: new URL("http://localhost"),
  $: null as unknown as PluginInput["$"],
}

interface CapturedCall {
  autoInstall: boolean
  autoUpgrade: boolean
}

/**
 * Build hermetic deps with a stub that signals when called. Returns
 * { deps, onCalled } where onCalled is a Promise resolving once the
 * __test_runCliAnythingSync stub is invoked. Tests that expect zero
 * calls use a timeout on onCalled.race to fail fast.
 */
function makeHermeticDeps(): {
  deps: MetaGovernorPluginDeps
  onCalled: Promise<CapturedCall>
  reset: () => void
  captured: CapturedCall
} {
  let resolveCalled: ((c: CapturedCall) => void) | null = null
  let capturedValue: CapturedCall | null = null
  const capturedRef: { current: CapturedCall | null } = { current: null }

  const onCalled = new Promise<CapturedCall>((resolve) => {
    resolveCalled = resolve
  })

  const deps: MetaGovernorPluginDeps = {
    __test_runGraphSync: async () => ({
      attempted: false,
      codes: ["disabled"],
      availability: {
        codegraph: false,
        graphify: false,
        codegraphIndexExists: false,
        graphifyIndexExists: false,
      },
      alreadyInitialized: true,
    }),
    __test_runCliAnythingSync: async (opts) => {
      const c: CapturedCall = {
        autoInstall: opts.autoInstall ?? false,
        autoUpgrade: opts.autoUpgrade ?? false,
      }
      capturedValue = c
      capturedRef.current = c
      resolveCalled?.(c)
      return {
        attempted: true,
        codes: ["mock"],
        availability: { cliHub: true, cliHubVersion: "test", metaSkill: true },
        alreadyInitialized: false,
      }
    },
    __test_persistSessionMessage: async () => ({
      ok: true,
      messageID: null,
      error: null,
      durationMs: 0,
    }),
    __test_persistRetryDelayMs: 0,
  }

  return {
    deps,
    onCalled,
    reset: () => {
      capturedValue = null
      capturedRef.current = null
    },
    get captured(): CapturedCall {
      return capturedRef.current as CapturedCall
    },
  }
}

async function waitForCliAnythingCall(
  onCalled: Promise<CapturedCall>,
  timeoutMs: number = process.platform === "win32" ? 5000 : 500,
): Promise<CapturedCall | null> {
  let timer: ReturnType<typeof setTimeout> | null = null
  const timeoutPromise = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), timeoutMs)
  })
  const result = await Promise.race([onCalled, timeoutPromise])
  if (timer) clearTimeout(timer)
  return result
}

describe("P2-1 rawCliAnything precedence: options > file", () => {
  beforeEach(() => clearAll())

  it("then options.cliAnything.enabled=false wins over file cliAnything enabled", async () => {
    const { deps, onCalled } = makeHermeticDeps()
    const plugin = createMetaGovernorPlugin(
      { cliAnything: { enabled: true, autoInstall: true, autoUpgrade: true } } as never,
      deps,
    )
    const opts: PluginOptions = {
      meta_governor: {
        enabled: true,
        cliAnything: { enabled: false },
      } as never,
    }
    await plugin(mockPluginInput, opts)
    const called = await waitForCliAnythingCall(onCalled, 500)
    // After the v0.36.1 fix, options.cliAnything.enabled=false must win,
    // so __test_runCliAnythingSync must NOT have been called.
    expect(called).toBeNull()
  })

  it("then options.cliAnything.autoInstall=true overrides file autoInstall=false", async () => {
    const { deps, onCalled } = makeHermeticDeps()
    const plugin = createMetaGovernorPlugin(
      { cliAnything: { enabled: true, autoInstall: false, autoUpgrade: false } } as never,
      deps,
    )
    const opts: PluginOptions = {
      meta_governor: {
        enabled: true,
        cliAnything: { enabled: true, autoInstall: true, autoUpgrade: true },
      } as never,
    }
    await plugin(mockPluginInput, opts)
    const called = await waitForCliAnythingCall(onCalled, 2000)
    expect(called).not.toBeNull()
    expect(called!.autoInstall).toBe(true)
    expect(called!.autoUpgrade).toBe(true)
  })
})