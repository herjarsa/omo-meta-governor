/**
 * Hermetic test helper: wraps `createMetaGovernorPlugin` with every DI seam
 * stubbed so tests never spawn real npx/pip/graphify/cli-hub subprocesses.
 *
 * v0.35.0 (P0 audit fix F0): prior to this helper, 25+ tests across
 * compaction-loop-guard.test.ts, plugin.test.ts, intervention-fix.test.ts,
 * persist-retry.test.ts leaked Windows children and stalled bun's test runner
 * with 5000ms timeouts. The helper centralises the seam injection so future
 * tests just call `createHermeticPlugin()` and stay hermetic.
 */
import { createMetaGovernorPlugin, type MetaGovernorPluginDeps } from "../plugin";
import type { MetaGovernorPluginConfig } from "../config";

export function noopRunner(_cmd: string): number {
  return 0;
}

/**
 * Returns a Plugin function equivalent to `createMetaGovernorPlugin(config)`
 * but with every DI seam replaced by no-ops. Disables `graphSync` and
 * `cliAnything` defaults to prevent subprocess spawns in tests.
 */
export function createHermeticPlugin(
  config: MetaGovernorPluginConfig = {},
  extraDeps: Partial<MetaGovernorPluginDeps> = {},
): ReturnType<typeof createMetaGovernorPlugin> {
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
    __test_runCliAnythingSync: async () => ({
      attempted: false,
      codes: ["cli-hub-version-probed"],
      availability: { cliHub: false, cliHubVersion: null, metaSkill: false },
      alreadyInitialized: true,
    }),
    __test_persistSessionMessage: async () => ({
      ok: true,
      messageID: null,
      error: null,
      durationMs: 0,
    }),
    __test_persistRetryDelayMs: 0,
    ...extraDeps,
  };
  return createMetaGovernorPlugin(
    {
      graphSync: { enabled: false, autoInstall: false, ...config.graphSync },
      cliAnything: { enabled: false, ...config.cliAnything },
      ...config,
    },
    deps,
  );
}
