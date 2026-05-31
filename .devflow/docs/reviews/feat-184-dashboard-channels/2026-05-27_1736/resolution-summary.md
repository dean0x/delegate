# Resolution Summary

**Branch**: feat-184-dashboard-channels -> main
**Date**: 2026-05-27
**Review**: .devflow/docs/reviews/feat-184-dashboard-channels/2026-05-27_1736
**Command**: /resolve

## Decisions Citations

- applies ADR-001 — batch-4, sec-lines-validation (explicit validation for all parameters entering shell commands)
- applies ADR-003 — batch-3, pre-existing biome formatter errors not introduced by this PR
- avoids PF-001 — batch-2, consistency-terminal-statuses (fix it while we're here, don't defer)
- avoids PF-002 — batch-1, perf-missing-index (safe to modify migration v32 since not yet released)

## Statistics
| Metric | Value |
|--------|-------|
| Total Issues | 11 |
| Fixed | 10 |
| False Positive | 1 |
| Deferred | 0 |
| Blocked | 0 |

## Fixed Issues
| Issue | File:Line | Commit |
|-------|-----------|--------|
| N+1 query batch loading in findAll/findByStatus | `channel-repository.ts:224-243` | `bcd2845` |
| Missing covering index for getMessages ORDER BY | `database.ts:1276-1279` | `bcd2845` |
| Missing TERMINAL_STATUSES pattern for channels | `constants.ts` + `entity-mutations.ts:84-94,202-211` | `d3fd6a1` |
| Missing entity mutation tests (13 tests added) | `entity-mutations.test.ts` | `d3fd6a1` |
| Missing never exhaustive guard in memberStatusColor | `channel-detail.tsx:48-52` | `bcb03e0` |
| Unbounded message list (added ScrollableList) | `channel-detail.tsx:150-158` | `bcb03e0` |
| Unvalidated lines parameter in capturePaneContent | `tmux-session-manager.ts:443` | `9dffc2e` |
| Stale inline comments (1-5→1-6, pause scope) | `handle-main-keys.ts:45,176` | `f6cdd94` |
| Duplicated member-lookup logic (extracted utility) | `app.tsx` + `channel-detail.tsx` → `helpers.ts` | `f6cdd94` |
| Unbounded channel_messages growth (inline pruning) | `channel-repository.ts` | `f6cdd94` |

## False Positives
| Issue | File:Line | Reasoning |
|-------|-----------|-----------|
| Double state-update in useChannelPanePreview | `use-channel-pane-preview.ts:68-96` | The first effect's unconditional reset is necessary: when sessionName changes to null or enabled becomes false, doCapture() returns early without resetting state. Removing the first effect would leave stale preview visible between member switches. |

## Deferred to Tech Debt
_(none)_

## Blocked
_(none)_
