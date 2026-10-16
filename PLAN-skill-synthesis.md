# PLAN v0.57 skill-synthesis (Nivel 2 self-improvement)

Branch: `feat/skill-synthesis` desde `main` (tras merge de `fix/memory-spam`).
Goal: el plugin propone borradores de SKILL.md sintetizados desde lecciones
consolidadas. El humano aprueba; el plugin NUNCA auto-instala.

## Por qué después de v0.56

v0.56 deja la memoria curada (dedupe, expiración, consolidación). El paso
natural: cuando `consolidateLessons()` fusiona N≥3 lecciones de la misma
firma, ese patrón merece subir de "lección" a "skill" — igual que Hermes
convierte patrones recurrentes en skills vía aprobación humana.

## Fases

### S1 — Detector de patrones candidatos
- Nueva función `findSkillCandidates(minGroupSize = 3)` en `sqlite-backend.ts`:
  lee firmas de tags con conteo (GROUP BY sobre tags JSON normalizados).
- Solo firmas con ≥3 lecciones y confianza media ≥0.6.
- Test hermético sobre tmp DB.

### S2 — Generador de borradores
- Nuevo `src/skill-synthesis.ts`: `draftSkill(candidate)` → `{ slug, SKILL.md }`.
  Estructura: nombre, trigger (cuándo aplica), procedimiento (de whatToDo de
  las lecciones), anti-patrones (de mistake), ejemplos (whereToGo).
- Borrador a `<cwd>/.agents/skills/<slug>/DRAFT-SKILL.md` — jamás SKILL.md
  final. El usuario lo renombra tras revisar.
- Reutiliza `skills-materialize.ts` con modo draft.

### S3 — Aprobación humana + wiring
- `omo_skill_propose` tool: lista candidatos pendientes (firma, N, confianza).
- `omo_skill_promote(slug)`: mueve DRAFT a SKILL.md + registra en catálogo.
- Sin auto-promoción. Sin excepciones.

### S4 — Release
- Mismo ship protocol (typecheck + bun test + CI + Oracle gate + release 0.57.0).

## Límites explícitos (no-negociables)

- NUNCA auto-instala skills ni modifica su propio código/pesos.
- Nivel 3 (auto-tuning de scoring) queda fuera: requiere jaula completa
  (rama + CI + Oracle + aprobación) que se diseñará aparte.
- Cada síntesis cita las lecciones origen (ids) para auditoría.
