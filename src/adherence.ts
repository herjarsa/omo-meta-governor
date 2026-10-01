/**
 * Adherence tracking — detects when the agent IGNORES an already-injected
 * directive (same rule violated again after the injection was drained).
 *
 * Why this exists: protocol violations are injected into the agent context
 * (system.transform drain, FASE 11 11e), but nothing measured whether the
 * agent actually complied afterwards. A repeat violation of the same rule
 * AFTER the agent saw the directive is evidence of non-adherence, not of a
 * missing directive — so it is counted separately (`directives_ignored`)
 * instead of re-injecting louder each time.
 *
 * Lifecycle (per session):
 *   1. tool.execute.before detects violation of rule R.
 *   2. If R was already injected (drained) in this session → reincidencia:
 *      `directives_ignored` + `adherence_ignored` log. Never escalates by
 *      itself for leve/media (counting only — explicit below).
 *   3. system.transform drains pendingViolations → each distinct rule R in
 *      the drained items is recorded via `recordInjection` (injected = the
 *      agent saw it; detection alone does NOT mark — the agent may never
 *      have seen an undrained queue).
 *   4. Scoring: ONLY grave reincidence with repeatCount >= 2 (third strike
 *      counting the original) floors the decision to `stop`. The
 *      stop → paralysis → continue loop stays supreme: a persistent false
 *      positive still resolves via paralysisOverride forcing continue after
 *      N consecutive stops, so adherence can never deadlock a session.
 *
 * Severity policy (explicit):
 *   - leve / media reincidence: counted in `directives_ignored`, NEVER
 *     escalates on its own. See `adherenceFloor` — it returns null for
 *     non-grave severities unconditionally.
 *   - grave reincidence: counted; escalates to `stop` ONLY at repeatCount
 *     >= ADHERENCE_STOP_REPEAT_THRESHOLD (2). Below that, the Wave B grave
 *     floor (continue/warn → escalate) still applies as before.
 *
 * All helpers here are pure (no I/O, no Date.now, no globals) so they are
 * unit-testable without the plugin factory.
 */

/** Rule -> times the rule's directive was drained (seen by the agent). */
export type InjectedRules = Record<string, number>;

/**
 * How many times a rule's directive was already injected when a new
 * violation arrives. repeatCount >= ADHERENCE_STOP_REPEAT_THRESHOLD means
 * the third strike (original + 2 repeats).
 */
export const ADHERENCE_STOP_REPEAT_THRESHOLD = 2;

/** Cap of distinct rules tracked per session (bounds per-session memory). */
export const ADHERENCE_MAX_RULES = 50;

/**
 * Record that rule `rule` was injected (drained into agent context).
 * Returns a NEW record (input is not mutated). When the record already
 * holds ADHERENCE_MAX_RULES distinct rules, the new rule is dropped so a
 * noisy session cannot grow memory unboundedly.
 */
export function recordInjection(
  rules: Readonly<InjectedRules>,
  rule: string,
): InjectedRules {
  const trimmed = rule.trim();
  if (trimmed.length === 0) return { ...rules };
  if (Object.prototype.hasOwnProperty.call(rules, trimmed)) {
    return { ...rules, [trimmed]: rules[trimmed]! + 1 };
  }
  if (Object.keys(rules).length >= ADHERENCE_MAX_RULES) return { ...rules };
  return { ...rules, [trimmed]: 1 };
}

/**
 * How many times `rule` was already injected in this session (0 = never —
 * the current violation is the first occurrence, NOT a reincidencia).
 */
export function countRepeat(
  rules: Readonly<InjectedRules>,
  rule: string,
): number {
  return rules[rule] ?? 0;
}

/**
 * Adherence escalation floor. Returns "stop" ONLY for grave reincidence at
 * or above the repeat threshold. leve/media ALWAYS return null (counted,
 * never escalated — see module docstring). Unknown severities return null.
 */
export function adherenceFloor(
  severity: string,
  repeatCount: number,
): "stop" | null {
  if (severity !== "grave") return null;
  if (!Number.isFinite(repeatCount) || repeatCount < ADHERENCE_STOP_REPEAT_THRESHOLD) {
    return null;
  }
  return "stop";
}

/**
 * Extract distinct rule names from drained violation entry strings.
 * Entries are formatted as `[SEVERITY] rule: detail` (see plugin.ts queue
 * site). Returns distinct rules in first-seen order; unparseable entries
 * are skipped (never throw — drain is best-effort).
 */
export function parseInjectedRules(items: readonly string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of items) {
    const m = /^\[[^\]]+\]\s+([^:]+):/.exec(item);
    if (!m) continue;
    const rule = m[1]!.trim();
    if (rule.length === 0 || seen.has(rule)) continue;
    seen.add(rule);
    out.push(rule);
  }
  return out;
}
