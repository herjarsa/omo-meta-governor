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

## Quick Reference

```
CODE → TEST → COMMIT → PUSH → CI GREEN → PUBLISH npm → TAG → RELEASE GitHub → UPDATE DOCS → VERIFY
```