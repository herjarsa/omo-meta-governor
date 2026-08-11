import { createMetaGovernorPlugin } from "./plugin"

/**
 * @sisyphuslabs/omo-meta-governor — Self-judging agent orchestration layer.
 *
 * Default export is an OpenCode PluginModule that registers a
 * `tool.execute.after` hook. The MetaGovernor reads session signals,
 * scores them against weighted evidence, and dispatches decisions.
 *
 * Install:
 *   npm install @sisyphuslabs/omo-meta-governor
 *
 * Configure:
 * ```jsonc
 * {
 *   "meta_governor": {
 *     "enabled": true
 *   }
 * }
 * ```
 */
// v0.19.4 fix: dual-shape default export for max compatibility across
// opencode 1.18.x loaders. Some versions call `default(input, options)`
// directly (Plugin function path); others read `module.server(input,
// options)` (PluginModule path). Empirically verified that opencode
// 1.18.16 npm-package plugins sometimes load the module but never invoke
// the factory under `opencode serve` — the dual shape covers both
// invocation paths so whichever opencode picks, the hooks register.
const _plugin = createMetaGovernorPlugin()
;( _plugin as unknown as { id: string; server: typeof _plugin } ).id = "omo-meta-governor"
;( _plugin as unknown as { id: string; server: typeof _plugin } ).server = _plugin

/**
 * Dual-shape export for opencode plugin loader compatibility.
 *
 * The default export is simultaneously:
 * - a Plugin function: `default(input, options) => Promise<Hooks>`
 * - a PluginModule: `default.id`, `default.server(input, options)`
 *
 * `.server` points to the same callable as the default, so whichever
 * shape the opencode loader resolves, the factory fires exactly once.
 */
export const _pluginDual: Plugin & { id: string; server: Plugin } = _plugin as unknown as Plugin & {
  id: string
  server: Plugin
}

export default _pluginDual

/**
 * Named alias of the dual-shape export. Some opencode plugin loaders
 * resolve plugins by named export rather than default — exposing both
 * covers that third hypothetical path with zero cost.
 */
export const plugin = _pluginDual

export { createMetaGovernorPlugin, type MetaGovernorPluginDeps } from "./plugin"
export { logToFile } from "./file-logger"
export {
  runMetaGovernor,
  buildDecisionContext,
  defaultOrchestratorConfig,
} from "./orchestrator"
export {
  loadOrchestratorConfig,
  isMetaGovernorEnabled,
  type MetaGovernorPluginConfig,
} from "./config"

// Core module re-exports
export { score, defaultScoringConfig } from "./scoring-engine"
export { predict, defaultTokenPredictorConfig, calculateBurnRate } from "./token-predictor"
export { handleDecision, defaultDecisionHandlerConfig, trimHistory, countConsecutiveStops } from "./decision-handler"
export { observeAndLearn, defaultClosedLoopConfig } from "./closed-loop-learning"
export { aggregateRead } from "./memory-aggregator"
export { recordRecovery, type RecoveryOutcome } from "./post-repair-recorder"
export {
  storeDecision,
  takeDecision,
  hasDecision,
  takeAnyDecision,
  clearAll,
} from "./decision-store"

// Types
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
// Protocol enforcer
export {
  loadProtocol,
  buildSystemInjection,
  auditToolCall,
  DEFAULT_PROTOCOL_PATH,
} from "./protocol-enforcer"

// Config-file loader + graphSync + schema generator
export {
  stripJsoncComments,
  parseJsonc,
  loadJsoncFile,
  deepMerge,
  loadMetaGovernorConfig,
  getUserConfigPath,
  getProjectConfigPath,
  type ConfigFileSources,
  type ConfigFileResult,
} from "./config-file"
export {
  runGraphSync,
  stopWatches,
  resetInitializedProjects,
  type GraphSyncConfig,
  type GraphSyncResult,
  type GraphSyncCode,
  type ToolAvailability,
} from "./graph-sync"
export { generateSchema, writeSchemaFile, type JsonSchema, type JsonSchemaProperty } from "./generate-schema"
export { SqliteBackend, getDefaultSqliteBackend } from "./sqlite-backend"
export { GraphRetrieval, getDefaultGraphRetrieval, hashQuery, type GraphToolKind, type GraphInvocationResult, type GraphRetrievalConfig, type InvokeOptions } from "./graph-retrieval"
export { loadOrchestratorConfigFromSources } from "./config"

export type { ProtocolViolation, ProtocolEnforcementSessionState } from "./types"
