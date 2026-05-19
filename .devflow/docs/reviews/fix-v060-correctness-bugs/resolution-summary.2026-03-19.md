# Resolution Summary

**Branch**: fix/v060-correctness-bugs -> main
**Date**: 2026-03-19
**Command**: /resolve
**PR**: #106

## Statistics
| Metric | Value |
|--------|-------|
| Total Issues | 7 |
| Fixed | 6 |
| False Positive | 1 |
| Deferred | 0 |
| Blocked | 0 |

## Fixed Issues
| Issue | File:Line | Commit |
|-------|-----------|--------|
| Extract duplicated `linesSize` to shared `linesByteSize` utility | output-capture.ts:13, task-manager.ts:33 | bfa99b3 |
| Fix `totalSize` byte-vs-char inconsistency (bytes everywhere) | output-capture.ts:51,119, task-manager.ts:153 | bfa99b3 |
| Align `TestOutputCapture` totalSize with production (use bytes) | output-capture.ts:213 | bfa99b3 |
| Add tests for TaskFailed emit failure in dead worker cleanup | recovery-manager.ts:129 | f5c9332 |
| Add tests for TaskFailed emit failure in crashed task recovery | recovery-manager.ts:271 | f5c9332 |
| Document double-write ARCHITECTURE EXCEPTION pattern | recovery-manager.ts:111,255 | f5c9332 |
| Add integration test for dependency-aware recovery | task-persistence.test.ts | 8135b77 |

## False Positives
| Issue | File:Line | Reasoning |
|-------|-----------|-----------|
| RecoveryManager 6 constructor params | recovery-manager.ts:13 | 6 injected dependencies is within codebase norm (3-7 range). WorkerHandler, DependencyHandler, and TaskManager all have 7. All 6 are genuine interface-typed collaborators, not configuration. An options object would obscure, not clarify. |

## Deferred to Tech Debt
*None formally deferred.*

**Observation (not deferred):** `OutputRepository.calculateTotalSize()` and `OutputRepository.append()` use `string.length` (characters) rather than `Buffer.byteLength` (bytes) in the persistence layer. This is a separate concern outside this PR's scope and does not affect correctness for the current fix (which targets in-memory and DB-read paths).

## Blocked
*None*

## Simplifier Refinements
- Removed unnecessary `ARCHITECTURE:` tags from utility comments (standard patterns don't need them)
- Added blank line before return in `BufferedOutputCapture.getOutput()` for spacing consistency
- Commit: cb3f4a5
