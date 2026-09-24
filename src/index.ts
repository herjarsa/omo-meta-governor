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
 * The entry now exports exactly ONE runtime symbol: a callable function
 * that also carries `.id` and `.server` (pointing at itself), satisfying
 * both loader paths — `lV(...,"server","detect")` (PluginModule) and
 * `uk()` iteration (Plugin function) — with a single registration.
 * All utility exports moved to the "./lib" subpath.
 */
const _plugin = createMetaGovernorPlugin()

/**
 * Plugin function shape: `default(input, options) => Hooks`.
 * Also acts as PluginModule shape via the `.server` self-reference.
 */
function omoMetaGovernor(input: PluginInput, options?: PluginOptions): Promise<Hooks> {
  // Invoke the factory with the loader-provided input so the returned
  // value is the HOOKS object (tool.execute.after, ...), not the factory.
  return _plugin(input, options)
}
;(omoMetaGovernor as unknown as { id: string; server: typeof omoMetaGovernor }).id = "omo-meta-governor"
;(omoMetaGovernor as unknown as { id: string; server: typeof omoMetaGovernor }).server = omoMetaGovernor

// ─── V2 bridge (opencode v2 / @opencode/plugin) ───
// Export-shape decision: FUNCTION-ATTACH (not object-spread). The v0.19.6
// loader contract requires `typeof defaultExport === "function"` for the
// opencode 1.18.16 `uk()` iteration path — a plain-object default
// (`{...v2def, server}`) would only satisfy the PluginModule `.server`
// branch and risks tripping `uk()` on the inner `setup` function value.
// Attaching `.setup` to the proven function export keeps BOTH loader paths
// green (callable + `.server`) while exposing the V2 `{id, setup}` surface
// (functions are objects — the V2 host reads `.setup`/`.id` off it).
// NOTE: `createV2Setup()` already returns the full V2 plugin object
// `{id, setup}` (not a bare setup fn), so it goes straight through
// `V2Plugin.define` — do NOT wrap it as `{id, setup: createV2Setup()}`.
const v2def = V2Plugin.define(createV2Setup())
;(omoMetaGovernor as unknown as { setup: typeof v2def.setup }).setup = v2def.setup

export default omoMetaGovernor

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


