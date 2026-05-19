# Security Review Report

**Branch**: feat/176-tmux-abstraction-layer -> main
**Date**: 2026-05-17
**Diff range**: 1bec153be5..40f9537 (incremental, 6 commits)

## Issues in Your Changes (BLOCKING)

### MEDIUM

**cleanup() lacks taskId/sessionsDir validation — path traversal risk** - `src/implementations/tmux/tmux-hooks.ts:188-191`
**Confidence**: 85%
- Problem: `generateWrapper()` validates `taskId` against `TASK_ID_REGEX` and `sessionsDir` against `SAFE_PATH_REGEX` before embedding them in scripts. However, `cleanup()` accepts the same `taskId` and `sessionsDir` parameters and passes them directly to `path.join()` and then `rmSync(..., { recursive: true, force: true })` without any validation. If a caller passes a crafted `taskId` (e.g. `../../etc`) to `cleanup()` directly (not through the spawn flow), the `rmSync` call could delete arbitrary directories.
- Impact: The current call sites (`destroy()`, `triggerExit()`, `dispose()`) use values that were validated during `spawn()`. However, `cleanup()` is a public interface method on `TmuxHooks` and could be called directly by future callers without the `spawn()` validation gate. Defense-in-depth dictates validating at each trust boundary.
- Fix: Apply the same validation in `cleanup()`:
```typescript
cleanup(taskId: string, sessionsDir: string): Result<void, AutobeatError> {
    if (!TASK_ID_REGEX.test(taskId)) {
      return err(tmuxHookFailed('cleanup', `invalid taskId: ${taskId}`, { taskId }));
    }
    if (!SAFE_PATH_REGEX.test(sessionsDir)) {
      return err(tmuxHookFailed('cleanup', `unsafe sessionsDir path: ${sessionsDir}`, { taskId, sessionsDir }));
    }
    const sessionDir = path.join(sessionsDir, taskId);
    // ... existing rmSync logic
}
```

## Issues in Code You Touched (Should Fix)

### MEDIUM

**agentCommand and agentArgs are embedded in wrapper script without validation or quoting** - `src/implementations/tmux/tmux-hooks.ts:105`
**Confidence**: 82%
- Problem: `config.agentCommand` and `config.agentArgs` are interpolated directly into the generated bash script at line 105 (`${config.agentCommand} ${agentArgs} 2>&1`). The JSDoc comment at line 12 explicitly acknowledges this: "callers are responsible for ensuring these values come from trusted configuration, not user input." While this is documented, the `generateWrapper` method now validates `taskId` and `sessionsDir` but does NOT validate `agentCommand` or `agentArgs`. If a caller passes user-controlled data for these fields, arbitrary command execution occurs inside the tmux session.
- Impact: This is mitigated by the trust model (agentCommand comes from agent configuration, not user input) and the documented trust boundary. However, with `taskId` and `sessionsDir` now validated, the asymmetry creates an incomplete trust boundary. A future developer seeing the validation on `taskId`/`sessionsDir` might reasonably assume all inputs are validated.
- Fix: Add an allowlist check for `agentCommand` or at minimum a `SAFE_PATH_REGEX` check:
```typescript
if (!SAFE_PATH_REGEX.test(config.agentCommand)) {
  return err(tmuxHookFailed('generateWrapper', `unsafe agentCommand: ${config.agentCommand}`, {
    taskId: config.taskId,
  }));
}
```
Alternatively, document the trust assumption more prominently (e.g., as a `@security` JSDoc tag on the `WrapperConfig.agentCommand` field).

## Pre-existing Issues (Not Blocking)

### MEDIUM

**SAFE_PATH_REGEX allows relative paths and dot components** - `src/implementations/tmux/tmux-hooks.ts:35`
**Confidence**: 80%
- Problem: `SAFE_PATH_REGEX` is `/^[a-zA-Z0-9/_.\-]+$/`. While it blocks shell metacharacters, it allows patterns like `../../higher` or `./relative/path` because dots and slashes are allowed. The `sessionsDir` could contain `..` path traversal components. In practice, `sessionsDir` typically comes from application configuration (an absolute path), but the regex does not enforce that the path is absolute or canonical.
- Fix: Strengthen to require an absolute path and reject `..` segments:
```typescript
const SAFE_PATH_REGEX = /^\/[a-zA-Z0-9/_.\-]+$/;
// And additionally check:
if (config.sessionsDir.includes('..')) {
  return err(tmuxHookFailed('generateWrapper', `sessionsDir must not contain ".." segments`, { ... }));
}
```

## Suggestions (Lower Confidence)

- **Communication block uses double-quoted `$PAYLOAD`** - `src/implementations/tmux/tmux-hooks.ts:61` (Confidence: 65%) -- The `tmux send-keys -t "${t}" -l "$PAYLOAD"` line uses double quotes around `$PAYLOAD`. While `$PAYLOAD` comes from `cat "$RESULT_FILE"` (file content), if the JSON content itself contained shell-significant characters, double-quote expansion could misbehave. Consider using single quotes with `escapeSingleQuoted` for `$PAYLOAD`, or note this is intentional since `-l` makes tmux treat it literally.

- **TASK_ID_REGEX permits leading digits** - `src/implementations/tmux/types.ts:228` (Confidence: 60%) -- The regex `^[a-z0-9][a-z0-9_-]*$` allows task IDs starting with a digit (e.g., `0-task`). This is likely fine for the current use case, but task IDs starting with a digit could conflict with shell arithmetic expansion or positional parameters in edge cases within the generated script. The current single-quoting of `SESSIONS_DIR` mitigates this.

## Summary

| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 0 | 1 | 0 |
| Should Fix | 0 | 0 | 1 | 0 |
| Pre-existing | 0 | 0 | 1 | 0 |

**Security Score**: 8/10
**Recommendation**: APPROVED_WITH_CONDITIONS

### Assessment

This incremental diff represents a substantial security improvement over the prior state. The 6 commits addressed the most critical shell injection vectors identified in previous reviews:

1. **SESSIONS_DIR quoting fixed** (commit 7c3d692): Changed from double quotes (`"${sessionDir}"`) to single quotes (`'${sessionDir}'`), preventing variable expansion and command substitution in the generated wrapper script.
2. **taskId validation added** (commit 7c3d692): `TASK_ID_REGEX` prevents shell metacharacters in task IDs before they are embedded in generated scripts.
3. **sessionsDir path validation added** (commit 7c3d692): `SAFE_PATH_REGEX` blocks shell-significant characters in the sessions base directory.
4. **escapeSingleQuoted consolidated** (commit 4bfb5b3): All shell quoting now uses a single `escapeSingleQuoted()` function (replacing an inline `.replace()` for cwd escaping), reducing the risk of inconsistent escaping.
5. **Test coverage for injection vectors**: Tests now cover metacharacter taskIds (`$(evil)`), path traversal taskIds (`../../etc/passwd`), and single-quote injection in sessionsDir.

The remaining findings are defense-in-depth improvements (validation in `cleanup()`, strengthening `SAFE_PATH_REGEX` to reject relative paths) rather than exploitable vulnerabilities. The trust boundary for `agentCommand`/`agentArgs` is documented but asymmetric with the new validation on other fields.

**Conditions for approval**: Fix the BLOCKING issue (add validation to `cleanup()`) before merge. The SHOULD-FIX items can be addressed in this PR or tracked separately.
