# Verify - C7 REFUTED: tool.execute.before/after dispatch for ALL native tools

## Original Claim
"tool.execute.before/after ONLY fire for task subtask delegation, NOT for native tools. This is a critical finding that makes omo's tool.execute.before audit at plugin.ts:184-244 dead for most operations."

## Refutation Evidence

**Source**: Direct upstream code inspection at SHA b67fda133a186c7c294c8822f7eda89f36d57aff.

**The dispatch lives in `packages/opencode/src/session/tools.ts` (`SessionTools.resolve`), NOT in the individual tool files.**

### The wrapping code (tools.ts, approximately lines 72-96)

```typescript
for (const item of yield* registry.tools({...})) {
    tools[item.id] = tool({
      description: item.description,
      inputSchema: jsonSchema(schema),
      execute(args, options) {
        return run.promise(
          Effect.gen(function* () {
            const ctx = context(args, options)
            yield* plugin.trigger(
              "tool.execute.before",  // ← DISPATCHED FOR EVERY REGISTRY TOOL
              { tool: item.id, sessionID: ctx.sessionID, callID: ctx.callID },
              { args },
            )
            const result = yield* item.execute(args, ctx)
            const output = { ... }
            yield* plugin.trigger(
              "tool.execute.after",   // ← DISPATCHED FOR EVERY REGISTRY TOOL
              { tool: item.id, sessionID: ctx.sessionID, callID: ctx.callID, args },
              output,
            )
            return output
          }),
        )
      },
    })
}
```

This wrapping is applied to:
- ALL 16+ built-in tools in `ToolRegistry` (Read, Edit, Write, Bash/Shell, Glob, Grep, Lsp, WebFetch, WebSearch, Skill, Task, Question, ApplyPatch, PlanExit, TodoWrite, Invalid)
- ALL MCP tools (loaded via MCP server connections)
- ALL MCP resource tools (`list_mcp_resources`, `list_mcp_resource_templates`, `read_mcp_resource`)

### Why my first verification was wrong
I grepped `plugin.trigger` in `tool/*.ts` files directly and found 0 matches in `bash.ts`, `edit.ts`, `read.ts`, `grep.ts`, `glob.ts`, `write.ts`. I concluded the hooks don't fire. This was a **search miss** — the trigger calls live in `session/tools.ts` (the SessionTools resolver), not in the tool implementation files.

The correct grep is:
- `grep -rn 'plugin.trigger' packages/opencode/src/session/tools.ts` → finds both hooks
- `grep -rn 'plugin.trigger.*tool.execute' packages/opencode/src/` → finds the wrapping

### Subagent hooks (Path B)
When `handleSubtask` (prompt.ts) executes the TaskTool, it explicitly calls both hooks at approximately lines 290-320:

```typescript
yield* plugin.trigger(
  "tool.execute.before",  // ← DISPATCHED
  { tool: TaskTool.id, sessionID, callID: part.id },
  { args: taskArgs },
)
const result = yield* taskTool.execute(taskArgs, { ... })
yield* plugin.trigger(
  "tool.execute.after",   // ← DISPATCHED
  { tool: TaskTool.id, sessionID, callID: part.id, args: taskArgs },
  result,
)
```

But the TaskTool's own `execute` is also wrapped via `SessionTools.resolve` when called through the AI SDK. So the hooks fire in BOTH paths.

## Verdict
**C7 REFUTED** — the `tool.execute.before/after` hooks ARE dispatched for every native tool. The architecture is sound.

## Implication for omo-meta-governor (corrected)

The original concern (C7) was that omo's `tool.execute.before` audit at `plugin.ts:184-244` is dead code. **This is FALSE.** The audit DOES fire for every bash, edit, read, grep, glob, write call.

The real problems remain:
- **C1**: Stub backends discard lesson writes (still broken)
- **C2**: Plugin never actually invokes graph tools (still broken)
- **C3**: Default config makes governance invisible (still broken)

But the **enforcement architecture works**. The fix is to:
1. Wire real SQLite backends (C1 fix) — scoring engine will then produce real decisions
2. Use the `tool.execute.before` hook to actually invoke `codegraph_explore` or `graphify query` and inject results into the agent's context before the tool runs (C2 fix) — this is the right place to do it now that we know the hook works
3. Fix default config to make governance visible (C3 fix)

**This correction is a major win** — omo's existing architecture is mostly correct. The 3 design fixes above are sufficient to make the plugin feel like a real commander.

## Acknowledgment
My first verification (verify-tool-execute-hooks-only-task.md) was based on a flawed grep. The refutation from bg_173c224c is more accurate. Updating claim-graph.md and verification-economics.md accordingly.
