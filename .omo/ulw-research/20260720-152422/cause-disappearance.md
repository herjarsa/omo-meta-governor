# Cause Disappearance Ledger

| cause_id | expected truth | previous observation | last_seen | disconfirming observation | replacement cause | status | violation absent? |
|---|---|---|---|---|---|---|---|
| CA1 | Automatic lessons appear after completed work | observations exist, lessons=[] | 2026-07-20 | C1: stub backends discard writes | needs real backend wiring | confirmed | no - requires real backends |
| CA2 | Graph-first code search is visible and enforceable | user reports no visible use | 2026-07-20 | C2: plugin never calls graph tools + C7: tool.execute.before doesn't fire for native grep/glob | needs to either (a) invoke graph tools from tool.execute.before with custom tools, or (b) use tool.definition to hide native tools | confirmed | no - requires architectural change |
| CA3 | Config enables visible governance | enabled=true expected to work | 2026-07-20 | C3: 4 layered defaults block visibility | change defaults to message mode + real backends | confirmed | no - config change needed |
| CA4 | Tests prove governance works | 333 unit tests pass | 2026-07-20 | no e2e test against real OpenCode; tests use mocked hooks | add e2e test | confirmed | no - test gap |
| CA5 | Protocol enforcer flags grep violations when graph exists | rule documented in protocol-enforcer.ts:148-160 | 2026-07-20 | C7: tool.execute.before does NOT fire for grep/glob native tool calls | rule is unreachable for most common operations | confirmed | no - hook is dead for native tools |
