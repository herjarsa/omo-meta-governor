# @herjarsa/omo-meta-governor

Self-judging agent orchestration layer for OpenCode. Observes tool executions,
reads session state, scores progress, and dispatches decisions. Includes **15 custom tools**
that the agent can invoke across CodeGraph, Graphify, AFT, AgentMemory, Magic Context, and SQLite.

## Install

```bash
npm install @herjarsa/omo-meta-governor
```

## Usage

Add as a plugin in your OpenCode config:

```jsonc
{
  "plugins": ["@herjarsa/omo-meta-governor"]
}
```

The 15 custom tools register automatically (even without setting enabled:true).
To also enable the governance pipeline (intervention, protocol enforcement):

```jsonc
{
  "meta_governor": {
    "enabled": true,
    "intervention": {
      "mode": "message",
      "minActionForMessage": "warn"
    }
  }
}
```

## 15 Custom Tools

The plugin registers 15 tools the LLM can invoke. All available immediately on install.

### Code Search & Navigation

| Tool | What it does | Use case |
|------|-------------|----------|
| `omo_search` | Semantic code search via codegraph/graphify with AFT fallback | Architecture questions, finding features — USE THIS FIRST |
| `omo_find` | Exact symbol lookup (definition + direct callers) via codegraph node | "Find the function `validateToken`" |
| `omo_impact` | Impact analysis: callers, transitive callers, test files, doc files | Run BEFORE modifying a function |
| `omo_path` | Shortest conceptual path between two concepts via graphify | "How does auth connect to database?" |
| `omo_explain` | Plain-language explanation of a concept via graphify | "What is the SwinTransformer?" |
| `omo_outline` | Structural outline of files/directories via AFT | Understanding a new file's structure |

### Lesson & Memory

| Tool | What it does | Use case |
|------|-------------|----------|
| `omo_recall` | Search past lessons via local SQLite FTS5 (fast, always available) | "How did we set up auth before?" |
| `omo_recall_mcp` | Search cross-session memory via AgentMemory | "What did we learn about X in previous sessions?" |
| `omo_remember` | Save a fact/observation to cross-session AgentMemory | "Remember this bug pattern for next time" |

### Rules & Notes

| Tool | What it does | Use case |
|------|-------------|----------|
| `omo_rule` | Save a durable rule to Magic Context (ctx_memory) | "Always use bun:sqlite, not better-sqlite3" |
| `omo_history` | Search git history + past messages via ctx_search | "When did we add this feature?" |
| `omo_note` | Write ephemeral session note via ctx_note | "Currently debugging auth in module X" |

### Safety & Status

| Tool | What it does | Use case |
|------|-------------|----------|
| `omo_checkpoint` | Create a named AFT snapshot before risky changes | Undo protection before refactoring |
| `omo_undo` | Revert to most recent AFT checkpoint | "That broke things, revert it" |
| `omo_health` | Show plugin runtime status: metrics, decisions, errors | "Is the plugin working?" |

## Health & Observability

The plugin exposes a health JSON file at `~/.config/opencode/meta-governor-health.json`:

```bash
cat ~/.config/opencode/meta-governor-health.json
```

Or the agent can call `omo_health` directly to get a formatted report.

Structured JSONL logs at `~/.config/opencode/meta-governor.log` with size-based rotation
(10MB max, 5 rotated files).

## Persistence

Lessons learned by the plugin persist in **SQLite** at `~/.omo-meta-governor/meta-governor.db`
with full-text search (FTS5) for fast recall. Zero dependencies needed — uses Bun's built-in
`bun:sqlite`.

Optionally, the Opción A tools (`omo_remember`, `omo_recall_mcp`, `omo_rule`, `omo_history`,
`omo_note`) can bridge to AgentMemory and Magic Context via `session.prompt()` — the LLM
receives a structured instruction to call the appropriate MCP tool.

## Graph Sync (v0.11.0)

MetaGovernor wires the plugin into the native git hooks of **codegraph** and
**graphify** so each commit automatically reindexes both graphs.

### What it does on first load in a project

1. **Auto-install** codegraph via `npm i -D @colbymchenry/codegraph` and
   graphify via `pip install graphifyy` (falls back to `uv tool install
   graphifyy`) if they're not already on PATH.
2. **Run `codegraph init`** + **`graphify . --no-viz`** to build the initial
   indexes for the project.
3. **Run `graphify hook install`** to wire up the native `post-commit` and
   `post-checkout` git hooks.

### What it does on each `git commit`

- **Primary path** (native git hook): `graphify update` runs in background.
- **Backup path** (plugin's `tool.execute.after`): detects `git commit` in
  bash commands and runs `codegraph sync -q [path]`.

## Intervention

MetaGovernor can inject governance decisions into the agent's context.
Enabled when `meta_governor.enabled: true` in config.

### Modes

| Mode | Mechanism | Effect |
|------|-----------|--------|
| `silent` | (none) | Decision is logged only |
| `message` | `experimental.chat.messages.transform` | Injects a synthetic user message visible to the LLM |
| `system` | `experimental.chat.system.transform` | Appends guidance to the system prompt |

### Configuration

```jsonc
{
  "meta_governor": {
    "enabled": true,
    "intervention": {
      "mode": "message",
      "minActionForMessage": "warn",
      "maxInterventionsPerSession": 3,
      "respectDoneSignal": true,
      "phaseAwareDoneSignal": true // v0.15.0: multi-phase plan support
    }
  }
}
```

### Fields

| Field | Default | Description |
|-------|---------|-------------|
| `mode` | `"message"` | How to inject: `"silent"`, `"message"`, or `"system"` |
| `minActionForMessage` | `"warn"` | Minimum action: `"warn"`, `"escalate"`, or `"stop"` |
| `maxInterventionsPerSession` | `3` | Hard cap on injections per session |
| `respectDoneSignal` | `true` | Stop injecting after terminal signal + Oracle verified |
| `phaseAwareDoneSignal` | `false` | **v0.15.0**: when `true`, only `<promise>PLAN-COMPLETE</promise>` latches intervention. DONE/PHASE-N-COMPLETE are per-phase hints. Recommended for multi-phase plans. |

### Multi-phase plans (v0.15.0)

For work plans with multiple phases (e.g. Sisyphus/Prometheus work plans),
configure `phaseAwareDoneSignal: true` and emit `<promise>PLAN-COMPLETE</promise>`
only when the **entire** plan is verified done by Oracle. The new markers:

| Marker | Effect |
|--------|--------|
| `<promise>DONE</promise>` | Per-phase hint. Logged but does NOT latch intervention (when `phaseAwareDoneSignal: true`). |
| `<promise>PHASE-N-COMPLETE</promise>` | Per-phase hint (e.g. `<promise>PHASE-1-COMPLETE</promise>`). Same as DONE — logged, does NOT latch. |
| `<promise>PLAN-COMPLETE</promise>` | Terminal. Latches intervention when Oracle has verified. |

**Migration**: existing v0.10.0–v0.14.x users keep working without changes (default
`phaseAwareDoneSignal: false` preserves the legacy single-task behavior). Set the
flag to `true` and switch your terminal marker to `PLAN-COMPLETE` to enable
multi-phase governance.

## v0.16.0 — Audit remediation: memory hygiene, dead code, tool coverage, CI

v0.16.0 closes the 50+ findings from the multi-front audit at `.omo/ulw-research/20260727-000530/plan-audit-v0.15.0.md`. The release is **additive in behavior, no breaking API changes** for users — only internal cleanup, dead code removal, and CI hardening.

### Highlights

#### Memory hygiene (F1)

- **`AuditStateCache`** (`src/audit-state-cache.ts`) — TTL+LRU bounded cache (100 entries, 1h TTL) replaces the bare `Map` that accumulated audit state without bounds. Stale sessions are evicted automatically.
- **`TTLQueue`** (`src/ttl-queue.ts`) — TTL-based expiration for `pendingBotFeedback` and `pendingViolations` queues. Previously unbounded.
- Removed dynamic `require("node:fs")` inside `shouldInjectPlanReminder` — replaced with static ESM imports (no more runtime module resolution failures).

#### Dead code elimination (F2)

- `takeAnyDecision()` — deprecated; removed from the active governance pipeline.
- `systemInjection` — now awaited eagerly instead of fire-and-forget, eliminating a silent failure route.
- `logToFile` in `graph-sync.ts` — wired to the real JSONL file logger (was a no-op stub).
- Plugin version — derived from `package.json` at runtime instead of hardcoded "0.13.0" (closes the version-drift bug where `omo_health` reported stale versions).

#### Tool bug fixes (F3)

- **AFT checkpoint/undo**: args split on whitespace broke names with spaces. Rewrote arg construction with proper quoting.
- **AFT subcommand**: now uses `options.projectDir` instead of `process.cwd()`.
- **graphify binary override**: `omo_path` / `omo_explain` honored the `graphifyBin` option (was hardcoded).
- **`as never` cast** on `setClient` → proper runtime guard that validates client shape.
- **`session-bridge`**: replaced module-level `_client` with `AsyncLocalStorage` for per-request isolation. Concurrent sessions no longer race on the same client reference.

#### Test coverage (F4)

- 22 tests covering all 15 custom tools (`src/custom-tools.test.ts`). Previously the entire public tool surface had zero test coverage.
- 12 tests for `decision-store` (previously untested).

#### Type/token pipeline (F5)

- `token-predictor` refactor: dead code (`delegate`/`switch-model`) removed; output is now informational-only as designed.
- Type alignment across `types.ts`, `token-predictor.ts`, `orchestrator.ts`.

#### CI matrix (F6)

- `bun run typecheck` now runs on **macos-latest** and **windows-latest** (was Ubuntu-only).
- Removed `package-lock.json` (bun project — canonical is `bun.lock`).
- Secret redaction layer in `logToFile` (JWT, OpenAI keys, Bearer tokens, GitHub PATs, generic key:value patterns).
- Implementation plan renamed `IMPLEMENTATION_PLAN.md` → `ARCHITECTURE.md`.

#### Final refactors (F7)

- Score formula documented (header doc with full formula spec).
- **NaN guard** in `score()` — defaults to neutral continue when `iterationRatio` or `ambient.iteration/maxIterations` produce NaN.
- `ACTION_SEVERITY` keyed by `DecisionHandlerOutput["action"]` union literal (was bare `Record<string, number>`).
- `projectHasCodegraph` / `projectHasGraphify` IIFE booleans replaced with lookup-time calls to `graphRetrieval.hasCodegraphDir(cwd)`.
- `extractConcepts` includes file basename for FTS lookup by tool/file name.
- Backup graph-sync uses `triggerReindex` (was `triggerCodegraphSync`) — reindexes both codegraph AND graphify backends.

### Test & build status

- **495/495 tests pass** (up from 487 in v0.15.0/0.15.1).
- `bun run typecheck` clean.
- `bun build.ts` clean (0.34 MB dist).
- `npm pack --dry-run` validated (no forbidden artifacts).

### Migration

No user action required. All changes are internal. The default `phaseAwareDoneSignal` is still `false` for backward compatibility; the v0.15.0 multi-phase behavior is preserved when explicitly enabled.

### Deferred to v0.17.0

- F5.1 — wiring `escalate` action to a real dispatcher (Oracle is recommended but not yet wired).
- F5.4 — `maxLessonsPerSession` enforcement (config field exists but is not enforced).
- F3.6 — Bridge tools lying about delivery (5 tools still return "dispatched" without polling). Recommend the user explicitly request this if delivery verification is critical.


## Auto-upgrade (v0.12.0)

On plugin load, queries npm/pip registries to check whether newer versions
of **codegraph** or **graphify** exist. Config: `graphSync.autoUpgrade` (default `true`),
`graphSync.upgradeCheckTtlMs` (default `86400000`).

## License

MIT
