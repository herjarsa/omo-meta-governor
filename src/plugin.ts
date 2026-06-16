import type { Hooks, Plugin, PluginInput, PluginOptions } from "@opencode-ai/plugin"
import type {
  AgentmemoryWriteBackend,
  DecisionHandlerOutput,
  MemoryBackends,
  MetaGovernorInput,
} from "./types"
import { runGraphSync, trackSession, untrackSession } from "./graph-sync"
import { runMetaGovernor } from "./orchestrator"
import { loadOrchestratorConfig, type MetaGovernorPluginConfig } from "./config"
import { storeDecision, takeAnyDecision, takeDecision } from "./decision-store"
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
    version: "0.9.3",
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

    // 5. Per-session audit state
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
    }
    const auditSessions = new Map<string, AuditState>()

    // Pending protocol violations queue
    const pendingViolations = new Map<string, string[]>()

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
        }

        const orchestratorInput: MetaGovernorInput = {
          sessionID: toolInput.sessionID,
          toolName: toolInput.tool,
          toolOutput: toolOutput.output,
          iteration: 0,
          maxIterations: 10,
          oracleVerified: false,
          noProgress: false,
          filesChanged: 0,
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

          if (mergedConfig.intervention.mode !== "silent") {
            const decision = output.decision
            if (
              decision.action !== "continue" &&
              meetsMinAction(decision.action, mergedConfig.intervention.minActionForMessage)
            ) {
              storeDecision(toolInput.sessionID, decision)
            }
          }
        } catch {
          // MetaGovernor must NEVER break a tool call
        }
      },

      // - Messages transform (injects decisions + protocol violations as synthetic user messages)
      "experimental.chat.messages.transform": async (
        _input: {},
        output: { messages: Array<{ info: unknown; parts: unknown[] }> },
      ): Promise<void> => {
        if (!mergedConfig.enabled) return
        if (mergedConfig.intervention.mode !== "message") return

        // 1. Inject pending protocol violations so the model sees them
        const lastMsg = output.messages[output.messages.length - 1] as { info?: { sessionID?: string } } | undefined
        const violationSessionID = lastMsg?.info?.sessionID
        if (violationSessionID && pendingViolations.has(violationSessionID)) {
          const violations = pendingViolations.get(violationSessionID)!
          if (violations.length > 0) {
            const violationText = `[META-GOVERNOR PROTOCOL VIOLATIONS - YOU MUST COMPLY]\n\n${violations.map((v, i) => `${i + 1}. ${v}`).join("\n")}\n\nRemember: use codegraph/graphify for architecture queries, do not grep without trying AFT/codegraph first, no @ts-ignore/as-any, no empty catch, check memory before asking.`
            output.messages.push({
              info: { role: "user", agent: "meta-governor", synthetic: true },
              parts: [{ type: "text", text: violationText, synthetic: true }],
            })
            pendingViolations.delete(violationSessionID)
            logToFile("info", `injected ${violations.length} violation(s) to model`)
          }
        }

        // 2. Inject MetaGovernor decision
        const decision = takeAnyDecision()
        if (!decision) return
        if (decision.action === "continue") return
        if (!decision.message) return
        if (!meetsMinAction(decision.action, mergedConfig.intervention.minActionForMessage)) return

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
          const decision = takeDecision(transformInput.sessionID)
          if (decision && decision.action !== "continue" && decision.message) {
            if (meetsMinAction(decision.action, mergedConfig.intervention.minActionForMessage)) {
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
