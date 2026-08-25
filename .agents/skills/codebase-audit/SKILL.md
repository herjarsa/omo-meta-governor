---
name: codebase-audit
description: Use when the user asks for a "code audit", "security review", "hardening pass", "find gaps that prevent correct functioning", or wants a structured P0/P1/P2/P3 severity report on a TypeScript / Node / Bun / ESM codebase. Walks a 10-section checklist (subprocess safety, ESM strict-mode, defaults/schema drift, state-machine invariants, tool registration, hook return shapes, logging hygiene, test coverage floors, CI/release hygiene, distribution safety), produces findings with file paths and severity tags, and references reusable patterns from the opencode skill ecosystem (wshobson/typescript-advanced-types, sickn33/security-review, sickn33/typescript-expert, sickn33/code-review-checklist, sickn33/architect-review, hugorcd/review-logging-patterns, aj-geddes/security-audit-logging, sickn33/api-security-best-practices). Complements systematic-debugging and requesting-code-review.
---

# Codebase Audit

Structured security-and-correctness audit for a TypeScript / Node / Bun /
ESM codebase. Produces a severity-tagged findings report and is the
heavier counterpart to `systematic-debugging` (which targets a single
symptom) and `requesting-code-review` (which reviews a diff before merge).

## When to use

Use this skill when the user asks any of:

- "audit this codebase"
- "find gaps that prevent correct functioning"
- "security review" / "hardening pass" / "pen test"
- "P0/P1/P2 report"
- "is this plugin production-ready"
- "pre-release audit"
- "review the subprocess lifecycle / ESM strictness / config defaults"

Do NOT use this skill for:

- One-bug diagnosis (`systematic-debugging` is better).
- PR-style diff review (`requesting-code-review` is better).
- Performance profiling (no skill in this catalog covers it).

## What the skill produces

A markdown report with these sections:

1. Stack & scope: language, runtime, package manager, target version.
2. Method: which file ranges were read, which were sampled.
3. Findings: table with Severity | ID | Title | File:line | Repro.
4. Severity scale: P0/P1/P2/P3 with the rubric below.
5. Top fixes for next release: ordered, low-risk first.
6. Appendix: how to verify - exact commands to re-run after fixes.

### Severity rubric

| Severity | Definition | Examples |
|---|---|---|
| P0 | Functional bug in production hot path; releases should be gated on fix | `process.kill(self)` in shutdown handler; ESM `require` returning "0.0.0" version |
| P1 | Drift or inconsistency that breaks a documented feature | Defaults diverge between config.ts / orchestrator.ts / schema; IMPLEMENTATION_TOOLS doesn't match writeTools |
| P2 | Code quality / observability; not blocking | Silent failure when config not loaded; working-tree uncommitted changes; missing CI step |
| P3 | Nice-to-have / informational | Unused exports; cosmetic dead code; redundant guards |

## Procedure

### 1. Scope the audit

Read in this order:

- package.json (version, type, main, bin, exports, scripts).
- tsconfig.json (module, moduleResolution, strict, rootDir, outDir).
- .github/workflows/*.yml (CI + publish).
- README.md + CHANGELOG.md last 5 entries.
- AGENTS.md / CONTRIBUTING.md / PLAN.md if present.

State: target version, runtime, build target, dist directory.

### 2. Map the codebase

Read the entrypoint (src/index.ts / src/main.ts / src/server.ts) and
follow imports top-down. Produce a one-paragraph architecture summary
and a directory tree (depth 2). Skip node_modules / dist / .git.

### 3. Walk the 10-section checklist

The full checklist lives at
`.agents/skills/codebase-audit/CHECKLIST.md` (project-local). For each
section:

- PASS: cite file:line that proves compliance.
- FAIL: open a finding referencing this checklist section, and
  apply the severity rubric.
- N/A: note why (e.g. "no subprocess spawning in this project").

Sections, in order:

1. Subprocess & process-tree safety
2. ESM strict-mode & package resolution
3. Default-value contracts & schema drift
4. State-machine invariants
5. Tool registration completeness
6. Hook return shapes (OpenCode plugin contract)
7. Logging hygiene
8. Test coverage floors
9. CI / release hygiene
10. Distribution safety

### 4. Skill-consultation step (BEFORE declaring done)

The audit is incomplete if the auditor has not consulted at least:

- wshobson/agents/typescript-advanced-types: for any TS-typing finding.
- sickn33/antigravity-awesome-skills/typescript-expert: for ESM/strict findings.
- sickn33/antigravity-awesome-skills/security-review: for process/shutdown findings.
- sickn33/antigravity-awesome-skills/code-review-checklist: for general completeness.
- sickn33/antigravity-awesome-skills/architect-review: for state-machine findings.
- hugorcd/evlog/review-logging-patterns: for logging findings.
- aj-geddes/useful-ai-prompts/security-audit-logging: for compliance-logging findings.
- sickn33/antigravity-awesome-skills/api-security-best-practices: for peerDep/lockfile findings.

Use `omo_skill_find` (the local plugin's tool) or `npx skills find` to
browse. Cite the skill version in the appendix.

### 5. Cross-check evidence

For each P0 finding, the audit must include BOTH:

- a file:line reference proving the bug exists, AND
- a concrete reproduction step (command, input, expected vs actual output).

A finding with only prose is not a finding. A finding without a repro is
an opinion. Both are required for P0/P1.

### 6. Verify before declaring done

Run, in this order:

```
bun run typecheck     # or tsc --noEmit
bun test              # or npm test
git status --short    # no uncommitted changes
```

If any fails, downgrade the highest-severity claim in the report and
note the failure.

## Output template

```markdown
# Auditoria Completa - <project> v<X.Y.Z>

**Stack:** <lang> / <runtime> / <pm> / <target>
Tamano: <N> TS files, <M> tools, <LOC> total
Tests: <pass/fail> (<N> tests, <M> files)
Typecheck: <pass/fail>
Dist: <fresh/stale>

## Findings

| Sev | ID | Title | File:line | Repro |
|---|---|---|---|---|
| P0 | P0-1 | <title> | src/<file>:<line> | <command> |
| P1 | P1-1 | <title> | src/<file>:<line> | <command> |
...

## Top <N> fixes for next release
1. <fix> - <rationale>
2. ...

## Appendix
- Reproduction commands
- Skills consulted
- Verification log
```

## Anti-patterns the auditor must reject

- Severity inflation. Calling everything P0 erodes trust.
  Reserve P0 for bugs that break the production hot path.
- Opinion-as-finding. "The code is messy" is not a finding. "Line 47
  uses `as any` to suppress a type error introduced in v0.18.0" is.
- Checklist theater. Ticking boxes without reading the file the box
  points to. Every PASS must cite.
- Skipping the skill-consultation step (section 4 above). The audit's
  authority comes from external validation.
- Reporting bugs in untracked branches without diff context. Either
  work from `main` or include the diff excerpt.

## Composition with other skills

- systematic-debugging: when a single symptom is reported; this
  skill is for whole-codebase audits, not bug hunts.
- requesting-code-review: for diff review before merge; this
  skill is for whole-codebase health.
- writing-plans: use AFTER the audit to plan the fix sequence.
- verification-before-completion: run before declaring the audit
  report itself complete (the report's findings must each be verified).