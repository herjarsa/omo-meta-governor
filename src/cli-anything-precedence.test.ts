/**
 * v0.36.1 (audit P2-1 + Oracle review) — rawCliAnything precedence: options > file.
 *
 * Bug (v0.35.9): rawCliAnything used `file ?? options` (file wins), opposite
 * to rawGraphSync (`options ?? file`) and to rawConfig (spread options > file
 * > factory). An operator disabling cliAnything inline was silently
 * re-enabled by the user-level file.
 *
 * v0.36.1: behavioral test using __test_runCliAnythingSync DI seam to
 * capture the resolved autoInstall value and assert options wins.
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

function makeHermeticDeps(captured: CapturedCall[]): MetaGovernorPluginDeps {
  return {
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
      captured.push({
        autoInstall: opts.autoInstall ?? false,
        autoUpgrade: opts.autoUpgrade ?? false,
      })
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
}

describe("P2-1 rawCliAnything precedence: options > file", () => {
  beforeEach(() => clearAll())

  it("then options.cliAnything.enabled=false wins over file cliAnything enabled", async () => {
    const captured: CapturedCall[] = []
    const deps = makeHermeticDeps(captured)
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
    await new Promise((r) => setImmediate(r))
    expect(captured.length).toBe(0)
  })

  it("then options.cliAnything.autoInstall=true overrides file autoInstall=false", async () => {
    const captured: CapturedCall[] = []
    const deps = makeHermeticDeps(captured)
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
    await new Promise((r) => setImmediate(r))
    expect(captured.length).toBe(1)
    expect(captured[0]!.autoInstall).toBe(true)
    expect(captured[0]!.autoUpgrade).toBe(true)
  })
})