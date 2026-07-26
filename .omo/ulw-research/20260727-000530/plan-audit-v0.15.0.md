# Plan de Auditoría ULTRA — `@herjarsa/omo-meta-governor` v0.15.0 → v0.16.0

**Versión actual publicada:** `0.15.0` (HEAD: `c672b71 feat: phase-aware DONE signal + PLAN-COMPLETE marker`)
**Versión objetivo:** `0.16.0` — Cierra los gaps críticos identificados en la auditoría multi-frente.
**Principio rector:** Aditivo en su mayoría, breaking en (a) `takeAnyDecision()` deprecado/eliminado, (b) default de `phaseAwareDoneSignal` cambia a `true` (migración documentada en v0.15.0), (c) `metricsCollector` ahora usa la versión del `package.json` en vez de hardcoded.
**Fecha de auditoría:** 2026-07-27

---

## 1. Resumen ejecutivo

Auditoría exhaustiva de 6 frentes (arquitectura/hooks, 15 custom tools, storage, scoring/decision, graph sync, tests/build/security). Se identificaron **50+ hallazgos** distribuidos en:

| Severidad | Cuenta | Naturaleza |
|-----------|--------|------------|
| **Critical** | 11 | Memory leak, race conditions, npm install roto, ZERO test coverage de superficie pública, args mal pasados a AFT, dead code en escalación, datos en tránsito sin verificar |
| **High** | 17 | `as never` cast, `_client` race, logger no-op, dead config (`maxLessonsPerSession`), tool sin tests, drift de defaults, mock features sin implementar |
| **Medium** | 14 | Formula de score no documentada, NaN propagation, devDeps mis-classified, lockfiles duplicados, feature flag no implementado |
| **Low** | 9 | Code style, O(n) en lookups, regex gaps, sinteticos faltantes |
| **Refactor** | 4 | Interfaces vacías, código duplicado, plan reminder Set no cleared |

**Bloqueador de release actual:** Conflicto en `package.json` con auto-referencia (`@herjarsa/omo-meta-governor: "^0.14.4"`) impide que `npm install` resuelva correctamente.

**Riesgo operacional mayor:** Memory leak en `auditSessions` Map. Una sesión de trabajo larga (50+ sesiones) acumula ~50 entries con state completo. Sin limpieza, en producción se observa degradación progresiva.

**Riesgo de seguridad funcional:** Bridge tools (`omo_remember`, `omo_rule`, `omo_note`, `omo_history`, `omo_recall_mcp`) reportan éxito sin verificar entrega. El agente cree que persistió reglas/lecciones cuando el LLM pudo haber ignorado la instrucción.

---

## 2. Inventario de hallazgos consolidados (5 agentes)

### 2.1 Críticos (11)

| # | Origen | Hallazgo | File:Line |
|---|--------|----------|-----------|
| C1 | A, B, C | `auditSessions` Map nunca limpia entries — leak por sesión | `src/plugin.ts:273` |
| C2 | A, F | `takeAnyDecision()` puede consumir decisión de OTRA sesión | `src/decision-store.ts:48-54` |
| C3 | A | `systemInjection` capturada en `let`, race con `loadProtocol` async | `src/plugin.ts:233-241` |
| C4 | B | AFT checkpoint/undo: args no se splitean en Linux, comando silenciosamente falla | `src/graph-retrieval.ts:492,502,533-536` |
| C5 | B, F | 5 bridge tools retornan "dispatched" sin verificar entrega | `src/custom-tools.ts:477-508, 551-580, 618-650, 689-718, 757-789` |
| C6 | F | Self-referencing dependency en `package.json` rompe `npm install` | `package.json:41` |
| C7 | F | `src/custom-tools.ts` (987 líneas) ZERO test coverage — superficie pública entera | `src/custom-tools.ts` |
| C8 | F | `src/codegraph-tools.ts` (342 líneas) ZERO test coverage | `src/codegraph-tools.ts` |
| C9 | D | `delegate`/`switch-model` de token-predictor son dead code | `src/token-predictor.ts:80-115` |
| C10 | D | `escalate` action no tiene dispatcher — feature ficticia | `src/decision-handler.ts:60-75` |
| C11 | A, F | `require("node:fs")` dentro de ESM module (`shouldInjectPlanReminder`) | `src/plugin.ts:958-959` |

### 2.2 Altos (17)

| # | Hallazgo | File:Line |
|---|----------|-----------|
| H1 | AFT subcommand usa `process.cwd()` ignorando `options.projectDir` | `src/graph-retrieval.ts:538` |
| H2 | `as never` cast en `setClient`/`setSessionClient` salta type-safety | `src/plugin.ts:186-187` |
| H3 | `_client` module-level en session-bridge → race entre sesiones | `src/session-bridge.ts:49-54,78-132` |
| H4 | `logToFile` no-op stub en graph-sync.ts → sync failures nunca loggeados | `src/graph-sync.ts:715-717` |
| H5 | SQLite: schema_version sin migration logic (bump futuro queda silencioso) | `src/sqlite-backend.ts:73,172-181` |
| H6 | `closed-loop-learning`: no deduplicación → lecciones duplicadas por turno | `src/closed-loop-learning.ts:114,154` |
| H7 | `maxLessonsPerSession` definido en config pero nunca enforced | `src/closed-loop-learning.ts:207` |
| H8 | `src/decision-store.ts` (61 líneas) sin test file | `src/decision-store.ts` |
| H9 | 4-5 catch vacíos (`catch {}` / `catch(() => {})`) que ocultan errores | `src/plugin.ts:373-374,587-589`, `src/health.ts:228-230`, `src/session-bridge.ts:98-100` |
| H10 | Hardcoded `"0.13.0"` en metrics.ts (línea 54, 96, 125) | `src/metrics.ts` |
| H11 | `omo_health` reporta `v0.13.1` mientras la versión real es 0.15.0 | `src/custom-tools.ts:233` |
| H12 | CI: macOS/Windows omiten `bun run typecheck` | `.github/workflows/ci.yml` |
| H13 | `omo_path`/`omo_explain` hardcodean `graphify` binary (omo_search sí respeta override) | `src/graph-retrieval.ts:437,518` |
| H14 | Cap check duplicado entre `messages.transform` y `tool.execute.after` | `src/plugin.ts:570-582,742-761` |
| H15 | `package-lock.json` + `bun.lock` ambos commiteados — divergencia posible | repo root |
| H16 | `interventionCount++` / `filesChanged++` sin lock → race con parallel tool calls | `src/plugin.ts:380-647` |
| H17 | `takeDecision()` destructivo antes de usar → race con concurrent hooks | `src/plugin.ts:558,580,670,808` |

### 2.3 Medios (14)

| # | Hallazgo | File:Line |
|---|----------|-----------|
| M1 | Scoring formula no documentada — cambio de pesos rompe threshold mapping | `src/scoring-engine.ts` |
| M2 | Default threshold scale mismatch — sin calibration test | `src/scoring-engine.ts:50-80` |
| M3 | `recents.length === 0` → `NaN` en score → silenciosamente cae a "continue" | `src/scoring-engine.ts:120-140` |
| M4 | `INTERVENTION` mode default drift: orchestrator.ts "stop" vs config.ts "warn" | `src/orchestrator.ts:55` vs `src/config.ts:164` |
| M5 | `IMPLEMENTATION_PLAN.md` es stale (documenta v0.3.0, código está en v0.15.0) | `IMPLEMENTATION_PLAN.md` |
| M6 | `closed-loop-learning.extractConcepts` no incluye file paths → FTS misses | `src/closed-loop-learning.ts:68-75` |
| M7 | `logToFile` sin redaction layer → secrets en tool output van a disco | `src/file-logger.ts` |
| M8 | `OmoFindDeps`/`OmoImpactDeps` con `codeGraph` parameter dead | `src/custom-tools.ts:278,345` |
| M9 | AFT commands no cacheados (vs. `omo_search` que sí cachea) | `src/graph-retrieval.ts` |
| M10 | Backup graph-sync (tool.execute.after) solo ejecuta codegraph, no graphify | `src/plugin.ts:610+` |
| M11 | `pluginReminderSent` Set no se limpia entre sesiones | `src/plugin.ts:273` |
| M12 | `pendingBotFeedback` / `pendingViolations` no tienen TTL | `src/plugin.ts:267,270` |
| M13 | `proto` en plugin input se castea con `as never` | `src/plugin.ts:186-187` |
| M14 | `extractConcepts` no preserva la "causa" de la lesson | `src/closed-loop-learning.ts:68-75` |

### 2.4 Bajos (9)

| # | Hallazgo | File:Line |
|---|----------|-----------|
| L1 | `idCounter` nunca se resetea (cosmetic) | `src/plugin.ts:87` |
| L2 | `ACTION_SEVERITY` keyed by `string` en vez de union literal | `src/plugin.ts:73-78` |
| L3 | `system.transform` injection no setea `synthetic: true` | `src/plugin.ts:825-828` |
| L4 | `getCachedContext` itera O(n) cuando O(1) basta | `src/graph-retrieval.ts:165-190` |
| L5 | Inline `require` en `getDefaultUpgradeCachePath` | `src/graph-sync.ts:770-772` |
| L6 | `omo_recall` trunca a 500 chars silenciosamente | `src/custom-tools.ts:147` |
| L7 | `shouldInjectPlanReminder` solo busca `AGENTS.md` (ignora `PLAN.md`) | `src/plugin.ts:966` |
| L8 | `protocol-enforcer` puede false-positive en documentation | `src/protocol-enforcer.ts:215-245` |
| L9 | `isGhPrCommand` regex no cubre todos los `gh pr` variants | `src/plugin.ts:939` |

### 2.5 Refactors (4)

| # | Hallazgo | File:Line |
|---|----------|-----------|
| R1 | 7 interfaces `OmoXxxDeps` vacías — dead code, sugieren DI que no existe | `src/custom-tools.ts` |
| R2 | `maxInterventionsPerSession` enforcement duplicado en dos hooks | `src/plugin.ts` |
| R3 | `planReminderSent` Set sin cleanup | `src/plugin.ts:273` |
| R4 | `pendingBotFeedback` y `pendingViolations` Map sin TTL | `src/plugin.ts:267,270` |

---

## 3. Fases de implementación (orden de ejecución)

### Fase 0 — Hotfix bloqueante de release (CRÍTICO)
**Objetivo:** Resolver problemas que impiden publicar v0.15.0 actual y v0.16.0 futuro. Cero scope creep.

**Commits independientes (per stage):**

#### F0.1 — Quitar self-dep de `package.json`
- **Archivo:** `package.json`
- **Cambio:** Eliminar `"@herjarsa/omo-meta-governor": "^0.14.4"` de `dependencies`.
- **Validación:** `npm install` resuelve sin warning de circular.
- **Commit:** `fix(pkg): remove self-referencing dependency`

#### F0.2 — `npm publish --dry-run` desde el package
- **Objetivo:** Confirmar que el tarball generado no incluye artefactos prohibidos.
- **Comando:** `npm pack --dry-run` y revisar el output (debe ser ~0.4 MB, sin node_modules, sin .git).
- **Validación:** Output contiene `dist/index.js`, `dist/index.d.ts`, `dist/*.d.ts`, `README.md`. NO contiene `node_modules/`, `.git/`, `tests/`, `*.db`, etc.
- **Commit:** `chore(ci): add npm pack dry-run check`

**Verificación de Fase 0:** `npm install` limpio + `npm pack --dry-run` solo emite los artefactos esperados.

---

### Fase 1 — Memory leaks y state hygiene (CRÍTICOS C1, C11, H16, R3, R4)
**Objetivo:** Cerrar los memory leaks identificados y eliminar los dead state structures.

**Archivos:** `src/plugin.ts`, `src/decision-store.ts`

**Tareas:**

#### F1.1 — Reemplazar `auditSessions` Map con TTL-based LRU
- **Cambio:** Crear `src/audit-state-cache.ts` con una clase `AuditStateCache` que:
  - Limita entries a N=100 (configurable)
  - Eviction LRU cuando se alcanza el límite
  - TTL de 1h por entry (configurable, default 1h)
  - Tests: 4-5 casos (insert, eviction, TTL expiry, overflow)
- **Edita:** `src/plugin.ts:263-262` (state type), `src/plugin.ts:282-263` (init)
- **Validación:** Test bench: 200 sesiones simuladas, verificar que solo las 100 más recientes quedan.
- **Commit:** `fix(state): TTL-based audit state cache to prevent memory leak`

#### F1.2 — Quitar `require()` de `shouldInjectPlanReminder`
- **Cambio:** Reemplazar `require("node:fs")` y `require("node:path")` con imports top-level en `src/plugin.ts:957-960`.
- **Validación:** tsc clean, test en strict ESM pasa.
- **Commit:** `fix(esm): replace inline require with top-level imports`

#### F1.3 — Limpiar `pendingBotFeedback` y `pendingViolations` con TTL
- **Cambio:** Cambiar los dos `Map<string, string[]>` a `Map<string, { items: string[]; expiresAt: number }>`. Verificación lazy en cada read.
- **Edita:** `src/plugin.ts:267,270,710,653` (los reads y writes).
- **Validación:** Test que inyecta entries con TTL pasado y verifica que no se inyectan.
- **Commit:** `fix(state): TTL on pending violations and bot feedback queues`

#### F1.4 — Lock per-session para mutations
- **Cambio:** Encapsular mutations de `sessionState` (interventionCount++, filesChanged++, takeDecision) detrás de un `Mutex` por session. Considerar: si Node/Bun single-threaded, no es necesario, pero los `await` entre check-and-set pueden ser interrumpidos.
- **Decisión:** Si Bun single-threaded event loop es el target, documentar la garantía y NO añadir mutex. Si Node multi-threaded es target, añadir mutex simple.
- **Validación:** Documentar el modelo de concurrencia y la garantía de atomicidad en el código.
- **Commit:** `docs(state): document single-threaded event loop guarantees`

**Verificación de Fase 1:** `bun test src/` → 100% pass. Stress test de 200 sesiones simuladas en test bench.

---

### Fase 2 — Eliminar dead code y rutas de fallo silenciosas (CRÍTICOS C2, C3, H4, H10, H11)
**Objetivo:** Limpiar la superficie de la API, eliminar las funciones deprecadas, reemplazar stubs.

**Archivos:** `src/decision-store.ts`, `src/plugin.ts`, `src/metrics.ts`, `src/custom-tools.ts`, `src/graph-sync.ts`

**Tareas:**

#### F2.1 — Deprecar y eliminar `takeAnyDecision()`
- **Cambio:** Marcar `takeAnyDecision` como `@deprecated` con JSDoc. Eliminar todos los call sites en `src/plugin.ts:659-665`. Después de 1 release minor, eliminar.
- **Edita:** `src/decision-store.ts:46-55`, `src/plugin.ts:659-665`.
- **Validación:** tsc emite warning si se usa. Mensajes-transform hook deriva sessionID de la última message — no necesita fallback.
- **Commit:** `refactor(decision-store): deprecate takeAnyDecision, derive sessionID from last message`

#### F2.2 — `systemInjection` await eagerly
- **Cambio:** Convertir `loadProtocol(protocolPath).then(...)` en `await loadProtocol(...)` dentro de un async IIFE. Gate `system.transform` con un flag `protocolReady: boolean`.
- **Edita:** `src/plugin.ts:233-241`, `src/plugin.ts:782`.
- **Validación:** Test que verifica que systemInjection está lista antes de que el primer hook corra.
- **Commit:** `fix(race): await protocol load before exposing system.transform hook`

#### F2.3 — Reemplazar `logToFile` no-op en graph-sync
- **Cambio:** Importar `logToFile` real desde `src/file-logger.ts` en `src/graph-sync.ts:715-717` y reemplazar el stub.
- **Validación:** Test que dispara un error en codegraph sync y verifica que aparece en el log.
- **Commit:** `fix(logging): wire real logToFile in graph-sync module`

#### F2.4 — Derivar version en runtime en metrics + custom-tools
- **Cambio:** Reemplazar hardcoded `"0.13.0"` (3 lugares en metrics.ts) y `"v0.13.1"` en custom-tools.ts:233 con `import { version } from "../package.json"`.
- **Edita:** `src/metrics.ts:54,96,125`, `src/custom-tools.ts:233`.
- **Validación:** tsc resuelve import. Test verifica que el snapshot tiene la versión del package.json.
- **Commit:** `fix(metrics): read plugin version from package.json`

**Verificación de Fase 2:** `bun run typecheck` clean. `bun test` 100% pass. Ningún `require()` o hardcoded version.

---

### Fase 3 — Bugs de tools (CRÍTICOS C4, C5, H1, H2, H3, H13)
**Objetivo:** Arreglar los bugs funcionales en `graph-retrieval.ts` y session-bridge.

**Archivos:** `src/graph-retrieval.ts`, `src/custom-tools.ts`, `src/session-bridge.ts`

**Tareas:**

#### F3.1 — AFT checkpoint/undo: aceptar string[] args
- **Cambio:** Cambiar firma de `invokeAFTSubcommand(subcommand, argument: string | string[], options)`. Split en args correctamente. Aplicar a checkpoint y undo.
- **Edita:** `src/graph-retrieval.ts:492,502,531-536,538`.
- **Validación:** Test que simula `aft safety checkpoint --name "my name"` con espacios y verifica que llega como 4 args separados.
- **Commit:** `fix(aft): split checkpoint/undo args correctly on Linux`

#### F3.2 — AFT subcommand usar `options.projectDir`
- **Cambio:** Reemplazar `process.cwd()` en `src/graph-retrieval.ts:538` con `options.projectDir ?? process.cwd()`.
- **Validación:** Test verifica que el cwd es el project dir.
- **Commit:** `fix(aft): respect projectDir in subcommand spawn`

#### F3.3 — Respetar `graphifyBin` override en `omo_path`/`omo_explain`
- **Cambio:** `src/graph-retrieval.ts:437,518` → `const cmd = options.graphifyBin ?? "graphify"`.
- **Validación:** Test con `graphifyBin: "/custom/path/graphify"`.
- **Commit:** `fix(tools): respect graphifyBin override in path/explain tools`

#### F3.4 — `as never` → guard runtime para setClient
- **Cambio:** `src/plugin.ts:186-187`. Reemplazar `as never` con `typeof client === "object" && client !== null && "tool" in client ? client : null` (runtime guard).
- **Validación:** Test que pasa `client = null` y `client = {}` (sin `tool`) y verifica que el plugin no crashea.
- **Commit:** `fix(types): add runtime guard for setClient instead of as never cast`

#### F3.5 — `session-bridge` con AsyncLocalStorage
- **Cambio:** Reemplazar `let _client` con `AsyncLocalStorage<unknown>`. El plugin factory envuelve cada hook invocation en `sessionStore.run(client, () => hook())`.
- **Edita:** `src/session-bridge.ts:49-54`, `src/plugin.ts:283-285` (setSessionClient), todos los `setSessionClient()` call sites.
- **Validación:** Test concurrente: 3 sesiones paralelas envían `promptAgent`, verificar que cada mensaje va al cliente correcto.
- **Commit:** `fix(sessions): AsyncLocalStorage for per-session client isolation`

#### F3.6 — Bridge tools: poll for delivery confirmation
- **Cambio:** `src/session-bridge.ts:promptAgent()`. Después de `session.prompt(promptText)`, hacer polling de tool calls por timeout (5s). Si el tool esperado se llamó, retornar `ok: true, delivered: true`. Si no, retornar `ok: true, delivered: false` con sugerencia de retry.
- **Edita:** `src/session-bridge.ts:78-132`, custom-tools.ts:477-508 (y otros 4 bridges).
- **Validación:** Test que mockea session.prompt + tool call, verifica el campo `delivered`.
- **Commit:** `feat(bridges): poll for MCP tool delivery in bridge tools`

**Verificación de Fase 3:** Tests específicos de cada bug, todos pasan. Suite completa verde.

---

### Fase 4 — Test coverage del surface público (CRÍTICO C7, C8, H8)
**Objetivo:** Llevar la cobertura de tests del surface público (15 tools + decision-store) a >80%.

**Archivos nuevos:** `src/custom-tools.test.ts`, `src/codegraph-tools.test.ts`, `src/decision-store.test.ts`

**Tareas:**

#### F4.1 — `decision-store.test.ts`
- **Cubre:** 5 funciones, comportamiento normal + edge cases (cross-session, takeAnyDecision deprecated, no leaks).
- **Commit:** `test(decision-store): add coverage for store/take/clear lifecycle`

#### F4.2 — `custom-tools.test.ts` (paralelo: 5 commits temáticos)
- **F4.2a:** `omo_search`, `omo_recall`, `omo_health` (read-only tools)
- **F4.2b:** `omo_find`, `omo_impact` (codegraph-based)
- **F4.2c:** `omo_path`, `omo_explain`, `omo_outline` (graphify/AFT)
- **F4.2d:** `omo_checkpoint`, `omo_undo` (AFT state ops)
- **F4.2e:** `omo_remember`, `omo_recall_mcp`, `omo_rule`, `omo_history`, `omo_note` (5 bridges)
- **Cada test:** Mock del backend subyacente, valida input args, error handling, result formatting, version string.
- **Commit:** `test(tools): add coverage for 15 custom tools (5 thematic commits)`

#### F4.3 — `codegraph-tools.test.ts`
- **Cubre:** `CodeGraphTools` class, 4 métodos, error paths.
- **Commit:** `test(codegraph): add coverage for CodeGraphTools class`

**Verificación de Fase 4:** `bun test src/custom-tools.test.ts src/codegraph-tools.test.ts src/decision-store.test.ts` — 100% pass. Coverage de los 3 archivos >80% (medible con `bun test --coverage` si está disponible, o via `istanbul`).

---

### Fase 5 — Logic dead code y drift (ALTOS C9, C10, M4, H7)
**Objetivo:** Decidir y ejecutar sobre las features ficticias y el drift de configuración.

**Archivos:** `src/decision-handler.ts`, `src/orchestrator.ts`, `src/config.ts`, `src/closed-loop-learning.ts`, `src/token-predictor.ts`

**Tareas:**

#### F5.1 — Resolver `escalate` action
- **Decisión arquitectónica:** 3 opciones:
  - (A) Wire real escalation: `task(subagent_type="oracle", ...)` cuando score >= 0.6
  - (B) Documentar en README que escalate es aspiracional
  - (C) Quitar el action y fusionar con stop
- **Recomendación:** (A) — wire a Oracle sub-agent. Es el camino más útil y aprovecha la infra que ya existe.
- **Implementación:** `src/decision-handler.ts:60-75` modifica la signature a `shouldEscalateTo(score, availableAgents)`. `src/orchestrator.ts:179-181` ejecuta `task({ subagent_type: target, description: ... })` cuando `result.shouldEscalateTo !== null`.
- **Validación:** Test con score=0.7, mock task(), verifica que se invoca con subagent_type correcto.
- **Commit:** `feat(decision): wire escalate action to Oracle sub-agent`

#### F5.2 — Token predictor dead code
- **Decisión:** Eliminar `delegate` y `switch-model` de TokenPredictorOutput, o documentar como informational. Recomendación: informational-only, con un nuevo field `recommendations: ReadonlyArray<{ kind, message }>`.
- **Edita:** `src/token-predictor.ts:80-115`, `src/types.ts:448-461`.
- **Validación:** Test que verifica que recommendations se incluyen en intervention message.
- **Commit:** `refactor(token-predictor): convert dead code to informational recommendations`

#### F5.3 — Resolver drift de defaults (`minActionForMessage`, `mode`)
- **Decisión:** Hacer `defaultOrchestratorConfig()` el source of truth. `config.ts:loadOrchestratorConfig()` debe llamarlo y proyectar.
- **Refactor:** `src/config.ts:88-179` reescribe para que use `defaultOrchestratorConfig()` como base.
- **Validación:** Test que verifica que `loadOrchestratorConfig({})` y `defaultOrchestratorConfig()` retornan los mismos defaults.
- **Commit:** `fix(config): consolidate default config source of truth`

#### F5.4 — `maxLessonsPerSession` enforcement
- **Cambio:** `src/closed-loop-learning.ts:114,154` agregar check: si el conteo de entries en SQLite para esa session >= `config.maxLessonsPerSession`, skip el save.
- **Validación:** Test que crea 25 entries, verifica que solo 20 (default) se guardan.
- **Commit:** `fix(closed-loop): enforce maxLessonsPerSession cap`

**Verificación de Fase 5:** Decision handler de verdad escala a Oracle. Token predictor no expone dead fields. Default config unificado. Lessons no crecen sin bound.

---

### Fase 6 — CI/CD, build, observability (ALTOS H12, M5, M7, L7, L8, R1, R4)
**Objetivo:** Profesionalizar el pipeline de release y observability.

**Archivos:** `.github/workflows/ci.yml`, `src/file-logger.ts`, `src/custom-tools.ts`, `IMPLEMENTATION_PLAN.md`

**Tareas:**

#### F6.1 — CI typecheck en todos los OS
- **Cambio:** `.github/workflows/ci.yml` — añadir `bun run typecheck` a los jobs de macos y windows.
- **Commit:** `ci: run typecheck on macos and windows`

#### F6.2 — Quitar `package-lock.json` (mantener solo `bun.lock`)
- **Cambio:** `.gitignore` añadir `package-lock.json`. Eliminar del repo.
- **Validación:** CI sigue funcionando con `bun install`.
- **Commit:** `chore(repo): remove package-lock.json, keep bun.lock as canonical`

#### F6.3 — Redaction layer en `logToFile`
- **Cambio:** `src/file-logger.ts` añadir parámetro opcional `redactPatterns: RegExp[]`. Sanitizar campos `api_key`, `token`, `password`, `secret` antes de escribir.
- **Validación:** Test que inyecta data con secrets, verifica que se redactan.
- **Commit:** `feat(logging): redact sensitive fields in log entries`

#### F6.4 — Reemplazar `IMPLEMENTATION_PLAN.md` stale
- **Decisión:** Eliminar el archivo (cubre solo v0.3.0) o reescribirlo con la historia completa hasta v0.16.0.
- **Recomendación:** Eliminar — el README es el source of truth actual. Planificar ARCHITECTURE.md en su lugar para documentar el diseño.
- **Commit:** `docs: remove stale IMPLEMENTATION_PLAN.md, add ARCHITECTURE.md`

#### F6.5 — Eliminar interfaces `OmoXxxDeps` vacías
- **Cambio:** `src/custom-tools.ts:434,527,597,667,735,933,965` eliminar las 7 interfaces vacías. Reemplazar con `Record<string, never>` donde se usan o quitar el parámetro.
- **Validación:** tsc clean.
- **Commit:** `refactor(tools): remove empty OmoXxxDeps interfaces`

**Verificación de Fase 6:** CI verde en 3 OS. No hay secrets en logs. ARCHITECTURE.md documenta la arquitectura actual.

---

### Fase 7 — Refactors finales y merge de dead code (MEDIOS/BAJOS restantes)
**Objetivo:** Recoger los hallazgos de severidad media y baja restantes.

**Archivos:** múltiples

**Tareas:**

#### F7.1 — Eliminar dead refs
- `void child` en graph-sync.ts:693 → eliminar.
- inline require en graph-sync.ts:770-772 → top-level import.
- `idCounter` → `crypto.randomUUID()`.

#### F7.2 — Score formula documentada + NaN guard
- `src/scoring-engine.ts:1-15` añadir doc con la fórmula exacta.
- `src/scoring-engine.ts:120-140` añadir guard `if (recents.length === 0) return defaultScore`.

#### F7.3 — Type-safety polish
- `ACTION_SEVERITY` keyed by union literal.
- `system.transform` injection set `synthetic: true`.

#### F7.4 — Limpiar Stale state
- `projectHasCodegraph` / `projectHasGraphify` booleans → reemplazar con lookup-time calls a `graphRetrieval.hasCodegraphDir()`.

#### F7.5 — `extractConcepts` en closed-loop-learning
- Incluir file paths en concepts para que FTS pueda encontrar lessons por tool name.

#### F7.6 — `OmoFindDeps`/`OmoImpactDeps` `codeGraph` parameter
- Marcar como dead, eliminar.

#### F7.7 — Plan reminder también busca `PLAN.md`
- `src/plugin.ts:966` también buscar `## Plan` en `PLAN.md` (no solo AGENTS.md).

#### F7.8 — Backup graph-sync ejecuta graphify también
- `src/plugin.ts:610+` cuando detecta git commit, llamar `triggerReindex` (no `triggerCodegraphSync`).

**Validación de Fase 7:** `bun test` 100% pass. `bun run typecheck` clean. Suite integration verde.

---

## 4. Roadmap y orden de releases

| Release | Fases | Scope |
|---------|-------|-------|
| **v0.15.1** (patch inmediato) | F0 | Solo hotfix de self-dep + npm pack check |
| **v0.16.0** (minor) | F1 + F2 + F3 | Memory leaks, dead code, bugs tools |
| **v0.17.0** (minor) | F4 + F5 | Test coverage + logic dead code |
| **v0.18.0** (minor) | F6 + F7 | CI/CD, observability, refactors |

**Razón del split:** F0-F3 son **bloqueantes funcionales** (memory leak, npm install roto, bridge tools mintiendo). F4-F5 son **calidad y cobertura**. F6-F7 son **profesionalización**. Mezclarlos en un solo release incrementa el blast radius y dificulta el rollback.

---

## 5. Riesgos y mitigaciones

| Riesgo | Probabilidad | Impacto | Mitigación |
|--------|--------------|---------|------------|
| F1.1 TTL cache cambia comportamiento | Media | Media | Feature flag `auditStateTTLCap` (default 100, off = sin cap) |
| F2.1 Quitar `takeAnyDecision` rompe consumer | Baja | Alta | Marcar deprecated 1 release, eliminar después |
| F3.5 AsyncLocalStorage cambia timing | Baja | Media | Tests de stress concurrente, fallback a AsyncResource si Bun no soporta |
| F5.1 Wire escalate a Oracle invoca sub-agents no deseados | Media | Alta | Default `escalate: false` en config; opt-in explícito |
| F5.3 Consolidar defaults rompe configs downstream | Baja | Alta | Run integration suite, validar behavior para `{}` |

---

## 6. Verificación de fin de fase

Cada fase termina con:
1. **All commits pushed** — no WIP in main.
2. **`bun test src/` 100% pass.**
3. **`bun run typecheck` clean.**
4. **`bun run build` produces dist/ sin warnings.**
5. **`npm pack --dry-run` solo emite artefactos esperados.**
6. **Oracle verdict** sobre cambios (consultar `task(subagent_type="oracle", ...)` cuando haya cambios de arquitectura).
7. **CHANGELOG entry** (cuando exista CHANGELOG.md, crear en F6.4).

---

## 7. Observación: lo que NO está en este plan

- **Nuevas features de producto**: el plan es estrictamente remediación. Features nuevas (e.g., soporte para sub-agents paralelos, dashboards web) van en su propio plan.
- **Reescritura a TypeScript strict más estricto**: el tsconfig ya tiene `strict: true`. No se necesita reescritura.
- **Internacionalización**: el plugin no muestra strings al usuario directamente, todo va al LLM. No es relevante.
- **Cobertura 100%**: target es 80% en surface público, no 100%. Tests exhaustivos tienen ROI decreciente.

---

## 8. Estimación de esfuerzo

| Fase | Esfuerzo | LOC estimado | Razón |
|------|----------|--------------|-------|
| F0 | 0.5h | ~5 LOC | Solo eliminar entry + añadir CI check |
| F1 | 3-4h | ~150 LOC | LRU cache + TTL + mutex doc |
| F2 | 2-3h | ~50 LOC | 4 fixes pequeños |
| F3 | 4-6h | ~200 LOC | 6 fixes, AFT args es tricky |
| F4 | 6-10h | ~600 LOC | Tests para 15 tools + decision store |
| F5 | 3-5h | ~150 LOC | Wire escalate + cleanup dead code |
| F6 | 2-3h | ~100 LOC | CI + redaction + docs |
| F7 | 2-3h | ~80 LOC | Refactors |
| **Total** | **22-34h** | **~1300 LOC** | Para v0.16.0 release completo |

---

## 9. Cierre

**Resumen:** El plugin está **funcional pero con riesgo operacional alto**. La superficie pública (15 tools) tiene ZERO test coverage, lo cual es un agujero de seguridad funcional. El memory leak en `auditSessions` se manifestará en cualquier sesión de trabajo larga. El self-referencing dep bloquea publicación.

**Recomendación ejecutiva:** Inmediatamente F0 + F1 + F2 + F3 en un sprint de 2-3 días. F4 + F5 en el siguiente sprint. F6 + F7 en el tercer sprint. Cada sprint termina con un release minor.

**Siguiente paso del usuario:** ¿Apruebas este plan para que lo ejecute, o quieres que ajuste prioridades/scope? Si sí, ejecuto F0 + F1 + F2 + F3 ahora.
