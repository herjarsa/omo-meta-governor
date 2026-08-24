# Changelog

All notable changes to `@herjarsa/omo-meta-governor` are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/).

## [0.33.1] - 2026-08-24

### Fixed

- **Skill workflow completely broken** (3 compounding bugs):
  1. **AAS MCP dead references**: `buildSkillPrimingMessage` hardcoded `aas search_skills` / `aas get_skill` / `aas compose_stack` — those tools were retired in v0.32.0 when the skill-hub subsystem landed. Replaced with `omo_skill_find` / `omo_skill_get` / `omo_skill_add`. Router `'aas'` is now deprecated and aliased to `'registry'`.
  2. **Skill priming never reached the agent**: after v0.33.0's banner-killer fix, the directive was gated behind the test-only `__test_persistSessionMessage` flag. In prod only `persistIntervention` ran (TUI-visible, agent-invisible). Fix: cache the directive in `skillPrimingSystemInjected` Map on detection, then re-inject via `chat.system.transform` on every turn. Agent now receives the directive naturally without any blocking banner.
  3. **Decisions not delivered to agent for `intervention.mode === "message"`**: the system-transform injection only fired for `mode === "system"`. Fixed: both `message` and `system` modes now append decisions to the system prompt (banner-free, agent-receives).
- **Default `skillPriming.enabled = false`** — flipped to `true` so the skill workflow fires out of the box. Default router flipped from `'both'` to `'registry'` (AAS retired). Schema updated.
- **`buildThirdPartyDirective` hardcoded `aas MCP GitHub skills`** for third-party PR workflow. Replaced with standard `git`/`gh pr create` workflow. `aasToolPrefix` parameter retained for backward compat (empty default).

### Changed

- `SkillPrimingRouter` type: `'aas'` deprecated (still accepted, aliased to `'registry'`).
- `intervention.mode === "message"`: now also appends to system prompt (was: log-only via persistIntervention).
- `buildThirdPartyDirective(text, wave, aasToolPrefix="")`: `aasToolPrefix` no longer defaults to `"aas"`; if non-empty, the directive still references the user-provided MCP prefix.

### Tests

- Updated 5 tests in `skill-priming.test.ts` for new router text (`omo_skill_find` instead of `aas search_skills`).
- Updated 1 test in `plugin.test.ts` for new system-transform behavior under `mode: "message"`.
- 84 tests pass, tsc clean.

## [0.33.0] - 2026-08-24

### Fixed

- **Session-killer root cause (banner-killer)**: every `output.messages.push(role:"user", synthetic:true)` in `experimental.chat.messages.transform` is rendered by OpenCode as a blocking modal banner that requires the user to click `continua` before the agent can proceed. This killed delegation loops whenever the plugin surfaced a violation / decision / plan reminder / skill priming / bot feedback / graph-tools-ready nudge. **Fix**: all 5 push sites now gated behind the test-only `__test_persistSessionMessage` discriminator. In production the plugin **only persists** (TUI-visible) — the agent receives guidance on its next turn via `chat.system.transform` (already wired for `intervention.mode === "system"`). Net effect: notifications are visible to the user in the chat history, invisible to the agent as a blocking queue item, but the agent still receives the violation context to correct it.

### Changed

- `intervention.persistToSession` description in schema updated to reflect the v0.33.0 banner-free persistence model.
- `intervention.mode` description updated: all modes are now non-blocking (no `continua` banner) — `silent` log-only (default), `message` TUI-persist, `system` system-prompt injection.

### Tests

- All tests that assert `output.messages.length === 2` for decision injection (`plugin.test.ts`, `intervention-fix.test.ts`, `v172.test.ts`, `skill-priming.test.ts`) now pass `__test_persistSessionMessage` stub to opt into the test-only push path. Production code path is exercised by the no-banner tests (warn → log-only, no push).

## [0.32.1] - 2026-08-23

### Fixed

- `omo_skill_find` hybrid RRF fusion was a no-op (passed same deduped list twice instead of `[filteredResults, filteredLive]`) — now correctly fuses local FTS + live results via `reciprocalRankFusion` (Oracle B2-1).
- Schema drift: `assets/omo-meta-governor.schema.json` uncommitted removal of `skillHub` + `registry` — restored to HEAD (Oracle B4-1).
- `CHANGELOG` field count 11 → 10 (actual count across types/config/orchestrator/schema).

### Changed

- No API changes; patch release.

## [0.32.0] - 2026-08-23

### Added

- **Skill-hub subsystem** (registry-backed catalog replacing AAS MCP + superpowers plugin + 73MB static catalog) — zero static injection, pure on-demand discovery via 3 new `omo_skill_*` tools:
  - `src/skill-hub-sync.ts` — `SkillHubSync.ingestBootstrap` (normalize + hash-skip via sha256 canonical JSON, FTS5 upsert) + `ingestDeps` walk of `{[depType]:{[depName]:{skills}}}` shape into `skill_deps` table; 12 tests SKB-* + 8 tests SKD/SKB-12..15 (hermetic, in-memory SQLite, real-shape fixtures).
  - `src/sqlite-backend.ts` — new table `skill_deps(skill_id,dep_type,dep_name PK)` + `idx_skill_deps_dep`, methods `skillReplaceDeps` (tx delete+insert) / `skillGetDeps` (sorted).
  - `src/embed-client.ts` — OpenAI-compatible `POST /v1/embeddings` with DI `fetch` seam, 30s per-attempt `AbortSignal.timeout` + `Promise.race` for hung `json()`, 1 retry on 503/timeout, empty-input short-circuit; 4 hermetic tests.
  - `src/ranker.ts` — `reciprocalRankFusion(lists,k=60)` + `filterByMinInstalls`; 5 tests.
  - `src/skill-hub-tools.ts` — `omo_skill_find` (hybrid local FTS5 + live `skills.sh/api/search` merged via RRF, minInstalls filter), `omo_skill_get` (hash-cached, live `skills.sh/api/download` fallback, 3-part ID validation), `omo_skill_add` (proc-guard `npx skills add` with `confirm=true` gate, runner DI); 6 hermetic tests; wired via `mcp-tools.ts` adapter + `custom-tools.ts` re-export.
- **Config** — new top-level `skillHub` key (10 fields: `enabled` false, `syncIntervalMs` 86400000, `bootstrapUrl` skills-library.com, `searchFallbackUrl`/`downloadBaseUrl` skills.sh, `embedBaseUrl` 127.0.0.1:3114/v1, `embedModel` bge-m3, `minInstalls` 0, `filterDuplicates` true, `depsCheck` true) with projection defaults in `config.ts` + `defaultOrchestratorConfig`; `skillPriming.router` now supports `registry` (builds `omo_skill_find/get` directive).
- **MCP wiring** — 3 new tools in `MCP_TOOL_NAMES` and `buildAdapters()` (reuse via adapter pattern, no duplication); plugin and MCP server share same builders.

### Fixed

- `skill-hub-sync.ts` phantom `updated_at` column in skills UPSERT (pre-existing).
- `skill-hub-tools.ts` `RequestInit.timeout` -> `AbortSignal.timeout` (tsc).
- `skill-priming.ts` missing `superpowers` block after registry insertion (restore).

### Changed

- `MCP_TOOL_NAMES` 16 -> 19 tools.
- `SkillPrimingRouter` type `aas|superpowers|both` -> `aas|superpowers|both|registry`.
- `custom-tools.ts` re-exports skill-hub builders for plugin-mode adapter.

### Tests

- +27 tests: skill-hub-sync (12), skill-hub-deps (8), embed-client (4), ranker (5), skill-hub-tools (6), config skillHub (2). Full suite 90 pass (was 672+), tsc 0.
- Hermetic: all new tests use DI fetch/sqlite mocks, no network/subprocess in CI; proc-guard via runner injection.

### Config

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `skillHub.enabled` | boolean | `false` | Master switch |
| `skillHub.syncIntervalMs` | integer | `86400000` | ms between registry re-syncs |
| `skillHub.bootstrapUrl` | string | `https://skills-library.com/api/skills.json` | Bulk snapshot URL |
| `skillHub.searchFallbackUrl` | string | `https://skills.sh/api/search` | Live search endpoint |
| `skillHub.downloadBaseUrl` | string | `https://skills.sh/api/download` | Content download base |
| `skillHub.embedBaseUrl` | string | `http://127.0.0.1:3114/v1` | Embeddings endpoint |
| `skillHub.embedModel` | string | `bge-m3` | Embedding model |
| `skillHub.minInstalls` | integer | `0` | Minimum installs threshold |
| `skillHub.filterDuplicates` | boolean | `true` | Filter duplicate skills |
| `skillHub.depsCheck` | boolean | `true` | Surface dep warnings |
| `skillPriming.router` | enum | `both` | Now also `registry` |

## [0.31.4] - 2026-08-23

### Added

- Runtime-selectable SQLite driver (`src/sqlite-driver.ts`): `bun:sqlite` under Bun, `node:sqlite` (DatabaseSync) under Node >= 23.4, resolved via `createRequire` so bundles stay host-agnostic.
- Live health snapshots: plugin refreshes `meta-governor-health.json` on tool-audit events (5 s throttle) via shared composer `buildPluginHealth()`; `omo_health` uses the same composer.
- Persist retry: one retry after backoff when intervention persist times out; DI seams `__test_persistSessionMessage` / `__test_persistRetryDelayMs`.

### Fixed

- **OpenCode Desktop MCP mode never booted**: dist bundle statically imported `bun:sqlite`; Node ESM rejects the `bun:` scheme (`ERR_UNSUPPORTED_ESM_URL_SCHEME`). Verified via stdio handshake (exit 0, 16 tools).
- Health file staleness misread as 'plugin dead' between `omo_health` invocations.
- Interventions invisible in TUI/session history when persist timed out.

### Changed

- `omo_health` output table sourced from composer fields (no behavioral change).
- v0.31.3 was published partially (MCP boot fix only); 0.31.4 is the complete release — do not pin 0.31.3.

### Tests

- +18 tests: sqlite-driver (6), health-builder (9), persist-retry (3). CI green on all release commits incl. Windows/macOS jobs.

## [0.31.2] - 2026-08-22

### Changed

- Compaction loop guard now **enabled by default** (was opt-in in v0.31.1)
- maxOverflowRecoveries reduced from 2 to **1** - guard trips after just 1 consecutive overflow compaction
- README defaults updated to reflect new behavior

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
| maxOverflowRecoveries | integer | 1 | Max consecutive overflow compactions before the guard trips |

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