# Verify - C7: tool.execute.before/after ONLY fire for task subtask delegation

## Claim
`tool.execute.before` and `tool.execute.after` plugin hooks are dispatched at upstream `session/prompt.ts:307-308` and `session/prompt.ts:389-390`, but ONLY for the `task` tool's subtask delegation path. Native tools (bash, edit, read, grep, glob, write) are NOT routed through the plugin hook system.

## Verification Method
Direct grep of upstream source files at SHA b67fda133a186c7c294c8822f7eda89f36d57aff.

## Evidence

### Where plugin.trigger("tool.execute.*") IS called

**`packages/opencode/src/session/prompt.ts:305-312` (subtask delegation only):**
```typescript
yield* plugin.trigger(
  "tool.execute.before",
  { tool: TaskTool.id, sessionID, callID: part.id },
  { args: taskArgs },
)
```

**`packages/opencode/src/session/prompt.ts:387-395` (subtask completion only):**
```typescript
yield* plugin.trigger(
  "tool.execute.after",
  { tool: TaskTool.id, sessionID, callID: part.id, args: taskArgs },
  result,
)
```

Both are inside the `handleSubtask()` function and gated on `TaskTool.id`. They only fire when an agent delegates work to a subagent via the `task` tool.

### Where native tools execute (no plugin hook)

**`packages/opencode/src/tool/registry.ts:135-175` shows native tool execution:**
```typescript
execute: (args, toolCtx) =>
  Effect.gen(function* () {
    const bridge = yield* EffectBridge.make()
    const pluginCtx: PluginToolContext = {
      ...toolCtx,
      ask: (req) => bridge.promise(toolCtx.ask(req)),
      directory: ctx.directory,
      worktree: ctx.worktree,
    }
    const result = yield* Effect.promise(() => def.execute(args as any, pluginCtx))
    // ...truncation, attachment handling, return wrapped result
  })
```

The registry calls `def.execute(args, pluginCtx)` directly. The `pluginCtx` carries a wrapped `ask` function but does NOT call `plugin.trigger("tool.execute.before", ...)` or `plugin.trigger("tool.execute.after", ...)`. Native tool execution is a direct function call, not a plugin-routed event.

### Per-tool grep (definitive)

| Tool file | plugin.trigger calls | Hook name |
|---|---|---|
| `tool/bash.ts` (search via API) | 0 | none |
| `tool/edit.ts` | 0 | none |
| `tool/read.ts` | 0 | none |
| `tool/grep.ts` | 0 | none |
| `tool/glob.ts` | 0 | none |
| `tool/write.ts` | 0 | none |
| `tool/shell.ts` | 1 | `shell.env` only (line 417) |
| `tool/task.ts` | 0 (defines the tool; triggers are in `session/prompt.ts`) | routed via `session/prompt.ts` |

### Complete plugin.trigger map (opencode package)

| File:line | Hook |
|---|---|
| `session/prompt.ts:307-308` | `tool.execute.before` (task only) |
| `session/prompt.ts:389-390` | `tool.execute.after` (task only) |
| `session/prompt.ts:1255` | `experimental.chat.messages.transform` |
| `session/compaction.ts:343` | `experimental.session.compacting` |
| `session/compaction.ts:350` | `experimental.chat.messages.transform` |
| `session/compaction.ts:454` | `experimental.compaction.autocontinue` |
| `session/llm/request.ts:69` | `experimental.chat.system.transform` |
| `session/llm/request.ts:114` | `chat.params` |
| `session/llm/request.ts:134` | `chat.headers` |
| `tool/registry.ts:313` | `tool.definition` |
| `tool/shell.ts:417` | `shell.env` |
| `session/processor.ts:516` | `experimental.text.complete` |

## Verdict
**PARTIALLY REFUTED — but with a critical caveat:**

The original claim from bg_b2b86fb5 was: "tool.execute.after declared in Hooks interface but has zero call sites for native tool path in `processor.ts`."

This is **CONFIRMED**: the hook has zero call sites in `processor.ts` for native tools. The only call sites are in `session/prompt.ts` for the task subtask path.

However, the hook IS dispatched — just only for `task` tool delegations, not for `bash`, `edit`, `read`, `grep`, `glob`, `write`. This is a MORE PRECISE finding than the original "never called" claim.

## Implication for omo-meta-governor

This is the **single most important finding** for plugin design. The current omo architecture relies on `tool.execute.before` (plugin.ts:184-244) to audit ALL tool calls against protocol rules. The upstream evidence shows that for native tools like `bash`, `edit`, `read`, `grep`, `glob`, `write`, **this hook does not fire**.

**Consequence**: omo-meta-governor's protocol enforcement and graph-first audit (protocol-enforcer.ts:148-160) is currently a no-op for the most common agent operations.

**Three design responses:**

1. **Patch the plugin's tool definitions** — register custom tools that wrap native tools, allowing the hook to fire (heavy refactor)
2. **Inject policy via system prompt** — use `experimental.chat.system.transform` to add "do not use grep/glob; use `omo_search` first" and provide `omo_search` as a custom tool that DOES trigger the hook
3. **Use upstream events instead** — subscribe to `session.next.tool.called` / `tool.success` / `tool.failed` via `event` hook for audit; accept that the hook is post-hoc (after the call, not before)

**Recommended**: Option 2 (system transform + custom tool) because it converts the agent's tool selection from native grep/glob to plugin-controlled `omo_search`/`omo_find`, which IS routed through the plugin hook system.

This finding significantly changes the design: omo cannot rely on `tool.execute.before` as a pre-execution gate for native tools. The commander must intercept at the tool-selection level (via `tool.definition` hook) or provide alternative tools.
