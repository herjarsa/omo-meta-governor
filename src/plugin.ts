import type {
  Hooks,
  Plugin,
  PluginInput,
  PluginOptions,
} from "@opencode-ai/plugin";
import { randomUUID as crypto_randomUUID, createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import type {
  AgentmemoryWriteBackend,
  DecisionHandlerOutput,
  MemoryBackends,
  MetaGovernorInput,
  MetaGovernorOutput,
} from "./types";
import {
  runGraphSync,
  trackSession,
  untrackSession,
  isGitCommitCommand,
  triggerReindex,
  detectRemoteNewCommits,
  stopWatches,
} from "./graph-sync";
import {
  killOrphanedToolProcesses,
  killTrackedProcesses,
  installProcessExitHandlers,
} from "./proc-guard";
import { runCliAnythingSync } from "./cli-anything-sync";
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
  buildOmoFilesTool,
  buildOmoCallersTool,
  buildOmoNodeTool,
  // v0.27.0 Wave 3 P2 â€” extended graph tool surface
  buildOmoContextTool,
  buildOmoAffectedCgTool,
  buildOmoStatusTool,
  buildOmoUnlockTool,
  buildOmoMarkDirtyTool,
  buildOmoSyncIfDirtyTool,
  buildOmoIndexTool,
  buildOmoVisualizeTool,
  buildOmoServeTool,
  buildOmoUninitTool,
  buildOmoDiagnoseTool,
  buildOmoMergeGraphsTool,
  buildOmoSaveResultTool,
  buildOmoExtractTool,
  buildOmoClusterOnlyTool,
  buildOmoLabelTool,
  buildOmoTreeTool,
  buildOmoCloneTool,
  buildOmoAddTool,
  buildOmoCheckUpdateTool,
  buildOmoHookStatusTool,
  // v0.28.0: CLI-Anything hub discovery tools
  buildOmoCliAnythingInstallTool,
  buildOmoCliAnythingListTool,
  buildOmoCliAnythingSearchTool,
  buildOmoCliAnythingInfoTool,
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
import type { PromptResult } from "./session-bridge";
import { PendingDeliveryRegistry } from "./delivery-registry";
import { setPendingDeliveryRegistry } from "./custom-tools";
import { LOG_PATH, logToFile } from "./file-logger";
import {
  buildOracleRule,
  buildAgentMemoryRule,
  buildSkillPrimingRule,
  buildProtocolRule as buildEnforcementProtocolRule,
} from "./enforcement-resources";
import { resolve } from "node:path";
import { homedir } from "node:os";
import { buildPluginHealth, createThrottledHealthWriter, describeLogFile, writeHealthToFile } from "./health";
import { createMetricsCollector } from "./metrics";
import {
  loadOrchestratorConfig,
  type MetaGovernorPluginConfig,
} from "./config";
import { loadMetaGovernorConfig } from "./config-file";
import { storeDecision, takeDecision, getDecisionHistory } from "./decision-store";
import { countConsecutiveStops } from "./decision-handler";
import { GraphRetrieval, getDefaultGraphRetrieval, configureDefaultGraphRetrieval } from "./graph-retrieval";
import { AuditStateCache } from "./audit-state-cache";
import { TtlBoundedMap } from "./utils/ttl-bounded-map";
import { DEFAULT_VERSION } from "./metrics";
import { statSync, readFileSync } from "node:fs";
import { execSync, execFileSync } from "node:child_process";
import { join } from "node:path";
import {
  loadProtocol,
  buildSystemInjection,
  auditToolCall,
  DEFAULT_PROTOCOL_PATH,
} from "./protocol-enforcer";
import { startSkillsFsWatcher } from "./skills-fs-watcher";
import { installGlobalErrorHandler } from "./error-handler";
import {
buildSkillPrimingMessage,
  buildGraphPrimingMessage,
  // v0.38.2: brief TUI status (NOT agent directive). Used by persistIntervention
  // so the user's TUI shows a short status, while the agent prompt gets the full
  // wrapped directive. Subagents should never see *UserStatus text.
  buildSkillPrimingUserStatus,
  buildGraphPrimingUserStatus,
  shouldInjectSkillPriming,
  isTrivialWrite,
  suggestSkillFindQuery,
  IMPLEMENTATION_TOOLS,
} from "./skill-priming";

// v0.38.3 (CI fix): install the global error handler at MODULE LOAD time
// (not just inside createMetaGovernorPlugin) so tests that don't invoke
// the factory still get the filter. Previously the handler was inside the
// factory closure, so bun:test runs that import the plugin module but
// never call the factory (e.g. sqlite-driver.test.ts, graphsink-fix.test.ts)
// had no handler — chokidar EINVAL on D:\DumpStack.log.tmp / D:\pagefile.sys
// escaped to bun's test runner as "Unhandled error between tests" and
// exit code 1, breaking the CI test-windows job.
//
// installGlobalErrorHandler is idempotent (defaultTeardown guard in
// error-handler.ts), so multiple module-loads (test workers re-import)
// reuse the same handler without stacking.
installGlobalErrorHandler();

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
  /** v0.21.0: test-only hook â€” asserts runGraphSync is invoked with the
   * session's projectDir (fix: was module-load cwd under serve). */
  __test_onGraphSyncInit?: (payload: { projectDir: string }) => void;
  /** v0.21.0: test-only DI seam â€” replaces the REAL runGraphSync so hermetic
   * placement tests never spawn npx/pip/graphify. Avoids mock.module (which
   * leaks across test files sharing a Bun worker â€” broke CI on macOS). */
__test_runGraphSync?: typeof import("./graph-sync").runGraphSync;
  /** v0.28.0: test-only DI seam for runCliAnythingSync â€” same hermetic rationale. */
  /** v0.28.0: test-only DI seam for runCliAnythingSync — same hermetic rationale. */
__test_runCliAnythingSync?: typeof import("./cli-anything-sync").runCliAnythingSync;
  /** v0.31.3: test-only DI seam — replaces persistSessionMessage so retry tests
   * never touch a real OpenCode server. */
__test_persistSessionMessage?: typeof import("./session-bridge").persistSessionMessage;
  /**
   * v0.37.1: test-only DI seam — replaces startSkillsFsWatcher so hermetic
   * tests never spawn a chokidar watcher (which scans projectDir with polling
   * and on Windows CI raises EINVAL lstat on D:\\DumpStack.log.tmp /
   * D:\\pagefile.sys when mockPluginInput.directory is ""). Fixes the v0.37.0
   * readdirp Windows flake that required 6 quarantines (f8caf18, e5fc0b6,
   * 31e0a21, ff2ecaf, 6180525, c4bc7ee).
   */
  __test_startSkillsFsWatcher?: typeof import("./skills-fs-watcher").startSkillsFsWatcher;
  /** v0.31.3: test-only DI seam — persist-retry backoff override (ms). */
  __test_persistRetryDelayMs?: number;
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

// v0.34.2 (P1-6): bash with > file / >> file / 	ee file is a write tool
// by another name. Treat it like one for the skill-priming gate and
// filesChanged accounting. Covers the common bypass patterns; full shell
// parser out of scope.
function bashHasFileWrite(toolInput: { tool: string; args?: unknown }): boolean {
  if (toolInput.tool !== "bash") return false
  const cmd = (toolInput.args as { command?: string } | undefined)?.command
  if (typeof cmd !== "string") return false
  return /(?:>>?|[<>]\s*&?\s*[''"]?\s*\S+|\btee\s+[^|;&]+)/.test(cmd)
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

// Module-level metrics collector Ã¢â‚¬â€ shared across all invocations of the plugin
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
  // v0.38.3: installGlobalErrorHandler() moved to module-load time (see top
  // of file). It must be installed BEFORE any chokidar instance is created,
  // and putting it at module load guarantees it's installed regardless of
  // whether createMetaGovernorPlugin is ever called.

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
  // v0.14.0: OpciÃƒÂ³n A pivot Ã¢â‚¬â€ tools that bridge to MCP servers via session.prompt()
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
  // v0.26.0: omo_files / omo_callers / omo_node â€” thin wrappers around
  // GraphRetrieval.invokeFiles / invokeCallers / invokeNode.
  const omoFilesTool = buildOmoFilesTool({ graphRetrieval, cwd });
  const omoCallersTool = buildOmoCallersTool({ graphRetrieval, cwd });
  const omoNodeTool = buildOmoNodeTool({ graphRetrieval, cwd });
  // v0.27.0 Wave 3 P2 â€” extended graph tool surface
  const omoContextTool = buildOmoContextTool({ graphRetrieval, cwd });
  const omoAffectedCgTool = buildOmoAffectedCgTool({ graphRetrieval, cwd });
  const omoStatusTool = buildOmoStatusTool({ graphRetrieval, cwd });
  const omoUnlockTool = buildOmoUnlockTool({ graphRetrieval, cwd });
  const omoMarkDirtyTool = buildOmoMarkDirtyTool({ graphRetrieval, cwd });
  const omoSyncIfDirtyTool = buildOmoSyncIfDirtyTool({ graphRetrieval, cwd });
  const omoIndexTool = buildOmoIndexTool({ graphRetrieval, cwd });
  const omoVisualizeTool = buildOmoVisualizeTool({ graphRetrieval, cwd });
  const omoServeTool = buildOmoServeTool({ graphRetrieval, cwd });
  const omoUninitTool = buildOmoUninitTool({ graphRetrieval, cwd });
  const omoDiagnoseTool = buildOmoDiagnoseTool({ graphRetrieval, cwd });
  const omoMergeGraphsTool = buildOmoMergeGraphsTool({ graphRetrieval, cwd });
  const omoSaveResultTool = buildOmoSaveResultTool({ graphRetrieval, cwd });
  const omoExtractTool = buildOmoExtractTool({ graphRetrieval, cwd });
  const omoClusterOnlyTool = buildOmoClusterOnlyTool({ graphRetrieval, cwd });
  const omoLabelTool = buildOmoLabelTool({ graphRetrieval, cwd });
  const omoTreeTool = buildOmoTreeTool({ graphRetrieval, cwd });
  const omoCloneTool = buildOmoCloneTool({ graphRetrieval, cwd });
  const omoAddTool = buildOmoAddTool({ graphRetrieval, cwd });
  const omoCheckUpdateTool = buildOmoCheckUpdateTool({ graphRetrieval, cwd });
  const omoHookStatusTool = buildOmoHookStatusTool({ cwd });
  // v0.28.0: CLI-Anything hub discovery tools
  const omoCliAnythingInstallTool = buildOmoCliAnythingInstallTool({ cwd });
  const omoCliAnythingListTool = buildOmoCliAnythingListTool({ cwd });
  const omoCliAnythingSearchTool = buildOmoCliAnythingSearchTool({ cwd });
  const omoCliAnythingInfoTool = buildOmoCliAnythingInfoTool({ cwd });
  // Log startup so the user can see the plugin is loaded. The version is
  // prepended to the message (and included in the structured fields) so
  // OpenChamber's startup log shows exactly which release is loaded â€”
  // without this, a stale cache could serve an older bundle silently
  // (user-reported 14/08/2026, after publishing v0.21.0 with `@latest`).
  logToFile("info", `v${DEFAULT_VERSION} MetaGovernor plugin loaded`, {
    version: DEFAULT_VERSION,
    build: DEFAULT_VERSION,
    cwd,
    projectHasCodegraph: graphRetrieval.hasCodegraphDir(cwd),
    projectHasGraphify: graphRetrieval.hasGraphifyDir(cwd),
  });
  // v0.26.3: include a short SHA-256 fingerprint of the loaded bundle so
  // stale-cache issues are immediately diagnosable (the user can compare
  // the fingerprint to the expected one for the installed version).
  // The hash is read from the same file Bun actually loaded â€” if Bun is
  // serving an older bundle from a cached path, the hash will NOT match
  // the npm registry tarball for the same version.
  let bundleFingerprint = "?";
  try {
    const bundleUrl = import.meta.url;
    const bundlePath = fileURLToPath(bundleUrl);
    const bundleBytes = readFileSync(bundlePath);
    bundleFingerprint = createHash("sha256")
      .update(bundleBytes)
      .digest("hex")
      .slice(0, 8);
  } catch {
    // best-effort â€” never fail plugin load because of the diagnostic line
  }
  // v0.26.2: one-line console confirmation so the user sees the plugin
  // actually loaded (v0.26.1 silenced all info logs, which made the
  // startup signal invisible). The verbose data stays in meta-governor.log.
  // v0.26.3: append the bundle fingerprint so the user can detect a stale
  // Bun module cache that didn't pick up the new npm package.
  console.log(
    `[meta-governor] v${DEFAULT_VERSION} loaded (bundle: ${bundleFingerprint})`,
  );

  // v0.24.3: detect stale npm cache. When opencode caches an older version,
  // the plugin loads silently with outdated code. This async check runs
  // once at load time and warns the user if a newer version exists.
  // v0.35.0 (audit fix F16): cache the npm registry check with a 24h TTL
  // so opencode restart loops do not hammer the registry.
  (async () => {
    const CACHE_PATH = resolve(homedir(), ".config", "opencode", "omo-meta-governor-self-version-cache.json")
    const TTL_MS = 24 * 60 * 60 * 1000
    let cached: { latest: string; checkedAtMs: number } | null = null
    try {
      const raw = readFileSync(CACHE_PATH, "utf-8")
      const parsed = JSON.parse(raw) as { latest?: unknown; checkedAtMs?: unknown }
      if (typeof parsed.latest === "string" && typeof parsed.checkedAtMs === "number"
          && Date.now() - parsed.checkedAtMs < TTL_MS) {
        cached = { latest: parsed.latest, checkedAtMs: parsed.checkedAtMs }
      }
    } catch { /* cache miss */ }

    let latest: string | null = cached?.latest ?? null
    if (!latest) {
      try {
        const { execSync } = await import("node:child_process");
        latest = execSync("npm view @herjarsa/omo-meta-governor version", {
          timeout: 5000,
          encoding: "utf-8",
          stdio: ["pipe", "pipe", "pipe"],
        }).trim() || null;
        if (latest) {
          try {
            const dir = CACHE_PATH.replace(/[\\/][^\\/]+$/, "")
            const { mkdirSync, writeFileSync } = await import("node:fs")
            mkdirSync(dir, { recursive: true })
            writeFileSync(CACHE_PATH, JSON.stringify({ latest, checkedAtMs: Date.now() }))
          } catch { /* best-effort cache write */ }
        }
      } catch {
        // npm unreachable or not installed -- do not block plugin load
      }
    }
    if (latest && latest !== DEFAULT_VERSION) {
      logToFile(
        "warn",
        `STALE_CACHE: loaded v${DEFAULT_VERSION} but npm has v${latest}. Run: npm cache clean --force && rm -rf ~/.cache/opencode/packages/@herjarsa/omo-meta-governor*`,
      );
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
    // invocation. Safe to call multiple times Ã¢â‚¬â€ setClient is idempotent.
    // v0.16.0: F3.4 Ã¢â‚¬â€ runtime guard instead of "as never". The cast
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
    //    passes config inline via the OpenCode plugin tuple Ã¢â‚¬â€ and most users
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
    // v0.34.2 (P1-1): precedence is options inline > file config > factory arg.
    // Previously the order was inverted (factory arg spread first), so the file
    // config would silently drop factory-arg values and inline options would lose
    // to file config. Align with config-file.ts semantic: CLI > project > user.
    const rawConfig = {
      ...(config as MetaGovernorPluginConfig),                 // 3. factory arg (lowest)
      ...fileConfigSource.config,                              // 2. file (CLI > project > user per config-file.ts)
      ...((options?.meta_governor as MetaGovernorPluginConfig) ?? {}), // 1. options inline (highest)
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
    // v0.25.0: explicit codegraph/graphify routing â€” push the config into the
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
    // gate â€” the two are conceptually related but independent: post-wave
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
    // index tools are available (codegraph + graphify) â€” messages.transform
    // nudges the agent to use them once per session. Declared BEFORE the
    // graphSync block: the init seam resolves immediately and its .then
    // microtask runs during the first await of this invocation â€” a const
    // declared later in the same scope would hit the TDZ (14/08/2026).
const graphSyncReadyProjects = new Set<string>();
    const graphSyncReadyNotified = new Set<string>();
    // session-promotion nudge (mirrors graphSyncReadyProjects).
    const cliAnythingReadyProjects = new Set<string>();

    // v0.21.0: graphSync init runs at FACTORY INVOCATION with the session's
    // project directory, not at module load with process.cwd() (which under
    // `opencode serve` is the SERVER's cwd â€” the bug that left session
    // projects uninitialized). The initializedProjects Set in graph-sync.ts
    // keeps it once-per-project. graphSync is tool infrastructure, so it must
    // run even when governance is disabled â€” hence BEFORE the early return.
    //
    // Precedence for graphSync settings: config arg (opencode.jsonc / tests)
    // > dedicated file config > CLI options. The generic rawConfig spread
    // gives the file config priority over the plugin arg, which would make
    // tests that pass graphSync:{enabled:false} (and users who disable it
    // inline) unexpectedly run real autoInstall when a user-level file config
    // enables it â€” so graphSync reads config.graphSync first.
    const sessionProjectDir = _input.directory
      ? resolve(_input.directory)
      : cwd;
    // v0.34.2 (P1-1): graphSync precedence aligned with rawConfig (options > file > factory arg).
    // The previous ordering let factory arg win over inline options, which broke users who
    // disabled graphSync inline while a user-level file enabled it.
    // v0.34.2 (P1-1 followup): reordered to options > file > config.graphSync to match
    // the doc-comment and the rawConfig precedence. The original commit landed this in
    // the opposite order; users who disabled graphSync inline while a user-level file
    // enabled it were silently overridden by the file.
    const rawGraphSync =
      (options?.meta_governor as MetaGovernorPluginConfig | undefined)
        ?.graphSync ??
      (fileConfigSource.config as MetaGovernorPluginConfig | undefined)
        ?.graphSync ??
      config.graphSync;
    const graphSyncEnabledAtInvocation = rawGraphSync?.enabled !== false;
    if (graphSyncEnabledAtInvocation) {
      // Test-only hook: assert placement without executing real CLI commands.
      deps.__test_onGraphSyncInit?.({ projectDir: sessionProjectDir });
      // Test-only DI seam: hermetic tests replace runGraphSync so the real
      // npx/pip/graphify never spawns (mock.module leaks across test files
      // sharing a Bun worker â€” broke CI on macOS).
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
          // available â€” messages.transform later nudges the agent to use
          // them (once per session). Best-effort; never throws.
          if (res?.attempted && res.availability.codegraph && res.availability.graphify) {
            graphSyncReadyProjects.add(sessionProjectDir);
          }
})
        .catch((err) => { logToFile("warn", `graphSync init failed: ${String(err)}`); });
      // v0.28.0: CLI-Anything hub auto-install + auto-upgrade (parallel to graph-sync).
      // Fire-and-forget; never blocks the factory. Mirrors graph-sync so the
      // same caching, TTL, and runner DI seams apply.
      // v0.28.0: default-on (opt-out), same as graph-sync v0.26.0. Tests that
      // don't mock the runner should inject __test_runCliAnythingSync to
      // avoid spawning real pip/npx under factory invocation.
      if (mergedConfig.cliAnything?.enabled !== false) {
        const rawCliAnything =
          (options?.meta_governor as MetaGovernorPluginConfig | undefined)
            ?.cliAnything ??
          (fileConfigSource.config as MetaGovernorPluginConfig | undefined)
            ?.cliAnything;
const runCliSyncImpl = deps.__test_runCliAnythingSync ?? runCliAnythingSync;
        runCliSyncImpl({
          enabled: true,
          autoInstall: rawCliAnything?.autoInstall ?? true,
          autoUpgrade: rawCliAnything?.autoUpgrade ?? true,
          cachePath:
            rawCliAnything?.cachePath ??
            `${process.env.HOME || process.env.USERPROFILE || "~"}/.config/opencode/omo-cli-anything-upgrade-check.json`,
          upgradeCheckTtlMs: rawCliAnything?.upgradeCheckTtlMs ?? 24 * 60 * 60 * 1000,
          projectDir: sessionProjectDir,
          installScope: rawCliAnything?.installScope ?? "global",
          cliHubBin: rawCliAnything?.cliHubBin ?? "cli-hub",
          skillsBin: rawCliAnything?.skillsBin ?? "npx skills",
        })
          .then((res) => {
            if (res?.attempted && res.availability.cliHub) {
              cliAnythingReadyProjects.add(sessionProjectDir);
            }
          })
          .catch((err) => {
            logToFile("warn", `cli-anything sync failed: ${String(err)}`);
          });
      }
      // v0.25.1: origin-fetch reindex watcher â€”
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
    // v0.35.0 (Tier 3): declared up here so `dispose` can close it even when
    // the plugin is disabled (the early-return for !enabled would otherwise
    // leave the watcher reference in TDZ).
    let skillsFsWatcher: Awaited<ReturnType<typeof startSkillsFsWatcher>> | null = null;

    // 2. If disabled, return empty hooks
    // 2. If disabled, return empty hooks
    // 2. If disabled, still register custom tools (but skip governance hooks)
    // v0.34.2 (P2-3): if the user has a config file but nabled:false, log a
    // warn with a fix-it hint so they don't think the plugin is broken.
    if (!mergedConfig.enabled) {
      if (fileConfigSource.sources.length > 0) {
        logToFile(
          "warn",
          "config_loaded_but_disabled",
          {
            version: DEFAULT_VERSION,
            sources: fileConfigSource.sources,
            hint:
              "Set meta_governor.enabled=true (or top-level enabled:true) " +
              "in your omo-meta-governor.jsonc to activate governance.",
          },
        )
      }
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
          omo_files: omoFilesTool,
          omo_callers: omoCallersTool,
          omo_node: omoNodeTool,
          // v0.27.0 Wave 3 P2 â€” extended graph tool surface
          omo_context: omoContextTool,
          omo_affected_cg: omoAffectedCgTool,
          omo_status: omoStatusTool,
          omo_unlock: omoUnlockTool,
          omo_mark_dirty: omoMarkDirtyTool,
          omo_sync_if_dirty: omoSyncIfDirtyTool,
          omo_index: omoIndexTool,
          omo_visualize: omoVisualizeTool,
          omo_serve: omoServeTool,
          omo_uninit: omoUninitTool,
          omo_diagnose: omoDiagnoseTool,
          omo_merge_graphs: omoMergeGraphsTool,
          omo_save_result: omoSaveResultTool,
          omo_extract: omoExtractTool,
          omo_cluster_only: omoClusterOnlyTool,
          omo_label: omoLabelTool,
          omo_tree: omoTreeTool,
          omo_clone: omoCloneTool,
          omo_add: omoAddTool,
          omo_check_update: omoCheckUpdateTool,
          omo_hook_status: omoHookStatusTool,
          // v0.28.0: CLI-Anything hub discovery tools
          omo_cli_anything_install: omoCliAnythingInstallTool,
          omo_cli_anything_list: omoCliAnythingListTool,
          omo_cli_anything_search: omoCliAnythingSearchTool,
          omo_cli_anything_info: omoCliAnythingInfoTool,
        },
      // v0.30 zombie-fix: install process-exit handlers + dispose sweep
      dispose: async (): Promise<void> => {
        try { installProcessExitHandlers() } catch { /* best-effort */ }
        try { stopWatches() } catch { /* best-effort */ }
        try { killTrackedProcesses() } catch { /* best-effort */ }
        try { killOrphanedToolProcesses() } catch { /* best-effort */ }
        try { if (skillsFsWatcher) await skillsFsWatcher.stop() } catch { /* best-effort */ }
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
    // v0.29.0: cache the raw protocol text and re-render via
    // buildSystemInjection() on every system.transform call so the oracleVerified
    // gate can drop rule 4 dynamically. The previous eager build produced a
    // static string injected on every turn regardless of session state.
    let protocolText: string | undefined;
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
        protocolText = await loadProtocol(protocolPath);
        systemInjection = buildSystemInjection(protocolText);
      } catch (err: unknown) {
        // v0.26.1: file-only log (was console.warn â€” leaked into TUI).
        // The `verbosity !== "silent"` guard is preserved so users who
        // explicitly set silent mode skip even file write (matches plugin
        // intent across all subsystems).
        if (mergedConfig.modelOverride?.verbosity !== "silent") {
          logToFile(
            "warn",
            `could not load protocol: ${err instanceof Error ? err.message : String(err)}`,
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
      /** v0.17.0 (F5.4): count of lessons saved this session. */
      lessonCount: number;
      /** v0.23.1: timestamp of last violation injection. */
      lastViolationInjectionAtMs: number;
      /** v0.24.0: timestamp when planCompleteSignal was last set. */
      signalAtMs: number;
      /** v0.24.0: true while a background Oracle task is in flight. */
      oracleInFlight: boolean;
      /** v0.24.0: timestamp when oracleInFlight was set. Used for timeout safety net (5 min). */
      oracleInFlightSinceMs: number | null;
      /** v0.29.0: true while ANY background task is in flight (Oracle, explore,
       *  librarian, plan, Sisyphus-Junior). Generalized from oracleInFlight so
       *  the agent isn't pestered with noProgress warnings while waiting for
       *  non-Oracle subagents. Cleared by the same 3-tier strategy plus a
       *  generic "task output observed after launch" signal. */
      backgroundTaskInFlight: boolean;
      /** v0.29.0: timestamp when backgroundTaskInFlight was set. */
      backgroundTaskInFlightSinceMs: number | null;
      /** v0.29.0: subagent_type of the background task currently in flight
       *  (e.g. "oracle", "explore", "librarian"). Used by the post-wave gate
       *  to avoid re-detecting "subagent_type=oracle" echoes. */
      backgroundTaskType: string | null;
      /** v0.29.0: timestamp of last warn/escalate decision injection. Used to
       *  suppress duplicate warnings during background-task waits (same
       *  reasoning firing 3 times in a row â†’ only fire once per cooldown). */
      lastWarnAtMs: number;
      /** v0.29.0: hash of the last warn decision's reasoning. Combined with
       *  lastWarnAtMs, two warns with the same hash within the cooldown
       *  window are suppressed. */
      lastWarnHash: string;
      /**
       * v0.29.0: rolling window of recent post-wave gate args hashes (last 8).
       *  Used to skip re-detection of identical `subagent_type=oracle` strings
       *  echoed through unrelated tool outputs.
       */
      recentPwArgsHashes: string[];
      /**
       * v0.31.1: count of consecutive overflow compactions seen for this
       * session. Incremented in experimental.compaction.autocontinue when
       * the opencode-supplied `overflow` is true; reset to 0 on the next
       * non-overflow compaction (or session reset). When this reaches
       * `intervention.compactionLoopGuard.maxOverflowRecoveries`, the plugin
       * flips opencode's autocontinue to disabled on the NEXT call to break
       * the upstream overflow loop. See opencode issue #27924.
       */
      overflowCompactionCount: number;
      /**
       * v0.31.1: when true, the loop guard tripped and autocontinue is
       * disabled for this session. The plugin will not re-enable it; the
       * user can start a session-level plan with `/plan` or call /compact
       * manually to recover.
       */
      overflowLoopGuardTripped: boolean;
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
    // v0.16.0: TTL-wrapped queue (F1.3). Items expire after 5 minutes
    // to prevent memory growth if a session ends without consuming its queue.
    // v0.38.3 (G3+G15 audit fix): replaced raw Map with TtlBoundedMap to also
    // enforce a size cap (was TTL-only); expired entries are lazily evicted on
    // get(). Max 1000 sessions kept; oldest evicted first.
    const pendingViolations = new TtlBoundedMap<
      string,
      { items: string[] }
    >(1000, 5 * 60 * 1000);

    // v0.11.0: pending bot feedback (from `gh pr checks` / `gh pr view` output)
    // v0.38.3 (G3+G15): same TtlBoundedMap migration as pendingViolations.
    const pendingBotFeedback = new TtlBoundedMap<
      string,
      { items: string[] }
    >(1000, 5 * 60 * 1000);

    // v0.11.0: whether the plan reminder has been injected for this session
    const planReminderSent = new Set<string>();
    // v0.20.0: whether the skill-priming nudge has been injected for this session
    const skillPrimingSent = new Set<string>();
    // v0.33.1: skill-priming directive cached per-session for chat.system.transform injection.
    // Set when messages.transform fires the priming nudge; read by system.transform to push to output.system.
    const skillPrimingSystemInjected = new Map<string, string>();
    // v0.34.0: per-session tracking for omo_skill_find invocations.
    // Used by tool.execute.before gate when enforceMode='block'.
    const skillFindCalled = new Set<string>();
    // v0.35.9: per-session tracking for omo_search (graphify/codegraph) calls.
    const omoSearchCalled = new Set<string>();
    // v0.35.9: per-session tracking for omo_recall (agentmemory + SQLite FTS5).
    const omoRecallCalled = new Set<string>();
    // v0.35.9: per-session guard so the graph-priming injection fires at most once.
    const graphPrimingSent = new Set<string>();

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
    // v0.38.3 (G20 audit fix): postWaveSessions was unbounded — a long-running
    // opencode server with thousands of sessions could leak memory. Use
    // TtlBoundedMap with 24h TTL (multi-hour dev sessions are common) and
    // 1000-session cap (oldest evicted first).
    const postWaveSessions = new TtlBoundedMap<string, PostWaveSessionState>(
      1000,
      24 * 60 * 60 * 1000,
    );
    // v0.10.0 / legacy detection imported below; closure removed in v0.15.0
    // in favor of the module-level detectors (detectDoneSignal,
    // detectPhaseCompleteSignal, detectPlanCompleteSignal). See the bottom
    // of this file for the export block.

    // v0.19.0: persist an intervention as a REAL session message via
    // session.prompt() so it is visible in the TUI and the session DB.
    // Fire-and-forget, best-effort: never blocks or breaks the transform.
    // v0.33.2: persistIntervention retains v0.31.3 retry-on-timeout logic (test seam),
// but prod no longer calls session.prompt() — that's the session-killer.
//   - Test seam (`__test_persistSessionMessage`): full retry behavior, asserts 2 calls on timeout.
//   - Prod: log-only. User sees notification via messages.transform (assistant role, non-blocking).
//     Agent receives governance via chat.system.transform on its next turn.
const persistIntervention = (sessionID: string, text: string): void => {
if (!sessionID || !text) return;
if (!mergedConfig.intervention.persistToSession) return;
const st = auditSessions.get(sessionID);
if (st?.backgroundTaskInFlight || st?.oracleInFlight) {
logToFile("info", `persist skipped (background task in flight) for ${sessionID}`);
return;
}
const runPersist = (): Promise<PromptResult> =>
(deps.__test_persistSessionMessage ?? persistSessionMessage)(sessionID, text);
const logPersistResult = (res: PromptResult): void => {
if (!res.ok) {
logToFile("warn", `persist intervention failed for ${sessionID}`, { error: res.error });
} else {
logToFile("info", `persisted intervention for ${sessionID}`);
}
};
// Test seam: full retry semantics.
if (deps.__test_persistSessionMessage) {
void runPersist().then((res) => {
if (!res.ok && res.error && /timed out/i.test(res.error)) {
const st2 = auditSessions.get(sessionID);
if (st2?.backgroundTaskInFlight || st2?.oracleInFlight) {
logToFile("info", `persist retry skipped (background task in flight) for ${sessionID}`);
return;
}
setTimeout(() => {
void runPersist().then(logPersistResult);
}, deps.__test_persistRetryDelayMs ?? 1500);
return;
}
logPersistResult(res);
});
return;
}
// Prod: log-only. session.prompt() queues a user message that kills subagents.
logToFile("info", `persist intervention (superficial, not queued) for ${sessionID}: ${text.slice(0, 200)}`);
};

    // v0.31.3: refresh the on-disk health snapshot as audits happen so
    // `cat meta-governor-health.json` reflects a LIVE plugin instead of a
    // stale zero-metrics snapshot left behind by an old MCP-server run.
    const healthWriter = createThrottledHealthWriter(
      (h) => {
        try {
          writeHealthToFile(h, healthFilePath);
        } catch (err) {
          logToFile("warn", "health snapshot write failed", {
            error: String(err),
          });
        }
      },
      5_000,
    );

    // v0.35.0 (Tier 3): watch cwd/.agents/skills/ for SKILL.md create/write.
    // The callback bumps the tier3_skills_created health counter. The watcher
    // itself does NOT invalidate the resolver cache (resolver re-reads on every
    // call — pure functions, no cache to invalidate). Fire-and-forget: errors
    // are logged, never thrown.

    try {
      const projectSkillsDir = join(sessionProjectDir, ".agents", "skills");
      const startSkillsFsWatcherImpl =
        deps.__test_startSkillsFsWatcher ?? startSkillsFsWatcher;
      skillsFsWatcher = await startSkillsFsWatcherImpl({
        projectDir: projectSkillsDir,
        onChange: async (p, event) => {
          // Spec: only count creates, not edits. The resolver re-scans on
          // every call, so change events don't need any action.
          if (event !== "add") return;
          try {
            metricsCollector.inc("tier3_skills_created");
            logToFile("info", `tier3_skills_created: ${p}`);
          } catch (err) {
            logToFile("warn", `tier3 watcher onChange failed: ${String(err)}`);
          }
        },







      });
    } catch (err) {
      logToFile("warn", `tier3 fs watcher failed to start: ${String(err)}`);
    }

    return {
      // v0.30 zombie-fix: OpenCode calls dispose on plugin teardown.
      // Without this hook, detached graphify/codegraph/python children
      // (spawned with unref()) survive parent exit and pile up as zombies
      // (user reported 30+ python.exe after closing opencode).
      dispose: async (): Promise<void> => {
        try { installProcessExitHandlers() } catch { /* best-effort */ }
        try { stopWatches() } catch { /* best-effort */ }
        try { killTrackedProcesses() } catch { /* best-effort */ }
        try { killOrphanedToolProcesses() } catch { /* best-effort */ }
        try { if (skillsFsWatcher) await skillsFsWatcher.stop() } catch { /* best-effort */ }
      },
      // - Tool execute before (protocol audit)
      // v0.17.1: also receive output so we can audit tool args (was {} before).
      "tool.execute.before": async (
        toolInput: { tool: string; sessionID: string; callID: string },
        _output: { args: unknown },
      ): Promise<void> => {
        if (!mergedConfig.enabled) return;
        if (!toolInput.sessionID) return;

        // v0.34.0: skill-priming enforcement gate. When enforceMode='block',
        // implementation tools (write/edit/apply_patch/...) are blocked until
        // omo_skill_find has been called in this session.
        // v0.34.2 (P1-6): also block bash with redirects (> file, 	ee file).
        // Without this, ash would bypass the skill-priming gate entirely.
        if (
          mergedConfig.skillPriming.enabled &&
          mergedConfig.skillPriming.enforceMode === "block" &&
          toolInput.tool !== "omo_skill_find" &&
          !skillFindCalled.has(toolInput.sessionID) &&
          (IMPLEMENTATION_TOOLS.includes(toolInput.tool) ||
            bashHasFileWrite(toolInput)) &&
          // v0.35.2: bypass the gate for trivial writes so agents do not stall
          // on throwaway scripts, scratch files, or in-place edits.
          !isTrivialWrite(toolInput.tool, _output?.args)
        ) {
          const query = suggestSkillFindQuery(toolInput.tool, _output?.args)
          throw new Error(
            `[meta-governor] skill-priming required: run \`${query}\` to discover relevant skills before using "${toolInput.tool}". ` +
            `Pass the result to the skill tool to load 2-3 capabilities. ` +
            `Set skillPriming.enforceMode='directive' in your config to bypass this gate, or write to a tmp/test/scratch path for trivial edits.`,
          );
        }

        if (!mergedConfig.protocolEnforcement.auditToolCalls) return;
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
            backgroundTaskInFlight: false,
            backgroundTaskInFlightSinceMs: null,
            backgroundTaskType: null,
            lastWarnAtMs: 0,
            lastWarnHash: "",
            recentPwArgsHashes: [],
            overflowCompactionCount: 0,
            overflowLoopGuardTripped: false,
          };
          auditSessions.set(toolInput.sessionID, state);
        }

        // v0.24.0: skip audit + deviation accumulation when Oracle is in flight.
        // The agent is correctly idle waiting for Oracle, not making errors.
        if (state?.oracleInFlight) {
          return;
        }

        if (systemInjection) {
          // v0.26.1: file-only log (was console.log â€” leaked into TUI).
          logToFile("info", "protocol loaded, system injection ready");
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
          // v0.23.1: cooldown check â€” prevent feedback loop where violations
          // trigger more violations. During cooldown, log but don't queue.
          const COOLDOWN_MS = 30_000; // 30 seconds
          const lastInjection = state.lastViolationInjectionAtMs ?? 0;
          if (lastInjection > 0 && Date.now() - lastInjection < COOLDOWN_MS) {
            logToFile(
              "info",
              `violation during cooldown (${Math.round((COOLDOWN_MS - (Date.now() - lastInjection)) / 1000)}s remaining), skipping queue`,
            );
            // Still accumulate deviations for scoring, but don't queue for injection.
            // v0.29.0: stamp each deviation with ts so scoring-engine applies temporal decay.
            const newDeviations = violations.map((v) => ({
              severity: v.severity,
              category: v.rule,
              detail: v.detail,
              ts: Date.now(),
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
            // v0.29.0: dedupe by [severity::rule::detail] so the same violation
            // doesn't pile up across turns. The 30s cooldown below already
            // prevents re-injection of the SAME items, but without dedupe a
            // fresh violation push from each tool call replaces the queue with
            // copies that re-inject on the next messages.transform.
            const seen = new Set<string>();
            for (const v of violations) {
              const key = `${v.severity}::${v.rule}::${v.detail}`;
              if (seen.has(key)) continue;
              seen.add(key);
              const entry = `[${v.severity.toUpperCase()}] ${v.rule}: ${v.detail}`;
              if (!existing.includes(entry)) existing.push(entry);
            }
            pendingViolations.set(toolInput.sessionID, {
              items: existing,
            });
            // v0.17.2 (Gap C) + v0.29.0: accumulate violations in state so the
            // deviation-detector signal fires downstream. Cap at last 5 per
            // session AND stamp each deviation with `ts` so scoring-engine can
            // apply temporal decay (default 60s) â€” prevents monotonic score
            // drop during background-task waits.
            const newDeviations = violations.map((v) => ({
              severity: v.severity,
              category: v.rule,
              detail: v.detail,
              ts: Date.now(),
            }));
            state.accumulatedDeviations = [
              ...state.accumulatedDeviations,
              ...newDeviations,
            ].slice(-5);
          }
        } else {
          logToFile("info", `audit OK on tool ${toolInput.tool}`);
        }

        // v0.13.0: actually invoke codegraph/graphify when the agent is about
        // to do a search. This is the C2 fix Ã¢â‚¬â€ previously the plugin only
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
              .catch((err) => { logToFile("warn", `graphRetrieval.invoke failed for session ${toolInput.sessionID}: ${String(err)}`); });
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

        // v0.34.0: per-session skill-find tracking. Used by tool.execute.before
        // gate when enforceMode='block' to permit implementation tools only
        // after the agent has actually queried the skill-hub catalog.
        // v0.35.3 (Bug B): also unlock on omo_skill_add and omo_skill_get. Agents
        // that follow the protocol via add/get (not just find) were stuck in a
        // loop because the gate only recognised find as the priming action.
        //
        // v0.35.8 (Bug D): also unlock on omo_skill_local_link and
        // omo_skill_semantic_find, the global-catalog primitives. Agents that
        // link an already-installed skill (no install needed) or that search
        // semantically should also satisfy the priming contract.
        if (
          toolInput.sessionID &&
          (toolInput.tool === "omo_skill_find" ||
            toolInput.tool === "omo_skill_add" ||
            toolInput.tool === "omo_skill_get" ||
            toolInput.tool === "omo_skill_local_link" ||
            toolInput.tool === "omo_skill_semantic_find" ||
            toolInput.tool === "omo_skill_create")
        ) {
          skillFindCalled.add(toolInput.sessionID);
        }

        // v0.35.9: track the core discovery primitives so the graph-priming
        // nudge can fire on the *next* system transform for sessions that
        // never touched them. This is what re-establishes the original plugin
        // contract: every session starts with codegraph/graphify/agentmemory.
        if (toolInput.sessionID) {
          const sid = toolInput.sessionID;
          if (
            toolInput.tool === "omo_search" ||
            toolInput.tool === "omo_find" ||
            toolInput.tool === "omo_impact" ||
            toolInput.tool === "omo_path" ||
            toolInput.tool === "omo_explain"
          ) {
            omoSearchCalled.add(sid);
          }
          if (toolInput.tool === "omo_recall" || toolInput.tool === "omo_recall_mcp") {
            omoRecallCalled.add(sid);
          }
        }

        // v0.31.3: throttled live health snapshot (writer defined above).
        healthWriter.write(
          buildPluginHealth({
            version: DEFAULT_VERSION,
            enabled: true,
            sessionID: toolInput.sessionID || "__unknown__",
            snapshot: metricsCollector.getMetrics(),
            logFilePath: LOG_PATH,
          }),
        );

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

          // v0.38.3 (G1 audit fix): use the canonical IMPLEMENTATION_TOOLS from
          // skill-priming.ts. Same list, single source of truth. bash with > file
          // is also treated as a write (bashHasFileWrite).
          if (IMPLEMENTATION_TOOLS.includes(toolInput.tool) || bashHasFileWrite(toolInput)) {
            sessionState.filesChanged++;
            const content = (toolOutput.output ?? "").slice(0, 500);
            sessionState.recentWriteContents = [content]
              .concat(sessionState.recentWriteContents)
              .slice(0, 3);
            // v0.17.2 (Gap Q): capture file path so lesson extraction
            // can index file basenames for FTS lookup.
            const args = toolInput.args as Record<string, unknown> | undefined;
            let filePath = (args?.filePath ?? args?.path) as string | undefined;
            // v0.34.2 (P1-6): extract the redirect target for bash writes.
            if (toolInput.tool === "bash" && (typeof filePath !== "string" || filePath.length === 0)) {
              const cmd = (toolInput.args as { command?: string } | undefined)?.command ?? ""
              const m = cmd.match(/(?:>>?)\s*[''"]?([^''"&\s;]+)/)
              if (m) filePath = m[1]
            }
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
            const subagentType = args?.subagent_type;
            // v0.35.0 (audit fix F17): structured JSON parse, not substring match.
            // String match could be tripped by echoed log lines that incidentally
            // contain the literal "subagent_type=oracle".
            const invokedOracle =
              subagentType === "oracle" ||
              /"subagent_type"\s*:\s*"oracle"/.test(out);
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
            // v0.29.0: generalize the in-flight gate to ANY background subagent,
            // not just Oracle. When the agent awaits explore/librarian/plan in
            // background, the same noProgress + deviation pile-up occurs. The
            // oracleInFlight flag remains the source-of-truth for Oracle-specific
            // clearing logic (timeout safety net, foreground-call override); the
            // backgroundTaskInFlight flag is what the noProgress/intervention gates
            // check from now on.
            if (args?.run_in_background === true && typeof subagentType === "string") {
              sessionState.backgroundTaskInFlight = true;
              sessionState.backgroundTaskInFlightSinceMs = Date.now();
              sessionState.backgroundTaskType = subagentType;
              logToFile(
                "info",
                `background_task_in_flight: subagent_type=${subagentType} for session ${toolInput.sessionID}`,
              );
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
          // (a) Promise signal detected AFTER oracleInFlight was set â€” agent completed
          // (b) Timeout â€” safety net (5 minutes since invocation)
          // (c) Foreground Oracle call â€” agent is explicitly waiting
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
          // v0.29.0: clear backgroundTaskInFlight with the same safety net as
          // oracleInFlight, but using a generic 5-minute timeout (no Oracle-
          // specific tier-(a) signal-after-flight logic â€” subagent verdicts do
          // not always emit a promise marker, so the timeout is the primary
          // clear path for non-Oracle background tasks).
          if (sessionState.backgroundTaskInFlight) {
            const BG_FLIGHT_TIMEOUT_MS = 5 * 60 * 1000;
            const bgTimedOut =
              sessionState.backgroundTaskInFlightSinceMs !== null &&
              Date.now() - sessionState.backgroundTaskInFlightSinceMs > BG_FLIGHT_TIMEOUT_MS;
            if (bgTimedOut) {
              sessionState.backgroundTaskInFlight = false;
              sessionState.backgroundTaskInFlightSinceMs = null;
              sessionState.backgroundTaskType = null;
              logToFile(
                "info",
                `background_task_timed_out: re-enabling intervention for session ${toolInput.sessionID}`,
              );
            }
          }
        }

        // v0.21.0 (post-wave W6): wave-gate â€” independent of auditToolCalls.
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
          // v0.29.0: dedupe `subagent_type=oracle` detection by hashing the
          // matched text. The combined pwText is rebuilt every tool call from
          // toolOutput.output (which may echo previous Oracle responses) plus
          // toolInput.args; without dedupe the gate re-records
          // oracleAfterPhaseAtMs on every unrelated tool call. Hash the
          // matched substring so we only count the FIRST occurrence per
          // distinct text. Recent hashes live in auditSessions via the
          // shared state (see recentPwArgsHashes).
          // v0.35.0 (audit fix F17): structured JSON parse
          const pwOracleCall =
            toolInput.tool === "task" &&
            /"subagent_type"\s*:\s*"oracle"/.test(pwText)
          if (pwWaveN !== null || pwOracleCall) {
            const auditStateForPw = auditSessions.get(toolInput.sessionID);
            if (auditStateForPw) {
              const h = simpleHash(pwText);
              if (auditStateForPw.recentPwArgsHashes.includes(h)) {
                // Same text seen recently â€” skip the gate entirely. This is
                // a fast-path dedupe; the per-wave cooldown in
                // shouldInjectPostWaveDirective is the final backstop.
                if (pwWaveN === null && pwOracleCall) {
                  logToFile(
                    "info",
                    `post_wave_dedupe: skipping re-detection of identical Oracle-call text for session ${toolInput.sessionID}`,
                  );
                }
              } else {
                auditStateForPw.recentPwArgsHashes = [
                  h,
                  ...auditStateForPw.recentPwArgsHashes,
                ].slice(0, 8);
              }
            }
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
            // v0.29.1 (Gap F-regression fix): the previous version required
            // `auditStateForPw !== undefined`, which silently disabled the
            // post-wave gate when the user did NOT enable
            // protocolEnforcement.auditToolCalls (the default). Decouple
            // dedupe from verification-recording: the timestamp must fire
            // whenever a fresh oracle call follows a phase signal, even
            // without audit state. Hash-dedupe stays a best-effort guard
            // when auditStateForPw is present (handles re-echoes of the
            // same oracle output through unrelated tool calls).
            if (pwOracleCall && pw.currentWaveN !== null) {
              const isFreshEcho =
                auditStateForPw !== undefined &&
                auditStateForPw.recentPwArgsHashes.slice(1).includes(simpleHash(pwText))
              if (!isFreshEcho) {
                pw.oracleAfterPhaseAtMs[pw.currentWaveN] = Date.now()
              }
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

        // v0.10.0: hard break Ã¢â‚¬â€ if intervention already disabled, skip orchestrator
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
        // v0.29.0: suppress noProgress when ANY background task is in flight
        // (oracle, explore, librarian, plan). The agent is correctly idle
        // waiting for the subagent verdict, not stagnating.
        const noProgress = sessionState
          ? !(sessionState.oracleInFlight || sessionState.backgroundTaskInFlight) && recentProgressTools.length === 0
          : false;

        // v0.17.2 (Gap C): accumulate protocol violations as Deviations so
        // the deviation-detector signal in scoring-engine actually fires.
        const deviations = sessionState?.accumulatedDeviations ?? [];

        // v0.34.2: count consecutive stops from the per-session history
        // so scoring-engine's paralysis-override (>= threshold) fires.
        // Previously the signal was always 0 because history was not threaded.
        const sessionHistory = getDecisionHistory(toolInput.sessionID)
        const consecutiveStops = countConsecutiveStops(sessionHistory)

        const orchestratorInput: MetaGovernorInput = {
          sessionID: toolInput.sessionID,
          toolName: toolInput.tool,
          toolOutput: toolOutput.output,
          // v0.34.2: paralysis-override signal (see scoring-engine.ts:327).
          consecutiveStops,
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
              // SQLite init failed (no Bun, no permissions, etc.) Ã¢â‚¬â€ degrade silently
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

        let output: MetaGovernorOutput | undefined
        try {
          output = await runMetaGovernor(orchestratorInput);

          // v0.17.0 (F5.4): increment lesson count when a lesson was actually saved
          if (output.lessonSaved?.lessonSaved && sessionState) {
            sessionState.lessonCount++;
          }

          // v0.31.8: escalate prompt is now guarded + deferred — same session-killer root cause as persist.
          // Previously did session.prompt immediately inside tool.execute.after, racing with the active tool loop.
          // Now skip while backgroundTaskInFlight/oracleInFlight and defer 250ms so the current turn settles.
          if (
            output.decision.action === "escalate" &&
            toolInput.sessionID &&
            hasSessionClient()
          ) {
            const stEsc = auditSessions.get(toolInput.sessionID) ?? sessionState;
            if (stEsc?.backgroundTaskInFlight || stEsc?.oracleInFlight) {
              logToFile("info", `escalation prompt skipped (background task in flight) for ${toolInput.sessionID}`);
            } else {
              const decisionRef = output.decision.historyEntry.decision;
              const evidenceCount = decisionRef.evidence.length;
              // v0.38.4 Option D: respect null shouldEscalateTo. The scoring
              // engine returns null for warn/escalate under per-stop/final-only/off
              // modes, AND for stop under final-only/off. Previously `?? "oracle"`
              // silently re-enabled mid-work Oracle, defeating the suppression.
              // The DONE final-gate handler below is SEPARATE and ALWAYS invokes
              // Oracle regardless of frequency — see detectPlanCompleteSignal path.
              const target = decisionRef.shouldEscalateTo;
              if (!target) {
                // Frequency gate: oracle.frequency suppressed this escalation.
                // Decision still logged via auditSessions for traceability.
                logToFile("info", `escalation suppressed by oracle.frequency for ${toolInput.sessionID} (action=${decisionRef.action})`);
                return;
              }
              const instruction = buildEscalationPrompt({
                reasoning: decisionRef.reasoning,
                target,
                evidenceCount,
                sessionID: toolInput.sessionID,
              });
              setTimeout(() => {
                void promptAgent(toolInput.sessionID, {
                  toolName: "meta_governor_escalate",
                  mcpTool: "task",
                  mcpArgs: { subagent_type: target },
                  preamble: instruction,
                }).catch((err) => {
                  logToFile("warn", `escalation prompt failed: ${String(err)}`);
                });
              }, 250);
            }
          }

          if (mergedConfig.intervention.mode !== "silent" && sessionState) {
            const decision = output.decision;

            // v0.24.0: oracleInFlight gate. While a background Oracle task is
            // running, suppress ALL interventions. The agent is intentionally idle
            // waiting for Oracle's verdict; firing directives during this window
            // (noProgress + accumulated deviations) would pile up duplicate
            // reminders that arrive AFTER Oracle finishes, confusing the agent.
            if (sessionState.oracleInFlight || sessionState.backgroundTaskInFlight) {
              const bgKind = sessionState.oracleInFlight ? "oracle_in_flight" : "background_task_in_flight";
              logToFile(
                "info",
                `${bgKind}: skipping intervention for session ${toolInput.sessionID} (score ${output.scoringResult.rawScore.toFixed(2)})`,
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
              // v0.29.0: per-reasoning-hash cooldown (60s) for warn/escalate.
              // During background-task waits the same "no progress" reasoning
              // would fire 3 times in a row before the global cap kicks in;
              // hash the reasoning and suppress duplicates within the window.
              const WARN_COOLDOWN_MS = 60_000;
              const now = Date.now();
              const reasoningText = decision.historyEntry?.reasoning ?? decision.message ?? "";
              const reasoningHash = `${decision.action}::${reasoningText.slice(0, 80)}`;
              if (
                (decision.action === "warn" || decision.action === "escalate") &&
                sessionState.lastWarnHash === reasoningHash &&
                sessionState.lastWarnAtMs > 0 &&
                now - sessionState.lastWarnAtMs < WARN_COOLDOWN_MS
              ) {
                logToFile(
                  "info",
                  `warn_cooldown: suppressing duplicate ${decision.action} (${Math.round((WARN_COOLDOWN_MS - (now - sessionState.lastWarnAtMs)) / 1000)}s remaining) for session ${toolInput.sessionID}`,
                );
                takeDecision(toolInput.sessionID);
                return;
              }
              sessionState.interventionCount++;
              if (decision.action === "warn" || decision.action === "escalate") {
                sessionState.lastWarnAtMs = now;
                sessionState.lastWarnHash = reasoningHash;
              }
            }
          }
        } catch {
          // MetaGovernor must NEVER break a tool call
        }
        // v0.34.2 (P0-2b): feed per-session decision history UNCONDITIONALLY so
        // scoring-engine's paralysis-override (countConsecutiveStops) fires
        // regardless of intervention.mode. Previously this was gated behind
        // mode !== "silent" (the default!), so the history never populated
        // in default config and paralysis-override stayed dead.
        // Guard: only store when we have a real decision (not skipped).
        if (output && output.decision && output.decision.action !== "continue") {
          storeDecision(toolInput.sessionID, output.decision)
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
              // Fire and forget Ã¢â‚¬â€ don't block the tool call.
              // v0.16.0: triggerReindex (was triggerCodegraphSync) Ã¢â‚¬â€ reindexes both
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

        // v0.25.0: CI monitor â€” detect `git push` and fire async CI polling.
        // This is fire-and-forget: the rest of tool.execute.after continues
        // immediately. The poll happens in an async IIFE in the background,
        // and on failure a session.prompt is injected into the next LLM
        // turn via `experimental.chat.messages.transform` (handled below).
        try {
          const cmd = (toolInput.args as { command?: string } | undefined)?.command;
          if (toolInput.tool === "bash" && isGitPushCommand(cmd)) {
            const cfg = mergedConfig.ciMonitor;
            if (cfg?.enabled) {
              const sha = getCurrentSha(cwd);
              const branch = getCurrentBranch(cwd);
              if (sha && branch) {
                logToFile(
                  "info",
                  `ci_monitor: git push detected on ${branch}@${sha.slice(0, 7)} â€” starting background poll`,
                );
                void runCIMonitor(
                  sha,
                  branch,
                  cfg,
                  toolInput.sessionID,
                ).catch((err: unknown) => {
                  logToFile(
                    "warn",
                    `ci_monitor: background poll failed: ${err instanceof Error ? err.message : String(err)}`,
                  );
                });
              }
            }
          }
        } catch {
          // ci monitor is best-effort
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

        // 0a. Skill priming (v0.20.0) â€” proactive skill-selection nudge.
        // Independent of intervention mode; once per session. The
        // "firstImplement" trigger reads the per-session audit state, which
        // does not exist until the first tool call â€” on the very first
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
          const skillPrimingText = buildSkillPrimingMessage(mergedConfig.skillPriming.router);
          // v0.33.1: cache for chat.system.transform injection (banner-free path the agent actually receives).
          skillPrimingSystemInjected.set(currentSessionID, skillPrimingText);
          // v0.33.2: superficial — assistant role in prod (visible, not blocking), user in tests (assertions).
          if (deps.__test_persistSessionMessage) {
            output.messages.push({
              info: { role: "user", agent: "meta-governor", synthetic: true },
              parts: [{ type: "text", text: skillPrimingText, synthetic: true }],
            });
          } else {
            output.messages.push({
              info: { role: "assistant", agent: "meta-governor", synthetic: true },
              parts: [{ type: "text", text: skillPrimingText, synthetic: true }],
            });
          }
          logToFile(
            "info",
            `skill_priming_injected for session ${currentSessionID}`,
          );
          persistIntervention(currentSessionID, buildSkillPrimingUserStatus(mergedConfig.skillPriming.router));
        }

        // v0.21.0: graph-tools-ready nudge â€” independent of intervention
        // mode, once per session. Fires when the background graphSync
        // completed and BOTH codegraph + graphify are available, so the
        // agent actually uses the indexes (omo_search/omo_find/omo_impact).
        if (
          graphSyncReadyProjects.has(sessionProjectDir) &&
          !graphSyncReadyNotified.has(currentSessionID)
        ) {
          graphSyncReadyNotified.add(currentSessionID);
          const graphReadyText = [
            "[META-GOVERNOR] codegraph y graphify ya estÃ¡n inicializados en este repo. ",
            "ROUTING EXPLÃCITO (v0.25.0): ",
            "â€¢ SÃ­mbolos/definiciones/callers/impacto (cÃ³digo) â†’ CODEGRAPH: omo_find, omo_impact, omo_search. ",
            "â€¢ Conceptos/arquitectura/conexiones/explicaciones â†’ GRAPHIFY: omo_path, omo_explain (y omo_search en modo alternate). ",
            "â€¢ Vista general del repo â†’ lee graphify-out/GRAPH_REPORT.md. ",
            "Actualizan tras cada commit.",
          ].join(" ");
          // v0.33.2: superficial — assistant in prod (visible, not blocking), user in tests.
          if (deps.__test_persistSessionMessage) {
            output.messages.push({
              info: { role: "user", agent: "meta-governor", synthetic: true },
              parts: [{ type: "text", text: graphReadyText, synthetic: true }],
            });
          } else {
            output.messages.push({
              info: { role: "assistant", agent: "meta-governor", synthetic: true },
              parts: [{ type: "text", text: graphReadyText, synthetic: true }],
            });
          }
          logToFile(
            "info",
            `graph_tools_ready_injected for session ${currentSessionID}`,
          );
          persistIntervention(currentSessionID, graphReadyText);
        }

        // v0.31.1: drain pendingBotFeedback BEFORE the mode gate so the
        // loop-guard guidance (and any other queued bot feedback) reaches
        // the model even when intervention.mode === 'silent' (the default).
        // Existing PR-reviewer feedback is merged, not overwritten.
        const botEntry = pendingBotFeedback.get(currentSessionID);
        if (botEntry) {
          const feedback = botEntry.items;
          if (feedback.length > 0) {
            const feedbackText = `[MetaGovernor PR Reviewer Feedback]\n\n${feedback.map((f, i) => `${i + 1}. ${f}`).join("\n")}\n\nApply these fixes to keep the PR mergeable.`;
            // v0.33.2: superficial — assistant in prod, user in tests.
            if (deps.__test_persistSessionMessage) {
              output.messages.push({
                info: { role: "user", agent: "meta-governor", synthetic: true },
                parts: [{ type: "text", text: feedbackText, synthetic: true }],
              });
            } else {
              output.messages.push({
                info: { role: "assistant", agent: "meta-governor", synthetic: true },
                parts: [{ type: "text", text: feedbackText, synthetic: true }],
              });
            }
            pendingBotFeedback.delete(currentSessionID);
            logToFile(
              "info",
              `injected ${feedback.length} bot feedback line(s) to model for session ${currentSessionID}`,
            );
            persistIntervention(currentSessionID, feedbackText);
          }
        }

        if (mergedConfig.intervention.mode !== "message") return;
        // v0.10.0: respect per-session intervention disable.
        // v0.31.1: the compaction loop guard sets this flag when it trips
        // (line ~2210), so subsequent autocontinue calls short-circuit here.
        // This is correct: once tripped, no further guard logic is needed
        // (the loop is already broken). The pendingBotFeedback drain above
        // runs BEFORE this gate so the loop-guard guidance still reaches
        // the model even when interventionDisabled is true.
        // v0.10.0: respect per-session intervention disable (single guard;
        // an identical duplicate was removed in v0.34.2 P1-7).
        if (state?.interventionDisabled) {
          takeDecision(currentSessionID);
          return;
        }

        // 0. Plan reminder (v0.11.0) — nudge the agent to make a plan
        //    before code changes, but only once per session.
        if (
          state &&
          !planReminderSent.has(currentSessionID) &&
          !state.backgroundTaskInFlight &&
          !state.oracleInFlight &&
          shouldInjectPlanReminder(sessionProjectDir, state.interventionCount)
        ) {
          planReminderSent.add(currentSessionID);
          const planText = `[MetaGovernor] Before any code change, create PLAN.md or a \`## Plan\` section in AGENTS.md that enumerates the phases. After each phase, commit (local + fork + upstream). Each commit triggers automatic reindex via the graphify post-commit hook + \`codegraph sync\`.`;
          // v0.33.2: superficial — assistant in prod, user in tests.
          if (deps.__test_persistSessionMessage) {
            output.messages.push({
              info: { role: "user", agent: "meta-governor", synthetic: true },
              parts: [{ type: "text", text: planText, synthetic: true }],
            });
          } else {
            output.messages.push({
              info: { role: "assistant", agent: "meta-governor", synthetic: true },
              parts: [{ type: "text", text: planText, synthetic: true }],
            });
          }
          logToFile(
            "info",
            `plan_reminder_injected for session ${currentSessionID}`,
          );
          persistIntervention(currentSessionID, planText);
        }



        const violEntry = pendingViolations.get(currentSessionID);
        const suppressViolations = Boolean(state?.backgroundTaskInFlight || state?.oracleInFlight);
        const isTestRun = Boolean(deps.__test_persistSessionMessage);
        if (!suppressViolations && violEntry) {
          const violations = violEntry.items;
          if (violations.length > 0) {
            pendingViolations.delete(currentSessionID);
            const isTest = Boolean(deps.__test_persistSessionMessage);
            // v0.33.0 session-killer fix: violations are NEVER banner-blocked.
            // - In tests: push to messages so pipeline assertions still work.
            // - In prod: ONLY persist (TUI-visible). The agent sees the violation
            //   on its NEXT turn via chat.system.transform / chat.messages context,
            //   never as a blocking role:"user" message that requires "continua".
            const violationText = `[META-GOVERNOR PROTOCOL VIOLATIONS - YOU MUST COMPLY]\n\n${violations.map((v, i) => `${i + 1}. ${v}`).join("\n")}\n\nRemember: use codegraph/graphify for architecture queries, do not grep without trying codegraph/graphify first, no @ts-ignore/as-any, no empty catch, check memory before asking.`;
            // v0.33.2: superficial — assistant in prod (visible, not blocking), user in tests.
            if (isTest) {
              output.messages.push({
                info: { role: "user", agent: "meta-governor", synthetic: true },
                parts: [{ type: "text", text: violationText, synthetic: true }],
              });
              logToFile("info", `injected ${violations.length} violation(s) to model`, violations);
            } else {
              output.messages.push({
                info: { role: "assistant", agent: "meta-governor", synthetic: true },
                parts: [{ type: "text", text: violationText, synthetic: true }],
              });
              logToFile("info", `violations injected (superficial, assistant role) for ${currentSessionID}: ${violations.length} item(s)`, violations);
            }
            persistIntervention(currentSessionID, violationText);
            // v0.23.1: record injection timestamp for cooldown
            const injectState = auditSessions.get(currentSessionID);
            if (injectState) {
              injectState.lastViolationInjectionAtMs = Date.now();
            }
          }
        }

        // 2. Inject MetaGovernor decision Ã¢â‚¬â€ SCOPED to current session
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
            backgroundTaskInFlight: false,
            backgroundTaskInFlightSinceMs: null,
            backgroundTaskType: null,
            lastWarnAtMs: 0,
            lastWarnHash: "",
            recentPwArgsHashes: [],
            overflowCompactionCount: 0,
            overflowLoopGuardTripped: false,
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
        // FIX session-killer: suppress decision injection while background task in flight — same root cause.
        if (curState.backgroundTaskInFlight || curState.oracleInFlight) {
          logToFile("info", `decision injection suppressed (background task in flight) for ${currentSessionID}`);
          // Re-queue the decision so it fires after the subagent returns, instead of being lost.
          try {
            storeDecision(currentSessionID, decision);
          } catch {
            // best-effort
          }
          return;
        }
        // FIX v0.31.7: WARN decisions are now log-only (non-blocking) in prod. Only escalate/stop require "continua" click.
        // WARN with -0.30 (No progress) was killing delegation loops every turn when user had minActionForMessage=warn.
        // In hermetic tests isTest=true we keep old behavior so persist-retry can assert the pipeline.
        const isTestWarn = Boolean(deps.__test_persistSessionMessage);
        if (decision.action === "warn" && !isTestWarn) {
          logToFile("info", `warn suppressed (non-blocking) for ${currentSessionID}: ${decision.message}`);
          // Keep history for future escalate context but do not push to messages (no banner, no continua).
          const entry = `[${decision.action}] ${decision.message}`;
          const last = curState.recentInterventionTexts?.slice(-1)[0];
          if (last !== entry) {
            curState.recentInterventionTexts = [...(curState.recentInterventionTexts ?? []), entry].slice(-5);
          }
          return;
        }
        curState.interventionCount++;

        // v0.17.2 (Gap D): when includeDecisionHistory is true, prepend
        // recent intervention texts so the model sees its history of decisions.
        // Capped at maxHistoryMessages (default 5).
        const includeHistory =
          mergedConfig.intervention.includeDecisionHistory !== false;
        const maxHistory = mergedConfig.intervention.maxHistoryMessages ?? 5;
        // v0.29.0: dedupe consecutive identical `[action] message` entries so a
        // burst of duplicate warns (suppressed by warn_cooldown above but still
        // landing here when the cooldown expires or the reasoning shifts by 1
        // char) doesn't pollute the LLM context with N copies of the same line.
        const rawHistory = (curState.recentInterventionTexts ?? []).slice(
          -maxHistory,
        );
        const historyTexts: string[] = [];
        for (const t of rawHistory) {
          if (historyTexts.length === 0 || historyTexts[historyTexts.length - 1] !== t) {
            historyTexts.push(t);
          }
        }
        const dedupedMax = Math.max(maxHistory, historyTexts.length);
        let messageText = `[MetaGovernor] ${decision.message}`;
        if (includeHistory && historyTexts.length > 0) {
          const historyBlock = historyTexts
            .map((t, i) => `${i + 1}. ${t}`)
            .join("\n");
          messageText = `[MetaGovernor] Recent decisions in this session:\n${historyBlock}\n\n---\n\nCurrent decision: ${decision.message}`;
        }
        // Track this intervention for future history inclusion. Also dedupe
        // before appending so the rolling window doesn't fill with duplicates.
        const currentEntry = `[${decision.action}] ${decision.message}`;
        const lastEntry = curState.recentInterventionTexts?.slice(-1)[0];
        if (lastEntry !== currentEntry) {
          curState.recentInterventionTexts = [
            ...(curState.recentInterventionTexts ?? []),
            currentEntry,
          ].slice(-dedupedMax);
        }

        const textPart = {
          type: "text",
          text: messageText,
          synthetic: true,
        };

        // v0.33.0 session-killer fix: decisions are NEVER banner-blocked in prod.
        // v0.33.2: superficial — assistant role, visible in history but not blocking user queue.
        // The agent receives guidance via chat.system.transform (persistent);
        // user sees the notification as non-blocking assistant message.
        output.messages.push({
          info: { role: "assistant", agent: "meta-governor", synthetic: true },
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

        // v0.29.0: re-render system injection per-turn using the cached raw
        // protocol text so the oracleVerified gate can drop rule 4 dynamically
        // (Post-task Oracle Verification). The previous eager build produced
        // a static string injected on every turn regardless of session state.
        if (
          mergedConfig.protocolEnforcement.injectIntoSystem &&
          protocolText
        ) {
          const auditStateForSys = transformInput.sessionID
            ? auditSessions.get(transformInput.sessionID)
            : undefined;
          output.system.push(
            "\n### Sisyphus Protocol Enforcement",
            buildSystemInjection(protocolText, {
              oracleVerified: auditStateForSys?.oracleInvoked === true,
              filesChanged: auditStateForSys?.filesChanged ?? 0,
            }),
            "---",
          );
        }

        // v0.37.0 (audit P0-2): mirror enforcement resources into the system
        // prompt. Plugin-CLI mode agents see these rules natively; OpenChamber
        // HTTP mode agents read them via resources/read from mcp-server.ts.
        // The [SYSTEM-NUDGE] prefix (built into each builder) lets the LLM
        // detect the nudge explicitly so it can't claim "I never saw that rule."
        // Gated by mergedConfig.enabled (already checked at top of transform).
        output.system.push(
          "\n### Enforcement Rules (v0.37.0 audit P0-2 mirror)",
          buildOracleRule(),
          "---",
          buildAgentMemoryRule(),
          "---",
          buildSkillPrimingRule(),
          "---",
          buildEnforcementProtocolRule(),
          "---",
        );

        // v0.33.1: inject skill-priming directive via system prompt (banner-free).
        // Fires ONCE per session on the first transform call where the trigger condition is met.
        // The agent sees this on every subsequent turn naturally — no blocking banner, no message queue.
        // The directive is also persisted to the TUI via persistIntervention (visible to user).
        // Handle both orderings: messages.transform may have already cached the directive,
        // or this system.transform may run first — in that case detect and cache here.
        if (transformInput.sessionID) {
          const sid = transformInput.sessionID;
          if (skillPrimingSystemInjected.has(sid)) {
            output.system.push(
              "\n### Skill Priming (MetaGovernor v0.33.1)",
              skillPrimingSystemInjected.get(sid) ?? "",
              "---",
            );
          } else if (
            mergedConfig.skillPriming.enabled &&
            !skillPrimingSent.has(sid) &&
            shouldInjectSkillPriming({
              trigger: mergedConfig.skillPriming.trigger,
              recentToolCalls: auditSessions.get(sid)?.recentToolCalls ?? [],
              implementationToolSeen: implementationToolsSeen.has(sid),
            })
          ) {
            skillPrimingSent.add(sid);
            const primingText = buildSkillPrimingMessage(mergedConfig.skillPriming.router);
            skillPrimingSystemInjected.set(sid, primingText);
            output.system.push(
              "\n### Skill Priming (MetaGovernor v0.33.1)",
              primingText,
              "---",
            );
            logToFile("info", `skill_priming_injected (system) for session ${sid}`);
            persistIntervention(sid, buildSkillPrimingUserStatus(mergedConfig.skillPriming.router));
          }
        }

        // v0.33.1: inject decisions into system prompt for BOTH 'message' and 'system' modes.
        // 'silent' stays log-only (no injection). Banner-free path: agent receives guidance
        // naturally on every turn via system prompt; user sees the notification in TUI via persistIntervention.
        if (
          mergedConfig.intervention.mode !== "silent" &&
          transformInput.sessionID
        ) {
          // v0.35.9: inject graph-priming once per session to nudge agents
          // toward omo_search/omo_find/omo_recall instead of raw grep/glob.
          // Only fires when the session has not yet called any of those.
          const sid = transformInput.sessionID;
          if (
            sid &&
            mergedConfig.skillPriming.enabled &&
            !graphPrimingSent.has(sid) &&
            !omoSearchCalled.has(sid) &&
            !omoRecallCalled.has(sid)
          ) {
            graphPrimingSent.add(sid);
            const graphText = buildGraphPrimingMessage();
            output.system.push(
              "\n### Graph Priming (MetaGovernor v0.35.9)",
              graphText,
              "---",
            );
            logToFile("info", `graph_priming_injected (system) for session ${sid}`);
          }
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

      // v0.13.1: custom tool registration Ã¢â‚¬â€ the LLM can call these explicitly
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
        omo_files: omoFilesTool,
        omo_callers: omoCallersTool,
        omo_node: omoNodeTool,
        // v0.27.0 Wave 3 P2 â€” extended graph tool surface
        omo_context: omoContextTool,
        omo_affected_cg: omoAffectedCgTool,
        omo_status: omoStatusTool,
        omo_unlock: omoUnlockTool,
        omo_mark_dirty: omoMarkDirtyTool,
        omo_sync_if_dirty: omoSyncIfDirtyTool,
        omo_index: omoIndexTool,
        omo_visualize: omoVisualizeTool,
        omo_serve: omoServeTool,
        omo_uninit: omoUninitTool,
        omo_diagnose: omoDiagnoseTool,
        omo_merge_graphs: omoMergeGraphsTool,
        omo_save_result: omoSaveResultTool,
        omo_extract: omoExtractTool,
        omo_cluster_only: omoClusterOnlyTool,
        omo_label: omoLabelTool,
        omo_tree: omoTreeTool,
        omo_clone: omoCloneTool,
        omo_add: omoAddTool,
        omo_check_update: omoCheckUpdateTool,
        omo_hook_status: omoHookStatusTool,
        // v0.28.0: CLI-Anything hub discovery tools
        omo_cli_anything_install: omoCliAnythingInstallTool,
        omo_cli_anything_list: omoCliAnythingListTool,
        omo_cli_anything_search: omoCliAnythingSearchTool,
        omo_cli_anything_info: omoCliAnythingInfoTool,
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

      // v0.13.1 + v0.31.1: disable auto-continue when (a) the plugin has
      // determined the task is complete (DONE+Oracle or intervention cap
      // reached), OR (b) an upstream OpenCode compaction-loop is detected
      // (overflow=true N times in a row). The loop guard is a defense
      // against opencode issue #27924: when a session hits context
      // overflow, opencode unconditionally retries overflow-only
      // compactions forever. The plugin cannot fix opencode, but it CAN
      // trip a circuit breaker: flip autocontinue to disabled, AND push a
      // short guidance message so the model can resume its pending tasks
      // instead of generating more context pressure.
      "experimental.compaction.autocontinue": async (
        autoInput: { sessionID: string; overflow: boolean },
        autoOutput: { enabled: boolean }
): Promise<void> => {
        if (!mergedConfig.enabled) return;

        const sessionID = autoInput.sessionID;
        const overflow = autoInput.overflow;

        // Lazily create a session state so counter persists across
        // repeated autocontinue calls within the same opencode session.
        let sessionState = auditSessions.get(sessionID);
        if (!sessionState) {
          sessionState = {
            memoryToolsUsed: [],
            hasCodegraphDir: false,
            hasGraphifyDir: false,
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
            backgroundTaskInFlight: false,
            backgroundTaskInFlightSinceMs: null,
            backgroundTaskType: null,
            lastWarnAtMs: 0,
            lastWarnHash: "",
            recentPwArgsHashes: [],
            overflowCompactionCount: 0,
            overflowLoopGuardTripped: false,
          };
          auditSessions.set(sessionID, sessionState);
        }

        // (a) Existing terminal-signal gate: DONE/intervention-cap tripped.
        if (sessionState.interventionDisabled) {
          autoOutput.enabled = false;
          return;
        }

        // (b) v0.31.1: Overflow loop guard.
        //
        // Counter logic:
        //   - overflow=true  â†’ counter++
        //   - overflow=false â†’ counter = 0   (reset on a clean compaction)
        // When counter reaches compactionLoopGuard.maxOverflowRecoveries,
        // we trip the guard ONCE for this session:
        //   1. enable the existing intervention-disabled gate so future
        //      autocontinue calls stay disabled for the rest of the session.
        //   2. queue a short guidance message via pendingBotFeedback so
        //      the model sees "resume your pending tasks" the next time
        //      chat.messages.transform fires (TTL = 5 min, set on TtlBoundedMap).
        //
        // If the guard is disabled in config, do nothing â€” opencode keeps
        // full control.
        const guard = mergedConfig.intervention.compactionLoopGuard;
        if (guard.enabled) {
          if (overflow) {
            sessionState.overflowCompactionCount++;
            if (
              !sessionState.overflowLoopGuardTripped &&
              sessionState.overflowCompactionCount > guard.maxOverflowRecoveries
            ) {
              sessionState.overflowLoopGuardTripped = true;
              sessionState.interventionDisabled = true;
              autoOutput.enabled = false;
              logToFile(
                "warn",
                `compaction_loop_guard_tripped for session ${sessionID}: ${sessionState.overflowCompactionCount} consecutive overflow compactions; autocontinue disabled and guidance queued`,
              );
              // v0.31.1: MERGE with any existing PR-reviewer feedback so
              // we never silently overwrite other queued guidance.
              const existing = pendingBotFeedback.get(sessionID);
              const guidanceItem = `[META-GOVERNOR] Overflow compaction loop detected (${sessionState.overflowCompactionCount} consecutive overflow compactions). opencode issue #27924 is in play. Auto-continue is now disabled for this session. Resume your pending tasks using the existing context — do NOT regenerate context you have already produced.`;
              pendingBotFeedback.set(sessionID, {
                items: (existing?.items ?? []).concat(guidanceItem),
              });
            }
          } else {
            // Non-overflow compaction â†’ reset the counter (a clean
            // compaction counts as progress, not part of the loop).
            sessionState.overflowCompactionCount = 0;
          }
        }
      },

    };
  };

  return plugin;
}
// Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬ v0.11.0: helpers Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬

/**
 * Detect whether a shell command is a `git commit` invocation.
 * Used to trigger codegraph reindex on each commit.
 */
export { isGitCommitCommand } from "./graph-sync";

/**
 * Extract bot feedback lines from `gh pr checks` output.
 * Returns an array of human-readable notes like:
 *   "pr-42 Ã‚Â· claude-code-review: CodeRabbit found issues: missing test for X"
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
      feedback.push(`${prIdentifier} Ã‚Â· ${name}: ${details}`);
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

// â”€â”€â”€ v0.25.0: CI monitor helpers â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

/**
 * Detect `git push ...` in a shell command. Handles `&&` chaining and line
 * continuations so commands like `git add . && git commit -m "..." && git push`
 * are still detected. Excludes `git push` to a local file path (rare but
 * possible: `git push <file> <refspec>`).
 */
export function isGitPushCommand(command: string | undefined | null): boolean {
  if (typeof command !== "string" || command.length === 0) return false
  const normalized = command.replace(/\\\n/g, " ").replace(/\s*\n\s*/g, " ")
  // Match `git push` not followed by a slash (would be `git push origin ...`
  // which is fine â€” that's the remote case).
  // Negative lookahead: skip if next non-space chars are `--help`/`-h`
  // (informational only).
  return /(?:^|[\s;&|])git\s+push(?:\s|$)/.test(normalized)
}

/** Get current HEAD SHA (short, 8 chars) for a project dir. */
function getCurrentSha(projectDir: string): string | null {
  try {
    const out = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: projectDir,
      encoding: "utf-8",
      timeout: 5_000,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    })
    return out.toString().trim() || null
  } catch {
    return null
  }
}

/** Get current branch name for a project dir. */
function getCurrentBranch(projectDir: string): string | null {
  try {
    const out = execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
      cwd: projectDir,
      encoding: "utf-8",
      timeout: 5_000,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    })
    const branch = out.toString().trim()
    return branch && branch !== "HEAD" ? branch : null
  } catch {
    return null
  }
}

/**
 * Per-session CI monitor state. Stored on `sessionState` (if mutable) or
 * on a module-level Map keyed by sessionID.
 *
 * Track the SHA we've dispatched CI for so we don't double-trigger on
 * subsequent tool calls within the same session.
 */
const ciMonitorState = new Map<
  string,
  {
    lastPolledSha: string | null
    lastFailureInjectionAtMs: number
    pending: Set<string> // SHAs currently being polled
  }
>()

/**
 * Background CI monitor. Returns immediately; does NOT block the tool call.
 *
 * Flow:
 * 1. Trigger workflow_dispatch for the branch (if CI doesn't auto-run on push)
 * 2. Wait briefly, then poll `gh run list --commit <sha>` until status=completed
 * 3. On failure: persist a session message via persistSessionMessage() so the
 *    next LLM turn sees the failure context with logs attached
 */
async function runCIMonitor(
  sha: string,
  branch: string,
  cfg: { workflow: string; pollIntervalMs: number; maxWaitMs: number; failOnly: boolean },
  sessionID: string,
): Promise<void> {
  const ci = await import("./ci-monitor")
  const state = ciMonitorState.get(sessionID) ?? {
    lastPolledSha: null,
    lastFailureInjectionAtMs: 0,
    pending: new Set<string>(),
  }
  state.pending.add(sha)
  ciMonitorState.set(sessionID, state)

  try {
    // Step 1: try workflow_dispatch (fast-fail if workflow file lacks the
    // workflow_dispatch trigger or if GH_TOKEN has insufficient scopes)
    ci.triggerWorkflow(cfg.workflow, branch)

    // Step 2: poll until complete (with backoff per cfg)
    const startMs = Date.now()
    let run: import("./ci-monitor").CIRunStatus | null = null
    while (Date.now() - startMs < cfg.maxWaitMs) {
      // Try SHA-specific lookup first, fall back to latest
      run = ci.getLatestRunForSha(sha)
      if (!run) {
        // brief delay before retry
        await new Promise((r) => setTimeout(r, cfg.pollIntervalMs))
        continue
      }
      if (run.status === "completed") break
      await new Promise((r) => setTimeout(r, cfg.pollIntervalMs))
    }
    if (!run || run.status !== "completed") {
      // Timed out â€” surface as ambiguous
      logToFile(
        "warn",
        `ci_monitor: timeout waiting for run on ${sha.slice(0, 7)} (${cfg.maxWaitMs}ms)`,
      )
      return
    }

    // Step 3: act on result
    state.lastPolledSha = sha
    if (run.conclusion === "failure") {
      // Throttle: don't inject the same failure twice within 60s
      const now = Date.now()
      if (now - state.lastFailureInjectionAtMs < 60_000) return
      state.lastFailureInjectionAtMs = now

      const logs = ci.getFailedLogs(run.databaseId, 4000)
      const text = [
        `[CI Monitor] GitHub Actions run #${run.databaseId} FAILED on ${branch}@${sha.slice(0, 7)}.`,
        "",
        `Title: ${run.displayTitle}`,
        `URL:   ${run.url}`,
        `Conclusion: ${run.conclusion}`,
        "",
        "â”€â”€ FAILED-STEP LOGS (truncated) â”€â”€",
        logs || "(no failed-log output available â€” run `gh run view " + run.databaseId + " --log-failed` for full output)",
        "",
        "â”€â”€ ACTION â”€â”€",
        cfg.failOnly
          ? "Read the failed logs above, identify which tests broke, run them locally to reproduce, fix, and re-push. Use `bun run typecheck` first (fastest signal), then run only the failing test files."
          : "Review the run and take action.",
      ].join("\n")

      logToFile("warn", `ci_monitor: CI failed for ${sha.slice(0, 7)} â€” ${run.url}`)
      // Use persistSessionMessage so it appears in the LLM context immediately
      // for the next turn (no tool call from the LLM required).
      const sb = await import("./session-bridge")
      const res = await sb.persistSessionMessage(sessionID, text, 10_000)
      if (!res.ok) {
        logToFile(
          "warn",
          `ci_monitor: failed to inject failure message: ${res.error ?? "unknown"}`,
        )
      }
    } else if (run.conclusion === "success") {
      logToFile("info", `ci_monitor: run #${run.databaseId} passed for ${sha.slice(0, 7)}`)
    } else {
      logToFile(
        "info",
        `ci_monitor: run #${run.databaseId} conclusion=${run.conclusion} for ${sha.slice(0, 7)}`,
      )
    }
  } finally {
    state.pending.delete(sha)
    ciMonitorState.set(sessionID, state)
  }
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

// Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬ v0.15.0 completion-signal detectors (module-level exports for testing) Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬

/**
 * v0.10.0 legacy detector. Matches `<promise>DONE</promise>` (with optional
 * trailing `!`) and nothing else. Retained for backwards compatibility Ã¢â‚¬â€
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
 * Strict: only numeric suffixes match (PHASE-1-COMPLETE â†’ 1, PHASE-12-COMPLETE
 * â†’ 12). Non-numeric suffixes (PHASE-A-COMPLETE) and legacy DONE return null.
 */
export function parsePhaseWaveN(text: string): number | null {
  const m = /(?:<promise>\s*)?PHASE-(\d+)-COMPLETE\s*(?:<\/promise>)?/i.exec(
    text,
  );
  return m ? Number.parseInt(m[1]!, 10) : null;
}

/**
 * v0.29.0: fast non-cryptographic 32-bit hash (FNV-1a) for dedupe keys. Used
 * by the post-wave gate to skip re-detection of identical
 * `subagent_type=oracle` text echoed through unrelated tool outputs. Not
 * suitable for security â€” collision resistance is irrelevant here because
 * the gate is best-effort and the wave-cooldown in
 * {@link shouldInjectPostWaveDirective} is the real backstop.
 */
export function simpleHash(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

// â”€â”€â”€ v0.21.0 (post-wave W5): wave-gate decision helpers (module-level exports for testing) â”€â”€â”€

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
  // a NEW wave arriving within the window must never be blocked â€” the agent
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
 * create the PR via standard git/gh workflow. The aasToolPrefix parameter is
 * kept for backward compat — when explicitly non-empty, references the user-
 * provided MCP prefix (e.g. "github"); when empty (default), uses standard
 * git workflow (AAS GitHub skills were retired in v0.32.0).
 * A user-provided override wins verbatim.
 */
export function buildThirdPartyDirective(
  override: string | undefined,
  waveN: number | null | undefined,
  aasToolPrefix = "",
): string {
  if (override) return override;
  const wave = waveN === null || waveN === undefined ? "?" : String(waveN);
  const prStep = aasToolPrefix
    ? `3. Invoke the \`${aasToolPrefix}\` MCP GitHub skills to create the PR/issue, then `
    : "3. ";
  return [
    `Wave ${wave} is Oracle-verified. This is a THIRD-PARTY repo — land it as a contribution:`,
    "1. READ FIRST the repo's contribution rules (read CONTRIBUTING.md, PR/issue templates and guides) and follow them exactly.",
    "2. Create a CLEAN dedicated branch for THIS PR: `git checkout -b <branch>` — each PR gets its own independent branch; never mix PRs on one branch unless they fix the same problem (then commit onto that same branch).",
    `${prStep}push the branch to your FORK (\`git push -u origin HEAD\`) and open the PR against the UPSTREAM repo following the repo's template. Use \`gh pr create\` for GitHub.`,
    "4. Request review on the PR (add reviewers) and wait for CI to pass before starting the next wave.",
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
    // gh unavailable/failed (common with private repos) â€” fall back to git
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
      // no git either â€” assume own repo
    }
    return "own";
  }
}
