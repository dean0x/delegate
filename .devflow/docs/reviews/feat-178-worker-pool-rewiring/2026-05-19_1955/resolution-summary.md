# Resolution Summary

**Branch**: feat/178-worker-pool-rewiring -> main
**Date**: 2026-05-19_1955
**Review**: .devflow/docs/reviews/feat-178-worker-pool-rewiring/2026-05-19_1955
**Command**: /resolve

## Decisions Citations

- avoids PF-001 — batch-1 (root-equals-file, claude-md-test-groups, readme-tmux-prereq); all issues surfaced and fixed, none deferred

## Statistics
| Metric | Value |
|--------|-------|
| Total Issues | 20 |
| Fixed | 18 |
| False Positive | 2 |
| Deferred | 0 |
| Blocked | 0 |

## Fixed Issues
| Issue | File:Line | Commit |
|-------|-----------|--------|
| Remove accidental shell artifact '=' from repo root | `=` | a4aa66f |
| Add test:tmux groups to CLAUDE.md Quick Start and Pre-Release Validation | `CLAUDE.md:25,130` | ca3db9a |
| Add tmux >= 3.0 prerequisite to README.md | `README.md` | ca3db9a |
| killAll() returns err when workers fail to kill | `event-driven-worker-pool.ts:352` | 3898305 |
| Bundle launchAndRegister 6 params into LaunchParams interface | `event-driven-worker-pool.ts:176` | 3898305 |
| Extract destroySessionWithWarning helper for rollback duplication | `event-driven-worker-pool.ts:231` | 3898305 |
| Introduce TmuxSpawnCoreConfig in core, eliminate core->impl import | `core/tmux-types.ts, core/agents.ts` | 3898305 |
| TmuxConnectorPort.spawn() accepts TmuxSpawnCoreConfig instead of unknown | `core/tmux-types.ts:93` | 3898305 |
| Update stale JSDoc on buildTmuxCommand to reflect Phase 3 decision | `core/agents.ts:319` | 3898305 |
| Update WorkerRegistration JSDoc to cover session-name recovery | `core/domain.ts:148` | e85c519 |
| Fix dashboard orchestration liveness for tmux workers | `use-dashboard-data.ts:278` | 8b876c7 |
| Batch recovery manager isAlive via listSessions() + Set lookup | `recovery-manager.ts:187` | 8b876c7 |
| Replace mock-agent double cast with satisfies AgentAdapter | `tests/fixtures/mock-agent.ts:53` | 8b876c7 |
| Eliminate bootstrap tmuxSessionManager! non-null assertion | `bootstrap.ts:521` | 8b876c7 |
| Remove unnecessary backslash in SAFE_PATH_REGEX | `tmux/types.ts:281` | 3898305 |
| Add adapter cleanup delegation tests (AC-11) | `event-driven-worker-pool.test.ts` | f6c5a1b |
| Add completion-after-kill warning test (EC-10) | `event-driven-worker-pool.test.ts` | f6c5a1b |
| Add worker registration contract assertion (EC-11) | `event-driven-worker-pool.test.ts` | f6c5a1b |

## False Positives
| Issue | File:Line | Reasoning |
|-------|-----------|-----------|
| .gitignore removed .memory/ without replacement | `.gitignore:60` | `.devflow/.gitignore` already contains `memory/` (line 2) covering `.devflow/memory/`. Verified via `git check-ignore` — no leak risk. The root entry was for a different path (`.memory/`). |
| Fixed 3s grace period without early exit check | `event-driven-worker-pool.ts:287` | DECISION comment (lines 283-286) documents why fixed sleep is intentional: each isAlive() is a blocking spawnSync, so polling at 200ms would issue up to 15 blocking syscalls per worker. The fix would reintroduce the problem it was designed to solve. |

## Deferred to Tech Debt
(none)

## Blocked
(none)
