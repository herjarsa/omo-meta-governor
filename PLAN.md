# PLAN v0.32.0 skill-hub subsystem

Branch: `feat/skill-hub` (worktree `../omo-meta-governor-skillhub`)
Goal: registry-backed skill catalog replacing AAS MCP + superpowers plugin + 73MB local catalog. Zero static context injection; pure on-demand discovery via 3 new `omo_skill_*` tools.

## Phases

### F1 — Sync & storage foundation [COMPLETED]
- [x] F1-A RED→GREEN: `skill-hub-sync.ts` (`normalizeSkillRecord`, `skillHubRecordHash`, `SkillHubSync.ingestBootstrap`) + 12 tests SKB-* ; fixed phantom `updated_at` bug in `sqlite-backend.ts` skills UPSERT — commit 2ce42aa
- [x] F1-B RED→GREEN: `skill_deps` table + `skillReplaceDeps`/`skillGetDeps` + `ingestDeps` walk of `{[depType]:{[depName]:{skills}}}` shape + 8 tests SKD/SKB-12..15 — commit (feat/skill-hub)
- [x] F1-C RED→GREEN: `SkillHubConfig` interface (types.ts) + raw `skillHub?{}` + projection defaults (config.ts) + `defaultOrchestratorConfig` (orchestrator.ts) + schema.json block + 2 config.test.ts tests — commit 1798618
- [x] Oracle review gate Fase 1 — APPROVE (no blockers, advisory NOTEs only)
- [x] CI GREEN — run 32658263786 (test-windows + test-macos + test: .github#2) — WATCH_EXIT 0

### F2 — Vectors & hybrid ranker [IN PROGRESS]
- [ ] F2a EmbedClient (:3114, cold-start 30s timeout + 1 retry, DI fetch seam) — RED embed-client.test.ts mock → GREEN embed-client.ts
- [ ] F2b Vector BLOB codec + cosine (~6k vectors) — sqlite read/write path
- [ ] F2c Ranker RRF(k=60): FTS5 ⊕ cosine; filters minInstalls / duplicates / deps-warning — RED ranker.test.ts → GREEN ranker.ts

### F3 — Tools [PENDING]
- [ ] `omo_skill_find(query, limit?)` — hybrid local ⊕ live merge
- [ ] `omo_skill_get(id)` — hash-cached content fetch
- [ ] `omo_skill_add(id)` — proc-guard wrapper, explicit-confirm semantics
- [ ] Wire into custom-tools.ts adapter + mcp-server.js curated list

### F4 — Governance integration [PENDING]
- [ ] `skillPriming.router` += `'registry'`
- [ ] Graceful degradation: embed down → FTS5-only note; offline → cache-only

### F5 — Release [PENDING]
- [ ] Docs: README / ARCHITECTURE / STRUCTURE / CHANGELOG
- [ ] Oracle review gate final (full-phase diff)
- [ ] bump 0.32.0 → CI green → npm publish → tag v0.32.0 → gh release

## Rules
- TDD RED→GREEN per behavior; hermetic tests with DI seams + fixture subsets (no network in CI)
- No type suppression (no bypassing checker); no empty catch; graceful degradation never crash load
- Per-phase exit = `tsc --noEmit` 0 errors + full `bun test` suite green + conventional commit + push + `gh run watch` green
- Final: bump 0.32.0, npm publish, tag v0.32.0, gh release (Added/Fixed/Changed/Tests/Config notes), Oracle review gate BEFORE release
- Windows-safe subprocess handling via proc-guard
- New tools must register in both plugin-mode AND MCP-server-mode via adapter pattern
- After each commit: graphify hook + `codegraph sync` reindex (automated)

## Verified sources (this session)
- Bootstrap bulk: `https://skills-library.com/api/skills.json` (6.6MB, 5959 records) + `deps.json`
- Live fallback search: `https://skills.sh/api/search?q=&limit=` (anonymous, verified)
- Content: `https://skills.sh/api/download/{owner}/{repo}/{slug}` → `{files:[{path,contents}]}` (anonymous, verified)
- Embeddings: pm2 `embed-server` @ `http://127.0.0.1:3114/v1/embeddings`, model bge-m3, 1024d (verified live)
