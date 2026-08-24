# PLAN: Fix Plugin Loop + Graphify Black Window

**Date**: 2026-08-17
**Version**: v0.23.1 (patch)
**Status**: IN PROGRESS

---

## Bug Summary

### Bug 1: Plugin Inducing Agent Loop
The plugin's protocol violation injection creates a feedback loop where the agent responds to violation messages but triggers NEW violations, causing repeated injections.

### Bug 2: Graphify Autoupdate Black Window  
When graphify watch mode activates, a black cmd.exe window opens and immediately closes because:
1. `spawn()` without `shell: false` opens a window on Windows
2. `python3` is a WindowsApps stub WITHOUT graphifyy installed
3. Command fails immediately → window closes (black flash)

---

## Phase 1: Fix Protocol Violation Loop

### Root Cause Analysis

**Code Path**:
- `tool.execute.before` (L604-734): Detects violations, pushes to `pendingViolations`
- `messages.transform` (L1336-1353): Consumes and injects `pendingViolations` as synthetic user messages
- Agent responds to violation message → uses tools that trigger NEW violations → loop

**Example Loop**:
```
1. Agent uses grep → violation detected → queued in pendingViolations
2. messages.transform injects: "[META-GOVERNOR PROTOCOL VIOLATIONS - YOU MUST COMPLY]..."
3. Agent responds, uses grep again → NEW violation detected
4. Next transform injects NEW violations → loop continues
```

### Fix Strategy

**Option A: Violation Cooldown (RECOMMENDED)**
Add a cooldown period after injecting violations. During cooldown, new violations are logged but NOT queued for injection.

```typescript
// In AuditState type (plugin.ts L453):
lastViolationInjectionAtMs: number;

// In tool.execute.before (L671-701):
const COOLDOWN_MS = 30_000; // 30 seconds
if (state.lastViolationInjectionAtMs && 
    Date.now() - state.lastViolationInjectionAtMs < COOLDOWN_MS) {
  // Log but don't queue during cooldown
  logToFile("info", `violation during cooldown, skipping queue`);
  return;
}

// In messages.transform (L1336-1353):
// After injecting violations:
state.lastViolationInjectionAtMs = Date.now();
```

**Option B: Max Violations Per Session**
Cap violations per session to prevent accumulation.

```typescript
// In AuditState type:
violationCount: number;

// In tool.execute.before:
const MAX_VIOLATIONS_PER_SESSION = 5;
if (state.violationCount >= MAX_VIOLATIONS_PER_SESSION) {
  // Stop queuing after cap
  return;
}
```

### Implementation Tasks

- [ ] **Task 1.1**: Add `lastViolationInjectionAtMs` to AuditState type
- [ ] **Task 1.2**: Add cooldown logic in `tool.execute.before`
- [ ] **Task 1.3**: Update cooldown timestamp after injection in `messages.transform`
- [ ] **Task 1.4**: Add tests for cooldown behavior
- [ ] **Task 1.5**: Verify loop is broken with manual testing

---

## Phase 2: Fix Graphify Black Window

### Root Cause Analysis

**Code Path**:
- `startWatch()` at L299-351 spawns graphify watch process
- Line 332: `spawn("python3", ["-m", "graphify", ".", "--no-viz", "--watch"], {...})`

**Problems**:
1. On Windows, `spawn()` without `shell: false` opens a cmd.exe window
2. `python3` is a WindowsApps stub WITHOUT graphifyy (memory #mem_msww7146)
3. Command fails immediately → window closes (black flash)

### Fix Strategy

**Fix 1: Add `shell: false` to prevent window creation**

```typescript
// In startWatch() at L332:
child = spawn("python3", ["-m", "graphify", ".", "--no-viz", "--watch"], {
  cwd: projectDir,
  stdio: "ignore",
  detached: true,
  shell: false,  // ADD THIS - prevents window on Windows
  env: { ...process.env, OMO_MG_SPAWN: "1" },
})
```

**Fix 2: Use resolved Python interpreter**

Create a helper function to resolve the correct Python interpreter:

```typescript
// Add to graph-sync.ts:
async function resolvePythonWithGraphify(): Promise<string> {
  // Try graphify binary first (Windows: pip installs as "graphify")
  try {
    execSync("graphify --version", { stdio: "ignore", timeout: 5000 });
    return "graphify";
  } catch {}
  
  // Try python (Windows: real interpreter at C:\Python314)
  try {
    execSync('python -c "import graphifyy"', { stdio: "ignore", timeout: 5000 });
    return "python";
  } catch {}
  
  // Try python3 (fallback)
  try {
    execSync('python3 -c "import graphifyy"', { stdio: "ignore", timeout: 5000 });
    return "python3";
  } catch {}
  
  return "python3"; // default
}
```

**Fix 3: Use resolved interpreter in startWatch()**

```typescript
// In startWatch():
if (tool === "graphify") {
  const pythonCmd = await resolvePythonWithGraphify();
  const args = pythonCmd === "graphify" 
    ? [".", "--no-viz", "--watch"]
    : ["-m", "graphify", ".", "--no-viz", "--watch"];
  
  child = spawn(pythonCmd, args, {
    cwd: projectDir,
    stdio: "ignore",
    detached: true,
    shell: false,  // Prevent window on Windows
    env: { ...process.env, OMO_MG_SPAWN: "1" },
  })
}
```

### Implementation Tasks

- [ ] **Task 2.1**: Add `resolvePythonWithGraphify()` helper function
- [ ] **Task 2.2**: Update `startWatch()` to use resolved Python
- [ ] **Task 2.3**: Add `shell: false` to spawn call
- [ ] **Task 2.4**: Add tests for Python resolution
- [ ] **Task 2.5**: Verify no black window on Windows

---

## Phase 3: Testing & Verification

### Test Scenarios

**Scenario 1: Violation Loop Break**
- Agent uses grep → violation injected
- Agent uses grep again within 30s → NO new violation injected (cooldown)
- After 30s, agent uses grep → violation injected again

**Scenario 2: Graphify Watch No Window**
- Enable graphify watch mode
- Verify no cmd.exe window appears on Windows
- Verify graphify process runs in background

**Scenario 3: Existing Tests Pass**
- Run `bun test` → all tests pass
- Run `bun run typecheck` → no type errors
- Run `bun build.ts` → clean build

---

## Phase 4: Commit & Publish

### Commit Messages

```
fix: break protocol violation feedback loop (v0.23.1)

- Add 30s cooldown after violation injection
- Prevents agent loop where violations trigger more violations
- Cooldown logged but violations still recorded for audit

fix: prevent graphify black window on Windows (v0.23.1)

- Add shell:false to spawn() to prevent cmd.exe window
- Resolve correct Python interpreter (python vs python3)
- Fixes black flash when graphify watch activates
```

### Version Bump

- Update `package.json` version to `0.23.1`
- Rebuild with `bun build.ts`
- Publish to npm

---

## Success Criteria

- [ ] Agent no longer enters loop when responding to violation messages
- [ ] No black window appears when graphify autoupdate activates
- [ ] All existing tests pass
- [ ] New tests cover cooldown and Python resolution
- [ ] Clean build with no type errors

---

## Notes

### Memory References
- `mem_msxj54rr_f8a73126e3f5`: Plugin loop behavior analysis
- `mem_msxj59c9_3113ffa61c5a`: Graphify black window analysis
- `mem_msww7146_d56ffd686729`: Windows Python detection (python3 vs python)

### Related Code
- `src/graph-sync.ts`: Graph initialization and watch mode
- `src/plugin.ts`: Protocol violation injection and messages.transform
- `src/proc-guard.ts`: Process tree killing on Windows

### Risk Assessment
- **Low Risk**: Both fixes are isolated to specific code paths
- **Cooldown fix**: Only affects violation injection timing, not detection
- **Python resolution**: Uses same pattern as existing `initGraphify()`


## Implementation roadmap

- [Wave 3 + Wave 4: codegraph + graphify integration](./.omo/plans/codegraph-graphify-integration.md) — completed in v0.27.0 + v0.27.1 (33 omo_* tools, 3 new config knobs, observability fields in omo_health).
