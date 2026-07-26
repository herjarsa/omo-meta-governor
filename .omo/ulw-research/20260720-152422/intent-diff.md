# Intent vs Reality

| intent_id | expected truth | observed reality | diff | violated invariant | intent source | observations | status | claims |
|---|---|---|---|---|---|---|---|---|
| I1 | Plugin visibly governs execution, not only advises | Pipeline runs but defaults produce zero visible effect | Default config (silent mode + minActionForMessage=stop + empty backends) creates invisible governance | Active enforcement + user visibility | User report 2026-07-20 | O2, O4, O8 | violated | C1, C2, C3 |
| I2 | Completed work produces reusable lessons automatically | AgentMemory search returned observations but lessons=[] | `runMetaGovernor` calls `saveLesson` via stub `writeBackend` that returns `{id:""}` | Closed learning loop writes real lessons | User report + tool output O1 | O1, O4 | violated | C1 |
| I3 | Codebase queries route through CodeGraph/Graphify when available | Plugin only injects prompt text; never calls `codegraph_explore` or `graphify query` | Agent is told to use tools it doesn't have; violation audit is reactive only | Graph-first retrieval | User report | O5, O12 | violated | C2 |
| I4 | Plugin exposes proof of interventions and learned value | File logger writes to ~/.config/opencode/meta-governor.log; no health endpoint, no metrics, no log rotation | Observability is "check the log file manually" | Visible value | User report | O2, O8 | violated | C3 |
| I5 | Improvements are feasible on current OpenCode public/runtime seams | V1 hooks available, V2 partial; multiple ecosystem plugins demonstrate patterns | Strong integration points exist but require workarounds for permission.ask, session.start/end, tool.execute.after for native | Implementability | Research objective | O6, O7, O9, O10, O11 | partial | C4 |
