# Plan de Implementación ULTRA PRO — v0.14.0: omo-meta-governor como Comandante Completo

**Versión actual publicada:** `@herjarsa/omo-meta-governor@0.13.1` en npm (SQLite + 3 tools + compacting + métricas)
**Versión objetivo:** `0.14.0` — comandante que explota los 5 sistemas (AgentMemory, Magic Context, AFT, CodeGraph, Graphify)
**Principio rector:** Zero nuevas dependencias, zero breaking changes, todo aditivo sobre 0.13.1

---

## Visión general

El plugin actual (0.13.1) usa SQLite como almacén aislado y 3 tools que invocan codegraph/graphify. La versión 0.14.0 integra los 5 sistemas de OpenCode como **custom tools que el LLM invoca explícitamente** + un **backend dual** que sincroniza lecciones entre SQLite y AgentMemory automáticamente.

### Inventario de sistemas y su integración

| Sistema | Estado 0.13.1 | Estado 0.14.0 | Impacto |
|---------|---------------|---------------|---------|
| **AgentMemory** | ❌ Sin tocar | ✅ Custom tools + backend dual | CRÍTICO |
| **Magic Context** | ❌ Sin tocar | ✅ Custom tools (ctx_memory, ctx_search, ctx_note) | ALTO |
| **AFT** | ❌ Sin tocar | ✅ Custom tools (aft_outline, aft_zoom, aft_search, aft_safety) | ALTO |
| **CodeGraph** | Solo omo_search | ✅ + omo_find, omo_impact | MEDIO |
| **Graphify** | Solo omo_search | ✅ + omo_path, omo_explain | MEDIO |
| **SQLite** | Backend único | Backend dual (cache local + AgentMemory) | BASE |

### Tools resultantes (13 total)

```
omo_search        (existente)  → codegraph explore | graphify query | aft_search
omo_recall        (existente)  → agentmemory smart_search | SQLite FTS5 | ctx_search
omo_health        (existente)  → métricas + health JSON
omo_rule          (NUEVO)      → ctx_memory(write) — guardar reglas persistentes
omo_history       (NUEVO)      → ctx_search(git) — buscar en git commits
omo_note          (NUEVO)      → ctx_note(write) — notas de sesión
omo_memo          (NUEVO)      → agentmemory save / lesson_save (vía client)
omo_find          (NUEVO)      → codegraph_node | aft_zoom
omo_impact        (NUEVO)      → codegraph_impact | codegraph_callers
omo_path          (NUEVO)      → graphify path A→B
omo_explain       (NUEVO)      → graphify explain
omo_undo          (NUEVO)      → aft_safety(undo)
omo_checkpoint    (NUEVO)      → aft_safety(checkpoint)
```

### Capabilities que el LLM gana en 0.14.0

1. **Persistencia cross-session real**: las lecciones se guardan en AgentMemory → cualquier sesión futura las encuentra con `agentmemory_memory_recall` automáticamente.
2. **Búsqueda unificada**: un solo tool (`omo_recall`) busca en AgentMemory + SQLite + git history. Si uno falla, otro toma el relevo.
3. **Reglas persistentes**: el agente puede guardar una decisión arquitectónica vía `omo_rule` y queda para siempre.
4. **Búsqueda de símbolos por nombre**: `omo_find "UserService"` encuentra la definición exacta.
5. **Análisis de impacto antes de cambiar**: `omo_impact "function foo"` lista todos los call sites.
6. **Pathfinding conceptual**: `omo_path A B` encuentra la ruta más corta entre dos conceptos en el grafo.
7. **Undo automático**: el plugin crea checkpoints en cada commit, el agente puede deshacer.

---

## Fases de implementación (orden de ejecución)

### Fase 0 — Infraestructura: capturar PluginInput.client

**Objetivo:** El plugin actual NO guarda `client` (pasado en `PluginInput`). Sin él no podemos llamar a AgentMemory/Magic Context/AFT vía MCP.

**Archivos:** `src/plugin.ts`, `src/mcp-client.ts` (NUEVO)

**Implementación:**

1. Crear `src/mcp-client.ts` (~80 LOC) — wrapper sobre `PluginInput.client` que:
   - Captura el client en el primer `event()` o `config()` hook
   - Expone métodos tipados: `callTool(name, args)`, `listTools()`, `isAvailable(name)`
   - Cachea resultados de `listTools` para evitar re-llamadas
   - Maneja timeout (5s) y degrada silenciosamente si el client no responde
   - Exporta un singleton `getMCPClient()` que inicializa con `null` y se hidrata en runtime

2. Modificar `src/plugin.ts`:
   - Agregar `let capturedClient: ReturnType<typeof createOpencodeClient> | null = null` a nivel módulo
   - En `event()` hook: `capturedClient = (input as any).client ?? null`
   - En `config()` hook: misma captura como fallback
   - Pasar el client al wrapper de MCP

3. Tests en `src/mcp-client.test.ts`:
   - `captures client from event hook input`
   - `returns null when no client available`
   - `callTool degrades gracefully on timeout`
   - `isAvailable returns false for unknown tools`

**Commit:** `feat(infra): capture PluginInput.client for MCP tool access`

**Verificación:** `bun test src/mcp-client.test.ts` + `tsc --noEmit`

---

### Fase 1 — AgentMemory backend dual (el gap más grande)

**Objetivo:** Las lecciones que el plugin aprende deben aparecer en `agentmemory_memory_recall` de cualquier sesión futura. Hoy solo viven en SQLite, invisible para AgentMemory.

**Archivos:** `src/agentmemory-adapter.ts` (NUEVO), `src/plugin.ts`, `src/sqlite-backend.ts`, `src/custom-tools.ts`, `src/agentmemory-adapter.test.ts` (NUEVO)

**Implementación:**

1. Crear `src/agentmemory-adapter.ts` (~150 LOC) — implementa `AgentmemoryWriteBackend`:
   ```typescript
   export class AgentmemoryAdapter implements AgentmemoryWriteBackend {
     constructor(private mcp: MCPClient) {}
     async saveMemory(input): Promise<{id: string}> {
       const result = await this.mcp.callTool('agentmemory_memory_save', {...input})
       return {id: result.id}
     }
     async saveLesson(input): Promise<{id: string}> {
       const result = await this.mcp.callTool('agentmemory_memory_lesson_save', {...input})
       return {id: result.id}
     }
   }
   ```

2. Modificar `src/plugin.ts:338-374` (IIFE de backends) — el `writeBackend` ahora es dual:
   ```typescript
   const dualWriteBackend: AgentmemoryWriteBackend = {
     saveMemory: async (input) => {
       const sqliteResult = await sqlite.saveMemory(input)
       try {
         const amResult = await agentmemoryAdapter.saveMemory(input)
         return amResult.id ? amResult : sqliteResult
       } catch { return sqliteResult }
     },
     saveLesson: similar
   }
   ```

3. Modificar `src/sqlite-backend.ts` — agregar método `readRecentBySession(sessionID)` para sync en background (opcional v0.15).

4. Tests en `src/agentmemory-adapter.test.ts`:
   - `saveMemory calls agentmemory_memory_save via MCP`
   - `saveLesson calls agentmemory_memory_lesson_save via MCP`
   - `falls back silently when MCP times out`
   - `returns SQLite id when AgentMemory unavailable`

5. Nuevo custom tool en `src/custom-tools.ts`:
   - `buildOmoMemoTool` — `omo_memo` que llama `agentmemory_memory_save` directamente

**Commit:** `feat(agentmemory): dual backend writes lessons to AgentMemory MCP`

**Verificación:** e2e test que verifica que `saveLesson` se refleja en `agentmemory_memory_recall` (con MCP mock).

**Criterio de éxito:** Las lecciones de una sesión A aparecen en `agentmemory_memory_recall` de sesión B.

---

### Fase 2 — Magic Context integration (reglas persistentes)

**Objetivo:** El LLM puede guardar reglas arquitectónicas y hechos durables que persisten entre sesiones via `ctx_memory`.

**Archivos:** `src/magic-context-adapter.ts` (NUEVO), `src/custom-tools.ts`, `src/magic-context-adapter.test.ts` (NUEVO)

**Implementación:**

1. Crear `src/magic-context-adapter.ts` (~120 LOC):
   ```typescript
   export class MagicContextAdapter {
     constructor(private mcp: MCPClient) {}
     async list() { return this.mcp.callTool('ctx_memory', {action: 'list'}) }
     async save(category, content) { return this.mcp.callTool('ctx_memory', {action: 'write', category, content}) }
     async search(query) { return this.mcp.callTool('ctx_search', {query}) }
     async note(content, surfaceCondition?) { return this.mcp.callTool('ctx_note', {action: 'write', content, ...}) }
   }
   ```

2. Tres custom tools nuevos en `src/custom-tools.ts`:
   - `buildOmoRuleTool` — `omo_rule` para guardar reglas durables (categoría PROJECT_RULES/ARCHITECTURE/CONSTRAINTS)
   - `buildOmoHistoryTool` — `omo_history` para buscar en git commits via `ctx_search`
   - `buildOmoNoteTool` — `omo_note` para notas efímeras de sesión

3. Wire en `src/plugin.ts` en el `tool` object.

4. Integración con `system.transform` — inyectar automáticamente los `ctx_memory list` del proyecto en cada turno (cached 5min, refresh on `omo_rule`).

5. Tests en `src/magic-context-adapter.test.ts`:
   - `list returns all memories grouped by category`
   - `save calls ctx_memory with correct action`
   - `search returns git commit matches`
   - `note creates ephemeral session-scoped note`

**Commit:** `feat(magic-context): omo_rule, omo_history, omo_note tools + auto-inject in system`

---

### Fase 3 — AFT integration (structural code navigation)

**Objetivo:** El plugin expone AFT como fallback para omo_search cuando el grafo falla, y como herramientas dedicadas para outline/zoom/safety.

**Archivos:** `src/aft-tools.ts` (NUEVO), `src/custom-tools.ts`, `src/aft-tools.test.ts` (NUEVO)

**Implementación:**

1. Crear `src/aft-tools.ts` (~180 LOC):
   - Verificar disponibilidad de AFT via `which aft` o `find . -name "aft"`
   - `runAftOutline(path)`, `runAftZoom(symbol)`, `runAftSearch(pattern)`, `runAftSafety(op, name)`
   - Si AFT no está disponible, todos retornan `null`

2. Tres custom tools nuevos:
   - `buildOmoOutlineTool` — `omo_outline`
   - `buildOmoFindTool` — `omo_find` (AFT zoom como fallback de codegraph node)
   - `buildOmoSafetyTool` — `omo_undo` / `omo_checkpoint` con args para op

3. Wire en `tool` object del plugin.

4. Tests con AFT mock.

**Commit:** `feat(aft): omo_outline, omo_find, omo_undo tools with AFT integration`

---

### Fase 4 — CodeGraph tools extendidos (node, impact, callers)

**Objetivo:** Exponer más herramientas de CodeGraph (no solo explore).

**Archivos:** `src/codegraph-tools.ts` (NUEVO), `src/custom-tools.ts`, `src/graph-retrieval.ts` (extender), `src/codegraph-tools.test.ts` (NUEVO)

**Implementación:**

1. Extender `src/graph-retrieval.ts`:
   - `invokeNode(symbol, projectDir)`, `invokeCallers(symbol)`, `invokeImpact(symbol)`, `invokeFiles()`

2. Crear `src/codegraph-tools.ts` (~100 LOC) — wrapper de alto nivel.

3. Dos custom tools nuevos:
   - `buildOmoFindTool` (CodeGraph path) — descripción "Find exact symbol definition. Use when you know the function/class name but not the file."
   - `buildOmoImpactTool` — "ALWAYS run this before modifying a function or class. Lists all files that would be affected."

4. Consolidar con `omo_find` de AFT (priorizar CodeGraph si está disponible, fallback AFT).

5. Wire en `tool` object.

**Commit:** `feat(codegraph): omo_find and omo_impact tools with extended sub-commands`

---

### Fase 5 — Graphify tools extendidos (path, explain)

**Objetivo:** Exponer `graphify path` y `graphify explain`.

**Archivos:** `src/graphify-tools.ts` (NUEVO), `src/custom-tools.ts`, `src/graph-retrieval.ts` (extender)

**Implementación:**

1. Extender `src/graph-retrieval.ts`:
   - `invokePath(from, to, projectDir)`
   - `invokeExplain(concept, projectDir)`

2. Crear `src/graphify-tools.ts` (~80 LOC).

3. Dos custom tools:
   - `buildOmoPathTool` — `omo_path` con args `{from, to}`
   - `buildOmoExplainTool` — `omo_explain` con args `{concept}`

4. Wire en `tool` object.

**Commit:** `feat(graphify): omo_path and omo_explain tools`

---

### Fase 6 — Routing inteligente y omo_health expandido

**Objetivo:** Con 13 tools, las descriptions deben sesgar correctamente al LLM.

**Archivos:** `src/custom-tools.ts`, `src/plugin.ts`, `src/tool-router.ts` (NUEVO)

**Implementación:**

1. Crear `src/tool-router.ts` (~80 LOC) — meta-router (en realidad, son las descriptions mismas).

2. Mejorar las descriptions de TODOS los tools con ejemplos:
   ```
   omo_search: "Use this FIRST when exploring an unfamiliar codebase..."
   omo_find: "Use when you know the EXACT symbol name..."
   omo_impact: "ALWAYS run this before modifying a function or class..."
   omo_recall: "Search PAST observations and lessons from earlier sessions..."
   ```

3. Ampliar `omo_health` para que reporte:
   - Qué sistemas están disponibles (codegraph, graphify, AFT, agentmemory, magic-context)
   - Cuántas lecciones en cada backend
   - Latencia p50 por sistema

4. Tests:
   - `tool descriptions contain usage examples`
   - `omo_health reports all 5 system availability`

**Commit:** `feat(ux): enrich tool descriptions + expand omo_health with system availability`

---

### Fase 7 — Test coverage completo y e2e

**Objetivo:** Cubrir con tests la nueva superficie.

**Archivos:** `src/e2e.test.ts` (extender), `src/tool-router.test.ts` (NUEVO)

**Implementación:**

1. Extender `src/e2e.test.ts`:
   - "dual backend writes to both SQLite and AgentMemory"
   - "omo_rule persists via ctx_memory"
   - "omo_recall searches AgentMemory when MCP available"
   - "omo_health reports all 5 systems"
   - "agentmemory dual write: when AM unavailable, SQLite still has the lesson"
   - "13 tools are all registered in plugin"

2. Crear `src/tool-router.test.ts`:
   - "tool descriptions are non-empty and contain examples"
   - "13 tools present in plugin tool map"
   - "every tool has Zod-validated args"

3. Meta-test que verifica que `plugin.ts` exporta exactamente 13 tools.

**Commit:** `test: e2e coverage for v0.14.0 dual backend and 13 tools`

---

### Fase 8 — Build, version bump, publish

**Objetivo:** Publicar `@herjarsa/omo-meta-governor@0.14.0` en npm.

**Pasos:**
1. Bump version en `package.json`: `0.13.1` → `0.14.0`
2. `bun build.ts`
3. Verify: `grep -c "AgentmemoryAdapter\|MagicContextAdapter\|AFT" dist/index.js`
4. `npm publish`
5. Verify: `npm view @herjarsa/omo-meta-governor versions`

**Commit:** `release: v0.14.0 with full AgentMemory + Magic Context + AFT + CodeGraph + Graphify integration`

---

## Gráfico de ejecución (paralelizable)

```
Wave 1 (start immediately — no dependencies):
├── Fase 0: Infrastructure (PluginInput.client capture)
└── Fase 4: CodeGraph tools extendidos (read-only)

Wave 2 (after Wave 1):
├── Fase 1: AgentMemory backend dual (depends on Fase 0)
├── Fase 2: Magic Context integration (depends on Fase 0)
└── Fase 5: Graphify tools extendidos (read-only)

Wave 3 (after Wave 2):
├── Fase 3: AFT integration (depends on Fase 0 for MCP client)
└── Fase 6: Routing inteligente + omo_health expandido

Wave 4 (final):
└── Fase 7: Test coverage + e2e
└── Fase 8: Build + publish
```

**Critical path:** Fase 0 → Fase 1 → Fase 2 → Fase 3
**Parallel work:** Fases 4 y 5 pueden ir en paralelo con Fases 1-3

---

## Estimación de esfuerzo

| Fase | LOC nuevos | LOC modificados | Tests | Tiempo |
|------|------------|-----------------|-------|--------|
| 0    | ~80       | ~30             | ~30   | 1h    |
| 1    | ~200      | ~50             | ~60   | 2h    |
| 2    | ~150      | ~40             | ~50   | 1.5h  |
| 3    | ~180      | ~30             | ~40   | 1.5h  |
| 4    | ~100      | ~20             | ~40   | 1h    |
| 5    | ~80       | ~20             | ~30   | 1h    |
| 6    | ~80       | ~50             | ~40   | 1h    |
| 7    | ~200      | ~0              | ~150  | 1.5h  |
| 8    | ~0        | ~5              | ~0    | 0.5h  |
| **TOTAL** | **~1070** | **~245** | **~440** | **11h** |

---

## Riesgos y mitigaciones

| Riesgo | Impacto | Mitigación |
|--------|---------|------------|
| `PluginInput.client` no tiene los métodos esperados | Crítico | Wrap con try/catch en todos los callTool, retornar null en fallo |
| AgentMemory MCP no conectado en algunas instalaciones | Medio | Adapter degrada silenciosamente, SQLite sigue siendo backend primario |
| 13 tools confunden al LLM | Medio | Descriptions largas con ejemplos, agrupar por intención |
| AFT no instalado | Bajo | Detección con `which aft`, todas las funciones retornan null |
| Latencia de MCP tool calls | Medio | Timeout 5s, cache de 5min donde aplica |
| Breaking change de la API MCP | Medio | Versions pinning en agentmemory MCP, version check en runtime |

---

## Criterios de "ULTRA PRO commander"

Al final de 0.14.0:
1. ✅ 13 custom tools
2. ✅ Lecciones en AM + SQLite (dual backend)
3. ✅ Fallback chain: codegraph → graphify → AFT → grep
4. ✅ LLM puede buscar en git history
5. ✅ LLM puede guardar reglas durables
6. ✅ LLM puede hacer undo/checkpoint
7. ✅ Descriptions con ejemplos
8. ✅ e2e test que valida todos los flujos
9. ✅ Build sin errores, typecheck limpio
10. ✅ v0.14.0 publicado en npm

---

## Costo de NO hacer este plan

El plugin actual (0.13.1) tiene 3 tools que solo tocan codegraph/graphify. **El 80% de los sistemas disponibles en OpenCode están sin explotar.** Las lecciones se quedan en SQLite invisible para AgentMemory. El LLM tiene que saber de memoria que existe `ctx_memory` y `aft_zoom` — pero el plugin no los aprovecha.

Después de 0.14.0, el LLM ve 13 tools con descripciones que sesgan hacia el uso correcto. Las lecciones persisten en 2 backends. Las reglas arquitectónicas se guardan. El undo funciona. **El plugin deja de ser un observador pasivo y se convierte en la interfaz unificada del agente sobre todos los sistemas de OpenCode.**

---

## Cómo ejecutar este plan

- **Opción A:** Yo ejecuto todo en orden de waves, validando con tests entre cada fase.
- **Opción B:** Ejecutamos wave por wave, tú validas el resultado entre waves.
- **Opción C:** Empezamos por la Fase 1 (AgentMemory dual backend) que es el cambio de mayor impacto, y decidimos el resto basándonos en feedback.

**Mi recomendación:** Opción A, comenzando con Wave 1 (Fases 0 + 4 en paralelo). La Fase 0 es prerequisito de todo, y la Fase 4 es un quick win que no depende del MCP client.

¿Opción A, B o C?
