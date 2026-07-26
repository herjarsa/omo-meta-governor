# Claim Graph

## verified-claims

### C1 - Plugin runs on stub backends by default
- RISK: high | STATUS: **supported**
- SOURCES: local source audit (bg_9e232dae, bg_e582d3e3)
- COUNTER: none
- PRIMARY: src/plugin.ts:338-346
- INDEPENDENT GROUPS: 2
- SYNTHESIS: "The orchestrator pipeline runs on stub backends. smartSearch returns zero results, slotList returns empty, boulderRead returns empty, saveMemory/saveLesson return fake {id:\"\"}. User sees `lessons=[]` despite observations."

### C2 - Plugin never invokes graph query tools
- RISK: high | STATUS: **supported**
- SOURCES: local source audit (bg_1c94a28b)
- COUNTER: none
- PRIMARY: grep across 17 source files
- INDEPENDENT GROUPS: 2
- SYNTHESIS: "Plugin is a meta-supervisor for graph lifecycle (install/init/watch/upgrade/reindex) but never invokes `codegraph_explore`/`codegraph_search`/`graphify query`. All graph tool references are prompt text."

### C3 - Default configuration creates invisible governance trap
- RISK: high | STATUS: **supported**
- SOURCES: local source audit (bg_9e232dae, bg_e582d3e3)
- COUNTER: none
- PRIMARY: src/config.ts:92-175
- INDEPENDENT GROUPS: 2
- SYNTHESIS: "Default config: enabled:false, intervention.mode:silent, protocolEnforcement.enabled:false, minActionForMessage:stop. Combined with C1, the pipeline runs but produces zero visible effect."

### C4 - Current OpenCode public seams support stronger commander behavior
- RISK: high | STATUS: **supported**
- SOURCES: upstream audit (bg_48c34dc3, bg_bf99c58a, bg_d10e7bf3, bg_173c224c), ecosystem survey (bg_ebfa5adc)
- COUNTER: none
- PRIMARY: packages/plugin/src/index.ts at SHA b67fda13
- INDEPENDENT GROUPS: 6
- SYNTHESIS: "V1 typed hooks (tool.execute.before/after for ALL tools, experimental.chat.*.transform, experimental.session.compacting, event, chat.params, chat.headers, tool.definition, shell.env) are reliable. SQLite-backed state, custom tool registration, and event-driven episode tracking are feasible."

### C5 - `permission.ask` is a dead hook
- RISK: normal | STATUS: **supported**
- SOURCES: direct verification
- COUNTER: none
- PRIMARY: packages/opencode/src/permission/index.ts (no Plugin.trigger call sites)
- INDEPENDENT GROUPS: 1
- SYNTHESIS: "Permission interception requires `event` hook listening for `permission.asked`/`permission.v2.asked` events, not the typed `permission.ask` hook."

### C6 - Event delivery is fire-and-forget
- RISK: high | STATUS: **supported**
- SOURCES: direct verification
- COUNTER: none
- PRIMARY: packages/opencode/src/plugin/index.ts:251-258 (void prefix)
- INDEPENDENT GROUPS: 2
- SYNTHESIS: "Event handlers use void prefix → fire-and-forget. Must use typed hooks for synchronous work."

### C7-REFUTED - `tool.execute.before/after` are dispatched for ALL native tools (not just task)
- RISK: high | STATUS: **refuted → corrected**
- ORIGINAL CLAIM: "Hook only fires for task subtask"
- REFUTATION: bg_173c224c direct upstream inspection found `SessionTools.resolve` in `packages/opencode/src/session/tools.ts` ~lines 72-96 wraps every registry tool with `plugin.trigger("tool.execute.before", ...)` and `plugin.trigger("tool.execute.after", ...)` inside the AI SDK tool's `execute` callback. This applies to ALL 16+ native tools (Read, Edit, Write, Bash/Shell, Glob, Grep, Lsp, WebFetch, WebSearch, Skill, Task, Question, ApplyPatch, PlanExit, TodoWrite, Invalid) plus MCP tools and MCP resource tools.
- PRIMARY: packages/opencode/src/session/tools.ts:72-96
- INDEPENDENT GROUPS: 1 (direct upstream code inspection)
- SYNTHESIS: "C7 was based on an incomplete grep that only looked for plugin.trigger in tool/*.ts files. The actual dispatch happens in `SessionTools.resolve` (session/tools.ts) inside the AI SDK tool wrapping. ALL native tools route through this hook. This is a CRITICAL CORRECTION: omo's `tool.execute.before` audit at plugin.ts:184-244 IS effective for native tools. The original omo architecture is sound — the problem is just C1 (stub backends) and C2 (no actual graph invocations)."

### C8-REFUTED - Subagent tool calls DO dispatch both hooks
- RISK: high | STATUS: **refuted → corrected**
- ORIGINAL CLAIM: "Subagent bypasses"
- REFUTATION: bg_173c224c. TaskTool itself wraps hooks in `handleSubtask` (prompt.ts ~lines 290-320). Subagent's own tool calls go through the same `SessionTools.resolve` wrapper, so all subagent tool calls also dispatch both hooks.
- PRIMARY: session/prompt.ts:290-320, session/tools.ts:72-96
- INDEPENDENT GROUPS: 1
- SYNTHESIS: "C8 was a corollary of the (incorrect) C7. Since C7 is refuted, C8 is also refuted — subagent tool calls dispatch both hooks via the same mechanism as direct tool calls."

## claim nodes (pending/partial)

| claim_id | statement | type | risk | intent_ids | groups | status | synthesis |
|---|---|---|---|---|---|---|---|
| C9 | Hot/cold tiered memory (memfs pattern) would solve observability | design | normal | I2, I4 | 1 | unresolved | design candidate |
| C10 | SQLite is the universal substrate for cross-session state | design | normal | I1-I5 | 1 (ecosystem) | partial | adoption candidate |
| C11 | Custom tools via plugin `tool` field can route through hook | design | normal | I1-I5 | 1 | unresolved | design candidate |

## Refuted claims (corrections)

| claim_id | original statement | refutation evidence | status |
|---|---|---|---|
| C7-orig | `tool.execute.before/after` only fires for task subtask | Found SessionTools.resolve wraps every registry tool with both hooks | refuted → design unchanged |
| C8-orig | Subagent tool calls bypass | Both hooks dispatched via same path | refuted → design unchanged |
