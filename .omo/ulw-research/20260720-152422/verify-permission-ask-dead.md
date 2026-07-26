# Verify - C5: permission.ask is a dead hook

## Claim
`permission.ask` plugin hook is declared in `@opencode-ai/plugin` Hooks type but NEVER dispatched by upstream runtime code.

## Verification Method
Direct read of upstream `packages/opencode/src/permission/index.ts` at SHA b67fda133a186c7c294c8822f7eda89f36d57aff via raw GitHub fetch.

## Evidence

### Upstream permission service (lines 1-50)
```typescript
// packages/opencode/src/permission/index.ts
import { EventV2Bridge } from "@/event-v2-bridge"
// ...
export const Event = PermissionV1.Event
export interface Interface {
  readonly ask: (input: PermissionV1.AskInput) => Effect.Effect<void, PermissionV1.Error>
  readonly reply: (input: PermissionV1.ReplyInput) => Effect.Effect<void, PermissionV1.NotFoundError>
  readonly list: () => Effect.Effect<ReadonlyArray<PermissionV1.Request>>
}
```

The `Permission.Service` interface exposes `ask`/`reply`/`list` operations but **does not call `Plugin.trigger("permission.ask", ...)` anywhere**. The grep across `permission/index.ts` returned zero `plugin.trigger` or `trigger(` call sites.

### How permission events actually flow
- The permission service publishes via `EventV2Bridge.Service` (line 2 import) which is the v2 event bridge
- Plugin `event` hook receives these as `permission.asked`, `permission.replied`, `permission.v2.asked`, `permission.v2.replied` events
- NOT as the typed `permission.ask` hook that requires `Plugin.trigger("permission.ask", {permission}, {status})`

## Verdict
**CONFIRMED** — `permission.ask` is dead. Plugins must use the `event` hook listening for `permission.asked` / `permission.v2.asked` events instead.

## Implication for omo-meta-governor
Any policy enforcement that needs to intercept permission decisions must:
1. Subscribe via `event` hook to `permission.asked` / `permission.v2.asked` events
2. Cannot use the typed `permission.ask` hook to block decisions
3. Cannot directly block tool calls pre-permission via this hook — must use `tool.execute.before` and reject by mutating `output.args` to a no-op or throwing
