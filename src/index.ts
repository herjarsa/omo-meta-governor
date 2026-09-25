import { createMetaGovernorPlugin } from "./plugin"
import type { Hooks, PluginInput, PluginOptions } from "@opencode-ai/plugin"
import { Plugin as V2Plugin } from "@opencode/plugin"
import { createV2Setup } from "./v2/setup.js"

/**
 * @herjarsa/omo-meta-governor — Self-judging agent orchestration layer.
 *
 * Registers a `tool.execute.after` hook. The MetaGovernor reads session
 * signals, scores them against weighted evidence, and dispatches decisions.
 *
 * Install:
 *   npm install @herjarsa/omo-meta-governor
 *
 * Configure:
 * ```jsonc
 * {
 *   "meta_governor": { "enabled": true }
 * }
 * ```
 *
 * v0.19.6 fix (loader contract): the opencode 1.18.16 plugin loader
 * (binary `uk()`) iterates `Object.values()` of EVERY export of the entry
 * module and throws `TypeError("Plugin export is not a function")` on the
 * first export that is neither a function nor an object with a callable
 * `.server`. v0.19.4/0.19.5 exported 50+ runtime symbols (config objects,
 * `DEFAULT_PROTOCOL_PATH` string, non-callable dual-shape instances), so
 * the loader always tripped on the first invalid one.
 *
 * v0.50.1 dual shape (object-spread, per the official V1→V2 migration
 * guide): the entry exports exactly ONE runtime symbol — a plain object
 * `{ id, setup, server }`. The V2 host reads `.id`/`.setup`; the V1 loader
 * (`PluginModule` branch, supported since 1.18.29) reads `.server`.
 * `uk()` iteration only sees the single `default` export, which is an
 * object with a callable `.server`, so it passes. The previous
 * function-attach shape (v0.50.0) kept V1 green on all versions but the V2
 * host never called `.setup` off a function export — the plugin imported
 * (top-level "loaded" log) yet stayed dead. Object-spread is the documented
 * dual shape; V1 <1.18.29 (function-only loaders) is no longer supported.
 * All utility exports moved to the "./lib" subpath.
 */
const _plugin = createMetaGovernorPlugin()

/**
 * V1 server shape: `(input, options) => Hooks` (PluginModule.server).
 * Invokes the factory with the loader-provided input so the returned
 * value is the HOOKS object (tool.execute.after, ...), not the factory.
 */
function omoMetaGovernorServer(input: PluginInput, options?: PluginOptions): Promise<Hooks> {
  return _plugin(input, options)
}

// ─── Dual V1+V2 default export (opencode v2 / @opencode/plugin) ───
// NOTE: `createV2Setup()` already returns the full V2 plugin object
// `{id, setup}` (not a bare setup fn), so it goes straight through
// `V2Plugin.define` — do NOT wrap it as `{id, setup: createV2Setup()}`.
const v2def = V2Plugin.define(createV2Setup())

const omoMetaGovernorDual = {
  ...v2def,
  id: "omo-meta-governor",
  server: omoMetaGovernorServer,
}

export default omoMetaGovernorDual

// ─── Type-only re-exports (erased at runtime — safe for the loader) ───
export type {
  Decision,
  DecisionContext,
  DecisionHandlerConfig,
  DecisionHandlerInput,
  DecisionHandlerOutput,
  Deviation,
  Evidence,
  EvidenceContribution,
  InterventionConfig,
  InterventionMode,
  LearnFromOutcomeInput,
  LearnFromOutcomeOutput,
  MemoryRead,
  MemoryBackends,
  AgentmemoryWriteBackend,
  MetaGovernorInput,
  MetaGovernorOutput,
  OrchestratorConfig,
  ScoringConfig,
  ScoringResult,
  SlotMemory,
  TokenPredictorConfig,
  TokenPredictorInput,
  TokenPredictorOutput,
  ClosedLoopConfig,
} from "./types"
export type {
  ConfigFileSources,
  ConfigFileResult,
} from "./config-file"
export type {
  GraphSyncConfig,
  GraphSyncResult,
  GraphSyncCode,
  ToolAvailability,
} from "./graph-sync"
export type { JsonSchema, JsonSchemaProperty } from "./generate-schema"
export type { GraphToolKind, GraphInvocationResult, GraphRetrievalConfig, InvokeOptions } from "./graph-retrieval"
export type { ProtocolViolation, ProtocolEnforcementSessionState } from "./types"
export type { MetaGovernorPluginConfig } from "./config"
export type { MetaGovernorPluginDeps } from "./plugin"
export type { RecoveryOutcome } from "./post-repair-recorder"


