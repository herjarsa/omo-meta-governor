# PLAN v0.57 skill-synthesis (Nivel 2 self-improvement)

Branch: `feat/skill-synthesis` desde `main` (tras merge de `fix/memory-spam`).
Estado: IMPLEMENTADO (S1-S4 codigo + tests; pendiente CI + release).
Goal: el plugin propone borradores de SKILL.md sintetizados desde lecciones
consolidadas. El humano aprueba; el plugin NUNCA auto-instala.

## Por qué después de v0.56

v0.56 deja la memoria curada (dedupe, expiración, consolidación). El paso
natural: cuando `consolidateLessons()` fusiona N≥3 lecciones de la misma
firma, ese patrón merece subir de "lección" a "skill" — igual que Hermes
convierte patrones recurrentes en skills vía aprobación humana.

## Fases

### S1 — Detector de patrones candidatos ✅
(Implementado: `SqliteBackend.listLessons()` + `findSkillCandidates()` puro en `src/skill-synthesis.ts`; tests S1a/S1b.)
- Nueva función `findSkillCandidates(minGroupSize = 3)` en `sqlite-backend.ts`:
  lee firmas de tags con conteo (GROUP BY sobre tags JSON normalizados).
- Solo firmas con ≥3 lecciones y confianza media ≥0.6.
- Test hermético sobre tmp DB.

### S2 — Generador de borradores ✅
(Implementado: `synthesizeSlug`, `draftSkillBody`, `writeDraftSkill` (solo DRAFT-SKILL.md, bloquea sobre SKILL.md real), `promoteDraftSkill` (requiere confirmed); tests S2a-S2d.)
- Nuevo `src/skill-synthesis.ts`: `draftSkill(candidate)` → `{ slug, SKILL.md }`.
  Estructura: nombre, trigger (cuándo aplica), procedimiento (de whatToDo de
  las lecciones), anti-patrones (de mistake), ejemplos (whereToGo).
- Borrador a `<cwd>/.agents/skills/<slug>/DRAFT-SKILL.md` — jamás SKILL.md
  final. El usuario lo renombra tras revisar.
- Reutiliza `skills-materialize.ts` con modo draft.

### S3 — Aprobación humana + wiring ✅
(Implementado: `buildOmoSkillProposeTool` (detecta + draftea, nada activo), `buildOmoSkillPromoteTool` (confirmed=true obligatorio); registrados en `mcp-tools.ts` + `MCP_TOOL_NAMES`; tests S3a/S3b.)
- `omo_skill_propose` tool: lista candidatos pendientes (firma, N, confianza).
- `omo_skill_promote(slug)`: mueve DRAFT a SKILL.md + registra en catálogo.
- Sin auto-promoción. Sin excepciones.

### S4 — Release (pendiente)
- Estado al cerrar codigo: typecheck clean; `skill-synthesis` 8/8; mcp/sqlite/upgrade suites verdes; full suite 1417 pass + 4 bootstrap preexistentes + flakes de timeout (5s) variables por carga, no relacionados (archivos no tocados por este cambio).
- Mismo ship protocol (typecheck + bun test + CI + Oracle gate + release 0.57.0).

## Límites explícitos (no-negociables)

- NUNCA auto-instala skills ni modifica su propio código/pesos.
- Nivel 3 (auto-tuning de scoring) queda fuera: requiere jaula completa
  (rama + CI + Oracle + aprobación) que se diseñará aparte.
- Cada síntesis cita las lecciones origen (ids) para auditoría.
