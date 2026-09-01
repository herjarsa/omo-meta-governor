/**
 * v0.41.0: tool.definition hook handler.
 *
 * Routes tool definition output through the governance policy. When enabled,
 * the handler can hide specific tools or suffix every tool description with a
 * governance marker. Parameter description overrides are per-tool and per-param.
 *
 * SAFETY: when policy.enabled is falsy, this is a pure pass-through.
 */
import type { MetricsCollector } from "../metrics";

export interface GovernanceToolRewritePolicy {
  readonly enabled?: boolean;
  readonly descriptionSuffix?: string;
  readonly hideToolIDs?: readonly string[];
  readonly parameterOverrides?: Record<string, Record<string, string>>;
}

export interface ToolDefinitionInput {
  toolID: string;
}

export interface ToolDefinitionOutput {
  description: string;
  parameters: { properties?: Record<string, { description?: string;[k: string]: unknown }> };
}

/**
 * v0.41.0: Handle a tool.definition invocation.
 * - If not enabled: pass through.
 * - If tool is in hideToolIDs: set description to empty string (hidden from LLM).
 * - Otherwise: append descriptionSuffix if set, and apply parameterOverrides.
 */
export async function handleToolDefinition(
  input: ToolDefinitionInput,
  output: ToolDefinitionOutput,
  policy: GovernanceToolRewritePolicy,
  metrics: MetricsCollector,
): Promise<void> {
  if (!policy.enabled) return;

  if (policy.hideToolIDs?.includes(input.toolID)) {
    output.description = "";
    metrics.inc("governance_tools_hidden");
    return;
  }

  if (policy.descriptionSuffix) {
    output.description = (output.description ?? "") + policy.descriptionSuffix;
    metrics.inc("governance_tools_rewritten");
  }

  const overrides = policy.parameterOverrides?.[input.toolID];
  if (!overrides || !output.parameters?.properties) return;

  for (const [key, desc] of Object.entries(overrides)) {
    if (output.parameters.properties[key]) {
      output.parameters.properties[key].description = desc;
    }
  }
}