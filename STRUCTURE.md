# Codebase Structure

## Directory Layout

```
omo-meta-governor/
├── .codegraph/              # CodeGraph index (auto-generated)
├── .cortexkit/              # CortexKit workspace data
├── .github/workflows/       # CI/CD pipelines
├── .omo/                    # OpenCode session continuations
│   ├── run-continuation/
│   └── ulw-research/
├── assets/                  # Generated artifacts
│   └── omo-meta-governor.schema.json
├── dist/                    # Build output (ESM bundle + declarations)
├── graphify-out/            # Graphify knowledge graph (auto-generated)
├── node_modules/            # Dependencies
├── src/                     # All source code (flat, no subdirectories)
├── ARCHITECTURE.md          # Architecture documentation
├── STRUCTURE.md             # This file
├── CHANGELOG.md             # Release history (Keep a Changelog format)
├── README.md                # Package README with usage docs
├── build.ts                 # Build script (bun)
├── bun.lock                 # Bun lockfile
├── package.json             # Package manifest
├── package-lock.json        # npm lockfile (legacy)
└── tsconfig.json            # TypeScript configuration
```

## Source Files (`src/`)

All source files live flat in `src/` — no subdirectories. Files are organized by domain responsibility.

### Core Pipeline

| File | Purpose |
|------|---------|
| `index.ts` | Plugin entry point. Default-exports `PluginModule`, re-exports all public APIs |
| `plugin.ts` | Plugin factory. Wires all hooks (`tool.execute.before/after`, `messages.transform`, `system.transform`, `session.compacting`, `compaction.autocontinue`) and registers 9 custom tools |
| `orchestrator.ts` | Pipeline runner: memory → predict → score → decide → learn |
| `types.ts` | All type contracts (DecisionContext, Decision, Evidence, MemoryRead, TokenPrediction, ScoringConfig, etc.) |
| `config.ts` | Config schema (`MetaGovernorPluginConfig`) and `loadOrchestratorConfig()` projection |
| `config-file.ts` | JSONC config file loader with 3-layer priority (CLI > project > user > defaults) |

### Pipeline Modules

| File | Purpose |
|------|---------|
| `memory-aggregator.ts` | Parallel reads from AgentMemory, MagicContext, BoulderState with per-source timeouts |
| `token-predictor.ts` | Token burn rate calculation and overflow prediction |
| `scoring-engine.ts` | Weighted evidence scoring → score ∈ [-1,+1] → action mapping |
| `decision-handler.ts` | Dispatch decisions to actions; history tracking; paralysis prevention |
| `closed-loop-learning.ts` | Decide whether to persist a lesson or decision record after each cycle |
| `post-repair-recorder.ts` | Record recovery outcomes from error-handling hooks |

### Storage & Retrieval

| File | Purpose |
|------|---------|
| `sqlite-backend.ts` | SQLite backend (via sqlite-driver) for lessons/memories/crystals + FTS5 search |
| `sqlite-driver.ts` | Runtime-selectable SQLite engine — `bun:sqlite` under Bun, `node:sqlite` under Node ≥23.4 — resolved via createRequire so dist bundles boot on both hosts |
| `decision-store.ts` | In-memory Map for intervention decisions (session-scoped) |
| `audit-state-cache.ts` | TTL+LRU bounded cache for per-session audit state |
| `graph-retrieval.ts` | Invoke codegraph/graphify CLI, cache results per-session |
| `graph-sync.ts` | Auto-initialize codegraph/graphify; git hook wiring; background reindex |

### External Integration

| File | Purpose |
|------|---------|
| `session-bridge.ts` | Bridge to MCP tools via `session.prompt()` (AgentMemory) |
| `mcp-client.ts` | Wrapper over OpenCode server API for direct MCP tool invocation |
| `codegraph-tools.ts` | High-level wrappers for codegraph sub-commands (node, impact, files) |
| `protocol-enforcer.ts` | Load Sisyphus protocol; build system injection; audit tool calls for violations |
| `custom-tools.ts` | All 12 `omo_*` tool definitions (Zod-validated args, graceful error handling) |

### Skills Resolution (v0.35.0)
| File | Purpose |
|------|---------|
| `skills-fs.ts` | Frontmatter parser + fs scanner for project and chore dirs |
| `skills-bundled.ts` | Bundled skills registry (slug ↔ source) for bootstrap |
| `skills-bootstrap.ts` | Chore tarball extraction with SHA-256 idempotency |
| `skills-resolver.ts` | Unified `findSkill` + `searchSkills` (3-tier precedence) |
| `skills-materialize.ts` | Hub skill write to `<cwd>/.agents/skills/<slug>/SKILL.md` |
| `skills-tier3-reminder.ts` | Zero-results advisory → system reminder |
| `skills-fs-watcher.ts` | chokidar watcher on `<cwd>/.agents/skills/` |
### Observability

| File | Purpose |
|------|---------|
| `metrics.ts` | Typed event counters (17 MetricEvent types), per-session + global aggregation |
| `health.ts` | Atomic JSON health file at `~/.config/opencode/meta-governor-health.json` |
| `file-logger.ts` | JSONL structured logging with size-based rotation and secret redaction |

### Utilities

| File | Purpose |
|------|---------|
| `generate-schema.ts` | JSON Schema generator for `omo-meta-governor.jsonc` config |
| `proc-guard.ts` | Process-zombie safeguards: kill-tree (taskkill /T /F), guarded spawn, orphan sweep |

### Test Files

| File | Tests |
|------|-------|
| `types.test.ts` | Type contract validation |
| `config.test.ts` | Config loading and defaults |
| `config-file.test.ts` | JSONC parsing, config file resolution |
| `orchestrator.test.ts` | Full pipeline integration |
| `scoring-engine.test.ts` | Score computation, threshold mapping, paralysis |
| `decision-handler.test.ts` | Decision dispatch, history, message templates |
| `closed-loop-learning.test.ts` | Lesson persistence logic |
| `token-predictor.test.ts` | Burn rate, overflow prediction, recommendations |
| `memory-aggregator.test.ts` | Parallel reads, graceful degradation |
| `sqlite-backend.test.ts` | SQLite CRUD, FTS5 search, schema migration |
| `decision-store.test.ts` | Store/take/has decisions |
| `graph-retrieval.test.ts` | CLI invocation, caching, timeouts |
| `graph-sync.test.ts` | Auto-init, git hook detection |
| `custom-tools.test.ts` | Tool registration, arg validation |
| `health.test.ts` | Health file read/write |
| `file-logger.test.ts` | JSONL logging, rotation, redaction |
| `metrics.test.ts` | Counter increments, snapshots |
| `protocol-enforcer.test.ts` | Protocol loading, system injection, audit detection |
| `mcp-client.test.ts` | MCP tool invocation, timeouts |
| `session-bridge.test.ts` | Session bridge prompt, client detection |
| `audit-state-cache.test.ts` | TTL expiration, LRU eviction |
| `post-repair-recorder.test.ts` | Recovery outcome recording |
| `generate-schema.test.ts` | Schema generation correctness |
| `intervention-fix.test.ts` | Intervention rate limiting fixes |
| `graphsink-fix.test.ts` | Graph sink error handling fixes |
| `upgrade-fix.test.ts` | Auto-upgrade logic fixes (v0.23.1) |
| `upgrade-autofix.test.ts` | **v0.26.0** — auto-upgrade regression tests (AUT-1..AUT-7): tiered probe, pip `--upgrade`, graphify check-update, cache write-once |
| `session-bridge-iso.test.ts` | Session bridge isolation tests |
| `multiphase-gap.test.ts` | Multi-phase plan signal detection |
| `e2e.test.ts` | End-to-end plugin lifecycle |
| `integration.test.ts` | Cross-module integration |

## Key File Locations

**Entry Point:** `src/index.ts` — Default-exports `PluginModule` that registers `createMetaGovernorPlugin()`

**Plugin Factory:** `src/plugin.ts` — `createMetaGovernorPlugin(config, deps)` → `Plugin` → `Hooks`

**Pipeline:** `src/orchestrator.ts` — `runMetaGovernor(input)` → `MetaGovernorOutput`

**Configuration:** `src/config.ts` — `loadOrchestratorConfig(pluginConfig)` → `OrchestratorConfig`

**Types:** `src/types.ts` — All interfaces and union types (no logic, no I/O)

**Build:** `build.ts` — Bun bundler script; `bun build.ts` → `dist/`

**Tests:** `src/*.test.ts` — Co-located with source; run via `bun test`

**Persistence:** `~/.omo-meta-governor/meta-governor.db` — SQLite database (auto-created)

**Health:** `~/.config/opencode/meta-governor-health.json` — Runtime status JSON

**Logs:** `~/.config/opencode/meta-governor.log` — JSONL structured logs

**Config (user):** `~/.config/opencode/omo-meta-governor.jsonc` — User-level config

**Config (project):** `.opencode/omo-meta-governor.jsonc` — Project-level config

**Protocol:** `~/.config/opencode/sisyphus-mandatory/sisyphus-mandatory.md` — Sisyphus protocol

## Naming Conventions

**Files:** kebab-case matching domain responsibility (`scoring-engine.ts`, `decision-handler.ts`, `sqlite-backend.ts`). Test files append `.test.ts`.

**Types:** PascalCase interfaces with descriptive suffixes (`DecisionContext`, `MetaGovernorInput`, `ScoringResult`, `TokenPredictorOutput`).

**Functions:** camelCase. Module-level factory functions use `default` prefix for config defaults (`defaultScoringConfig`, `defaultDecisionHandlerConfig`). Builder functions use `build` prefix (`buildOmoSearchTool`, `buildSystemInjection`).

**Constants:** SCREAMING_SNAKE_CASE for module-level constants (`DEFAULT_WEIGHTS`, `DEFAULT_PROTOCOL_PATH`, `ACTION_SEVERITY`).

**Tools:** Prefixed `omo_` followed by verb/noun (`omo_search`, `omo_recall`, `omo_health`).

## Where to Add New Code

**New pipeline module:** `src/[module-name].ts` — follow the pure-function pattern (no I/O, DI backends via function params). Add types to `src/types.ts`. Wire into `src/orchestrator.ts`.

**New custom tool:** `src/custom-tools.ts` — add a `buildOmo[Name]Tool(deps)` function following the existing pattern (Zod schema via `tool.schema`, graceful error returns). Register in `src/plugin.ts` in the `tool:` hook.

**New hook:** Add the hook implementation in `src/plugin.ts` inside the `return { ... }` block. Use the existing patterns: guard on `mergedConfig.enabled`, scope to session via `sessionID`, catch errors silently.

**New backend integration:** Create a new `src/[backend-name].ts` with a DI interface (like `AgentmemoryBackend` in `memory-aggregator.ts`). Inject it via the orchestrator config or `MetaGovernorPluginDeps`.

**New metric event:** Add the event name to `MetricEvent` union in `src/metrics.ts`. Increment it via `metricsCollector.increment("event_name")`.

**New config field:** Add to `MetaGovernorPluginConfig` in `src/config.ts`. Project it with defaults in `loadOrchestratorConfig()`. Add types to `src/types.ts` if needed.

**Tests:** Co-locate with source as `src/[module].test.ts`. Use `bun test` runner. Follow the existing patterns: DI injection for isolation, no filesystem side effects in unit tests.

**Schema:** Update the JSON Schema generator in `src/generate-schema.ts` when adding new config fields.
