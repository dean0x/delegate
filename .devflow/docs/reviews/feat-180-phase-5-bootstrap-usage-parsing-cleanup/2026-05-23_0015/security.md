# Security Review Report

**Branch**: feat/180-phase-5-bootstrap-usage-parsing-cleanup -> main
**Date**: 2026-05-23

## Issues in Your Changes (BLOCKING)

### CRITICAL

(none)

### HIGH

**Setup shim embeds `agentCommand` without SAFE_PATH_REGEX validation** - `src/implementations/tmux/tmux-hooks.ts:169-193`
**Confidence**: 95%
- Problem: `buildSetupShim()` embeds `config.agentCommand` directly in the generated shell script via `exec ${config.agentCommand} ${agentArgs}` (line 192) but the validation against `SAFE_PATH_REGEX` happens only in `generateSetupShim()` (line 275). The free function `buildSetupShim()` itself does not validate — it trusts the caller. If `buildSetupShim()` were called from another path without the validation gate, an `agentCommand` containing shell metacharacters (e.g., `; rm -rf /`) would execute arbitrary commands inside the tmux session.

  Currently, the only call site is `generateSetupShim()` which validates first, so there is no *exploitable* path today. However, the existing `buildWrapperScript()` follows the same pattern (free function trusts caller), so this is a known architectural choice. The risk is that a future refactor could call `buildSetupShim()` without the validation gate, unlike `generateSetupShim()` which has explicit SECURITY comments documenting the dependency. Adding a defensive `SAFE_PATH_REGEX` check inside `buildSetupShim()` (matching the pattern comment at line 167 — "agentCommand is validated against SAFE_PATH_REGEX before embedding") would eliminate the trust gap entirely.

- Fix: Add a guard inside `buildSetupShim()` or document the caller-validated contract explicitly:
```typescript
function buildSetupShim(config: SetupShimConfig): string {
  // Defense-in-depth: validate agentCommand before embedding in shell script.
  // Caller (generateSetupShim) also validates, but this prevents misuse from future callers.
  if (!SAFE_PATH_REGEX.test(config.agentCommand)) {
    throw new Error(`unsafe agentCommand in buildSetupShim: ${config.agentCommand}`);
  }
  // ... rest of function
}
```

### MEDIUM

(none)

## Issues in Code You Touched (Should Fix)

(none)

## Pre-existing Issues (Not Blocking)

(none)

## Suggestions (Lower Confidence)

- **Interactive orchestrator `nodeSpawn` session name not validated for shell safety** - `src/cli/commands/orchestrate-interactive.ts:313` (Confidence: 65%) — `handle.sessionName` is passed directly to `nodeSpawn('tmux', ['attach-session', '-t', handle.sessionName])`. The session name is derived from `beat-task-{taskId}` which passes through `SESSION_NAME_REGEX` (`/^beat-[a-z0-9-]+$/`) validation in the session manager, so it is safe in practice. The concern is that the validation happens deep in the stack and not at the point of use — a direct defensive check before `nodeSpawn` would be defense-in-depth.

- **`tmuxExec` injection point widens bootstrap attack surface** - `src/bootstrap.ts:519-524` (Confidence: 60%) — The new `options.tmuxExec` parameter allows callers to inject a custom exec function. This is intended for test isolation but means any code that constructs `BootstrapOptions` can redirect all tmux commands to a custom handler. The risk is mitigated by `BootstrapOptions` being an internal API (not exposed via MCP or CLI), but the injection point should remain documented as test-only.

- **Setup shim `exec` without full path** - `src/implementations/tmux/tmux-hooks.ts:192` (Confidence: 70%) — The `exec ${config.agentCommand}` in the setup shim uses the bare command name (e.g., `claude`), relying on PATH resolution inside the tmux session. If the tmux session inherits a manipulated PATH, this could resolve to a different binary. The existing wrapper script (`buildWrapperScript`) uses the same pattern, so this is consistent with the codebase, but using an absolute path resolved at build time would be more robust.

## Summary
| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 1 | 0 | - |
| Should Fix | - | 0 | 0 | - |
| Pre-existing | - | - | 0 | 0 |

**Security Score**: 8/10
**Recommendation**: APPROVED_WITH_CONDITIONS

The single HIGH finding is a defense-in-depth gap where `buildSetupShim()` trusts its caller to validate `agentCommand` against `SAFE_PATH_REGEX`. The current code is safe because the only caller (`generateSetupShim()`) performs validation, but adding an internal guard would close the trust gap for future callers.

The overall security posture of this PR is strong:

1. **Shell injection prevention**: All user-controlled values embedded in generated shell scripts are properly escaped via `singleQuoteToken()` / `escapeForSingleQuotes()`. The `SAFE_PATH_REGEX`, `TASK_ID_REGEX`, and `SESSION_NAME_REGEX` validations are consistently applied at all entry points in the session manager and hooks.

2. **Environment variable injection**: `setSessionEnvironment()` validates `varName` against `POSIX_ENV_VAR_REGEX`, caps `value.length` at `MAX_ENV_VALUE_LENGTH`, and single-quotes the value before embedding in the tmux command. `sendControlKeys()` validates against the `ALLOWED_CONTROL_KEYS` allowlist before executing without `-l` mode.

3. **Path traversal**: The `SAFE_PATH_REGEX` rejects `..` sequences, and database paths continue to use `path.normalize()` with explicit traversal checks. The new `sessionsDir` container registration does not introduce new traversal vectors.

4. **Process control**: The cancel path correctly validates `pid > 0 && Number.isInteger(pid)` before calling `process.kill()`. The new tmux session-based cancel (`destroySession`) validates the session name before executing. The pid=0 sentinel convention for tmux workers prevents accidental SIGTERM to PID 0.

5. **Migration v30**: Adds a nullable `session_name TEXT` column — no security concern. Uses parameterized queries via prepared statements (consistent with all other repository code).

6. **Dead code removal**: Removing `ProcessSpawner` interface, `ProcessSpawnerAdapter`, and `spawn()`/`kill()`/`spawnInteractive()` methods reduces attack surface.

**Condition for approval**: Address the HIGH finding by adding defensive validation inside `buildSetupShim()` or adding a clear `@security` JSDoc tag documenting the caller-validated contract. The current code is not exploitable but violates the defense-in-depth principle established elsewhere in the tmux subsystem.
