import type { Hooks, Plugin, PluginInput, PluginOptions } from "@opencode-ai/plugin"
import { randomUUID as crypto_randomUUID } from "node:crypto"
import type {
  AgentmemoryWriteBackend,
  DecisionHandlerOutput,
  MemoryBackends,
  MetaGovernorInput,
} from "./types"
import {
  runGraphSync,
  trackSession,
  untrackSession,
  isGitCommitCommand,
  triggerReindex,
} from "./graph-sync"
import { runMetaGovernor } from "./orchestrator"
import { getDefaultSqliteBackend } from "./sqlite-backend"
import {
  buildOmoSearchTool,
  buildOmoRecallTool,
  buildOmoHealthTool,
  buildOmoFindTool,
  buildOmoImpactTool,
  buildOmoRememberTool,
  buildOmoRecallMcpTool,
  buildOmoRuleTool,
  buildOmoHistoryTool,
  buildOmoNoteTool,
  buildOmoPathTool,
  buildOmoExplainTool,
  buildOmoOutlineTool,
  buildOmoCheckpointTool,
  buildOmoUndoTool,
} from "./custom-tools"
import { getMCPClient } from "./mcp-client"
import { setSessionClient, promptAgent, hasSessionClient, buildEscalationPrompt } from "./session-bridge"
import { PendingDeliveryRegistry } from "./delivery-registry"
import { setPendingDeliveryRegistry } from "./custom-tools"
import { LOG_PATH, logToFile } from "./file-logger"
import { resolve } from "node:path"
import { homedir } from "node:os"
import { describeLogFile } from "./health"
import { createMetricsCollector } from "./metrics"
import { loadOrchestratorConfig, type MetaGovernorPluginConfig } from "./config"
import { storeDecision, takeDecision } from "./decision-store"
import { GraphRetrieval, getDefaultGraphRetrieval } from "./graph-retrieval"
import { AuditStateCache } from "./audit-state-cache"
import { DEFAULT_VERSION } from "./metrics"
import { statSync, readFileSync } from "node:fs"
import { join } from "node:path"
import {
  loadProtocol,
  buildSystemInjection,
  auditToolCall,
  DEFAULT_PROTOCOL_PATH,
} from "./protocol-enforcer"

/**
 * Dependencies required by the MetaGovernor plugin.
 * All are optional - features degrade gracefully when backends are unavailable.
 */
export interface MetaGovernorPluginDeps {
  backends?: MemoryBackends
  writeBackend?: AgentmemoryWriteBackend
  providerID?: () => string | undefined
  modelID?: () => string | undefined
  // v0.11.0: test-only hooks for hermetic assertions. NOT part of the
  // public contract; used by integration tests to verify the plugin
  // triggered an event without depending on filesystem state.
  __test_onCommitTrigger?: (payload: {
    projectDir: string
    command: string
    sessionID: string
  }) => void
}

// - Helpers

const ACTION_SEVERITY: Record<DecisionHandlerOutput["action"], number> = {
  continue: 0,
  warn: 1,
  escalate: 2,
  stop: 3,
}

function meetsMinAction(
  action: DecisionHandlerOutput["action"],
  minAction: "warn" | "escalate" | "stop",
): boolean {
  return ACTION_SEVERITY[action] >= ACTION_SEVERITY[minAction]
}

function generateID(): string {
  return `mg-${crypto_randomUUID()}`
}

/**
 * Extract a search query from tool args. For `grep`, the query is the
 * `pattern` field. For `glob`, the query is the `pattern` field. Returns
 * null if no usable query can be extracted.
 */
function extractQueryFromArgs(toolInput: { tool: string; args?: unknown }): string | null {
  const args = (toolInput as { args?: Record<string, unknown> }).args
  if (!args || typeof args !== "object") return null
  // Common arg names for grep/glob across OpenCode versions
  const candidates = ["pattern", "query", "path", "glob", "regex", "include_pattern"]
  for (const key of candidates) {
    const v = (args as Record<string, unknown>)[key]
    if (typeof v === "string" && v.trim().length > 0) return v.trim()
  }
  return null
}

// Module-level metrics collector — shared across all invocations of the plugin
const metricsCollector = createMetricsCollector({ sessionID: "__global__", global: true, version: DEFAULT_VERSION })
const healthFilePath = resolve(homedir(), ".config", "opencode", "meta-governor-health.json")

// - Plugin factory

export function createMetaGovernorPlugin(
  config: MetaGovernorPluginConfig = {},
  deps: MetaGovernorPluginDeps = {},
): Plugin {
  // v0.13.0: lazy graph-dir detection via the graph-retrieval layer.
  // This fixes the race condition where static booleans were set at load
  // time before async runGraphSync() could create the directories.
  // The booleans below remain for backwards-compat with AuditContext.
  const graphRetrieval = getDefaultGraphRetrieval()
  // v0.17.0 (F3.6): track bridge tool dispatches and verify delivery.
  const deliveryRegistry = new PendingDeliveryRegistry()
  // Inject the registry into the custom-tools module so bridge tools
  // can register pending dispatches + poll for delivery.
  setPendingDeliveryRegistry(deliveryRegistry as unknown as Parameters<typeof setPendingDeliveryRegistry>[0])
  const cwd = process.cwd()

  // v0.13.1: initialize custom tools for the LLM to call.
  const sqlite = getDefaultSqliteBackend()
  const omoSearchTool = buildOmoSearchTool({ graphRetrieval, cwd })
  const omoRecallTool = buildOmoRecallTool({ sqlite })
  const omoHealthTool = buildOmoHealthTool({
    metrics: metricsCollector,
    logFilePath: LOG_PATH,
    healthFilePath: healthFilePath,
  })
  // v0.14.0: extended tools (CodeGraph sub-commands)
  const omoFindTool = buildOmoFindTool({ cwd })
  const omoImpactTool = buildOmoImpactTool({ cwd })
  // v0.14.0: Opción A pivot — tools that bridge to MCP servers via session.prompt()
  const omoRememberTool = buildOmoRememberTool({
  onDispatch: ({ sessionID, mcpTool, mcpArgs }) => {
    deliveryRegistry.register({ sessionID, mcpTool, mcpArgs })
  },
})
  const omoRecallMcpTool = buildOmoRecallMcpTool({
  onDispatch: ({ sessionID, mcpTool, mcpArgs }) => {
    deliveryRegistry.register({ sessionID, mcpTool, mcpArgs })
  },
})
  const omoRuleTool = buildOmoRuleTool({
  onDispatch: ({ sessionID, mcpTool, mcpArgs }) => {
    deliveryRegistry.register({ sessionID, mcpTool, mcpArgs })
  },
})
  const omoHistoryTool = buildOmoHistoryTool({
  onDispatch: ({ sessionID, mcpTool, mcpArgs }) => {
    deliveryRegistry.register({ sessionID, mcpTool, mcpArgs })
  },
})
  const omoNoteTool = buildOmoNoteTool({
  onDispatch: ({ sessionID, mcpTool, mcpArgs }) => {
    deliveryRegistry.register({ sessionID, mcpTool, mcpArgs })
  },
})
  const omoPathTool = buildOmoPathTool({ cwd })
  const omoExplainTool = buildOmoExplainTool({ cwd })
  const omoOutlineTool = buildOmoOutlineTool({ cwd })
  const omoCheckpointTool = buildOmoCheckpointTool({})
  const omoUndoTool = buildOmoUndoTool({})


  // Initialise graphSync when the module loads
  const graphSyncEnabled = config.graphSync?.enabled !== false
  if (graphSyncEnabled) {
    runGraphSync({
      enabled: true,
      watch: config.graphSync?.watch ?? false,
      autoInstall: config.graphSync?.autoInstall ?? true,
      installTimeoutMs: config.graphSync?.installTimeoutMs ?? 60_000,
      projectDir: cwd,
    }).catch(() => {})
    trackSession(cwd)
  }

  // Log startup so the user can see the plugin is loaded
  logToFile("info", "MetaGovernor plugin loaded", {
    version: DEFAULT_VERSION,
    cwd,
    projectHasCodegraph: graphRetrieval.hasCodegraphDir(cwd),
    projectHasGraphify: graphRetrieval.hasGraphifyDir(cwd),
  })

  const plugin: Plugin = async (
    _input: PluginInput,
    options?: PluginOptions,
  ): Promise<Hooks> => {
    // v0.14.0: capture OpenCode server client for MCP tool access (AgentMemory,
    // Magic Context, AFT). Hydrates the MCPClient singleton on first plugin
    // invocation. Safe to call multiple times — setClient is idempotent.
    // v0.16.0: F3.4 — runtime guard instead of "as never". The cast
    // hid incompatibilities between OpenCode plugin API versions; the
    // guard makes failures visible (we skip hydration) instead of
    // silently feeding the wrong shape to setClient.
    const clientCandidate = _input.client
    const safeClient =
      clientCandidate != null &&
      typeof clientCandidate === "object" &&
      "tool" in clientCandidate
        ? clientCandidate
        : null
    getMCPClient().setClient(safeClient as never) // safeClient narrowed to null | valid-shape
    setSessionClient(safeClient as never)

    // 1. Load config from plugin options
    const rawConfig = {
      ...config,
      ...((options?.meta_governor as MetaGovernorPluginConfig) ?? {}),
    }
    const mergedConfig = loadOrchestratorConfig(rawConfig)

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
          omo_rule: omoRuleTool,
          omo_history: omoHistoryTool,
          omo_note: omoNoteTool,
          omo_path: omoPathTool,
          omo_explain: omoExplainTool,
          omo_outline: omoOutlineTool,
          omo_checkpoint: omoCheckpointTool,
          omo_undo: omoUndoTool,
        },
      }
    }

    // 3. Resolve model settings from override or session
    const getProviderID = (): string | undefined =>
      mergedConfig.modelOverride?.providerID ?? deps.providerID?.()
    const getModelID = (): string | undefined =>
      mergedConfig.modelOverride?.modelID ?? deps.modelID?.()
    const getModelLimit = (): number =>
      mergedConfig.modelOverride?.modelLimit ?? 200_000

    const providerID = getProviderID() ?? "unknown"
    const modelID = getModelID() ?? "unknown"

    // 4. Load protocol text (best-effort, cached once)
    let systemInjection: string | undefined
    // v0.16.0: eagerly await protocol load + gate on a readiness flag.
    // Previously the load was fire-and-forget, so system.transform could
    // fire before systemInjection was set, silently skipping injection.
    if (mergedConfig.protocolEnforcement.enabled || mergedConfig.protocolEnforcement.injectIntoSystem) {
      const protocolPath = mergedConfig.protocolEnforcement.path ?? DEFAULT_PROTOCOL_PATH
      try {
        const text = await loadProtocol(protocolPath)
        systemInjection = buildSystemInjection(text)
      } catch (err: unknown) {
        if (typeof console !== "undefined" && mergedConfig.modelOverride?.verbosity !== "silent") {
          console.warn("[meta-governor] could not load protocol:", err instanceof Error ? err.message : err)
        }
      }
    }

    // 5. Per-session audit state (v0.10.0: adds DONE tracking + intervention cap)
    type AuditState = {
      memoryToolsUsed: string[]
      hasCodegraphDir: boolean
      hasGraphifyDir: boolean
      oracleInvoked: boolean
      filesChanged: number
      emptyRecall: boolean
      escalationAttempted: boolean
      aftAvailable: boolean
      aftUsed: boolean
      recentToolCalls: string[]
      recentWriteContents: string[]
      memorySaved: boolean
      batchCompletions: number
      /** v0.10.0: kept for legacy readers. Set by `<promise>DONE</promise>`
       *  (with optional `!`). In v0.15.0 phase-aware mode this is NOT used
       *  by the gate; see `phaseCompleteSignal` and `planCompleteSignal`. */
      taskDoneSignal: boolean
      /** v0.15.0: set by `<promise>DONE</promise>` OR
       *  `<promise>PHASE-N-COMPLETE</promise>`. Per-phase hint only;
       *  only latches intervention in legacy (phaseAwareDoneSignal=false) mode. */
      phaseCompleteSignal: boolean
      /** v0.15.0: set by `<promise>PLAN-COMPLETE</promise>`. Terminal signal;
       *  always latches intervention (when Oracle has verified). */
      planCompleteSignal: boolean
      interventionCount: number
      interventionDisabled: boolean
      /** v0.17.0 (F5.4): count of lessons saved this session. Used to enforce maxLessonsPerSession. */
      lessonCount: number
    }
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
    })

    // Pending protocol violations queue
// Pending protocol violations queue
    // v0.16.0: TTL-wrapped queue (F1.3). Items expire after 5 minutes
    // to prevent memory growth if a session ends without consuming its queue.
    const pendingViolations = new Map<string, { items: string[]; expiresAtMs: number }>()
    const PENDING_TTL_MS = 5 * 60 * 1000

    // v0.11.0: pending bot feedback (from `gh pr checks` / `gh pr view` output)
    const pendingBotFeedback = new Map<string, { items: string[]; expiresAtMs: number }>()

    // v0.11.0: whether the plan reminder has been injected for this session
    const planReminderSent = new Set<string>()
    // v0.10.0 / legacy detection imported below; closure removed in v0.15.0
    // in favor of the module-level detectors (detectDoneSignal,
    // detectPhaseCompleteSignal, detectPlanCompleteSignal). See the bottom
    // of this file for the export block.

    return {
      // - Tool execute before (protocol audit)
      "tool.execute.before": async (
        toolInput: { tool: string; sessionID: string; callID: string },
      ): Promise<void> => {
        if (!mergedConfig.enabled) return
        if (!mergedConfig.protocolEnforcement.auditToolCalls) return
        if (!toolInput.sessionID) return

        let state = auditSessions.get(toolInput.sessionID)
        if (!state) {
          state = {
            memoryToolsUsed: [],
            hasCodegraphDir: graphRetrieval.hasCodegraphDir(cwd),
            hasGraphifyDir: graphRetrieval.hasGraphifyDir(cwd),
            oracleInvoked: false,
            filesChanged: 0,
            emptyRecall: false,
            escalationAttempted: false,
            aftAvailable: false,
            aftUsed: false,
            recentToolCalls: [],
            recentWriteContents: [],
            memorySaved: false,
            batchCompletions: 0,
            taskDoneSignal: false,
            phaseCompleteSignal: false,
            planCompleteSignal: false,
            interventionCount: 0,
            interventionDisabled: false,
            lessonCount: 0,
          }
          auditSessions.set(toolInput.sessionID, state)
        }

        if (systemInjection) {
          console.log("[meta-governor] protocol loaded, system injection ready")
        }

        const violations = auditToolCall(toolInput.tool, {}, {
          memoryToolsUsed: state.memoryToolsUsed,
          hasCodegraphDir: state.hasCodegraphDir,
          hasGraphifyDir: state.hasGraphifyDir,
          oracleInvoked: state.oracleInvoked,
          filesChanged: state.filesChanged,
          emptyRecall: state.emptyRecall,
          escalationAttempted: state.escalationAttempted,
          aftAvailable: state.aftAvailable,
          aftUsed: state.aftUsed,
          recentToolCalls: state.recentToolCalls,
          recentWriteContents: state.recentWriteContents,
          memorySaved: state.memorySaved,
          batchCompletions: state.batchCompletions,
        })

        if (violations.length > 0) {
          logToFile("warn", `protocol violations on tool ${toolInput.tool}`, violations)
          const existing = pendingViolations.get(toolInput.sessionID)?.items ?? []
          for (const v of violations) {
            existing.push(`[${v.severity.toUpperCase()}] ${v.rule}: ${v.detail}`)
          }
          pendingViolations.set(toolInput.sessionID, {
            items: existing,
            expiresAtMs: Date.now() + PENDING_TTL_MS,
          })
        } else {
          logToFile("info", `audit OK on tool ${toolInput.tool}`)
        }

        // v0.13.0: actually invoke codegraph/graphify when the agent is about
        // to do a search. This is the C2 fix — previously the plugin only
        // told the agent to use graph tools via prompt text. Now it runs them
        // and caches the result for system.transform to inject.
        if (
          (toolInput.tool === "grep" || toolInput.tool === "glob") &&
          (graphRetrieval.hasCodegraphDir(cwd) || graphRetrieval.hasGraphifyDir(cwd))
        ) {
          const query = extractQueryFromArgs(toolInput)
          if (query) {
            // Fire-and-forget: never block tool.execute.before
            graphRetrieval
              .invoke(cwd, query, { timeoutMs: 5_000 })
              .then((result) => {
                if (result.result) {
                  graphRetrieval.cacheContext(toolInput.sessionID, query, result.result)
                }
              })
              .catch(() => {
                // Best-effort: silently swallow errors
              })
          }
        }
      },

      // - Tool execute after (orchestrator + audit state update)
      "tool.execute.after": async (
        toolInput: { tool: string; sessionID: string; callID: string; args: unknown },
        toolOutput: { title: string; output: string; metadata: unknown },
      ): Promise<void> => {
        if (!mergedConfig.enabled) return

        // v0.17.0 (F3.6): when the LLM calls an MCP tool that was previously
        // dispatched via session-bridge, mark the pending delivery as
        // verified. This lets bridge tools report actual delivery status.
        try {
          deliveryRegistry.markDelivered({
            sessionID: toolInput.sessionID,
            mcpTool: toolInput.tool,
            mcpArgs: toolInput.args,
          })
        } catch {
          // best-effort
        }

        const sessionState = auditSessions.get(toolInput.sessionID)
        if (sessionState) {
          sessionState.recentToolCalls = [toolInput.tool].concat(
            sessionState.recentToolCalls,
          ).slice(0, 20)

          const writeTools = [
            "write", "edit", "edit_block",
            "desktop-commander_write_file", "desktop-commander_edit_block",
          ]
          if (writeTools.includes(toolInput.tool)) {
            sessionState.filesChanged++
            const content = (toolOutput.output ?? "").slice(0, 500)
            sessionState.recentWriteContents = [content].concat(
              sessionState.recentWriteContents,
            ).slice(0, 3)
          }

          const memoryTools = [
            "agentmemory_memory_recall", "agentmemory_memory_smart_search",
            "agentmemory_memory_save", "ctx_memory", "ctx_search", "ctx_note",
          ]
          const isMemoryTool = memoryTools.some((m: string) => toolInput.tool.startsWith(m))
          if (isMemoryTool && !sessionState.memoryToolsUsed.includes(toolInput.tool)) {
            sessionState.memoryToolsUsed.push(toolInput.tool)
          }

          if (toolInput.tool.startsWith("ctx_memory")) {
            const out = toolOutput.output ?? ""
            if (out.includes("saved") || out.includes("written")) {
              sessionState.memorySaved = true
            }
          }

          if (toolInput.tool.startsWith("aft_zoom") || toolInput.tool.startsWith("aft_outline")) {
            sessionState.aftUsed = true
          }

          if (toolInput.tool === "task" && (toolOutput.output ?? "").includes("subagent_type=oracle")) {
            sessionState.oracleInvoked = true
          }

          const outLower = (toolOutput.output ?? "").toLowerCase()
          if (toolInput.tool.includes("recall") && (outLower.includes("returned empty") || outLower.includes("no results"))) {
            sessionState.emptyRecall = true
          }

          if (toolInput.tool === "todowrite" && (toolOutput.output ?? "").includes("completed")) {
            const matches = (toolOutput.output ?? "").match(/"status":"completed"/g) ?? []
            if (matches.length >= 3) {
              sessionState.batchCompletions++
            }
          }

          // v0.15.0: split per-phase hint (DONE / PHASE-N-COMPLETE) from
          // terminal (PLAN-COMPLETE). Each signal has its own latch; the
          // gate (further below) decides which one disables intervention.
          const textToScan = [
            typeof toolOutput.output === "string" ? toolOutput.output : "",
            typeof toolInput.args === "string" ? toolInput.args : "",
          ].join("\n")

          if (!sessionState.taskDoneSignal && detectDoneSignal(textToScan)) {
            sessionState.taskDoneSignal = true
            logToFile(
              "info",
              `task_done_signal detected (legacy) for session ${toolInput.sessionID}`,
            )
          }
          if (!sessionState.phaseCompleteSignal && detectPhaseCompleteSignal(textToScan)) {
            sessionState.phaseCompleteSignal = true
            logToFile(
              "info",
              `phase_complete_signal detected for session ${toolInput.sessionID}`,
            )
          }
          if (!sessionState.planCompleteSignal && detectPlanCompleteSignal(textToScan)) {
            sessionState.planCompleteSignal = true
            logToFile(
              "info",
              `plan_complete_signal detected for session ${toolInput.sessionID}`,
            )
          }
        }

        // v0.10.0: hard break — if intervention already disabled, skip orchestrator
        if (sessionState?.interventionDisabled) {
          return
        }

        const orchestratorInput: MetaGovernorInput = {
          sessionID: toolInput.sessionID,
          toolName: toolInput.tool,
          toolOutput: toolOutput.output,
          iteration: 0,
          maxIterations: 10,
          oracleVerified: sessionState?.oracleInvoked ?? false,
          noProgress: false,
          filesChanged: sessionState?.filesChanged ?? 0,
          recentTurnTokens: [],
          deviations: [],
          // v0.13.0: default backends are real SQLite (was: no-op stubs).
          // The user can still override via `deps.backends` / `deps.writeBackend`.
          // If SQLite init fails (non-Bun runtime, no permissions, etc.) we
          // degrade silently to a no-op so the plugin still loads.
          ...((): Pick<MetaGovernorInput, "backends" | "writeBackend"> => {
            const userBackends = deps.backends
            const userWrite = deps.writeBackend
            if (userBackends && userWrite) {
              return { backends: userBackends, writeBackend: userWrite }
            }
            try {
              const sqlite = getDefaultSqliteBackend()
              return {
                backends: userBackends ?? {
                  agentmemory: sqlite,
                  magicContext: { slotList: async () => [] },
                  boulderState: sqlite,
                },
                writeBackend: userWrite ?? sqlite,
              }
            } catch {
              // SQLite init failed (no Bun, no permissions, etc.) — degrade silently
              return {
                backends: userBackends ?? {
                  agentmemory: { smartSearch: async () => ({ lessons: [], crystals: [] }) },
                  magicContext: { slotList: async () => [] },
                  boulderState: { boulderRead: async () => [] },
                },
                writeBackend: userWrite ?? {
                  saveMemory: async () => ({ id: "" }),
                  saveLesson: async () => ({ id: "" }),
                },
              }
            }
          })(),
          config: mergedConfig,
          ...(getProviderID() ? { providerID: getProviderID() } : {}),
          ...(getModelID() ? { modelID: getModelID() } : {}),
          modelLimit: getModelLimit(),
          // v0.17.0 (F5.4): thread current lesson count for maxLessonsPerSession cap
          currentLessonCount: sessionState?.lessonCount ?? 0,
        }

        try {
          const output = await runMetaGovernor(orchestratorInput)

          // v0.17.0 (F5.4): increment lesson count when a lesson was actually saved
          if (output.lessonSaved?.lessonSaved && sessionState) {
            sessionState.lessonCount++
          }

          // v0.17.0 (F5.1): wire escalate action to fire a session.prompt
          // that instructs the LLM to invoke Oracle (or user). Pure prompt
          // builder is testable; the actual session.prompt is best-effort.
          if (
            output.decision.action === "escalate" &&
            toolInput.sessionID &&
            hasSessionClient()
          ) {
            const decisionRef = output.decision.historyEntry.decision
            const evidenceCount = decisionRef.evidence.length
            const target = decisionRef.shouldEscalateTo ?? "oracle"
            const instruction = buildEscalationPrompt({
              reasoning: decisionRef.reasoning,
              target,
              evidenceCount,
              sessionID: toolInput.sessionID,
            })
            void promptAgent(toolInput.sessionID, {
              toolName: "meta_governor_escalate",
              mcpTool: "task",
              mcpArgs: { subagent_type: target },
              preamble: instruction,
            }).catch((err) => {
              logToFile("warn", `escalation prompt failed: ${String(err)}`)
            })
          }

          if (mergedConfig.intervention.mode !== "silent" && sessionState) {
            const decision = output.decision

            // v0.15.0: terminal-signal gate. Latches intervention when:
            //   respectDoneSignal is true (master switch from v0.10.0), AND
            //   Oracle has verified, AND either:
            //     a) <promise>PLAN-COMPLETE</promise> was emitted (always terminal), or
            //     b) phaseAwareDoneSignal is false (legacy) and a phase
            //        completion signal was emitted (DONE / PHASE-N-COMPLETE).
            const phaseAwareDone =
              mergedConfig.intervention.phaseAwareDoneSignal === true
            if (
              mergedConfig.intervention.respectDoneSignal &&
              sessionState.oracleInvoked &&
              (sessionState.planCompleteSignal ||
                (!phaseAwareDone &&
                  (sessionState.taskDoneSignal ||
                    sessionState.phaseCompleteSignal)))
            ) {
              sessionState.interventionDisabled = true
              const cause = sessionState.planCompleteSignal
                ? "PLAN-COMPLETE"
                : (sessionState.taskDoneSignal ? "DONE" : "PHASE-N-COMPLETE")
              logToFile(
                "info",
                `task verified (${cause} + Oracle): disabling intervention for session ${toolInput.sessionID}`,
              )
              takeDecision(toolInput.sessionID)
              return
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
              )
              if (cap > 0 && sessionState.interventionCount >= cap) {
                sessionState.interventionDisabled = true
                logToFile(
                  "warn",
                  `intervention cap (${cap}) reached for session ${toolInput.sessionID}; disabling further intervention`,
                )
                takeDecision(toolInput.sessionID)
                return
              }
              sessionState.interventionCount++
              storeDecision(toolInput.sessionID, decision)
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
            const args = toolInput.args as { command?: string } | undefined
            const cmd = args?.command
            if (isGitCommitCommand(cmd)) {
              logToFile(
                "info",
                "git_commit_reindex_triggered",
                { sessionID: toolInput.sessionID, command: cmd },
              )
              // v0.11.0: test-only hook so hermetic tests can assert
              // the trigger fired without depending on log file paths.
              deps.__test_onCommitTrigger?.({
                projectDir: cwd,
                command: cmd ?? "",
                sessionID: toolInput.sessionID,
              })
// Fire and forget — don't block the tool call.
// v0.16.0: triggerReindex (was triggerCodegraphSync) — reindexes both
// codegraph and graphify, not just codegraph.
void triggerReindex(cwd).catch((err) => {
  logToFile("warn", `codegraph sync failed: ${String(err)}`)
})
}
}
} catch {
// reindex is best-effort, never break a tool call
        }

        // v0.11.0: detect `gh pr ...` output and queue bot feedback
        try {
          if (toolInput.tool === "bash") {
            const args = toolInput.args as { command?: string } | undefined
            const cmd = args?.command
            if (isGhPrCommand(cmd)) {
              const feedback = extractBotFeedbackFromGhOutput(
                toolOutput.output,
                toolInput.sessionID,
              )
              if (feedback.length > 0) {
                const existing = pendingBotFeedback.get(toolInput.sessionID)?.items ?? []
                pendingBotFeedback.set(
                  toolInput.sessionID,
                  {
                    items: existing.concat(feedback),
                    expiresAtMs: Date.now() + PENDING_TTL_MS,
                  },
                )
                logToFile(
                  "info",
                  `captured ${feedback.length} bot feedback line(s) for session ${toolInput.sessionID}`,
                )
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
        if (!mergedConfig.enabled) return
        if (mergedConfig.intervention.mode !== "message") return

        // v0.10.0: derive current sessionID from the LAST message.
        // MUST scope decisions to the current session; never takeAnyDecision().
        // If we cannot derive a sessionID, the safe default is no injection.
        const lastMsg = output.messages[output.messages.length - 1] as
          | { info?: { sessionID?: string } }
          | undefined
        const currentSessionID = lastMsg?.info?.sessionID
        if (!currentSessionID) {
          return
        }

        // v0.10.0: respect per-session intervention disable
        const state = auditSessions.get(currentSessionID)
        if (state?.interventionDisabled) {
          takeDecision(currentSessionID)
          return
        }

        // 0. Plan reminder (v0.11.0) — nudge the agent to make a plan
        //    before code changes, but only once per session.
        if (
          state &&
          !planReminderSent.has(currentSessionID) &&
          shouldInjectPlanReminder(cwd, state.interventionCount)
        ) {
          planReminderSent.add(currentSessionID)
          const planText = `[MetaGovernor] Before any code change, create PLAN.md or a \`## Plan\` section in AGENTS.md that enumerates the phases. After each phase, commit (local + fork + upstream). Each commit triggers automatic reindex via the graphify post-commit hook + \`codegraph sync\`.`
          output.messages.push({
            info: { role: "user", agent: "meta-governor", synthetic: true },
            parts: [{ type: "text", text: planText, synthetic: true }],
          })
          logToFile("info", `plan_reminder_injected for session ${currentSessionID}`)
        }

        // 0b. Bot feedback from PR reviewers (v0.11.0)
        const botEntry = pendingBotFeedback.get(currentSessionID)
        if (botEntry && botEntry.expiresAtMs > Date.now()) {
          const feedback = botEntry.items
          if (feedback.length > 0) {
            const feedbackText = `[MetaGovernor PR Reviewer Feedback]\n\n${feedback.map((f, i) => `${i + 1}. ${f}`).join("\n")}\n\nApply these fixes to keep the PR mergeable.`
            output.messages.push({
              info: { role: "user", agent: "meta-governor", synthetic: true },
              parts: [{ type: "text", text: feedbackText, synthetic: true }],
            })
            pendingBotFeedback.delete(currentSessionID)
            logToFile(
              "info",
              `injected ${feedback.length} bot feedback line(s) to model for session ${currentSessionID}`,
            )
          }
        }
        // 1. Inject pending protocol violations so the model sees them
        const violEntry = pendingViolations.get(currentSessionID)
        if (violEntry && violEntry.expiresAtMs > Date.now()) {
          const violations = violEntry.items
          if (violations.length > 0) {
            const violationText = `[META-GOVERNOR PROTOCOL VIOLATIONS - YOU MUST COMPLY]\n\n${violations.map((v, i) => `${i + 1}. ${v}`).join("\n")}\n\nRemember: use codegraph/graphify for architecture queries, do not grep without trying AFT/codegraph first, no @ts-ignore/as-any, no empty catch, check memory before asking.`
            output.messages.push({
              info: { role: "user", agent: "meta-governor", synthetic: true },
              parts: [{ type: "text", text: violationText, synthetic: true }],
            })
            pendingViolations.delete(currentSessionID)
            logToFile("info", `injected ${violations.length} violation(s) to model`)
          }
        }

        // 2. Inject MetaGovernor decision — SCOPED to current session
        const decision = takeDecision(currentSessionID)
        if (!decision) return
        if (decision.action === "continue") return
        if (!decision.message) return
        if (!meetsMinAction(decision.action, mergedConfig.intervention.minActionForMessage)) return

        // v0.10.0: defense-in-depth cap check before push.
        // State may not exist yet (no tool.execute.before ran); lazily create it.
        let curState = state ?? auditSessions.get(currentSessionID)
        if (!curState) {
          curState = {
            memoryToolsUsed: [],
            hasCodegraphDir: graphRetrieval.hasCodegraphDir(cwd),
            hasGraphifyDir: graphRetrieval.hasGraphifyDir(cwd),
            oracleInvoked: false,
            filesChanged: 0,
            emptyRecall: false,
            escalationAttempted: false,
            aftAvailable: false,
            aftUsed: false,
            recentToolCalls: [],
            recentWriteContents: [],
            memorySaved: false,
            batchCompletions: 0,
            taskDoneSignal: false,
            phaseCompleteSignal: false,
            planCompleteSignal: false,
            interventionCount: 0,
            interventionDisabled: false,
            lessonCount: 0,
          }
          auditSessions.set(currentSessionID, curState)
        }
        const cap = Math.max(
          0,
          mergedConfig.intervention.maxInterventionsPerSession ?? 0,
        )
        if (cap > 0 && curState.interventionCount >= cap) {
          curState.interventionDisabled = true
          return
        }
        curState.interventionCount++

        const textPart = {
          type: "text",
          text: `[MetaGovernor] ${decision.message}`,
          synthetic: true,
        }

        output.messages.push({
          info: { role: "user", agent: "meta-governor" },
          parts: [textPart],
        })
      },

      // - System transform (protocol injection + system intervention mode)
      "experimental.chat.system.transform": async (
        transformInput: { sessionID?: string; model: unknown },
        output: { system: string[] },
      ): Promise<void> => {
        if (!mergedConfig.enabled) return

        if (mergedConfig.protocolEnforcement.injectIntoSystem && systemInjection) {
          output.system.push(
            "\n### Sisyphus Protocol Enforcement",
            systemInjection,
            "---",
          )
        }

        // v0.13.0: inject cached graph context (C2 fix). When tool.execute.before
        // fired a graph query earlier, the result is now in the per-session cache
        // and we append it to the system prompt as reference material.
        if (transformInput.sessionID) {
          const graphContext = graphRetrieval.getCachedContext(transformInput.sessionID)
          if (graphContext) {
            output.system.push(
              "\n### Graph Context (auto-retrieved)",
              graphContext,
              "---",
            )
          }
        }

        if (mergedConfig.intervention.mode === "system" && transformInput.sessionID) {
          // v0.10.0: also respect per-session intervention disable here
          const state = auditSessions.get(transformInput.sessionID)
          if (state?.interventionDisabled) {
            takeDecision(transformInput.sessionID)
            return
          }
          const decision = takeDecision(transformInput.sessionID)
          if (decision && decision.action !== "continue" && decision.message) {
            if (meetsMinAction(decision.action, mergedConfig.intervention.minActionForMessage)) {
              if (state) {
                const cap = Math.max(
                  0,
                  mergedConfig.intervention.maxInterventionsPerSession ?? 0,
                )
                if (cap > 0 && state.interventionCount >= cap) {
                  state.interventionDisabled = true
                  return
                }
                state.interventionCount++
              }
              output.system.push(
                "\n[MetaGovernor Intervention]",
                decision.message,
                "---",
              )
            }
          }
        }
      },

      // v0.13.1: custom tool registration — the LLM can call these explicitly
      tool: {
        omo_search: omoSearchTool,
        omo_recall: omoRecallTool,
        omo_health: omoHealthTool,
        omo_find: omoFindTool,
        omo_impact: omoImpactTool,
        omo_remember: omoRememberTool,
        omo_recall_mcp: omoRecallMcpTool,
        omo_rule: omoRuleTool,
        omo_history: omoHistoryTool,
        omo_note: omoNoteTool,
        omo_path: omoPathTool,
        omo_explain: omoExplainTool,
        omo_outline: omoOutlineTool,
        omo_checkpoint: omoCheckpointTool,
        omo_undo: omoUndoTool,
      },

      // v0.13.1: inject lesson context at compaction time so learned patterns
      // survive context window compaction.
      "experimental.session.compacting": async (
        compactInput: { sessionID: string },
        compactOutput: { context: string[]; prompt?: string },
      ): Promise<void> => {
        if (!mergedConfig.enabled || !mergedConfig.closedLoop.enabled) return
        // Fetch top-3 relevant lessons and inject into compaction context
        const sqlite = getDefaultSqliteBackend()
        const recentQuery = `session:${compactInput.sessionID}`
        const results = await sqlite.smartSearch({ query: recentQuery, limit: 3 })
        if (results.lessons.length > 0) {
          const lessonText = results.lessons
            .map(
              (l, i) =>
                `${i + 1}. [${l.id}] confidence=${l.confidence.toFixed(2)}\n   ${l.content.slice(0, 300)}`,
            )
            .join("\n\n")
          compactOutput.context.push(
            "\n### Past Lessons (auto-retrieved)",
            lessonText,
            "---",
          )
        }
      },

      // v0.13.1: disable auto-continue when the plugin has determined the
      // task is complete (DONE+Oracle or intervention cap reached).
      "experimental.compaction.autocontinue": async (
        _autoInput: { sessionID: string; overflow: boolean },
        autoOutput: { enabled: boolean },
      ): Promise<void> => {
        if (!mergedConfig.enabled) return
        const state = auditSessions.get(_autoInput.sessionID)
        if (state?.interventionDisabled) {
          autoOutput.enabled = false
        }
      },
    }
  }

  return plugin
}
// ─── v0.11.0: helpers ────────────────────────────────────────────

/**
 * Detect whether a shell command is a `git commit` invocation.
 * Used to trigger codegraph reindex on each commit.
 */
export { isGitCommitCommand } from "./graph-sync"

/**
 * Extract bot feedback lines from `gh pr checks` output.
 * Returns an array of human-readable notes like:
 *   "pr-42 · claude-code-review: CodeRabbit found issues: missing test for X"
 * Only "fail" status is reported; "pass" and "pending" are ignored.
 */
export function extractBotFeedbackFromGhOutput(
  output: string,
  prIdentifier: string,
): string[] {
  if (typeof output !== "string" || output.length === 0) return []
  const lines = output.split("\n")
  const feedback: string[] = []
  for (const line of lines) {
    // gh pr checks output: "<check-name>    <status>    <details>"
    // Status values: pass, fail, pending, skipping, cancelled
    const match = line.match(/^\s*(\S+)\s+(fail)\s+(.*)$/)
    if (match) {
      const name = match[1]!.trim()
      const details = match[3]!.trim()
      feedback.push(`${prIdentifier} · ${name}: ${details}`)
    }
  }
  return feedback
}

/**
 * Detect whether a shell command is a `gh pr ...` invocation.
 * Used to capture bot feedback from PR review bots (CodeRabbit, codecov,
 * claude-code-review, etc.) so the next LLM turn can act on the feedback.
 */
export function isGhPrCommand(command: string | undefined | null): boolean {
  if (typeof command !== "string" || command.length === 0) return false
  const normalized = command.replace(/\\\n/g, " ").replace(/\s*\n\s*/g, " ")
  return /(?:^|[\s;&|])gh\s+pr(?:\s|$)/.test(normalized)
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
  if (interventionCount >= 1) return false
  // v0.16.0: replaced inline CJS require with top-level ESM imports (F1.2).
  // In strict ESM environments, require() throws ReferenceError; the catch
  // was silently returning true (always inject), which broke the logic.
  // Now both file checks use synchronous fs/imports at module load.
  try {
    statSync(join(projectDir, "PLAN.md"))
    return false
  } catch { /* no PLAN.md */ }
  try {
    const agents = readFileSync(join(projectDir, "AGENTS.md"), "utf-8")
    if (/^##\s+Plan\b/im.test(agents)) return false
  } catch { /* no AGENTS.md */ }
  return true
}

// ─── v0.15.0 completion-signal detectors (module-level exports for testing) ───

/**
 * v0.10.0 legacy detector. Matches `<promise>DONE</promise>` (with optional
 * trailing `!`) and nothing else. Retained for backwards compatibility —
 * new code should prefer {@link detectPhaseCompleteSignal} for per-phase
 * hints or {@link detectPlanCompleteSignal} for the terminal marker.
 */
export function detectDoneSignal(
  text: string | undefined | null,
): boolean {
  if (typeof text !== "string" || text.length === 0) return false
  return /<promise>\s*DONE!?\s*<\/promise>/i.test(text)
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
  if (typeof text !== "string" || text.length === 0) return false
  return (
    /<promise>\s*DONE!?\s*<\/promise>/i.test(text) ||
    /<promise>\s*PHASE-\d+-COMPLETE\s*<\/promise>/i.test(text)
  )
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
  if (typeof text !== "string" || text.length === 0) return false
  return /<promise>\s*PLAN-COMPLETE\s*<\/promise>/i.test(text)
}
