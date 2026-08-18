import type {
  Hooks,
  Plugin,
  PluginInput,
  PluginOptions,
} from "@opencode-ai/plugin";
import { randomUUID as crypto_randomUUID } from "node:crypto";
import type {
  AgentmemoryWriteBackend,
  DecisionHandlerOutput,
  MemoryBackends,
  MetaGovernorInput,
} from "./types";
import {
  runGraphSync,
  trackSession,
  untrackSession,
isGitCommitCommand,
  triggerReindex,
  detectRemoteNewCommits,
} from "./graph-sync";
import { runMetaGovernor } from "./orchestrator";
import { getDefaultSqliteBackend } from "./sqlite-backend";
import {
  buildOmoSearchTool,
  buildOmoRecallTool,
  buildOmoHealthTool,
  buildOmoFindTool,
  buildOmoImpactTool,
  buildOmoRememberTool,
  buildOmoRecallMcpTool,
  buildOmoPathTool,
  buildOmoExplainTool,
} from "./custom-tools";
import { getMCPClient } from "./mcp-client";
import {
  setSessionClient,
  promptAgent,
  hasSessionClient,
  buildEscalationPrompt,
  persistSessionMessage,
  promptAgentText,
} from "./session-bridge";
import { PendingDeliveryRegistry } from "./delivery-registry";
import { setPendingDeliveryRegistry } from "./custom-tools";
import { LOG_PATH, logToFile } from "./file-logger";
import { resolve } from "node:path";
import { homedir } from "node:os";
import { describeLogFile } from "./health";
import { createMetricsCollector } from "./metrics";
import {
  loadOrchestratorConfig,
  type MetaGovernorPluginConfig,
} from "./config";
import { loadMetaGovernorConfig } from "./config-file";
import { storeDecision, takeDecision } from "./decision-store";
import { GraphRetrieval, getDefaultGraphRetrieval, configureDefaultGraphRetrieval } from "./graph-retrieval";
import { AuditStateCache } from "./audit-state-cache";
import { DEFAULT_VERSION } from "./metrics";
import { statSync, readFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { join } from "node:path";
import {
  loadProtocol,
  buildSystemInjection,
  auditToolCall,
  DEFAULT_PROTOCOL_PATH,
} from "./protocol-enforcer";
import {
  buildSkillPrimingMessage,
  shouldInjectSkillPriming,
  IMPLEMENTATION_TOOLS,
} from "./skill-priming";

/**
 * Dependencies required by the MetaGovernor plugin.
 * All are optional - features degrade gracefully when backends are unavailable.
 */
export interface MetaGovernorPluginDeps {
  backends?: MemoryBackends;
  writeBackend?: AgentmemoryWriteBackend;
  providerID?: () => string | undefined;
  modelID?: () => string | undefined;
  // v0.11.0: test-only hooks for hermetic assertions. NOT part of the
  // public contract; used by integration tests to verify the plugin
  // triggered an event without depending on filesystem state.
  __test_onCommitTrigger?: (payload: {
    projectDir: string;
    command: string;
    sessionID: string;
  }) => void;
  /** v0.21.0: test-only hook — asserts runGraphSync is invoked with the
   * session's projectDir (fix: was module-load cwd under serve). */
  __test_onGraphSyncInit?: (payload: { projectDir: string }) => void;
  /** v0.21.0: test-only DI seam — replaces the REAL runGraphSync so hermetic
   * placement tests never spawn npx/pip/graphify. Avoids mock.module (which
   * leaks across test files sharing a Bun worker — broke CI on macOS). */
  __test_runGraphSync?: typeof import("./graph-sync").runGraphSync;
}

// - Helpers

const ACTION_SEVERITY: Record<DecisionHandlerOutput["action"], number> = {
  continue: 0,
  warn: 1,
  escalate: 2,
  stop: 3,
};

function meetsMinAction(
  action: DecisionHandlerOutput["action"],
  minAction: "warn" | "escalate" | "stop",
): boolean {
  return ACTION_SEVERITY[action] >= ACTION_SEVERITY[minAction];
}

function generateID(): string {
  return `mg-${crypto_randomUUID()}`;
}

/**
 * Extract a search query from tool args. For `grep`, the query is the
 * `pattern` field. For `glob`, the query is the `pattern` field. Returns
 * null if no usable query can be extracted.
 */
function extractQueryFromArgs(toolInput: {
  tool: string;
  args?: unknown;
}): string | null {
  const args = (toolInput as { args?: Record<string, unknown> }).args;
  if (!args || typeof args !== "object") return null;
  // Common arg names for grep/glob across OpenCode versions
  const candidates = [
    "pattern",
    "query",
    "path",
    "glob",
    "regex",
    "include_pattern",
  ];
  for (const key of candidates) {
    const v = (args as Record<string, unknown>)[key];
    if (typeof v === "string" && v.trim().length > 0) return v.trim();
  }
  return null;
}

// Module-level metrics collector â€” shared across all invocations of the plugin
const metricsCollector = createMetricsCollector({
  sessionID: "__global__",
  global: true,
  version: DEFAULT_VERSION,
});
const healthFilePath = resolve(
  homedir(),
  ".config",
  "opencode",
  "meta-governor-health.json",
);

// - Plugin factory

export function createMetaGovernorPlugin(
  config: MetaGovernorPluginConfig = {},
  deps: MetaGovernorPluginDeps = {},
): Plugin {
  // v0.13.0: lazy graph-dir detection via the graph-retrieval layer.
  // This fixes the race condition where static booleans were set at load
  // time before async runGraphSync() could create the directories.
  // The booleans below remain for backwards-compat with AuditContext.
  const graphRetrieval = getDefaultGraphRetrieval();
  // v0.17.0 (F3.6): track bridge tool dispatches and verify delivery.
  const deliveryRegistry = new PendingDeliveryRegistry();
  // Inject the registry into the custom-tools module so bridge tools
  // can register pending dispatches + poll for delivery.
  setPendingDeliveryRegistry(
    deliveryRegistry as unknown as Parameters<
      typeof setPendingDeliveryRegistry
    >[0],
  );
  const cwd = process.cwd();

  // v0.13.1: initialize custom tools for the LLM to call.
  const sqlite = getDefaultSqliteBackend();
  const omoSearchTool = buildOmoSearchTool({ graphRetrieval, cwd });
  const omoRecallTool = buildOmoRecallTool({ sqlite });
  const omoHealthTool = buildOmoHealthTool({
    metrics: metricsCollector,
    logFilePath: LOG_PATH,
    healthFilePath: healthFilePath,
  });
  // v0.14.0: extended tools (CodeGraph sub-commands)
  const omoFindTool = buildOmoFindTool({ cwd });
  const omoImpactTool = buildOmoImpactTool({ cwd });
  // v0.14.0: OpciÃ³n A pivot â€” tools that bridge to MCP servers via session.prompt()
  const omoRememberTool = buildOmoRememberTool({
    onDispatch: ({ sessionID, mcpTool, mcpArgs }) => {
      deliveryRegistry.register({ sessionID, mcpTool, mcpArgs });
    },
  });
  const omoRecallMcpTool = buildOmoRecallMcpTool({
    onDispatch: ({ sessionID, mcpTool, mcpArgs }) => {
      deliveryRegistry.register({ sessionID, mcpTool, mcpArgs });
    },
  });
  const omoPathTool = buildOmoPathTool({ cwd });
  const omoExplainTool = buildOmoExplainTool({ cwd });

  // Log startup so the user can see the plugin is loaded. The version is
  // prepended to the message (and included in the structured fields) so
  // OpenChamber's startup log shows exactly which release is loaded —
  // without this, a stale cache could serve an older bundle silently
  // (user-reported 14/08/2026, after publishing v0.21.0 with `@latest`).
  logToFile("info", `v${DEFAULT_VERSION} MetaGovernor plugin loaded`, {
    version: DEFAULT_VERSION,
    build: "0.19.5-instr",
    cwd,
    projectHasCodegraph: graphRetrieval.hasCodegraphDir(cwd),
    projectHasGraphify: graphRetrieval.hasGraphifyDir(cwd),
  });

  // v0.24.3: detect stale npm cache. When opencode caches an older version,
  // the plugin loads silently with outdated code. This async check runs
  // once at load time and warns the user if a newer version exists.
  (async () => {
    try {
      const { execSync } = await import("node:child_process");
      const latest = execSync("npm view @herjarsa/omo-meta-governor version", {
        timeout: 5000,
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
      }).trim();
      if (latest && latest !== DEFAULT_VERSION) {
        logToFile(
          "warn",
          `STALE_CACHE: loaded v${DEFAULT_VERSION} but npm has v${latest}. Run: npm cache clean --force && rm -rf ~/.cache/opencode/packages/@herjarsa/omo-meta-governor*`,
        );
      }
    } catch {
      // npm unreachable or not installed — don't block plugin load
    }
  })();

  const plugin: Plugin = async (
    _input: PluginInput,
    options?: PluginOptions,
  ): Promise<Hooks> => {
    // v0.19.3 debug instrumentation: prove whether opencode invokes the
    // factory in serve mode and what input it receives. The version is
    // prepended so the user can confirm from the OpenChamber startup log
    // which release actually loaded (cache may serve an older bundle).
    logToFile("info", `v${DEFAULT_VERSION} factory_invoked`, {
      version: DEFAULT_VERSION,
      hasInput: _input != null,
      inputDir: _input?.directory ?? null,
      inputKeys: _input ? Object.keys(_input) : [],
    });
    // Hydrates the MCPClient singleton on first plugin
    // invocation. Safe to call multiple times â€” setClient is idempotent.
    // v0.16.0: F3.4 â€” runtime guard instead of "as never". The cast
    // hid incompatibilities between OpenCode plugin API versions; the
    // guard makes failures visible (we skip hydration) instead of
    // silently feeding the wrong shape to setClient.
    const clientCandidate = _input.client;
    const safeClient =
      clientCandidate != null &&
      typeof clientCandidate === "object" &&
      "tool" in clientCandidate
        ? clientCandidate
        : null;
    getMCPClient().setClient(safeClient as never); // safeClient narrowed to null | valid-shape
    setSessionClient(safeClient as never);

    // 1. Load config from three sources (priority: CLI > project > user).
    //    The plugin file loader reads ~/.config/opencode/omo-meta-governor.jsonc
    //    and .opencode/omo-meta-governor.jsonc automatically. Without this call,
    //    `mergedConfig.enabled` resolves to false unless the user explicitly
    //    passes config inline via the OpenCode plugin tuple â€” and most users
    //    register the plugin as a bare string, so the hooks never fire.
    //
    //    v0.18.1 fix: load config file unconditionally. Use _input.directory
    //    (the OpenCode project root) as the projectDir. Fall back to cwd
    //    when not provided (for test environments).
    let fileConfigSource: Awaited<ReturnType<typeof loadMetaGovernorConfig>>;
    try {
      fileConfigSource = await loadMetaGovernorConfig({
        projectDir: _input.directory ?? cwd,
      });
    } catch (err: unknown) {
      logToFile("error", "factory_config_load_failed", {
        message: err instanceof Error ? err.message : String(err),
        stack: err instanceof Error ? err.stack?.slice(0, 800) : undefined,
      });
      throw err;
    }
    const rawConfig = {
      ...config,
      ...fileConfigSource.config,
      ...((options?.meta_governor as MetaGovernorPluginConfig) ?? {}),
    };
    let mergedConfig: ReturnType<typeof loadOrchestratorConfig>;
    try {
      mergedConfig = loadOrchestratorConfig(rawConfig);
    } catch (err: unknown) {
      logToFile("error", "factory_orchestrator_config_failed", {
        message: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }
    // v0.25.0: explicit codegraph/graphify routing — push the config into the
    // GraphRetrieval singleton so omo_search/omo_path/omo_explain honor it.
    configureDefaultGraphRetrieval({
      preferredTool: mergedConfig.graphRetrieval.preferredTool,
    });
    if (fileConfigSource.sources.length > 0) {
      logToFile("info", `v${DEFAULT_VERSION} config_loaded`, {
        version: DEFAULT_VERSION,
        sources: fileConfigSource.sources,
        effectiveSource: fileConfigSource.effectiveSource,
        enabled: mergedConfig.enabled,
      });
    }

    // v0.21.0 (post-wave W6): startup warning when the user disabled the
    // done-signal latch (respectDoneSignal=false) but enabled the post-wave
    // gate — the two are conceptually related but independent: post-wave
    // directives fire on `oracleInvoked && PHASE-N-COMPLETE` regardless of
    // whether intervention is being latched (Oracle note N3, 14/08/2026).
    if (
      mergedConfig.postWave?.enabled === true &&
      mergedConfig.intervention.respectDoneSignal === false
    ) {
      logToFile("info", "post_wave_warning", {
        message:
          "postWave.enabled=true but intervention.respectDoneSignal=false: post-wave " +
          "directives still fire on Oracle-verified PHASE-N-COMPLETE, but the done-signal " +
          "latch is off (intervention is not auto-disabled at plan end).",
      });
    }

    // v0.21.0: projects where the background graphSync completed and BOTH
    // index tools are available (codegraph + graphify) — messages.transform
    // nudges the agent to use them once per session. Declared BEFORE the
    // graphSync block: the init seam resolves immediately and its .then
    // microtask runs during the first await of this invocation — a const
    // declared later in the same scope would hit the TDZ (14/08/2026).
    const graphSyncReadyProjects = new Set<string>();
    const graphSyncReadyNotified = new Set<string>();

    // v0.21.0: graphSync init runs at FACTORY INVOCATION with the session's
    // project directory, not at module load with process.cwd() (which under
    // `opencode serve` is the SERVER's cwd — the bug that left session
    // projects uninitialized). The initializedProjects Set in graph-sync.ts
    // keeps it once-per-project. graphSync is tool infrastructure, so it must
    // run even when governance is disabled — hence BEFORE the early return.
    //
    // Precedence for graphSync settings: config arg (opencode.jsonc / tests)
    // > dedicated file config > CLI options. The generic rawConfig spread
    // gives the file config priority over the plugin arg, which would make
    // tests that pass graphSync:{enabled:false} (and users who disable it
    // inline) unexpectedly run real autoInstall when a user-level file config
    // enables it — so graphSync reads config.graphSync first.
    const sessionProjectDir = _input.directory
      ? resolve(_input.directory)
      : cwd;
    const rawGraphSync =
      config.graphSync ??
      (fileConfigSource.config as MetaGovernorPluginConfig | undefined)
        ?.graphSync ??
      (options?.meta_governor as MetaGovernorPluginConfig | undefined)
        ?.graphSync;
    const graphSyncEnabledAtInvocation = rawGraphSync?.enabled !== false;
    if (graphSyncEnabledAtInvocation) {
      // Test-only hook: assert placement without executing real CLI commands.
      deps.__test_onGraphSyncInit?.({ projectDir: sessionProjectDir });
      // Test-only DI seam: hermetic tests replace runGraphSync so the real
      // npx/pip/graphify never spawns (mock.module leaks across test files
      // sharing a Bun worker — broke CI on macOS).
      const runGraphSyncImpl = deps.__test_runGraphSync ?? runGraphSync;
      runGraphSyncImpl({
        enabled: true,
        watch: rawGraphSync?.watch ?? false,
        autoInstall: rawGraphSync?.autoInstall ?? true,
        installTimeoutMs: rawGraphSync?.installTimeoutMs ?? 60_000,
        killOrphanedOnInit: rawGraphSync?.killOrphanedOnInit ?? true,
        projectDir: sessionProjectDir,
      })
        .then((res) => {
          // v0.21.0: mark the project as ready when BOTH index tools are
          // available — messages.transform later nudges the agent to use
          // them (once per session). Best-effort; never throws.
          if (res?.attempted && res.availability.codegraph && res.availability.graphify) {
            graphSyncReadyProjects.add(sessionProjectDir);
          }
        })
        .catch(() => {});
      // v0.25.1: origin-fetch reindex watcher — if local HEAD is behind origin,
      // fetch and reindex so the agent sees fresh graph results on next tool call.
      // Fire-and-forget; never blocks the factory. Sits INSIDE the
      // graphSyncEnabledAtInvocation guard so tests with graphSync:{enabled:false}
      // never spawn real git processes.
      queueMicrotask(() => {
        try {
          const fetchBranch = mergedConfig.graphSync.fetchBranch
          const behind = detectRemoteNewCommits(sessionProjectDir, fetchBranch)
          if (behind > 0) {
            logToFile("info", `reindexOnFetch: ${behind} new commits on origin/${fetchBranch}, reindexing`)
            void triggerReindex(sessionProjectDir).catch((err) => {
              logToFile("warn", `reindexOnFetch failed: ${String(err)}`)
            })
          }
        } catch {
          // best-effort
        }
      })
    }

    // 2. If disabled, return empty hooks
    // 2. If disabled, still register custom tools (but skip governance hooks)
    if (!mergedConfig.enabled) {
      return {
        tool: {
          omo_search: omoSearchTool,
          omo_recall: omoRecallTool,
          omo_health: omoHealthTool,
          omo_find: omoFindTool,
          omo_impact: omoImpactTool,
          omo_remember: omoRememberTool,
          omo_recall_mcp: omoRecallMcpTool,
          omo_path: omoPathTool,
          omo_explain: omoExplainTool,
        },
      };
    }

    // 3. Resolve model settings from override or session
    const getProviderID = (): string | undefined =>
      mergedConfig.modelOverride?.providerID ?? deps.providerID?.();
    const getModelID = (): string | undefined =>
      mergedConfig.modelOverride?.modelID ?? deps.modelID?.();
    const getModelLimit = (): number =>
      mergedConfig.modelOverride?.modelLimit ?? 200_000;

    const providerID = getProviderID() ?? "unknown";
    const modelID = getModelID() ?? "unknown";

    // 4. Load protocol text (best-effort, cached once)
    let systemInjection: string | undefined;
    // v0.16.0: eagerly await protocol load + gate on a readiness flag.
    // Previously the load was fire-and-forget, so system.transform could
    // fire before systemInjection was set, silently skipping injection.
    if (
      mergedConfig.protocolEnforcement.enabled ||
      mergedConfig.protocolEnforcement.injectIntoSystem
    ) {
      const protocolPath =
        mergedConfig.protocolEnforcement.path ?? DEFAULT_PROTOCOL_PATH;
      try {
        const text = await loadProtocol(protocolPath);
        systemInjection = buildSystemInjection(text);
      } catch (err: unknown) {
        if (
          typeof console !== "undefined" &&
          mergedConfig.modelOverride?.verbosity !== "silent"
        ) {
          console.warn(
            "[meta-governor] could not load protocol:",
            err instanceof Error ? err.message : err,
          );
        }
      }
    }

    // 5. Per-session audit state (v0.10.0: adds DONE tracking + intervention cap)
    type AuditState = {
      memoryToolsUsed: string[];
      hasCodegraphDir: boolean;
      hasGraphifyDir: boolean;
      oracleInvoked: boolean;
      filesChanged: number;
      emptyRecall: boolean;
      escalationAttempted: boolean;
      recentToolCalls: string[];
      recentWriteContents: string[];
      /** v0.17.2: file paths from recent write tools. Used by Gap Q to
       *  populate LearnFromOutcomeInput.filesChanged so lesson extraction
       *  indexes file basenames for FTS lookup. */
      recentWriteFilePaths: string[];
      memorySaved: boolean;
      /** v0.17.2: accumulated protocol violations. Populated by the audit
       *  in tool.execute.before and threaded into MetaGovernorInput.deviations
       *  so the deviation-detector signal actually fires in production
       *  (Gap C fix). Decay applied each turn. Shape matches Deviation
       *  (category is the rule name from protocol-enforcer). */
      accumulatedDeviations: {
        severity: "leve" | "media" | "grave";
        category: string;
        detail: string;
        filePath?: string;
      }[];
      /** v0.17.2: rolling window of recent intervention texts. Populated
       *  by messages.transform when intervention fires. Surfaced back into
       *  the LLM context on subsequent interventions when
       *  intervention.includeDecisionHistory is true (Gap D fix). */
      recentInterventionTexts: string[];
      batchCompletions: number;
      /** v0.10.0: kept for legacy readers. Set by `<promise>DONE</promise>`
       *  (with optional `!`). In v0.15.0 phase-aware mode this is NOT used
       *  by the gate; see `phaseCompleteSignal` and `planCompleteSignal`. */
      taskDoneSignal: boolean;
      /** v0.15.0: set by `<promise>DONE</promise>` OR
       *  `<promise>PHASE-N-COMPLETE</promise>`. Per-phase hint only;
       *  only latches intervention in legacy (phaseAwareDoneSignal=false) mode. */
      phaseCompleteSignal: boolean;
      /** v0.15.0: set by `<promise>PLAN-COMPLETE</promise>`. Terminal signal;
       *  always latches intervention (when Oracle has verified). */
      planCompleteSignal: boolean;
      interventionCount: number;
      interventionDisabled: boolean;
      /** v0.17.2: per-session iteration counter. Incremented on each tool call
       *  so the iteration-budget signal in scoring can fire. Previously this
       *  was always 0 in the orchestrator input, making the 0.15-weight
       *  iteration-budget signal dead. */
      iteration: number;
      /** v0.24.0: true while a background Oracle task is in flight (run_in_background=true).
       *  Suppresses interventions during the Oracle execution window so the agent isn't
       *  pestered with directives while waiting for Oracle to return a verdict. */
      oracleInFlight: boolean;
      /** v0.24.0: timestamp when oracleInFlight was set. Used for timeout safety net (5 min). */
      oracleInFlightSinceMs: number | null;
      /** v0.24.0: timestamp when planCompleteSignal was last set. Used by clear gate to
       *  prevent stale latches from immediately clearing oracleInFlight. */
      signalAtMs: number;
      /** v0.17.0 (F5.4): count of lessons saved this session. Used to enforce maxLessonsPerSession. */
      lessonCount: number;
      /** v0.23.1: timestamp of last violation injection. Used by cooldown to break
       *  the feedback loop where violations trigger more violations. */
      lastViolationInjectionAtMs: number;
      /** v0.22.0 (post-wave W3): post-wave tracking fields. Consumed by the
       *  wave-gate (W4/W5) — purely additive in this wave; no behavior yet. */
      postWave: {
        currentWaveN: number | null;
        lastInjectedWaveN: number | null;
        lastInjectedAtMs: number | null;
        postWaveInjectionsThisWave: number;
        rulesReadForWave: Record<number, boolean>;
        oracleAfterPhaseAtMs: Record<number, number>;
        repoModeResolved: "own" | "third-party" | null;
      };
    };
    // v0.16.0: replaced unbounded Map with TTL+LRU-bounded AuditStateCache.
    // Capped at 100 sessions, 1h TTL. Prevents the C1/H16 memory leak.
    //
    // Concurrency model: Bun's runtime is single-threaded. Between two
    // synchronous statements, the event loop cannot be interrupted.
    // Therefore read-modify-write of state fields is atomic per-call.
    // If ported to a multi-threaded runtime, this becomes a TODO for
    // per-session mutex.
    const auditSessions = new AuditStateCache<AuditState>({
      maxEntries: 100,
      ttlMs: 60 * 60 * 1000,
    });

    // Pending protocol violations queue
    // Pending protocol violations queue
    // v0.16.0: TTL-wrapped queue (F1.3). Items expire after 5 minutes
    // to prevent memory growth if a session ends without consuming its queue.
    const pendingViolations = new Map<
      string,
      { items: string[]; expiresAtMs: number }
    >();
    const PENDING_TTL_MS = 5 * 60 * 1000;

    // v0.11.0: pending bot feedback (from `gh pr checks` / `gh pr view` output)
    const pendingBotFeedback = new Map<
      string,
      { items: string[]; expiresAtMs: number }
    >();

    // v0.11.0: whether the plan reminder has been injected for this session
    const planReminderSent = new Set<string>();
    // v0.20.0: whether the skill-priming nudge has been injected for this session
    const skillPrimingSent = new Set<string>();
    // v0.20.0: sessions where an implementation tool (write/edit/apply_patch/...)
    // was observed, tracked independently of the audit state — the audit state
    // only exists when protocolEnforcement.auditToolCalls is enabled, but the
    // firstImplement trigger must work under the default config too.
    const implementationToolsSeen = new Set<string>();
    // v0.21.0 (post-wave W6): per-session post-wave gate state, tracked
    // independently of the audit state (the audit state only exists when
    // protocolEnforcement.auditToolCalls is enabled, but the wave-gate must
    // work under the default config too). Shape mirrors the postWave block of
    // AuditState (plugin.ts:399-409).
    type PostWaveSessionState = {
      currentWaveN: number | null;
      lastInjectedWaveN: number | null;
      lastInjectedAtMs: number | null;
      postWaveInjectionsThisWave: number;
      rulesReadForWave: Record<number, boolean>;
      oracleAfterPhaseAtMs: Record<number, number>;
      repoModeResolved: "own" | "third-party" | null;
    };
    const createPostWaveSessionState = (): PostWaveSessionState => ({
      currentWaveN: null,
      lastInjectedWaveN: null,
      lastInjectedAtMs: null,
      postWaveInjectionsThisWave: 0,
      rulesReadForWave: {},
      oracleAfterPhaseAtMs: {},
      repoModeResolved: null,
    });
    const postWaveSessions = new Map<string, PostWaveSessionState>();
    // v0.10.0 / legacy detection imported below; closure removed in v0.15.0
    // in favor of the module-level detectors (detectDoneSignal,
    // detectPhaseCompleteSignal, detectPlanCompleteSignal). See the bottom
    // of this file for the export block.

    // v0.19.0: persist an intervention as a REAL session message via
    // session.prompt() so it is visible in the TUI and the session DB.
    // Fire-and-forget, best-effort: never blocks or breaks the transform.
    const persistIntervention = (sessionID: string, text: string): void => {
      if (!sessionID || !text) return;
      if (!mergedConfig.intervention.persistToSession) return;
      void persistSessionMessage(sessionID, text).then((res) => {
        if (!res.ok) {
          logToFile("warn", `persist intervention failed for ${sessionID}`, {
            error: res.error,
          });
        } else {
          logToFile("info", `persisted intervention for ${sessionID}`);
        }
      });
    };

    return {
      // - Tool execute before (protocol audit)
      // v0.17.1: also receive output so we can audit tool args (was {} before).
      "tool.execute.before": async (
        toolInput: { tool: string; sessionID: string; callID: string },
        _output: { args: unknown },
      ): Promise<void> => {
        if (!mergedConfig.enabled) return;
        if (!mergedConfig.protocolEnforcement.auditToolCalls) return;
        if (!toolInput.sessionID) return;

        let state = auditSessions.get(toolInput.sessionID);
        if (!state) {
          state = {
            memoryToolsUsed: [],
            hasCodegraphDir: graphRetrieval.hasCodegraphDir(cwd),
            hasGraphifyDir: graphRetrieval.hasGraphifyDir(cwd),
            oracleInvoked: false,
            filesChanged: 0,
            emptyRecall: false,
            escalationAttempted: false,
            recentToolCalls: [],
            recentWriteContents: [],
            recentWriteFilePaths: [],
            memorySaved: false,
            accumulatedDeviations: [],
            recentInterventionTexts: [],
            batchCompletions: 0,
            taskDoneSignal: false,
            phaseCompleteSignal: false,
            planCompleteSignal: false,
            interventionCount: 0,
            interventionDisabled: false,
            lessonCount: 0,
            lastViolationInjectionAtMs: 0,
            iteration: 0,
            oracleInFlight: false,
            oracleInFlightSinceMs: null,
            signalAtMs: 0,
            postWave: {
              currentWaveN: null,
              lastInjectedWaveN: null,
              lastInjectedAtMs: null,
              postWaveInjectionsThisWave: 0,
              rulesReadForWave: {},
              oracleAfterPhaseAtMs: {},
              repoModeResolved: null,
            },
          };
          auditSessions.set(toolInput.sessionID, state);
        }

        // v0.24.0: skip audit + deviation accumulation when Oracle is in flight.
        // The agent is correctly idle waiting for Oracle, not making errors.
        if (state?.oracleInFlight) {
          return;
        }

        if (systemInjection) {
          console.log(
            "[meta-governor] protocol loaded, system injection ready",
          );
        }

        // v0.17.1: pass _output.args (was {}) so the audit actually sees
        // file content for type-suppression and empty-catch detection.
        const violations = auditToolCall(toolInput.tool, _output.args, {
          memoryToolsUsed: state.memoryToolsUsed,
          hasCodegraphDir: state.hasCodegraphDir,
          hasGraphifyDir: state.hasGraphifyDir,
          oracleInvoked: state.oracleInvoked,
          filesChanged: state.filesChanged,
          emptyRecall: state.emptyRecall,
          escalationAttempted: state.escalationAttempted,
          recentToolCalls: state.recentToolCalls,
          recentWriteContents: state.recentWriteContents,
          memorySaved: state.memorySaved,
          batchCompletions: state.batchCompletions,
        });

        if (violations.length > 0) {
          // v0.23.1: cooldown check — prevent feedback loop where violations
          // trigger more violations. During cooldown, log but don't queue.
          const COOLDOWN_MS = 30_000; // 30 seconds
          const lastInjection = state.lastViolationInjectionAtMs ?? 0;
          if (lastInjection > 0 && Date.now() - lastInjection < COOLDOWN_MS) {
            logToFile(
              "info",
              `violation during cooldown (${Math.round((COOLDOWN_MS - (Date.now() - lastInjection)) / 1000)}s remaining), skipping queue`,
            );
            // Still accumulate deviations for scoring, but don't queue for injection
            const newDeviations = violations.map((v) => ({
              severity: v.severity,
              category: v.rule,
              detail: v.detail,
            }));
            state.accumulatedDeviations = [
              ...state.accumulatedDeviations,
              ...newDeviations,
            ].slice(-5);
          } else {
            logToFile(
              "warn",
              `protocol violations on tool ${toolInput.tool}`,
              violations,
            );
            const existing =
              pendingViolations.get(toolInput.sessionID)?.items ?? [];
            for (const v of violations) {
              existing.push(
                `[${v.severity.toUpperCase()}] ${v.rule}: ${v.detail}`,
              );
            }
            pendingViolations.set(toolInput.sessionID, {
              items: existing,
              expiresAtMs: Date.now() + PENDING_TTL_MS,
            });
            // v0.17.2 (Gap C): accumulate violations in state so the
            // deviation-detector signal actually fires downstream. Decay the
            // window to the last 5 violations per session so a single bad
            // day doesn't poison scoring forever. Convert ProtocolViolation
            // → Deviation shape (rule → category).
            const newDeviations = violations.map((v) => ({
              severity: v.severity,
              category: v.rule,
              detail: v.detail,
            }));
            state.accumulatedDeviations = [
              ...state.accumulatedDeviations,
              ...newDeviations,
            ].slice(-5);
            // v0.23.1: record injection timestamp for cooldown
            state.lastViolationInjectionAtMs = Date.now();
          }
        } else {
          logToFile("info", `audit OK on tool ${toolInput.tool}`);
        }

        // v0.13.0: actually invoke codegraph/graphify when the agent is about
        // to do a search. This is the C2 fix â€” previously the plugin only
        // told the agent to use graph tools via prompt text. Now it runs them
        // and caches the result for system.transform to inject.
        if (
          (toolInput.tool === "grep" || toolInput.tool === "glob") &&
          (graphRetrieval.hasCodegraphDir(cwd) ||
            graphRetrieval.hasGraphifyDir(cwd))
        ) {
          const query = extractQueryFromArgs(toolInput);
          if (query) {
            // Fire-and-forget: never block tool.execute.before
            graphRetrieval
              .invoke(cwd, query, { timeoutMs: 5_000 })
              .then((result) => {
                if (result.result) {
                  graphRetrieval.cacheContext(
                    toolInput.sessionID,
                    query,
                    result.result,
                  );
                }
              })
              .catch(() => {
                // Best-effort: silently swallow errors
              });
          }
        }
      },

      // - Tool execute after (orchestrator + audit state update)
      "tool.execute.after": async (
        toolInput: {
          tool: string;
          sessionID: string;
          callID: string;
          args: unknown;
        },
        toolOutput: { title: string; output: string; metadata: unknown },
      ): Promise<void> => {
        if (!mergedConfig.enabled) return;

        // v0.17.0 (F3.6): when the LLM calls an MCP tool that was previously
        // dispatched via session-bridge, mark the pending delivery as
        // verified. This lets bridge tools report actual delivery status.
        try {
          deliveryRegistry.markDelivered({
            sessionID: toolInput.sessionID,
            mcpTool: toolInput.tool,
            mcpArgs: toolInput.args,
          });
        } catch {
          // best-effort
        }

        // v0.20.0: implementation-tool tracking independent of audit state
        // (see implementationToolsSeen above).
        if (IMPLEMENTATION_TOOLS.includes(toolInput.tool)) {
          implementationToolsSeen.add(toolInput.sessionID);
        }

        const sessionState = auditSessions.get(toolInput.sessionID);
        if (sessionState) {
          // v0.17.2: increment per-session iteration so the iteration-budget
          // signal (weight 0.15) actually fires downstream.
          sessionState.iteration++;
          sessionState.recentToolCalls = [toolInput.tool]
            .concat(sessionState.recentToolCalls)
            .slice(0, 20);

          const writeTools = [
            "write",
            "edit",
            "edit_block",
            "desktop-commander_write_file",
            "desktop-commander_edit_block",
          ];
          if (writeTools.includes(toolInput.tool)) {
            sessionState.filesChanged++;
            const content = (toolOutput.output ?? "").slice(0, 500);
            sessionState.recentWriteContents = [content]
              .concat(sessionState.recentWriteContents)
              .slice(0, 3);
            // v0.17.2 (Gap Q): capture file path so lesson extraction
            // can index file basenames for FTS lookup.
            const args = toolInput.args as Record<string, unknown> | undefined;
            const filePath = args?.filePath ?? args?.path;
            if (typeof filePath === "string" && filePath.length > 0) {
              sessionState.recentWriteFilePaths = [filePath]
                .concat(sessionState.recentWriteFilePaths)
                .slice(0, 10);
            }
          }

          const memoryTools = [
            "agentmemory_memory_recall",
            "agentmemory_memory_smart_search",
            "agentmemory_memory_save",
          ];
          const isMemoryTool = memoryTools.some((m: string) =>
            toolInput.tool.startsWith(m),
          );
          if (
            isMemoryTool &&
            !sessionState.memoryToolsUsed.includes(toolInput.tool)
          ) {
            sessionState.memoryToolsUsed.push(toolInput.tool);
          }

          if (toolInput.tool.startsWith("agentmemory_memory_save")) {
            const out = toolOutput.output ?? "";
            if (out.includes("saved") || out.includes("written")) {
              sessionState.memorySaved = true;
            }
          }

          if (toolInput.tool === "task") {
            const out = toolOutput.output ?? "";
            const args = toolInput.args as
              | { subagent_type?: string; run_in_background?: boolean }
              | undefined;
            const invokedOracle =
              args?.subagent_type === "oracle" ||
              out.includes("subagent_type=oracle");
            if (invokedOracle) {
              sessionState.oracleInvoked = true;
              // v0.24.0: if Oracle is running in background, suppress interventions
              // until Oracle returns. Without this, the agent's idle window triggers
              // noProgress + accumulating deviations -> intervention pile-up.
              if (args?.run_in_background === true) {
                sessionState.oracleInFlight = true;
                sessionState.oracleInFlightSinceMs = Date.now();
              }
            }
          }

          const outLower = (toolOutput.output ?? "").toLowerCase();
          if (
            toolInput.tool.includes("recall") &&
            (outLower.includes("returned empty") ||
              outLower.includes("no results"))
          ) {
            sessionState.emptyRecall = true;
          }

          if (
            toolInput.tool === "todowrite" &&
            (toolOutput.output ?? "").includes("completed")
          ) {
            const matches =
              (toolOutput.output ?? "").match(/"status":"completed"/g) ?? [];
            if (matches.length >= 3) {
              sessionState.batchCompletions++;
            }
          }

          // v0.15.0: split per-phase hint (DONE / PHASE-N-COMPLETE) from
          // terminal (PLAN-COMPLETE). Each signal has its own latch; the
          // gate (further below) decides which one disables intervention.
          const textToScan = [
            typeof toolOutput.output === "string" ? toolOutput.output : "",
            typeof toolInput.args === "string" ? toolInput.args : "",
          ].join("\n");

          if (!sessionState.taskDoneSignal && detectDoneSignal(textToScan)) {
            sessionState.taskDoneSignal = true;
            sessionState.signalAtMs = Date.now();
            logToFile(
              "info",
              `task_done_signal detected (legacy) for session ${toolInput.sessionID}`,
            );
          }
          if (
            !sessionState.phaseCompleteSignal &&
            detectPhaseCompleteSignal(textToScan)
          ) {
            sessionState.phaseCompleteSignal = true;
            sessionState.signalAtMs = Date.now();
            logToFile(
              "info",
              `phase_complete_signal detected for session ${toolInput.sessionID}`,
            );
          }
          if (
            !sessionState.planCompleteSignal &&
            detectPlanCompleteSignal(textToScan)
          ) {
            sessionState.planCompleteSignal = true;
            sessionState.signalAtMs = Date.now();
            logToFile(
              "info",
              `plan_complete_signal detected for session ${toolInput.sessionID}`,
            );
          }

          // v0.24.0: clear oracleInFlight when Oracle's verdict has been processed.
          // 3-tier clear strategy (Oracle-reviewed v2):
          // (a) Promise signal detected AFTER oracleInFlight was set — agent completed
          // (b) Timeout — safety net (5 minutes since invocation)
          // (c) Foreground Oracle call — agent is explicitly waiting
          if (sessionState.oracleInFlight) {
            const ORACLE_FLIGHT_TIMEOUT_MS = 5 * 60 * 1000;
            const timedOut =
              sessionState.oracleInFlightSinceMs !== null &&
              Date.now() - sessionState.oracleInFlightSinceMs > ORACLE_FLIGHT_TIMEOUT_MS;
            // Tier (a): only clear on signals that fired AFTER oracleInFlight started,
            // not stale latches from a previous phase.
            const signalAfterFlight =
              sessionState.oracleInFlightSinceMs !== null &&
              sessionState.signalAtMs > sessionState.oracleInFlightSinceMs;
            if (
              signalAfterFlight ||
              timedOut
            ) {
              sessionState.oracleInFlight = false;
              sessionState.oracleInFlightSinceMs = null;
              logToFile(
                "info",
                `oracle_completed: re-enabling intervention for session ${toolInput.sessionID}${timedOut ? " (timeout)" : ""}`,
              );
            }
            // Tier (c): foreground Oracle call means agent is explicitly waiting for
            // a NEW Oracle, so any previous background Oracle is effectively abandoned.
            if (
              toolInput.tool === "task" &&
              (toolInput.args as Record<string, unknown>)?.subagent_type === "oracle" &&
              (toolInput.args as Record<string, unknown>)?.run_in_background === false
            ) {
              sessionState.oracleInFlight = false;
              sessionState.oracleInFlightSinceMs = null;
              logToFile(
                "info",
                `oracle_completed (foreground call): re-enabling intervention for session ${toolInput.sessionID}`,
              );
            }
          }
        }

        // v0.21.0 (post-wave W6): wave-gate — independent of auditToolCalls.
        // The audit state only exists when protocolEnforcement.auditToolCalls
        // is enabled, but the post-wave gate must work under the default
        // config too, so it tracks its own per-session state (postWaveSessions).
        if (mergedConfig.postWave?.enabled) {
          const pwCfg = mergedConfig.postWave
          const pwText = [
            typeof toolOutput.output === "string" ? toolOutput.output : "",
            typeof toolInput.args === "string" ? toolInput.args : "",
          ].join("\n")
          const pwWaveN = parsePhaseWaveN(pwText)
          const pwOracleCall =
            toolInput.tool === "task" && pwText.includes("subagent_type=oracle")
          if (pwWaveN !== null || pwOracleCall) {
            let pw = postWaveSessions.get(toolInput.sessionID)
            if (!pw) {
              pw = createPostWaveSessionState()
              postWaveSessions.set(toolInput.sessionID, pw)
            }
            // Advance the wave when a new PHASE-N-COMPLETE is seen (Oracle N3).
            if (pwWaveN !== null && pwWaveN !== pw.currentWaveN) {
              pw.currentWaveN = pwWaveN
              pw.postWaveInjectionsThisWave = 0
            }
            // Record Oracle verification AFTER the phase signal (Oracle N2).
            if (pwOracleCall && pw.currentWaveN !== null) {
              pw.oracleAfterPhaseAtMs[pw.currentWaveN] = Date.now()
            }
            // Gate: inject the landing directive once per verified wave.
            const pwNow = Date.now()
            if (
              shouldInjectPostWaveDirective(
                { postWave: pw },
                pwCfg,
                pwNow,
              )
            ) {
              const pwMode =
                pw.repoModeResolved ??
                resolveRepoMode(
                  pwCfg.repoMode ?? "auto",
                  sessionProjectDir,
                )
              pw.repoModeResolved = pwMode
              const pwText2 =
                pwMode === "third-party"
                  ? buildThirdPartyDirective(
                      pwCfg.thirdPartyDirective,
                      pw.currentWaveN,
                      pwCfg.aasToolPrefix,
                    )
                  : buildOwnRepoDirective(
                      pwCfg.ownRepoDirective,
                      pw.currentWaveN,
                    )
              pw.lastInjectedWaveN = pw.currentWaveN
              pw.lastInjectedAtMs = pwNow
              pw.postWaveInjectionsThisWave++
              void promptAgentText(toolInput.sessionID, pwText2).then((res) => {
                if (!res.ok) {
                  logToFile(
                    "info",
                    `post-wave directive delivery failed for ${toolInput.sessionID}: ${res.error ?? "unknown"}`,
                  )
                }
              })
            }
          }
        }

        // v0.10.0: hard break â€” if intervention already disabled, skip orchestrator
        if (sessionState?.interventionDisabled) {
          return;
        }

        // v0.17.2 (Gap C): derive noProgress from real signals.
        // Heuristic: no progress if last 5 tool calls had no write/edit/oracle
        // (i.e. the agent is reading/grepping without producing artifacts).
        const recentCalls = sessionState?.recentToolCalls ?? [];
        const recentProgressTools = recentCalls
          .slice(0, 5)
          .filter((t) =>
            [
              "write",
              "edit",
              "edit_block",
              "desktop-commander_write_file",
              "desktop-commander_edit_block",
              "task",
            ].includes(t),
          );
        // v0.24.0: suppress noProgress when oracleInFlight — agent is correctly idle
        // waiting for Oracle, not stagnating.
        const noProgress = sessionState
          ? !sessionState.oracleInFlight && recentProgressTools.length === 0
          : false;

        // v0.17.2 (Gap C): accumulate protocol violations as Deviations so
        // the deviation-detector signal in scoring-engine actually fires.
        const deviations = sessionState?.accumulatedDeviations ?? [];

        const orchestratorInput: MetaGovernorInput = {
          sessionID: toolInput.sessionID,
          toolName: toolInput.tool,
          toolOutput: toolOutput.output,
          // v0.17.2: thread per-session iteration so the iteration-budget
          // signal (weight 0.15) actually fires downstream.
          iteration: sessionState?.iteration ?? 0,
          maxIterations: mergedConfig.closedLoop.maxLessonsPerSession ?? 10,
          oracleVerified: sessionState?.oracleInvoked ?? false,
          noProgress,
          filesChanged: sessionState?.filesChanged ?? 0,
          recentTurnTokens: [],
          deviations,
          // v0.17.2 (Gap Q): pass recent write file paths so lesson extraction
          // can index file basenames for FTS lookup.
          filePaths: sessionState?.recentWriteFilePaths ?? [],
          // v0.13.0: default backends are real SQLite (was: no-op stubs).
          // The user can still override via `deps.backends` / `deps.writeBackend`.
          // If SQLite init fails (non-Bun runtime, no permissions, etc.) we
          // degrade silently to a no-op so the plugin still loads.
          ...((): Pick<MetaGovernorInput, "backends" | "writeBackend"> => {
            const userBackends = deps.backends;
            const userWrite = deps.writeBackend;
            if (userBackends && userWrite) {
              return { backends: userBackends, writeBackend: userWrite };
            }
            try {
              const sqlite = getDefaultSqliteBackend();
              return {
                backends: userBackends ?? {
                  agentmemory: sqlite,
                                    boulderState: sqlite,
                },
                writeBackend: userWrite ?? sqlite,
              };
            } catch {
              // SQLite init failed (no Bun, no permissions, etc.) â€” degrade silently
              return {
                backends: userBackends ?? {
                  agentmemory: {
                    smartSearch: async () => ({ lessons: [], crystals: [] }),
                  },
                                    boulderState: { boulderRead: async () => [] },
                },
                writeBackend: userWrite ?? {
                  saveMemory: async () => ({ id: "" }),
                  saveLesson: async () => ({ id: "" }),
                },
              };
            }
          })(),
          config: mergedConfig,
          ...(getProviderID() ? { providerID: getProviderID() } : {}),
          ...(getModelID() ? { modelID: getModelID() } : {}),
          modelLimit: getModelLimit(),
          // v0.17.0 (F5.4): thread current lesson count for maxLessonsPerSession cap
          currentLessonCount: sessionState?.lessonCount ?? 0,
        };

        try {
          const output = await runMetaGovernor(orchestratorInput);

          // v0.17.0 (F5.4): increment lesson count when a lesson was actually saved
          if (output.lessonSaved?.lessonSaved && sessionState) {
            sessionState.lessonCount++;
          }

          // v0.17.0 (F5.1): wire escalate action to fire a session.prompt
          // that instructs the LLM to invoke Oracle (or user). Pure prompt
          // builder is testable; the actual session.prompt is best-effort.
          if (
            output.decision.action === "escalate" &&
            toolInput.sessionID &&
            hasSessionClient()
          ) {
            const decisionRef = output.decision.historyEntry.decision;
            const evidenceCount = decisionRef.evidence.length;
            const target = decisionRef.shouldEscalateTo ?? "oracle";
            const instruction = buildEscalationPrompt({
              reasoning: decisionRef.reasoning,
              target,
              evidenceCount,
              sessionID: toolInput.sessionID,
            });
            void promptAgent(toolInput.sessionID, {
              toolName: "meta_governor_escalate",
              mcpTool: "task",
              mcpArgs: { subagent_type: target },
              preamble: instruction,
            }).catch((err) => {
              logToFile("warn", `escalation prompt failed: ${String(err)}`);
            });
          }

          if (mergedConfig.intervention.mode !== "silent" && sessionState) {
            const decision = output.decision;

            // v0.24.0: oracleInFlight gate. While a background Oracle task is
            // running, suppress ALL interventions. The agent is intentionally idle
            // waiting for Oracle's verdict; firing directives during this window
            // (noProgress + accumulated deviations) would pile up duplicate
            // reminders that arrive AFTER Oracle finishes, confusing the agent.
            if (sessionState.oracleInFlight) {
              logToFile(
                "info",
                `oracle_in_flight: skipping intervention for session ${toolInput.sessionID} (score ${output.scoringResult.rawScore.toFixed(2)})`,
              );
              return;
            }

            // v0.15.0: terminal-signal gate. Latches intervention when:
            //   respectDoneSignal is true (master switch from v0.10.0), AND
            //   Oracle has verified, AND either:
            //     a) <promise>PLAN-COMPLETE</promise> was emitted (always terminal), or
            //     b) phaseAwareDoneSignal is false (legacy) and a phase
            //        completion signal was emitted (DONE / PHASE-N-COMPLETE).
            const phaseAwareDone =
              mergedConfig.intervention.phaseAwareDoneSignal === true;
            if (
              mergedConfig.intervention.respectDoneSignal &&
              sessionState.oracleInvoked &&
              (sessionState.planCompleteSignal ||
                (!phaseAwareDone &&
                  (sessionState.taskDoneSignal ||
                    sessionState.phaseCompleteSignal)))
            ) {
              sessionState.interventionDisabled = true;
              const cause = sessionState.planCompleteSignal
                ? "PLAN-COMPLETE"
                : sessionState.taskDoneSignal
                  ? "DONE"
                  : "PHASE-N-COMPLETE";
              logToFile(
                "info",
                `task verified (${cause} + Oracle): disabling intervention for session ${toolInput.sessionID}`,
              );
              takeDecision(toolInput.sessionID);
              return;
            }

            if (
              decision.action !== "continue" &&
              meetsMinAction(
                decision.action,
                mergedConfig.intervention.minActionForMessage,
              )
            ) {
              // v0.10.0: rate-limit interventions
              const cap = Math.max(
                0,
                mergedConfig.intervention.maxInterventionsPerSession ?? 0,
              );
              if (cap > 0 && sessionState.interventionCount >= cap) {
                sessionState.interventionDisabled = true;
                logToFile(
                  "warn",
                  `intervention cap (${cap}) reached for session ${toolInput.sessionID}; disabling further intervention`,
                );
                takeDecision(toolInput.sessionID);
                return;
              }
              sessionState.interventionCount++;
              storeDecision(toolInput.sessionID, decision);
            }
          }
        } catch {
          // MetaGovernor must NEVER break a tool call
        }

        // v0.11.0: detect `git commit` and trigger reindex as a backup
        // for users who skipped `graphify hook install`. The native git
        // hook is the primary path; this is the safety net.
        try {
          if (toolInput.tool === "bash") {
            const args = toolInput.args as { command?: string } | undefined;
            const cmd = args?.command;
            if (isGitCommitCommand(cmd)) {
              logToFile("info", "git_commit_reindex_triggered", {
                sessionID: toolInput.sessionID,
                command: cmd,
              });
              // v0.11.0: test-only hook so hermetic tests can assert
              // the trigger fired without depending on log file paths.
              deps.__test_onCommitTrigger?.({
                projectDir: sessionProjectDir,
                command: cmd ?? "",
                sessionID: toolInput.sessionID,
              });
              // Fire and forget â€” don't block the tool call.
              // v0.16.0: triggerReindex (was triggerCodegraphSync) â€” reindexes both
              // codegraph and graphify, not just codegraph.
              // v0.21.0: use the SESSION's projectDir, not module-load cwd (same
              // serve-mode bug as runGraphSync).
              void triggerReindex(sessionProjectDir).catch((err) => {
                logToFile("warn", `codegraph sync failed: ${String(err)}`);
              });
            }
          }
        } catch {
          // reindex is best-effort, never break a tool call
        }

        // v0.11.0: detect `gh pr ...` output and queue bot feedback
        try {
          if (toolInput.tool === "bash") {
            const args = toolInput.args as { command?: string } | undefined;
            const cmd = args?.command;
            if (isGhPrCommand(cmd)) {
              const feedback = extractBotFeedbackFromGhOutput(
                toolOutput.output,
                toolInput.sessionID,
              );
              if (feedback.length > 0) {
                const existing =
                  pendingBotFeedback.get(toolInput.sessionID)?.items ?? [];
                pendingBotFeedback.set(toolInput.sessionID, {
                  items: existing.concat(feedback),
                  expiresAtMs: Date.now() + PENDING_TTL_MS,
                });
                logToFile(
                  "info",
                  `captured ${feedback.length} bot feedback line(s) for session ${toolInput.sessionID}`,
                );
              }
            }
          }
        } catch {
          // bot feedback is best-effort
        }
      },
      // - Messages transform (injects decisions + protocol violations as synthetic user messages)
      "experimental.chat.messages.transform": async (
        _input: {},
        output: { messages: Array<{ info: unknown; parts: unknown[] }> },
      ): Promise<void> => {
        if (!mergedConfig.enabled) return;

        // v0.10.0: derive current sessionID from the LAST message.
        // MUST scope decisions to the current session; never takeAnyDecision().
        // If we cannot derive a sessionID, the safe default is no injection.
        // v0.20.0: derivation moved BEFORE the intervention-mode gate so the
        // skill-priming nudge can inject independently of intervention.mode.
        const lastMsg = output.messages[output.messages.length - 1] as
          { info?: { sessionID?: string } } | undefined;
        const currentSessionID = lastMsg?.info?.sessionID;
        if (!currentSessionID) {
          return;
        }

        // v0.10.0: respect per-session intervention disable
        const state = auditSessions.get(currentSessionID);

        // 0a. Skill priming (v0.20.0) — proactive skill-selection nudge.
        // Independent of intervention mode; once per session. The
        // "firstImplement" trigger reads the per-session audit state, which
        // does not exist until the first tool call — on the very first
        // transform call only "sessionStart" can fire.
        if (
          mergedConfig.skillPriming.enabled &&
          !skillPrimingSent.has(currentSessionID) &&
          shouldInjectSkillPriming({
            trigger: mergedConfig.skillPriming.trigger,
            recentToolCalls: state?.recentToolCalls ?? [],
            implementationToolSeen:
              implementationToolsSeen.has(currentSessionID),
          })
        ) {
          skillPrimingSent.add(currentSessionID);
          output.messages.push({
            info: { role: "user", agent: "meta-governor", synthetic: true },
            parts: [
              {
                type: "text",
                text: buildSkillPrimingMessage(
                  mergedConfig.skillPriming.router,
                ),
                synthetic: true,
              },
            ],
          });
          logToFile(
            "info",
            `skill_priming_injected for session ${currentSessionID}`,
          );
        }

        // v0.21.0: graph-tools-ready nudge — independent of intervention
        // mode, once per session. Fires when the background graphSync
        // completed and BOTH codegraph + graphify are available, so the
        // agent actually uses the indexes (omo_search/omo_find/omo_impact).
        if (
          graphSyncReadyProjects.has(sessionProjectDir) &&
          !graphSyncReadyNotified.has(currentSessionID)
        ) {
          graphSyncReadyNotified.add(currentSessionID);
          output.messages.push({
            info: { role: "user", agent: "meta-governor", synthetic: true },
            parts: [
              {
                type: "text",
                text: [
                  "[META-GOVERNOR] codegraph y graphify ya están inicializados en este repo. ",
                  "ROUTING EXPLÍCITO (v0.25.0): ",
                  "• Símbolos/definiciones/callers/impacto (código) → CODEGRAPH: omo_find, omo_impact, omo_search. ",
                  "• Conceptos/arquitectura/conexiones/explicaciones → GRAPHIFY: omo_path, omo_explain (y omo_search en modo alternate). ",
                  "• Vista general del repo → lee graphify-out/GRAPH_REPORT.md. ",
                  "Actualizan tras cada commit.",
                ].join(" "),
                synthetic: true,
              },
            ],
          });
          logToFile(
            "info",
            `graph_tools_ready_injected for session ${currentSessionID}`,
          );
        }

        if (mergedConfig.intervention.mode !== "message") return;

        // v0.10.0: respect per-session intervention disable
        if (state?.interventionDisabled) {
          takeDecision(currentSessionID);
          return;
        }

        // 0. Plan reminder (v0.11.0) â€” nudge the agent to make a plan
        //    before code changes, but only once per session.
        if (
          state &&
          !planReminderSent.has(currentSessionID) &&
          shouldInjectPlanReminder(cwd, state.interventionCount)
        ) {
          planReminderSent.add(currentSessionID);
          const planText = `[MetaGovernor] Before any code change, create PLAN.md or a \`## Plan\` section in AGENTS.md that enumerates the phases. After each phase, commit (local + fork + upstream). Each commit triggers automatic reindex via the graphify post-commit hook + \`codegraph sync\`.`;
          output.messages.push({
            info: { role: "user", agent: "meta-governor", synthetic: true },
            parts: [{ type: "text", text: planText, synthetic: true }],
          });
          logToFile(
            "info",
            `plan_reminder_injected for session ${currentSessionID}`,
          );
          persistIntervention(currentSessionID, planText);
        }

        // 0b. Bot feedback from PR reviewers (v0.11.0)
        const botEntry = pendingBotFeedback.get(currentSessionID);
        if (botEntry && botEntry.expiresAtMs > Date.now()) {
          const feedback = botEntry.items;
          if (feedback.length > 0) {
            const feedbackText = `[MetaGovernor PR Reviewer Feedback]\n\n${feedback.map((f, i) => `${i + 1}. ${f}`).join("\n")}\n\nApply these fixes to keep the PR mergeable.`;
            output.messages.push({
              info: { role: "user", agent: "meta-governor", synthetic: true },
              parts: [{ type: "text", text: feedbackText, synthetic: true }],
            });
            pendingBotFeedback.delete(currentSessionID);
            logToFile(
              "info",
              `injected ${feedback.length} bot feedback line(s) to model for session ${currentSessionID}`,
            );
            persistIntervention(currentSessionID, feedbackText);
          }
        }
        // 1. Inject pending protocol violations so the model sees them
        const violEntry = pendingViolations.get(currentSessionID);
        if (violEntry && violEntry.expiresAtMs > Date.now()) {
          const violations = violEntry.items;
          if (violations.length > 0) {
            const violationText = `[META-GOVERNOR PROTOCOL VIOLATIONS - YOU MUST COMPLY]\n\n${violations.map((v, i) => `${i + 1}. ${v}`).join("\n")}\n\nRemember: use codegraph/graphify for architecture queries, do not grep without trying codegraph/graphify first, no @ts-ignore/as-any, no empty catch, check memory before asking.`;
            output.messages.push({
              info: { role: "user", agent: "meta-governor", synthetic: true },
              parts: [{ type: "text", text: violationText, synthetic: true }],
            });
            pendingViolations.delete(currentSessionID);
            logToFile(
              "info",
              `injected ${violations.length} violation(s) to model`,
            );
            persistIntervention(currentSessionID, violationText);
            // v0.23.1: record injection timestamp for cooldown
            const injectState = auditSessions.get(currentSessionID);
            if (injectState) {
              injectState.lastViolationInjectionAtMs = Date.now();
            }
          }
        }

        // 2. Inject MetaGovernor decision â€” SCOPED to current session
        const decision = takeDecision(currentSessionID);
        if (!decision) return;
        if (decision.action === "continue") return;
        if (!decision.message) return;
        if (
          !meetsMinAction(
            decision.action,
            mergedConfig.intervention.minActionForMessage,
          )
        )
          return;

        // v0.10.0: defense-in-depth cap check before push.
        // State may not exist yet (no tool.execute.before ran); lazily create it.
        let curState = state ?? auditSessions.get(currentSessionID);
        if (!curState) {
          curState = {
            memoryToolsUsed: [],
            hasCodegraphDir: graphRetrieval.hasCodegraphDir(cwd),
            hasGraphifyDir: graphRetrieval.hasGraphifyDir(cwd),
            oracleInvoked: false,
            filesChanged: 0,
            emptyRecall: false,
            escalationAttempted: false,
            recentToolCalls: [],
            recentWriteContents: [],
            recentWriteFilePaths: [],
            memorySaved: false,
            accumulatedDeviations: [],
            recentInterventionTexts: [],
            batchCompletions: 0,
            taskDoneSignal: false,
            phaseCompleteSignal: false,
            planCompleteSignal: false,
            interventionCount: 0,
            interventionDisabled: false,
            lessonCount: 0,
            iteration: 0,
            oracleInFlight: false,
            oracleInFlightSinceMs: null,
            signalAtMs: 0,
            lastViolationInjectionAtMs: 0,
            postWave: {
              currentWaveN: null,
              lastInjectedWaveN: null,
              lastInjectedAtMs: null,
              postWaveInjectionsThisWave: 0,
              rulesReadForWave: {},
              oracleAfterPhaseAtMs: {},
              repoModeResolved: null,
            },
          };
          auditSessions.set(currentSessionID, curState);
        }
        const cap = Math.max(
          0,
          mergedConfig.intervention.maxInterventionsPerSession ?? 0,
        );
        if (cap > 0 && curState.interventionCount >= cap) {
          curState.interventionDisabled = true;
          return;
        }
        curState.interventionCount++;

        // v0.17.2 (Gap D): when includeDecisionHistory is true, prepend
        // recent intervention texts so the model sees its history of decisions.
        // Capped at maxHistoryMessages (default 5).
        const includeHistory =
          mergedConfig.intervention.includeDecisionHistory !== false;
        const maxHistory = mergedConfig.intervention.maxHistoryMessages ?? 5;
        const historyTexts = (curState.recentInterventionTexts ?? []).slice(
          -maxHistory,
        );
        let messageText = `[MetaGovernor] ${decision.message}`;
        if (includeHistory && historyTexts.length > 0) {
          const historyBlock = historyTexts
            .map((t, i) => `${i + 1}. ${t}`)
            .join("\n");
          messageText = `[MetaGovernor] Recent decisions in this session:\n${historyBlock}\n\n---\n\nCurrent decision: ${decision.message}`;
        }
        // Track this intervention for future history inclusion.
        curState.recentInterventionTexts = [
          ...historyTexts,
          `[${decision.action}] ${decision.message}`,
        ].slice(-maxHistory);

        const textPart = {
          type: "text",
          text: messageText,
          synthetic: true,
        };

        output.messages.push({
          info: { role: "user", agent: "meta-governor" },
          parts: [textPart],
        });
        persistIntervention(currentSessionID, messageText);
      },

      // - System transform (protocol injection + system intervention mode)
      "experimental.chat.system.transform": async (
        transformInput: { sessionID?: string; model: unknown },
        output: { system: string[] },
      ): Promise<void> => {
        if (!mergedConfig.enabled) return;

        if (
          mergedConfig.protocolEnforcement.injectIntoSystem &&
          systemInjection
        ) {
          output.system.push(
            "\n### Sisyphus Protocol Enforcement",
            systemInjection,
            "---",
          );
        }

        // v0.13.0: inject cached graph context (C2 fix). When tool.execute.before
        // fired a graph query earlier, the result is now in the per-session cache
        // and we append it to the system prompt as reference material.
        if (transformInput.sessionID) {
          const graphContext = graphRetrieval.getCachedContext(
            transformInput.sessionID,
          );
          if (graphContext) {
            output.system.push(
              "\n### Graph Context (auto-retrieved)",
              graphContext,
              "---",
            );
          }
        }

        if (
          mergedConfig.intervention.mode === "system" &&
          transformInput.sessionID
        ) {
          // v0.10.0: also respect per-session intervention disable here
          const state = auditSessions.get(transformInput.sessionID);
          if (state?.interventionDisabled) {
            takeDecision(transformInput.sessionID);
            return;
          }
          const decision = takeDecision(transformInput.sessionID);
          if (decision && decision.action !== "continue" && decision.message) {
            if (
              meetsMinAction(
                decision.action,
                mergedConfig.intervention.minActionForMessage,
              )
            ) {
              if (state) {
                const cap = Math.max(
                  0,
                  mergedConfig.intervention.maxInterventionsPerSession ?? 0,
                );
                if (cap > 0 && state.interventionCount >= cap) {
                  state.interventionDisabled = true;
                  return;
                }
                state.interventionCount++;
              }
              output.system.push(
                "\n[MetaGovernor Intervention]",
                decision.message,
                "---",
              );
            }
          }
        }
      },

      // v0.13.1: custom tool registration â€” the LLM can call these explicitly
      tool: {
        omo_search: omoSearchTool,
        omo_recall: omoRecallTool,
        omo_health: omoHealthTool,
        omo_find: omoFindTool,
        omo_impact: omoImpactTool,
        omo_remember: omoRememberTool,
        omo_recall_mcp: omoRecallMcpTool,
        omo_path: omoPathTool,
        omo_explain: omoExplainTool,
      },

      // v0.13.1: inject lesson context at compaction time so learned patterns
      // survive context window compaction.
      "experimental.session.compacting": async (
        compactInput: { sessionID: string },
        compactOutput: { context: string[]; prompt?: string },
      ): Promise<void> => {
        if (!mergedConfig.enabled || !mergedConfig.closedLoop.enabled) return;
        // Fetch top-3 relevant lessons and inject into compaction context
        const sqlite = getDefaultSqliteBackend();
        const recentQuery = `session:${compactInput.sessionID}`;
        const results = await sqlite.smartSearch({
          query: recentQuery,
          limit: 3,
        });
        if (results.lessons.length > 0) {
          const lessonText = results.lessons
            .map(
              (l, i) =>
                `${i + 1}. [${l.id}] confidence=${l.confidence.toFixed(2)}\n   ${l.content.slice(0, 300)}`,
            )
            .join("\n\n");
          compactOutput.context.push(
            "\n### Past Lessons (auto-retrieved)",
            lessonText,
            "---",
          );
        }
      },

      // v0.13.1: disable auto-continue when the plugin has determined the
      // task is complete (DONE+Oracle or intervention cap reached).
      "experimental.compaction.autocontinue": async (
        _autoInput: { sessionID: string; overflow: boolean },
        autoOutput: { enabled: boolean },
      ): Promise<void> => {
        if (!mergedConfig.enabled) return;
        const state = auditSessions.get(_autoInput.sessionID);
        if (state?.interventionDisabled) {
          autoOutput.enabled = false;
        }
      },
    };
  };

  return plugin;
}
// â”€â”€â”€ v0.11.0: helpers â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

/**
 * Detect whether a shell command is a `git commit` invocation.
 * Used to trigger codegraph reindex on each commit.
 */
export { isGitCommitCommand } from "./graph-sync";

/**
 * Extract bot feedback lines from `gh pr checks` output.
 * Returns an array of human-readable notes like:
 *   "pr-42 Â· claude-code-review: CodeRabbit found issues: missing test for X"
 * Only "fail" status is reported; "pass" and "pending" are ignored.
 */
export function extractBotFeedbackFromGhOutput(
  output: string,
  prIdentifier: string,
): string[] {
  if (typeof output !== "string" || output.length === 0) return [];
  const lines = output.split("\n");
  const feedback: string[] = [];
  for (const line of lines) {
    // gh pr checks output: "<check-name>    <status>    <details>"
    // Status values: pass, fail, pending, skipping, cancelled
    const match = line.match(/^\s*(\S+)\s+(fail)\s+(.*)$/);
    if (match) {
      const name = match[1]!.trim();
      const details = match[3]!.trim();
      feedback.push(`${prIdentifier} Â· ${name}: ${details}`);
    }
  }
  return feedback;
}

/**
 * Detect whether a shell command is a `gh pr ...` invocation.
 * Used to capture bot feedback from PR review bots (CodeRabbit, codecov,
 * claude-code-review, etc.) so the next LLM turn can act on the feedback.
 */
export function isGhPrCommand(command: string | undefined | null): boolean {
  if (typeof command !== "string" || command.length === 0) return false;
  const normalized = command.replace(/\\\n/g, " ").replace(/\s*\n\s*/g, " ");
  return /(?:^|[\s;&|])gh\s+pr(?:\s|$)/.test(normalized);
}

/**
 * Decide whether to inject a "make a plan first" reminder on the current
 * session. Returns true only when:
 *   - first intervention for this session (interventionCount === 0)
 *   - no PLAN.md exists in the project
 *   - no "## Plan" section exists in AGENTS.md
 *
 * Once any of those becomes true, the reminder is suppressed for the
 * rest of the session.
 */
export function shouldInjectPlanReminder(
  projectDir: string,
  interventionCount: number,
): boolean {
  if (interventionCount >= 1) return false;
  // v0.16.0: replaced inline CJS require with top-level ESM imports (F1.2).
  // In strict ESM environments, require() throws ReferenceError; the catch
  // was silently returning true (always inject), which broke the logic.
  // Now both file checks use synchronous fs/imports at module load.
  try {
    statSync(join(projectDir, "PLAN.md"));
    return false;
  } catch {
    /* no PLAN.md */
  }
  try {
    const agents = readFileSync(join(projectDir, "AGENTS.md"), "utf-8");
    if (/^##\s+Plan\b/im.test(agents)) return false;
  } catch {
    /* no AGENTS.md */
  }
  return true;
}

// â”€â”€â”€ v0.15.0 completion-signal detectors (module-level exports for testing) â”€â”€â”€

/**
 * v0.10.0 legacy detector. Matches `<promise>DONE</promise>` (with optional
 * trailing `!`) and nothing else. Retained for backwards compatibility â€”
 * new code should prefer {@link detectPhaseCompleteSignal} for per-phase
 * hints or {@link detectPlanCompleteSignal} for the terminal marker.
 */
export function detectDoneSignal(text: string | undefined | null): boolean {
  if (typeof text !== "string" || text.length === 0) return false;
  return /<promise>\s*DONE!?\s*<\/promise>/i.test(text);
}

/**
 * v0.15.0: per-phase hint detector. Matches `<promise>DONE</promise>` (with
 * optional trailing `!`) AND `<promise>PHASE-N-COMPLETE</promise>` where N
 * is a positive integer (1, 2, 3, ...). Case-insensitive, whitespace-tolerant.
 *
 * The MetaGovernor gate respects `phaseAwareDoneSignal` when deciding whether
 * this signal latches intervention.
 */
export function detectPhaseCompleteSignal(
  text: string | undefined | null,
): boolean {
  if (typeof text !== "string" || text.length === 0) return false;
  return (
    /<promise>\s*DONE!?\s*<\/promise>/i.test(text) ||
    /<promise>\s*PHASE-\d+-COMPLETE\s*<\/promise>/i.test(text)
  );
}

/**
 * v0.15.0: terminal marker detector. Matches `<promise>PLAN-COMPLETE</promise>`
 * only. Case-insensitive, whitespace-tolerant. This is the ONLY signal that
 * latches intervention unconditionally (when Oracle has verified and
 * `respectDoneSignal: true`).
 */
export function detectPlanCompleteSignal(
  text: string | undefined | null,
): boolean {
  if (typeof text !== "string" || text.length === 0) return false;
  return /<promise>\s*PLAN-COMPLETE\s*<\/promise>/i.test(text);
}

/**
 * v0.21.0 (post-wave W3): extract the wave number N from a PHASE-N-COMPLETE
 * marker. Mirrors the regex of {@link detectPhaseCompleteSignal} (same
 * whitespace tolerance + case-insensitivity) but captures the numeric suffix.
 *
 * Returns the number, or null when the text has no PHASE-N-COMPLETE marker.
 * Strict: only numeric suffixes match (PHASE-1-COMPLETE → 1, PHASE-12-COMPLETE
 * → 12). Non-numeric suffixes (PHASE-A-COMPLETE) and legacy DONE return null.
 */
export function parsePhaseWaveN(text: string): number | null {
  const m = /(?:<promise>\s*)?PHASE-(\d+)-COMPLETE\s*(?:<\/promise>)?/i.exec(
    text,
  );
  return m ? Number.parseInt(m[1]!, 10) : null;
}

// ─── v0.21.0 (post-wave W5): wave-gate decision helpers (module-level exports for testing) ───

/**
 * Decide whether a post-wave landing directive should be injected NOW for the
 * given session state. True only when:
 *   - postWave gate is enabled (config), and
 *   - a current wave is set (PHASE-N-COMPLETE seen), and
 *   - Oracle has verified AFTER that phase (oracleAfterPhaseAtMs[N] present), and
 *   - the same-wave injection budget is not exhausted, and
 *   - the re-injection cooldown has elapsed.
 *
 * New waves reset the budget implicitly: lastInjectedWaveN !== wave bypasses
 * the per-wave cap, so a fresh PHASE-2-COMPLETE after PHASE-1 is always
 * eligible once Oracle verifies it.
 */
export function shouldInjectPostWaveDirective(
  state: {
    postWave: {
      currentWaveN: number | null;
      lastInjectedWaveN: number | null;
      lastInjectedAtMs: number | null;
      postWaveInjectionsThisWave: number;
      oracleAfterPhaseAtMs: Record<number, number>;
    };
  },
  config: {
    enabled?: boolean;
    maxRetriesPerWave?: number;
    reinjectCooldownMs?: number;
  },
  nowMs: number,
): boolean {
  if (config.enabled === false) return false;
  const wave = state.postWave.currentWaveN;
  if (wave === null) return false;
  if (!(wave in state.postWave.oracleAfterPhaseAtMs)) return false;
  const cap = config.maxRetriesPerWave ?? 1;
  const cooldown = config.reinjectCooldownMs ?? 60_000;
  const sameWave = state.postWave.lastInjectedWaveN === wave;
  if (sameWave && state.postWave.postWaveInjectionsThisWave >= cap) {
    return false;
  }
  // Cooldown applies ONLY to same-wave re-injection (Oracle N1, 14/08/2026):
  // a NEW wave arriving within the window must never be blocked — the agent
  // can legally land wave N+1 seconds after injecting wave N.
  if (
    sameWave &&
    state.postWave.lastInjectedAtMs !== null &&
    nowMs - state.postWave.lastInjectedAtMs < cooldown
  ) {
    return false;
  }
  return true;
}

/**
 * Build the landing directive text for OWN repos: push + self-terminating CI
 * watch. `timeout 600` caps the blocking `gh pr checks --watch` so the agent
 * never hangs forever (Oracle note E, 14/08/2026). A user-provided override
 * wins verbatim.
 */
export function buildOwnRepoDirective(
  override: string | undefined,
  waveN: number | null | undefined,
): string {
  if (override) return override;
  const wave = waveN === null || waveN === undefined ? "?" : String(waveN);
  return [
    `Wave ${wave} is Oracle-verified. Land it now:`,
    "1. Use a CLEAN dedicated branch for this PR: `git checkout -b <branch>` (each PR gets its own independent branch; never mix PRs on one branch unless they fix the same problem).",
    "2. `git push -u origin HEAD` (sets upstream on first push).",
    "3. If no PR exists yet: `gh pr create --fill`.",
    "4. Monitor CI: `timeout 600 gh pr checks --watch` (auto-stops after 10 min).",
    "5. Only start the next wave after checks are green.",
  ].join("\n");
}

/**
 * Build the landing directive text for THIRD-PARTY repos (fork/PR workflow).
 * Embeds the user's contribution rule (memory #1235): READ the repo's
 * contribution rules FIRST (CONTRIBUTING.md, PR/issue templates and guides),
 * invoke the AAS GitHub skills ({@link aasToolPrefix}) to create PR/issue,
 * and request review at the end. A user-provided override wins verbatim.
 */
export function buildThirdPartyDirective(
  override: string | undefined,
  waveN: number | null | undefined,
  aasToolPrefix = "aas",
): string {
  if (override) return override;
  const wave = waveN === null || waveN === undefined ? "?" : String(waveN);
  return [
    `Wave ${wave} is Oracle-verified. This is a THIRD-PARTY repo — land it as a contribution:`,
    "1. READ FIRST the repo's contribution rules (read CONTRIBUTING.md, PR/issue templates and guides) and follow them exactly.",
    "2. Create a CLEAN dedicated branch for THIS PR: `git checkout -b <branch>` — each PR gets its own independent branch; never mix PRs on one branch unless they fix the same problem (then commit onto that same branch).",
    `3. Invoke the \`${aasToolPrefix}\` MCP GitHub skills (search_skills → get_skill → compose_stack) to create the PR/issue.`,
    "4. Push the branch to your FORK (`git push -u origin HEAD`) and open the PR against the UPSTREAM repo following the repo's template.",
    "5. Request review on the PR (add reviewers) and wait for CI to pass before starting the next wave.",
  ].join("\n");
}

/**
 * Resolve the repository mode for the post-wave workflow.
 * v0.21.0 W5/N5 (14/08/2026): explicit config wins; "auto" queries gh
 * (`gh repo view --json isFork,parent`) to decide own vs third-party.
 * Falls back to "own" when gh is unavailable or the repo view fails.
 * `runner` is injectable for tests (defaults to node:child_process execSync).
 */
export function resolveRepoMode(
  configured: "auto" | "own" | "third-party",
  projectDir: string,
  runner: typeof execSync = execSync,
): "own" | "third-party" {
  if (configured === "own" || configured === "third-party") return configured;
  try {
    const out = runner("gh repo view --json isFork,parent", {
      cwd: projectDir,
      stdio: "pipe",
      timeout: 10_000,
    });
    const parsed = JSON.parse(String(out)) as {
      isFork?: boolean;
      parent?: { owner?: { login?: string }; name?: string } | null;
    };
    if (
      parsed.isFork === true &&
      parsed.parent !== null &&
      parsed.parent !== undefined
    ) {
      return "third-party";
    }
    return "own";
  } catch {
    // gh unavailable/failed (common with private repos) — fall back to git
    // remotes: a fork workflow usually has an "upstream" remote.
    try {
      const remotes = runner("git remote -v", {
        cwd: projectDir,
        stdio: "pipe",
        timeout: 10_000,
      })
      const hasUpstream = String(remotes)
        .split("\n")
        .some((l) => /^\s*upstream\s+/.test(l))
      if (hasUpstream) return "third-party";
    } catch {
      // no git either — assume own repo
    }
    return "own";
  }
}
