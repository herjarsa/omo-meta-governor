# PLAN — v0.32.0 skill-hub subsystem

Branch: `feat/skill-hub` (worktree `../omo-meta-governor-skillhub`)
Goal: registry-backed skill catalog replacing AAS MCP + superpowers plugin + 73MB local catalog. Zero static context injection; pure on-demand discovery via 3 new `omo_skill_*` tools.

## Verified sources (this session)
- Bootstrap bulk: `https://skills-library.com/api/skills.json` (6.6MB, 5959 records) + `deps.json`
- Live fallback search: `https://skills.sh/api/search?q=&limit=` (anonymous, verified)
- Content: `https://skills.sh/api/download/{owner}/{repo}/{slug}` → `{files:[{path,contents}]}` (anonymous, verified)
- Embeddings: existing pm2 `embed-server` @ `http://127.0.0.1:3114/v1/embeddings`, model bge-m3, 1024d (verified live)

## Phases

### F1 — Sync & storage foundation
- [x] F1-A RED→GREEN: `skill-hub-sync.ts` (`normalizeSkillRecord`, `skillHubRecordHash`, `SkillHubSync.ingestBootstrap`) + 12 tests SKB-* ; fixed pre-existing phantom `updated_at` bug in `sqlite-backend.ts` skills UPSERT
- [ ] F1-B: deps.json real shape → `skill_deps` table + backend methods (RED→GREEN)
- [ ] F1-C: config key `skillHub` (types.ts + config-file.ts + schema.json) (RED→GREEN)
- [ ] Commit + push + draft PR (CI runs on PR)

### F2 — Vectors & hybrid ranker
- [ ] EmbedClient (:3114, cold-start 30s timeout + 1 retry, DI fetch seam) — mock-server tests
- [ ] Vector BLOB codec + cosine (~6k vectors)
- [ ] Ranker RRF(k=60): FTS5 ⊕ cosine; filters minInstalls / duplicates / deps-warning

### F3 — Tools
- [ ] `omo_skill_find(query, limit?)` — hybrid local → live merge
- [ ] `omo_skill_get(id)` — hash-cached content fetch
- [ ] `omo_skill_add(id)` — proc-guard wrapper, explicit-confirm semantics
- [ ] Wire into custom-tools.ts adapter + mcp-server.js curated list

### F4 — Governance integration
- [ ] `skillPriming.router` += `'registry'`
- [ ] Graceful degradation: embed down → FTS5-only note; offline → cache-only

### F5 — Release
- [ ] Docs: README / ARCHITECTURE / STRUCTURE / CHANGELOG
- [ ] Oracle review gate (full-phase diff)
- [ ] bump 0.32.0 → CI green → npm publish → tag v0.32.0 → gh release

## Rules
TDD RED→GREEN per behavior · hermetic tests (DI seams, no network in CI) · no as-any · graceful degradation never crashes load · conventional commits · push+CI green per phase.
