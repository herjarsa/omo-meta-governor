# omo-meta-governor Architecture

## Overview

`@herjarsa/omo-meta-governor` is an OpenCode plugin that acts as a self-judging agent orchestration layer. It observes tool executions, reads cross-system memory, scores session progress via weighted evidence, and dispatches decisions (continue / warn / escalate / stop) that are injected into the agent's context. The plugin registers **12 custom tools** the LLM can invoke for code search, memory, file/symbol lookup, and safety status.

## Plugin Integration

The plugin exports a default `PluginModule` from `src/index.ts`. OpenCode loads it and calls `createMetaGovernorPlugin()`, which returns a `Plugin` function. On invocation, the plugin captures the OpenCode server client and returns a `Hooks` object.

### Hook Lifecycle

| Hook | Phase | Purpose |
|------|-------|---------|
| `tool.execute.before` | Before any tool runs | Runs protocol audit on the tool call; if the agent is about to `grep`/`glob`, fires an async graph query and caches the result for later injection |
| `tool.execute.after` | After any tool runs | Updates per-session audit state (tool calls, files changed, memory usage, signals); runs the orchestrator pipeline; stores decisions for intervention; detects `git commit` for backup reindex |
| `experimental.chat.messages.transform` | Before messages reach the LLM | Injects synthetic user messages: plan reminders, PR bot feedback, protocol violations, and MetaGovernor decisions (when `mode: "message"`) |
| `experimental.chat.system.transform` | Before system prompt reaches the LLM | Appends protocol enforcement rules and cached graph context to the system prompt; injects decisions (when `mode: "system"`) |
| `experimental.session.compacting` | At context compaction time | Injects top-3 relevant lessons into the compaction context so learned patterns survive window resets |
| `experimental.compaction.autocontinue` | When auto-continue fires | Disables auto-continue when the task is verified done (DONE + Oracle, or intervention cap reached) |
| `experimental.compaction.loopGuard` | On overflow compaction | Trips circuit breaker after N consecutive overflow compactions (default 1) to break infinite compaction loops (opencode #27924) |
| `tool` | Custom tool registration | Registers 15 `omo_*` tools the LLM can invoke explicitly |

### Graceful Degradation

Every hook guards on `mergedConfig.enabled`. If disabled, `tool.execute.before`/`after` return immediately, and intervention hooks no-op. Even when enabled, each pipeline stage catches errors independently — a failing module produces a partial output with `skipped: true`, never crashing the host tool call.

## Core Pipeline (Orchestrator)

`src/orchestrator.ts` — `runMetaGovernor()` executes a pure pipeline on every `tool.execute.after`:

```
Input (MetaGovernorInput)
  → 1. Memory Read (aggregateRead)
  → 2. Token Prediction (predict)
  → 3. Scoring (score) → DecisionContext → ScoringResult
  → 4. Decision Dispatch (handleDecision)
  → 5. Closed-Loop Learning (observeAndLearn)
  → Output (MetaGovernorOutput)
```

### Stage Details

| Stage | Module | I/O | Key Contract |
|-------|--------|-----|-------------|
| Memory Read | `memory-aggregator.ts` | Reads from AgentMemory, MagicContext, BoulderState in parallel | `MemoryRead` — lessons, slots, tasks; graceful degrade per source |
| Token Prediction | `token-predictor.ts` | None (pure) | `TokenPredictorOutput` — burn rate, overflow prediction, recommendation |
| Scoring | `scoring-engine.ts` | None (pure) | `ScoringResult` — weighted evidence contributions, raw score ∈ [-1,+1], paralysis override |
| Decision | `decision-handler.ts` | None (pure) | `DecisionHandlerOutput` — action, message, history entry |
| Learning | `closed-loop-learning.ts` | Writes via `AgentmemoryWriteBackend` | `LearnFromOutcomeOutput` — lesson saved or null |

### Scoring Weights

| Evidence Source | Weight | Raw Score Range |
|----------------|--------|----------------|
| `progress-detector` | 0.30 | 0 or +0.6 (verified forward progress) |
| `deviation-detector` | 0.20 | 0 to -0.9 (severity-weighted) |
| `no-progress-detector` | 0.20 | 0 or -0.8 |
| `iteration-budget` | 0.15 | 0 to -0.8 (linear ramp) |
| `oracle-burn` | 0.10 | 0 to -0.6 (recent oracle issues) |
| `stop-advice` | 0.05 | 0 to -0.7 (lesson-recommended stop) |

### Score → Action Thresholds (defaults)

| Score Range | Action |
|-------------|--------|
| ≥ `continueThreshold` (0.05) | continue (silent) |
| ≤ -`warnThreshold` (0.3) | warn |
| ≤ -`escalateThreshold` (0.45) | escalate |
| ≤ -`stopThreshold` (0.55) | stop |

Thresholds are configurable via `scoring.{continueThreshold, warnThreshold, escalateThreshold, stopThreshold}`. Worst-case math (no oracle, no progress, 2 grave deviations, iteration at limit, stop-advice lessons) produces score ≈ -0.55 → `stop` action fires (Gap C fix).

Paralysis prevention: 3+ consecutive stops forces `continue` with a warning, regardless of score.

## Intervention System

When `intervention.mode !== "silent"`, decisions that meet the `minActionForMessage` threshold are stored in `src/decision-store.ts` (in-memory `Map<sessionID, DecisionHandlerOutput>`) and consumed by the transform hooks.

### Modes

| Mode | Mechanism | Hook |
|------|-----------|------|
| `silent` | Decision logged and stored in memory, never injected | — |
| `message` | Synthetic user message prepended to message list | `experimental.chat.messages.transform` |
| `system` | Guidance appended to system prompt | `experimental.chat.system.transform` |

### Rate Limiting and Termination

- `maxInterventionsPerSession` (default: 3) — hard cap per session; once reached, `interventionDisabled` latches to `true`.
- `respectDoneSignal` — when `true`, intervention stops after the agent emits a terminal completion signal AND Oracle has verified.
- `phaseAwareDoneSignal` (v0.15.0) — when `true`, only `<promise>PLAN-COMPLETE</promise>` is terminal. `<promise>DONE</promise>` and `<promise>PHASE-N-COMPLETE</promise>` are per-phase hints that do NOT latch intervention. Recommended for multi-phase plans.

### Additional Injections

- **Plan reminder** — on first intervention of a session, if no `PLAN.md` or `## Plan` section exists in `AGENTS.md`, injects a reminder to create one.
- **PR bot feedback** — captures failed check lines from `gh pr checks`/`gh pr view` output and injects them as actionable feedback.
- **Protocol violations** — accumulated violations from `tool.execute.before` audits are batched and injected as a single message.

## Skill Priming (v0.20.0)

Proactive skill-selection nudge. When enabled, the plugin injects **one** synthetic user message
(via `experimental.chat.messages.transform`) prompting the agent to select precise skills for the
current task before writing code — querying the **AAS skill catalog** (`aas search_skills` /
`get_skill` / `compose_stack`) and/or loading the task-appropriate **superpowers** skill
(`brainstorming`, `writing-plans`, `test-driven-development`, `systematic-debugging`,
`subagent-driven-development`) via the `skill` tool.

| Config | Default | Description |
|--------|---------|-------------|
| `skillPriming.enabled` | `false` | Master switch |
| `skillPriming.trigger` | `"firstImplement"` | `"sessionStart"` = first transform call of the session; `"firstImplement"` = once a write/edit-like tool appears |
| `skillPriming.router` | `"both"` | Which system(s) the directive references: `"aas"`, `"superpowers"`, `"both"` |

Design notes:
- **Independent of intervention mode** — the priming block runs before the
  `intervention.mode !== "message"` gate, so it works in `silent`/`system` modes too.
- **Once per session** — tracked via a per-factory `Set` (same pattern as the plan reminder).
- **Minimal context cost** — the directive explicitly forbids enumerating the full catalog; the
  AAS MCP is read-only and only consumes tokens when the agent actually queries it (avoids the
  past skill-index token bloat, ~205k tokens/session).
- **`firstImplement` does not depend on the audit state** — the audit state only exists when
  `protocolEnforcement.auditToolCalls` is enabled, so implementation tools are also tracked in an
  independent per-session `Set` populated by `tool.execute.after`.
- The message is synthetic-only (never persisted via `persistSessionMessage`); it is a nudge, not
  an intervention.

### Skills Resolution (added v0.35.0)
Three registries + one resolver + one materialization side effect + one
advisory reminder. See `docs/superpowers/specs/2026-08-26-skills-resolution-design.md`
for the full design.

| Component | Responsibility |
|---|---|
| `src/skills-fs.ts` | Frontmatter parser + fs scanner |
| `src/skills-bootstrap.ts` | Chore tarball extraction with idempotency |
| `src/skills-resolver.ts` | Unified `findSkill` + `searchSkills` |
| `src/skills-materialize.ts` | Hub skill write to project fs |
| `src/skills-tier3-reminder.ts` | Zero-results advisory |
| `src/skills-fs-watcher.ts` | Hot-reload of project-local skills |
## Protocol Enforcement

`src/protocol-enforcer.ts` — reads the Sisyphus protocol markdown from disk and enforces it.

- **`loadProtocol(path?)`** — reads the protocol file (default: `~/.config/opencode/sisyphus-mandatory/sisyphus-mandatory.md`).
- **`buildSystemInjection(text)`** — builds a condensed rules block injected into the system prompt via `system.transform`.
- **`auditToolCall(tool, args, context)`** — heuristic detection of protocol violations (no NLP). Checks: memory tools not used before grep, `@ts-ignore`/`as any` usage, empty catch blocks, etc.

Violations are queued per-session with a 5-minute TTL and injected on the next `messages.transform` call.

## Graph Integration

### Graph Sync (`graph-sync.ts`)

On first session load in a project:
1. Auto-installs codegraph (`npm i -D @colbymchenry/codegraph`) and graphify (`pip install graphifyy`) if missing.
2. Runs `codegraph init` + `graphify . --no-viz` to build initial indexes.
3. Runs `graphify hook install` to wire `post-commit` and `post-checkout` git hooks.
4. **v0.26.0: Auto-upgrade** installed codegraph + graphify binaries (see below).

On each `git commit`:
- **Primary path**: native git hook runs `graphify update` in background.
- **Backup path**: `tool.execute.after` detects `git commit` in bash commands and runs `codegraph sync -q [path]`.

#### Auto-Upgrade (v0.26.0)

`src/graph-sync.ts:runGraphSync` runs an auto-upgrade block at the end
of `initGraphSync` whenever `graphSync.autoUpgrade !== false`:

1. **Tiered version probe** — `getInstalledCodegraphVersion` tries
   `npx codegraph --version` → `node node_modules/.bin/codegraph
   --version`. `getInstalledGraphifyVersion` tries `graphify --version`
   → `python -m pip show graphifyy` → `python3 -m pip show graphifyy`.
2. **Latest-version fetch** — `resolveLatest()` reads from
   `upgradeCachePath` (default: `~/.omo-meta-governor/upgrade-cache.json`)
   and falls back to `npm view @colbymchenry/codegraph version` /
   `pip index versions graphifyy`.
3. **Compare + decide** — `shouldUpgrade(installed, latest, cache)`
   returns true when installed < latest AND cache differs.
4. **Install with --upgrade flag** — `installCodegraph` / `installGraphify`
   now pass `--upgrade` to pip/uv so the binary actually upgrades
   (the most visible v0.24.x bug: `pip install` without `--upgrade`
   returned 0 with "Requirement already satisfied" but did NOT upgrade).
5. **Cache write-once** — cache is written exactly once at the end of
   the block (was being fetched 3× per run before the fix).
6. **Post-upgrade probe** — verifies the new binary is actually
   installed; on failure emits `codegraph-upgrade-broken` diagnostic.
7. **Graphify semantic check** — when `checkGraphifyNeedsUpdate: true`,
   runs `graphify check-update` and emits `graphify-reextract-triggered`
   if the schema changed (signals semantic re-extraction is pending).

New config fields: `graphSync.autoUpgrade`, `graphSync.upgradeCachePath`,
`graphSync.checkGraphifyNeedsUpdate`.

New `GraphSyncCode` union members: `codegraph-upgrade-broken`,
`graphify-reextract-triggered`, `upgrade-cache-written`.

### Process Zombie Safeguards (`proc-guard.ts`, v0.22.0)

`src/proc-guard.ts` guarantees every subprocess the plugin spawns dies after
use — on success, error, and timeout — including its descendant tree:
- `killProcessTree(pid)` — win32 `taskkill /pid <pid> /T /F`; POSIX group SIGKILL.
- `runGuarded` / `runGuardedSync` — spawn wrappers with kill-tree on timeout;
  used by `spawnWithTimeout` (graph-retrieval), installs, hook install, and
  reindex triggers (graph-sync). The `runner` DI seam is preserved for hermetic tests.
- `killOrphanedToolProcesses()` — swept once at graph-sync init when
  `graphSync.killOrphanedOnInit` (default `true`) is set.
Watch processes carry an `OMO_MG_WATCH`/`OMO_MG_SPAWN` marker so the sweep can
identify them via CommandLine.

### Graph Retrieval (`graph-retrieval.ts`)

Invokes codegraph or graphify CLI and caches results per-session (5min TTL, 10 entries LRU).

- When the agent runs `grep`/`glob`, `tool.execute.before` fires an async graph query.
- `system.transform` injects the cached result as reference material in the system prompt.

### CodeGraph Tools (`codegraph-tools.ts`)

Wraps codegraph sub-commands for the custom tools:
- `codegraph node <symbol>` — source + callers
- `codegraph impact <symbol>` — full impact analysis

## 12 Custom Tools

Registered via the `tool` hook. Available even when governance is disabled.

### Code Search & Navigation

| Tool | Backend | Purpose |
|------|---------|---------|
| `omo_search` | `graph-retrieval.ts` | Semantic search via codegraph/graphify |
| `omo_find` | `codegraph-tools.ts` | Exact symbol lookup (definition + callers) |
| `omo_impact` | `codegraph-tools.ts` | Impact analysis: callers, transitive callers, tests, docs |
| `omo_path` | `graphify` via `promptAgent` | Shortest conceptual path between two concepts |
| `omo_explain` | `graphify` via `promptAgent` | Plain-language explanation of a concept |

### Lesson & Memory

| Tool | Backend | Purpose |
|------|---------|---------|
| `omo_recall` | `sqlite-backend.ts` | Search past lessons via local SQLite FTS5 |
| `omo_recall_mcp` | `promptAgent` → AgentMemory MCP | Cross-session memory search |
| `omo_remember` | `promptAgent` → AgentMemory MCP | Save a fact/observation |

### File & Symbol Lookup (v0.26.0)

| Tool | Backend | Purpose |
|------|---------|---------|
| `omo_files` | `graph-retrieval.ts` | List files indexed by codegraph or graphify |
| `omo_callers` | `codegraph-tools.ts` | List all call sites of a symbol via `codegraph callers` |
| `omo_node` | `codegraph-tools.ts` | Get source + direct callers of a symbol via `codegraph node` |

### Safety & Status

| Tool | Backend | Purpose |
|------|---------|---------|
| `omo_health` | `metrics.ts` + `health.ts` | Show plugin runtime status, metrics, errors |

### Session Bridge Pattern

Tools that bridge to MCP servers (AgentMemory) use `src/session-bridge.ts`. The OpenCode SDK does not expose direct MCP tool invocation from plugins, so `promptAgent()` sends a follow-up message to the session telling the LLM to call the right MCP tool with the right args. This adds ~1–2s latency but works without SDK changes.

## Persistence

### SQLite Backend (`sqlite-backend.ts`)

- Database: `~/.omo-meta-governor/meta-governor.db`
- Runtime: `sqlite-driver.ts` selects the engine at runtime — `bun:sqlite` under Bun, `node:sqlite` (DatabaseSync) under Node ≥ 23.4 — via `createRequire`, keeping dist bundles loadable on both hosts
- Schema: `entries` table (lessons + memories + crystals) with FTS5 virtual table for natural-language search; `boulder_tasks` table for task state; `_meta` KV table for schema versioning
- WAL mode + `synchronous=NORMAL` + `busy_timeout` for concurrent safety
- Prepared statements cached at init

### Decision Store (`decision-store.ts`)

In-memory `Map<sessionID, DecisionHandlerOutput>`. Stores decisions from `tool.execute.after` for consumption by the transform hooks. Scoped per-session — `takeDecision(sessionID)` retrieves and removes; `takeAnyDecision()` is deprecated (v0.16.0).

## Observability

### Metrics (`metrics.ts`)

Module-level `MetricsCollector` with 17 typed `MetricEvent` counters: `decisions_taken`, `interventions_delivered`, `orchestrator_runs`, `orchestrator_errors`, `protocol_violations_detected`, etc. Per-session and global aggregation.

### Health File (`health.ts`)

Atomic writes (write to `.tmp`, then rename) to `~/.config/opencode/meta-governor-health.json`. Contains version, uptime, metrics snapshot, log file stats, and current session info. The `omo_health` tool reads this directly.

### File Logger (`file-logger.ts`)

JSONL structured logs at `~/.config/opencode/meta-governor.log`. Size-based rotation (10MB max, 5 rotated files). Automatic secret redaction (JWT tokens, API keys, GitHub PATs, Bearer tokens) via regex patterns before writing.

## Audit State

Per-session state tracked by `AuditStateCache` (`audit-state-cache.ts`) — a TTL+LRU bounded cache (100 entries, 1h TTL). Fields include:

- `memoryToolsUsed` — which memory tools have been called
- `oracleInvoked` — whether Oracle has verified this session
- `filesChanged` — count of write/edit operations
- `taskDoneSignal` / `phaseCompleteSignal` / `planCompleteSignal` — completion signal tracking
- `interventionCount` / `interventionDisabled` — intervention rate limiting
- `recentToolCalls` / `recentWriteContents` — rolling window for pattern detection

## CI Monitor (v0.25.0)

`src/ci-monitor.ts` wires `git push` detection in `tool.execute.after`:

1. Detect `git push` in bash commands.
2. Poll the GitHub Actions API for the resulting run (5s initial delay,
   exponential backoff).
3. On failure, inject a synthetic message with the failed logs into the
   agent's context via `experimental.chat.messages.transform` so it can
   fix and retry.

Configuration via `meta_governor.ciMonitor` (disabled by default — opt-in
feature).

## Configuration

### Config Hierarchy (closer wins)

1. CLI inline options (highest priority)
2. Project config: `.opencode/omo-meta-governor.jsonc`
3. User config: `~/.config/opencode/omo-meta-governor.jsonc`
4. Module defaults (lowest priority)

JSONC files support comments and trailing commas (`src/config-file.ts` strips them before parsing).

### Key Config Sections

| Section | Purpose |
|---------|---------|
| `enabled` | Master switch for governance pipeline |
| `intervention` | Mode, thresholds, rate limits, done-signal behavior |
| `protocolEnforcement` | Protocol path, system injection, tool audit |
| `graphSync` | Auto-init, watch mode, auto-upgrade |
| `scoring` | Score thresholds, paralysis threshold |
| `tokenPredictor` | Burn rate thresholds, window size |
| `closedLoop` | Lesson persistence, severity thresholds |
| `modelOverride` | Provider/model for internal LLM usage |

## Build

- Entry: `build.ts` — runs via `bun build.ts`
- Bundles `src/index.ts` → `dist/index.js` (ESM, minified, sourcemaps)
- Emits TypeScript declarations → `dist/index.d.ts`
- Generates JSON Schema → `assets/omo-meta-governor.schema.json`

## Testing

- Test runner: `bun test` (configured in `package.json`)
- Test files: co-located with source as `*.test.ts` (excluded from build via `tsconfig.json`)
- E2E and integration tests verify full pipeline behavior
