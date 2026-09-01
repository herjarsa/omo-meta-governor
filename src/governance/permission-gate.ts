/**
 * v0.41.0: permission.ask hook handler.
 *
 * Routes permission requests through the governance policy. When the policy
 * matches a deny/ask pattern, the handler mutates output.status to block or
 * prompt the user, and increments the appropriate counter.
 *
 * SAFETY: policy.mode === undefined or empty patterns = pure pass-through
 * (preserves v0.40.0 behavior - OpenCode prompts user by default).
 */
import type { MetricsCollector } from "../metrics";
import {
  evaluateBashPolicy,
  evaluateEditPolicy,
  evaluateWebfetchPolicy,
  type GovernancePermissionPolicySubset,
} from "./permission-rules";

/**
 * OpenCode Permission shape (subset we care about - the SDK defines more types).
 * Discriminated by `type`.
 */
export type Permission =
  | { type: "bash"; command: string;[k: string]: unknown }
  | { type: "edit"; pattern: string;[k: string]: unknown }
  | { type: "webfetch"; url: string;[k: string]: unknown }
  | { type: string;[k: string]: unknown } // unknown types pass through

export interface PermissionOutput {
  status: "ask" | "deny" | "allow"
}

/**
 * v0.41.0: Handle a permission.ask invocation.
 * - If policy is undefined/empty: pass through (no override of status).
 * - If a deny pattern matches: set status="deny" + increment governance_blocks.
 * - If an ask pattern matches: set status="ask" + increment governance_asks.
 */
export async function handlePermissionAsk(
  input: Permission,
  output: PermissionOutput,
  policy: GovernancePermissionPolicySubset,
  metrics: MetricsCollector,
): Promise<void> {
  // Pure pass-through when policy is opt-out (default safe behavior).
  if (!policy || policy.mode === undefined) return
  if (!policy.mode) return

  let result
  switch (input.type) {
    case "bash":
      result = evaluateBashPolicy(input.command as string, policy)
      break
    case "edit":
      result = evaluateEditPolicy(input.pattern as string, policy)
      break
    case "webfetch":
      result = evaluateWebfetchPolicy(input.url as string, policy)
      break
    default:
      // Unknown permission types pass through.
      return
  }

  if (result === null) return // no match, pass through

  output.status = result.decision
  if (result.decision === "deny") {
    metrics.inc("governance_blocks")
  } else {
    metrics.inc("governance_asks")
  }
}