# Security Review Report

**Branch**: feat/orchestrator-mode -> main
**Date**: 2026-03-27
**PR**: #123
**Reviewer Focus**: Security (injection, input validation, secrets, auth, resource exhaustion, file safety, process spawning)

## Issues in Your Changes (BLOCKING)

### HIGH

**Cleanup deletes file paths read from DB without path validation** - `src/implementations/orchestration-repository.ts:232-233`
**Confidence**: 85%
- Problem: `cleanupOldOrchestrations()` reads `state_file_path` values from SQLite rows and passes them directly to `unlink()` without any validation. While state file paths are validated on creation (via `getStateDir()` which resolves to `~/.autobeat/orchestrator-state/`), a corrupted DB row, manual DB edit, or future code path that writes an arbitrary path could cause the cleanup routine to delete unintended files. This is a defense-in-depth gap -- the write path is safe today, but the delete path trusts the DB blindly.
- Fix: Validate that each `state_file_path` is within the expected orchestrator-state directory before calling `unlink()`:
  ```typescript
  import { getStateDir } from '../core/orchestrator-state.js';
  import path from 'path';

  const stateDir = getStateDir();
  const safePaths = filePaths.filter((fp) => {
    const resolved = path.resolve(fp);
    return resolved.startsWith(stateDir + path.sep);
  });
  await Promise.allSettled(safePaths.map((filePath) => unlink(filePath)));
  ```

**Exit condition script accepts `process.argv[2]` override** - `src/core/orchestrator-state.ts:130`
**Confidence**: 82%
- Problem: The generated exit condition script (`check-complete.js`) uses `process.argv[2] || <hardcoded-path>` to determine which state file to read. The orchestration manager at line 154 correctly passes the state file path as a JSON-quoted argument: `node "scriptPath" "stateFilePath"`. However, `check-complete.js` is a shared singleton file in the state directory (overwritten by every orchestration). The `process.argv[2]` override means any caller of this script can redirect it to read an arbitrary file. Combined with the shared-file nature, this creates a subtle attack surface: if an attacker can influence the loop's `exitCondition` string in the DB, they could point the script at a different file to manipulate loop termination (e.g., keeping a loop running indefinitely or terminating it prematurely).
- Fix: Remove the `process.argv[2]` fallback. Since the orchestration manager already passes the state file path as an argument, and the exit condition string includes both the script path and the argument, the fallback is redundant. Generate a per-orchestration script instead of a shared one:
  ```typescript
  // In writeExitConditionScript, make script path unique:
  const scriptPath = path.join(dir, `check-complete-${crypto.randomUUID().substring(0, 8)}.js`);
  const script = `try {
    const s = JSON.parse(require('fs').readFileSync(${JSON.stringify(stateFilePath)}, 'utf8'));
    process.exit(s.status === 'complete' ? 0 : 1);
  } catch { process.exit(1); }
  `;
  ```

### MEDIUM

**Math.random() used for log file name uniqueness** - `src/cli/detach-helpers.ts:61`
**Confidence**: 83%
- Problem: `Math.random().toString(36).substring(2, 8)` generates the uniqueness suffix for detach log file names. `Math.random()` is not cryptographically secure. In this context (file name collision avoidance, not authentication), the risk is low. However, the codebase consistently uses `crypto.randomUUID()` for all other random identifiers (state file names at `orchestration-manager.ts:105`, task/loop/schedule IDs in `domain.ts`). This inconsistency creates a pattern where developers might copy the weaker approach for more sensitive contexts.
- Fix: Use `crypto.randomUUID().substring(0, 8)` for consistency:
  ```typescript
  const suffix = crypto.randomUUID().substring(0, 8);
  ```

**Exit condition script written with overly permissive file permissions** - `src/core/orchestrator-state.ts:134`
**Confidence**: 80%
- Problem: `check-complete.js` is written with mode `0o700` (owner read/write/execute). Since this is a JavaScript file executed via `node check-complete.js` (not direct execution), the execute bit is unnecessary. The write permission also persists after initial creation, allowing modification by any process running as the same user. The state directory correctly uses `0o700` and state files use `0o600`, making this an inconsistency.
- Fix: Use `0o400` (read-only) since the script is only read by `node`:
  ```typescript
  writeFileSync(scriptPath, script, { encoding: 'utf-8', mode: 0o400 });
  ```

**Detach log directory and files created without restrictive permissions** - `src/cli/detach-helpers.ts:44,64`
**Confidence**: 80%
- Problem: `createDetachLogDir()` creates `~/.autobeat/detach-logs/` with `mkdirSync(logDir, { recursive: true })` without specifying a `mode` (defaults to `0o755` after typical umask). `createDetachLogFile()` opens files with `openSync(logFile, 'w')` without specifying a mode (defaults to `0o644`). Orchestration logs could contain goal descriptions, error messages, and filesystem paths. The state file I/O correctly uses `mode: 0o700` for directories and `0o600` for files.
- Fix: Add restrictive permissions:
  ```typescript
  mkdirSync(logDir, { recursive: true, mode: 0o700 });
  // ...
  const logFd = openSync(logFile, 'w', 0o600);
  ```

## Issues in Code You Touched (Should Fix)

### MEDIUM

**Prompt length limit removed from loop validation without alternative bound** - `src/services/loop-manager.ts:55-60` (removed lines)
**Confidence**: 81%
- Problem: The 4000-character prompt length limit in `validateCreateRequest()` was removed entirely to accommodate orchestrator prompts (which are larger due to the system prompt template). The MCP `CreateLoop` schema still enforces a limit at the MCP boundary, but any code path calling `loopService.createLoop()` directly (e.g., `OrchestrationManagerService`, `ScheduleHandler`) now has no prompt size validation. The orchestrator prompt builder produces prompts of roughly 1500-2500 characters depending on the goal length, and the goal itself is capped at 8000 characters, so the total could reach ~10,000 characters.
- Fix: Replace the hard 4000-char limit with a higher but still bounded limit (e.g., 16000) to prevent unbounded prompt sizes from any caller:
  ```typescript
  if (request.prompt && request.prompt.length > 16000) {
    return err(
      new AutobeatError(ErrorCode.INVALID_INPUT, 'prompt must not exceed 16000 characters', {
        field: 'prompt',
        length: request.prompt.length,
      }),
    );
  }
  ```

## Pre-existing Issues (Not Blocking)

No critical pre-existing security issues found in the files touched by this PR.

## Suggestions (Lower Confidence)

- **Goal text interpolated into orchestrator prompt without content sanitization** - `src/services/orchestrator-prompt.ts:85` (Confidence: 65%) -- The user-provided `goal` string is interpolated directly into the prompt template sent to the orchestrator agent. While this is not a traditional injection vector (it becomes part of an LLM prompt, not a shell command or SQL query), adversarial goals could influence agent behavior. The 8000-char limit in `orchestration-manager.ts:67` mitigates length but not content.

- **Detached process inherits full environment** - `src/cli/detach-helpers.ts:83` (Confidence: 60%) -- `spawnDetachedProcess` passes `process.env` directly to child processes. This includes all environment variables, which may contain sensitive values (API keys, tokens). This is consistent with the existing `run.ts` pattern and is intentional (the child process needs the same configuration).

- **OrchestratorId input not format-validated at boundaries** - `src/adapters/mcp-adapter.ts`, `src/cli/commands/orchestrate.ts` (Confidence: 62%) -- The `orchestratorId` from user input is accepted as any string and branded via `OrchestratorId()` without format validation (e.g., checking it matches `/^orchestrator-/`). The lookup returns not-found for invalid IDs (safe), but format validation would tighten the boundary. This is consistent with how `TaskId`, `LoopId`, etc. are handled throughout the codebase.

## Pitfall Check

Reviewed `.memory/knowledge/pitfalls.md` for overlap with changed files:

| Pitfall | Overlap with PR | Status |
|---------|----------------|--------|
| PF-001: TaskFailed git reset bypass | No overlap -- loop-handler.ts changes are structural (DI refactor), not logic | N/A |
| PF-002: startNextIteration complexity | No overlap -- already resolved | N/A |
| PF-003: recordAndContinue nesting | No overlap -- already resolved | N/A |
| PF-004: Crash recovery git reset | No overlap -- already resolved | N/A |
| PF-005: getResetTargetSha O(n) | No overlap -- not addressed in this PR | N/A |
| PF-006: commitAllChanges sequential spawns | No overlap -- not addressed in this PR | N/A |

No known pitfalls are being reintroduced by this PR.

## Resolved Issues from Previous Review

The following issues from the initial security review have been fixed:

1. **Math.random() for state file naming** (was HIGH) -- Fixed: now uses `crypto.randomUUID().substring(0, 8)` at `orchestration-manager.ts:105`
2. **Unquoted shell arguments in exit condition** (was HIGH) -- Fixed: now uses `JSON.stringify()` for both script path and state file path at `orchestration-manager.ts:154`
3. **readStateFile lacked Zod schema validation** (was MEDIUM) -- Fixed: now uses `OrchestratorStateFileSchema.safeParse()` with full Zod validation at `orchestrator-state.ts:111`

## Security Positives

The following security practices in this PR are well-implemented:

1. **Parameterized SQL queries**: All DB operations in `orchestration-repository.ts` use prepared statements with parameter binding. No string interpolation in SQL.
2. **Zod schema validation at all boundaries**: `OrchestrationRowSchema` validates DB rows on read; `OrchestratorStateFileSchema` validates state file content; MCP schemas (`CreateOrchestratorSchema`, etc.) validate all tool inputs.
3. **Path validation with `validatePath()`**: Working directory inputs are validated in both CLI (`orchestrate.ts:380`) and MCP adapter. The utility resolves symlinks and checks path containment.
4. **State directory permissions**: `mkdirSync(stateDir, { recursive: true, mode: 0o700 })` restricts access to owner only. State files use `0o600`.
5. **Atomic file writes**: State file writes use temp-file + rename pattern to prevent corruption on crash.
6. **Bounded numeric inputs**: All numeric parameters (maxDepth 1-10, maxWorkers 1-20, maxIterations 1-200) are bounded in both CLI parsing and Zod schemas.
7. **JSON.stringify for shell argument escaping**: Exit condition construction uses `JSON.stringify()` for path arguments, preventing shell injection.
8. **Immutable domain objects**: All orchestration domain objects are `Object.freeze()`'d.
9. **Resource cleanup with try/finally**: `spawnDetachedProcess` closes file descriptors in all code paths via try/finally.
10. **Defense-in-depth state file path validation**: `orchestrate.ts:379-384` validates the state file path with `validatePath()` before reading, even though it comes from the DB.

## Summary

| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 2 | 3 | 0 |
| Should Fix | 0 | 0 | 1 | 0 |
| Pre-existing | 0 | 0 | 0 | 0 |

**Security Score**: 8/10
**Recommendation**: CHANGES_REQUESTED

The PR demonstrates strong security fundamentals: parameterized queries, Zod validation at all boundaries, path traversal prevention, bounded inputs, atomic file operations, and proper shell argument quoting. Three issues from the initial review have already been resolved. The remaining findings are defense-in-depth hardening: validating file paths before cleanup deletion, eliminating the shared exit condition script's `argv[2]` override, tightening file permissions, and restoring a prompt length bound. None represent immediately exploitable vulnerabilities in the current single-user local CLI architecture, but they should be addressed to maintain the codebase's high security baseline.
