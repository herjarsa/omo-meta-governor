# AGENTS.md — OMO MetaGovernor Workflow Protocol

## Non-Negotiable Shipping Protocol

**Every feature, fix, or refactor that touches production code MUST complete this full cycle before the task is considered done.**

### 1. Commit & Push

- One atomic commit per verified logical unit. Never batch unrelated changes.
- Conventional commit format: `feat(scope):`, `fix(scope):`, `docs(scope):`, `test(scope):`.
- Push immediately after every verified commit. Local-only work is incomplete work.

### 2. CI Verification Loop (NON-NEGOTIABLE)

After **every** push:

```
gh run watch <run-id> --exit-status
```

- Assert `conclusion == "success"` on **every** job.
- If any job fails → fix the regression, re-push, re-verify. **Never proceed on red CI.**
- At the **end of the task** (all steps done), run final guarantee:

```
gh run list --branch <branch> --limit 5
```

Assert **every** recent run on this branch has `conclusion=success`. If any run shows failure, surface it with run-id, failing job, and log excerpt. **Do NOT claim task success while a recent CI run is red.**

### 3. Release to npm

Once CI is green for the final commit:

### 3b. Automated release (v0.38.0+)

Instead of running steps 1-4 manually, use the release script:

```bash
bun run release 0.38.0              # actual release
bun run release 0.38.0 --dry-run    # validate without executing
```

The script (`scripts/release.ts`) automates:
- Bump version in package.json
- Validate CHANGELOG has `### Ship protocol compliance` section with ✅ markers
- Run tests, build, publish to npm
- Create git tag, push tag
- Create GitHub release with notes-file (avoids PowerShell backtick escaping)

The script aborts on any step failure. Exit code 0 = success.

1. Ensure `package.json` version is correct (bump if needed).
2. `npm publish` — verify the publish succeeds.
3. Confirm the package appears on npm: `npm view @herjarsa/omo-meta-governor version`.

### 4. GitHub Release

After npm publish:

1. Tag the commit: `git tag v<version>`.
2. Push the tag: `git push origin v<version>`.
3. Create a GitHub release with release notes:

```
gh release create v<version> \
  --repo herjarsa/omo-meta-governor \
  --title "v<version> — <one-line summary>" \
  --notes "<detailed release notes>"
```

Release notes MUST include:
- **Added** — new features, tools, config options.
- **Fixed** — bug fixes with root cause.
- **Changed** — breaking changes, deprecations.
- **Tests** — count delta, suite total, new test IDs.
- **Config** — any new/changed config fields with defaults.

### 5. Documentation Update

After every release, verify and update as needed:

| Document | When to update |
|----------|---------------|
| `CHANGELOG.md` | Every release — add entry with date, features, fixes, commits |
| `README.md` | New features, config changes, tool additions/removals |
| `ARCHITECTURE.md` | New subsystems, subsystem changes, tool count changes |
| `STRUCTURE.md` | New files, moved files, deleted files |
| `assets/omo-meta-governor.schema.json` | Any config schema change |

### 6. Oracle Review Gate

**Trigger:** any implementation or modification that:
- Touches 3+ files
- Changes core plugin logic (scoring, governance, audit, intervention)
- Adds/removes `omo_*` tools
- Modifies the config schema
- Affects CI/publish pipeline
- Is a security-sensitive change

**Process:**
1. Complete the implementation.
2. Fire Oracle with: goal, file list, diff summary, test results.
3. Wait for Oracle response before proceeding.
4. Address every **criterion-cited blocker** from Oracle.
5. Re-run only the affected test scenarios after fixes.
6. Surface any remaining Oracle concerns to the user — do NOT loop further than 2 re-reviews.

---

## Skill Workflow — Pick the Level that Matches the Risk

Before touching code, classify the work into one of three tiers. The plugin does not enforce this — it is a guide you (the agent) follow. Apply judgement.

### Tier 0 — Trivial (skip the workflow)

**Trigger**: config tweak, doc edit, log message, single-line fix, comment change, dependency bump with no behavior delta.

**Required steps**: edit → `bun run typecheck` → done.

**Forbidden**: do NOT call `brainstorming`, `writing-plans`, `dispatching-parallel-agents`, or `momus`. Skip ceremony.

### Tier 1 — Standard (default)

**Trigger**: any new feature or fix that changes behavior in >= 1 file but does NOT touch 3+ files, core plugin logic, the config schema, CI/publish, or anything security-sensitive.

**Required steps**, in order:

1. **`/mo-skill:brainstorming`** — clarify intent, requirements, design. Skip if the user has already specified the implementation concretely.
2. **`/mo-skill:find-skills`** — search the catalog for relevant techniques (Python, TDD, debugging, etc.). The `omo_skill_find` tool also unlocks the skill-priming gate (v0.35.3 also recognises `omo_skill_add` / `omo_skill_get`).
3. **`/mo-skill:test-driven-development`** — write the failing test FIRST, watch it RED, then implement to GREEN. Capture the RED output as evidence.
4. **`/mo-skill:verification-before-completion`** — before claiming done, run the verification commands and paste output. No "should work" assertions.
5. **`/mo-skill:dispatching-parallel-agents`** — if >= 2 independent surfaces, fan out to parallel agents. Otherwise skip.
6. Commit, push, wait for CI green. See Non-Negotiable Shipping Protocol below.

### Tier 2 — Critical (full ceremony)

**Trigger**: ANY of:
- Touches 3+ files
- Changes core plugin logic (scoring, governance, audit, intervention)
- Adds or removes an `omo_*` tool
- Modifies the config schema
- Affects CI or publish
- Security-sensitive change
- Refactor of > 1 module

**Required steps**: ALL of Tier 1, **plus**:

7. **`/mo-skill:writing-plans`** — write a decision-complete plan to `.omo/plans/*.md` before touching code.
8. **`/mo-skill:subagent-driven-development`** — execute the plan via parallel subagents (not by hand).
9. **`/mo-skill:requesting-code-review`** — after implementation, fire a reviewer agent. Address every **criterion-cited blocker**.
11. **`/mo-skill:finishing-a-development-branch`** — once CI is green and review passes, decide merge strategy.

**Forbidden**: do NOT skip TDD or verification. Do NOT commit without a failing test preceding the implementation in your notepad.

### Cheat sheet

| Tier | Skills invoked (in order) | Cost |
|---|---|---|
| 0 Trivial | none | 30s |
| 1 Standard | brainstorming -> find-skills -> TDD -> verification-before-completion | ~5 min |
| 2 Critical | + writing-plans -> subagent-driven-development -> requesting-code-review -> finishing-a-development-branch | ~30+ min |

When in doubt, go up one tier. The cost of over-ceremony is 5 minutes; the cost of skipping it is a broken commit + a 2-hour revert.

---

## Quick Reference

```
CODE → TEST → COMMIT → PUSH → CI GREEN → PUBLISH npm → TAG → RELEASE GitHub → UPDATE DOCS → VERIFY
```