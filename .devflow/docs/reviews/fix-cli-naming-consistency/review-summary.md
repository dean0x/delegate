# Code Review Summary

**Branch**: fix/cli-naming-consistency -> main
**Date**: 2026-03-24
**Commit**: c2537f8
**PR**: #117

## Merge Recommendation: CHANGES_REQUESTED

The PR is a well-executed mechanical naming consistency fix across 16 files with comprehensive test updates. All nine reviewers agree on one blocking issue: **README.md line 81 still references `GetSchedule`** while the actual MCP tool was renamed to `ScheduleStatus` everywhere else (source, tests, all docs). Once this single line is fixed, this is a clean APPROVED.

---

## Issue Summary

| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| **Blocking** | 0 | 4 | 1 | 0 |
| **Should Fix** | 0 | 0 | 1 | 0 |
| **Pre-existing** | 0 | 0 | 2 | 0 |

---

## Blocking Issues (Must Fix Before Merge)

### HIGH (4/4 reviewers flagged)

**Missed rename: `GetSchedule` in README.md MCP tools table** — `README.md:81`
- **Confidence**: 97% (security, architecture, consistency, regression, typescript, documentation all flagged)
- **Problem**: The MCP tools table in README.md line 81 still references `GetSchedule` (both the tool name and the example call `GetSchedule({ scheduleId })`). Every other reference across source, tests, docs (CHANGELOG, CLAUDE.md, FEATURES.md, release notes v0.4.0/v0.6.0/v0.7.0) was correctly renamed to `ScheduleStatus`, but this single table entry was missed.
- **Impact**: Users consulting the README (the most visible documentation surface) will call `GetSchedule` which no longer exists as an MCP tool, causing tool-not-found errors at runtime.
- **Fix**: Update README.md line 81:
  ```markdown
  # Change from:
  | **GetSchedule** | Get schedule details and execution history | `GetSchedule({ scheduleId })` |

  # To:
  | **ScheduleStatus** | Get schedule details and execution history | `ScheduleStatus({ scheduleId })` |
  ```

### MEDIUM (1/9 reviewers flagged)

**Missing mutual exclusion test for `--minimize`/`--maximize` in schedule `--loop` context** — `tests/unit/cli.test.ts`
- **Confidence**: 85% (tests)
- **Problem**: The `parseLoopCreateArgs` tests include a test for rejecting both `--minimize` and `--maximize` simultaneously, but the `CLI - Schedule --loop flag` describe block has no corresponding test. Production code in `parseScheduleLoopFlags()` (src/cli/commands/schedule.ts:139-141) does validate this case, but it is untested for the schedule path.
- **Impact**: The mutual exclusion validation in the schedule parser could regress without test coverage.
- **Fix**: Add test to the `CLI - Schedule --loop flag` describe block:
  ```typescript
  it('should reject --loop with both --minimize and --maximize', () => {
    const result = parseScheduleCreateArgs([
      '--loop', '--eval', 'echo 42', '--minimize', '--maximize', '--cron', '0 9 * * *',
    ]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain('Cannot specify both --minimize and --maximize');
  });
  ```

---

## Should Fix (Lower Blocking Priority)

### MEDIUM (1/9 reviewers flagged)

**CLAUDE.md MCP tools list adds 3 tools not in README table** — `CLAUDE.md:141`, `README.md:70-89`
- **Confidence**: 82% (documentation)
- **Problem**: This PR updated CLAUDE.md to add `PauseLoop`, `ResumeLoop`, `ScheduleLoop` to the MCP tools list (valid tools that exist in codebase since v0.8.0). However, the README MCP tools table -- also touched in this PR -- still omits these three tools. Both documents were modified in this PR, creating a consistency gap: CLAUDE.md lists 19 tools, README.md lists 16.
- **Impact**: The two canonical tool lists now disagree, which confuses users about which tools are available.
- **Fix**: Add the three missing tools to the README MCP tools table after the `CancelLoop` row:
  ```markdown
  | **PauseLoop** | Pause a running loop (resumable) | `PauseLoop({ loopId })` |
  | **ResumeLoop** | Resume a paused loop | `ResumeLoop({ loopId })` |
  | **ScheduleLoop** | Schedule a recurring loop | `ScheduleLoop({ loopId, cronExpression: "..." })` |
  ```

---

## Pre-existing Issues (Informational Only)

### MEDIUM (2/9 reviewers flagged)

**Flag-skipping guard clause has growing boolean complexity** — `src/cli/commands/schedule.ts:267`
- **Confidence**: 82% (complexity)
- **Problem**: The condition that determines which flags are boolean (don't consume next arg) is now a 3-term negation chain: `arg !== '--checkpoint' && arg !== '--minimize' && arg !== '--maximize'`. This is an exclusion list within a larger inclusion list (11 flags). When new boolean flags are added, developers must update both the outer `if` (to recognize the flag) and the inner `if` (to exclude it from value consumption). This dual-update requirement is a maintenance trap.
- **Recommendation**: Consider inverting logic to use an allowlist of value-consuming flags instead (pre-existing code pattern, not blocking this PR).

**Duplicated direction-flag validation logic across two parsers** — `src/cli/commands/loop.ts:145-157`, `src/cli/commands/schedule.ts:138-146`
- **Confidence**: 80% (complexity)
- **Problem**: The `--minimize`/`--maximize` mutual exclusion check and ternary resolution is duplicated nearly verbatim in both parsers. The subsequent direction strategy validation is also duplicated across both files.
- **Impact**: If direction semantics change, two files must be updated in lockstep.
- **Recommendation**: Extract shared `resolveDirectionFlags()` and `validateDirectionForStrategy()` helper functions (pre-existing maintenance opportunity, not blocking this PR).

---

## Analysis Summary

### What's Clean ✓

1. **Security**: Zero security impact. Boolean flag pattern (`--minimize`/`--maximize`) is actually a minor improvement over prior `--direction <value>` (eliminates free-form string input requiring validation). All Zod validation schemas retained. Input validation at boundaries intact. No new attack surface.

2. **Architecture**: Layering preserved. Separation of concerns intact. `--checkpoint` correctly maps to internal `freshContext` field. Parallel structure maintained across both parsers. Test coverage follows renames consistently. Single blocking issue: missed README reference (not architectural).

3. **Performance**: Mechanical rename with zero performance impact. Boolean flag pattern is net-neutral (parser loop iterates same argument count). No new database queries, N+1 patterns, unbounded iterations, or memory allocations. Read-only context optimization for `status` subcommand correctly preserved.

4. **Consistency**: Three renames applied thoroughly across source code, tests, and 8 documentation files (CHANGELOG, CLAUDE.md, README, FEATURES.md, ROADMAP.md, and 3 release notes v0.4.0/v0.6.0/v0.7.0). All 16 changed files verified. Only exception: one stale README.md reference (blocking issue above).

5. **Regression**: Thorough rename across 16 files with good test coverage. No exports removed without deprecation (internal method names preserved). Return types unchanged. Default values unchanged. Side effects preserved. Migration complete except for single README reference. CLI options correctly renamed. Internal service method names (`getSchedule`, `scheduleService.getSchedule`) preserved (only external surface renamed).

6. **Tests**: Mechanical rename consistency thorough with zero stale references. New test added for `--minimize` + `--maximize` mutual exclusion. Test-production parity maintained. Test helper functions renamed correctly. One minor gap: schedule `--loop` parser lacks parallel mutual exclusion test (blocking medium issue above).

7. **TypeScript**: All changes maintain strong typing. `--direction` value flag (accepting string, requiring runtime validation) replaced with `--minimize`/`--maximize` boolean flags (improving type safety). Discriminated unions remain correctly structured. Exhaustive checks valid. Zero `any` types. No unsafe assertions. Test coverage includes new mutual exclusion case. All renames applied consistently except single README reference (blocking issue).

8. **Documentation**: All 8 documentation files updated for 3 naming changes. Help.ts output brought into alignment. CHANGELOG entries and release notes internally consistent. Single blocking issue: missed README reference. Single should-fix issue: README tool list parity with CLAUDE.md (3 new loop tools).

9. **Complexity**: Well-executed mechanical rename. New mutual exclusion validation and test coverage added correctly. One blocking medium issue: flag-skipping guard has growing boolean complexity (addressed above). Two pre-existing opportunities: duplication across parsers and long `parseScheduleCreateArgs` function.

---

## Action Plan

1. **CRITICAL (Fix Before Merge)**
   - Update README.md line 81: `GetSchedule` → `ScheduleStatus` in MCP tools table
   - Add missing mutual exclusion test for `--minimize`/`--maximize` in schedule `--loop` parser

2. **HIGH PRIORITY (Fix Before Merge)**
   - Add three missing MCP tools to README MCP tools table: `PauseLoop`, `ResumeLoop`, `ScheduleLoop`

3. **INFORMATIONAL (Future Tech Debt)**
   - Consider inverting flag-skipping logic in `parseScheduleCreateArgs` to use allowlist pattern
   - Extract shared `resolveDirectionFlags()` and `validateDirectionForStrategy()` utilities
   - Consider further extraction of "Infer type from --cron/--at" and "Loop mode" validation in `parseScheduleCreateArgs`

---

## Confidence Levels

All four reviewers who flagged the README.md issue (security, architecture, consistency, regression, typescript, documentation) reported 95-98% confidence. The missed `GetSchedule` reference is unambiguous: it exists in the file and conflicts with the renamed tool.

The test coverage gap (mutual exclusion in schedule path) has 85% confidence and is actionable: test case exists for the loop path, just needs mirroring for the schedule path.

The tool list parity issue has 82% confidence: CLAUDE.md was updated to add 3 tools, README was touched but not updated to match.
