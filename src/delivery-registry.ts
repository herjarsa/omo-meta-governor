/**
 * v0.17.0 (F3.6): PendingDeliveryRegistry — track bridge tool dispatches
 * and verify they were actually delivered by the LLM via the matching
 * MCP tool call in `tool.execute.after`.
 *
 * Why this exists (v0.14.0 pivot):
 * session-bridge uses `session.prompt()` to instruct the LLM to call an
 * MCP tool (e.g. agentmemory_memory_save). The LLM may or may not follow
 * the instruction. Previously, the bridge tool returned "dispatched" on
 * `session.prompt()` success — but that just means the prompt was queued,
 * not that the MCP tool was actually called. This registry gives us a
 * way to verify delivery within a short window.
 *
 * Design:
 * - Per-session pending entries (Map) — small, bounded, TTL-cleaned.
 * - `register()` when a bridge tool dispatches a prompt.
 * - `markDelivered()` when tool.execute.after sees a matching tool call.
 * - `awaitDelivery()` is a brief async poll (~2-3s) used by bridge tools
 *   to surface fast deliveries. Slow deliveries are still tracked.
 */

export interface PendingDelivery {
  /** Unique id (randomUUID) so callers can correlate. */
  readonly id: string
  readonly sessionID: string
  /** The MCP tool the bridge instructed the LLM to call. */
  readonly mcpTool: string
  /** Hash of mcpArgs to match the eventual tool call. */
  readonly mcpArgsHash: string
  /** When registered (ms since epoch). */
  readonly registeredAt: number
  /** TTL in ms — after this, the entry is considered expired. */
  readonly ttlMs: number
}

export type DeliveryStatus = "pending" | "delivered" | "expired"

const DEFAULT_TTL_MS = 10_000

export class PendingDeliveryRegistry {
  private readonly entries = new Map<string, PendingDelivery>()
  /** When mcpArgs match is disabled (no mcpArgs available on observed call) */
  private deliveredCount = 0
  private expiredCount = 0

  /**
   * Register a pending delivery. Returns a random id for correlation.
   */
  register(input: {
    sessionID: string
    mcpTool: string
    mcpArgs: Record<string, unknown>
    ttlMs?: number
  }): string {
    this.cleanup()
    const id = `deliv-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
    const argsHash = hashArgs(input.mcpArgs)
    this.entries.set(id, {
      id,
      sessionID: input.sessionID,
      mcpTool: input.mcpTool,
      mcpArgsHash: argsHash,
      registeredAt: Date.now(),
      ttlMs: input.ttlMs ?? DEFAULT_TTL_MS,
    })
    return id
  }

  /**
   * Mark a pending delivery as delivered. Returns the matching id if
   * found, or null if no pending entry matches.
   */
  markDelivered(input: { sessionID: string; mcpTool: string; mcpArgs?: unknown }): string | null {
    this.cleanup()
    const argsHash = input.mcpArgs ? hashArgs(input.mcpArgs as Record<string, unknown>) : null
    for (const [id, item] of this.entries) {
      if (item.sessionID !== input.sessionID) continue
      if (item.mcpTool !== input.mcpTool) continue
      if (argsHash !== null && item.mcpArgsHash !== argsHash) continue
      this.entries.delete(id)
      this.deliveredCount++
      return id
    }
    return null
  }

  /**
   * Brief async poll: wait for the matching delivery, up to `timeoutMs`.
   * Resolves with the status when the delivery is verified or expires.
   */
  async awaitDelivery(input: {
    sessionID: string
    mcpTool: string
    timeoutMs?: number
  }): Promise<DeliveryStatus> {
    const timeout = input.timeoutMs ?? 2000
    const start = Date.now()
    while (Date.now() - start < timeout) {
      this.cleanup()
      const match = [...this.entries.values()].find(
        (i) => i.sessionID === input.sessionID && i.mcpTool === input.mcpTool,
      )
      if (!match) {
        // Either delivered or expired — return "delivered" since the
        // markDelivered call would have removed it.
        return "delivered"
      }
      await sleep(50)
    }
    return "expired"
  }

  /**
   * Return current stats: pending + cumulative delivered + cumulative expired.
   */
  getStats(): { pending: number; delivered: number; expired: number } {
    return {
      pending: this.entries.size,
      delivered: this.deliveredCount,
      expired: this.expiredCount,
    }
  }

  /**
   * Clear all entries for a session. Useful on session end.
   */
  clearSession(sessionID: string): void {
    for (const [id, item] of this.entries) {
      if (item.sessionID === sessionID) this.entries.delete(id)
    }
  }

  /**
   * Remove expired entries. Called internally on register/mark/await.
   */
  private cleanup(): void {
    const now = Date.now()
    for (const [id, item] of this.entries) {
      if (now - item.registeredAt > item.ttlMs) {
        this.entries.delete(id)
        this.expiredCount++
      }
    }
  }
}

function hashArgs(args: Record<string, unknown>): string {
  // Stable JSON serialization for matching
  return JSON.stringify(args, Object.keys(args).sort())
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
