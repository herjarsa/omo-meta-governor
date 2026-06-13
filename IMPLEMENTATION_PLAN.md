# MetaGovernor v0.3.0 Intervention Feature

## Goal
Make MetaGovernor visible to the active agent (Sisyphus) by injecting its recommendations into the chat context via `experimental.chat.messages.transform`.

## Changes

### 1. types.ts
- Add `InterventionMode` type: `"silent" | "message" | "system"`
- Add `InterventionConfig` interface:
  - mode: InterventionMode
  - includeDecisionHistory: boolean
  - maxHistoryMessages: number
  - minActionForMessage: "warn" | "escalate" | "stop"
- Add `intervention` field to `OrchestratorConfig`
- Add `intervention` field to `MetaGovernorPluginConfig`

### 2. config.ts
- Update `MetaGovernorPluginConfig` with `intervention` field
- Update `loadOrchestratorConfig` to project `intervention` with defaults

### 3. decision-store.ts (NEW)
- In-memory Map<string, DecisionHandlerOutput>
- `storeDecision(sessionID, decision)`
- `takeDecision(sessionID)` — returns decision and clears it
- `hasDecision(sessionID)`

### 4. plugin.ts
- In `tool.execute.after`:
  - After runMetaGovernor, if decision.action !== "continue" and meets threshold, store it
- Add `experimental.chat.messages.transform` hook:
  - For each message list, check if session has a stored decision
  - If mode === "message": insert a synthetic UserMessage with the decision message + context
  - If mode === "system": append to system strings (but we don't have access here, so we'll skip this or use chat.system.transform)
  - If mode === "silent": no-op
- Add `experimental.chat.system.transform` hook (for system mode):
  - If session has stored decision, append guidance to system strings

### 5. index.ts
- Export `InterventionConfig` and `InterventionMode` types
- Export decision-store functions if needed

### 6. plugin.test.ts (NEW)
- Test that createMetaGovernorPlugin returns hooks
- Test that tool.execute.after stores decisions when intervention is enabled
- Test that experimental.chat.messages.transform injects message when a decision is stored
- Test that mode "silent" does not inject anything

### 7. README.md
- Document intervention modes
- Document config example

### 8. package.json
- Bump version to 0.3.0

### 9. Build & Publish
- Run tests
- Build
- Commit
- Tag v0.3.0
- Publish to npm
- Update GitHub release

## Notes
- The injected message will be seen by the LLM but NOT displayed as a separate visible user message in the OpenCode UI (unless OpenCode renders synthetic messages). However, the LLM will respond to it.
- For a truly visible agent, OpenCode would need to support plugin-created subagent messages; that is not available in 1.17.4.
