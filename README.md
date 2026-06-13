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

## Intervention (v0.3.0)

MetaGovernor can inject its decisions into the active agent's context
so the agent is aware of governance warnings, escalations, or stop signals.

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
      "minActionForMessage": "warn"
    }
  }
}

```

| Field | Default | Description |
|-------|---------|-------------|
| `mode` | `"silent"` | How to inject: `"silent"`, `"message"`, or `"system"` |
| `includeDecisionHistory` | `true` | Whether to include recent decision history |
| `maxHistoryMessages` | `5` | Max history entries when includeDecisionHistory is true |
| `minActionForMessage` | `"warn"` | Minimum action: `"warn"` (all non-continue), `"escalate"`, or `"stop"` |

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
