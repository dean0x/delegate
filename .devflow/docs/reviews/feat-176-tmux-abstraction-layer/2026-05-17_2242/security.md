# Security Review Report

**Branch**: feat/176-tmux-abstraction-layer -> main
**Date**: 2026-05-17
**Pass**: Third analysis pass (post batch-1 fixes)

## Issues in Your Changes (BLOCKING)

### MEDIUM

**SAFE_PATH_REGEX allows path traversal via `..` sequences** - `src/implementations/tmux/types.ts:240`, `src/implementations/tmux/tmux-hooks.ts:171,226`
**Confidence**: 85%
- Problem: `SAFE_PATH_REGEX = /^[a-zA-Z0-9/_.\-]+$/` permits dot-dot sequences (e.g., `/tmp/../etc/passwd`). This regex is the sole validation gate for `sessionsDir` in both `generateWrapper()` and `cleanup()`. A `sessionsDir` containing `..` segments could cause `cleanup()` to call `rmSync(path.join(sessionsDir, taskId), { recursive: true, force: true })` on an unintended directory, or `generateWrapper()` to write files outside the intended session root.
- Impact: If a future caller (e.g., MCP tool, config loader) passes user-influenced `sessionsDir`, this becomes a directory traversal leading to arbitrary file creation (via `generateWrapper`) or arbitrary recursive deletion (via `cleanup`). Currently no external callers exist, so exploitation requires a second bug in a future integration. Defense-in-depth issue.
- Fix: Add an explicit `..` rejection to `SAFE_PATH_REGEX` or add a `path.resolve` + prefix check:
  ```typescript
  // Option A: Reject .. in the regex
  export const SAFE_PATH_REGEX = /^(?!.*\.\.)([a-zA-Z0-9/_.\-]+)$/;
  
  // Option B: Resolve and check prefix (more robust)
  function isSafePath(input: string, expectedPrefix: string): boolean {
    const resolved = path.resolve(input);
    return resolved.startsWith(expectedPrefix) && SAFE_PATH_REGEX.test(input);
  }
  ```

## Issues in Code You Touched (Should Fix)

### LOW

**agentCommand embedded in generated bash without validation** - `src/implementations/tmux/tmux-hooks.ts:129`
**Confidence**: 80%
- Problem: `config.agentCommand` is interpolated directly into the generated bash script without any validation or escaping. The JSDoc at line 11-13 correctly documents this as an intentional trust boundary ("callers are responsible for ensuring these values come from trusted configuration, not user input"). However, no compile-time or runtime mechanism enforces this contract. If `WrapperConfig` were ever exposed to a less trusted caller, arbitrary command injection would result.
- Impact: Low today because the only caller (`TmuxConnector.spawn`) passes `config.command` from `TmuxSpawnConfig`, and `agentArgs` is always `[]`. The `agent` field is typed as `'claude' | 'codex'` literal union, but `agentCommand` is a freeform `string`. A future integration could pass user-controlled data through this path.
- Fix: Consider adding an `AGENT_COMMAND_REGEX` validation similar to `SAFE_PATH_REGEX` inside `generateWrapper()` — or restrict `agentCommand` to a known allowlist derived from the `agent` field:
  ```typescript
  const ALLOWED_COMMANDS: Record<string, string> = {
    claude: 'claude',
    codex: 'codex',
  };
  const resolved = ALLOWED_COMMANDS[config.agent];
  if (!resolved || config.agentCommand !== resolved) {
    return err(tmuxHookFailed('generateWrapper', `untrusted agentCommand: ${config.agentCommand}`));
  }
  ```

## Pre-existing Issues (Not Blocking)

(none)

## Suggestions (Lower Confidence)

- **ExecFn accepts raw shell strings** - `src/implementations/tmux/types.ts:183` (Confidence: 65%) -- The `ExecFn` type signature `(cmd: string) => ExecResult` accepts a single string that will be interpreted by the shell. This is a common injection surface in Node.js child_process usage. The current callers all construct commands with validated/escaped values, but the signature does not enforce structured command construction (e.g., `[command, ...args]` array form). Worth considering as a future hardening measure.

- **No upper bound on env var count in injectEnvironment** - `src/implementations/tmux/tmux-session-manager.ts:131` (Confidence: 62%) -- The `injectEnvironment` method chains all env vars into a single `&&`-joined shell command string. A very large `env` object (thousands of entries) could produce a command string that exceeds shell argument limits. Not exploitable for injection (values are escaped), but could cause a DoS-like condition if the env object is user-influenced.

## Summary

| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 0 | 1 | 0 |
| Should Fix | 0 | 0 | 0 | 1 |
| Pre-existing | 0 | 0 | 0 | 0 |

**Security Score**: 8/10
**Recommendation**: APPROVED_WITH_CONDITIONS

The tmux abstraction layer demonstrates strong security practices overall:
- Session names are strictly validated via `SESSION_NAME_REGEX` before shell embedding
- Task IDs are validated via `TASK_ID_REGEX` before script generation
- Single-quote escaping is correctly implemented using the POSIX `'\''` idiom
- `sendKeys` uses tmux `-l` (literal) mode to prevent key binding interpretation
- Communication targets are filtered through `SESSION_NAME_REGEX` before shell embedding
- File permissions are locked to `0o700` (owner-only)
- Atomic `.tmp` + `mv` pattern prevents partial reads
- Environment variable keys are validated against POSIX naming rules
- The trust boundary for `agentCommand` is explicitly documented

The one blocking finding (path traversal via `..` in `SAFE_PATH_REGEX`) is a defense-in-depth gap. It is not currently exploitable because no external callers exist yet, but it should be fixed before the abstraction layer is wired to any external input source (e.g., MCP tools, config files).

This assessment avoids PF-001 (deferring issues) by flagging the path traversal as blocking rather than informational, given it is in newly added code.
