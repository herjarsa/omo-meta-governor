import type { Hooks, Plugin, PluginInput, PluginOptions } from "@opencode-ai/plugin"
import type { UserMessage, TextPart } from "@opencode-ai/sdk"
import type {
  AgentmemoryWriteBackend,
  DecisionHandlerOutput,
  MemoryBackends,
  MetaGovernorInput,
  ProtocolViolation,
} from "./types"
import { runGraphSync, type GraphSyncConfig } from "./graph-sync"
import { runMetaGovernor } from "./orchestrator"
import { loadOrchestratorConfig, type MetaGovernorPluginConfig } from "./config"
import { storeDecision, takeAnyDecision, takeDecision } from "./decision-store"
import {
  loadProtocol,
  buildSystemInjection,
  auditToolCall,
  DEFAULT_PROTOCOL_PATH,
} from "./protocol-enforcer"

/**
 * Dependencies required by the MetaGovernor plugin.
 * All are optional — features degrade gracefully when backends are unavailable.
 */
export interface MetaGovernorPluginDeps {
  /** Backends for reading memory (agentmemory, magic-context, boulder-state). Optional — degrades gracefully. */
  backends?: MemoryBackends
  /** Backend for writing lessons/decisions back to agentmemory. Optional — degrades gracefully. */
  writeBackend?: AgentmemoryWriteBackend
  /** Provider ID for the current session (for token predictor). */
  providerID?: () => string | undefined
  /** Model ID for the current session (for token predictor). */
  modelID?: () => string | undefined
}

// ─── Helpers ──────────────────────────────────────────────────────

const ACTION_SEVERITY: Record<string, number> = {
  continue: 0,
  warn: 1,
  escalate: 2,
  stop: 3,
}

/**
 * Check if the given action meets or exceeds the minimum severity threshold.
 */
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

// ─── Plugin factory ─────────────────────────────────────────────

/**
 * Create a MetaGovernor plugin that registers:
 * 1. `tool.execute.after` — runs the orchestrator pipeline
 * 2. `experimental.chat.messages.transform` — injects decisions as synthetic user messages
 * 3. `experimental.chat.system.transform` — appends decision guidance to system prompt
 */
export function createMetaGovernorPlugin(
  deps: MetaGovernorPluginDeps = {},
): Plugin {
  const plugin: Plugin = async (
    _input: PluginInput,
    options?: PluginOptions,
  ): Promise<Hooks> => {
    // 1. Load config from plugin options (PluginOptions = Record<string, unknown>)
    const rawConfig = ((options?.meta_governor as MetaGovernorPluginConfig) ?? {})
    const config = loadOrchestratorConfig(rawConfig)

    // 2. If disabled, return empty hooks
    if (!config.enabled) {
      return {}
    }

    // 2a. Run graphSync (best-effort, non-blocking)
const graphSyncCfg: GraphSyncConfig = {
enabled: rawConfig?.graphSync?.enabled ?? true,
      watch: rawConfig?.graphSync?.watch ?? false,
      autoInstall: rawConfig?.graphSync?.autoInstall ?? true,
      installTimeoutMs: rawConfig?.graphSync?.installTimeoutMs ?? 60_000,
}
    runGraphSync(graphSyncCfg).catch(() => {})

    // 3. Helper to resolve model settings from override or session
    const getProviderID = (): string | undefined =>
      config.modelOverride?.providerID ?? deps.providerID?.()
    const getModelID = (): string | undefined =>
      config.modelOverride?.modelID ?? deps.modelID?.()
    const getModelLimit = (): number =>
      config.modelOverride?.modelLimit ?? 200_000

    const providerID = getProviderID() ?? "unknown"
    const modelID = getModelID() ?? "unknown"

    // 4. Load protocol text for enforcement (best-effort, cached once)
    let protocolText: string | undefined
    let systemInjection: string | undefined
    if (config.protocolEnforcement.enabled || config.protocolEnforcement.injectIntoSystem) {
      const protocolPath = config.protocolEnforcement.path ?? DEFAULT_PROTOCOL_PATH
      loadProtocol(protocolPath).then((text) => {
        protocolText = text
        systemInjection = buildSystemInjection(text)
      }).catch((err) => {
        if (typeof console !== "undefined" && config.modelOverride?.verbosity !== "silent") {
          console.warn("[meta-governor] could not load protocol:", err instanceof Error ? err.message : err)
        }
      })
    }

    // 5. Per-session audit state (for tool.execute.before)
    type AuditState = {
      memoryToolsUsed: string[]
      hasCodegraphDir: boolean
      hasGraphifyDir: boolean
      oracleInvoked: boolean
      filesChanged: number
      emptyRecall: boolean
      escalationAttempted: boolean
    }
    const auditSessions = new Map<string, AuditState>()

    return {
      // ── Tool execute before (protocol audit) ────────────────────
      "tool.execute.before": async (
        toolInput: { tool: string; sessionID: string }
      ): Promise<void> => {
        if (!config.enabled) return
        if (!config.protocolEnforcement.auditToolCalls) return
        if (!toolInput.sessionID) return

        // Get or create audit state for this session
        let state = auditSessions.get(toolInput.sessionID)
        if (!state) {
          state = {
            memoryToolsUsed: [],
            hasCodegraphDir: false,
            hasGraphifyDir: false,
            oracleInvoked: false,
            filesChanged: 0,
            emptyRecall: false,
            escalationAttempted: false,
          }
          auditSessions.set(toolInput.sessionID, state)
        }

        if (systemInjection) {
          console.log("[meta-governor] protocol loaded, system injection ready")
        }
      },
      "tool.execute.after": async (
        toolInput: { tool: string; sessionID: string; callID: string },
        toolOutput: { title: string; output: string; metadata: unknown },
      ): Promise<void> => {
        if (!config.enabled) return

        // Build the orchestrator input from available signals
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
            agentmemory: {
              smartSearch: async () => ({ lessons: [], crystals: [] }),
            },
            magicContext: {
              slotList: async () => [],
            },
            boulderState: {
              boulderRead: async () => [],
            },
          },
          writeBackend: deps.writeBackend ?? {
            saveMemory: async () => ({ id: "" }),
            saveLesson: async () => ({ id: "" }),
          },
          config,
          ...(getProviderID() ? { providerID: getProviderID() } : {}),
          ...(getModelID() ? { modelID: getModelID() } : {}),
          modelLimit: getModelLimit(),
        }

        // Run the orchestrator
        try {
          const output = await runMetaGovernor(orchestratorInput)

          // 4. Store decision for intervention if applicable
          if (config.intervention.mode !== "silent") {
            const decision = output.decision
            if (
              decision.action !== "continue" &&
              meetsMinAction(decision.action, config.intervention.minActionForMessage)
            ) {
              storeDecision(toolInput.sessionID, decision)
            }
          }
        } catch (err) {
          // MetaGovernor must NEVER break a tool call.
          if (typeof console !== "undefined" && config.modelOverride?.verbosity !== "silent") {
            console.error("[meta-governor] orchestrator error:", err)
          }
        }
      },

      // ── Messages transform (injects decision as synthetic user message) ──
      "experimental.chat.messages.transform": async (
        _input: {},
        output: {
          messages: Array<{ info: unknown; parts: unknown[] }>
        },
      ): Promise<void> => {
        if (!config.enabled) return
        if (config.intervention.mode !== "message") return

        const decision = takeAnyDecision()
        if (!decision) return
        if (decision.action === "continue") return
        if (!decision.message) return
        if (!meetsMinAction(decision.action, config.intervention.minActionForMessage)) return

        const messageID = generateID()
        const partID = generateID()
        const sessionID = "intervention"

        const syntheticUserMessage: UserMessage = {
          id: generateID(),
          sessionID,
          role: "user",
          time: { created: Date.now() },
          agent: "meta-governor",
          model: { providerID, modelID },
        }

        const syntheticPart: TextPart = {
          id: partID,
          sessionID,
          messageID,
          type: "text",
          text: decision.message,
          synthetic: true,
        }

        output.messages.unshift({
          info: syntheticUserMessage,
          parts: [syntheticPart],
        })
      },

      // ── System transform (injects protocol text + decision guidance) ──
      "experimental.chat.system.transform": async (
        transformInput: { sessionID?: string },
        output: { system: string[] },
      ): Promise<void> => {
        if (!config.enabled) return

        // 1. Inject Sisyphus protocol text into system prompt
        if (config.protocolEnforcement.injectIntoSystem && systemInjection) {
          output.system.push(
            "\n### ⚙ Sisyphus Protocol Enforcement",
            systemInjection,
            "---",
          )
        }

        // 2. Inject decision guidance for "system" intervention mode
        if (config.intervention.mode === "system" && transformInput.sessionID) {
          const decision = takeDecision(transformInput.sessionID)
          if (decision && decision.action !== "continue" && decision.message) {
            if (meetsMinAction(decision.action, config.intervention.minActionForMessage)) {
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
