# Plan: v0.23.0 — Remove AFT + Magic Context integrations (15 → 9 tools)

## Background

User decision (14/08/2026): memory is now handled by **agentmemory** (MCP via
`omo_remember`/`omo_recall_mcp`) and **OMO's native closed-loop** (SQLite lesson
store — `observeAndLearn` on `tool.execute.after`, backend default
`getDefaultSqliteBackend()`, plugin.ts:1034-1041; magicContext backend is
ALREADY a no-op stub). No integration needed — verified. Therefore remove the
**AFT** (aft CLI outline/zoom/safety) and **Magic Context** (ctx_memory /
ctx_search / ctx_note) integrations entirely.

CANCELLED context: the earlier AFT removal (first task of the session) was
reverted when the crash cause was misattributed; it was later confirmed the
crashes were zombie processes (fixed in v0.22.0 via proc-guard). This removal
is a fresh, deliberate feature decision — AFT and magic-context are no longer
needed in the plugin.

## Resulting tool surface (9 tools)

Removed (6): `omo_outline`, `omo_checkpoint`, `omo_undo` (AFT);
`omo_rule`, `omo_history`, `omo_note` (Magic Context).
Kept (9): `omo_search`, `omo_find`, `omo_impact`, `omo_path`, `omo_explain`
(codegraph/graphify); `omo_recall` (local SQLite), `omo_remember`,
`omo_recall_mcp` (agentmemory); `omo_health`.

## Files & changes

### 1. src/graph-retrieval.ts — remove AFT section
Delete the "AFT tools (v0.14.0)" section: `invokeAFTOutline`, `invokeAFTZoom`
(dead), `invokeAFTCheckpoint`, `invokeAFTUndo`, private `invokeAFTSubcommand`.
Keep `invokeGraphifySubcommand` and all codegraph/graphify methods. Keep the
proc-guard `runGuarded` import (still used by spawnWithTimeout).

### 2. src/custom-tools.ts — remove 6 builders
Remove: `buildOmoOutlineTool`+`OmoOutlineDeps`, `buildOmoCheckpointTool`+
`OmoCheckpointDeps`, `buildOmoUndoTool`+`OmoUndoDeps` (AFT section),
`buildOmoRuleTool`+`OmoRuleDeps`, `buildOmoHistoryTool`+`OmoHistoryDeps`,
`buildOmoNoteTool`+`OmoNoteDeps` (Magic Context section). Keep:
`buildOmoRememberTool` (→ agentmemory_memory_save), `buildOmoRecallMcpTool`
(→ agentmemory_memory_smart_search), `verifyDelivery`, `pollForDelivery`,
`setPendingDeliveryRegistry`, `pendingRegistryRef`. Update the bridge-tools
overview comment (L500-501: remove "Magic Context").

### 3. src/plugin.ts — imports, instantiations, registrations, audit
- Imports: remove `buildOmoRuleTool, buildOmoHistoryTool, buildOmoNoteTool`
  and `buildOmoOutlineTool, buildOmoCheckpointTool, buildOmoUndoTool`.
- Instantiation: remove the 6 `const omoXTool = buildOmoXTool(...)`.
- Two tool maps (disabled-path ~L408-410, enabled-path ~L1555-1563): remove the
  6 entries (omo_outline, omo_checkpoint, omo_undo, omo_rule, omo_history,
  omo_note). Keep omo_remember + omo_recall_mcp.
- `AuditState` fields `aftAvailable: boolean; aftUsed: boolean` (+2 default
  literals +2 AuditContext spreads): remove.
- `memoryTools` array (tool.execute.after): remove `"ctx_memory"`,
  `"ctx_search"`, `"ctx_note"` entries; keep agentmemory entries.
- `memorySaved` tracking: replace the `ctx_memory` startsWith block with
  `agentmemory_memory_save`.
- AFT detection block (`aft_zoom`/`aft_outline` → `sessionState.aftUsed`): remove.
- Violation text ("do not grep without trying AFT/codegraph first"):
  drop AFT mention, keep codegraph/graphify.
- Comments: remove "Magic Context, AFT" mentions.

### 4. src/protocol-enforcer.ts — remove AFT rules + Magic Context rules
- buildSystemInjection: rule 2 line — remove "Fall back to AFT (aft_zoom,
  aft_outline)"; Tool Routing Table — remove `ctx_memory(action="list")`,
  `ctx_search`, `ctx_note` lines; `ctx_memory` save line → agentmemory_memory_save;
  Empty-Result Escalation — remove `+ ctx_search`; hard rule "Do NOT use
  grep/find when aft_outline..."; "Do NOT duplicate ... ctx_memory" line;
  self-check "save it with ctx_memory" → agentmemory_memory_save.
- AuditContext: remove `aftAvailable?`, `aftUsed?` fields; update comments for
  `escalationAttempted` (drop ctx_search mention) and `memorySaved`.
- auditToolCall: remove aftAvailable/aftUsed locals; remove "aft-first" rule +
  "grep-without-aft" rule; discoveryTools: remove "aft_zoom","aft_outline";
  save-discovery-to-memory: drop ctx_memory check (keep memorySaved);
  remove ctx_reduce discipline rule block; empty-result message: drop
  "+ ctx_search"; memory-first rule: remove ctx_* entries + reword.

### 5. src/types.ts
- `MagicContextRead` interface: remove. `MemoryRead.magicContext`: remove.
  `MemorySource` union: remove "magicContext". `SlotMemory` comment (L132):
  reword to agentmemory meta_state slot. Header comment L10: remove
  "AFT + magic-context" → "agentmemory + boulder-state".

### 6. src/config.ts
- `MetaGovernorPluginConfig.memory.magicContextTimeoutMs`: remove field.
  (Keep boulderStateTimeoutMs.)

### 7. src/generate-schema.ts
- Remove `magicContextTimeoutMs` property from memory schema block.

### 8. src/memory-aggregator.ts
- Remove `MagicContextBackend` interface + `readMagicContext()` + degraded
  magicContext entries + header comment magic-context mention. Keep agentmemory
  + boulder-state readers.

### 9. Comments only
- src/mcp-client.ts header: remove "Magic Context, and AFT".
- src/session-bridge.ts L3/L139: remove "Magic Context".

### 10. Tests
- DELETE src/aft-args.test.ts (standalone AFT arg-splitting test).
- src/custom-tools.test.ts: remove 6 builder imports + 6 mock stubs (invokeAFT*,
  and any ctx mock) + AFT state tools describe + omo_rule/omo_history/omo_note
  tests + tools[] entries; count 15 → 9.
- src/mcp-client.test.ts: remove `aft_outline` and `ctx_memory` fixtures;
  isAvailable assertions updated; list expectation drops ctx_memory.
- src/memory-aggregator.test.ts: remove magic-context tests (slot contract,
  degrade, relevance) + magicContext backend fixture.
- src/types.test.ts: remove MagicContextRead half of the unavailable test.
- src/session-bridge.test.ts: replace ctx_memory fixture with
  agentmemory_memory_save.
- src/integration.test.ts: remove magicContext throwOn branch.

### 11. Docs (README / ARCHITECTURE / STRUCTURE)
- 15 custom tools → 9; remove omo_outline/checkpoint/undo/rule/history/note rows;
  remove AFT + Magic Context mentions from overview and tool tables; remove
  aft-args.test.ts row from STRUCTURE; keep historical changelog entries.
- Note in README: memory handled by agentmemory + OMO closed-loop (SQLite).

## Verification

- `bun run typecheck` exit 0.
- Per-file `bun test` (Windows): proc-guard, graph-retrieval, custom-tools,
  protocol-enforcer, memory-aggregator, mcp-client, session-bridge, types,
  config, generate-schema, integration, plugin, e2e, postwave.
- `bun build.ts` regenerates dist/ (0.23.0 baked).
- grep audit: zero `\bAFT\b`, zero `ctx_` (except allowed noise like
  "context" — verify), zero `invokeAFT`, zero buildOmoOutline/Checkpoint/Undo/
  Rule/History/Note in src/.
- Oracle review (3+ files changed).
- QA: count tool maps in plugin.ts → 9 keys × 2 sites = 18 entries.

## Release

- Bump package.json 0.22.1 → 0.23.0 (feature removal, minor).
- `bun build.ts` (bake version), verify bundle, `npm publish`.
- Verify tarball (exports.import intact, load probe v0.23.0).
- Commits per logical surface + push main + CI monitor.
