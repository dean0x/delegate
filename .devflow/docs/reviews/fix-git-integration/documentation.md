# Documentation Review Report

**Branch**: fix-git-integration -> main
**Date**: 2026-03-25
**PR**: #120

## Issues in Your Changes (BLOCKING)

### MEDIUM

**Release notes misidentify reset target as `preIterationCommitSha`** - `docs/releases/RELEASE_NOTES_v0.8.1.md:15`
**Confidence**: 90%
- Problem: The release notes state "Failed or discarded iterations are reset to the appropriate target commit (`preIterationCommitSha`)" but this is inaccurate. The actual reset target is determined by `getResetTargetSha()` in `loop-handler.ts:1224-1238`, which resets to either: (1) the best iteration's `gitCommitSha` for optimize strategy, or (2) `loop.gitStartCommitSha` as fallback. The `preIterationCommitSha` field is only used as a guard condition (skip git reset if absent) and as the "from" ref for diff capture -- it is never the reset target itself.
- Fix: Replace the parenthetical with a description of the actual reset logic:
  ```markdown
  - **Full revert on failure**: Failed or discarded iterations are reset -- retry loops revert to `gitStartCommitSha` (clean slate), optimize loops revert to the best iteration's commit (or `gitStartCommitSha` if no best iteration exists)
  ```

## Issues in Code You Touched (Should Fix)

### MEDIUM

**CLAUDE.md database section does not mention migration 12 or new git columns** - `CLAUDE.md:129-130`
**Confidence**: 85%
- Problem: The Database section in CLAUDE.md documents `loops` table (migration v10) and `loop_iterations` table (migration v10) but does not mention migration 12 or the three new columns (`git_start_commit_sha`, `git_commit_sha`, `pre_iteration_commit_sha`). This PR adds migration 12 and the CHANGELOG, release notes, and ROADMAP all document it, but the primary project guidance file (CLAUDE.md) is not updated. Future contributors relying on CLAUDE.md as the source of truth for schema will miss these columns.
- Fix: Update the database entries in CLAUDE.md:
  ```markdown
  - `loops` table: loop definitions, strategy, exit condition, iteration state, git commit tracking (migrations v10, v12)
  - `loop_iterations` table: per-iteration execution records with scores, results, and git SHA tracking (migrations v10, v12)
  ```

### MEDIUM

**CLAUDE.md File Locations table missing `git-state.ts`** - `CLAUDE.md:147-166`
**Confidence**: 82%
- Problem: The File Locations table lists utilities like `src/utils/cron.ts` but does not include `src/utils/git-state.ts`, which now contains 7 exported functions (`captureGitState`, `captureGitDiff`, `createAndCheckoutBranch`, `getCurrentCommitSha`, `commitAllChanges`, `resetToCommit`, `captureLoopGitContext`) plus the `LoopGitContext` interface. This PR significantly expanded this file (165 new lines of exported logic). While this was absent before, the file's importance has grown substantially with this PR, and it is a natural companion to `cron.ts` in the table.
- Fix: Add to the File Locations table:
  ```markdown
  | Git utilities | `src/utils/git-state.ts` |
  ```

## Pre-existing Issues (Not Blocking)

### MEDIUM

**FEATURES.md has no v0.8.0 section** - `docs/FEATURES.md`
**Confidence**: 85%
- Problem: FEATURES.md documents "What's New" sections up through v0.6.0 and "Capability Summary" sections referencing v0.7.0, but has no v0.8.0 section covering Loop Pause/Resume, Scheduled Loops, or Git Integration. The v0.8.1 changes in this PR build on undocumented v0.8.0 features. This was a pre-existing gap before this PR.
- Fix: Add a v0.8.0 section to FEATURES.md covering the three major features. Should be done in a separate PR.

### LOW

**`getCurrentCommitSha()` JSDoc claims "full 40-character hex SHA" but implementation does not validate length** - `src/utils/git-state.ts:260-264`
**Confidence**: 80%
- Problem: The JSDoc says "Returns the full 40-character hex SHA of the current HEAD commit" but the function just trims stdout with no validation. While `git rev-parse HEAD` always returns a 40-char SHA in practice, the documentation promises a stricter contract than the code enforces.
- Fix: Either add a length check or soften the JSDoc to "Returns the hex SHA of the current HEAD commit."

## Suggestions (Lower Confidence)

- **v0.8.0 description in CHANGELOG now says "(Corrected in v0.8.1)" which may confuse readers** - `CHANGELOG.md:29` (Confidence: 65%) -- Consider rewording to "(see v0.8.1 for corrections)" or simply describing the original feature without the parenthetical, since the v0.8.1 entry directly above already explains the fix.

- **ROADMAP v0.8.1 domain model description uses arrow notation that may be unclear** - `docs/ROADMAP.md:134` (Confidence: 60%) -- The line "`gitBaseBranch` -> `gitStartCommitSha`, `gitBranch` on iteration -> `gitCommitSha`" uses arrows that could be misread as "field A flows to field B" rather than "field A replaced by field B". Consider using "replaced by" language instead.

## Summary

| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 0 | 1 | 0 |
| Should Fix | 0 | 0 | 2 | 0 |
| Pre-existing | 0 | 0 | 1 | 1 |

**Documentation Score**: 7/10
**Recommendation**: APPROVED_WITH_CONDITIONS

The documentation for this PR is generally strong. The CHANGELOG, release notes, ROADMAP, and inline code comments are well-written, comprehensive, and show clear attention to explaining the "why" behind the design change. JSDoc on new functions is thorough with proper `@param` and `@returns` annotations. The domain model field comments clearly mark legacy vs. new fields with version tags. The v0.8.0 release notes subtitle has been corrected (previously flagged). The v0.8.1 release notes file now exists with comprehensive content.

The one blocking issue is a factual misstatement in the release notes about which SHA is used as the reset target (`preIterationCommitSha` is cited but the code actually uses `gitStartCommitSha` or the best iteration's `gitCommitSha`). The two should-fix items keep the project's primary guidance file (CLAUDE.md) in sync with the expanded schema and utility surface.
