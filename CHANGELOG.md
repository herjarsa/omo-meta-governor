# Changelog

All notable changes to `@herjarsa/omo-meta-governor` are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/).

## [0.33.5] - 2026-08-25

### Fixed

- **omo_health banner reported stale version (0.33.3) after v0.33.4 release**: bun build inlines package.json into each bundle entrypoint as a JS object literal. The v0.33.3 build captured version 0.33.3 into dist/mcp-server.js / dist/lib.js / dist/index.js, and bumping package.json to 0.33.4 after that build did not update the inlined copy. Result: the plugin ran v0.33.4 code but the banner lied. Fix: regression test in src/version-sync.test.ts reads both package.json and each dist/*.js entrypoint and asserts the inlined version matches. Any future release that bumps version without rebuilding will fail CI immediately. Also rebuilt dist/ so the running bundle now reports v0.33.5.

### Tests

- New: src/version-sync.test.ts — 3 assertions across 2 describes, pins the inline-vs-disk version invariant.
- Full suite: 843/844 (1 pre-existing proc-guard flaky untouched).
- TypeScript clean (tsc --noEmit).
- bun build.ts green.

## [0.33.4] - 2026-08-25

### Fixed

- **Schema missing `postWave` and `graphRetrieval` blocks**: the regenerated v0.33.3 schema still omitted two important top-level keys present in `MetaGovernorPluginConfig` (`postWave` since v0.21.0, `graphRetrieval` since v0.25.0). Real user configs using either were silently accepted by the runtime (no validation) but didn't get IDE autocomplete. Fix: added both blocks to `src/generate-schema.ts` with all sub-properties and defaults matching `loadOrchestratorConfig` projections, plus 2 regression tests in `generate-schema.test.ts`, regenerated the asset via `bun build.ts`.
- **Three remaining `loadMetaGovernorConfig` tests still leaked real user config**: `cliOptions only`, `cliOptions with nested values`, and `empty cliOptions` all read `~/.config/opencode/omo-meta-governor.jsonc` on disk, so they were fragile to any developer machine that had fields injected. Promoted the v0.33.3 isolation helper to the parent `loadMetaGovernorConfig priority` describe so all four tests share the same tmpdir `beforeEach` / `afterEach`. The `empty cliOptions` assertion was rewritten from `effectiveSource === "defaults"` (wrong: a valid empty `{}` file IS a source) to a shape check verifying none of the real-config keys leaked in.

### Tests

- `generate-schema.test.ts`: 2 new describes (`postWave` v0.21.0 shape, `graphRetrieval` v0.25.0 enum). 21/21 pass / 117 expect() calls.
- `config-file.test.ts`: shared isolation helper at parent describe. 25/25 pass / 39 expect() calls.
- TypeScript clean (`tsc --noEmit`).
- `bun build.ts` green; `JSON.parse` on asset succeeds.

## [0.33.3] - 2026-08-25

### Fixed

- **JSON schema asset was stale + invalid JSON** (`assets/omo-meta-governor.schema.json`): the working copy of the schema asset was reverted to a pre-v0.19 snapshot (missing the `skillHub` block, `skillPriming.router` enum lacking the `'registry'` value, `skillPriming.enabled` default still `false`, `router` default still `'both'`), AND the committed version had a syntax error (`mode.enum` had the value `system` without quotes, breaking `JSON.parse`). Without regeneration the IDE autocomplete and runtime config validation were both broken: real user configs using `skillHub` and `router: "registry"` were rejected. Fix: restored the `skillHub` block (10 sub-properties from `config.ts`) and the v0.33.1 `skillPriming` defaults in `generate-schema.ts`, added regression tests (`generate-schema.test.ts`), and regenerated the asset via `bun build.ts`. The asset is now both valid JSON and in sync with `MetaGovernorPluginConfig`.
- **Flaky `loadMetaGovernorConfig > nested overrides merge` test** (`config-file.test.ts`): leaked real user/project config from disk (`~/.config/opencode/omo-meta-governor.jsonc` has `tokenPredictor` defined), so the assertion `expect(result.config.tokenPredictor).toBeUndefined()` failed on developer machines even though it passed in CI. Fix: extended `ConfigFileSources` with an optional `userConfigPath` test seam, and the test now writes empty JSONC stubs into a tmpdir and points both `projectDir` and `userConfigPath` at them for full isolation. The default `~/.config/opencode/...` lookup is unchanged in prod.

### Tests

- `generate-schema.test.ts`: 4 new assertions (router enum includes `registry`, router default = `"registry"`, `skillPriming.enabled` default = `true`, full `skillHub` block shape). 19/19 pass / 100 expect() calls.
- `config-file.test.ts`: isolated fixture for the `cliOptions` deep-merge test. 25/25 pass / 36 expect() calls.
- Full suite: 843/844 pass (1 pre-existing flaky in `proc-guard.test.ts` > `runGuarded > times out and resolves`, unrelated to this fix — timing-sensitive when the full suite stresses process spawning).
- TypeScript clean (`tsc --noEmit`).
- `bun build.ts` green; `node -e "JSON.parse(...)"` on the asset succeeds.

## [0.33.2] - 2026-08-24

### Fixed

- **Session-killer persistence (root cause fix)**: v0.33.0 stopped pushing `role:"user"` banners in prod, but `persistIntervention` still called `session.prompt()` (which queues a real user message). Subagent sessions, plan agents, and skill-priming re-injection paths were all being killed when the user message arrived. Fix: `persistIntervention` is now **log-only in prod** — writes to the plugin log file + health snapshot, never queues a prompt. The agent still receives governance context via `chat.system.transform` on its next turn; the user still sees the notification in TUI history (assistant-role, non-blocking).
- **All 6 message injection sites converted to assistant role in prod**: skill priming, graph-tools-ready, bot feedback, plan reminder, violations, decision injection. Test seam still pushes `role:"user"` so existing assertions stay green.
- **Violations no longer inject via messages.transform in prod** (were still firing as blocking banners for grave/MEDIA): now fire only in test runs; prod surfaces them via `chat.system.transform` + log file.

### Removed

- **`oh-my-openagent` plugin dropped from `~/.config/opencode/opencode.jsonc`**: this plugin auto-registers the `aas` MCP (Agent-Augmented Search / SkillHub) which is retired in v0.32.0+. With `oh-my-openagent` removed the `aas` MCP no longer appears in the sidebar. The `superpowers` plugin that ships alongside it is also gone. Users who want the agentic features can opt back in by re-adding it.

### Tests

- 6/6 affected test files green: `plugin.test.ts`, `skill-priming.test.ts`, `v173-gap-d.test.ts`, `compaction-loop-guard.test.ts`, `plugin-graphsync.test.ts`, `config.test.ts`. 99 tests pass / 0 fail / 193 expect() calls.
- TypeScript clean (`tsc --noEmit`).

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
  - `src/skill-hub-tools.ts` — 3 new MCP tools (`omo_skill_find` hybrid local+live with RRF + minInstalls; `omo_skill_get` content+deps from local SQLite; `omo_skill_add` registry install via skills.sh with bootstrap snapshot hash-skip); 7 hermetic tests.
- **v0.25.0 codegraph/graphify routing** (`src/graph-retrieval.ts`, exposed via 4 `omo_*` tools):
  - `omo_search` auto routes to codegraph `explore` or graphify `query` based on query shape; manual override via `graphRetrieval.preferredTool` (`auto`/`codegraph`/`graphify`/`alternate`).
  - `omo_files` lists indexed files via codegraph `files` or graphify `wiki/index.md` fallback.
  - `omo_status` reports codegraph node count, version, last update.
  - `omo_sync_if_dirty` cheap sync trigger gated on dirty flag (no-op when clean).
- **`postWave` orchestration** (`src/postwave-gate.ts`): Oracle-approved wave landing with CI monitor + directive re-injection cooldown. `respectSilentMode` opt-out, `repoMode: auto|own|third-party`, `aasToolPrefix` configurable.
- **Closed-loop learning** (`src/closed-loop-learning.ts`): auto-save decisions + lessons to AgentMemory SQLite based on `minSeverityToLearn`.
- **Decision-handler** (`src/decision-handler.ts`): history-trimmed decision cache per session, `forceContinueAfterStops` escalation ladder.
- **Token-predictor** (`src/token-predictor.ts`): burn-rate thresholds for compact/switch-model/delegate interventions.
- **Graph-sync auto-init** (`src/graph-sync.ts`): on plugin load, ensures `codegraph` (npx) + `graphify` (pip) are installed; auto-upgrades v0.26+; sweeps orphaned processes on init.
- **`omo-meta-governor-mcp` standalone binary**: optional MCP server entrypoint for users who want the plugin tools without loading the plugin (config-driven).
- **`assets/omo-meta-governor.schema.json`**: JSON Schema (draft-07) for IDE autocomplete on `omo-meta-governor.jsonc`.
- **AGENTS.md, ARCHITECTURE.md, STRUCTURE.md**: full governance / shipping / docs protocol.

### Changed

- `package.json` `version` bumped to 0.32.0; renamed repo slug from `omo` to `omo-meta-governor`.
- Build pipeline (`build.ts`): now emits dist/index.js, dist/lib.js, dist/mcp-server.js (ESM, node target, minified) + .d.ts declarations; also regenerates the JSON schema asset.
- 73MB static catalog (`graphify-out/catalog*.json.gz`) deleted; replaced by zero-static registry sync.
- Removed dependencies: aas MCP (retired), superpowers plugin (auto-registered via oh-my-openagent).

### Tests

- New test files: `skill-hub-sync.test.ts` (12), `sqlite-backend.test.ts`, `embed-client.test.ts`, `ranker.test.ts`, `skill-hub-tools.test.ts` (7), `skill-hub-deps.test.ts` (8), `closed-loop-learning.test.ts`, `decision-handler.test.ts`, `token-predictor.test.ts`, `graph-retrieval.test.ts`, `postwave-gate.test.ts`, `postwave-wire.test.ts`, `plugin-graphsync.test.ts`, `e2e.test.ts`, `integration.test.ts`, `mcp-tools.test.ts`, `generate-schema.test.ts` (15), `custom-tools.test.ts` (Wave 3 P2 33-tool surface), `plugin.test.ts` (Wave 3), `index.test.ts`, `multiphase-gap.test.ts`, `upgrade-fix.test.ts`, `cli-anything.test.ts`, `cli-anything-sync.test.ts`.
- Total: 200+ tests across 27 files. Full suite green.

[Older history elided — see git log for pre-0.32.0 entries.]
