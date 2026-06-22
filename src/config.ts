import type { InterventionConfig, ModelOverrideConfig, OrchestratorConfig, ProtocolEnforcementConfig } from "./types"
import { defaultScoringConfig } from "./scoring-engine"
import { defaultDecisionHandlerConfig } from "./decision-handler"
import { defaultClosedLoopConfig } from "./closed-loop-learning"
import type { ConfigFileSources, ConfigFileResult } from "./config-file"

/**
 * MetaGovernor config schema exposed to users.
 * This is a Zod-free config interface since Zod parsing is optional
 * in the standalone plugin — the user provides JSON, we coerce with defaults.
 */
export interface MetaGovernorPluginConfig {
  /** Master feature flag — must be true to run the orchestrator. */
  enabled?: boolean

  /** Decision handler (PR 6) */
  decision?: {
    maxHistoryPerSession?: number
    forceContinueAfterStops?: number
  }

  /** Memory aggregator (PR 2) */
  memory?: {
    agentmemoryTimeoutMs?: number
    magicContextTimeoutMs?: number
    boulderStateTimeoutMs?: number
    query?: string
  }

  /** Token predictor (PR 4) */
  tokenPredictor?: {
    compactBurnRateThreshold?: number
    compactUsageThreshold?: number
    switchModelUsageThreshold?: number
    delegateConsecutiveHighBurn?: number
  }

  /** Scoring engine (PR 5) */
  scoring?: {
    continueThreshold?: number
    warnThreshold?: number
    escalateThreshold?: number
    stopThreshold?: number
  }

  /** Closed-loop learning (PR 3) */
  closedLoop?: {
    saveDecisions?: boolean
    saveLessons?: boolean
  }

  /** Model override for MetaGovernor internal LLM usage. */
  modelOverride?: ModelOverrideConfig

  /** Intervention config for visible decision injection. */
  intervention?: {
    mode?: "silent" | "message" | "system"
    includeDecisionHistory?: boolean
    maxHistoryMessages?: number
    minActionForMessage?: "warn" | "escalate" | "stop"
    /** v0.10.0: rate-limit interventions to break instruction loops. */
    maxInterventionsPerSession?: number
    /** v0.10.0: stop injecting after <promise>DONE</promise> + Oracle verified. */
    respectDoneSignal?: boolean
}

  /** Sisyphus protocol enforcement config. */
  protocolEnforcement?: {
    enabled?: boolean
    path?: string
    injectIntoSystem?: boolean
    auditToolCalls?: boolean
  }

  /** Graph sync config for auto-initializing codegraph/graphify. */
graphSync?: {
enabled?: boolean
    watch?: boolean
    autoInstall?: boolean
    installTimeoutMs?: number
}
}

/**
 * Project the full MetaGovernorPluginConfig into OrchestratorConfig.
 * Missing sub-configs fall back to module defaults.
 */
export function loadOrchestratorConfig(
  pluginConfig: Partial<MetaGovernorPluginConfig> | undefined,
): OrchestratorConfig {
  const full: MetaGovernorPluginConfig = {
    enabled: false,
    ...pluginConfig,
  }

  const baseScoring = defaultScoringConfig()
  const baseDecision = defaultDecisionHandlerConfig()
  const baseClosedLoop = defaultClosedLoopConfig()

  return {
    enabled: full.enabled === true,
    memory: {
      enabled: true,
      query: full.memory?.query ?? "meta_governor_context",
      timeoutMs: full.memory?.agentmemoryTimeoutMs ?? 2000,
    },
    tokenPredictor: {
      compactBurnRateThreshold:
        full.tokenPredictor?.compactBurnRateThreshold ?? 500,
      compactUsageThreshold:
        full.tokenPredictor?.compactUsageThreshold ?? 0.85,
      switchModelUsageThreshold:
        full.tokenPredictor?.switchModelUsageThreshold ?? 0.95,
      delegateConsecutiveHighBurn:
        full.tokenPredictor?.delegateConsecutiveHighBurn ?? 5,
    },
    scoring: {
      ...baseScoring,
      ...(full.scoring?.continueThreshold !== undefined
        ? { continueThreshold: full.scoring.continueThreshold }
        : {}),
      ...(full.scoring?.warnThreshold !== undefined
        ? { warnThreshold: full.scoring.warnThreshold }
        : {}),
      ...(full.scoring?.escalateThreshold !== undefined
        ? { escalateThreshold: full.scoring.escalateThreshold }
        : {}),
      ...(full.scoring?.stopThreshold !== undefined
        ? { stopThreshold: full.scoring.stopThreshold }
        : {}),
    },
    closedLoop: {
      ...baseClosedLoop,
      ...(full.closedLoop?.saveDecisions !== undefined
        ? { saveDecisions: full.closedLoop.saveDecisions }
        : {}),
    },
    decision: {
      ...baseDecision,
      ...(full.decision?.maxHistoryPerSession !== undefined
        ? { maxHistoryPerSession: full.decision.maxHistoryPerSession }
        : {}),
      ...(full.decision?.forceContinueAfterStops !== undefined
        ? { forceContinueAfterStops: full.decision.forceContinueAfterStops }
        : {}),
    },
    modelOverride: full.modelOverride
      ? {
          providerID: full.modelOverride.providerID,
          modelID: full.modelOverride.modelID,
          modelLimit: full.modelOverride.modelLimit,
          temperature: full.modelOverride.temperature ?? 0.2,
          topP: full.modelOverride.topP ?? 1,
          maxTokens: full.modelOverride.maxTokens ?? 2048,
          reasoning: full.modelOverride.reasoning ?? false,
          verbosity: full.modelOverride.verbosity ?? "minimal",
        }
      : undefined,
    intervention: {
      mode: full.intervention?.mode ?? "silent",
      includeDecisionHistory: full.intervention?.includeDecisionHistory ?? true,
      maxHistoryMessages: full.intervention?.maxHistoryMessages ?? 5,
      // v0.10.0: default is "stop" — see orchestrator.ts for rationale.
      minActionForMessage: full.intervention?.minActionForMessage ?? "stop",
      // v0.10.0: rate-limit interventions to break instruction loops.
      maxInterventionsPerSession:
        full.intervention?.maxInterventionsPerSession ?? 3,
      // v0.10.0: stop injecting after the agent signals <promise>DONE</promise>
      // AND Oracle has verified the work.
      respectDoneSignal: full.intervention?.respectDoneSignal ?? true,
    } as InterventionConfig,
    protocolEnforcement: {
      enabled: full.protocolEnforcement?.enabled ?? false,
      path: full.protocolEnforcement?.path,
      injectIntoSystem: full.protocolEnforcement?.injectIntoSystem ?? false,
      auditToolCalls: full.protocolEnforcement?.auditToolCalls ?? false,
    } as ProtocolEnforcementConfig,
  }
}

/**
 * Check whether the MetaGovernor is enabled. Returns false if config is undefined.
 */
export function isMetaGovernorEnabled(
  config: MetaGovernorPluginConfig | undefined,
): boolean {
  return config?.enabled === true
}

/**
 * Load orchestrator config from all available sources: config file (JSONC)
 * with priority: CLI inline > project config > user config > defaults.
 */
export async function loadOrchestratorConfigFromSources(
  sources: ConfigFileSources = {},
): Promise<OrchestratorConfig> {
  const { loadMetaGovernorConfig } = await import("./config-file")
  const result: ConfigFileResult = await loadMetaGovernorConfig(sources)
  return loadOrchestratorConfig(result.config)
}
