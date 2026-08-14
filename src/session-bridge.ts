/**
 * SessionBridge — gives omo-meta-governor a way to instruct the LLM to call
 * MCP tools (AgentMemory, Magic Context, etc.) via `session.prompt()`.
 *
 * Why this exists (v0.14.0 pivot):
 * The OpenCode SDK (1.17.4) does NOT expose a way to call MCP tools directly
 * from the plugin — `client.tool` only has `ids()` and `list()`, no `invoke()`.
 * The only path to invoke MCP tools is through the LLM itself: the agent must
 * call them as part of its tool-using flow.
 *
 * So instead of trying to call AgentMemory directly, we create custom tools
 * that:
 *  1. Receive a request from the LLM (e.g. "remember this content")
 *  2. Use `session.prompt()` to send a follow-up message to the same session
 *     that explicitly tells the LLM to call the right MCP tool with the right args
 *  3. Return a result that the LLM sees immediately
 *
 * This is one level of indirection but it works without SDK changes. Trade-off:
 * each "direct" call now goes through an LLM round-trip, adding ~1-2s latency.
 *
 * Design:
 * - The `client` is captured from PluginInput on first plugin invocation and
 *   stored in a module-level variable (see plugin.ts).
 * - `promptAgent()` is the single entry point — all custom tools call it.
 * - Failures degrade silently: if the client is unavailable or the session
 *   is busy, the tool returns a friendly error string and the LLM can retry.
 */

import { join } from "node:path";
import { existsSync } from "node:fs";
import { AsyncLocalStorage } from "node:async_hooks";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * The subset of the OpenCode client API we actually use. The real type is
 * `ReturnType<typeof createOpencodeClient>` but it's huge — we declare
 * only what we need to avoid pulling in the full SDK type.
 */
export interface OpencodeClientLike {
  session: {
    prompt(input: {
      sessionID: string;
      body: {
        // Accept any shape — the SDK allows parts as a discriminated union
        parts: Array<{ type: string; text?: string; [k: string]: unknown }>;
      };
    }): Promise<{ data?: { info?: { id?: string } } | null } | null>;
  };
}

export interface PromptOptions {
  /** The tool name to mention in the prompt (for context) */
  toolName: string;
  /** The MCP tool the agent should invoke */
  mcpTool: string;
  /** Args to pass to the MCP tool (will be serialized to JSON) */
  mcpArgs: Record<string, unknown>;
  /** Optional instruction prefix (e.g. "this is a durable fact") */
  preamble?: string;
  /** Timeout in ms. Default: 15_000 (MCP tools can be slow) */
  timeoutMs?: number;
}

export interface PromptResult {
  /** True if the prompt was sent and the session accepted it */
  ok: boolean;
  /** The session message id (if available) */
  messageID: string | null;
  /** Error if the prompt failed */
  error: string | null;
  /** Time taken in ms */
  durationMs: number;
}

// ---------------------------------------------------------------------------
// Module-level state
// ---------------------------------------------------------------------------

// v0.16.0: F3.5 — AsyncLocalStorage isolates per-session client state.
// Previously a module-level _client meant concurrent sessions could
// overwrite each other's client reference. Now each session's client
// is bound to its async context via runWithClient().
export const _sessionStore = new AsyncLocalStorage<OpencodeClientLike>();
let _lastInitLog: number = 0;
let _fallbackClient: OpencodeClientLike | null = null;

/**
 * Set the OpenCode client. Called from the plugin factory when the first
 * `event` hook fires. Safe to call multiple times — last writer wins.
 */
export function setSessionClient(client: OpencodeClientLike | null): void {
  if (client) {
    const now = Date.now();
    if (now - _lastInitLog > 1000) {
      _lastInitLog = now;
      // Lazy require to avoid circular dep at module load
      try {
        const { logToFile } = require("./file-logger");
        logToFile(
          "info",
          "SessionBridge: OpenCode client hydrated — session.prompt() available",
        );
      } catch {
        // best-effort
      }
    }
  }
  // Legacy: also write to a module-level fallback so promptAgent can find
  // it when called outside a runWithClient context (e.g., direct test).
  _fallbackClient = client;
}

/**
 * Run a function with a specific client bound to its async context. All
 * promptAgent() calls inside the function will use this client, isolated
 * from other concurrent sessions.
 */
export function runWithClient<T>(client: OpencodeClientLike, fn: () => T): T {
  return _sessionStore.run(client, fn);
}

/**
 * Returns true if a client is available for session.prompt() calls.
 */
export function hasSessionClient(): boolean {
  return (_sessionStore.getStore() ?? _fallbackClient) !== null;
}

// ---------------------------------------------------------------------------
// Core: promptAgent
// ---------------------------------------------------------------------------

/**
 * Send a message to the LLM that instructs it to call a specific MCP tool
 * with specific args. This is the bridge between the plugin and MCP servers
 * (AgentMemory, Magic Context, etc.) since we can't call them directly.
 *
 * Example: promptAgent({ toolName: "omo_remember", mcpTool: "agentmemory_memory_save",
 *                        mcpArgs: { content: "...", concepts: [...] } })
 *   → sends a user message to the session:
 *     "Use the agentmemory_memory_save tool with these exact args: {...}"
 *   → LLM processes and calls agentmemory_memory_save
 *   → we return ok:true (the prompt was accepted)
 *
 * NOTE: This does NOT wait for the LLM to actually call the MCP tool —
 * `session.prompt()` returns when the message is queued. The actual MCP
 * tool call happens asynchronously on the LLM's next turn. If you need
 * confirmation that the MCP tool was called, watch for it in
 * `tool.execute.after` or check AgentMemory directly.
 */
export async function promptAgent(
  sessionID: string,
  options: PromptOptions,
): Promise<PromptResult> {
  const start = Date.now();
  const timeoutMs = options.timeoutMs ?? 15_000;
  const client = _sessionStore.getStore() ?? _fallbackClient;
  if (!client) {
    return {
      ok: false,
      messageID: null,
      error:
        "SessionBridge: no OpenCode client captured (plugin not initialized?)",
      durationMs: 0,
    };
  }
  if (!sessionID) {
    return {
      ok: false,
      messageID: null,
      error: "SessionBridge: sessionID is required",
      durationMs: 0,
    };
  }
  const mcpArgsJson = JSON.stringify(options.mcpArgs, null, 2);
  const preamble = options.preamble ?? "The user wants to record this.";
  const instruction =
    `${preamble}\n\n` +
    `Please call the \`${options.mcpTool}\` MCP tool with EXACTLY these args:\n\n` +
    "```json\n" +
    mcpArgsJson +
    "\n```\n\n" +
    `Do not paraphrase, modify, or add fields. Pass the args through verbatim.\n` +
    `After the tool call, briefly confirm what you stored and for which tool.`;
  const part = { type: "text", text: instruction };
  try {
    const result = await raceWithTimeout(
      client.session.prompt({ sessionID, body: { parts: [part] } }),
      timeoutMs,
      `session.prompt for ${options.mcpTool}`,
    );
    const messageID =
      (result as { data?: { info?: { id?: string } } | null })?.data?.info
        ?.id ?? null;
    return {
      ok: true,
      messageID,
      error: null,
      durationMs: Date.now() - start,
    };
  } catch (err) {
    return {
      ok: false,
      messageID: null,
      error: err instanceof Error ? err.message : String(err),
      durationMs: Date.now() - start,
    };
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Persist a plain-text message into the session via session.prompt() so it
 * becomes a REAL user message: visible in the OpenCode TUI and stored in
 * the session DB. Unlike promptAgent, this does NOT instruct the LLM to
 * call a tool — it just records text.
 *
 * v0.19.0: used by messages.transform to make MetaGovernor interventions
 * (plan reminders, violations, decisions) visible to the user. The transform
 * push alone reaches the model but is never persisted in OpenCode 1.18.x.
 *
 * NOTE: session.prompt() queues the message for the LLM's next turn — it
 * returns when queued, not when processed. Best-effort: never throws;
 * returns ok:false with error when the client is unavailable.
 */
export async function persistSessionMessage(
  sessionID: string,
  text: string,
  timeoutMs = 10_000,
): Promise<PromptResult> {
  const start = Date.now();
  const client = _sessionStore.getStore() ?? _fallbackClient;
  if (!client) {
    return {
      ok: false,
      messageID: null,
      error:
        "SessionBridge: no OpenCode client captured (plugin not initialized?)",
      durationMs: 0,
    };
  }
  if (!sessionID || !text) {
    return {
      ok: false,
      messageID: null,
      error: "SessionBridge: sessionID and text are required",
      durationMs: 0,
    };
  }
  const part = { type: "text", text };
  try {
    const result = await raceWithTimeout(
      client.session.prompt({ sessionID, body: { parts: [part] } }),
      timeoutMs,
      `session.prompt persist for ${sessionID}`,
    );
    const messageID =
      (result as { data?: { info?: { id?: string } } | null })?.data?.info
        ?.id ?? null;
    return {
      ok: true,
      messageID,
      error: null,
      durationMs: Date.now() - start,
    };
  } catch (err) {
    return {
      ok: false,
      messageID: null,
      error: err instanceof Error ? err.message : String(err),
      durationMs: Date.now() - start,
    };
  }
}

/**
 * Send a plain-text directive to the session as a REAL user message —
 * visible in the OpenCode TUI and stored in the session DB.
 *
 * v0.21.0: send plain-text directive to the session (used by the post-wave
 * gate to inject push/PR landing instructions).
 *
 * Thin wrapper over persistSessionMessage: same transport
 * (`session.prompt({ sessionID, body: { parts: [{ type: "text", text }] } })`)
 * and same delivery semantics — awaited, never throws. Resolves with
 * `PromptResult`; the caller (post-wave gate W4.4) must check `result.ok` to
 * confirm the directive was actually queued for the LLM.
 */
export async function promptAgentText(
  sessionID: string,
  text: string,
): Promise<PromptResult> {
  return persistSessionMessage(sessionID, text);
}

function raceWithTimeout<T>(
  promise: Promise<T>,
  ms: number,
  label: string,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`${label} timed out after ${ms}ms`));
    }, ms);
    promise.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

// Re-export existsSync for the plugin factory to detect a project context
export { existsSync, join };

// ─── v0.17.0 (F5.1): escalation prompt builder ──────────────────

/**
 * Build the prompt that instructs the LLM to invoke Oracle (or escalate
 * to the user) when the MetaGovernor decision is "escalate".
 *
 * Pure function — testable in isolation.
 */
export function buildEscalationPrompt(options: {
  reasoning: string;
  target: "oracle" | "user";
  evidenceCount: number;
  sessionID: string;
}): string {
  if (options.target === "oracle") {
    return (
      `[MetaGovernor] Escalation triggered. Reason: ${options.reasoning}\n\n` +
      `Please invoke the \`task\` tool with \`subagent_type=oracle\` to ` +
      `perform a verification pass on the current session state. ` +
      `Decision context: ${options.evidenceCount} evidence unit(s). ` +
      `After Oracle returns, you should continue with the recommended action.`
    );
  }
  return (
    `[MetaGovernor] Escalation to user required. Reason: ${options.reasoning}\n\n` +
    `Present a clear summary to the user with the deviation(s) detected and ` +
    `your recommended next steps. Wait for explicit user input before proceeding.`
  );
}
