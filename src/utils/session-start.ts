/**
 * v0.38.6 — session-start detector for the TUI session-killer fix.
 *
 * Bug (reported 29/08/2026): the OpenCode TUI pauses a session and asks the
 * user to press "continue" when the LLM produces a completed turn before the
 * user has submitted any subsequent prompt. omo-meta-governor injects priming
 * nudges (skill-priming, graph-tools-ready, plan-reminder, bot feedback,
 * violations, decision interventions) via `output.messages.push({ role:
 * "assistant", agent: "meta-governor", synthetic: true })`. When this happens
 * during the user's FIRST message (no prior real assistant message), the TUI
 * treats the synthetic message as the agent's first (completed) turn and
 * pauses the session.
 *
 * Mid-session (after the agent has produced at least one real assistant
 * message), the TUI is in "running mode" and synthetic injections do NOT
 * pause the session.
 *
 * Fix: at session start (no real prior assistant message), the priming
 * nudges skip the `output.messages.push` entirely. The directive still reaches
 * the agent via `chat.system.transform` (banner-free system prompt injection).
 * persistIntervention still runs (log-only in prod) so the user sees the
 * notification in the file log + the agent surfaces it on the next turn via
 * the system prompt.
 *
 * Pure function — no I/O, no plugin state. Exported for hermetic testing.
 */

type MessageLike = { info: unknown; parts: unknown[] };

interface MessageInfo {
  role?: string;
  agent?: string;
  synthetic?: boolean;
}

/**
 * Returns true when the conversation has NO prior REAL assistant message
 * from the actual agent.
 *
 * Any meta-governor synthetic assistant message does NOT count as a real
 * prior message — the discriminator is the `agent` field ONLY (not the
 * `synthetic` flag, which may be missing/false on malformed payloads):
 *   - Real assistant messages come from a build/runtime agent
 *     (e.g. `build`, `code`, `plan`, `compaction`, etc.) — `agent` is
 *     undefined or any string other than `"meta-governor"`.
 *   - Synthetic meta-governor nudges always carry `agent === "meta-governor"`.
 *
 * If we let meta-governor messages count as "prior", the gate would
 * self-fulfill on the very first nudge it skipped (chicken and egg) — once
 * any nudge is pushed, the next transform call would consider it "not
 * session-start" and start pushing again, undoing the fix.
 */
export function isSessionStart(messages: readonly MessageLike[]): boolean {
  for (const m of messages) {
    const info = (m.info ?? {}) as MessageInfo;
    if (info.role !== "assistant") continue;
    if (info.agent === "meta-governor") continue;
    return false; // found a prior real assistant message
  }
  return true; // no prior real assistant message
}
