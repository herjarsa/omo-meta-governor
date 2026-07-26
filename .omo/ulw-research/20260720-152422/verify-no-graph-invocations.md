# Verify - C2: Plugin never invokes graph query tools

## Claim
The plugin never calls `codegraph_explore`, `codegraph_search`, `graphify query`, `graphify path`, or `graphify explain` programmatically. All references to these tools are in prompt text or audit detection lists.

## Verification Method
Direct grep across all TypeScript source files for tool invocation patterns.

## Evidence

### Grep result for graph tool invocations in src/
```
/home/herjarsa/PROYECTOS-IA/omo-meta-governor/src/protocol-enforcer.ts:268:  const discoveryTools = ["grep", "glob", "read", "aft_zoom", "aft_outline", "codegraph_explore", "graphify query"]
```

**Exactly ONE match** across all 17 source files, and it is a string in an array used for violation detection — not a tool invocation.

### Where the tools ARE referenced
1. `src/protocol-enforcer.ts:46` — `buildSystemInjection()` generates prompt text that tells the agent to use these tools
2. `src/protocol-enforcer.ts:158` — violation detail text mentions the tools
3. `src/plugin.ts:494` — plan reminder mentions graphify hook
4. `src/plugin.ts:522` — violation message text mentions the tools
5. `src/protocol-enforcer.ts:268` — `discoveryTools` array (this grep hit)

All five references are **prompt text strings** that instruct the agent (the LLM) to use the tools. The plugin itself does not invoke them.

### What the plugin DOES do with graph tools
- `src/plugin.ts:76-81` — Detect if `.codegraph/` and `graphify-out/` directories exist
- `src/plugin.ts:86-92` — Fire-and-forget `runGraphSync()` to install/init/watch the graph backends
- `src/graph-sync.ts:63-104` — Install codegraph (npm) and graphify (pip/uv)
- `src/graph-sync.ts:217-253` — Initialize both backends
- `src/graph-sync.ts:264-338` — Start watch processes
- `src/graph-sync.ts:515-527` — Install graphify git post-commit hook
- `src/graph-sync.ts:643-712` — `triggerCodegraphSync()` after `git commit` detection
- `src/protocol-enforcer.ts:148-160` — AUDIT (not enforce) when grep/glob is used and a graph dir exists

The plugin is a **meta-supervisor for graph lifecycle** (install/init/watch/upgrade/reindex) but never actually runs `codegraph explore` or `graphify query`.

### Why this matters
The agent is told to use `codegraph_explore` and `graphify query` via system prompt injection, but:
1. These tools are not provided by the plugin
2. The agent must obtain them from elsewhere (CodeGraph MCP, Graphify MCP, or direct CLI)
3. The `aftAvailable` flag (plugin.ts:201, 552) is initialized to `false` and never set to `true` → the AFT-first rule (protocol-enforcer.ts:162-176) never fires because `aftAvailable && !aftUsed` is always false
4. The graph detection is snapshotted at plugin load time (plugin.ts:76-81) → race condition with async `runGraphSync()`

## Verdict
**CONFIRMED** — the plugin is a graph lifecycle manager, not a graph tool provider.

## Implication for omo-meta-governor
The fix requires real tool invocation. Options:
1. **Shell out to `npx codegraph explore ...` / `graphify query ...` in `tool.execute.before`** — race-free, async with timeout
2. **Register custom tools via the plugin's `tool` field** — but the plugin's current entry only exports hooks, not tools
3. **Inject graph results into context** — run the query in `tool.execute.before` and mutate `output.args` to add a synthetic context message
4. **Fix the `aftAvailable` flag** — add a one-time probe at plugin init to detect AFT CLI

The recommended fix is option 1 + option 4 combined.
