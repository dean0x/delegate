# Security Review Report

**Branch**: fix-git-integration -> main
**Date**: 2026-03-25
**PR**: #120

---

## Issues in Your Changes (BLOCKING)

### CRITICAL

(none)

### HIGH

(none)

### MEDIUM

(none)

## Issues in Code You Touched (Should Fix)

(none)

## Pre-existing Issues (Not Blocking)

(none)

## Suggestions (Lower Confidence)

- **`git clean -fd` in `resetToCommit` removes untracked files without branch guard** - `src/utils/git-state.ts:410` (Confidence: 72%) -- `resetToCommit()` runs `git reset --hard` + `git clean -fd` which destroys uncommitted work irrevocably. While gated by `iteration.preIterationCommitSha` (only git-enabled loops) and the loop creates its own branch, there is no runtime check that the current branch matches the loop's `gitBranch` before performing destructive operations. If an agent switches branches mid-iteration, the reset could affect the wrong branch. Consider verifying the current branch before destructive operations.

- **Commit message includes interpolated loop state** - `src/services/handlers/loop-handler.ts:1188` (Confidence: 65%) -- The commit message interpolates `loop.id` and `iterationStatus` into a string passed to `git commit -m`. Safe because `execFile` is used (no shell), `loop.id` is system-generated UUID, and `--` separator is applied. Flagged for awareness only.

- **`getCurrentCommitSha` does not validate its return value is a hex SHA** - `src/utils/git-state.ts:266-282` (Confidence: 62%) -- The function trusts `git rev-parse HEAD` output without verifying it matches `^[0-9a-f]{40}$`. In practice, this value goes through `isValidCommitSha` validation before use in `resetToCommit`, so the actual security boundary is maintained. Low practical risk.

## Summary

| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 0 | 0 | 0 |
| Should Fix | 0 | 0 | 0 | 0 |
| Pre-existing | 0 | 0 | 0 | 0 |

**Security Score**: 9/10
**Recommendation**: APPROVED

---

## Detailed Security Analysis

### Scope

21 files changed, 1202 insertions, 157 deletions across 19 commits. Security-relevant changes concentrated in:

| File | Security Surface |
|------|-----------------|
| `src/utils/git-state.ts` | New functions: `commitAllChanges`, `resetToCommit`, `getCurrentCommitSha`, `captureLoopGitContext`, `isValidCommitSha` |
| `src/services/handlers/loop-handler.ts` | Git command orchestration: `setupGitForIteration`, `handleIterationGitOutcome`, `commitAndCaptureDiff`, `resetIterationGitState`, `getResetTargetSha` |
| `src/services/loop-manager.ts` | `gitStartCommitSha` capture at loop creation |
| `src/services/handlers/schedule-handler.ts` | `captureLoopGitContext` integration for scheduled loops |
| `src/implementations/database.ts` | Migration 12: new TEXT columns |
| `src/implementations/loop-repository.ts` | Column mappings with Zod validation |
| `src/core/domain.ts` | New fields: `gitStartCommitSha`, `gitCommitSha`, `preIterationCommitSha` |
| `src/adapters/mcp-adapter.ts` | New fields exposed in MCP responses |

### Command Injection Prevention

All five new git utility functions follow the established security pattern:

1. **`execFile` (not `exec`)** -- All git commands use `execFile` via `execFileAsync`, passing arguments as an array without invoking a shell. This eliminates shell metacharacter injection as a class of vulnerability.

2. **`--` argument separator** -- Every git command that accepts user-influenced arguments terminates option parsing with `--`:
   - `git add -A --` (git-state.ts:339)
   - `git commit -m message --` (git-state.ts:351)
   - `git reset --hard commitSha --` (git-state.ts:407)
   - `git diff --stat fromRef..toRef --` (git-state.ts:237)
   - `git checkout -B branchName [fromRef] --` (git-state.ts:199)

3. **SHA validation in `resetToCommit`** -- The `isValidCommitSha()` function (git-state.ts:373-378) rejects:
   - Empty/too-short/too-long strings
   - Leading dashes (argument injection)
   - `..` sequences (ref range traversal)
   - Non-hex characters (only `[0-9a-f]` accepted)

4. **Ref name validation in `captureGitDiff`** -- `validateGitRefName()` validates both branch names and commit SHAs passed as refs. Commit SHAs (hex-only strings) correctly pass all validation rules. The function blocks control characters, glob characters, `@{` reflog syntax, leading dashes, and `..` sequences.

### Database Security

- **Migration 12** uses static `ALTER TABLE ... ADD COLUMN` DDL with no interpolated values. Safe.
- **Prepared statements** with `?` and `@named` placeholders used throughout `loop-repository.ts` for all new columns. No SQL injection risk.
- **Zod boundary validation** on `LoopRowSchema` and `LoopIterationRowSchema` validates all new nullable string columns (`git_start_commit_sha`, `git_commit_sha`, `pre_iteration_commit_sha`) when reading from SQLite.

### Data Exposure Assessment

New fields exposed through MCP adapter and CLI are git commit SHAs -- opaque 40-character hex strings containing no sensitive information. The CLI truncates SHAs to 8 characters for display (`slice(0, 8)`). No information disclosure concern.

### Destructive Operation Safety

The `resetToCommit` function performs `git reset --hard` + `git clean -fd`:
- Only invoked on failure/discard paths (never on success/keep)
- Protected by `isValidCommitSha()` validation before execution
- Gated by `iteration.preIterationCommitSha` being set (only git-enabled loops)
- Best-effort with try/catch: logs warnings on failure, never throws
- Scoped to the loop's `workingDirectory` via `cwd` option
- `git clean -fd` respects `.gitignore` by default (does not remove ignored files)

### Error Handling and Graceful Degradation

All git operations return `Result<T, AutobeatError>`. Git failures never crash the loop -- all operations are wrapped with warn-level logging and the iteration continues without git tracking. This is the correct pattern for an optional feature.

### Timeout Protection

All git operations use `GIT_TIMEOUT_MS` (30 seconds) timeout, preventing hung git processes from blocking the event loop.

### Prior Review Items Addressed

The previous review (PR #118) raised two MEDIUM items:
1. **Branch guard before destructive git operations** -- Not yet implemented but risk is mitigated by the loop-scoped branch creation flow. Moved to Suggestions.
2. **`validateGitRefName` semantic mismatch for SHA validation** -- The function correctly accepts both refs and SHAs. `resetToCommit` uses the stricter `isValidCommitSha` for its inputs. The dual-validation approach provides adequate defense-in-depth.
