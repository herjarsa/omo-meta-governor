# @herjarsa/omo-meta-governor

Self-judging agent orchestration layer for OpenCode. Observes tool executions,
reads session state, scores progress, and dispatches decisions.

## Install

```bash
npm install @herjarsa/omo-meta-governor
```

## Usage

Add as a plugin in your OpenCode config:

```jsonc
{
  "plugins": ["@herjarsa/omo-meta-governor"]
}
```

Configure:

```jsonc
{
  "meta_governor": {
    "enabled": true
  }
}
```

## How it works

After every tool call, MetaGovernor:
- Reads session signals (deviations, iteration budget, progress)
- Scores the session against weighted evidence
- Dispatches: `continue | warn | escalate | stop`

See [docs/guide/meta-governor.md](docs/guide/meta-governor.md) for full docs.

## Intervention

MetaGovernor can inject its decisions into the active agent's context
so the agent is aware of governance warnings, escalations, or stop signals.

### v0.10.0 — Loop prevention

The plugin now self-disables intervention when the agent's task is verifiably
complete. This fixes the v0.3.0–v0.9.x bug where the plugin kept injecting
synthetic user messages indefinitely after the agent had finished.

Three mechanisms enforce the cap:

1. **`<promise>DONE</promise>` + Oracle verified** — the agent emits this signal
   to mark the task complete. If Oracle has verified the work (the agent
   invoked `task(subagent_type="oracle")` and got a PASS verdict), the plugin
   disables intervention for that session.
2. **`maxInterventionsPerSession`** — hard cap (default `3`) on the number of
   times a session can receive an injection. Once reached, no more injections.
3. **Cross-session scoping** — decisions are now scoped to the current
   sessionID. The plugin no longer pulls decisions from unrelated sessions.

### Modes

| Mode | Mechanism | Effect |
|------|-----------|--------|
| `silent` | (none) | Decision is logged only — no injection |
| `message` | `experimental.chat.messages.transform` | Injects a synthetic user message visible to the LLM |
| `system` | `experimental.chat.system.transform` | Appends guidance to the system prompt |

### Configuration

```jsonc
{
  "meta_governor": {
    "enabled": true,
    "intervention": {
      "mode": "message",
      "includeDecisionHistory": true,
      "maxHistoryMessages": 5,
      "minActionForMessage": "stop",
      "maxInterventionsPerSession": 3,
      "respectDoneSignal": true
    }
  }
}
```

### Fields

| Field | Default | Description |
|-------|---------|-------------|
| `mode` | `"silent"` | How to inject: `"silent"`, `"message"`, or `"system"` |
| `includeDecisionHistory` | `true` | Whether to include recent decision history |
| `maxHistoryMessages` | `5` | Max history entries when includeDecisionHistory is true |
| `minActionForMessage` | `"stop"` (v0.10.0) | Minimum action: `"warn"`, `"escalate"`, or `"stop"`. Default is now `"stop"` so warnings do not auto-trigger injection. Opt UP to `"warn"` explicitly. |
| `maxInterventionsPerSession` | `3` (v0.10.0) | Hard cap on injections per session. Once reached, no more injections until session restart. |
| `respectDoneSignal` | `true` (v0.10.0) | When true, the plugin stops injecting the moment the agent emits `<promise>DONE</promise>` AND Oracle has verified the work. |
### How it works

1. After every tool call, MetaGovernor runs the orchestrator pipeline.
2. If the decision is non-continue and meets `minActionForMessage`, it is
   stored in an in-memory decision store keyed by session ID.
3. When the next LLM call starts, the appropriate transform hook fires:
   - `message` mode: a synthetic `UserMessage` with `synthetic: true` flag
     is prepended to the message list.
   - `system` mode: the decision message is appended to the system prompt.
4. The decision is removed from the store after injection (one-shot).


## License

MIT
