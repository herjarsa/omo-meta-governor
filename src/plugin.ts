import type { Hooks, Plugin, PluginInput, PluginOptions } from "@opencode-ai/plugin"
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
  triggerCodegraphSync,
} from "./graph-sync"
import { runMetaGovernor } from "./orchestrator"
import { loadOrchestratorConfig, type MetaGovernorPluginConfig } from "./config"
import { storeDecision, takeDecision } from "./decision-store"
import { logToFile } from "./file-logger"
import { statSync } from "node:fs"
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
}

// - Helpers

const ACTION_SEVERITY: Record<string, number> = {
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

let idCounter = 0
function generateID(): string {
  idCounter++
  return `mg-${Date.now()}-${idCounter}`
}

// - Plugin factory

export function createMetaGovernorPlugin(
  config: MetaGovernorPluginConfig = {},
  deps: MetaGovernorPluginDeps = {},
): Plugin {
  // Detect project graph directories at load time
  const cwd = process.cwd()
  const projectHasCodegraph = (() => {
    try { return statSync(`${cwd}/.codegraph`).isDirectory() } catch { return false }
})()
  const projectHasGraphify = (() => {
    try { return statSync(`${cwd}/graphify-out`).isDirectory() } catch { return false }
  })()

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
    version: "0.10.0",
    cwd,
    projectHasCodegraph,
    projectHasGraphify,
  })

  const plugin: Plugin = async (
    _input: PluginInput,
    options?: PluginOptions,
  ): Promise<Hooks> => {
    // 1. Load config from plugin options
    const rawConfig = {
      ...config,
      ...((options?.meta_governor as MetaGovernorPluginConfig) ?? {}),
    }
    const mergedConfig = loadOrchestratorConfig(rawConfig)

    // 2. If disabled, return empty hooks
    if (!mergedConfig.enabled) {
      return {}
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
    if (mergedConfig.protocolEnforcement.enabled || mergedConfig.protocolEnforcement.injectIntoSystem) {
      const protocolPath = mergedConfig.protocolEnforcement.path ?? DEFAULT_PROTOCOL_PATH
      loadProtocol(protocolPath).then((text: string) => {
        systemInjection = buildSystemInjection(text)
      }).catch((err: unknown) => {
        if (typeof console !== "undefined" && mergedConfig.modelOverride?.verbosity !== "silent") {
          console.warn("[meta-governor] could not load protocol:", err instanceof Error ? err.message : err)
        }
      })
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
      taskDoneSignal: boolean
      interventionCount: number
      interventionDisabled: boolean
    }
    const auditSessions = new Map<string, AuditState>()

    // Pending protocol violations queue
// Pending protocol violations queue
    const pendingViolations = new Map<string, string[]>()

    // v0.11.0: pending bot feedback (from `gh pr checks` / `gh pr view` output)
    const pendingBotFeedback = new Map<string, string[]>()

    // v0.11.0: whether the plan reminder has been injected for this session
    const planReminderSent = new Set<string>()
    // v0.10.0: detect `<promise>DONE</promise>` (with optional !) in any
    // tool output / agent output string. Sisyphus emits this to mark the
    // user's task as verifiably complete.
    function detectDoneSignal(text: string | undefined | null): boolean {
      if (typeof text !== "string" || text.length === 0) return false
      return /<promise>\s*DONE!?\s*<\/promise>/i.test(text)
    }

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
            hasCodegraphDir: projectHasCodegraph,
            hasGraphifyDir: projectHasGraphify,
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
            interventionCount: 0,
            interventionDisabled: false,
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
          const existing = pendingViolations.get(toolInput.sessionID) ?? []
          for (const v of violations) {
            existing.push(`[${v.severity.toUpperCase()}] ${v.rule}: ${v.detail}`)
          }
          pendingViolations.set(toolInput.sessionID, existing)
        } else {
          logToFile("info", `audit OK on tool ${toolInput.tool}`)
        }
      },

      // - Tool execute after (orchestrator + audit state update)
      "tool.execute.after": async (
        toolInput: { tool: string; sessionID: string; callID: string; args: unknown },
        toolOutput: { title: string; output: string; metadata: unknown },
      ): Promise<void> => {
        if (!mergedConfig.enabled) return

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

          // v0.10.0: detect <promise>DONE</promise> in tool output
          if (!sessionState.taskDoneSignal) {
            if (
              detectDoneSignal(toolOutput.output) ||
              detectDoneSignal(toolInput.args as string | undefined)
            ) {
              sessionState.taskDoneSignal = true
              logToFile(
                "info",
                `task_done_signal detected for session ${toolInput.sessionID}`,
              )
            }
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
          backends: deps.backends ?? {
            agentmemory: { smartSearch: async () => ({ lessons: [], crystals: [] }) },
            magicContext: { slotList: async () => [] },
            boulderState: { boulderRead: async () => [] },
          },
          writeBackend: deps.writeBackend ?? {
            saveMemory: async () => ({ id: "" }),
            saveLesson: async () => ({ id: "" }),
          },
          config: mergedConfig,
          ...(getProviderID() ? { providerID: getProviderID() } : {}),
          ...(getModelID() ? { modelID: getModelID() } : {}),
          modelLimit: getModelLimit(),
        }

        try {
          const output = await runMetaGovernor(orchestratorInput)

          if (mergedConfig.intervention.mode !== "silent" && sessionState) {
            const decision = output.decision

            // v0.10.0: DONE + Oracle verified → stop intervening
            if (
              mergedConfig.intervention.respectDoneSignal &&
              sessionState.taskDoneSignal &&
              sessionState.oracleInvoked
            ) {
              sessionState.interventionDisabled = true
              logToFile(
                "info",
                `task verified (DONE + Oracle): disabling intervention for session ${toolInput.sessionID}`,
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
              // Fire and forget — don't block the tool call
              void triggerCodegraphSync(cwd).catch((err) => {
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
                const existing = pendingBotFeedback.get(toolInput.sessionID) ?? []
                pendingBotFeedback.set(
                  toolInput.sessionID,
                  existing.concat(feedback),
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
        if (pendingBotFeedback.has(currentSessionID)) {
          const feedback = pendingBotFeedback.get(currentSessionID)!
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
        if (pendingViolations.has(currentSessionID)) {
          const violations = pendingViolations.get(currentSessionID)!
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
            hasCodegraphDir: projectHasCodegraph,
            hasGraphifyDir: projectHasGraphify,
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
            interventionCount: 0,
            interventionDisabled: false,
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
  try {
    const { statSync, readFileSync } = require("node:fs")
    const { join } = require("node:path")
    // PLAN.md wins
    try {
      statSync(join(projectDir, "PLAN.md"))
      return false
    } catch { /* no PLAN.md */ }
    // Check AGENTS.md for a Plan section
    try {
      const agents = readFileSync(join(projectDir, "AGENTS.md"), "utf-8")
      if (/^##\s+Plan\b/im.test(agents)) return false
    } catch { /* no AGENTS.md */ }
    return true
  } catch {
    return true
  }
}
