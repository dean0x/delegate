# Security Review Report

**Branch**: fix/cli-naming-consistency -> main
**Date**: 2026-03-24
**PR**: #117

## Scope

Reviewed all 16 changed files across 1 commit (`c2537f8`). The PR performs three mechanical CLI naming renames:
1. `--direction minimize|maximize` replaced by `--minimize` / `--maximize` boolean flags
2. `--continue-context` replaced by `--checkpoint`
3. `get` subcommand replaced by `status` (for both `schedule` and `loop`)

Additionally, `GetSchedule` MCP tool renamed to `ScheduleStatus`, and all documentation updated.

## Security Analysis

### Input Validation Review

The changes were reviewed against all OWASP categories and the security patterns skill. Specific areas examined:

1. **Injection (A03)**: No new user inputs are introduced. The `--minimize`/`--maximize` flags are boolean (no value consumed), reducing the attack surface compared to the prior `--direction <value>` which accepted arbitrary string input. The old code validated the value against a whitelist (`minimize`/`maximize`); the new code eliminates the need for that validation entirely by using discrete boolean flags. This is a security improvement.

2. **Input Validation at Boundaries**: The Zod schema `ScheduleStatusSchema` (renamed from `GetScheduleSchema`) retains all existing validation constraints (`z.string()`, `z.boolean().optional().default(false)`, `z.number().min(1).max(100).optional().default(10)`). No validation was weakened or removed.

3. **Conflicting Flags**: New mutual exclusion validation was added -- `if (minimizeFlag && maximizeFlag) return err(...)` -- in both `parseLoopCreateArgs()` and `parseScheduleLoopFlags()`. This is a correctness improvement that also prevents ambiguous input.

4. **Flag Skip Logic**: The schedule parser's loop-flag skip section (`parseScheduleCreateArgs`) was updated to treat `--minimize` and `--maximize` as boolean flags (no value consumption), matching `--checkpoint`. The guard `arg !== '--checkpoint' && arg !== '--minimize' && arg !== '--maximize'` correctly prevents these boolean flags from consuming the next positional argument. No parsing confusion or argument injection vector.

5. **Hardcoded Secrets (A02)**: No secrets, API keys, or credentials introduced.

6. **Auth/Access Control (A01)**: No changes to authentication, authorization, or access control patterns.

7. **Command Injection**: The `--eval` and `--until` flags (which accept shell commands) are unchanged. No new shell command execution paths introduced.

8. **MCP Tool Routing**: The `case 'ScheduleStatus'` routing in `mcp-adapter.ts` correctly maps to `handleScheduleStatus()` which uses the renamed `ScheduleStatusSchema` for input validation via Zod `safeParse`. The validation chain is intact.

## Issues in Your Changes (BLOCKING)

### CRITICAL
None.

### HIGH
None.

## Issues in Code You Touched (Should Fix)

None.

## Pre-existing Issues (Not Blocking)

None identified at CRITICAL severity in the changed file regions.

## Suggestions (Lower Confidence)

None. The changes are purely mechanical renames with no security-relevant behavioral modifications.

## Summary

| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 0 | 0 | 0 |
| Should Fix | 0 | 0 | 0 | 0 |
| Pre-existing | 0 | 0 | 0 | 0 |

**Security Score**: 9/10
**Recommendation**: APPROVED

### Rationale

This PR is a clean mechanical rename with zero security impact. The boolean flag pattern (`--minimize`/`--maximize`) is actually a minor security improvement over the previous `--direction <value>` pattern, as it eliminates a free-form string input that required validation. All Zod validation schemas remain intact. All old references (`GetSchedule`, `schedule get`, `loop get`, `--direction`, `--continue-context`) have been fully removed from source and test files with no orphaned remnants. No new attack surface introduced.
