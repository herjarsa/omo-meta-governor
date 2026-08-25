# Security & Code-Audit Checklist for `omo-meta-governor`

> **Status:** Living document. Updated by every release-audit cycle.
> **Source skills referenced:** `wshobson/agents/typescript-advanced-types`,
> `sickn33/antigravity-awesome-skills/security-review`,
> `sickn33/antigravity-awesome-skills/typescript-expert`,
> `sickn33/antigravity-awesome-skills/code-review-checklist`,
> `sickn33/antigravity-awesome-skills/architect-review`,
> `hugorcd/evlog/review-logging-patterns`,
> `aj-geddes/useful-ai-prompts/security-audit-logging`,
> `sickn33/antigravity-awesome-skills/api-security-best-practices`.
> Versions: applied 2026-08-25 based on the v0.34.1 audit.

This checklist captures the conventions that **the audited scope must follow**.
Each section is a list of testable propositions; auditors tick each one and
cite a file path + line number when an item fails.

---

## 1. Subprocess & process-tree safety (covers P0-1)

Mirrors `wshobson/agents/code-review-excellence` (Process management) and
`sickn33/security-review` (Insecure shutdown).

- [ ] **No `process.kill(process.pid, signal)` from a signal/exit handler.**
  Self-targeting kills the entire runtime. Use `process.exit(code)` or
  re-raise the signal from outside the handler.
- [ ] **`installProcessExitHandlers()` is idempotent and tear-down-safe.**
  Module-level guard flag prevents double-registration; the test seam
  resets listeners between tests.
- [ ] **`proc-guard.ts:killProcessTree` covers POSIX, win32, group-leader and
  non-group-leader cases.** Recursive `pgrep -P` walk as fallback after
  `kill(-pid, SIGKILL)` when child is not group leader.
- [ ] **Orphan sweep runs `taskkill /IM graphify.exe /F` and the
  `OMO_MG_WATCH|OMO_MG_SPAWN` PowerShell regex exactly once per plugin
  process** (one-shot latch required).
- [ ] **All `spawn` calls have a timeout AND a tree-kill fallback in their
  helper** (no naked `spawn(...)` from plugin code).

## 2. ESM strict-mode & package resolution (covers P0-3, P1-1, P2-6)

Mirrors `sickn33/typescript-expert` and `wshobson/typescript-advanced-types`.

- [ ] **No `require()` in any file compiled to ESM.** The package's
  `package.json` carries `"type": "module"`; `tsconfig.json` uses
  `module: "ESNext"`. Use `createRequire(import.meta.url)` for portable
  CJS-from-ESM, or read+parse with `node:fs`.
- [ ] **Reading `package.json` at runtime** uses a portable mechanism that
  works in both Bun and Node ESM (Bun inlines it via `bun build`; Node
  requires explicit `fs.readFile`).
- [ ] **All path-only exports use the form `"./dist/foo.js"`** (with leading
  `./`) consistently with `"main": "./dist/index.js"`.
- [ ] **Config precedence is documented in code and tested.** Single-source
  ordering rule with named priority - and the carve-out for `graphSync`
  matches the general rule.

## 3. Default-value contracts & schema drift (covers P0-4, P1-4, P2-3)

Mirrors `sickn33/architect-review` and `wshobson/code-review-excellence` -
"config drift" is the highest-frequency root cause of audit findings.

- [ ] **Every default in `config.ts` matches the corresponding `default` in
  `generate-schema.ts`.** Walk both manually or via a small bootstrap test.
- [ ] **Defaults in `config.ts` match `defaultOrchestratorConfig()` in
  `orchestrator.ts`.** Especially: `enabled`, `compactionLoopGuard.enabled`,
  `maxOverflowRecoveries`, `persistToSession`.
- [ ] **When `mergedConfig.enabled === false` AND a config file was
  loaded**, the plugin logs an info/warn line with a fix-it hint. No silent
  "I'm here, just not doing anything" mode.

## 4. State-machine invariants (covers P0-2)

Mirrors `sickn33/architect-review` - anti-pattern: signals wired but never
threaded to the consumer.

- [ ] **Any signal read by `scoring-engine.ts` is also written somewhere in
  the hot path.** Specifically audit:
  - `ctx.slotMemory.consecutiveStops` - must be derived from
    `decision-handler.countConsecutiveStops()` applied to the session's
    decision history and threaded into `MetaGovernorInput.consecutiveStops`.
  - `ctx.oracleVerified` - written from `state.oracleInvoked` (verify).
  - `ctx.iterationRatio` - written from `iteration / maxIterations`
    (verify).
- [ ] **Per-state-shape fields used downstream appear in every constructor
  site for that state** (e.g. `recentPwArgsHashes` in 3 places - `tool.execute.before`,
  `tool.execute.after` lazy init, `experimental.chat.messages.transform`
  lazy init). Grep the type definition and confirm each member has a value
  in every initializer.
- [ ] **All `auditSessions.get(sessionID)` consumers handle `undefined`
  gracefully** (lazy-init from defaults). No field access on a possibly-
  undefined state.
- [ ] **The two maps keyed by sessionID are kept distinct:**
  `auditSessions: AuditStateCache<AuditState>` (TTL/LRU) vs
  `postWaveSessions: Map<string, PostWaveSessionState>` (unbounded - watch
  this). The unbounded map is acceptable only if TTL is added or it's
  documented as session-scoped.

## 5. Tool registration completeness (covers P1-5, P1-6, P2-5)

- [ ] **Each `omo_*` tool with a non-zero install base also exists in the
  plugin's `tool:` object AND the MCP server's adapter list.**
- [ ] **`IMPLEMENTATION_TOOLS` in `skill-priming.ts` matches the
  `writeTools` list in `plugin.ts:tool.execute.after`** (with explicit
  rationale for any divergence). The two lists feed different signals but
  must be consistent.
- [ ] **`bypass-via-bash` check:** `bash` with `cat << EOF > file` or
  `echo ... > file` is **not** in `IMPLEMENTATION_TOOLS`. If the
  `enforceMode='block'` gate is to be meaningful, audit state must track
  which bash commands write files (the audit can do this without
  executing the command - extract the redirect target from the bash argv
  token).

## 6. Hook return shapes (OpenCode contract)

- [ ] **`tool.execute.before` returns a `Promise<void>`.** The
  `enforceMode='block'` path **throws** rather than returning - verify
  the OpenCode loader treats throws in tool.execute.before as a hard
  reject on the tool call.
- [ ] **`experimental.chat.messages.transform` returns a `Promise<void>`.**
  Mutates `output.messages`. No return value contract.
- [ ] **`experimental.chat.system.transform` returns a `Promise<void>`.**
  Pushes strings to `output.system`.

## 7. Logging hygiene (covers P0-3 follow-up, P2-3)

Mirrors `hugorcd/evlog/review-logging-patterns`.

- [ ] **Every `console.log/console.error/console.warn` is routed through
  `logToFile`** (writes to `~/.config/opencode/meta-governor.log`).
- [ ] **No secrets or session-content leaks to logs.** The plugin logs
  `toolName`, hashed IDs, and decision reasoning - NOT raw tool args or
  LLM output bodies.
- [ ] **Log levels are meaningful.** `info` = lifecycle; `warn` =
  recoverable degradation; `error` = unrecoverable. CLI usage: `error` to
  stderr, `warn` and `info` to the log file.
- [ ] **The "STALE_CACHE" detector uses `logToFile("warn", ...)`**, not
  `console.warn` (which leaked into the TUI in v0.26.1).

## 8. Test coverage floors

- [ ] **Each P0 finding has at least one regression test** that exercises
  the failure mode in isolation. Examples to add:
  - `consecutiveStops` threading - assert `slotMemory.consecutiveStops >= 3`
    after a fixture history of stops.
  - `process.kill(process.pid, signal)` self-target - assert the signal
    handler does not call `process.kill(self, ...)` directly (lint or AST
    rule).
  - `require("../package.json")` in ESM - assert the dist bundle version
    is non-zero.
  - `compactionLoopGuard.enabled` default - assert the projected
    `OrchestratorConfig` default for users who don't set the field.
- [ ] **Hermetic tests use the DI seams** (`__test_runGraphSync`,
  `__test_runCliAnythingSync`, `__test_persistSessionMessage`,
  `__test_persistRetryDelayMs`, `__test_onCommitTrigger`,
  `__test_onGraphSyncInit`). Never mock via `mock.module()` (leaks across
  test files in Bun).

## 9. CI / release hygiene (covers P1-3, P2-2, P2-7)

- [ ] **`publish.yml` has a `gh release create` step** matching AGENTS.md
  contract. Today's gap.
- [ ] **Every release bumps `README.md`**, `ARCHITECTURE.md`,
  `STRUCTURE.md`, `CHANGELOG.md` - either manually or via a docs-bump job.
- [ ] **`npm pack --dry-run` lists `dist/` plus the published `files`
  field.** No `.env*`, no `node_modules/`, no `bun.lock`.
- [ ] **`package.json` repo URL** uses the `https://github.com/...` form
  (not the `git+https` form, which npm propagates as the package homepage).
- [ ] **Working tree has no uncommitted changes** before tagging.

## 10. Distribution safety (covers P2-6)

- [ ] **`dependencies` field empty**, all deps in `devDependencies` or
  `peerDependencies`.
- [ ] **`@opencode-ai/plugin` peerDep floor matches the runtime contract.**
  Plugin loads under 1.18.x; document minimum in README.
- [ ] **Built `dist/mcp-server.js` standalone-bundle includes the
  schema/types** needed by the MCP transport (no missing imports).

---

## Audit-run protocol (how to use this checklist)

1. Open an issue titled `audit/vX.Y.Z` with the target version.
2. Walk each section top-to-bottom. For each item:
   - PASS - link the file/lines that prove compliance.
   - FAIL - file a P0/P1/P2 finding referencing this checklist section.
3. After audit-cycle close, update `.agents/skills/codebase-audit/CHECKLIST.md`
   with any new anti-patterns discovered.
4. Convert "PASS evidence" into either:
   - a regression test (preferred - see section 8), OR
   - a comment citation in the relevant source file.
5. Re-run `bun run typecheck && bun test` and CI before tagging the release.