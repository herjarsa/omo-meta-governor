---
title: Skills Resolution — 3-Tier Architecture
date: 2026-08-26
status: approved
version_target: 0.35.0
---

# Skills Resolution — 3-Tier Architecture

## Problem

Today the plugin treats skills as a single registry sourced from the
skills-hub (`https://skills-library.com/api/skills.json`, with fallback to
`https://skills.sh/api/search`). It ignores the canonical chore skills
shipped with the agent runtime at `~/.agents/skills/`, and it never writes
a skill to the project directory so opencode can see it as a real file.

The user wants the plugin to behave like `obra/superpowers` — chore skills
always present, hub as a fallback, custom generation as a last resort —
without losing the v0.32.0 skill-hub catalog work.

## Goals

- The plugin reads chore skills from `~/.agents/skills/` and treats them
  as Tier 1 (always available, never written by the plugin).
- The plugin bootstraps the chore set on first run from a bundled tarball
  shipped with the plugin npm package.
- The plugin materializes hub skills to `<cwd>/.agents/skills/<slug>/SKILL.md`
  on `omo_skill_get` so opencode can `Read()` them.
- The plugin recommends (never forces) the creation of a new skill via the
  `writing-skills` chore skill when hub and chore both miss.
- The agent (not the plugin) decides which skill to use per task. The
  plugin only enriches the registry; it never injects skill content into
  prompts.

## Non-Goals

- No skill auto-execution. The plugin does not run a skill on the agent's
  behalf.
- No skill versioning system. The bundled manifest records the bundled
  version; upgrade policy is a future question.
- No skill marketplace UI. Catalog discovery stays via `omo_skill_find`.
- No fork of superpowers. We reuse the same skill files where applicable
  (specifically the `writing-skills` flow) but do not depend on superpowers
  being installed.

## Architecture

Three registries, one resolver, one materialization side effect, one
advisory reminder layer.

```
Plugin Boot
  ├── bootstrapChoreSkills()  -> materialize bundled tarball to ~/.agents/skills/
  ├── scanSkillsFs()          -> build in-memory index of chore + custom
  ├── runSkillHubSync()       -> refresh SQLite catalog from hub
  └── startSkillsFsWatcher()  -> rescan on writes to cwd/.agents/skills/

Query path (omo_skill_find / omo_skill_get)
  ├── search project-local  (cwd/.agents/skills)  <- tier 3 + tier 2 materialized
  ├── search chore global   (~/.agents/skills)    <- tier 1
  └── search hub SQLite                              <- tier 2 metadata only

On hub hit -> write SKILL.md to cwd/.agents/skills/<slug>/
On zero results -> inject advisory reminder (tier 3)

Tier 1 (chore)  ---+
Tier 2 (hub)    ---+--> resolver --> SkillDescriptor --> agent
Tier 3 (custom) ---+
```

## Layers

### Tier 1 — Chore (global, bundled, read-only)

- Source: filesystem at `~/.agents/skills/<slug>/SKILL.md`.
- Bootstrap: on first run, extract `dist/skills/chore.tar.gz` (bundled in
  the npm package) into `~/.agents/skills/`. Idempotent: skip slugs whose
  existing `SKILL.md` has the same SHA-256 as the bundled copy.
- Hash mismatch (user modified): skip, log warn. Never overwrite.
- Manifest: `~/.agents/skills/.omo-meta-governor-checksums.json` records
  per-slug hash and the plugin version that shipped them.
- Precedence: project-local `cwd/.agents/skills/` wins over global for
  the same slug.
- Read-only: the plugin never writes to `~/.agents/skills/`.
- Initial bundled set: the 16 skills currently in the user's runtime
  (`brainstorming`, `using-superpowers`, `writing-plans`, `writing-skills`,
  `TDD`, `verification-before-completion`, `systematic-debugging`,
  `find-skills`, `dispatching-parallel-agents`, `executing-plans`,
  `subagent-driven-development`, `using-git-worktrees`,
  `finishing-a-development-branch`, `requesting-code-review`,
  `receiving-code-review`, `codebase-audit`).

### Tier 2 — Hub (SQLite catalog + lazy materialization)

- Source: existing `skill-hub-sync.ts` ingest into SQLite `skills` table.
- Query: existing `omo_skill_find` searches the catalog (FTS5).
- Materialization: existing `omo_skill_get` now writes the fetched body to
  `<cwd>/.agents/skills/<slug>/SKILL.md` before returning, gated by:
  - `skillHub.autoMaterialize` config flag (default `true`).
  - Idempotent write if local hash matches fetched hash.
  - Skip + warn on hash mismatch with existing local file.
- New column in SQLite: `skills.last_materialized_at` (TIMESTAMP, NULL
  default). Set on successful write.
- New config field: `skillHub.autoMaterialize: boolean` (default `true`).
- New metric: `materializationFailures` counter on `omo_health`.

### Tier 3 — Custom (project-local, advisory generation)

- Source: filesystem at `cwd/.agents/skills/<slug>/SKILL.md`.
- Trigger: when `omo_skill_find` returns zero results across all tiers.
- Behavior: emit a single system reminder to the next agent turn. The
  reminder is advisory; the agent decides whether to invoke
  `writing-skills`.
- Detection: fs watcher on `cwd/.agents/skills/` triggers rescan on any
  `create` or `write` matching `**/SKILL.md`.
- Source attribution: skills created this way are tagged `source: 'custom'`
  in the resolver index, distinct from `source: 'hub-materialized'`.
- Frontmatter: not strictly validated. Missing frontmatter degrades the
  search result but does not break the plugin.
- Circuit breaker: at most 1 reminder per session per query. After 3
  reminders with no action in the session, stop emitting. Counters visible
  in `omo_health` (`tier3RemindersSent`, `tier3SkillsCreated`).

### Resolver — unified query layer

- New file `src/skills-resolver.ts` exports `findSkill(slug)` and
  `searchSkills(query, opts)`.
- Both are pure: no side effects, no network, no fs mutation.
- Precedence: project-local > chore global > hub catalog.
- Tier filter: `tier: 'all' | 'chore' | 'custom' | 'hub'`.
- Response shape (additive, not breaking):
  ```ts
  interface SkillDescriptor {
    slug: string;
    name: string;
    description: string;
    source: 'chore' | 'hub-materialized' | 'custom' | 'hub';
    tier: 1 | 2 | 3;
    path: string | null;  // null for hub-catalog-only entries
    contentHash: string | null;
  }
  ```
- Dedup by `slug`. Higher tier wins on collision. No merging.

## Component Map

| File | Purpose | New/Modified |
|---|---|---|
| `src/skills-fs.ts` | Frontmatter parser + fs scanner | new |
| `src/skills-bundled.ts` | Constants: `CHORE_SKILLS: string[]` | new |
| `src/skills-bootstrap.ts` | Tarball extraction + hash check + manifest | new |
| `src/skills-resolver.ts` | Unified `findSkill` + `searchSkills` | new |
| `src/skills-materialize.ts` | Write SKILL.md to cwd on hub fetch | new |
| `src/skills-tier3-reminder.ts` | Advisory reminder with rate limiting | new |
| `src/skills-fs-watcher.ts` | Watch `cwd/.agents/skills/` for writes | new |
| `src/skill-hub-tools.ts` | `omo_skill_find` + `omo_skill_get` delegate to resolver; materialize on get | modified |
| `src/custom-tools.ts` | Replace scattered skill queries with resolver | modified |
| `src/ranker.ts` | Accept unified descriptor, no tier special-cases | modified |
| `src/health.ts` | New counters: `tier3RemindersSent`, `tier3SkillsCreated`, `materializationFailures` | modified |
| `src/config.ts` | New field `skillHub.autoMaterialize: boolean` (default `true`) | modified |
| `src/plugin.ts` | Boot sequence: bootstrap -> scan -> hub sync -> watcher | modified |
| `src/sqlite-backend.ts` | New column `skills.last_materialized_at` | modified |
| `build.ts` | New task `build:skills` -> packs `bundled-skills/` into `dist/skills/chore.tar.gz` | modified |
| `bundled-skills/` | Source directory: copies of the 16 chore skills | new |
| `assets/omo-meta-governor.schema.json` | Document `skillHub.autoMaterialize` field | modified |
| `CHANGELOG.md` | v0.35.0 entry | modified |
| `README.md` | New section "Skills system: 3-tier resolution" | modified |
| `ARCHITECTURE.md` | New subsystem `skills-resolution` | modified |
| `STRUCTURE.md` | List new files | modified |

## Data Flow Examples

### Example 1 — Agent asks for `brainstorming`

1. Agent calls `omo_skill_find({ query: "brainstorming" })`.
2. Resolver searches project-local -> miss.
3. Resolver searches chore global -> hit (`source: 'chore'`, `tier: 1`,
   `path: 'C:\\Users\\herna\\.agents\\skills\\brainstorming\\SKILL.md'`).
4. Returns single descriptor to agent.
5. Agent calls `Read(path)` to load the skill content.

### Example 2 — Agent asks for `vercel-deploy-cli`

1. Agent calls `omo_skill_find({ query: "vercel deploy cli" })`.
2. Resolver searches project-local -> miss.
3. Resolver searches chore global -> miss.
4. Resolver searches hub SQLite (FTS5) -> hit (`source: 'hub'`, `tier: 2`,
   `path: null`, no body yet).
5. Returns metadata descriptor. Tells agent: "skill found in hub, no
   local copy yet".
6. Agent calls `omo_skill_get({ slug: "vercel-deploy-cli" })`.
7. Plugin fetches body from `downloadBaseUrl`.
8. Plugin writes body to `cwd/.agents/skills/vercel-deploy-cli/SKILL.md`.
9. Plugin sets `last_materialized_at` in SQLite.
10. Plugin rescans project-local registry.
11. Plugin returns the body to the agent.
12. Agent calls `Read(cwd/.agents/skills/vercel-deploy-cli/SKILL.md)`.

### Example 3 — Agent asks for something with no hub match

1. Agent calls `omo_skill_find({ query: "omegazero-edge-cache" })`.
2. Resolver searches all three tiers -> miss.
3. Returns `[]` plus a flag `zeroResults: true`.
4. `skills-tier3-reminder` emits advisory reminder on next agent turn.
5. Agent reads reminder, decides to invoke `writing-skills` (chore skill,
   always available).
6. Agent follows writing-skills flow, writes
   `cwd/.agents/skills/omegazero-edge-cache/SKILL.md`.
7. `skills-fs-watcher` detects the write, triggers rescan.
8. New skill appears in resolver as `source: 'custom'`, `tier: 3`.
9. Subsequent calls to `omo_skill_find` return it.

## Error Handling

| Layer | Failure | Behavior |
|---|---|---|
| Bootstrap chore | tarball corrupt | warn log, tier 1 empty |
| Bootstrap chore | write denied | warn log, tier 1 empty |
| Scan fs | dir inaccessible | warn log, that registry empty |
| Hub sync | network error | warn log, tier 2 metadata empty |
| Materialize | write denied | warn log, return content inline |
| Materialize | hash mismatch with local | warn log, return local content |
| Tier 3 reminder | rate limited | silent skip |
| Fs watcher | dir missing | no-op, no error |

The plugin must boot successfully even if every layer fails. Boot
failures are warnings, not errors. Only true unrecoverable conditions
(missing manifest, schema mismatch) throw.

## Testing Strategy

### Unit tests (no network, no real fs)

| File | Tests |
|---|---|
| `src/skills-fs.test.ts` | 4 — frontmatter parser |
| `src/skills-bootstrap.test.ts` | 4 — extraction, hash, idempotency, manifest |
| `src/skills-resolver.test.ts` | 8 — precedence, dedup, filter, fallback |
| `src/skills-materialize.test.ts` | 4 — write, fail, hash check, idempotent |
| `src/skills-tier3-reminder.test.ts` | 3 — rate limit, circuit breaker, format |
| `src/skills-fs-watcher.test.ts` | 2 — detect create, ignore other paths |

### Integration tests (tempdir fs, mocked network)

| File | Tests |
|---|---|
| `src/skills-integration.test.ts` | 4 — end-to-end resolution, materialization, tier-3 rescan, precedence end-to-end |

### Config tests

| File | Tests |
|---|---|
| `src/config.test.ts` | +2 — `skillHub.autoMaterialize` default + override |

**Total new tests: 29**.

## Release Plan

v0.35.0 (minor bump, additive only, no breaking changes).

Four atomic commits, each Oracle-reviewed before the next:

1. `feat(skills): add skills-fs scanner + chore bootstrap`
   — Tier 1 only, no hub changes.
2. `feat(skills): add resolver with unified tier precedence`
   — Centralizes queries; resolver is in-memory, no side effects.
3. `feat(skills): add tier-2 materialization to project .agents/skills`
   — Writes SKILL.md to project fs on hub fetch.
4. `feat(skills): add tier-3 advisory reminder + fs watcher`
   — Advisory generation path + hot-reload of project-local skills.

Each commit:
- Adds new tests.
- Runs `bun test` (all green).
- Runs `npx tsc --noEmit` (clean).
- Runs `bun run build` (succeeds).
- Goes through Oracle review (per AGENTS.md §6).
- CI run watches to conclusion (`gh run watch`).

Final commit:
- Bumps version to `0.35.0`.
- Updates CHANGELOG, README, ARCHITECTURE, STRUCTURE.
- Builds `dist/skills/chore.tar.gz` via `bun run build:skills`.
- Publishes to npm.
- Tags `v0.35.0`.
- Creates GitHub Release.

## Open Questions Deferred

These are intentionally out of scope for v0.35.0:

1. **Auto-upgrade of bundled skills**: when plugin version bumps and a
   bundled skill has a new version, should we offer to upgrade user-modified
   copies? Recorded as a future question; current policy is "skip + warn".
2. **Cross-project skill sharing**: should `cwd/.agents/skills/` symlink to
   a shared location for multi-repo projects? Not asked for; not built.
3. **Skill versioning in custom tier**: should custom skills support
   `version:` in frontmatter for upgrade detection? Not asked for.
4. **Telemetry on skill usage**: should the plugin track which skills the
   agent actually invokes (vs just finds)? Useful, but privacy-sensitive
   and out of scope.
5. **Allowlist of trusted hub owners**: should the plugin refuse to
   materialize skills from unknown owners? User decided "no filter" for
   v0.35.0; can be added later without breaking changes.
