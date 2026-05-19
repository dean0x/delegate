# Architecture Review Report

**Branch**: fix/cli-naming-consistency -> main
**Date**: 2026-03-24
**PR**: #117

## Issues in Your Changes (BLOCKING)

### HIGH

**Incomplete MCP tool rename in README.md** - `README.md:81`
**Confidence**: 95%
- Problem: The MCP tools table in README.md still references `GetSchedule` (both tool name and usage example `GetSchedule({ scheduleId })`), while the actual MCP adapter was renamed to `ScheduleStatus`. This creates a documentation-to-implementation mismatch -- any MCP client following the README will call `GetSchedule`, which no longer exists.
- Impact: External consumers referencing the README MCP tools table will get tool-not-found errors. This undermines the purpose of the naming consistency fix.
- Fix: Update README.md line 81:
```markdown
# Before:
| **GetSchedule** | Get schedule details and execution history | `GetSchedule({ scheduleId })` |

# After:
| **ScheduleStatus** | Get schedule details and execution history | `ScheduleStatus({ scheduleId })` |
```

## Issues in Code You Touched (Should Fix)

No issues found.

## Pre-existing Issues (Not Blocking)

No issues found.

## Suggestions (Lower Confidence)

- **Semantic overlap between `--checkpoint` and `--continue`** - `src/cli/commands/help.ts:37,90` (Confidence: 65%) -- The task command uses `-c, --continue TASK_ID` for checkpoint continuation from dependencies, while the loop command introduces `--checkpoint` to mean "continue from checkpoint between iterations." Both concepts involve checkpoints but use different flag names (`--continue` vs `--checkpoint`) and different semantics (inter-task vs intra-loop). This is a minor discoverability concern, not a correctness issue.

- **MCP tool rename is a breaking API change** - `src/adapters/mcp-adapter.ts:356` (Confidence: 70%) -- Renaming `GetSchedule` to `ScheduleStatus` is a breaking change for any existing MCP client that calls this tool. If there are external consumers, a deprecation period or alias could smooth the transition. This may be intentional given pre-1.0 status.

## Summary
| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 1 | 0 | - |
| Should Fix | - | 0 | 0 | - |
| Pre-existing | - | - | 0 | 0 |

**Architecture Score**: 9/10
**Recommendation**: CHANGES_REQUESTED

### Rationale

The PR is architecturally clean. All three renames are mechanical surface-level changes that preserve the existing architecture:

1. **Layering preserved**: The CLI `status` subcommand correctly uses `withReadOnlyContext` (lightweight query path), matching the existing pattern for read-only operations. Mutation commands continue to use `withServices` (full bootstrap). No layering violations introduced.

2. **Separation of concerns intact**: The `--minimize`/`--maximize` boolean flags replace the `--direction <value>` pattern without touching the internal `evalDirection` field -- the CLI parsing layer correctly maps external flags to internal domain types.

3. **`--checkpoint` correctly maps to `freshContext: !continueContext`**: The internal `freshContext` field in `ParsedLoopBaseArgs` is unchanged. The CLI flag is a presentation concern only.

4. **Parallel structure maintained**: Both `parseLoopCreateArgs()` and `parseScheduleLoopFlags()` receive the same treatment (minimize/maximize flags, checkpoint flag, direction validation with mutual exclusion). The `schedule.ts` parser correctly skips boolean flags (`--minimize`, `--maximize`, `--checkpoint`) when advancing past loop-specific args.

5. **Test coverage follows the renames**: All test helpers, mock fields, and describe blocks are updated consistently.

The single blocking issue is a missed `GetSchedule` reference in README.md's MCP tools table, which is a straightforward fix.
