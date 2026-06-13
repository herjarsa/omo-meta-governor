import type { PluginModule } from "@opencode-ai/plugin"
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
const pluginModule: PluginModule = {
  id: "omo-meta-governor",
  server: createMetaGovernorPlugin(),
}

export default pluginModule

export {
  createMetaGovernorPlugin,
  type MetaGovernorPluginDeps,
} from "./plugin"

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
export { loadOrchestratorConfigFromSources } from "./config"

export type { ProtocolViolation, ProtocolEnforcementSessionState } from "./types"
