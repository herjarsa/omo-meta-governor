# Verification Economics

| claim | risk | error cost | verification cost | chosen path | decision | outcome | residual risk |
|---|---|---|---|---|---|---|---|
| C1 stub backends | high | miss root cause | low | grep plugin.ts:338-346 | verify now | CONFIRMED | none |
| C2 no graph invocations | high | miss design opportunity | low | grep src/ for graph tool calls | verify now | CONFIRMED | none |
| C3 invisible defaults | high | misdiagnose trap | low | read config.ts:92-175 | verify now | CONFIRMED | none |
| C4 feasible commander | high | design impossibility | high | 5-group convergence | verify | CONFIRMED | none |
| C5 permission.ask dead | normal | miss workarounds | low | grep upstream packages | verify | CONFIRMED | none |
| C6 event fire-and-forget | high | race conditions | medium | read plugin/index.ts:251-258 | verify | CONFIRMED | none |
| C7 tool hooks only task | high | wrong enforcement model | medium | grep session/prompt.ts + tool/registry.ts | verify | CONFIRMED + REFINED | none |
| C8 subagent bypass | high | security model error | medium | grep tool/registry.ts | verify | REFUTED + REFINED | none |

## Verification artifacts produced

1. `verify-stub-backends.md` (C1) - grep evidence
2. `verify-no-graph-invocations.md` (C2) - grep evidence
3. `verify-invisible-defaults.md` (C3) - config.ts excerpt
4. `verify-upstream-feasibility.md` (C4) - 5-group convergence
5. `verify-permission-ask-dead.md` (C5) - upstream grep
6. `verify-event-fire-and-forget.md` (C6) - plugin/index.ts excerpt
7. `verify-tool-execute-hooks-only-task.md` (C7) - precise call-site map

## Findings that changed the design space

C7 is the most important finding. It means:
- omo-meta-governor's current `tool.execute.before` audit at `plugin.ts:184-244` is **dead code** for native tools
- The graph-first protocol rule at `protocol-enforcer.ts:148-160` only fires when the LLM is about to use `task` tool, which is rare
- The commander must either (a) provide its own tools that DO route through hooks, or (b) use `tool.definition` hook to hide native tools, or (c) inject system-prompt-level policy

This single finding changes the implementation strategy from "audit existing tool calls" to "intercept tool selection."
