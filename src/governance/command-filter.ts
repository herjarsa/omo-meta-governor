/**
 * v0.41.0: command.execute.before hook handler.
 *
 * Blocks destructive shell commands (the `!`-prefixed palette). When enabled,
 * every command is checked against the denyPatterns list (regex). On match,
 * the handler throws — OpenCode surfaces the error to the agent.
 *
 * The optional replacementPrefix is appended as a warning text part; it is
 * informative only (does not block).
 */
import type { MetricsCollector } from "../metrics";

export interface GovernanceCommandFilterPolicy {
  readonly enabled?: boolean;
  readonly denyPatterns?: readonly string[];
  readonly replacementPrefix?: string;
}

export interface CommandInput {
  command: string;
  sessionID: string;
  arguments: string;
}

export interface CommandOutput {
  parts: Array<{ type: string; text: string; synthetic?: boolean }>;
}

/**
 * v0.41.0: Handle a command.execute.before invocation.
 * - If not enabled or no patterns: pass through.
 * - If a deny pattern matches: increment counter, throw (blocks execution).
 */
export async function handleCommandFilter(
  input: CommandInput,
  _output: CommandOutput,
  policy: GovernanceCommandFilterPolicy,
  metrics: MetricsCollector,
): Promise<void> {
  if (!policy.enabled) return;
  if (policy.denyPatterns?.length) {
    for (const pattern of policy.denyPatterns) {
      try {
        if (new RegExp(pattern).test(input.command)) {
          metrics.inc("governance_commands_blocked");
          throw new Error(
            "[meta-governor] blocked command matching pattern \"" + pattern + "\"",
          );
        }
      } catch (err) {
        // Invalid regex in config is already a governance error — let it through
        // but log it. Don't block the command on invalid-pattern errors.
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes("blocked command matching")) throw err;
      }
    }
  }

  if (policy.replacementPrefix) {
    _output.parts.push({
      type: "text",
      text: policy.replacementPrefix + " executing: " + input.command,
      synthetic: true,
    });
  }
}