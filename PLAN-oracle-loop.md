# PLAN v0.61.0 — F0 (cerrar el bucle del Oracle) + F6 (modelLimit real)

## El problema que F0 arregla

El piggyback del LESSON (v0.56) es una **instrucción al agente**, no un mecanismo:

- `session-bridge.ts:354` le dice al agente "pedile al Oracle que cierre con un bloque
  LESSON... persistilo con `omo_remember`".
- `promptAgent` (`session-bridge.ts:197`) devuelve **solo `messageID`** — el plugin nunca
  lee el texto que el Oracle contesta.
- No hay verificación, ni contador, ni log de si la lección se persistió.

Consecuencia: si el agente ignora la instrucción, **la lección se pierde en silencio**.
El sistema de auto-aprendizaje depende de la obediencia del agente en el momento exacto.

## El canal disponible

`tool.execute.after` recibe `toolOutput: { title, output, metadata }`. El Oracle se lanza
como subagente `task` (`mcpArgs: { subagent_type: target }`, `plugin.ts:2341`), así que
su veredicto vuelve por ahí con `tool === "task"`.

**Ese es el punto de captura.** No hace falta LLM ni ningún endpoint nuevo: el texto ya
pasa por el proceso.

## Diseño

### F0-a: parser puro (`src/oracle-lesson.ts`)

`parseOracleLesson(text)` → `{ mistake, whatToDo, whereToGo } | null`

- Reconoce el shape pedido al Oracle: `LESSON | Mistake: X | WhatToDo: Y | WhereToGo: Z`.
- Acepta variantes: solo `Mistake:/What to do:/Where:` (el shape que ya usa
  `buildConscienceMemoryContent`), con o sin el prefijo `LESSON |`.
- **Rechaza** texto sin lesson, campos vacíos, o un `whatToDo` genérico
  (`GENERIC_WHAT_TO_DO`).
- Es puro y testeable: no toca red ni estado.

### F0-b: gates de calidad (reusa los existentes)

Antes de escribir, la lección del Oracle pasa por:
1. `isActionableConscienceLesson(mistake, whatToDo, deviations, files)` — el value gate.
2. `isNovelAgainstRecall(mistake, recalled)` — evita duplicar lo que ya se sabe.
3. Dedupe por clave estable (session + hash del contenido) vía `writeLessonOnce` — que
   ya tiene `writtenLessonKeys` en el `AgentmemoryBridgeState`.

**El gate de calidad es el filtro.** El plugin escribe, pero solo lo que vale.

### F0-c: captura en `tool.execute.after`

- Intercepta `tool === "task"` y busca el bloque LESSON en `toolOutput.output`.
- Si el agente YA persistió la lección (detectado por el `omo_remember` call en el
  mismo turno), el plugin NO escribe — evita el doble escritor.
- Si NO la persistió, el plugin la escribe a agentmemory con el writer único
  (`writeLessonOnce`).

**Esto elimina la dependencia de la obediencia del agente** sin crear un segundo
escritor: sigue habiendo un solo camino de escritura (agentmemory vía
`writeLessonOnce`).

### F6: `modelLimit` real

Hoy `getModelLimit()` devuelve `modelOverride.modelLimit ?? 200_000` — el 200k es
hardcoded y no refleja el modelo real de la sesión. El token-predictor calcula la
tasa de quema contra ese número, así que **la predicción de overflow miente** cuando
el modelo tiene otra ventana.

Fix: `getModelLimit()` pasa a preferir el contexto real del modelo de la sesión
(lo que opencode reporta) y usa `modelOverride.modelLimit` solo como override
explícito.

## Orden de release

Un solo release: **v0.61.0** con F0 + F6. Son el mismo theme (el plugin lee lo que
el modelo realmente dijo, en vez de asumirlo).

## Criterios de aceptación

- [ ] `parseOracleLesson` extrae el lesson del shape exacto y de las variantes.
- [ ] `parseOracleLesson` rechaza: sin lesson, campos vacíos, whatToDo genérico.
- [ ] El plugin NO escribe cuando el agente ya persistió (no hay doble escritor).
- [ ] El plugin escribe cuando el agente NO persistió.
- [ ] Las lecciones del Oracle pasan los gates (value + novelty) antes de escribir.
- [ ] `getModelLimit` usa el contexto real del modelo de la sesión.
- [ ] `bun run typecheck` clean.
- [ ] Suite sin regresiones.
