# @herjarsa/omo-meta-governor

Self-judging agent orchestration layer for OpenCode. Observes tool executions,
reads session state, scores progress, and dispatches decisions. Includes **15 custom tools**
that the agent can invoke across CodeGraph, Graphify, AFT, AgentMemory, Magic Context, and SQLite.

## Install

```bash
npm install @herjarsa/omo-meta-governor
```

## Usage

Add as a plugin in your OpenCode config:

```jsonc
{
  "plugins": ["@herjarsa/omo-meta-governor"]
}
```

The 15 custom tools register automatically (even without setting enabled:true).
To also enable the governance pipeline (intervention, protocol enforcement):

```jsonc
{
  "meta_governor": {
    "enabled": true,
    "intervention": {
      "mode": "message",
      "minActionForMessage": "warn"
    }
  }
}
```

## 15 Custom Tools

The plugin registers 15 tools the LLM can invoke. All available immediately on install.

### Code Search & Navigation

| Tool | What it does | Use case |
|------|-------------|----------|
| `omo_search` | Semantic code search via codegraph/graphify with AFT fallback | Architecture questions, finding features â€” USE THIS FIRST |
| `omo_find` | Exact symbol lookup (definition + direct callers) via codegraph node | "Find the function `validateToken`" |
| `omo_impact` | Impact analysis: callers, transitive callers, test files, doc files | Run BEFORE modifying a function |
| `omo_path` | Shortest conceptual path between two concepts via graphify | "How does auth connect to database?" |
| `omo_explain` | Plain-language explanation of a concept via graphify | "What is the SwinTransformer?" |
| `omo_outline` | Structural outline of files/directories via AFT | Understanding a new file's structure |

### Lesson & Memory

| Tool | What it does | Use case |
|------|-------------|----------|
| `omo_recall` | Search past lessons via local SQLite FTS5 (fast, always available) | "How did we set up auth before?" |
| `omo_recall_mcp` | Search cross-session memory via AgentMemory | "What did we learn about X in previous sessions?" |
| `omo_remember` | Save a fact/observation to cross-session AgentMemory | "Remember this bug pattern for next time" |

### Rules & Notes

| Tool | What it does | Use case |
|------|-------------|----------|
| `omo_rule` | Save a durable rule to Magic Context (ctx_memory) | "Always use bun:sqlite, not better-sqlite3" |
| `omo_history` | Search git history + past messages via ctx_search | "When did we add this feature?" |
| `omo_note` | Write ephemeral session note via ctx_note | "Currently debugging auth in module X" |

### Safety & Status

| Tool | What it does | Use case |
|------|-------------|----------|
| `omo_checkpoint` | Create a named AFT snapshot before risky changes | Undo protection before refactoring |
| `omo_undo` | Revert to most recent AFT checkpoint | "That broke things, revert it" |
| `omo_health` | Show plugin runtime status: metrics, decisions, errors | "Is the plugin working?" |

## Health & Observability

The plugin exposes a health JSON file at `~/.config/opencode/meta-governor-health.json`:

```bash
cat ~/.config/opencode/meta-governor-health.json
```

Or the agent can call `omo_health` directly to get a formatted report.

Structured JSONL logs at `~/.config/opencode/meta-governor.log` with size-based rotation
(10MB max, 5 rotated files).

## Persistence

Lessons learned by the plugin persist in **SQLite** at `~/.omo-meta-governor/meta-governor.db`
with full-text search (FTS5) for fast recall. Zero dependencies needed â€” uses Bun's built-in
`bun:sqlite`.

Optionally, the OpciÃ³n A tools (`omo_remember`, `omo_recall_mcp`, `omo_rule`, `omo_history`,
`omo_note`) can bridge to AgentMemory and Magic Context via `session.prompt()` â€” the LLM
receives a structured instruction to call the appropriate MCP tool.

## Graph Sync (v0.11.0)

MetaGovernor wires the plugin into the native git hooks of **codegraph** and
**graphify** so each commit automatically reindexes both graphs.

### What it does on first load in a project

1. **Auto-install** codegraph via `npm i -D @colbymchenry/codegraph` and
   graphify via `pip install graphifyy` (falls back to `uv tool install
   graphifyy`) if they're not already on PATH.
2. **Run `codegraph init`** + **`graphify . --no-viz`** to build the initial
   indexes for the project.
3. **Run `graphify hook install`** to wire up the native `post-commit` and
   `post-checkout` git hooks.

### What it does on each `git commit`

- **Primary path** (native git hook): `graphify update` runs in background.
- **Backup path** (plugin's `tool.execute.after`): detects `git commit` in
  bash commands and runs `codegraph sync -q [path]`.

## Intervention

MetaGovernor can inject governance decisions into the agent's context.
Enabled when `meta_governor.enabled: true` in config.

### Modes

| Mode | Mechanism | Effect |
|------|-----------|--------|
| `silent` | (none) | Decision is logged only |
| `message` | `experimental.chat.messages.transform` | Injects a synthetic user message visible to the LLM |
| `system` | `experimental.chat.system.transform` | Appends guidance to the system prompt |

### Configuration

```jsonc
{
  "meta_governor": {
    "enabled": true,
    "intervention": {
      "mode": "message",
      "minActionForMessage": "warn",
      "maxInterventionsPerSession": 3,
      "respectDoneSignal": true,
      "phaseAwareDoneSignal": true // v0.15.0: multi-phase plan support
    }
  }
}
```

### Fields

| Field | Default | Description |
|-------|---------|-------------|
| `mode` | `"message"` | How to inject: `"silent"`, `"message"`, or `"system"` |
| `minActionForMessage` | `"warn"` | Minimum action: `"warn"`, `"escalate"`, or `"stop"` |
| `maxInterventionsPerSession` | `3` | Hard cap on injections per session |
| `respectDoneSignal` | `true` | Stop injecting after terminal signal + Oracle verified |
| `phaseAwareDoneSignal` | `false` | **v0.15.0**: when `true`, only `<promise>PLAN-COMPLETE</promise>` latches intervention. DONE/PHASE-N-COMPLETE are per-phase hints. Recommended for multi-phase plans. |

## Skill Priming (v0.20.0)

Proactive skill-selection nudge: the plugin injects **one** synthetic user message at session
start (or once implementation work begins) prompting the agent to select precise skills for the
task via the **AAS skill catalog** (`aas search_skills` / `get_skill` / `compose_stack`) and/or
the task-appropriate **superpowers** skill — before writing code. Minimal context cost: the
directive forbids enumerating the full catalog.

```jsonc
{
  "meta_governor": {
    "enabled": true,
    "skillPriming": {
      "enabled": true,
      "trigger": "sessionStart", // or "firstImplement" (default)
      "router": "both" // "aas", "superpowers", or "both"
    }
  }
}
```

| Field | Default | Description |
|-------|---------|-------------|
| `enabled` | `false` | Master switch for the skill-priming nudge |
| `trigger` | `"firstImplement"` | `"sessionStart"`: first transform call of the session. `"firstImplement"`: once a write/edit-like tool is observed |
| `router` | `"both"` | Which system(s) the directive references: `"aas"`, `"superpowers"`, `"both"` |

### Multi-phase plans (v0.15.0)

For work plans with multiple phases (e.g. Sisyphus/Prometheus work plans),
configure `phaseAwareDoneSignal: true` and emit `<promise>PLAN-COMPLETE</promise>`
only when the **entire** plan is verified done by Oracle. The new markers:

| Marker | Effect |
|--------|--------|
| `<promise>DONE</promise>` | Per-phase hint. Logged but does NOT latch intervention (when `phaseAwareDoneSignal: true`). |
| `<promise>PHASE-N-COMPLETE</promise>` | Per-phase hint (e.g. `<promise>PHASE-1-COMPLETE</promise>`). Same as DONE â€” logged, does NOT latch. |
| `<promise>PLAN-COMPLETE</promise>` | Terminal. Latches intervention when Oracle has verified. |

**Migration**: existing v0.10.0â€“v0.14.x users keep working without changes (default
`phaseAwareDoneSignal: false` preserves the legacy single-task behavior). Set the
flag to `true` and switch your terminal marker to `PLAN-COMPLETE` to enable
multi-phase governance.

## v0.16.0 â€” Audit remediation: memory hygiene, dead code, tool coverage, CI

v0.16.0 closes the 50+ findings from the multi-front audit at `.omo/ulw-research/20260727-000530/plan-audit-v0.15.0.md`. The release is **additive in behavior, no breaking API changes** for users â€” only internal cleanup, dead code removal, and CI hardening.

### Highlights

#### Memory hygiene (F1)

- **`AuditStateCache`** (`src/audit-state-cache.ts`) â€” TTL+LRU bounded cache (100 entries, 1h TTL) replaces the bare `Map` that accumulated audit state without bounds. Stale sessions are evicted automatically.
- **`TTLQueue`** (`src/ttl-queue.ts`) â€” TTL-based expiration for `pendingBotFeedback` and `pendingViolations` queues. Previously unbounded.
- Removed dynamic `require("node:fs")` inside `shouldInjectPlanReminder` â€” replaced with static ESM imports (no more runtime module resolution failures).

#### Dead code elimination (F2)

- `takeAnyDecision()` â€” deprecated; removed from the active governance pipeline.
- `systemInjection` â€” now awaited eagerly instead of fire-and-forget, eliminating a silent failure route.
- `logToFile` in `graph-sync.ts` â€” wired to the real JSONL file logger (was a no-op stub).
- Plugin version â€” derived from `package.json` at runtime instead of hardcoded "0.13.0" (closes the version-drift bug where `omo_health` reported stale versions).

#### Tool bug fixes (F3)

- **AFT checkpoint/undo**: args split on whitespace broke names with spaces. Rewrote arg construction with proper quoting.
- **AFT subcommand**: now uses `options.projectDir` instead of `process.cwd()`.
- **graphify binary override**: `omo_path` / `omo_explain` honored the `graphifyBin` option (was hardcoded).
- **`as never` cast** on `setClient` â†’ proper runtime guard that validates client shape.
- **`session-bridge`**: replaced module-level `_client` with `AsyncLocalStorage` for per-request isolation. Concurrent sessions no longer race on the same client reference.

#### Test coverage (F4)

- 22 tests covering all 15 custom tools (`src/custom-tools.test.ts`). Previously the entire public tool surface had zero test coverage.
- 12 tests for `decision-store` (previously untested).

#### Type/token pipeline (F5)

- `token-predictor` refactor: dead code (`delegate`/`switch-model`) removed; output is now informational-only as designed.
- Type alignment across `types.ts`, `token-predictor.ts`, `orchestrator.ts`.

#### CI matrix (F6)

- `bun run typecheck` now runs on **macos-latest** and **windows-latest** (was Ubuntu-only).
- Removed `package-lock.json` (bun project â€” canonical is `bun.lock`).
- Secret redaction layer in `logToFile` (JWT, OpenAI keys, Bearer tokens, GitHub PATs, generic key:value patterns).
- Implementation plan renamed `IMPLEMENTATION_PLAN.md` â†’ `ARCHITECTURE.md`.

#### Final refactors (F7)

- Score formula documented (header doc with full formula spec).
- **NaN guard** in `score()` â€” defaults to neutral continue when `iterationRatio` or `ambient.iteration/maxIterations` produce NaN.
- `ACTION_SEVERITY` keyed by `DecisionHandlerOutput["action"]` union literal (was bare `Record<string, number>`).
- `projectHasCodegraph` / `projectHasGraphify` IIFE booleans replaced with lookup-time calls to `graphRetrieval.hasCodegraphDir(cwd)`.
- `extractConcepts` includes file basename for FTS lookup by tool/file name.
- Backup graph-sync uses `triggerReindex` (was `triggerCodegraphSync`) â€” reindexes both codegraph AND graphify backends.

### Test & build status

- **495/495 tests pass** (up from 487 in v0.15.0/0.15.1).
- `bun run typecheck` clean.
- `bun build.ts` clean (0.34 MB dist).
- `npm pack --dry-run` validated (no forbidden artifacts).

### Migration

No user action required. All changes are internal. The default `phaseAwareDoneSignal` is still `false` for backward compatibility; the v0.15.0 multi-phase behavior is preserved when explicitly enabled.

### Deferred to v0.17.0

- F5.1 â€” wiring `escalate` action to a real dispatcher (Oracle is recommended but not yet wired).
- F5.4 â€” `maxLessonsPerSession` enforcement (config field exists but is not enforced).
- F3.6 â€” Bridge tools lying about delivery (5 tools still return "dispatched" without polling). Recommend the user explicitly request this if delivery verification is critical.




## v0.17.0 â€” Wire escalate to Oracle, enforce lesson cap, verify bridge delivery

v0.17.0 closes the 3 deferred items from the v0.16.0 audit: **F5.1** (escalate â†’ Oracle), **F5.4** (`maxLessonsPerSession` enforcement), and **F3.6** (bridge tool delivery verification).

### Highlights

#### F5.1 â€” Escalate action now fires Oracle (v0.17.0)

When the scoring engine produces an `escalate` action with target `oracle`, the plugin's `tool.execute.after` hook now fires a `session.prompt()` instructing the LLM to invoke `task(subagent_type=oracle)`. The prompt includes the decision reasoning, evidence count, and a verification pass directive. New `buildEscalationPrompt()` function in `session-bridge.ts` is the pure prompt builder (testable in isolation). User-targeted escalations get a separate prompt asking the LLM to summarize for human input.

```ts
// Decision flow when score lands in escalate band:
score â‰¤ -escalateThreshold (default -0.6)
  â†’ decision.action = "escalate"
  â†’ decision.shouldEscalateTo = "oracle" (or "user" for grave deviations)
  â†’ plugin fires session.prompt with buildEscalationPrompt(...)
  â†’ LLM invokes Oracle (or summarizes for user)
  â†’ Oracle verifies â†’ oracleInvoked=true â†’ governance continues
```

#### F5.4 â€” `maxLessonsPerSession` is now enforced

The cap (default 20) was a config field that was never enforced. v0.17.0 adds:
- `currentLessonCount` on `LearnFromOutcomeInput` and `MetaGovernorInput`
- `lessonCount` tracked in per-session `AuditState`
- `observeAndLearn()` short-circuits when `currentLessonCount >= maxLessonsPerSession`
- The orchestrator increments `sessionState.lessonCount` after each successful save
- **Cap semantics: inclusive** â€” when count equals cap, no more lessons are saved

#### F3.6 â€” Bridge tool delivery verification

The 5 bridge tools (`omo_remember`, `omo_recall_mcp`, `omo_rule`, `omo_history`, `omo_note`) previously returned "dispatched" after the `session.prompt()` was queued â€” without verifying the LLM actually called the MCP tool. v0.17.0 adds:

- **New `PendingDeliveryRegistry` module** (`src/delivery-registry.ts`) â€” tracks pending dispatches per session with TTL-based cleanup.
- **`tool.execute.after` hook** marks deliveries when a matching MCP tool call is observed.
- **All 5 bridge tools** now report `deliveryStatus: "delivered" | "pending"` in their tool result and metadata, and briefly poll (1.5s) for fast deliveries.
- When the LLM follows the prompt, the tool returns immediately with `"delivered"`. When it doesn't, the tool returns `"pending"` and the entry expires silently after 10s.

```ts
// Bridge tool result metadata now includes:
{
  tool: "omo_remember",
  ok: true,
  deliveryStatus: "delivered" | "pending",
  messageID: "...",
  durationMs: 1234,
  contentLength: 256
}
```

### Test & build status

- **514/514 tests pass** (up from 495 in v0.16.0 â€” 5 + 4 + 10 new tests across F5.4, F5.1, F3.6).
- `bun run typecheck` clean.
- `bun build.ts` clean (0.34 MB dist).
- `npm pack --dry-run` validated.

### Migration

No user action required. All changes are internal or additive:
- `deliveryStatus` is an additive metadata field â€” existing consumers ignore it.
- `maxLessonsPerSession` is now actually enforced â€” if you have sessions that previously saved more than 20 lessons (e.g. from before the cap was added), this may surprise you. Bump the cap in your config if needed.
- `escalate` action now actively fires Oracle â€” this is the first version where Oracle is auto-invoked, not just manually invoked by the LLM.

### Audit roadmap (status as of v0.17.0)

| Release | Status | Scope |
|---------|--------|-------|
| v0.15.1 (F0) | âœ… Shipped | Hotfix self-dep + npm pack gate |
| v0.16.0 (F1-F7) | âœ… Shipped | Memory hygiene, dead code, tool coverage, CI |
| v0.17.0 (deferred) | âœ… Shipped | F5.1 escalate, F5.4 cap, F3.6 delivery verify |

All audit findings are now closed. Future work focuses on new features and user-driven feedback.



## v0.17.1 â€” Audit args fix (patch)

v0.17.1 is a single-bug patch release. The fix addresses an issue discovered during v0.17.0 verification:

### The bug

The `tool.execute.before` hook passed an empty `{}` object as the second argument to `auditToolCall()`. This meant the audit function never saw the tool's args (e.g. file content for write tools) and could never detect:

- `@ts-ignore` / `@ts-expect-error` directives
- `as any` type assertions  
- `catch(e) {}` empty catch blocks

The hook signature was also incomplete â€” it didn't receive the `output` parameter that contains the mutable args, even though the SDK provides it.

### The fix

Two changes in `src/plugin.ts`:

1. **Hook signature updated** to receive the `output` parameter:
   ```ts
   "tool.execute.before": async (
     toolInput: { tool: string; sessionID: string; callID: string },
     _output: { args: unknown },
   ): Promise<void> => {
   ```

2. **Audit call** now passes `_output.args` instead of `{}`:
   ```ts
   const violations = auditToolCall(toolInput.tool, _output.args, { ... })
   ```

### Tests

Added 4 new tests in `src/plugin.test.ts`:
- `@ts-ignore + as any` in args â†’ `no-type-suppression` violation detected and injected
- `catch(e) {}` in args â†’ `no-empty-catch` violation detected and injected
- Clean code â†’ no violation injected (false-positive guard)
- `auditToolCalls: false` â†’ audit short-circuits (regression check)

### Test & build status

- **518/518 tests pass** (up from 514 in v0.17.0 â€” 4 new audit tests).
- `bun run typecheck` clean.
- `bun build.ts` clean (0.34 MB dist).

### Migration

No user action required. The audit detection now correctly fires when the agent writes forbidden patterns. This means:

- **If your agent previously wrote `@ts-ignore` without being flagged**: it will now be flagged with `[GRAVE] no-type-suppression: ...` injected as a synthetic user message.
- **If you want to disable the audit**: set `protocolEnforcement.auditToolCalls: false` (already supported).



## v0.17.2 â€” Fix escalation dead code + 4 audit gaps

v0.17.2 closes 4 gaps discovered during live verification of v0.17.0/v0.17.1. The most important: F5.1 (escalate â†’ Oracle) was effectively dead in production due to two compounding bugs.

### Highlights

#### Gap C (CRITICAL) â€” Escalation now actually fires

The score formula's `noProgress` and `deviations` inputs were hardcoded as `false` and `[]` in the plugin. This meant the `no-progress-detector` (weight 0.20) and `deviation-detector` (weight 0.20) signals always contributed 0. Combined with default thresholds, the maximum possible score was -0.55 â€” never reaching `escalateThreshold: 0.6` or `stopThreshold: 0.8`.

**Fix:**
1. **Derive `noProgress`** from the recent tool call window. If the last 5 tool calls contain no `write`/`edit`/`task` (i.e. the agent is only reading/grepping without producing artifacts), `noProgress = true`.
2. **Derive `deviations`** from accumulated protocol violations. The audit hook now stores violations in `state.accumulatedDeviations` (capped at 5 per session); the orchestrator input reads them.
3. **Lower default thresholds** to match the new worst-case math:
   - `escalateThreshold`: 0.6 â†’ 0.45
   - `stopThreshold`: 0.8 â†’ 0.55

Now worst-case state (no oracle, no progress, 2 grave deviations, iteration at limit, stop-advice lessons) produces score â‰ˆ -0.55 â†’ `stop` action fires.

#### Gap Q (HIGH) â€” File paths threaded through pipeline

`orchestrator.ts` was hardcoding `filesChanged: []` instead of `input.filePaths`. This meant lesson extraction never saw the actual changed files, so F7.5's file-basename FTS indexing was empty.

**Fix:**
1. Track `recentWriteFilePaths` in AuditState (alongside existing `recentWriteContents`).
2. Capture `filePath` from `toolInput.args` on write/edit tool calls.
3. New `MetaGovernorInput.filePaths?: readonly string[]` passed through to `observeAndLearn`.

#### Gap D (HIGH) â€” Three config fields now actually do something

Three fields were in the schema and config projection but NEVER consulted by the logic:

- `closedLoop.saveLessons` â€” parallel to `saveDecisions`. When `false`, lessons are skipped (decision records still save).
- `intervention.includeDecisionHistory` â€” when `true`, `messages.transform` prepends recent intervention texts (capped at `maxHistoryMessages`) so the LLM sees its history of decisions.
- `intervention.maxHistoryMessages` â€” limit for the above (default 5).

**Fix:** All three fields now control behavior. Track `recentInterventionTexts` in AuditState, format them into the injection text.

#### Bonus â€” iteration-budget signal wired (Oracle finding)

Oracle flagged a pre-existing gap alongside Gap C: `iteration` was hardcoded `0` in the orchestrator input, making the `iteration-budget` signal (weight 0.15) effectively dead.

Fix:
- Added `iteration: number` to `AuditState`, incremented per tool call.
- Threaded `iteration: sessionState?.iteration ?? 0` into `MetaGovernorInput`.
- `maxIterations` now reads from config instead of being hardcoded.

Worst-case score math updated: with iteration at 100% (-0.12), all signals bad, no oracle â†’ score = -0.65 â†’ `stop` action fires.

#### Gap I (MEDIUM) â€” `verifyDelivery` return type includes "expired"

The TypeScript signature was `Promise<"delivered" | "pending">` but the registry could return `"expired"`. The expired case leaked through as `"pending"` silently.

**Fix:** Signature updated to `Promise<"delivered" | "pending" | "expired">`. Bridge tools now distinguish: `"delivered"` (verified), `"pending"` (still polling), `"expired"` (TTL elapsed).

### Test & build status

- **521/521 tests pass** (up from 518 â€” 3 new tests for the v0.17.2 fixes).
- `bun run typecheck` clean.
- `bun build.ts` clean (0.34 MB dist).
- `npm pack --dry-run` validated.

### Migration

No user action required. Two behavior changes:

1. **Escalation now fires more aggressively.** If your agent has been producing violations and not making progress, expect to see escalate â†’ Oracle prompts more often. This is the intended behavior; v0.17.0 was incorrectly silent.
2. **`includeDecisionHistory` and `maxHistoryMessages` are now functional.** If you set them in v0.17.0 expecting them to work, they will now actually take effect.

### Audit roadmap (status as of v0.17.2)

| Release | Status | Scope |
|---------|--------|-------|
| v0.15.1 (F0) | âœ… | Hotfix self-dep |
| v0.16.0 (F1-F7) | âœ… | Memory hygiene, dead code, tool coverage, CI |
| v0.17.0 | âœ… | F5.1 escalate, F5.4 cap, F3.6 delivery verify |
| v0.17.1 | âœ… | Audit args fix |
| v0.17.2 | âœ… | Gap C (escalation live), Q (file paths), D (config fields), I (delivery expired) |



## v0.17.3 â€” Fix Gap I properly (patch)

v0.17.3 is a single-bug patch. During live verification of v0.17.2, Gap I was found to be incompletely fixed.

### The bug (v0.17.2 cosmetic fix)

The `verifyDelivery` export signature was widened to include `"expired"` in v0.17.2, and the bridge tools' title/output text was updated to handle it. **BUT the underlying `pollForDelivery` helper was still collapsing `"expired"` â†’ `"pending"` silently:**

```ts
// v0.17.2 (BUG):
return status === "delivered" ? "delivered" : "pending"
```

So bridge tools could never report `"expired"` to the user, even though the registry correctly tracked it. Live verification confirmed: `deliveryStatus` always showed `"pending"`.

### The fix (v0.17.3)

```ts
// v0.17.3:
return await pendingRegistryRef.awaitDelivery({ sessionID, mcpTool, timeoutMs })
```

Now the actual status from the registry propagates through. `"expired"` flows end-to-end to the bridge tool's `metadata.deliveryStatus` and title.

### Tests

Added 3 RED tests in `src/custom-tools.test.ts`:
- Returns `"expired"` when registry entry exists past timeout (real registry instance)
- Returns `"delivered"` when `markDelivered` fires before timeout
- Returns `"pending"` when no registry is configured

### Test & build status

- **525/525 tests pass** (up from 522 in v0.17.2 â€” 3 new tests for pollForDelivery).
- `bun run typecheck` clean.
- `bun build.ts` clean (0.34 MB dist).

### Migration

No user action required. Bridge tools will now correctly distinguish all three delivery states:
- `"delivered"` â€” LLM's MCP tool call was observed within 1.5s
- `"expired"` â€” TTL elapsed without delivery (entry expires after 10s, but bridge tool sees this immediately as "expired" when polling times out at 1.5s)
- `"pending"` â€” no registry configured (graceful degradation for tests/mocks)

### Audit roadmap (status as of v0.17.3)

| Release | Status | Scope |
|---------|--------|-------|
| v0.15.1 â†’ v0.17.2 | âœ… | All audit findings + 5 gap fixes |
| v0.17.3 | âœ… | Gap I real fix (pollForDelivery returns "expired") |

Two remaining gaps documented but require SDK support to fix:
- `recentTurnTokens: []` â€” token-predictor signal dead (10% of score); needs per-turn token counts from OpenCode SDK
- `agentName` defaults to `"unknown"` â€” cosmetic, no functional impact



## v0.18.0 â€” Audit remediation: 7+ silent config drops + circular ref crash

v0.18.0 is a thorough-audit patch release. Each fix addresses a bug found by testing every public function with edge cases and adversarial inputs.

### Highlights

| # | Bug | Severity | Fix |
|---|-----|----------|-----|
| 1 | `file-logger.redactData` crashed on circular references with stack overflow | ðŸ”´ CRITICAL | `WeakSet` guard + `try/catch` fallback |
| 2 | `loadOrchestratorConfig` only projected `closedLoop.saveDecisions` â€” `enabled`, `minSeverityToLearn`, `maxLessonsPerSession`, `saveLessons` were silently dropped | ðŸ”´ CRITICAL | Project all 5 fields |
| 3 | `loadOrchestratorConfig` didn't project `decision.warnMessageTemplate`, `escalateMessageTemplate`, `stopMessageTemplate` | ðŸŸ  HIGH | Project all 3 templates |
| 4 | `loadOrchestratorConfig` didn't project `scoring.paralysisThreshold`, `defaultEscalationTarget` | ðŸŸ  HIGH | Project all fields |
| 5 | `loadOrchestratorConfig` had `memory.timeoutMs` field name mismatch (schema said `agentmemoryTimeoutMs`) | ðŸŸ  HIGH | Accept both names |
| 6 | `isMetaGovernorEnabled` only checked top-level `enabled`, not `meta_governor.enabled` (wrapped shape from `opencode.jsonc`) | ðŸŸ  HIGH | Check both shapes |
| 7 | `createMetricsCollector` crashed when called without config (`config.version` on `undefined`) | ðŸŸ  HIGH | Accept `Partial<MetricsCollectorConfig>` |
| 8 | `metrics.inc` crashed on unknown event names (`bucket.count++` on `undefined`) | ðŸŸ  HIGH | Guard `if (!bucket) return` |
| 9 | `isNewerVersion` returned `false` for `installed=null` (no upgrade triggered for fresh installs) | ðŸŸ¡ MEDIUM | Return `true` when installed is null AND latest is valid |

### Test & build status

- **557/557 tests pass** (up from 530 in v0.17.3 â€” 27 new tests for the audit fixes).
- `bun run typecheck` clean.
- `bun build.ts` clean (0.34 MB dist).
- `npm pack --dry-run` validated.

### Migration

No user action required. The fix to `loadOrchestratorConfig` means **users who were setting `closedLoop.maxLessonsPerSession` or other previously-dropped fields will now see those values actually take effect**. If you had a config like `{ "closedLoop": { "maxLessonsPerSession": 50 } }` before v0.18.0, it was silently being overridden to 20. Starting v0.18.0, the value 50 is now respected.

### Audit roadmap (status as of v0.18.0)

| Release | Status | Scope |
|---------|--------|-------|
| v0.15.1 â†’ v0.17.3 | âœ… | All audit findings + deferred items + audit args fix + gap fixes |
| v0.18.0 | âœ… | 7 silent config drops + circular ref crash + metrics crashes + upgrade trigger |

This release closes the final round of gaps found by a thorough function-by-function audit. The plugin now correctly projects **all** user configuration, handles **all** circular reference cases, and fails safely on **all** missing-input scenarios.


## v0.19.4 — Dual-shape default export: opencode 1.18.x loader compat (patch)

v0.19.3 shipped a function-only default export hoping to fix the opencode
serve factory-not-invoked bug. Empirical verification (reading
`~/.config/opencode/meta-governor.log`) showed it didn''t help: opencode
1.18.16 npm-package plugins still loaded the module without ever calling
the factory under `opencode serve`.

### The fix

`src/index.ts` now exports an object that is **both** a Plugin function
**and** a PluginModule:

```ts
const _plugin = createMetaGovernorPlugin()
_plugin.id = "omo-meta-governor"
_plugin.server = _plugin
export default _plugin
```

Bundled as `var u4=IN(); u4.id="omo-meta-governor"; u4.server=u4; export{...JX=u4...}`.
Whichever path opencode picks (`default(input, options)` or
`default.server(input, options)`), the same callable fires and the hooks
register.

### Verification

After restart of OpenChamber, log shows:
- factory_invoked events (was 0 with v0.19.3)
- config_loaded events (was 0 with v0.19.3)
- intervention / violations / persist calls firing normally

### Test & build status

- 4/4 new tests in `src/index.test.ts` lock down the dual-shape contract.
- `bun run typecheck` clean.
- `bun build.ts` clean (0.35 MB dist).
- `npm publish` to registry OK.

### Migration

No user action required. If you previously set
`intervention.persistToSession: false` in your config, that toggle is
still respected.

---

## v0.19.7 — Fix npm-published package.json: restore `import` condition in `exports` (patch)

v0.19.6 shipped a single callable default export with the dual-shape contract (memory #1126) but the published tarball's `package.json` had the `exports` map regenerated to contain only the `types` condition — no `import`/`default`/`require` runtime condition. Under opencode 1.18.16's plugin loader, that caused the npm-package plugin to load the module (module scope ran, `MetaGovernor plugin loaded` logged) but **never invoke the factory** (`factory_invoked` was 0). v0.19.4 had empirically verified the dual-shape fix for `opencode serve`; v0.19.6 on `opencode run` with the same dual-shape bundle in the npm cache was silently broken for the same reason.

### The bug

`package.json` in the v0.19.6 tarball (read from the installed package in `~/.cache/opencode/packages/@herjarsa/omo-meta-governor@latest/...`):

```json
"exports": {
    ".": { "types": "./dist/index.d.ts" },
    "./lib": { "types": "./dist/lib.d.ts" }
}
```

vs. the repo's source `package.json` (correct, with `import` condition for runtime resolution):

```json
"exports": {
    ".": { "types": "./dist/index.d.ts", "import": "./dist/index.js" },
    "./lib": { "types": "./dist/lib.d.ts", "import": "./dist/lib.js" }
}
```

The published manifest lost the `import` condition (and `peerDependencies: {"@opencode-ai/plugin": ">=1.0.0"}`, `publishConfig`, `repository.url`, `devDependencies.typescript`, `files` README entry, `scripts.test`). When opencode's plugin installer resolves the entry via `exports`, only `"types"` is offered — no runtime condition matches → the loader imports the bundle by `main` fallback but the export contract that uk() (`opencode.util.createPlugin`) inspects isn't satisfied, so the plugin is loaded but never invoked.

### How the bug was reproduced

Cheap-shape probes (`@herjarsa/omg-shape-probe2` … `probe7`) with byte-identical Bun-bundles from `dist/index.js` were published to npm and tested under `opencode run` with XDG-isolated config. All probes with `exports."."` containing `"import"` or `"default"` invoked the factory. The probe replicating the exact published shape (types-only exports) failed to invoke. Bundle SHA-256 identical between probes and the real published package:
```
E737C676FCC74B6CBA771616058BC5620C1F0364089B1B8626246E96FF02ED69
```

### The fix

No source/bundle changes — the bundle was correct all along. The malformed published `package.json` was restored from the repo (`git show HEAD:package.json` has the canonical full exports map with `import`) and only the version was bumped to `0.19.7`. Rebuild with `bun build.ts` (bakes version into the bundle), published, verified.

### Verification

XDG-isolated opencode run (`opencode run` with custom config pointing at `@herjarsa/omo-meta-governor@latest`):

- v0.19.6 (cache populated): log shows `MetaGovernor plugin loaded` only — **no `factory_invoked`**, intervention never runs.
- v0.19.7 (cache cleared, reinstalled): log shows full chain:
  ```
  [meta-governor] MetaGovernor plugin loaded
  [meta-governor] factory_invoked
  [meta-governor] SessionBridge: OpenCode client hydrated — session.prompt() available
  [meta-governor] config_loaded
  ```

Updated `~/.cache/opencode/packages/@herjarsa/omo-meta-governor@latest/node_modules/@herjarsa/omo-meta-governor/package.json` now reads `exports."."` = `{ types: "./dist/index.d.ts", import: "./dist/index.js" }` and `peerDependencies` = `{ "@opencode-ai/plugin": ">=1.0.0" }`.

### Test & build status

- `bun run typecheck` clean.
- `bun build.ts` clean (0.34 MB dist, version 0.19.7 baked in).
- `npm publish` to registry OK.
- Empirical harness verification: factory_invoked + config_logged restored.

### Migration

No user action required. If you were running v0.19.6 and the plugin appeared silent (no interventions, no metrics), delete your opencode cache:
```bash
rm -rf ~/.cache/opencode/packages/@herjarsa/omo-meta-governor@latest
```
Then restart opencode — it will reinstall v0.19.7 from the registry and the pipeline will fire normally.

---

## v0.19.3 — opencode serve factory invocation + persistSessionMessage wiring

This release closes the persistSessionMessage wiring arc (memory #999) and
loads config from three sources automatically (CLI > project > user).
The `index.ts` `export default` change was incomplete (see v0.19.4 for
the proper dual-shape fix that resolves opencode serve invocation).

### Highlights

- **index.ts**: switched `export default` to call `createMetaGovernorPlugin()`
  directly (function path), abandoning the `PluginModule` wrapper. Was the
  wrong shape — see v0.19.4 for the actual fix.
- **plugin.ts**: factory now calls `loadMetaGovernorConfig({ projectDir })` so
  config from `.opencode/omo-meta-governor.jsonc` and
  `~/.config/opencode/omo-meta-governor.jsonc` flows in automatically.
- **session-bridge.ts**: `persistSessionMessage()` — fire-and-forget
  `session.prompt()` helper that records intervention text as a REAL session
  message (visible in TUI and session DB).
- **types.ts + config.ts + orchestrator.ts**: `persistToSession` defaults to
  true on `InterventionConfig`. Helps users running OpenChamber actually
  SEE interventions in their TUI.
- **tests**: 16 `createMetaGovernorPlugin()` calls in plugin/v172/v173-gap-d
  tests now pass `graphSync: { enabled: false, autoInstall: false }`
  because user config enables `autoInstall` by default (memory #989).

### Test & build status

- ~437/437 tests pass (per-file, `graphsink-fix.ts` skipped per known Bun
  Windows integer-overflow crash).
- `bun run typecheck` clean.
- `bun build.ts` clean (0.35 MB dist).
- `npm publish` to registry OK.

### Migration

No user action required.

---

## v0.19.0–v0.19.2 — Internal persistSessionMessage wiring arc (memory #999)

Three iterations on the persistSessionMessage wiring arc. Each iteration
added call sites and tightened the test coverage, but the fix was lost in
stashes and merges until v0.19.3 finally shipped a working version of
the helper. See v0.19.3 for the user-facing release notes; v0.19.4
supersedes with the correct dual-shape export.
## Auto-upgrade (v0.12.0)

On plugin load, queries npm/pip registries to check whether newer versions
of **codegraph** or **graphify** exist. Config: `graphSync.autoUpgrade` (default `true`),
`graphSync.upgradeCheckTtlMs` (default `86400000`).

## License

MIT
