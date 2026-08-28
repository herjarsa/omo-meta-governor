import { homedir } from "node:os"
import { join } from "node:path"

import type {
  InterventionConfig,
  ModelOverrideConfig,
  OrchestratorConfig,
  PostWaveConfig,
  ProtocolEnforcementConfig,
  SkillHubConfig,
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
    /** @default "silent" */
    mode?: "silent" | "message" | "system"
    /** @default true */
    includeDecisionHistory?: boolean
    /** @default 5 */
    maxHistoryMessages?: number
    /** @default "stop" */
    minActionForMessage?: "warn" | "escalate" | "stop"
    /**
     * v0.10.0: rate-limit interventions to break instruction loops.
     * @default 3
     */
    maxInterventionsPerSession?: number
    /**
     * v0.10.0: stop injecting after <promise>DONE</promise> + Oracle verified.
     * @default true
     */
    respectDoneSignal?: boolean
    /**
     * v0.15.0: split per-phase hint from terminal signal. See types.ts.
     * @default false
     */
    phaseAwareDoneSignal?: boolean
    /**
     * v0.19.0: persist intervention messages to the session (TUI-visible).
     * @default true
     */
    persistToSession?: boolean
    /**
     * v0.31.1: overflow compaction loop guard. Defends against opencode
     * bug #27924 (recursive overflow-only compactions). When the guard
     * trips, the plugin flips opencode's autocontinue to disabled so the
     * model can resume its pending tasks.
     *
     * v0.34.2: defaults aligned to ON (was OFF in v0.31.x - v0.34.1).
     * Users upgrading from v0.34.0/0.34.1 should set nabled: false
     * explicitly if they relied on the previous OFF default.
     */
    compactionLoopGuard?: {
      /** @default true */
      enabled?: boolean
      /** @default 1 */
      maxOverflowRecoveries?: number
    }
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
    /** @default true */
    enabled?: boolean
    /** @default false */
    watch?: boolean
    /** @default true */
    autoInstall?: boolean
    /** @default 120000 */
    installTimeoutMs?: number
    /** v0.22.0: when true, graph-sync init sweeps orphaned graphify/codegraph
     * @default true
     * processes left by previous crashed runs. Default true. */
    killOrphanedOnInit?: boolean
    /**
     * v0.25.1: on plugin load, fetch origin and reindex if local HEAD is behind.
     * @default true
     */
    reindexOnFetch?: boolean
    /**
     * v0.25.1: branch to fetch + compare against.
     * @default "main"
     */
    fetchBranch?: string
    /** v0.26.0: auto-upgrade installed codegraph and graphify binaries on graph-sync init.
     * @default true
     * Default true. Tiered probe + pip --upgrade flag fixes 6 silent-failure bugs from v0.24.x. */
    autoUpgrade?: boolean
    /** v0.26.0: filesystem path for the upgrade cache file (tracks latest-known
     * @default "~/.omo-meta-governor/upgrade-cache.json"
     * codegraph/graphify versions to avoid re-fetching the npm/PyPI registry on every load). */
    upgradeCachePath?: string
    /** v0.26.0: when true, run 'graphify check-update' after upgrade and emit a
     * 'graphify-reextract-triggered' diagnostic code if the schema changed.
     * @default true
     * Default true. */
    checkGraphifyNeedsUpdate?: boolean
    /** v0.27.0: when true, register the project graph in the global graphify
     * registry after initial install (so 'graphify global list' surfaces it).
     * @default false
     * Default false (opt-in — multi-project users want explicit control). */
    addToGlobalGraph?: boolean
  }
  /** v0.28.0: CLI-Anything hub auto-install + auto-upgrade. Opt-in.
   *  When enabled, the plugin ensures `cli-anything-hub` (pip) and
   *  `cli-hub-meta-skill` (npx skills) are installed and current. */
  cliAnything?: {
    /** @default false */
    enabled?: boolean
    /** @default true */
    autoInstall?: boolean
    /** @default true */
    autoUpgrade?: boolean
    cachePath?: string
    /** @default 86400000 */
    upgradeCheckTtlMs?: number
    cliHubBin?: string
    skillsBin?: string
    /** @default "global" */
    installScope?: "global" | "project"
  }
  /** Skill priming config (v0.20.0): proactive skill-selection nudge. */
skillPriming?: {
    /** @default false */
enabled?: boolean
    /** @default "firstImplement" */
trigger?: SkillPrimingTrigger
    /** @default "both" */
    router?: SkillPrimingRouter
    /** v0.34.0: enforcement mode for the skill-priming directive. */
    /** @default "directive" */
    enforceMode?: "directive" | "block"
}
  /** Skill hub config (v0.32.0): registry-backed catalog + hybrid search. */
  skillHub?: {
    /** @default true */
    enabled?: boolean
    /** @default 3600000 */
    syncIntervalMs?: number
    bootstrapUrl?: string
    searchFallbackUrl?: string
    downloadBaseUrl?: string
    embedBaseUrl?: string
    embedModel?: string
    minInstalls?: number
    filterDuplicates?: boolean
    depsCheck?: boolean
    choreDir?: string
    /**
     * v0.35.0: write fetched hub skills to <cwd>/.agents/skills/<slug>/SKILL.md.
     * @default true
     */
    autoMaterialize?: boolean
  }

  /** Post-wave workflow gate (v0.21.0): landing directives after Oracle-approved waves. */
  postWave?: PostWaveConfig
  /**
   * v0.25.0: explicit routing between codegraph and graphify.
   * "auto" (default) | "codegraph" | "graphify" | "alternate".
   */
  graphRetrieval?: {
    /** @default "auto" */
    preferredTool?: "auto" | "codegraph" | "graphify" | "alternate"
    /** v0.27.0: when true, prefer the locally-installed codegraph binary
     * @default false
     * (node_modules/.bin/codegraph) over the npx-resolved one. Default false. */
    preferLocalCodegraph?: boolean
    /** v0.27.0: route omo_search queries to codegraph `context` instead of
     * `explore`. Default false. context returns a focused code window; explore
     * @default false
     * returns a conceptual explanation. */
    contextRouting?: boolean
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
      // v0.31.1: overflow loop guard. Defaults to OFF (opt-in) so users
      // upgrading from v0.30.x do not get a silent behavior change. Set
      // enabled:true if you are affected by opencode issue #27924 (recursive
      // overflow-only compactions). Max consecutive overflows tolerated
      // before the guard flips autocontinue to disabled.
      compactionLoopGuard: {
        // v0.34.2: defaults aligned to schema/orchestrator intent. v0.34.1
        // had false/2 in config.ts but true/1 in orchestrator.ts +
        // generate-schema.ts — drift left users without the opencode #27924
        // defense enabled by default.
        enabled:
          full.intervention?.compactionLoopGuard?.enabled ?? true,
        maxOverflowRecoveries: Math.max(
          1,
          full.intervention?.compactionLoopGuard?.maxOverflowRecoveries ?? 1,
        ),
      },
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
    // v0.33.1: enabled defaults to TRUE so the skill workflow fires out of the box;
    // router default changed from 'both' to 'registry' since AAS MCP is retired.
    skillPriming: {
      enabled: full.skillPriming?.enabled ?? true,
      trigger: full.skillPriming?.trigger ?? "firstImplement",
      router: full.skillPriming?.router ?? "registry",
      // v0.34.0: opt-in enforcement. Default 'directive' = backward-compat.
      enforceMode: full.skillPriming?.enforceMode ?? "directive",
    },
skillHub: {
      enabled: full.skillHub?.enabled ?? false,
      syncIntervalMs: full.skillHub?.syncIntervalMs ?? 86400000,
      bootstrapUrl: full.skillHub?.bootstrapUrl ?? "https://skills-library.com/api/skills.json",
      searchFallbackUrl: full.skillHub?.searchFallbackUrl ?? "https://skills.sh/api/search",
      downloadBaseUrl: full.skillHub?.downloadBaseUrl ?? "https://skills.sh/api/download",
      embedBaseUrl: full.skillHub?.embedBaseUrl ?? "http://127.0.0.1:3114/v1",
      embedModel: full.skillHub?.embedModel ?? "bge-m3",
      minInstalls: full.skillHub?.minInstalls ?? 0,
      filterDuplicates: full.skillHub?.filterDuplicates !== false,
      depsCheck: full.skillHub?.depsCheck !== false,
      choreDir: full.skillHub?.choreDir ?? join(homedir(), ".agents", "skills"),
      // v0.35.0: default true so hub-fetched skills land on disk and opencode can Read() them.
      autoMaterialize: full.skillHub?.autoMaterialize ?? true,
    } as SkillHubConfig,
    // v0.22.0: project graphSync killOrphanedOnInit with default true.
graphSync: {
      killOrphanedOnInit: full.graphSync?.killOrphanedOnInit ?? true,
      reindexOnFetch: full.graphSync?.reindexOnFetch !== false,
      fetchBranch: full.graphSync?.fetchBranch ?? "main",
      // v0.26.0: auto-upgrade + graphify check-update defaults.
      autoUpgrade: full.graphSync?.autoUpgrade !== false,
      upgradeCachePath: full.graphSync?.upgradeCachePath,
      checkGraphifyNeedsUpdate: full.graphSync?.checkGraphifyNeedsUpdate !== false,
      // v0.27.0: opt-in global graph registration.
      addToGlobalGraph: full.graphSync?.addToGlobalGraph === true,
},
    // v0.25.0: explicit codegraph/graphify routing.
    graphRetrieval: {
      preferredTool: full.graphRetrieval?.preferredTool ?? "auto",
      // v0.27.0: extended routing knobs.
      preferLocalCodegraph: full.graphRetrieval?.preferLocalCodegraph === true,
      contextRouting: full.graphRetrieval?.contextRouting === true,
    },
    // v0.28.0: CLI-Anything hub auto-install + auto-upgrade projection.
    cliAnything: {
      enabled: full.cliAnything?.enabled !== false,
      autoInstall: full.cliAnything?.autoInstall !== false,
      autoUpgrade: full.cliAnything?.autoUpgrade !== false,
      cachePath: full.cliAnything?.cachePath,
      upgradeCheckTtlMs: full.cliAnything?.upgradeCheckTtlMs,
      cliHubBin: full.cliAnything?.cliHubBin ?? "cli-hub",
      skillsBin: full.cliAnything?.skillsBin ?? "npx skills",
      installScope: full.cliAnything?.installScope ?? "global",
    },
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
