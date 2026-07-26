# Verify - C1: Plugin runs on stub backends by default

## Claim
The `agentmemory`, `magicContext`, `boulderState`, and `writeBackend` interfaces are populated with no-op stubs when the user does not provide `deps.backends`.

## Verification Method
Direct grep of `src/plugin.ts` for the stub implementations.

## Evidence

### src/plugin.ts lines 338-346
```
339:            agentmemory: { smartSearch: async () => ({ lessons: [], crystals: [] }) },
340:            magicContext: { slotList: async () => [] },
341:            boulderState: { boulderRead: async () => [] },
344:            saveMemory: async () => ({ id: "" }),
345:            saveLesson: async () => ({ id: "" }),
```

Every backend function returns empty data:
- `smartSearch()` → `{ lessons: [], crystals: [] }` — zero lessons
- `slotList()` → `[]` — zero context slots
- `boulderRead()` → `[]` — zero task state
- `saveMemory()` → `{ id: "" }` — fake write
- `saveLesson()` → `{ id: "" }` — fake write

### Downstream impact
- `runMetaGovernor()` in `src/orchestrator.ts:159` calls `aggregateRead()` which returns zero data
- `scoring-engine.ts:62-122` computes scores with zero evidence → always returns "continue" (score < warn threshold)
- `closed-loop-learning.ts:114-143` calls `saveMemory`/`saveLesson` which write to fake stub → lessons never persist
- Decision store in `src/decision-store.ts` never receives a non-continue decision
- `messages.transform:533-583` never injects a governance message because `storeDecision` was never called

## Verdict
**CONFIRMED** — the default `deps.backends` are no-op stubs that produce zero observable output. The user's `agentmemory_memory_smart_search` returning `lessons: []` is the direct consequence.

## Implication for omo-meta-governor
The fix is to provide real backends. Options:
1. **SQLite + better-sqlite3** (recommended, matches ecosystem pattern from opencode-mem, opencode-telemetry, opencode-ensemble)
2. **JSON file persistence** (simpler, no native deps)
3. **Delegate to external agentmemory server** (requires user setup)
4. **Embed lessons in the plugin's own state** (write to ~/.config/opencode/meta-governor/lessons.jsonl)

The first option (SQLite) is the recommended design — see `verify-upstream-feasibility.md` for the broader pattern.
