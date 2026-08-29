/**
 * MetaGovernor decision store - in-memory Map for intervention feature.
 *
 * Stores decisions produced by tool.execute.after so they can be
 * consumed by experimental.chat.messages.transform and
 * experimental.chat.system.transform hooks.
 *
 * The store is keyed by sessionID. For hooks that receive a sessionID
 * (system.transform), use takeDecision(sessionID). For hooks that
 * receive no sessionID (messages.transform), use takeAnyDecision().
 *
 * v0.34.2: added per-session decision history (capped) for the
 * paralysis-override signal consumed by scoring-engine.
 */
import type { DecisionHandlerOutput } from "./types"

// v0.34.2: per-session history (capped) for paralysis-override signal.
// Previously the store kept only the LAST decision per session; the
// scoring engine's consecutiveStops field was always 0 because no
// history was threaded. Now storeDecision also appends to a history
// list that countConsecutiveStops(decision-handler.ts:216) reads.
const MAX_HISTORY = 20

const store = new Map<string, DecisionHandlerOutput>()
const history = new Map<string, DecisionHandlerOutput["historyEntry"][]>()

/**
 * Store a decision for a session.
 * Overwrites any previous pending decision for the same session.
 * v0.34.2: also appends to per-session history.
 */
export function storeDecision(sessionID: string, decision: DecisionHandlerOutput): void {
  store.set(sessionID, decision)
  const list = history.get(sessionID) ?? []
  list.push(decision.historyEntry)
  if (list.length > MAX_HISTORY) list.splice(0, list.length - MAX_HISTORY)
  history.set(sessionID, list)
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
 * v0.38.6: peek at the pending decision WITHOUT consuming it.
 * Used by chat.messages.transform when the push may be skipped (e.g.
 * session-start gate): the caller reads the decision, decides whether
 * to inject it, and only calls takeDecision() if it will actually push.
 * Without peek, takeDecision would consume the decision even when the
 * push is skipped, losing the intervention.
 */
export function peekDecision(sessionID: string): DecisionHandlerOutput | undefined {
  return store.get(sessionID)
}

/**
 * Check whether a session has a pending decision without consuming it.
 */
export function hasDecision(sessionID: string): boolean {
  return store.has(sessionID)
}

/**
 * @deprecated v0.16.0: this function can leak decisions across sessions.
 * Use takeDecision(sessionID) instead - the messages.transform hook now
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
 * Clear all stored decisions and history. Useful in tests or when
 * a session ends.
 */
export function clearAll(): void {
  store.clear()
  history.clear()
}

/**
 * v0.34.2: per-session history of past decisions (capped at MAX_HISTORY).
 * Consumed by scoring-engine via countConsecutiveStops() to detect
 * paralysis (3+ consecutive stops triggers force-continue).
 */
export function getDecisionHistory(
  sessionID: string,
): readonly DecisionHandlerOutput["historyEntry"][] {
  return history.get(sessionID) ?? []
}