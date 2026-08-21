/**
 * @herjarsa/omo-meta-governor — utility exports (subpath "./lib").
 *
 * v0.19.6: all non-plugin runtime exports moved here from the entry
 * ".". The opencode plugin loader iterates every export of the entry
 * module, so runtime symbols that are neither functions nor objects
 * with a callable `.server` break plugin loading. Utilities stay
 * available to consumers via `import { ... } from "@herjarsa/omo-meta-governor/lib"`.
 */
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
export {
  loadProtocol,
  buildSystemInjection,
  auditToolCall,
  DEFAULT_PROTOCOL_PATH,
} from "./protocol-enforcer"
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
// v0.30 zombie-fix: re-export proc-guard primitives so the plugin entry
// (which bundles ./proc-guard directly) can be exercised from outside.
export {
  killProcessTree,
  isProcessAlive,
  trackPid,
  untrackPid,
  killTrackedProcesses,
  runGuarded,
  runGuardedSync,
  killOrphanedToolProcesses,
  installProcessExitHandlers,
  isOrphanSweepInstalled,
  type GuardedResult,
  type GuardedOptions,
} from "./proc-guard"
export { generateSchema, writeSchemaFile, type JsonSchema, type JsonSchemaProperty } from "./generate-schema"
export { SqliteBackend, getDefaultSqliteBackend } from "./sqlite-backend"
export { GraphRetrieval, getDefaultGraphRetrieval, hashQuery, type GraphToolKind, type GraphInvocationResult, type GraphRetrievalConfig, type InvokeOptions } from "./graph-retrieval"
export { loadOrchestratorConfigFromSources } from "./config"
export { isGitCommitCommand } from "./graph-sync"
export { extractBotFeedbackFromGhOutput } from "./plugin"
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
  ProtocolViolation,
  ProtocolEnforcementSessionState,
} from "./types"
