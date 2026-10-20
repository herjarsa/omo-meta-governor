# PLAN v0.59.0 — skill synthesis AUTÓNOMA con gates de calidad

Rama: `feat/autonomous-skill-synthesis` desde `main` (tras v0.58.0).
Meta: el agente crea sus propias skills a partir de su experiencia, SIN
aprobación humana, pero solo si las skills son de valor real.

## El problema (medido contra agentmemory real, 2026-10-20)

7 lecciones en `omo-meta-governor`, de las cuales 5 son basura:
- `lsn_33472206eaab8cb1` conf 0.97 — "no-type-suppression" score -0.50
- `lsn_6ff46e2678ad9d18` conf 0.91 — "no-type-suppression" score -0.50
- `lsn_919f8a9c4bd465a9` conf 0.82 — "no-type-suppression" score -0.51
- `lsn_199a7b1cd4af02b3` conf 0.78 — "no-type-suppression" score -0.50
- `lsn_ce063717a78a884b` conf 0.78 — "no-type-suppression" bad.ts

**Por qué el dedupe de agentmemory no las colapsa:** el `content` incluye el
score (`score -0.50` vs `score -0.51`) y el target (`seed.ts` vs `bad.ts`).
El fingerprint SHA-256 cambia → 5 filas distintas → 5 "patrones" → 5
skills basura con la misma regla.

**Por qué son basura como skills:** `no-type-suppression` NO es una skill
dependiente del proyecto — es una regla del protocolo, ya cubierta por el
system prompt. Una skill debe ser conocimiento ESPECÍFICO del proyecto que
el agente no tiene en el prompt.

## F1 — Lección canónica (arregla la fuente)
- `extractLessonsForSession` deja de meter el score en el content.
- Firma estable: `rule | where | remedy` (sin floats, sin timestamps).
- `agentmemory` refuerza duplicados reales; el score no vuelve a crear filas.
- Test: la misma regla en 3 sesiones con scores distintos → 1 fila.

## F2 — Clasificador de "merece ser skill" (el gate central)
Una lección NO es skill si:
- su categoría es una regla de protocolo (no-type-suppression,
  memory-first, no-empty-catch, oracle-verification, codebase-graph-first,
  continuation-discipline, no-batch-todo-completion,
  save-discovery-to-memory, empty-result-escalation) → ya están en el
  system prompt; una skill los duplicaría sin valor.
- su `where` es genérico (`session:<id>`, sin archivo) → no es aplicable.
- no hay señal de proyecto (categoría + al menos un basename de archivo).
- su remedy es el fallback genérico.
- ya existe una skill con el mismo slug y confianza >= la de la lección.
- la confianza de la lección < 0.6 (nunca aprendida, solo insinuada).

Test: gate con 8 casos (acepta/rechaza).

## F3 — Fusión por slug (kills the 5-rows → 1-skill problem)
- Agrupar por slug de skill, no por firma de tags.
- Un slug = una skill. La confianza agregada = max + 0.05*(n-1) (cap 0.9).
- El body se sintetiza de TODAS las lecciones fusionadas, no de una.

## F4 — Síntesis con LLM barata (calidad real)
- `modelOverride` ya configurado (`muse-spark-1.3-contributor`).
- El sintetizador recibe SOLO el bloque estructurado
  (`Mistake/What to do/Where`), nunca el dump de scoring.
- Salida: JSON estricto `{name, description, whenToUse, procedure[], pitfalls[]}`.
- Fallo/timeout → fallback determinista (nunca escribe basura).
- 1 llamada por propuesta, NO por turno.

## F5 — Autopromoción con gates
- La promoción es AUTOMÁTICA si la skill pasa TODOS los gates:
  - F2 (merece ser skill)
  - confianza agregada >= 0.7
  - N >= 3 lecciones independientes
  - el body tiene >= 3 pasos de procedimiento no vacíos
  - el body no es casi-idéntico a una skill existente (Jaccard < 0.8)
- Se escribe directo a `SKILL.md` (no DRAFT) — el agente es autónomo.
- Se escribe en `<cwd>/.agents/skills/<slug>/SKILL.md` (proyecto) para que
  opencode la cargue. Chore global es opcional y opt-in.
- Se registra en agentmemory como `type=architecture` para que la skill
  creada se recupere en sesiones futuras.
- Kill-switch: `closedLoop.autonomousSkills.enabled: false` (default true).

## F6 — Cleanup de basura heredada
- `omo_skill_prune`: borra lecciones de agentmemory que NO pasan el gate F2
  (basura de score-float). Requiere `agentmemory/governance/memories` o
  `lesson_delete`. Opcional, con dry-run por defecto.

## F7 — Registro V1/V2
- `omo_skill_propose`/`promote`/`prune` registradas en plugin V1 y V2
  (hoy solo MCP).

## No-negociables
- El agente NUNCA crea una skill que duplique una regla del system prompt.
- El agente NUNCA escribe una skill con menos de 3 lecciones independientes.
- Una skill creada se puede degradar/borrar si deja de ser usada (TTL).
- Todo es reversible: el kill-switch apaga la promoción automática.
