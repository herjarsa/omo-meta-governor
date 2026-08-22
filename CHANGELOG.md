# Changelog

All notable changes to `@herjarsa/omo-meta-governor` are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/).

## [0.31.1] — 2026-08-22

### 🛡️ Fixed: overflow compaction loop guard (defends against opencode bug #27924)

OpenCode upstream bug [#27924](https://github.com/anomalyco/opencode/issues/27924)
causes an infinite compaction loop when a session hits context overflow:

```
assistant responds → context overflow → auto-compaction → synthetic "Continue..." →
agent responds → overflow → compaction → synthetic "Continue..." → …
```

The plugin cannot fix opencode, but it CAN trip a circuit breaker:

**New config: `intervention.compactionLoopGuard`**

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `enabled` | boolean | `true` | Master switch for the overflow loop guard |
| `maxOverflowRecoveries` | integer | `2` | Max consecutive overflow compactions before the guard trips |

When the guard is enabled (default), after `maxOverflowRecoveries` consecutive
overflow compactions (default: 2), the plugin:

1. Flips `autocontinue.enabled = false` so opencode stops re-compacting
2. Queues a `[META-GOVERNOR]` guidance message telling the agent to resume
   its pending tasks instead of generating more context pressure
3. Disables further autocontinue for the session (user can start a new
   session or call `/compact` manually to recover)

**Counter semantics:**
- `overflow=true` → counter increments
- `overflow=false` → counter resets to 0 (a clean compaction is progress)
- Counter is per-session (one session's loop does not affect another)
- Guard is disabled when `compactionLoopGuard.enabled = false` (users with
   large-context-window models may want this)

**Workaround without the plugin:** set `compaction: { "auto": false }` in
`opencode.jsonc` to disable autocompaction entirely.

**Tests:** 7 new tests in `src/compaction-loop-guard.test.ts` covering:
- Single overflow → still enabled
- Two consecutive overflows → still enabled (counter below threshold)
- Three consecutive overflows → autocontinue disabled
- Non-overflow resets the counter
- Per-session counter isolation
- Guard disabled → always enabled
- meta_governor disabled → hook not registered

---

## [0.29.0] — 2026-08-20

### 🐛 Fixed: context-window contamination from repeated interventions

The MetaGovernor plugin was firing the same directives on every LLM turn
during background-task waits (explore, librarian, plan, Oracle), polluting
the context window with up to 3 identical "no progress" warnings per turn
and re-injecting the "Post-task Oracle Verification" reminder even after
Oracle had already verified.

**Ten gaps fixed:**

* **Gap A** — generalize `oracleInFlight` → `backgroundTaskInFlight`. The
  in-flight suppression gate now covers ALL `run_in_background=true`
  tasks, not just Oracle, with a 5-min timeout safety net. Closes the
  `noProgress` pile-up when the agent awaits non-Oracle subagents.
* **Gap B** — `chat.system.transform` re-renders `buildSystemInjection`
  per turn with cached raw `protocolText` + audit state, so rule 4
  drops dynamically once Oracle has verified.
* **Gap C** — `scoreDeviations` drops entries older than 60s. Deviations
  stamp `ts` at push time so the score stops dropping monotonically
  during background waits. `Deviation.ts?: number` field added in
  `types.ts` (optional, backwards-compatible with pre-v0.29 fixtures).
* **Gap D** — per-reasoning-hash warn cooldown (60s). Same reasoning
  firing 3× in a row is suppressed; different reasoning passes through.
  Bug fix: cooldown reads `decision.historyEntry?.reasoning` (not the
  non-existent `decision.reasoning`).
* **Gap E** — dedupe consecutive identical entries in
  `recentInterventionTexts` before prepending history into the LLM
  context.
* **Gap F** — `simpleHash` (FNV-1a 32-bit) + rolling 8-hash window for
  the post-wave gate. Prevents re-detection of identical
  `subagent_type=oracle` text echoed through unrelated tool outputs.
* **Gap G** — `buildSystemInjection` accepts `{ oracleVerified,
  filesChanged }` options. Rule 4 (Post-task Oracle Verification) is
  dropped when `oracleVerified && filesChanged > 0`.
* **Gap H** — the Oracle rule in `auditToolCall` fires only on write
  tools (`write`/`edit`/`edit_block`/`desktop-commander_*`/
  `apply_patch`). No longer piles up duplicate violations on every
  read/grep during waits.
* **Gap I** — dedupe `pendingViolations` by `[severity::rule::detail]`
  before push so the queue stops refilling with copies.

**Type-fix side**: extended the inline `type AuditState` interface with
the pre-existing `lessonCount` / `lastViolationInjectionAtMs` /
`signalAtMs` fields that the state literals already had. Closes 39 tsc
errors that slipped past the Bun runtime transpiler.

**Tests**: +26 (5 scoring-engine decay, 4 buildSystemInjection
oracleVerified skip, 4 write-only Oracle rule, 6 simpleHash, 5
integrated via plugin factory). Suite: **232 pass across 12 files**
(`tsc --noEmit` exit 0). Oracle-verified PASS.

---

## [0.26.0] — 2026-08-19

### 🐛 Fixed: auto-upgrade of codegraph and graphify binaries

`autoUpgrade: true` (default) silently failed to upgrade installed
binaries. Six bugs in `src/graph-sync.ts:503-628` forced users to
manually run `npm install -g @colbymchenry/codegraph@latest` and
`pip install --upgrade graphifyy`.

**Root cause bugs:**

1. Tiered probe missing on `getInstalledCodegraphVersion` — only
   probed `npx`, failed on Windows binary-only installs.
2. No DI runner on `getInstalledGraphifyVersion` — Windows
   dual-python fallback was untestable.
3. `shouldUpgrade` called with `latest=null` — ignored the cache.
4. Cache cold + undetectable binary → silent noop.
5. **`pip install` without `--upgrade` returned 0** with "Requirement
   already satisfied" but did NOT upgrade.
6. `graphify check-update` was ignored — semantic re-extraction flag
   never triggered.

**Fixes:**

- Tiered probe matching `checkToolAvailability`:
  `npx` + `node node_modules/.bin/codegraph` for codegraph;
  `graphify` → `python -m pip show` → `python3 -m pip show` for
  graphify.
- Runner DI seam on `getInstalledCodegraphVersion`,
  `getInstalledGraphifyVersion`, `installCodegraph`,
  `installGraphify` — hermetic tests, no real network in CI.
- `resolveLatest()` inlines cache into `shouldUpgrade`.
- Cache written **ONCE** at the end of the upgrade block.
- `pip install --upgrade graphifyy` / `uv tool install --upgrade
  graphifyy` flags.
- `graphify check-update` integration emits
  `graphify-reextract-triggered` when semantic re-extraction is
  pending.
- New codes: `codegraph-upgrade-broken`,
  `graphify-reextract-triggered`, `upgrade-cache-written`.
- New config fields: `autoUpgrade`, `upgradeCachePath`,
  `checkGraphifyNeedsUpdate`.
- TS type narrowing: `runner?` calls now use
  `Parameters<typeof execSync>[1]` cast instead of `as never`.

### ✨ Added: 3 new omo_* tools exposed to the LLM

The `GraphRetrieval.invokeFiles` / `invokeCallers` / `invokeNode`
methods were already implemented in `src/graph-retrieval.ts` but never
wrapped as user-facing tools. This release wires them as `omo_*` tools
alongside the existing 9:

- **`omo_files`** — list files indexed by codegraph or graphify.
- **`omo_callers`** — list all call sites of a symbol via `codegraph
  callers`.
- **`omo_node`** — get source + direct callers of a symbol via
  `codegraph node`.

Tool count: **9 → 12**. All three follow the `buildOmo*Tool` pattern:
Zod-validated args, `ToolResult` with `title`/`output`/`metadata`,
graceful degradation on backend absence.

### 🧪 Tests

- 10 new tests in `src/upgrade-autofix.test.ts` (AUT-1..AUT-7) —
  regression coverage for all six auto-upgrade bugs.
- 7 new tests in `src/custom-tools.test.ts` (FIL-1..3, CAL-1..2,
  NOD-1..2) for the new tools.
- Full suite: **672+ pass, 2 skip, 1 fail** (pre-existing flaky
  `runGuarded > times out` test confirmed by Oracle).

### 📝 Commits

```
89e967a fix: narrow execSync runner return type for TS strict mode (v0.26.0 build)
0b52abb chore: bump to 0.26.0 — auto-upgrade fix + 3 new omo_* tools
92ab892 chore: register omo_files/omo_callers/omo_node in plugin.ts tool registry
3baaddd test: cover omo_files/omo_callers/omo_node with FIL-1..FIL-3, CAL-1..CAL-2, NOD-1..NOD-2
24d881f feat: expose omo_files / omo_callers / omo_node tools (v0.26.0)
e91af04 fix: auto-upgrade codegraph/graphify binaries — tiered version probe, pip --upgrade flag, graphify check-update integration
3034406 test: add graph-sync v0.26.0 auto-upgrade regression tests (AUT-1..AUT-7)
```

---

## [0.25.1] — 2026-08-XX

### Added

- **`reindexOnFetch`** — `src/graph-sync.ts:detectRemoteNewCommits()`
  counts commits the local HEAD is behind `origin/<branch>`. On plugin
  load, if local is behind, reindex both codegraph and graphify.
  Default `true`.
- **`fetchBranch`** — branch to fetch + compare against (default
  `"main"`).

### Fixed

- `detectRemoteNewCommits` honors the `runner?` DI parameter for
  hermetic testing.

---

## [0.25.0] — 2026-08-XX

### Added

- **`CI monitor`** (`src/ci-monitor.ts`) — auto-triggers GitHub
  Actions on `git push` and surfaces failures to the agent via
  session prompt injection.
- **Explicit codegraph/graphify routing** — `graphRetrieval.preferredTool`
  can be `"codegraph"`, `"graphify"`, or `"auto"` (default).

---

## [0.24.7] — 2026-08-XX

### Fixed

- Bump e2e test timeouts to 15s for Windows CI cold-start.

---

## [0.24.6] — 2026-08-XX

### Added

- CI monitor feature (rolled into 0.25.0 release).

---

## [0.24.5] — 2026-08-XX

### Fixed

- `detectRemoteNewCommits` — honor runner DI param.

---

## [0.24.4] — 2026-08-XX

### Fixed

- TS errors — score field path + duplicate property.

---

## [0.24.3] — 2026-08-XX

### Added

- **Stale-cache detection** — on plugin load, an async npm version
  check runs in the background. If the loaded version differs from
  the latest published version, a warning is logged with
  cache-clearing instructions. This prevents silent stale-cache
  issues where `@latest` does not force re-fetch from opencode's
  package cache.
- **CHANGELOG.md** — this file.

---

## [0.24.2] — 2026-08-XX

### Fixed

- Suppress interventions during background Oracle execution.

---

## [0.24.1] — 2026-08-XX

### Fixed

- `codegraph watch` loop uses `spawn windowsHide:true`.

---

## [0.24.0] — 2026-08-XX

### Changed

- **Memory save directive** — added explicit negative guidance:
  > "Do NOT save routine operations (file reads, greps, list
  > commands), trivial decisions, or facts already covered by
  > existing memory."
- Narrowed `save-discovery-to-memory` audit rule from 5 tools to 2
  (`codegraph_explore`, `graphify query`).

### Reverted

- TUI toast notifications — feature dropped by user feedback.

### Added

- SDK v1 `session.prompt` shape fix.

---

## [0.23.1] — 2026-08-XX

### Fixed

- Migrate `execSync` to `runGuardedSync` in auto-upgrade functions.
- `checkToolAvailability` / `initCodegraph` / `initGraphify` use
  `runGuardedSync`.
- Break violation injection loop + prevent black window on Windows.

---

## [0.22.0] — 2026-08-XX

### Added

- **`graphSync.killOrphanedOnInit`** — sweep orphaned graphify/
  codegraph processes left by previous crashed runs on graph-sync
  init. Default `true`.

---

## [0.21.0] — 2026-08-XX

### Added

- **`graphSyncReadyProjects` Set** — tracks projects where background
  graph-sync completed and BOTH index tools are available.
- **`graphSyncReadyNotified` Set** — ensures the once-per-session
  nudge fires at most once.

### Changed

- graphSync init runs at **factory invocation** with the session's
  resolved config, not lazily on first message. Keeps it once-per-
  project (graphSync is tool infrastructure, so it must run even when
  governance is disabled).

---

## [0.20.0] — 2026-08-XX

### Added

- **Skill priming** (`src/skill-priming.ts`) — proactive
  skill-selection nudge injected **once** per session. Prompts the
  agent to select precise skills for the task via the AAS skill
  catalog and/or superpowers skill before writing code.
- Config: `skillPriming.{enabled, trigger, router}`.
- `trigger`: `'sessionStart'` (first transform call) or
  `'firstImplement'` (once write-like tool observed).
- `router`: `'aas'`, `'superpowers'`, or `'both'`.

---

## [0.19.0] — 2026-08-XX

### Added

- `intervention.persistToSession` — when `true` (default),
  intervention messages ALSO persist to the session via
  `session.prompt()` so they appear in the OpenCode TUI.

---

## [0.18.0] — 2026-08-XX

### Fixed

- 7 silent config drops — `loadOrchestratorConfig` now projects all
  user configuration (was silently overriding
  `closedLoop.maxLessonsPerSession` to 20, etc.).
- Circular reference crash in config loader.
- Metrics crashes on empty input.

### Migration

- Users who were setting previously-dropped fields will now see
  those values actually take effect.

---

## [0.17.3] — 2026-07-XX

### Fixed

- Final round of gaps from the audit at
  `.omo/ulw-research/20260727-000530/plan-audit-v0.15.0.md`.

---

## [0.16.0] — 2026-07-XX

### Added (audit remediation — memory hygiene, dead code, tool coverage, CI)

- **`AuditStateCache`** (`src/audit-state-cache.ts`) — TTL+LRU
  bounded cache (100 entries, 1h TTL) replaces the bare `Map` that
  accumulated audit state without bounds.
- **`TTLQueue`** (`src/ttl-queue.ts`) — TTL-based expiration for
  `pendingBotFeedback` and `pendingViolations` queues.

### Removed

- Dynamic `require("node:fs")` inside `shouldInjectPlanReminder` —
  replaced with static ESM imports.
- `takeAnyDecision()` — deprecated; removed from active pipeline.
- `logToFile` in `graph-sync.ts` — was a no-op stub; now wired to the
  real JSONL file logger.

### Fixed

- AFT checkpoint/undo arg quoting for names with spaces.
- AFT subcommand uses `options.projectDir` instead of `process.cwd()`.
- `graphify binary override` honored by `omo_path` / `omo_explain`.
- `as never` cast on `setClient` → proper runtime guard.
- `session-bridge` replaced module-level `_client` with
  `AsyncLocalStorage` for per-request isolation.
- NaN guard in `score()` — defaults to neutral continue when inputs
  produce NaN.
- `ACTION_SEVERITY` keyed by `DecisionHandlerOutput["action"]` union
  literal.
- `extractConcepts` includes file basename for FTS lookup.

### Tests

- 22 tests covering all 15 custom tools (was 0).
- 12 tests for `decision-store` (was 0).
- `bun run typecheck` now runs on macOS and Windows (was Ubuntu-only).
- Secret redaction layer in `logToFile`.

---

## [0.15.1] — 2026-06-XX

### Added

- **`phaseAwareDoneSignal`** — when `true`, only
  `<promise>PLAN-COMPLETE</promise>` is the terminal marker;
  `DONE` / `PHASE-N-COMPLETE` are per-phase hints.

---

## [0.15.0] — 2026-06-XX

### Added

- **Graph sync v0.11.0** — auto-init codegraph + graphify.
- **Git hook wiring** via `graphify hook install`.
- **Native git hook primary path** + plugin backup path.

---

## [0.14.x] and earlier

See git history: `git log --oneline` for the full commit log prior
to v0.15.0.

---

[0.26.0]: https://github.com/herjarsa/omo-meta-governor/releases/tag/v0.26.0
[0.25.1]: https://github.com/herjarsa/omo-meta-governor/compare/v0.25.0...v0.25.1
[0.25.0]: https://github.com/herjarsa/omo-meta-governor/compare/v0.24.7...v0.25.0
[0.24.7]: https://github.com/herjarsa/omo-meta-governor/compare/v0.24.6...v0.24.7
[0.24.6]: https://github.com/herjarsa/omo-meta-governor/compare/v0.24.5...v0.24.6
[0.24.5]: https://github.com/herjarsa/omo-meta-governor/compare/v0.24.4...v0.24.5
[0.24.4]: https://github.com/herjarsa/omo-meta-governor/compare/v0.24.3...v0.24.4
[0.24.3]: https://github.com/herjarsa/omo-meta-governor/compare/v0.24.2...v0.24.3
[0.24.2]: https://github.com/herjarsa/omo-meta-governor/compare/v0.24.1...v0.24.2
[0.24.1]: https://github.com/herjarsa/omo-meta-governor/compare/v0.24.0...v0.24.1
[0.24.0]: https://github.com/herjarsa/omo-meta-governor/compare/v0.23.1...v0.24.0
[0.23.1]: https://github.com/herjarsa/omo-meta-governor/compare/v0.22.0...v0.23.1
[0.22.0]: https://github.com/herjarsa/omo-meta-governor/compare/v0.21.0...v0.22.0
[0.21.0]: https://github.com/herjarsa/omo-meta-governor/compare/v0.20.0...v0.21.0
[0.20.0]: https://github.com/herjarsa/omo-meta-governor/compare/v0.19.0...v0.20.0
[0.19.0]: https://github.com/herjarsa/omo-meta-governor/compare/v0.18.0...v0.19.0
[0.18.0]: https://github.com/herjarsa/omo-meta-governor/compare/v0.17.3...v0.18.0
[0.17.3]: https://github.com/herjarsa/omo-meta-governor/compare/v0.16.0...v0.17.3
[0.16.0]: https://github.com/herjarsa/omo-meta-governor/compare/v0.15.1...v0.16.0
[0.15.1]: https://github.com/herjarsa/omo-meta-governor/compare/v0.15.0...v0.15.1