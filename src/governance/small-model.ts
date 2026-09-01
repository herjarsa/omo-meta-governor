/**
 * v0.41.0: experimental.provider.small_model hook handler — subagent cost control.
 *
 * When enabled, the plugin overrides which model OpenCode uses for the
 * cheap/fast path (TaskTool/Oracle subagents). The provider hook receives the
 * provider context with the provider's bundled model list; if the configured
 * modelID exists in that list, the handler replaces output.model so OpenCode
 * will schedule the subagent on the cheaper model.
 *
 * Graceful degradation: the handler is a pure no-op if the policy is empty
 * or the model cannot be found — OpenCode keeps its default choice.
 */
export interface GovernanceSmallModelPolicy {
  readonly enabled?: boolean;
  readonly modelID?: string;
  readonly providerID?: string;
}

export interface SmallModelInput {
  provider: {
    models?: Record<string, unknown>;
    [k: string]: unknown;
  };
}

export interface SmallModelOutput {
  model?: { id?: string; providerID?: string;[k: string]: unknown };
}

/**
 * v0.41.0: Handle a provider.small_model invocation.
 * - If not enabled or modelID/providerID missing: pass through.
 * - Finds the configured model in the provider's model list and assigns it.
 */
export async function handleSmallModel(
  input: SmallModelInput,
  output: SmallModelOutput,
  policy: GovernanceSmallModelPolicy,
): Promise<void> {
  if (!policy.enabled) return;
  if (!policy.modelID || !policy.providerID) return;

  const models = input.provider.models ?? {};
  const found = Object.values(models).find(
    (m) => typeof m === "object" && m !== null && (m as { id?: string }).id === policy.modelID,
  ) as { id?: string;[k: string]: unknown } | undefined;

  if (found) {
    output.model = found;
  }
}