# Expansion Log

## Wave 1 Results

### bg_9e232dae - Map plugin hook lifecycle (DONE)
Key findings:
- 4 of 21 available hooks registered
- Default `intervention.mode: "silent"` makes governance invisible
- `untrackSession` imported but never called
- `runGraphSync()` fire-and-forget creates race condition
- Default backends are stubs returning empty data
- Orchestrator pipeline runs on vacuum → always "continue"
- Protocol enforcement defaults to disabled
- Plan reminder requires non-silent mode

### bg_1c94a28b - Audit graph search routing (DONE)
Key findings:
- Plugin NEVER calls `codegraph_explore` or `graphify query`
- Only injects prompt text telling agent to use them
- `.codegraph/` and `graphify-out/` detected at plugin load only
- `aftAvailable` flag never set to true (dead code path)
- Snapshot race: projectHasCodegraph set before async init
- Audit is reactive (flags violations) not preventive

### bg_b2b86fb5 - Research upstream issues (DONE)
Key findings (54 issues/PRs catalogued):
- `tool.execute.after` declared but never triggered for native tools (#25918)
- `tool.execute.before` fires with empty args for MCP tools (#18489)
- `permission.ask` hook defined but never dispatched (#9229)
- Event delivery has recurring SSE regressions
- 4+ missing session lifecycle hooks requested
- 10+ memory feature requests, zero native implementation
- CodeGraph built-in requested (#32011)

### bg_48c34dc3 - Research upstream plugin hooks (DONE)
Key findings:
- V1 plugin system: 21 hooks, 4 dispatched reliably
- `permission.ask` confirmed dead hook
- V2 plugin system: 7 domains wired (agent, catalog, command, integration, reference, skill, aisdk)
- V2 `session` domain and `tool` hooks in PLAN.md only
- Hooks run sequentially, no cancellation, no rollback
- `client` API in PluginInput gives unrestricted server proxy
- `event` hook is fire-and-forget with void keyword

### bg_e582d3e3 - Audit observability and tests (DONE)
Key findings:
- 19 test files, 333 test cases
- Orchestrator intervention is ACTIVE but invisible by default
- `silent` mode + `minActionForMessage: "stop"` = trap configuration
- No health check, no metrics, no log rotation
- No E2E test against real OpenCode
- File logger works but invisible to user
- 8 critical gaps identified

### bg_ebfa5adc - Research ecosystem plugins (DONE)
Key findings (15 repos catalogued):
- opencode-ensemble: SQLite + event-driven state machine (169★)
- opencode-swarm: adversarial testing pattern (401★)
- opencode-mem: SQLite + USearch vector DB (1178★)
- opencode-memfs: hot/cold tiered memory with cache-bust
- opencode-mcp-tool-search: meta-tool pattern with Fuse.js
- opencode-bash-guard: 60-line tool.execute.before enforcement
- opencode-telemetry: passive SQLite session recording
- opencode-gh-actions-status: post-push CI auto-prompt
- Tool interception has subagent bypass (#5894)

### bg_d10e7bf3 - Deep dive upstream source (DONE)
Key findings:
- Two parallel implementations: Go CLI + TypeScript monorepo
- SHA Go: 73ee493265acf15fcd8caab2bc8cd3bd375b63cb
- SHA TS: b67fda133a186c7c294c8822f7eda89f36d57aff
- Pubsub broker pattern in Go
- Plugin SDK with Effect+Promise variants in TS
- Background job system process-local, no persistence
- Agent loop synchronous sequential
- MCP first-class citizen

### bg_bf99c58a - Research session lifecycle (DONE)
Key findings:
- Two-tier event system: v1 lifecycle + v2 schema durable
- session-next.* events all durable, persisted to SQLite
- Reliable episode open: session.created, step.started, tool.called
- Reliable episode close: step.ended, tool.success/failed, session.status(idle)
- Compaction is only structured mid-session summary point
- Subtask dispatched via ToolPart tool="task"
- No dedicated "lesson extracted" event exists

## Wave 2 (pending - to be launched after journaling)

Pending: verification probes + targeted counter-search
