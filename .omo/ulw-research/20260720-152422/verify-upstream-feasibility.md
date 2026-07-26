# Verify - C4: Current OpenCode public seams support stronger commander behavior

## Claim
A "commander" plugin that actively governs execution (not just advises) is feasible on current OpenCode public/runtime seams.

## Verification Method
5 independent observation groups converge on the same conclusion:
1. Upstream hook audit (bg_48c34dc3) — V1 hooks are real and dispatched
2. Upstream session lifecycle (bg_bf99c58a) — durable events for episode boundaries
3. Upstream source deep dive (bg_d10e7bf3) — plugin SDK architecture supports custom tools
4. Ecosystem survey (bg_ebfa5adc) — 15 production plugins demonstrate patterns
5. Upstream issues (bg_b2b86fb5) — community explicitly requests commander capabilities

## Evidence by group

### Group 1: V1 hook surface is real
- `tool.execute.before` — dispatches at `packages/opencode/src/session/processor.ts:795` AND `packages/opencode/src/session/prompt.ts:307`
- `tool.execute.after` — dispatches at `session/processor.ts:795` AND `prompt.ts:389`
- `experimental.chat.messages.transform` — dispatches at `prompt.ts:1255` AND `compaction.ts:350`
- `experimental.chat.system.transform` — dispatches at `session/llm/request.ts:69`
- `experimental.session.compacting` — dispatches at `compaction.ts:343`
- `experimental.compaction.autocontinue` — dispatches at `compaction.ts:454`
- `event` hook — subscribes to all V2 events via `EventV2Bridge`

### Group 2: Durable events for episode boundaries
- `session.created`, `session.updated`, `session.deleted` — durable, always fires
- `session.next.step.started` / `step.ended` / `step.failed` — durable
- `session.next.tool.called` / `tool.success` / `tool.failed` — durable
- `session.next.compaction.started` / `compaction.ended` — durable
- `session.status` (idle/retry/busy) — for episode close
- `session.compacted` — for mid-session learning checkpoints

### Group 3: Plugin SDK supports custom tools
- `packages/plugin/src/tool.ts` — `tool()` function for defining custom tools
- `packages/core/src/config/plugin/agent.ts` — agent file discovery
- `PluginInput.client` — unrestricted opencode server proxy
- `PluginInput.$` — Bun shell for template scripts
- `PluginInput.serverUrl` — for cross-process coordination

### Group 4: Ecosystem demonstrates patterns
- **opencode-ensemble** (169★) — SQLite + event-driven state machine for multi-agent coordination
- **opencode-mem** (1178★) — SQLite + USearch for persistent cross-session memory
- **opencode-bash-guard** — 60-line `tool.execute.before` enforcement with throwing
- **opencode-telemetry** — passive SQLite session recording
- **opencode-gh-actions-status** — post-push CI auto-prompt via `tool.execute.after` + `session.prompt()`
- **opencode-swarm** (401★) — adversarial testing harness
- **opencode-mcp-tool-search** — meta-tool pattern with Fuse.js
- **opencode-memfs** — hot/cold tiered memory with cache-bust ladder
- **oh-my-openagent** — full hook surface wrapping including `chat.params`, `chat.headers`

### Group 5: Community demands
- 10+ issues request session lifecycle hooks (#21075, #28695, #28874, #16626, #5409, #12472, #14863)
- 4+ orchestration plugins independently patch the same missing hooks
- 6+ memory plugins use fragile workarounds
- CodeGraph built-in request (#32011)
- Stream delta hook PR exists (#14741, CI green, not merged)

## Verdict
**CONFIRMED** — A commander plugin is feasible. The plugin can:
1. Use V1 typed hooks for synchronous intervention (`tool.execute.before/after`, `experimental.chat.*.transform`)
2. Subscribe to durable events via `event` hook for episode tracking
3. Register custom tools via `tool` field for graph queries
4. Use the `client` API for session creation, interruption, prompt injection
5. Use SQLite for cross-session state (proven pattern)
6. Throw inside `tool.execute.before` for blocking enforcement (bash-guard pattern)

## Constraints
- Cannot cancel operations (all hooks return void)
- Event handlers are fire-and-forget
- `permission.ask` is dead — must use `event` hook for permission-related work
- Subagent tool calls may bypass `tool.execute.before` (#5894) — must use `system.transform` as backup
- Plugin errors are always contained — cannot crash opencode

## Implication for omo-meta-governor
The plugin can become a real commander by:
1. Wiring real SQLite backends (closes C1)
2. Actually invoking graph tools from `tool.execute.before` (closes C2)
3. Fixing default config to make governance visible (closes C3)
4. Adding a `/health` command, metrics emission, and e2e test (closes C4)
5. Using `experimental.session.compacting` to inject lessons during compaction
6. Using `session.status` events to trigger lesson extraction at session end
