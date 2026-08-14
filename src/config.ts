import type {
  InterventionConfig,
  ModelOverrideConfig,
  OrchestratorConfig,
  PostWaveConfig,
  ProtocolEnforcementConfig,
  SkillPrimingConfig,
  SkillPrimingRouter,
  SkillPrimingTrigger,
} from "./types"
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
    /** v0.18.0: custom warning message template. */
    warnMessageTemplate?: string
    /** v0.18.0: custom escalation message template. */
    escalateMessageTemplate?: string
    /** v0.18.0: custom stop message template. */
    stopMessageTemplate?: string
  }

  /** Memory aggregator (PR 2) */
  memory?: {
    agentmemoryTimeoutMs?: number
    /** v0.18.0: alias for agentmemoryTimeoutMs (was the only name projected). */
    timeoutMs?: number
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
    /** v0.18.0: was silently dropped by loadOrchestratorConfig */
    paralysisThreshold?: number
    /** v0.18.0: was silently dropped by loadOrchestratorConfig */
    defaultEscalationTarget?: "oracle" | "user"
  }

  /** Closed-loop learning (PR 3) */
  closedLoop?: {
    enabled?: boolean
    minSeverityToLearn?: "leve" | "media" | "grave"
    maxLessonsPerSession?: number
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
    /** v0.15.0: split per-phase hint from terminal signal. See types.ts. */
    phaseAwareDoneSignal?: boolean
    /** v0.19.0: persist intervention messages to the session (TUI-visible). */
    persistToSession?: boolean
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

  /** Skill priming config (v0.20.0): proactive skill-selection nudge. */
  skillPriming?: {
    enabled?: boolean
    trigger?: SkillPrimingTrigger
    router?: SkillPrimingRouter
  }

  /** Post-wave workflow gate (v0.21.0): landing directives after Oracle-approved waves. */
  postWave?: PostWaveConfig
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
    // v0.18.0: support both `timeoutMs` and `agentmemoryTimeoutMs` (alias for back-compat)
    memory: {
      enabled: true,
      query: full.memory?.query ?? "meta_governor_context",
      timeoutMs: full.memory?.timeoutMs ?? full.memory?.agentmemoryTimeoutMs ?? 2000,
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
    // v0.18.0: project ALL scoring fields. Previously paralysisThreshold
    // and defaultEscalationTarget were silently dropped.
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
      ...(full.scoring?.paralysisThreshold !== undefined
        ? { paralysisThreshold: full.scoring.paralysisThreshold }
        : {}),
      ...(full.scoring?.defaultEscalationTarget !== undefined
        ? { defaultEscalationTarget: full.scoring.defaultEscalationTarget }
        : {}),
    },
    // v0.18.0: project all closedLoop fields, not just saveDecisions.
    // Previously maxLessonsPerSession, enabled, minSeverityToLearn, and
    // saveLessons were silently dropped.
    closedLoop: {
      ...baseClosedLoop,
      ...(full.closedLoop?.enabled !== undefined
        ? { enabled: full.closedLoop.enabled }
        : {}),
      ...(full.closedLoop?.minSeverityToLearn !== undefined
        ? { minSeverityToLearn: full.closedLoop.minSeverityToLearn }
        : {}),
      ...(full.closedLoop?.maxLessonsPerSession !== undefined
        ? { maxLessonsPerSession: full.closedLoop.maxLessonsPerSession }
        : {}),
      ...(full.closedLoop?.saveDecisions !== undefined
        ? { saveDecisions: full.closedLoop.saveDecisions }
        : {}),
      ...(full.closedLoop?.saveLessons !== undefined
        ? { saveLessons: full.closedLoop.saveLessons }
        : {}),
    },
    // v0.18.0: project all decision fields, including message templates.
    decision: {
      ...baseDecision,
      ...(full.decision?.maxHistoryPerSession !== undefined
        ? { maxHistoryPerSession: full.decision.maxHistoryPerSession }
        : {}),
      ...(full.decision?.forceContinueAfterStops !== undefined
        ? { forceContinueAfterStops: full.decision.forceContinueAfterStops }
        : {}),
      ...(full.decision?.warnMessageTemplate !== undefined
        ? { warnMessageTemplate: full.decision.warnMessageTemplate }
        : {}),
      ...(full.decision?.escalateMessageTemplate !== undefined
        ? { escalateMessageTemplate: full.decision.escalateMessageTemplate }
        : {}),
      ...(full.decision?.stopMessageTemplate !== undefined
        ? { stopMessageTemplate: full.decision.stopMessageTemplate }
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
      // v0.15.0: split per-phase hint (DONE) from terminal (PLAN-COMPLETE).
      // Default false (preserves v0.10.0–v0.14.x behavior). Users with
      // multi-phase plans opt in to phase-aware DONE gating.
      phaseAwareDoneSignal: full.intervention?.phaseAwareDoneSignal ?? false,
      // v0.19.0: persist interventions to the session so the user sees
      // them in the TUI. The transform push reaches the model but is never
      // persisted in OpenCode 1.18.x (no write path for synthetic messages).
      persistToSession: full.intervention?.persistToSession ?? true,
    } as InterventionConfig,
    // v0.21.0: project all postWave fields with defaults. `enabled` derives
    // from phaseAwareDoneSignal when the user hasn't set it explicitly.
    postWave: {
      enabled:
        full.postWave?.enabled ?? (full.intervention?.phaseAwareDoneSignal === true),
      repoMode: full.postWave?.repoMode ?? "auto",
      aasToolPrefix: full.postWave?.aasToolPrefix ?? "aas",
      ciTimeoutMs: full.postWave?.ciTimeoutMs ?? 600_000,
      maxRetriesPerWave: full.postWave?.maxRetriesPerWave ?? 1,
      reinjectCooldownMs: full.postWave?.reinjectCooldownMs ?? 60_000,
      respectSilentMode: full.postWave?.respectSilentMode ?? false,
      ...(full.postWave?.ownRepoDirective !== undefined
        ? { ownRepoDirective: full.postWave.ownRepoDirective }
        : {}),
      ...(full.postWave?.thirdPartyDirective !== undefined
        ? { thirdPartyDirective: full.postWave.thirdPartyDirective }
        : {}),
    } as PostWaveConfig,
    protocolEnforcement: {
      enabled: full.protocolEnforcement?.enabled ?? false,
      path: full.protocolEnforcement?.path,
      injectIntoSystem: full.protocolEnforcement?.injectIntoSystem ?? false,
      auditToolCalls: full.protocolEnforcement?.auditToolCalls ?? false,
    } as ProtocolEnforcementConfig,
    // v0.20.0: project all skillPriming fields with defaults.
    skillPriming: {
      enabled: full.skillPriming?.enabled ?? false,
      trigger: full.skillPriming?.trigger ?? "firstImplement",
      router: full.skillPriming?.router ?? "both",
    } as SkillPrimingConfig,
  }
}

/**
 * Check whether the MetaGovernor is enabled. Returns false if config is undefined.
 */
export function isMetaGovernorEnabled(
  config: Partial<MetaGovernorPluginConfig> | undefined,
): boolean {
  // v0.18.0: support both `enabled` at top level and the wrapped
  // `meta_governor.enabled` shape that OpenCode uses in opencode.jsonc.
  if (!config) return false
  if (config.enabled === true) return true
  const mg = (config as unknown as { meta_governor?: { enabled?: boolean } }).meta_governor
  return mg?.enabled === true
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
