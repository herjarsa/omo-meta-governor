/**
 * v0.41.0: Pure-function regex matchers for permission.ask policy.
 *
 * No I/O, no plugin deps - these are the building blocks the permission-gate
 * handler calls. Each function returns a PermissionMatchResult with the
 * governance decision ("deny" / "ask") and a human-readable reason
 * for the audit log.
 *
 * SAFETY: callers MUST treat null as "do nothing" (preserve OpenCode's
 * default permission flow). "deny" blocks silently, "ask" prompts the user.
 */
export type PermissionDecision = "allow" | "deny" | "ask"

export interface PermissionMatchResult {
  decision: Exclude<PermissionDecision, "allow">
  reason: string
}

/**
 * v0.41.0: Governance policy shape - subset of MetaGovernorPluginConfig that
 * the matchers care about. Defined here so this file has no dependency on
 * the full config schema.
 */
export interface GovernancePermissionPolicySubset {
  mode?: "allow" | "deny-on-match" | "ask-on-match"
  bashDenyPatterns?: string[]
  bashAskPatterns?: string[]
  editDenyPaths?: string[]
  editAskPaths?: string[]
  webfetchDenyHosts?: string[]
}

function matchAnyRegex(input: string, patterns: readonly string[]): string | null {
  for (const pattern of patterns) {
    try {
      if (new RegExp(pattern).test(input)) return pattern
    } catch {
      // Invalid regex - skip
    }
  }
  return null
}

function globToRegex(pattern: string): RegExp {
  // Strip leading "**/" so root-level files match directly.
  const cleaned = pattern.replace(/^\*\*\//, "")
  // Escape regex special chars, then convert globs:
  //   **  -> .*     (any chars including /)
  //    *  -> [^/]*  (any chars except /)
  const escaped = cleaned
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, ".*")
    .replace(/\*/g, "[^/]*")
  // Substring match (no anchors) so "**/.env" matches ".env" or "x/y/.env".
  return new RegExp(escaped)
}

function matchAnyGlob(filepath: string, patterns: readonly string[]): string | null {
  for (const pattern of patterns) {
    try {
      if (globToRegex(pattern).test(filepath)) return pattern
    } catch {
      // Skip invalid pattern
    }
  }
  return null
}

function matchHost(url: string, hostPatterns: readonly string[]): string | null {
  let host: string
  try {
    host = new URL(url).host
  } catch {
    return null
  }
  for (const pattern of hostPatterns) {
    if (host === pattern || host.endsWith("." + pattern) || host.includes(pattern)) {
      return pattern
    }
  }
  return null
}

/**
 * Evaluate bash permission: returns the FIRST matching rule (deny beats ask).
 * If no match: returns null - caller should treat as "allow" (no override).
 */
export function evaluateBashPolicy(
  command: string,
  policy: GovernancePermissionPolicySubset,
): PermissionMatchResult | null {
  const denyMatch = matchAnyRegex(command, policy.bashDenyPatterns ?? [])
  if (denyMatch !== null) {
    return {
      decision: "deny",
      reason: "bash command matches deny pattern \"" + denyMatch + "\"",
    }
  }
  const askMatch = matchAnyRegex(command, policy.bashAskPatterns ?? [])
  if (askMatch !== null) {
    return {
      decision: "ask",
      reason: "bash command matches ask pattern \"" + askMatch + "\"",
    }
  }
  return null
}

/**
 * Evaluate edit permission against file path patterns.
 */
export function evaluateEditPolicy(
  filepath: string,
  policy: GovernancePermissionPolicySubset,
): PermissionMatchResult | null {
  const denyMatch = matchAnyGlob(filepath, policy.editDenyPaths ?? [])
  if (denyMatch !== null) {
    return {
      decision: "deny",
      reason: "edit path matches deny pattern \"" + denyMatch + "\"",
    }
  }
  const askMatch = matchAnyGlob(filepath, policy.editAskPaths ?? [])
  if (askMatch !== null) {
    return {
      decision: "ask",
      reason: "edit path matches ask pattern \"" + askMatch + "\"",
    }
  }
  return null
}

/**
 * Evaluate webfetch permission against URL host patterns.
 */
export function evaluateWebfetchPolicy(
  url: string,
  policy: GovernancePermissionPolicySubset,
): PermissionMatchResult | null {
  const denyMatch = matchHost(url, policy.webfetchDenyHosts ?? [])
  if (denyMatch !== null) {
    return {
      decision: "deny",
      reason: "webfetch host matches deny pattern \"" + denyMatch + "\"",
    }
  }
  return null
}