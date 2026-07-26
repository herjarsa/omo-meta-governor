# Observation Manifest

| observation_id | source | layer | group | independence | observer | observed_at | valid_at | artifact | anchor | contamination |
|---|---|---|---|---|---|---|---|---|---|---|
| O1 | AgentMemory smart search | runtime | orchestrator | direct tool output | Sisyphus | 2026-07-20T15:24:22+02:00 | current session | tool output | lessons=[] with prior observations | none |
| O2 | User report | experiential | user | independent first-party report | user | 2026-07-20T15:24:22+02:00 | current installed plugin | conversation | plugin seems to do nothing | perception requires code/runtime corroboration |
| O3 | graphify query local graph | static graph | orchestrator | graph index | Sisyphus | 2026-07-20T15:25:00+02:00 | graph snapshot | tool output | plugin.ts imports graph-sync functions | graph may be stale; source validation required |
| O4 | local plugin hook audit | static source | code audit | 37 source files read in full | bg_9e232dae | 2026-07-20T15:31:00+02:00 | 0.12.1 | plugin.ts:184-629 | 4/21 hooks registered | none |
| O5 | local graph routing audit | static source | code audit | protocol-enforcer.ts + plugin.ts | bg_1c94a28b | 2026-07-20T15:30:00+02:00 | 0.12.1 | entire codebase | zero graph tool invocations | none |
| O6 | upstream issue audit | community | GitHub | 10+ search queries | bg_b2b86fb5 | 2026-07-20T15:29:00+02:00 | open issues as of 2026-07-20 | 54 issues/PRs catalogued | tool.execute.after not triggered #25918 | some are open-feature requests not bugs |
| O7 | upstream plugin hooks audit | source code | code audit | TypeScript packages at SHA b67fda13 | bg_48c34dc3 | 2026-07-20T15:30:00+02:00 | dev branch HEAD | plugin/index.ts:280-293 | trigger() runs hooks sequentially | none |
| O8 | local observability audit | static source | code audit | 19 test files, 17 source files | bg_e582d3e3 | 2026-07-20T15:33:00+02:00 | 0.12.1 | config.ts:92-175 | 4 inert-by-default configs | none |
| O9 | ecosystem plugin survey | community | GitHub | 15 repos cloned and read | bg_ebfa5adc | 2026-07-20T15:32:00+02:00 | various SHAs | ed3ba3f ensemble SHA | SQLite is universal substrate | popularity ≠ production-readiness |
| O10 | upstream source deep dive | source code | code audit | Go + TS repos cloned | bg_d10e7bf3 | 2026-07-20T15:36:00+02:00 | both branches | Go 73ee493, TS b67fda13 | 2 parallel implementations | none |
| O11 | session lifecycle trace | source code | code audit | session-event.ts + processor.ts | bg_bf99c58a | 2026-07-20T15:37:00+02:00 | dev branch HEAD | 21 typed hooks mapped | 2-tier event system | none |
| O12 | file system reality check | runtime | orchestrator | statSync at plugin load | bg_1c94a28b | 2026-07-20T15:30:00+02:00 | current session | .codegraph + graphify-out both exist | detection is correct | race condition found |
