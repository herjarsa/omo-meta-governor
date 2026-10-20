# PLAN v0.58.0 — agentmemory como ÚNICA memoria del plugin

Rama: `feat/agentmemory-only-memory` desde `main`.
Meta: eliminar la memoria paralela del plugin (SQLite de lecciones + captura
automática por tool call) y usar agentmemory como única memoria a largo plazo.

## Hallazgos de la API real (probe contra :3111, 2026-10-20)

| Endpoint | Estado | Uso en el plugin |
|---|---|---|
| `POST /agentmemory/context` | ✅ | contexto relacionado al inicio de cada tarea |
| `POST /agentmemory/enrich` | ✅ | contexto por archivos tocados (pre-write) |
| `POST /agentmemory/smart-search` | ✅ | recall híbrido (reemplaza omo_recall SQLite) |
| `POST /agentmemory/lessons` | ✅ | escritura de lecciones (crea/strengthens/decae) |
| `POST /agentmemory/observe` | ✅ | ya lo usa el plugin agentmemory-capture |
| `POST /agentmemory/summarize` | ✅ | resumen de sesión al cierre |
| `POST /agentmemory/session/start|end` | ✅ | ciclo de vida de sesión |
| `GET /lessons,/memories,/insights,/patterns,/profile,/frontier,/next,/counts,/graph/stats` | ✅ | señal extra para el juez |
| `POST /agentmemory/remember` | ❌ 500 `isLatest` | **no usar** (bug del server; MCP shim cae a KV local) |
| `GET /agentmemory/file-history` | ❌ 404 | usar `POST /enrich` en su lugar |
| `memory_slot_*` | ⚠️ flag `AGENTMEMORY_SLOTS` off | no usar |

## F1 — `src/agentmemory-client.ts` (nuevo)
- Cliente REST con DI de `fetch` (tests herméticos, sin red).
- Auth: `AGENTMEMORY_SECRET` env → `~/.agentmemory/.env` → `~/.agentmemory/secret`.
  URL: `AGENTMEMORY_URL` env → `http://localhost:3111`.
- Métodos: `startSession`, `endSession`, `context`, `enrich`, `search`,
  `saveLesson`, `summarize`, `listLessons`, `profile`, `patterns`, `insights`,
  `counts`, `status`.
- Todos con timeout (default 3s) y degradación silenciosa (null, no throw).
- Tests: auth resolution, timeout, degraded path, mapping de respuestas.

## F2 — Contexto al inicio de cada tarea
- `session.start` (1 vez por sesión) + `POST /context` → bloque inyectado en
  `chat.system.transform` con marcador `DO NOT TREAT AS TASK`.
- `POST /enrich` con los archivos que el agente va a tocar → contexto
  relevante pre-write (una vez por conjunto de archivos, cache 30s).
- Rate-limit: máximo 1 fetch de contexto por turno; nada si no hay archivos.
- Tests: no inyecta si context vacío; inyecta una vez; cache por archivos.

## F3 — Escritura al final de la sesión
- Trigger: señal `<promise>DONE</promise>` / `session.idle` (no cada tool call).
- `POST /summarize` (sessionId) + `POST /lessons` por cada lección validada.
- GATES 0.56 se reutilizan (value gate + novelty + dedupe) → no reintroduce spam.
- `POST /lessons` refuerza duplicados automáticamente (confidence sube).
- Tests: sin gate no escribe; escribe con gate; refuerza duplicado.

## F4 — Quitar la memoria paralela
- `omo_recall` → agentmemory `/smart-search` (fallback: cache local, no SQLite lessons).
- `omo_remember` → escritura directa HTTP (elimina el round-trip LLM del bridge).
- `omo_recall_mcp` → deprecado (alias de omo_recall).
- Captura por tool call → OFF (solo session-end). Cierra la doble captura.
- `skill-synthesis` (0.57) → lee lecciones de agentmemory, no de SQLite.
- SQLite conserva solo datos operativos (skills catalog, boulder tasks, health).
- Tests: recall consulta agentmemory; remember no usa session.prompt.

## F5 — Señales extra de agentmemory para el juez
- `memory_patterns` (patrones recurrentes entre sesiones) → señal de
  desviación recurrentes (más específica que `deviation-detector`).
- `memory_profile` (convenciones del proyecto) → contexto para el sintetizador.
- `memory_insight_list` (insights de orden superior) → contexto de sesión.
- `memory_commits`/`commit_lookup` → qué sesión produjo qué commit.
- Implementado como `omo_memory_context` tool (una llamada, todo junto) para
  no multiplicar round-trips.

## F6 — Release
- typecheck + bun test + CI + PR + release 0.58.0.

## No-negociables
- Una sola captura: agentmemory-capture plugin (ya instalado) es el único
  capturador de observaciones. El plugin NO captura por tool call.
- El plugin no borra memorias de agentmemory sin gate explícito.
- Si agentmemory está caído, el plugin degrada a "sin contexto" (no a SQLite
  paralelo): menos contexto es mejor que dos memorias divergentes.
