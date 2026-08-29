/**
 * JSON Schema generator for omo-meta-governor.jsonc.
 *
 * Generates a JSON Schema (draft-07) from the MetaGovernorPluginConfig
 * interface definition. The schema is used for IDE autocompletion and
 * validation when editing the .jsonc config file.
 *
 * Single source of truth for the schema shape. The committed asset at
 * assets/omo-meta-governor.schema.json is regenerated from this file via
 * `bun build.ts` (which calls writeSchemaFile) and pinned by
 * src/generate-schema-sync.test.ts to prevent silent drift.
 */

export interface JsonSchema {
  $schema: string
  $id: string
  title: string
  description: string
  type: "object"
  properties: Record<string, JsonSchemaProperty>
  additionalProperties: boolean
  definitions?: Record<string, JsonSchemaProperty>
}

export interface JsonSchemaProperty {
  type?: string | string[]
  description?: string
  default?: unknown
  properties?: Record<string, JsonSchemaProperty>
  items?: JsonSchemaProperty
  additionalProperties?: boolean
  required?: string[]
  enum?: string[]
  oneOf?: JsonSchemaProperty[]
  anyOf?: JsonSchemaProperty[]
  $ref?: string
  minimum?: number
  maximum?: number
}

const ID_BASE = "https://raw.githubusercontent.com/herjarsa/omo-meta-governor/main"

/**
 * Generate the full JSON Schema for the omo-meta-governor.jsonc config file.
 *
 * Shape MUST mirror src/config.ts (MetaGovernorPluginConfig + loadOrchestratorConfig).
 * Any drift is caught by src/generate-schema-sync.test.ts (committed-asset sync).
 */
export function generateSchema(): JsonSchema {
  return {
    $schema: "http://json-schema.org/draft-07/schema#",
    $id: `${ID_BASE}/assets/omo-meta-governor.schema.json`,
    title: "omo-meta-governor",
    description: "Configuration schema for @herjarsa/omo-meta-governor — Self-judging agent orchestration layer for OpenCode.",
    type: "object",
    additionalProperties: false,
    properties: {
      $schema: { type: "string", description: "JSON Schema reference for IDE autocompletion." },
      enabled: { type: "boolean", description: "Master feature flag — must be true to run the orchestrator.", default: false },
      decision: {
        type: "object", description: "Decision handler configuration.", additionalProperties: false,
        properties: {
          maxHistoryPerSession: { type: "integer", description: "Maximum history entries per session before oldest are trimmed.", default: 50, minimum: 1 },
          forceContinueAfterStops: { type: "integer", description: "How many consecutive stops before forcing continue.", default: 3, minimum: 1 },
          warnMessageTemplate: { type: "string", description: "v0.18.0: custom warning message template. Supports {{action}}, {{score}}, {{sessionID}} placeholders." },
          escalateMessageTemplate: { type: "string", description: "v0.18.0: custom escalation message template. Supports {{action}}, {{score}}, {{sessionID}} placeholders." },
          stopMessageTemplate: { type: "string", description: "v0.18.0: custom stop message template. Supports {{action}}, {{score}}, {{sessionID}} placeholders." },
        },
      },
      memory: {
        type: "object", description: "Memory aggregator configuration.", additionalProperties: false,
        properties: {
          agentmemoryTimeoutMs: { type: "integer", description: "Timeout for agentmemory queries in milliseconds.", default: 2000, minimum: 100 },
          timeoutMs: { type: "integer", description: "v0.18.0: preferred name for agentmemoryTimeoutMs. Aliased for back-compat.", default: 2000, minimum: 100 },
          boulderStateTimeoutMs: { type: "integer", description: "Timeout for boulder-state queries in milliseconds.", default: 1000, minimum: 100 },
          query: { type: "string", description: "Natural-language query for memory recall.", default: "meta_governor_context" },
        },
      },
      tokenPredictor: {
        type: "object", description: "Token predictor configuration.", additionalProperties: false,
        properties: {
          compactBurnRateThreshold: { type: "integer", description: "Burn rate threshold (tokens/turn) above which to recommend compact-now.", default: 500, minimum: 0 },
          compactUsageThreshold: { type: "number", description: "Context usage ratio (0..1) above which to recommend compact-now.", default: 0.85, minimum: 0, maximum: 1 },
          switchModelUsageThreshold: { type: "number", description: "Context usage ratio above which to recommend switch-model.", default: 0.95, minimum: 0, maximum: 1 },
          delegateConsecutiveHighBurn: { type: "integer", description: "Max consecutive high-burn turns before recommending delegate.", default: 5, minimum: 1 },
        },
      },
      scoring: {
        type: "object", description: "Scoring engine configuration.", additionalProperties: false,
        properties: {
          continueThreshold: { type: "number", description: "Score >= this -> continue silently.", default: 0.3, minimum: 0, maximum: 1 },
          warnThreshold: { type: "number", description: "Score <= -warnThreshold -> warn.", default: 0.3, minimum: 0, maximum: 1 },
          escalateThreshold: { type: "number", description: "Score <= -escalateThreshold -> escalate.", default: 0.45, minimum: 0, maximum: 1 },
          stopThreshold: { type: "number", description: "Score <= -stopThreshold -> stop.", default: 0.55, minimum: 0, maximum: 1 },
          paralysisThreshold: { type: "number", description: "v0.18.0: when progress-detector sees no movement for N turns, score drops by paralysisThreshold.", default: 0.2, minimum: 0, maximum: 1 },
          defaultEscalationTarget: { type: "string", description: "v0.18.0: which agent receives escalation messages.", enum: ["oracle", "user"], default: "user" },
        },
      },
      closedLoop: {
        type: "object", description: "Closed-loop learning configuration.", additionalProperties: false,
        properties: {
          enabled: { type: "boolean", description: "Master switch for the closed-loop learning pipeline. v0.18.0: was silently dropped by loadOrchestratorConfig; now projected.", default: true },
          minSeverityToLearn: { type: "string", description: "v0.18.0: minimum decision severity that triggers lesson save.", enum: ["leve", "media", "grave"], default: "media" },
          maxLessonsPerSession: { type: "integer", description: "v0.18.0: hard cap on lessons per session. Was silently dropped pre-v0.18.0.", default: 20, minimum: 0 },
          saveDecisions: { type: "boolean", description: "Whether to save decision records.", default: true },
          saveLessons: { type: "boolean", description: "Whether to save lessons.", default: true },
        },
      },
      modelOverride: {
        type: "object", description: "Model override for MetaGovernor internal LLM usage.", additionalProperties: false,
        properties: {
          providerID: { type: "string", description: "Provider ID (e.g. 'openai', 'anthropic')." },
          modelID: { type: "string", description: "Model ID (e.g. 'gpt-4o-mini', 'claude-sonnet-4-20250514')." },
          modelLimit: { type: "integer", description: "Context window size for token predictor.", minimum: 1000 },
          temperature: { type: "number", description: "Sampling temperature. Default: 0.2.", default: 0.2, minimum: 0, maximum: 2 },
          topP: { type: "number", description: "Top-p nucleus sampling. Default: 1.", default: 1, minimum: 0, maximum: 1 },
          maxTokens: { type: "integer", description: "Max output tokens for internal reasoning.", default: 2048, minimum: 1 },
          reasoning: { type: "boolean", description: "Enable extended reasoning / thinking mode.", default: false },
          verbosity: { type: "string", description: "Verbosity level for internal logging.", enum: ["silent", "minimal", "verbose"], default: "minimal" },
        },
      },
      // v0.38.4 Option D: Oracle invocation frequency. Single user-facing knob;
      // `scoring.oracleFrequency` is derived internally to avoid dual-knob drift.
      // - "per-stop" (default): Oracle invoked at final-gate AND when action is
      //   "stop" (the brake). warn/escalate log only.
      // - "final-only": Oracle invoked ONLY at final-gate. Zero mid-work prompts.
      // - "off": Oracle never invoked automatically. Set oracleVerified manually.
      // The DONE final-gate is ALWAYS Oracle-verified regardless of this setting.
      oracle: {
        type: "object",
        description: "Oracle invocation frequency (Option D, v0.38.4). Controls when the plugin invokes Oracle for verification mid-work.",
        additionalProperties: false,
        properties: {
          frequency: {
            type: "string",
            enum: ["per-stop", "final-only", "off"],
            default: "per-stop",
            description: "per-stop: brake at stop + final-gate. final-only: only final-gate. off: never auto-invoke.",
          },
        },
      },
      intervention: {
        type: "object", description: "Intervention config for visible decision injection.", additionalProperties: false,
        properties: {
          mode: { type: "string", description: "How to inject: 'silent', 'message', or 'system'.", enum: ["silent", "message", "system"], default: "silent" },
          includeDecisionHistory: { type: "boolean", description: "Whether to include recent decision history.", default: true },
          maxHistoryMessages: { type: "integer", description: "Max history entries when includeDecisionHistory is true.", default: 5, minimum: 1 },
          minActionForMessage: { type: "string", description: "Minimum action: 'warn' (all non-continue), 'escalate', or 'stop'.", enum: ["warn", "escalate", "stop"], default: "stop" },
          persistToSession: { type: "boolean", description: "v0.19.0: when true (default), intervention messages are ALSO persisted to the session via session.prompt() so they appear in the OpenCode TUI and session DB. The messages.transform push alone reaches the model but is never persisted in OpenCode 1.18.x.", default: true },
          maxInterventionsPerSession: { type: "integer", description: "Hard cap on interventions per session before the plugin auto-disables intervention. v0.10.0: prevents infinite instruction loops.", default: 3, minimum: 1 },
          respectDoneSignal: { type: "boolean", description: "When true, the plugin stops injecting once the agent emits a terminal completion signal AND Oracle has verified the work.", default: true },
          phaseAwareDoneSignal: { type: "boolean", description: "v0.15.0: split per-phase hint from terminal signal. When true, <promise>PLAN-COMPLETE</promise> is the only terminal marker (DONE / PHASE-N-COMPLETE are per-phase hints).", default: false },
          compactionLoopGuard: {
            type: "object",
            description: "v0.31.1: defense against opencode #27924 (infinite overflow-compaction loop). Counter-trips a circuit breaker after N consecutive overflow compactions to break the loop.",
            additionalProperties: false,
            properties: {
              enabled: { type: "boolean", description: "v0.31.2: defense against opencode #27924 (infinite overflow-compaction loop). Default true (v0.31.2).", default: true },
              maxOverflowRecoveries: { type: "integer", description: "v0.31.2: consecutive overflow compactions tolerated before the guard trips. Default 1.", default: 1 },
            },
          },
        },
      },
      protocolEnforcement: {
        type: "object", description: "Sisyphus protocol enforcement config.", additionalProperties: false,
        properties: {
          enabled: { type: "boolean", description: "Master switch for protocol enforcement.", default: false },
          path: { type: "string", description: "Path to protocol markdown file." },
          injectIntoSystem: { type: "boolean", description: "Whether to inject protocol rules into the system prompt.", default: false },
          auditToolCalls: { type: "boolean", description: "Whether to audit tool calls for protocol violations.", default: false },
        },
      },
      skillPriming: {
        type: "object", description: "Skill priming config (v0.20.0, v0.33.1: skill-hub routing, v0.34.0: enforcement mode): proactive skill-selection nudge injected once per session.", additionalProperties: false,
        properties: {
          enabled: { type: "boolean", description: "Master switch for skill priming injection. v0.33.1: defaults to true so the skill workflow fires out of the box.", default: true },
          trigger: { type: "string", description: "When to inject: 'sessionStart' (first transform call) or 'firstImplement' (once implementation work begins).", enum: ["firstImplement", "sessionStart"], default: "firstImplement" },
          router: { type: "string", description: "Which skill system(s) the directive references. v0.33.1: 'aas' is deprecated (AAS MCP retired in v0.32.0) and aliased to 'registry'. 'registry' = skill-hub (omo_skill_find/get/add); 'superpowers' = external plugin; 'both' = registry + superpowers.", enum: ["registry", "superpowers", "both", "aas"], default: "registry" },
          enforceMode: { type: "string", description: "v0.34.0: enforcement mode. 'directive' (default) = opt-in nudge. 'block' = hard gate that prevents implementation tools (write/edit/apply_patch/...) from running until omo_skill_find has been called in the session.", enum: ["directive", "block"], default: "directive" },
        },
      },
      skillHub: {
        type: "object", description: "Skill hub config (v0.32.0): registry-backed catalog + hybrid search.", additionalProperties: false,
        properties: {
          enabled: { type: "boolean", description: "Master switch.", default: false },
          syncIntervalMs: { type: "integer", description: "ms between registry re-syncs.", default: 86400000 },
          bootstrapUrl: { type: "string", description: "Bulk bootstrap snapshot URL.", default: "https://skills-library.com/api/skills.json" },
          searchFallbackUrl: { type: "string", description: "Live search fallback endpoint.", default: "https://skills.sh/api/search" },
          downloadBaseUrl: { type: "string", description: "Skill content download base.", default: "https://skills.sh/api/download" },
          embedBaseUrl: { type: "string", description: "Local embeddings endpoint base.", default: "http://127.0.0.1:3114/v1" },
          embedModel: { type: "string", description: "Embedding model id.", default: "bge-m3" },
          minInstalls: { type: "integer", description: "Minimum installs threshold.", default: 0 },
          filterDuplicates: { type: "boolean", description: "Filter duplicate skills.", default: true },
          depsCheck: { type: "boolean", description: "Surface dependency warnings.", default: true },
          choreDir: { type: "string", description: "v0.35.0: chore skills directory (global, read-only from plugin perspective). Skills are extracted here on first run via SHA-256-idempotent bootstrap.", default: "~/.agents/skills" },
          autoMaterialize: { type: "boolean", description: "v0.35.0: write fetched hub SKILL.md to <cwd>/.agents/skills/<slug>/SKILL.md.", default: true },
        },
      },
      graphSync: {
        type: "object", description: "Graph synchronization (auto-init codegraph/graphify).", additionalProperties: false,
        properties: {
          enabled: { type: "boolean", description: "Enable auto-initialization of codegraph and graphify.", default: true },
          watch: { type: "boolean", description: "Enable watch mode (re-index on file changes).", default: false },
          autoInstall: { type: "boolean", description: "When true, install codegraph + graphify if missing. Default true.", default: true },
          installTimeoutMs: { type: "integer", description: "Max ms to wait for graphify/codegraph install before failing graph-sync init.", default: 120000, minimum: 1000 },
          killOrphanedOnInit: { type: "boolean", description: "When true, sweep orphaned graphify/codegraph processes left by previous crashed runs on graph-sync init.", default: true },
          reindexOnFetch: { type: "boolean", description: "v0.25.1: when true, fetch origin and reindex if local HEAD is behind. Default true.", default: true },
          fetchBranch: { type: "string", description: "v0.25.1: branch to fetch + compare against. Default 'main'.", default: "main" },
          autoUpgrade: { type: "boolean", description: "v0.26.0: auto-upgrade installed codegraph and graphify binaries on graph-sync init. Default true. Tiered probe + pip --upgrade flag fixes 6 silent-failure bugs from v0.24.x.", default: true },
          upgradeCachePath: { type: "string", description: "v0.26.0: filesystem path for the upgrade cache file (tracks latest-known codegraph/graphify versions to avoid re-fetching the npm/PyPI registry on every load)." },
          checkGraphifyNeedsUpdate: { type: "boolean", description: "v0.26.0: when true, run 'graphify check-update' after upgrade and emit a 'graphify-reextract-triggered' diagnostic code if the schema changed (signals a semantic re-extraction is pending).", default: true },
          addToGlobalGraph: { type: "boolean", description: "v0.27.0: opt-in. Register the project graph in the global graphify registry after install (so 'graphify global list' surfaces it). Default false.", default: false },
        },
      },
      postWave: {
        type: "object", description: "Post-wave workflow gate (v0.21.0): landing directives after Oracle-approved waves.", additionalProperties: false,
        properties: {
          enabled: { type: "boolean", description: "Master switch. Default false (derives from phaseAwareDoneSignal when unset).", default: false },
          repoMode: { type: "string", description: "Repository mode: auto | own | third-party.", enum: ["auto", "own", "third-party"], default: "auto" },
          aasToolPrefix: { type: "string", description: "Prefix for aas tool names when invoking third-party skills.", default: "aas" },
          ciTimeoutMs: { type: "integer", description: "Max ms to wait for CI after push before reporting failure.", default: 600000, minimum: 1000 },
          maxRetriesPerWave: { type: "integer", description: "Max retries per wave before escalating.", default: 1, minimum: 0 },
          reinjectCooldownMs: { type: "integer", description: "Min ms between directive re-injections for the same wave.", default: 60000, minimum: 0 },
          respectSilentMode: { type: "boolean", description: "When true, skip injection while silent mode is active.", default: false },
          ownRepoDirective: { type: "string", description: "Directive injected for own repos (push + CI)." },
          thirdPartyDirective: { type: "string", description: "Directive injected for third-party repos (PR/issue via aas skills)." },
        },
      },
      graphRetrieval: {
        type: "object", description: "v0.27.0: extended routing knobs for the graph retrieval layer.", additionalProperties: false,
        properties: {
          preferredTool: { type: "string", enum: ["auto", "codegraph", "graphify", "alternate"], description: "v0.25.0: routing preference. 'auto' prefers codegraph; 'alternate' hash-parity round-robin.", default: "auto" },
          preferLocalCodegraph: { type: "boolean", description: "v0.27.0: when true, prefer the locally-installed codegraph binary (node_modules/.bin/codegraph) over the npx-resolved one. Default false.", default: false },
          contextRouting: { type: "boolean", description: "v0.27.0: route omo_search queries to codegraph `context` instead of `explore`. Default false. context returns a focused code window; explore returns a conceptual explanation.", default: false },
        },
      },
      cliAnything: {
        type: "object", description: "v0.28.0: CLI-Anything hub auto-install + auto-upgrade. When enabled, the plugin ensures `cli-anything-hub` (pip) and `cli-hub-meta-skill` (npx skills) are installed and current.", additionalProperties: false,
        properties: {
          enabled: { type: "boolean", description: "v0.28.0: master toggle. Set to false to disable all CLI-Anything auto-install/auto-upgrade behavior. Default true.", default: true },
          autoInstall: { type: "boolean", description: "v0.28.0: when true, install cli-anything-hub and cli-hub-meta-skill if missing. Default true.", default: true },
          autoUpgrade: { type: "boolean", description: "v0.28.0: when true, run auto-upgrade probes per the cache TTL. Default true.", default: true },
          cachePath: { type: "string", description: "v0.28.0: filesystem path for the upgrade-cache file (tracks latest-known cli-anything-hub version to avoid re-querying PyPI on every load). Default ~/.config/opencode/omo-cli-anything-upgrade-check.json." },
          upgradeCheckTtlMs: { type: "number", description: "v0.28.0: minimum ms between PyPI queries for version checks. Default 24h." },
          cliHubBin: { type: "string", description: "v0.28.0: override the cli-hub binary path. Default 'cli-hub' (looked up in PATH).", default: "cli-hub" },
          skillsBin: { type: "string", description: "v0.28.0: override the skills invocation. Default 'npx skills' (the Vercel Labs skills CLI).", default: "npx skills" },
          installScope: { type: "string", enum: ["global", "project"], description: "v0.28.0: scope for the cli-hub-meta-skill install. 'global' (default) installs to ~/.claude/skills/, 'project' to ./.claude/skills/.", default: "global" },
        },
      },
      ciMonitor: {
        type: "object", description: "v0.25.0: CI monitor configuration. When enabled, the plugin polls GitHub Actions after `git push` and injects failure context into the agent session.", additionalProperties: false,
        properties: {
          enabled: { type: "boolean", description: "Master switch. When true, the plugin auto-triggers CI monitoring on git push.", default: false },
          workflow: { type: "string", description: "GitHub Actions workflow file name (e.g. 'ci.yml'). Used to filter runs.", default: "ci.yml" },
          pollIntervalMs: { type: "integer", description: "Initial poll interval in ms; subsequent polls use exponential backoff.", default: 5000, minimum: 1000 },
          maxWaitMs: { type: "integer", description: "Hard cap on total poll duration before giving up.", default: 600000, minimum: 5000 },
          failOnly: { type: "boolean", description: "When true, inject only failed-job context (logs); skip success messages.", default: true },
        },
      },
    },
    definitions: {
      verbosity: { type: "string", enum: ["silent", "minimal", "verbose"], description: "Verbosity level." },
      interventionMode: { type: "string", enum: ["silent", "message", "system"], description: "Intervention injection mode." },
      minAction: { type: "string", enum: ["warn", "escalate", "stop"], description: "Minimum action threshold." },
    },
  }
}

/**
 * Write the schema to a file.
 */
export async function writeSchemaFile(outputPath: string): Promise<void> {
  const schema = generateSchema()
  const { writeFile } = await import("node:fs/promises")
  await writeFile(outputPath, JSON.stringify(schema, null, 2) + "\n", "utf-8")
}