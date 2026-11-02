/**
 * Regression: plugin activation must not run background subsystems inline.
 *
 * OpenCode aborts a location whose plugins have not finished activating within
 * ~13s. graphSync (orphan sweep + install probes), cli-anything (pip/npx
 * probes), the git origin fetch, the chore-skills tar extraction and the
 * skills fs watcher all used to run inside the factory prologue, so `setup()`
 * spent ~13s before resolving and the host reported the location as failed
 * (OpenChamber: HTTP 500 on session create/continue).
 *
 * Contract pinned here: `setup()` resolves with the background seams still
 * uncalled; the deferred work starts on a later macrotask.
 */
import { describe, expect, it } from "bun:test"
import type { PluginInput } from "@opencode-ai/plugin"

import { createMetaGovernorPlugin, type MetaGovernorPluginDeps } from "./plugin"

const fakeGraphSync = (onCall: () => void) =>
  (async () => {
    onCall()
    return {
      attempted: false,
      codes: [],
      availability: {
        codegraph: false,
        graphify: false,
        codegraphIndexExists: false,
        graphifyIndexExists: false,
      },
      alreadyInitialized: false,
    }
  }) as unknown as NonNullable<MetaGovernorPluginDeps["__test_runGraphSync"]>

const fakeCliAnything = (onCall: () => void) =>
  (async () => {
    onCall()
    return {
      attempted: false,
      codes: ["cli-anything-upgrade-skipped"],
      availability: { cliHub: false, cliHubVersion: null, metaSkill: false },
      alreadyInitialized: true,
    }
  }) as unknown as NonNullable<MetaGovernorPluginDeps["__test_runCliAnythingSync"]>

const fakeWatcher = (onCall: () => void) =>
  (async () => {
    onCall()
    return { stop: async () => {} }
  }) as unknown as NonNullable<MetaGovernorPluginDeps["__test_startSkillsFsWatcher"]>

function makeInput(directory: string): PluginInput {
  return {
    client: null as unknown as PluginInput["client"],
    project: null as unknown as PluginInput["project"],
    directory,
    worktree: "",
    experimental_workspace: { register: () => {} },
    serverUrl: new URL("http://localhost"),
    $: null as unknown as PluginInput["$"],
  }
}

describe("plugin activation is not blocked by background subsystems", () => {
  it("defers graphSync, cli-anything and the skills watcher past setup()", async () => {
    const calls = { graphSync: 0, cliAnything: 0, watcher: 0 }
    const plugin = createMetaGovernorPlugin(
      {
        enabled: true,
        graphSync: { enabled: true, autoInstall: false, installTimeoutMs: 10 },
      },
      {
        __test_runGraphSync: fakeGraphSync(() => {
          calls.graphSync += 1
        }),
        __test_runCliAnythingSync: fakeCliAnything(() => {
          calls.cliAnything += 1
        }),
        __test_startSkillsFsWatcher: fakeWatcher(() => {
          calls.watcher += 1
        }),
      },
    )

    const hooks = await plugin(makeInput("D:/test/project-activation"), {
      meta_governor: { enabled: true, protocolEnforcement: { enabled: false } },
    })

    // Activation finished while every background subsystem is still pending:
    // none of them may run before the host observes the resolved setup().
    expect(hooks.dispose).toBeDefined()
    expect(calls).toEqual({ graphSync: 0, cliAnything: 0, watcher: 0 })

    await new Promise((resolve) => setTimeout(resolve, 50))

    expect(calls).toEqual({ graphSync: 1, cliAnything: 1, watcher: 1 })
  })
})
