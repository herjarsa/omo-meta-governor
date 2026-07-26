# Verify - C3: Default configuration creates invisible governance trap

## Claim
The default configuration makes the plugin's governance invisible to the user, even when `enabled: true` is explicitly set.

## Verification Method
Direct read of `src/config.ts` and `src/plugin.ts` for default values and gate conditions.

## Evidence

### Default values from src/config.ts
```
92:    enabled: false,
164:      minActionForMessage: full.intervention?.minActionForMessage ?? "stop",
```

Plus from `src/plugin.ts`:
```
159:      intervention: {
160:        mode: "silent",
164:        minActionForMessage: "stop",
```

And from protocol config:
```
172:      protocolEnforcement: {
173:        enabled: false,
175:        auditToolCalls: false,
176:        injectIntoSystem: false,
```

### The 4-layer trap

1. **Layer 1: Plugin disabled by default** (`config.ts:92`)
   - Even if user sets `enabled: true`, they must also set the sub-features
   - The README does not prominently warn about this

2. **Layer 2: Intervention mode = "silent"** (`plugin.ts:160`)
   - `silent` mode means `messages.transform:466` early-returns
   - `system.transform:586-600` does not append governance decisions
   - User sees NO injected messages regardless of scoring

3. **Layer 3: minActionForMessage = "stop"** (`config.ts:164`)
   - Only the highest-severity decision ("stop") triggers message injection
   - But the scoring engine with empty backends NEVER produces a "stop" decision
   - Even in "message" mode, nothing is injected

4. **Layer 4: Protocol enforcement disabled** (`config.ts:173,175,176`)
   - No system prompt injection
   - No tool call auditing
   - No violation detection

### Combined effect
A user who:
- Installs the plugin
- Sets `meta_governor: { enabled: true }` in their config

Gets:
- The orchestrator pipeline running on stub backends
- All scoring returning "continue" (score 0)
- Zero messages injected (silent mode)
- Zero protocol rules enforced
- Only side effect: file logger writes to `~/.config/opencode/meta-governor.log`
- Only visible user effect: post-commit graph reindex (if codegraph/graphify installed)

The user perceives "the plugin does nothing" because it literally does nothing visible.

## Verdict
**CONFIRMED** — the default configuration is a layered trap. Even explicit `enabled: true` is insufficient without also setting `intervention.mode: "message"` and providing real backends.

## Implication for omo-meta-governor
Three fixes needed:
1. Change default `intervention.mode` to `"message"` (or remove the silent mode entirely)
2. Change default `minActionForMessage` to `"warn"` (so warn/escalate/stop all trigger)
3. Provide a sensible default `backends` implementation (SQLite) so the pipeline actually produces decisions
4. Add a startup log line that explicitly says: "MetaGovernor active. Mode: message. Backends: sqlite. To disable, set meta_governor.enabled = false"
