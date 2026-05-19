# Security Review Report

**Branch**: feat/176-tmux-abstraction-layer -> main
**Date**: 2026-05-17

## Issues in Your Changes (BLOCKING)

### HIGH

**[P1] agentCommand embedded in generated bash script without validation or escaping** - `src/implementations/tmux/tmux-hooks.ts:123`
**Confidence**: 90%
- **Problem**: `config.agentCommand` is interpolated directly into the generated wrapper bash script on line 123 (`${config.agentCommand} ${agentArgs} 2>&1 | ...`) with zero validation or escaping. While `taskId` is validated against `TASK_ID_REGEX` and `sessionsDir` against `SAFE_PATH_REGEX`, the `agentCommand` field has no equivalent guard. A value containing shell metacharacters (`;`, `$(...)`, backticks, `&&`) would execute arbitrary code.
- **Attack vector**: If any future caller passes user-influenced data as `config.command` (which flows to `agentCommand` via `tmux-connector.ts:156`), the attacker achieves arbitrary code execution inside the tmux session. The header comment (lines 11-13) states "callers are responsible" but provides no enforcement. Defense-in-depth requires the boundary to validate, not trust upstream.
- **Current mitigation**: Today `agentArgs` is hardcoded to `[]` (connector line 157), and `agentCommand` comes from internal agent adapter configuration. But the `WrapperConfig` interface accepts an arbitrary `string` with no type narrowing or runtime check.
- **Suggestion**: Add a validation regex for `agentCommand` (e.g., `SAFE_COMMAND_REGEX` allowing alphanumeric, hyphens, underscores, forward slashes, and dots) in `generateWrapper()`, mirroring the pattern used for `taskId` and `sessionsDir`. Alternatively, always single-quote the command and escape it with `escapeSingleQuoted()`:

```typescript
// In buildWrapperScript():
const escapedCmd = `'${config.agentCommand.replace(/'/g, "'\\''")}'`;
const escapedArgs = config.agentArgs.map(a => `'${a.replace(/'/g, "'\\''")}'`).join(' ');
// ...
${escapedCmd} ${escapedArgs} 2>&1 | while IFS= read -r line; do
```

Or add validation in `generateWrapper()`:

```typescript
const SAFE_COMMAND_REGEX = /^[a-zA-Z0-9/_.\-]+$/;
if (!SAFE_COMMAND_REGEX.test(config.agentCommand)) {
  return err(tmuxHookFailed('generateWrapper', `unsafe agentCommand: ${config.agentCommand}`, {
    taskId: config.taskId,
  }));
}
```

---

**[P1] agentArgs join without escaping allows argument injection** - `src/implementations/tmux/tmux-hooks.ts:90`
**Confidence**: 85%
- **Problem**: `config.agentArgs.join(' ')` concatenates arguments with spaces and interpolates the result directly into the bash script (line 123). If any argument contains spaces, quotes, or shell metacharacters, the shell will split and interpret them. While `agentArgs` is currently hardcoded to `[]` in the connector (line 157), the `WrapperConfig` interface accepts `string[]` without validation.
- **Attack vector**: A future caller passing `agentArgs: ["--flag'; rm -rf /; echo '"]` would inject arbitrary shell commands.
- **Suggestion**: Each argument should be individually single-quoted and escaped:

```typescript
const agentArgs = config.agentArgs.map(a => `'${a.replace(/'/g, "'\\''")}'`).join(' ');
```

## Issues in Code You Touched (Should Fix)

### MEDIUM

**[P2] cwd parameter not validated against SAFE_PATH_REGEX** - `src/implementations/tmux/tmux-session-manager.ts:97`
**Confidence**: 82%
- **Problem**: The `config.cwd` field is embedded in the shell command via `escapeSingleQuoted()` (line 97), which handles single-quote breakout. However, unlike `sessionsDir` (which gets `SAFE_PATH_REGEX` validation in `generateWrapper`), `cwd` is not validated against any path safety regex. The `escapeSingleQuoted` function is sufficient to prevent shell injection from within single quotes, so this is defense-in-depth only.
- **Attack vector**: Low. `escapeSingleQuoted` prevents breakout from single-quoted context. The risk is limited to `cwd` values containing newlines or null bytes, which `escapeSingleQuoted` does not address (though such values are unlikely in practice and tmux may reject them).
- **Suggestion**: Add `SAFE_PATH_REGEX` validation for `cwd` in `createSession()` for consistency:

```typescript
if (config.cwd && !SAFE_PATH_REGEX.test(config.cwd)) {
  return err(tmuxSessionFailed('create', `unsafe cwd path: ${config.cwd}`, { cwd: config.cwd }));
}
```

---

**[P2] Raw tmux stderr/stdout exposed in error results** - `src/implementations/tmux/tmux-session-manager.ts:105`
**Confidence**: 80%
- **Problem**: Multiple error paths in `DefaultTmuxSessionManager` pass raw `spawnResult.stderr || spawnResult.stdout` into error objects (lines 105, 176, 198, 230). If tmux produces error messages containing file paths, session state, or environment details, these propagate through the Result chain and could reach MCP tool responses visible to external clients.
- **Attack vector**: Information disclosure. An attacker who can trigger tmux errors (e.g., by exhausting resources) could observe internal paths or session names in error responses. Low severity given MCP clients are typically trusted operators.
- **Suggestion**: Consider truncating or sanitizing tmux output before embedding in error messages, or log the full output at debug level and return a sanitized summary:

```typescript
const safeMsg = (spawnResult.stderr || spawnResult.stdout).slice(0, 200);
```

## Pre-existing Issues (Not Blocking)

No pre-existing issues identified (all files are new in this branch).

## Suggestions (Lower Confidence)

- **SAFE_PATH_REGEX allows relative paths** - `src/implementations/tmux/types.ts:276` (Confidence: 65%) -- The regex does not require a leading `/`, so relative paths like `sessions/data` would pass validation. While `sessionsDir` is typically absolute in practice, adding `^/` to the regex would harden against accidental relative path usage.

- **Symlink traversal not addressed by SAFE_PATH_REGEX** - `src/implementations/tmux/types.ts:276` (Confidence: 60%) -- `SAFE_PATH_REGEX` rejects `..` but cannot prevent symlink-based traversal where `/tmp/autobeat-sessions/attacker-task` is a symlink to `/etc`. The `rmSync(recursive: true, force: true)` in `cleanup()` would follow the symlink. Requires a local attacker with filesystem write access to the sessions directory, which is a narrow threat model.

- **File descriptor leak possible on watcher error path** - `src/implementations/tmux/tmux-connector.ts:356` (Confidence: 62%) -- If `fs.watch` succeeds but the `error` event fires immediately, the watcher object is assigned to `session.sentinelWatcher` but the error handler only logs — it does not close the watcher. The degradation to staleness detection is correct, but the open file descriptor persists until `closeSession`.

## Summary

| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 2 | 0 | 0 |
| Should Fix | 0 | 0 | 2 | 0 |
| Pre-existing | 0 | 0 | 0 | 0 |

**Security Score**: 7/10
**Recommendation**: CHANGES_REQUESTED

The tmux abstraction layer demonstrates strong security awareness overall: `TASK_ID_REGEX`, `SAFE_PATH_REGEX`, `SESSION_NAME_REGEX`, and `escapeSingleQuoted()` are applied consistently at the right boundaries. File permissions are set to `0o700` (owner-only). Communication targets are validated before script embedding. Environment variable keys are validated against POSIX regex.

The two HIGH findings center on `agentCommand` and `agentArgs` being the only user-controllable values that flow into the generated bash script without validation or escaping. While these are currently sourced from trusted internal configuration, the defense-in-depth principle requires the script-generation boundary to validate its own inputs rather than trusting callers. avoids PF-001 -- all findings reported inline rather than deferred.
