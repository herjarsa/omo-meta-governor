/**
 * MetaGovernor decision store — in-memory Map for intervention feature.
 *
 * Stores decisions produced by tool.execute.after so they can be
 * consumed by experimental.chat.messages.transform and
 * experimental.chat.system.transform hooks.
 *
 * The store is keyed by sessionID. For hooks that receive a sessionID
 * (system.transform), use takeDecision(sessionID). For hooks that
 * receive no sessionID (messages.transform), use takeAnyDecision().
 */
import type { DecisionHandlerOutput } from "./types"

const store = new Map<string, DecisionHandlerOutput>()

/**
 * Store a decision for a session.
 * Overwrites any previous pending decision for the same session.
 */
export function storeDecision(sessionID: string, decision: DecisionHandlerOutput): void {
  store.set(sessionID, decision)
}

/**
 * Take (retrieve and remove) the pending decision for a session.
 * Returns undefined if no decision is pending.
 */
export function takeDecision(sessionID: string): DecisionHandlerOutput | undefined {
  const decision = store.get(sessionID)
  if (decision !== undefined) {
    store.delete(sessionID)
  }
  return decision
}

/**
 * Check whether a session has a pending decision without consuming it.
 */
export function hasDecision(sessionID: string): boolean {
  return store.has(sessionID)
}

/**
 * @deprecated v0.16.0: this function can leak decisions across sessions.
 * Use takeDecision(sessionID) instead — the messages.transform hook now
 * derives the sessionID from the last outgoing message (see plugin.ts).
 * Will be removed in v0.18.0.
 */
export function takeAnyDecision(): DecisionHandlerOutput | undefined {
  for (const [sessionID, decision] of store) {
    store.delete(sessionID)
    return decision
  }
  return undefined
}

/**
 * Clear all stored decisions. Useful in tests or when a session ends.
 */
export function clearAll(): void {
  store.clear()
}
