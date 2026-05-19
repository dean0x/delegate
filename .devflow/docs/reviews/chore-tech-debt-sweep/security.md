# Security Review Report

**Branch**: chore/tech-debt-sweep -> main
**Date**: 2026-03-20
**PR**: #109

## Issues in Your Changes (BLOCKING)

### CRITICAL

No critical security issues found.

### HIGH

No high-severity security issues found.

## Issues in Code You Touched (Should Fix)

No should-fix security issues found.

## Pre-existing Issues (Not Blocking)

No pre-existing security issues surfaced by these changes.

## Suggestions (Lower Confidence)

No lower-confidence suggestions.

## Analysis Notes

This PR is a pure refactoring with three commits:

1. **`e615c1e` - refactor(worker-pool): extract registerWorker from spawn() (#98)**
   Extracts inline worker registration logic into a private `registerWorker()` method. Security-relevant behavior is preserved exactly:
   - UNIQUE violation rollback (Edge Case J) still kills the child process and cleans up maps before returning the error.
   - `ownerPid` cross-process coordination is unchanged.
   - `SIGTERM` on conflict is unchanged.
   The extraction is a pure move -- no logic changes, no new inputs, no changed control flow.

2. **`c306792` - refactor(cli): extract exitOnError/exitOnNull helpers (#102)**
   Introduces two guard functions in `src/cli/services.ts` that centralize the repeated `if (!result.ok) { process.exit(1); }` pattern. Security considerations reviewed:
   - **Error message exposure**: `exitOnError` passes `result.error.message` to `ui.error()`. This is a local CLI tool (not a web server), so exposing internal error messages to the terminal user is the expected behavior. No information leakage risk.
   - **Control flow safety**: Both functions call `process.exit(1)` on the error path, which is the `never` return path. TypeScript narrows correctly after these calls. No code continues past a failed guard.
   - **No input validation changes**: All ID values (TaskId, ScheduleId) still go through their branded constructors. Path validation via `validatePath()` is unchanged.

3. **`d7d27c8` - style(cli): dogfood exitOnError in withReadOnlyContext/withServices**
   Applies the `exitOnError` helper to `withReadOnlyContext()` and `withServices()`, replacing inline error-handling boilerplate. Behavior is identical to the previous implementation.

**Threat model assessment**: This is a local CLI tool. The attack surface is the local user's terminal input. All changes are mechanical refactoring that preserves existing security properties:
- Parameterized queries (SQLite) -- unchanged
- Path traversal protection (`validatePath`) -- unchanged
- Branded type constructors for IDs -- unchanged
- Process isolation and SIGTERM/SIGKILL handling -- unchanged
- Worker registration rollback on UNIQUE violation -- unchanged

## Summary

| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 0 | 0 | 0 |
| Should Fix | 0 | 0 | 0 | 0 |
| Pre-existing | 0 | 0 | 0 | 0 |

**Security Score**: 9/10
**Recommendation**: APPROVED

The PR introduces no new security surface. All changes are mechanical refactoring (extract method, extract helper function) that preserve existing security invariants exactly. The one point deducted from the score reflects the pre-existing pattern of casting user-supplied strings directly into branded types (e.g., `ScheduleId(scheduleArgs[0])`) without sanitization, but this is not introduced by this PR and is appropriate for a local CLI tool.
