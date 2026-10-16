# PLAN-spam-fix v0.56.0 — ejecución (rama `fix/memory-spam`)

Objetivo: el plugin audita sin generar memoria basura, orienta con
síntesis estructurada por regla y cura su propia memoria (Nivel 1).

## F1 — Reproducción ✅
- `src/spam-oracle-dump.test.ts`: T1 (final-only no audita Oracle mid-work),
  T1b (per-stop sí), T2 (colapso ×N), T3 (concepts sin severity),
  T4 (dedupe insensible a multiplicidad). RED 4 fail / 1 pass → GREEN 5/5.

## F2 — Cerrar el grifo ✅
1. `protocol-enforcer.ts`: `AuditContext.oracleFrequency` + audit
   frequency-aware (solo `per-stop` emite mid-work).
2. `closed-loop-learning.ts`: `collapseDeviationsForLesson()` usado en
   `buildLessonContent`; `extractConcepts` sin severity, stoplist, cap 5;
   `conscienceDedupeKey` sobre sets únicos.
3. `orchestrator.ts`: respeta `input.config` (antes lo ignoraba: toggles
   de `closedLoop` eran letra muerta en producción).
4. `plugin.ts`: pasa `oracleFrequency` al audit; single-writer
   (`saveLessons:false` cuando conscience posee lecciones); ventana de
   keys vistas (no solo última); `filePath` en desviaciones desde
   `tool.execute.before`.
5. Tests legacy actualizados a per-stop donde testeaban el audit en sí.

## F3 — Value gate + novelty ✅
- `GENERIC_WHAT_TO_DO` canónico + `isActionableConscienceLesson()`
  (genérico solo persiste grounded o grave).
- `isNovelAgainstRecall()` (Jaccard) cableado en `observeAndLearn`
  vía `memoryRead`.
- Tests T5/T6.

## F4 — Tokens + objetivo + higiene ✅
- Cache `smartSearch` 30s TTL por query (menos I/O por tool call).
- `goal-progress` (w=0.10, slot antes sin asignar) desde
  `boulderState.planProgress`; `DecisionContext.planProgress` (opcional).
  Tests T7/T8.
- `sqlite-backend.ts`: columna `last_used` (migración aditiva),
  `recordLessonUse` en `smartSearch`, `expireUnusedLessons(cutoff)`.
  Tests T9.

## F5 — Judge-synthesis determinista ✅
- `RULE_GUIDANCE` + `synthesizeWhatToDo()` por regla (adiós template
  genérico). Tests T10.
- Oracle piggyback en `buildEscalationPrompt`: bloque LESSON
  estructurado con cero invocaciones extra. Test T11.
- Decisión: sin LLM por alerta (coste/latencia/async); el juez-LLM
  llega gratis dentro del Oracle que ya corre.

## Nivel 1 self-curation ✅
- `consolidateLessons()`: fusiona por firma de tags, longest-content
  wins, confianza +0.05/absorbida (cap 0.9). Test T12.

## Verificación
- `bun run typecheck` → 0 errores.
- `bun test` (suite completa) → ver reporte final.
- Ship: commit atómico → push → `gh run watch` → Oracle gate → release 0.56.0.

## Siguiente (v0.57)
Ver `PLAN-skill-synthesis.md`. Nivel 3 (auto-tuning) fuera de alcance
hasta diseñar su jaula.
