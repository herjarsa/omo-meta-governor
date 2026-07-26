# Verify - C6: event hook is fire-and-forget

## Claim
The `event` plugin hook is called with `void` prefix → fire-and-forget, no awaiting, no error handling.

## Verification Method
Direct read of upstream `packages/opencode/src/plugin/index.ts` at SHA b67fda133a186c7c294c8822f7eda89f36d57aff.

## Evidence

### Plugin event subscription (lines 251-258)
```typescript
const unsubscribe = yield* events.listen((event) => {
  if (event.location?.directory !== ctx.directory) return Effect.void
  return Effect.sync(() => {
    for (const hook of hooks) {
      void hook["event"]?.({ event: { id: event.id, type: event.type, properties: event.data } as any })
    }
  })
})
```

The `void` prefix on `hook["event"]?.(...)` is the key indicator. This means:
1. The promise returned by the event hook is **discarded** (voided)
2. The dispatcher does NOT await completion
3. Any error thrown by the event hook is **silently dropped** (unhandled promise rejection)
4. The `Effect.sync` wrapper completes immediately after dispatching

### Implication
A plugin's `event` handler can never:
- Block the event bus
- Signal a decision back to the system
- Guarantee completion before the next event
- Propagate errors to the upstream
- Delay event processing

## Verdict
**CONFIRMED** — `event` hook is fire-and-forget. Plugin authors must:
- Use synchronous code in event handlers (no async)
- Catch their own errors internally
- Not rely on completion for downstream effects
- Use typed hooks (e.g., `tool.execute.before`, `tool.execute.after`) for any synchronous mutation
- Use the `client` API (PluginInput) for any stateful side effect

## Implication for omo-meta-governor
The plugin's `event` hook in `experimental.chat.system.transform` and `experimental.chat.messages.transform` is the correct channel for synchronous intervention. The `event` hook should be used only for:
- Metrics collection
- Background async work (with internal error handling)
- Session state tracking
- NOT for blocking or signaling back to the system
