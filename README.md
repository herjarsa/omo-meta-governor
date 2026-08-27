# @herjarsa/omo-meta-governor

> Self-judging agent orchestration layer for [OpenCode](https://opencode.ai).
> Observes tool executions, scores progress, dispatches decisions, and exposes
> **12 custom tools** the agent can invoke across CodeGraph, Graphify,
> AgentMemory, and SQLite — for cheaper, more accurate code understanding.

**Current version:** `0.37.0` · **License:** MIT · **Status:** stable

---

## Table of Contents

- [Install](#install)
- [What it does](#what-it-does)
- [12 Custom Tools](#12-custom-tools)
  - [Code search & navigation](#code-search--navigation)
  - [Lesson & memory](#lesson--memory)
  - [File & symbol lookup](#file--symbol-lookup)
  - [Safety & status](#safety--status)
- [Governance pipeline](#governance-pipeline)
  - [Scoring engine](#scoring-engine)
  - [Intervention modes](#intervention-modes)
  - [Protocol enforcement](#protocol-enforcement)
  - [Skill priming](#skill-priming)
  - [Multi-phase plans](#multi-phase-plans)
- [Graph sync (codegraph + graphify)](#graph-sync-codegraph--graphify)
  - [Auto-init](#auto-init)
  - [Auto-upgrade (v0.26.0)](#auto-upgrade-v0260)
  - [Git hooks](#git-hooks)
  - [Process safeguards](#process-safeguards)
- [Persistence & observability](#persistence--observability)
- [CI monitor (v0.25.0)](#ci-monitor-v0250)
- [Configuration reference](#configuration-reference)
- [Architecture overview](#architecture-overview)
- [Testing](#testing)
- [Migration from earlier versions](#migration-from-earlier-versions)
- [License](#license)

---

## Install

```bash
npm install @herjarsa/omo-meta-governor
```

Add as a plugin in your OpenCode config (`~/.config/opencode/opencode.jsonc`):

```jsonc
{
  "plugins": ["@herjarsa/omo-meta-governor"]
}
```

The 12 custom tools register automatically on every load. To also enable
the governance pipeline (scoring, intervention, protocol enforcement):

```jsonc
{
  "meta_governor": {
    "enabled": true,
    "intervention": { "mode": "message", "minActionForMessage": "warn" }
  }
}
```

---

## What it does

`omo-meta-governor` is a single OpenCode plugin that ships **five
interconnected subsystems**:

| Subsystem | Purpose | Surface |
|---|---|---|
| **Graph sync** | Auto-install codegraph + graphify, build initial index, wire git hooks, auto-upgrade binaries on every load | `graphSync.*` config |
| **12 custom tools** | Semantic code search, impact analysis, symbol lookup, lesson recall, file/caller/node queries, health | `omo_*` tools |
| **Governance pipeline** | Score session progress → dispatch decision (`continue` / `warn` / `escalate` / `stop`) → optionally inject it into the agent's context | `meta_governor.enabled` |
| **Memory + lessons** | Persist decisions and lessons in SQLite (FTS5) + bridge to AgentMemory for cross-session recall | `omo_recall`, `omo_remember`, `omo_recall_mcp` |
| **Observability** | Health JSON, rotating JSONL logs, metrics, audit state, CI monitor | `omo_health`, `~/.config/opencode/meta-governor-health.json` |

All five run **inside the plugin** — no daemon, no sidecar. They share
process boundaries, lifecycle, and the opencode event hooks
(`tool.execute.before` / `tool.execute.after` / `chat.messages.transform`).

---

## Workflow guide (v0.35.4)

The plugin itself does not force a workflow — it gives the agent a guard against unprimed `write` calls, and the rest is judgement. For your agent to use the catalogued skills in the right order, classify the task into one of three tiers and follow the corresponding chain.

| Tier | Trigger | Required skills (in order) |
|---|---|---|
| **0 Trivial** | config tweak, doc edit, single-line fix | none — edit → typecheck → done |
| **1 Standard** (default) | new feature or fix in 1-2 files, no schema/security/CI touch | `brainstorming` → `find-skills` → `test-driven-development` → `verification-before-completion` |
| **2 Critical** | 3+ files, core plugin logic, schema, CI, security, refactor | ALL of Tier 1, plus `writing-plans` → `subagent-driven-development` → `requesting-code-review` → `finishing-a-development-branch` |

Full reference: see [`AGENTS.md`](AGENTS.md) (Skill Workflow section).

**When in doubt, go up one tier.** Cost of over-ceremony is ~5 minutes; cost of skipping is a broken commit + a 2-hour revert.

---

## 12 Custom Tools

The plugin registers 12 tools the LLM can invoke. All are available
immediately on install (no `enabled: true` required for tools — only the
governance pipeline needs `meta_governor.enabled: true`).

### Code search & navigation

| Tool | What it does | Use case |
|------|--------------|----------|
| `omo_search` | Semantic code search via codegraph or graphify | "Where is authentication handled?" — USE THIS FIRST for any architecture question |
| `omo_find` | Exact symbol lookup (definition + direct callers) via `codegraph node` | "Find the function `validateToken`" |
| `omo_impact` | Impact analysis: direct + transitive callers, test files, doc files | Run BEFORE modifying a function |
| `omo_path` | Shortest conceptual path between two concepts via graphify | "How does auth connect to database?" |
| `omo_explain` | Plain-language explanation of a concept via graphify | "What is the SwinTransformer?" |

### Lesson & memory

| Tool | What it does | Use case |
|------|--------------|----------|
| `omo_recall` | Search past lessons via local SQLite FTS5 (fast, always available) | "How did we set up auth before?" |
| `omo_recall_mcp` | Search cross-session memory via AgentMemory | "What did we learn about X in previous sessions?" |
| `omo_remember` | Save a fact / observation / pattern to cross-session AgentMemory | "Remember this bug pattern for next time" |

### File & symbol lookup

| Tool | What it does | Use case |
|------|--------------|----------|
| `omo_files` | List files indexed by codegraph or graphify | "What files are in the graph?" |
| `omo_callers` | List all call sites of a symbol via `codegraph callers` | "Who calls `UserService.create`?" |
| `omo_node` | Get source + direct callers of a symbol via `codegraph node` | "Show me the source of `validateToken` and its callers" |

### Safety & status

| Tool | What it does | Use case |
|------|--------------|----------|
| `omo_health` | Show plugin runtime status: metrics, decisions, errors | "Is the plugin working?" |

All tools return a typed `ToolResult` with `title`, `output`, and
`metadata` (`{tool, kind, durationMs, sessionID}`). They degrade
gracefully — when codegraph or graphify is missing, they return a
**friendly hint** (e.g. `npx codegraph init` to recover) instead of
crashing.

---

## Governance pipeline

When `meta_governor.enabled: true`, the plugin attaches to opencode's
tool-execution stream and runs an **observe → score → decide → (optionally)
intervene** loop on every turn.

### Scoring engine

`src/scoring-engine.ts` computes a single composite score in `[-1, 1]`
from weighted signals:

| Signal | Weight | Source |
|--------|--------|--------|
| `progress-detector` | 0.30 | did the last 5 tool calls make forward progress? |
| `deviation-detector` | 0.20 | accumulated protocol violations (capped at 5/session) |
| `no-progress-detector` | 0.20 | is the agent reading without writing? |
| `iteration-budget` | 0.15 | are we approaching `maxIterations`? |
| `oracle-burn` | 0.10 | did recent oracle calls detect issues? |
| `stop-advice` | 0.05 | did prior lessons recommend stop? |

The score maps to an action via configurable thresholds (see
[Configuration reference](#configuration-reference)):

- `score ≥ continueThreshold` → **continue** (silent)
- `score ≤ -warnThreshold` → **warn** (log + nudge)
- `score ≤ -escalateThreshold` → **escalate** (block + inject)
- `score ≤ -stopThreshold` → **stop** (latch intervention)

Default thresholds: `continue: 0.05`, `warn: 0.3`, `escalate: 0.45`,
`stop: 0.55` (worst-case math gives `stop ≈ -0.55`, so it actually
fires — verified via Gap C audit).

### Intervention modes

**v0.33.0 banner-killer fix**: all modes are now non-blocking. None of them produce the `continua` banner that previously killed delegation loops. The plugin persists guidance as a TUI notification (visible to user, invisible to agent as a blocking message-queue item). The agent still receives the violation context to correct it, either via system-prompt injection (`system` mode) or through its natural next turn after the notification.

When the decision is `warn` / `escalate` / `stop`:

| Mode | Mechanism | Effect |
|------|-----------|--------|
| `silent` (default) | (none) | Decision logged only; no TUI notification. Lowest noise. |
| `message` | `session.prompt()` (deferred 250ms) | Notification persisted to session TUI; agent does NOT see it as a blocking turn. Banner-free. |
| `system` | `chat.system.transform` | Guidance appended to system prompt on every turn; agent receives context non-blocking. |

`maxInterventionsPerSession: 3` (default) hard-stops injection after 3
interventions per session to prevent instruction loops (v0.10.0). When
`respectDoneSignal: true` (default), injection stops once the agent emits
the terminal signal AND Oracle has verified.
### Protocol enforcement

`src/protocol-enforcer.ts` audits tool calls against a configurable
protocol markdown file. Use it to enforce rules like "do not save
routine operations to memory" or "always invoke Oracle before declaring
done".

```jsonc
{
  "meta_governor": {
    "enabled": true,
    "protocolEnforcement": {
      "enabled": true,
      "path": "./PROTOCOL.md",
      "injectIntoSystem": true,
      "auditToolCalls": true
    }
  }
}
```

Violations accumulate in `state.accumulatedDeviations` (capped at 5 per
session) and feed the `deviation-detector` scoring signal.

### Skill priming

`src/skill-priming.ts` (v0.20.0) injects **one** synthetic user message
at session start (or once implementation work begins) prompting the
agent to select precise skills for the task via the AAS skill catalog
(`aas search_skills` / `get_skill` / `compose_stack`) and/or the
task-appropriate superpowers skill — before writing code. Minimal context
cost: the directive forbids enumerating the full catalog.

```jsonc
{
  "meta_governor": {
    "enabled": true,
    "skillPriming": {
      "enabled": true,
      "trigger": "firstImplement",
      "router": "both"
    }
  }
}
```
### Skills system: 3-tier resolution
The plugin resolves skills from three tiers, in this precedence:
1. **Chore (global)** — bundled skills shipped with the plugin, extracted to
   `~/.agents/skills/` on first run. Read-only from the plugin's perspective.
2. **Hub (lazy)** — on-demand from `skills-library.com` / `skills.sh`. Materialized
   to `<cwd>/.agents/skills/<slug>/SKILL.md` when the agent calls `omo_skill_get`.
3. **Custom (project-local)** — written by the agent via the `writing-skills`
   chore skill when no hub match exists.
The plugin recommends skills to the agent; it never injects skill content into
prompts. The agent decides which skill to use per task.

### Multi-phase plans

For work plans with multiple phases (e.g. Sisyphus/Prometheus work
plans), set `phaseAwareDoneSignal: true` and emit
`<promise>PLAN-COMPLETE</promise>` only when the **entire** plan is
verified done by Oracle.

| Marker | Effect |
|--------|--------|
| `<promise>DONE</promise>` | Per-phase hint. Logged but does NOT latch intervention (when `phaseAwareDoneSignal: true`). |
| `<promise>PHASE-N-COMPLETE</promise>` | Per-phase hint (e.g. `<promise>PHASE-1-COMPLETE</promise>`). Same as `DONE`. |
| `<promise>PLAN-COMPLETE</promise>` | Terminal. Latches intervention when Oracle has verified. |

---

## Graph sync (codegraph + graphify)

The plugin wires the native git hooks of **codegraph** and **graphify**
so each commit automatically reindexes both graphs.

### Auto-init

On first load in a project (when `graphSync.enabled: true`, default):

1. **Auto-install** codegraph via `npm i -D @colbymchenry/codegraph` and
   graphify via `pip install graphifyy` (falls back to
   `uv tool install graphifyy`) if not already on PATH.
2. **Run `codegraph init`** + **`graphify . --no-viz`** to build the
   initial indexes for the project.
3. **Run `graphify hook install`** to wire up the native `post-commit`
   and `post-checkout` git hooks.

### Auto-upgrade (v0.26.0)

Before v0.26.0, `autoUpgrade: true` (default) silently failed. Six
bugs in `src/graph-sync.ts:503-628` forced users to manually run
`npm install -g @colbymchenry/codegraph@latest` and
`pip install --upgrade graphifyy`.

**Root cause bugs fixed in v0.26.0:**

1. `getInstalledCodegraphVersion` only probed `npx` — failed when the
   binary was at `node_modules/.bin/codegraph` (Windows users).
2. `getInstalledGraphifyVersion` had no DI runner — Windows dual-python
   fallback was untestable.
3. `shouldUpgrade` ignored the cache value (`latest=null`).
4. Cache cold + undetectable binary → silent noop (no diagnostic code).
5. **`pip install` without `--upgrade` returned 0** with
   "Requirement already satisfied" but **did NOT upgrade** — most
   visible bug.
6. `graphify check-update` was ignored — semantic re-extraction flag
   never triggered.

**Fixes:**

- Tiered probe matching `checkToolAvailability`: `npx` +
  `node node_modules/.bin/codegraph` for codegraph; `graphify` →
  `python -m pip show` → `python3 -m pip show` for graphify.
- Runner DI seam on `getInstalledCodegraphVersion`,
  `getInstalledGraphifyVersion`, `installCodegraph`, `installGraphify`
  — hermetic tests, no real network in CI.
- `resolveLatest()` inlines cache into `shouldUpgrade` — avoids
  double-fetch from the registry.
- Cache written **ONCE** at the end of the upgrade block (was being
  fetched 3× per run).
- `pip install --upgrade graphifyy` / `uv tool install --upgrade graphifyy`
  flags.
- `graphify check-update` integration emits
  `graphify-reextract-triggered` when semantic re-extraction is pending.
- New codes: `codegraph-upgrade-broken`, `graphify-reextract-triggered`,
  `upgrade-cache-written`.
- New config fields: `autoUpgrade`, `upgradeCachePath`,
  `checkGraphifyNeedsUpdate`.

**Verified surface run:** `codegraph 0.6.8 → 1.5.0` and
`graphify 0.8.30 → 0.9.46` upgraded silently without manual
intervention.

**Configuration:**

```jsonc
{
  "meta_governor": {
    "graphSync": {
      "enabled": true,         // default true
      "autoUpgrade": true,     // v0.26.0: default true
      "upgradeCachePath": "~/.omo-meta-governor/upgrade-cache.json",
      "checkGraphifyNeedsUpdate": true  // emit graphify-reextract-triggered when schema changed
    }
  }
}
```

### Git hooks

On every `git commit`:

- **Primary path** (native git hook): `graphify update` runs in background.
- **Backup path** (plugin's `tool.execute.after`): detects `git commit`
  in bash commands and runs `codegraph sync -q [path]`.

### Process safeguards

Every subprocess the plugin spawns (graphify, codegraph, npx, python,
npm/pip) is guaranteed to die after use — on success, error, AND
timeout — including its descendant tree. On Windows this uses
`taskkill /pid <pid> /T /F` (plain `child.kill()` only kills the direct
shell, orphaning grandchildren — the confirmed cause of the
Bun/OpenChamber crashes).

Config: `graphSync.killOrphanedOnInit` (default `true`) — on graph-sync
init the plugin sweeps orphaned `graphify`/`codegraph` processes left
by previous crashed runs. Set to `false` to disable the sweep.

## MCP server mode (v0.31.0)

OpenCode Desktop and OpenChamber spawn `opencode serve` in HTTP/sidecar mode
where plugin `hooks.tool` registrations don't reach the UI (the factory
is never invoked). The MCP server mode exposes the same `omo_*` tools via
an independent MCP server process — the same delivery mechanism that powers
`codegraph`, `graphify`, `agentmemory`, etc.

Both modes can be active simultaneously without conflict.

### Setup

Add to your `~/.config/opencode/opencode.jsonc`:

```json
{
  "mcp": {
    "omo-meta-governor": {
      "type": "local",
      "command": ["npx", "-y", "@herjarsa/omo-meta-governor", "omo-meta-governor-mcp"]
    }
  }
}
```

To target a specific project directory, set the `OMO_CWD` environment
variable in the MCP config:

```json
{
  "mcp": {
    "omo-meta-governor": {
      "type": "local",
      "command": ["npx", "-y", "@herjarsa/omo-meta-governor", "omo-meta-governor-mcp"],
      "environment": { "OMO_CWD": "/absolute/path/to/project" }
    }
  }
}
```

### Tools exposed

The MCP server exposes a curated subset of the full tool surface:

| Tool | Description |
|------|-------------|
| `omo_search` | Semantic code search via codegraph/graphify |
| `omo_recall` | Search past lessons in the project memory |
| `omo_health` | Show plugin runtime status |
| `omo_find` | Find a symbol by name in the codegraph index |
| `omo_impact` | Show what a symbol affects |
| `omo_path` | Find shortest path between two graph nodes |
| `omo_explain` | Explain a graph node |
| `omo_status` | Show graphify status |
| `omo_index` | Run graphify indexing |
| `omo_visualize` | Open the graphify visualisation server |
| `omo_serve` | Start the graphify HTTP API server |
| `omo_diagnose` | Diagnose graph inconsistencies |
| `omo_uninit` | Remove the codegraph index from disk |
| `omo_sync_if_dirty` | Trigger codegraph reindex if stale |
| `omo_mark_dirty` | Mark the codegraph index as stale |
| `omo_hook_status` | Check whether the graphify post-commit hook is installed |

Some tools from the plugin mode (`omo_remember`, `omo_recall_mcp`,
`omo_unlock`, `omo_clone`, etc.) are intentionally NOT exposed via the MCP
server — they either require the session client or lack browser-side
visibility. Use the CLI or plugin hooks for those.

### Technical notes

- Tool implementations are reused from `custom-tools.ts` via the adapter
  pattern — fixes in the plugin surface are automatically available in MCP
  mode.
- The MCP server process is independent of the opencode sidecar. It has
  its own `GraphRetrieval`, `SqliteBackend`, and `MetricsCollector`
  singletons.
- Backward-compatible: existing users who only use the `plugin` key in
  `opencode.jsonc` see no behavior change.

---

## Persistence & observability

**Lesson storage.** Decisions and lessons persist in **SQLite** at
`~/.omo-meta-governor/meta-governor.db` with full-text search (FTS5) for
fast recall. Zero dependencies — uses Bun's built-in `bun:sqlite`.

**Cross-session memory.** The `omo_remember` / `omo_recall_mcp` tools
bridge to AgentMemory via `session.prompt()` — the LLM receives a
structured instruction to call the appropriate MCP tool.

**Health JSON** at `~/.config/opencode/meta-governor-health.json`:

```bash
cat ~/.config/opencode/meta-governor-health.json
```

Or invoke `omo_health` directly for a formatted report.

**Structured JSONL logs** at `~/.config/opencode/meta-governor.log` with
size-based rotation (10MB max, 5 rotated files). Secret redaction layer
strips JWT, OpenAI keys, Bearer tokens, GitHub PATs, and generic
`key:value` patterns before writing.

---

## CI monitor (v0.25.0)

`src/ci-monitor.ts` auto-triggers GitHub Actions on `git push` and
surfaces failures to the agent:

- Detects `git push` in bash commands via the `tool.execute.after` hook.
- Polls the GH Actions API for the resulting run (5s initial delay,
  exponential backoff).
- On failure, injects a synthetic message with the failed logs into the
  agent's context so it can fix and retry.

Configurable via `meta_governor.ciMonitor` (disabled by default — opt-in
feature).

---

## Configuration reference

All configuration lives under the `meta_governor` key in
`opencode.jsonc`. Full schema:
[assets/omo-meta-governor.schema.json](assets/omo-meta-governor.schema.json).

### Top-level

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `enabled` | boolean | `false` | Master feature flag — must be true to run the orchestrator. |
| `decision` | object | — | Decision handler tuning. |
| `memory` | object | — | Memory aggregator config. |
| `tokenPredictor` | object | — | Token predictor (compact-now / switch-model / delegate recommendations). |
| `scoring` | object | — | Scoring engine thresholds. |
| `closedLoop` | object | — | Closed-loop learning (save decisions + lessons). |
| `modelOverride` | object | — | Model override for MetaGovernor's internal LLM usage. |
| `intervention` | object | — | Visible decision injection config. |
| `protocolEnforcement` | object | — | Sisyphus protocol enforcement. |
| `skillPriming` | object | — | Proactive skill-selection nudge (v0.20.0). |
| `graphSync` | object | — | Graph synchronization (auto-init codegraph/graphify). |

### `decision`

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `maxHistoryPerSession` | integer | — | Maximum history entries per session before oldest are trimmed. |
| `forceContinueAfterStops` | integer | — | How many consecutive stops before forcing continue. |

### `memory`

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `agentmemoryTimeoutMs` | integer | — | Timeout for agentmemory queries in milliseconds. |
| `boulderStateTimeoutMs` | integer | — | Timeout for boulder-state queries in milliseconds. |
| `query` | string | — | Natural-language query for memory recall. |

### `tokenPredictor`

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `compactBurnRateThreshold` | integer | — | Burn rate (tokens/turn) above which to recommend compact-now. |
| `compactUsageThreshold` | number | — | Context usage ratio (0..1) above which to recommend compact-now. |
| `switchModelUsageThreshold` | number | — | Context usage ratio above which to recommend switch-model. |
| `delegateConsecutiveHighBurn` | integer | — | Max consecutive high-burn turns before recommending delegate. |

### `scoring`

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `continueThreshold` | number | `0.05` | Score ≥ this → continue silently. |
| `warnThreshold` | number | `0.3` | Score ≤ -this → warn. |
| `escalateThreshold` | number | `0.45` | Score ≤ -this → escalate. |
| `stopThreshold` | number | `0.55` | Score ≤ -this → stop. |

### `closedLoop`

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `saveDecisions` | boolean | `true` | Whether to save decision records. |
| `saveLessons` | boolean | `true` | Whether to save lessons. |

### `modelOverride`

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `providerID` | string | — | Provider ID (e.g. `'openai'`, `'anthropic'`). |
| `modelID` | string | — | Model ID (e.g. `'gpt-4o-mini'`, `'claude-sonnet-4-20250514'`). |
| `modelLimit` | integer | — | Context window size for token predictor (min 1000). |
| `temperature` | number | `0.2` | Sampling temperature (0..2). |
| `topP` | number | `1` | Top-p nucleus sampling (0..1). |
| `maxTokens` | integer | — | Max output tokens for internal reasoning. |
| `reasoning` | boolean | — | Enable extended reasoning / thinking mode. |
| `verbosity` | enum | — | `'silent'` \| `'minimal'` \| `'verbose'`. |

### `intervention`

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `mode` | enum | — | `'silent'` \| `'message'` \| `'system'`. |
| `includeDecisionHistory` | boolean | — | Whether to include recent decision history in injection. |
| `maxHistoryMessages` | integer | `5` | Max history entries when `includeDecisionHistory: true`. |
| `minActionForMessage` | enum | — | Minimum action: `'warn'` (all non-continue), `'escalate'`, `'stop'`. |
| `persistToSession` | boolean | `true` | v0.33.0: when true, notifications persist to the session via `session.prompt()` (banner-free, TUI-visible). The plugin no longer pushes `role:'user'` synthetic messages through `experimental.chat.messages.transform` (that was the session-killer — OpenCode renders them as blocking banners requiring `continua` clicks). |
| `respectDoneSignal` | boolean | `true` | Stop injecting once terminal signal + Oracle verified. |
| `phaseAwareDoneSignal` | boolean | `false` | v0.15.0: split per-phase hint from terminal signal. |
| `compactionLoopGuard.enabled` | boolean | `true` | v0.31.2: defense against opencode [#27924](https://github.com/anomalyco/opencode/issues/27924) (infinite overflow-compaction loop). |
| `compactionLoopGuard.maxOverflowRecoveries` | integer | `1` | v0.31.2: consecutive overflow compactions tolerated before the guard trips. |

### `protocolEnforcement`

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `enabled` | boolean | — | Master switch. |
| `path` | string | — | Path to protocol markdown file. |
| `injectIntoSystem` | boolean | — | Whether to inject protocol rules into the system prompt. |
| `auditToolCalls` | boolean | — | Whether to audit tool calls for violations. |

### `skillPriming`

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `enabled` | boolean | `false` | Master switch. |
| `trigger` | enum | `'firstImplement'` | `'sessionStart'` (first transform) or `'firstImplement'` (once write-like tool observed). |
| `router` | enum | `'both'` | `'aas'` \| `'superpowers'` \| `'both'`. |

### `graphSync`

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `enabled` | boolean | `true` | Enable auto-initialization. |
| `watch` | boolean | `false` | Enable watch mode (re-index on file changes). |
| `killOrphanedOnInit` | boolean | `true` | Sweep orphaned processes on init. |
| `autoUpgrade` | boolean | `true` | **v0.26.0** — auto-upgrade installed codegraph + graphify binaries. |
| `upgradeCachePath` | string | — | **v0.26.0** — path for the upgrade cache file. |
| `checkGraphifyNeedsUpdate` | boolean | `true` | **v0.26.0** — run `graphify check-update` after upgrade. |

---

## Architecture overview

The plugin is a single ESM module with five layers wired through opencode
event hooks:

```
                  ┌─────────────────────────────────────────────────────┐
                  │              opencode event hooks                    │
                  │  tool.execute.before   tool.execute.after            │
                  │  chat.messages.transform   chat.system.transform      │
                  └───────────────┬─────────────────────┬────────────────┘
                                  │                     │
              ┌───────────────────▼────────┐ ┌──────────▼─────────────┐
              │   AuditStateCache (TTL)   │ │  Decision + Scoring    │
              │   recentWriteFilePaths    │ │  Engine (-1..+1 score) │
              │   accumulatedDeviations   │ └──────────┬─────────────┘
              │   recentInterventionTexts │            │
              └───────────────────────────┘            │
                                  │                     │
        ┌─────────────────────────▼─────────────────────▼──────────────┐
        │                  Governance pipeline                          │
        │  Protocol Enforcer  →  Scoring  →  Decision Handler  →       │
        │                                                  Intervention  │
        └──────────────────────────────────────────────────────────────┘
                                  │
                                  │
        ┌─────────────────────────▼──────────────────────────────────────┐
        │                Graph sync + tool layer                        │
        │  codegraph + graphify (auto-init, git hooks, auto-upgrade)    │
        │  12 omo_* tools (search, find, impact, recall, files, etc.)  │
        └───────────────────────────────────────────────────────────────┘
                                  │
                                  ▼
                ┌──────────────────────────────────┐
                │   SQLite (bun:sqlite) + AgentMem │
                │   meta-governor.db / decisions   │
                │   / lessons / audit state        │
                └──────────────────────────────────┘
```

See [ARCHITECTURE.md](ARCHITECTURE.md) for module-level relationships and
[STRUCTURE.md](STRUCTURE.md) for the file layout.

---

## Testing

```bash
bun test                  # full suite (672+ tests)
bun test src/upgrade-autofix.test.ts   # Wave 1: auto-upgrade regression
bun test src/custom-tools.test.ts      # Wave 2: 12 tools
```

**Coverage highlights (v0.26.0):**

- 10 tests in `src/upgrade-autofix.test.ts` (AUT-1..AUT-7) — tiered probe,
  pip `--upgrade` flag, `graphify check-update` integration, cache
  write-once semantics.
- 7 tests in `src/custom-tools.test.ts` for the new tools
  (FIL-1..3, CAL-1..2, NOD-1..2) plus full coverage of the existing 9.
- 686+ tests across `decision-store`, `token-predictor`,
  `protocol-enforcer`, `graph-sync`, `skill-priming`, `ci-monitor`,
  `audit-state-cache`, `closed-loop-learning`, `closed-loop`,
  `config-file`, `session-bridge`, `sqlite-backend`, `memory-aggregator`,
  `proc-guard`, `ttl-queue`, `mcp-client`, `scoring-engine`, `v018-fixes`,
  `v172`, `v173-f51`, `v173-gap-d`, `intervention-fix`, `graphsink-fix`,
  `plugin`, `plugin-graphsync`, `plugin-audit-postwave`, `postwave-wire`,
  `postwave-gate`.

Known flaky test: `runGuarded > times out` (1 test) — pre-existing,
unrelated to v0.26.0, confirmed by Oracle audit.

---

## Migration from earlier versions

**From v0.24.x → v0.26.0:**

- **Stale-cache detection (v0.24.3):** On plugin load, an async npm
  version check runs in the background. If the loaded version differs
  from the latest published version, a warning is logged with
  cache-clearing instructions. If you see `STALE_CACHE` in
  `meta-governor.log`, run:

  ```bash
  npm cache clean --force && rm -rf ~/.cache/opencode/packages/@herjarsa/omo-meta-governor*
  ```

  Then restart opencode.

- **Auto-upgrade (v0.26.0):** No user action required. The plugin now
  upgrades codegraph and graphify silently on every load. If you
  previously disabled `graphSync.enabled` to work around the broken
  upgrade, re-enable it.

- **New config fields:** `graphSync.autoUpgrade`,
  `graphSync.upgradeCachePath`, `graphSync.checkGraphifyNeedsUpdate` —
  all default true. Schema is backward-compatible.

**From earlier versions:** no user action required. All changes through
v0.18.0 were transparent — the audit gaps (config drops, circular refs,
metrics crashes) only affected edge cases where users set obscure
fields. See [CHANGELOG.md](CHANGELOG.md) for the full history.

---

## License

MIT