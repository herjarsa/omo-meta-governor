# @herjarsa/omo-meta-governor

> Self-judging agent orchestration layer for [OpenCode](https://opencode.ai).
> Observes tool executions, scores progress, dispatches decisions, and exposes
> **12 custom tools** the agent can invoke across CodeGraph, Graphify,
> AgentMemory, and SQLite — for cheaper, more accurate code understanding.

**Current version:** `0.37.1` · **License:** MIT · **Status:** stable

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
  - [CLI-Anything hub (v0.28.0)](#cli-anything-hub-v0280)
  - [On-demand upgrades (W4-C)](#on-demand-upgrades-w4-c)
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

### OpenCode V2 compat (v0.50.0+, dual V1+V2)

One package serves both runtimes. V1 (`1.18.x`, `plugin` key) uses the classic
function entrypoint; V2 (OpenChamber v2 / opencode v2, `plugins` key) uses the
bridged `setup()` (same scoring, decisions, tools, session-start protocol).
No config change needed — `omo-meta-governor.jsonc` is read identically, and the
V1 `plugin` config key is normalized automatically by V2.

V2 limitations (no V2 hook equivalent per the official migration guide, logged
at setup, V1-only for now): `command.execute.before` command-filter,
`experimental.provider.small_model` override, `experimental.compaction.autocontinue`
overflow loop guard.

### Plugin configuration (`omo-meta-governor.jsonc`)

The plugin reads its detailed configuration from `omo-meta-governor.jsonc`
(separate file from `opencode.jsonc`). Three locations, closest wins:

1. **CLI inline** (highest priority — `omo-meta-governor --config '{...}'`)
2. **Project config**: `<projectDir>/.opencode/omo-meta-governor.jsonc`
3. **User config**: `~/.config/opencode/omo-meta-governor.jsonc` (lowest priority — defaults)

Minimal config to enable the governance pipeline:

```jsonc
{
  "enabled": true,
  "intervention": { "mode": "message", "minActionForMessage": "warn" }
}
```

### Oracle frequency

Controls when the plugin invokes Oracle for verification:

```jsonc
{
  "oracle": {
    // "final-only" (default): Oracle invoked ONLY at the final-gate. Zero mid-work.
    // "per-stop": Oracle invoked ONLY at the final-gate AND when
    // scoring reaches stop band (action === "stop"). warn/escalate log only.
    // "off": Oracle never invoked automatically. Set oracleVerified manually.
    "frequency": "final-only"
  }
}
```

The `<promise>DONE</promise>` / `<promise>PLAN-COMPLETE</promise>` final-gate
ALWAYS invokes Oracle regardless of `oracle.frequency`.

| `frequency` | Mid-work Oracle | Final-gate Oracle | Typical invocations / session |
|---|---|---|---|
| `final-only` (default) | Never — even `stop` decisions log without an Oracle prompt | Always | Exactly 1 (final-gate); zero mid-work interruptions |
| `per-stop` | ONLY when scoring reaches the stop band (`action === "stop"`); `warn`/`escalate` log only (`escalation suppressed by oracle.frequency`) | Always | 1 (final-gate) + 1 per stop-level emergency |
| `off` | Never invoked automatically | Never — set `oracleVerified` manually (e.g. via `omo_recall`) | 0 |

Implementation: `selectEscalationTarget()` in `src/scoring-engine.ts`
returns `null` for `off`/`final-only` (any action) and for `per-stop` unless
action is `"stop"`; `src/plugin.ts` respects the `null` (logs `escalation
suppressed by oracle.frequency`) while the DONE final-gate handler
(`detectPlanCompleteSignal` path) invokes Oracle separately.

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
4. **Synthesized (v0.57.0)** — recurring lesson patterns (3+ similar lessons)
   become draft skills via `omo_skill_propose` (writes `DRAFT-SKILL.md`,
   invisible to the resolver); `omo_skill_promote` activates one ONLY with
   explicit user approval. No auto-promotion, ever.
The plugin recommends skills to the agent; it never injects skill content into
prompts. The agent decides which skill to use per task.

### Memory: agentmemory only (v0.58.0)

The plugin used to keep a **parallel** SQLite lesson store with its own
auto-capture, while the `agentmemory-capture` plugin also observed every tool
call. Two memories doing the same job produce two sources of truth and double
the noise. v0.58.0 removes the duplication:

| When | What the plugin does | Endpoint |
|---|---|---|
| Task start | Fetches context related to the task and injects it into the agent's system prompt (empty context → nothing injected) | `POST /agentmemory/context`, `POST /agentmemory/enrich` |
| Task end | Writes the validated lessons (the 0.56 value/novelty gates still decide what is worth writing) and closes the session | `POST /agentmemory/lessons`, `POST /agentmemory/summarize`, `POST /agentmemory/session/end` |
| On demand | `omo_recall` searches agentmemory; `omo_remember` writes a lesson directly (no LLM round-trip) | `POST /agentmemory/smart-search`, `POST /agentmemory/lessons` |

Rules:
- **One capturer.** The `agentmemory-capture` plugin owns observation capture;
  this plugin never observes tool calls for memory purposes.
- **One writer.** The orchestrator no longer writes lessons or decisions
  (`saveLessons:false`, `saveDecisions:false`) — the session-end path owns
  every long-term write.
- **agentmemory owns the dedupe.** Saving a lesson that already exists
  *reinforces* it (confidence rises, one row) instead of creating a duplicate.
- **Degrade, never fork.** If agentmemory is down the plugin injects no
  context and writes nothing — it does not fall back to a second memory store.
  `omo_recall` may read the local SQLite lessons as a degraded fallback.

Config: `AGENTMEMORY_URL` (default `http://localhost:3111`) and
`AGENTMEMORY_SECRET` (falls back to `~/.agentmemory/.env` / `~/.agentmemory/secret`).

### Autonomous skill synthesis (v0.59.0)

The agent creates its own skills from what it learns. **No human approval
step** — a quality gate makes that safe:

| Gate | What it rejects |
|---|---|
| `protocol-rule` | Rules already in the system prompt (no `as any`, memory-first, …) — a skill repeating them adds tokens, not knowledge |
| `no-project-scope` | Lessons with no real place (`session:<id>`) — nothing to apply them to |
| `generic-remedy` | "Re-read the plan" — true of every stop ever |
| `not-enough-evidence` | Fewer than 3 occurrences (an anecdote is not a pattern) |
| `low-confidence` | Below 0.6 (never really learned) |
| `duplicate-skill` / `near-duplicate-skill` | Already covered by an existing skill |

A pattern's evidence is counted as **rows + agentmemory reinforcements** —
agentmemory collapses three identical saves into one row with
`reinforcements: 2`, so counting rows would never see the pattern.

Tools: `omo_skill_synthesize` (create from your own lessons; `dryRun` to
preview) and `omo_skill_prune` (delete the lessons that can never become a
skill — dry-run by default). Synthesis also runs automatically at session
end.

Config (`omo-meta-governor.jsonc`):

```jsonc
{
  "closedLoop": {
    "autonomousSkills": {
      "enabled": true,            // kill-switch (default true)
      "minLessons": 3,            // occurrences required
      "minConfidence": 0.6,
      "minPromotionConfidence": 0.7,
      "writeProjectSkills": true, // <cwd>/.agents/skills/<slug>/SKILL.md
      "writeGlobalSkills": false, // ~/.agents/skills (opt-in)
      "mirrorGlobal": false
    }
  }
}
```

### Project history as a signal (v0.60.0, F5)

Every signal the judge uses today describes the **current session**. F5 adds
the **project's history**, read from agentmemory:

| Source | Endpoint | What it finds |
|---|---|---|
| Recurring errors | `POST /patterns` | `error_repeat` — the same error across sessions (e.g. "x16") |
| Co-changes | `POST /patterns` | `co_change` — files that always change together |
| Project profile | `GET /profile` | `commonErrors`, `conventions`, top concepts |
| Insights | `GET /insights` | higher-order patterns agentmemory already distilled |

The difference matters: a per-turn signal reacts **after** the agent repeats
a mistake; these let the score be low **before** it happens, with the
concrete remedy attached.

Design constraints:
- **No LLM.** These are local HTTP reads, cached per project (5 min TTL) —
  never per tool call.
- **Informative by default.** `weight` defaults to `0`: the signals appear
  in the judge's digest but do not move the score. Raise it deliberately
  once you trust them on your project.
- **Honest about scope.** agentmemory detects patterns across ALL sessions,
  so a pattern may describe another project. Unscoped patterns are marked
  `(machine-wide)` in the digest.

```jsonc
{
  "scoring": {
    "projectSignals": {
      "enabled": true,
      "minFrequency": 3,
      "weight": 0,        // 0 = informative only
      "cacheTtlMs": 300000
    }
  }
}
```

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

### CLI-Anything hub (v0.28.0)

Parallel to graph-sync, the plugin ensures the CLI-Anything ecosystem
(`cli-hub` registry/installer + `npx skills` meta-skill) is installed and
current. **Opt-out: enabled by default** — every default projection uses
`!== false`, so omitting the block means ON:

```jsonc
{
  "meta_governor": {
    "cliAnything": {
      "enabled": true,          // default true — opt-out
      "autoInstall": true,      // default true
      "autoUpgrade": true,      // default true
      "upgradeCheckTtlMs": 86400000  // 24h registry-query TTL
    }
  }
}
```

To disable (e.g. offline machines, hermetic tests):

```jsonc
{
  "meta_governor": {
    "cliAnything": { "enabled": false }
  }
}
```

Independent of `graphSync.enabled` (W1-A1 desanidado): disabling graphSync
does NOT disable cliAnything and vice-versa. Both run fire-and-forget at
factory invocation, never blocking session start. The test seam
`__test_onCliAnythingInit` mirrors `__test_onGraphSyncInit` for placement
assertions without spawning real subprocesses.

### On-demand upgrades (W4-C)

Two tools expose the backend upgrade path on demand (codegraph + graphify):

| Tool | What it does | Use case |
|------|--------------|----------|
| `omo_upgrade_check` | Dry-run version table (installed / latest / upgrade-needed per backend). NEVER installs anything. | "Is an upgrade pending?" — safe to call any time |
| `omo_upgrade_run` | Executes the upgrade path once. Respects the 24h TTL cache (`upgradeCheckTtlMs`, default `86400000`): skips with `skipped:true` when the cache is fresh. Best-effort, never throws. | "Upgrade the backends now" |

Both are registered on all three surfaces: V1 `tool` hook (governance-enabled
and governance-disabled paths), V2 (`registerOmoTools`), and MCP
(`getAdapters()` + `MCP_TOOL_NAMES`).

> **Nota `syncIntervalMs` (startup-only):** `syncIntervalMs` applies ONLY to
> the `skillHub` registry sync (periodic background refresh of the skill
> catalog). `omo_upgrade_check` / `omo_upgrade_run` are **on-demand /
> startup-only** — they NEVER use `setInterval` and never poll in the
> background.

## MCP server mode (v0.31.0)

OpenCode Desktop and OpenChamber spawn `opencode serve` in HTTP/sidecar mode
where plugin `hooks.tool` registrations don't reach the UI (the factory
is never invoked). The MCP server mode exposes the same `omo_*` tools via
an independent MCP server process — the same delivery mechanism that powers
`codegraph`, `graphify`, `agentmemory`, etc.

Both modes can be active simultaneously without conflict.

### Known limitation: OpenCode Desktop plugin init (v0.38.5)

OpenCode Desktop spawns `opencode serve` in HTTP/sidecar mode. In some
versions of OpenCode Desktop, the plugin service is never materialised
during serve startup, so `plugin.server(input)` is never called and
the plugin's `omo_*` tools never appear in the session — **even though
the plugin module loads successfully** (you can see `MetaGovernor plugin
loaded` in `~/.config/opencode/meta-governor.log`).

This is tracked upstream:
- [anomalyco/opencode#42280](https://github.com/anomalyco/opencode/issues/42280)
  — V2 external plugins silently fail to register agents/tools after startup
- [anomalyco/opencode#41728](https://github.com/anomalyco/opencode/pull/41728)
  — fix(server): ensure Plugin service materialises at serve startup
- [anomalyco/opencode#44367](https://github.com/anomalyco/opencode/issues/44367)
  — [Desktop][Windows] npm plugin from config is silently never loaded

**Workaround** (until upstream PR #41728 lands): use the **CLI** (`opencode`
or `opencode run`) where the plugin loads normally, OR enable the
[MCP server mode](#mcp-server-mode-v0310) below to get the `omo_*` tools
via a sidecar process.

The regression test in `src/plugin.test.ts` ("serve-mode plugin init
contract (v0.38.5)") documents the serve-mode contract from the plugin
author's POV and will pass even today because it exercises the factory
directly. When upstream lands, this test should be extended to cover the
new `opencode serve` integration test shipped with PR #41728.

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
| `cliAnything` | object | — | CLI-Anything hub auto-install + auto-upgrade (opt-out, enabled by default). |

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
| `autoRemember.enabled` | boolean | `false` | Opt-in kill-switch for the auto-remember prompt (escalate/stop only → `omo_remember`). Conscience fix 2026-09-27: default flipped `true` → `false`; `warn` no longer triggers. |
| `autoRemember.cooldownMs` | number | `300000` | Min ms between two auto-remember fires in the same session. |
| `autoRemember.dedupe` | boolean | `true` | Identical content (stable key: action + evidence sources + deviation categories, score floats excluded) is never re-queued in the same session. |
| `conscience.enabled` | boolean | `false` | Master switch for conscience memory persistence (opt-in). |
| `conscience.maxMemoriesPerSession` | integer | `5` | Max conscience memories persisted per session. |
| `conscience.toolRoute` | enum | `omo_remember` | Tool route for conscience writes (`omo_remember` only). |
| `conscience.requireNovelty` | boolean | `true` | When true, only novel structured content (`mistake`, `whatToDo`, `whereToGo`, `toolRoute`) is persisted; raw dumps forbidden. |

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
| `enabled` | boolean | `true` | Master switch (v0.33.1+: defaults on). |
| `trigger` | enum | `'firstImplement'` | `'sessionStart'` (first transform) or `'firstImplement'` (once write-like tool observed). |
| `router` | enum | `'registry'` | `'registry'` (skill-hub, standalone) \| `'superpowers'` \| `'both'`. v0.50.0: `"both"`/`"superpowers"` delegate via `task(load_skills=[...])` and require the superpowers plugin installed separately — without it only the registry half (`omo_skill_find/get/add`) operates. `'aas'` is deprecated, aliased to `'registry'`. |

### `graphSync`

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `enabled` | boolean | `true` | Enable auto-initialization. |
| `watch` | boolean | `false` | Enable watch mode (re-index on file changes). |
| `killOrphanedOnInit` | boolean | `true` | Sweep orphaned processes on init. |
| `autoUpgrade` | boolean | `true` | **v0.26.0** — auto-upgrade installed codegraph + graphify binaries. |
| `upgradeCachePath` | string | — | **v0.26.0** — path for the upgrade cache file. |
| `checkGraphifyNeedsUpdate` | boolean | `true` | **v0.26.0** — run `graphify check-update` after upgrade. |

### `cliAnything`

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `enabled` | boolean | `true` | Opt-out master switch — set `cliAnything.enabled:false` to disable. Canonical `!== false` projection. |
| `autoInstall` | boolean | `true` | Auto-install `cli-hub` + meta-skill when missing. |
| `autoUpgrade` | boolean | `true` | Auto-upgrade on factory init (TTL-gated). |
| `cachePath` | string | — | Upgrade-check cache file (effective default `newPluginPaths().cliAnythingUpgradeCheck`). |
| `upgradeCheckTtlMs` | number | `86400000` | Min ms between registry queries (24h). Effective default applied at call-site (`plugin.ts`). |
| `cliHubBin` | string | `"cli-hub"` | Path to `cli-hub` binary. |
| `skillsBin` | string | `"npx skills"` | Path to `npx skills` invocation. |
| `installScope` | enum | `"global"` | `"global"` \| `"project"`. |

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