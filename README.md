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

## Graph Sync (v0.11.0)

MetaGovernor wires the plugin into the native git hooks of **codegraph** and
**graphify** so each commit automatically reindexes both graphs. No more
polling loops, no more stale indexes.

### What it does on first load in a project

1. **Auto-install** codegraph via `npm i -D @colbymchenry/codegraph` and
   graphify via `pip install graphifyy` (falls back to `uv tool install
   graphifyy`) if they're not already on PATH.
2. **Run `codegraph init`** + **`graphify . --no-viz`** to build the initial
   indexes for the project.
3. **Run `graphify hook install`** to wire up the native `post-commit` and
   `post-checkout` git hooks. From that point on, every `git commit`
   triggers `graphify update` automatically (deterministic clustering with
   `PYTHONHASHSEED=0`, rebase/merge/cherry-pick detection, detached
   subprocess for non-blocking rebuild).

### What it does on each `git commit`

- **Primary path** (native git hook): `graphify update` runs in background.
- **Backup path** (plugin's `tool.execute.after`): detects `git commit` in
  bash commands and runs `codegraph sync -q [path]`. Catches the case
  where the user manually deleted the native hook.

### Plan enforcement

On the first message of each session, if the project has no `PLAN.md` and
no `## Plan` section in `AGENTS.md`, the plugin injects a one-time reminder:
"create a plan, commit per phase, push to fork + upstream". The reminder
honors the same gates as intervention (max 3, DONE+Oracle disables).

### PR reviewer bot feedback

When a bash command matches `gh pr ...` (e.g. `gh pr checks 42`, `gh pr view
42 --comments`), the plugin extracts failing check runs and review
comments. The next LLM turn receives them as actionable feedback so the
agent can apply fixes to keep the PR mergeable. Recognizes: codecov,
claude-code-review, CodeRabbit, etc.

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
