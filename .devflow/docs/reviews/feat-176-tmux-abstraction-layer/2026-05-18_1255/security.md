# Security Review Report

**Branch**: feat/176-tmux-abstraction-layer -> main
**Date**: 2026-05-18
**Reviewer focus**: Shell injection vectors, command escaping, path traversal, input validation at trust boundaries, unsafe exec calls

## Issues in Your Changes (BLOCKING)

### CRITICAL

(none)

### HIGH

**Env var values not validated before shell embedding in injectEnvironment** - `tmux-session-manager.ts:159-162`
**Confidence**: 90%
- Problem: `injectEnvironment` validates env var *keys* against a POSIX regex but env var *values* are only escaped with `escapeSingleQuoted()` (single-quote replacement). The values are caller-supplied via `config.env`, which is an external trust boundary. While single-quote escaping within `'...'` is technically correct per POSIX shell rules (everything inside single quotes is literal except the closing quote), the escaping function must be flawless for this to hold. The current `escapeSingleQuoted` function replaces `'` with `'\''` which is the standard technique, so it *is* correct. However, the concern is that this value escaping is the *only* defense — there is no validation/rejection of values containing shell metacharacters, unlike the reject-bad-input strategy used for `cwd`, `sessionsDir`, `agentCommand`, and `taskId`. A defense-in-depth approach would add a length limit or a character class check on values, consistent with the project's "assume all input is malicious" principle.
- Impact: If `escapeSingleQuoted` ever regresses or is accidentally changed, attacker-controlled env values would flow directly into shell commands. The current implementation is correct but lacks the defense-in-depth layering applied everywhere else.
- Fix: Add a value-level validation pass before escaping, or at minimum a length cap:
```typescript
const MAX_ENV_VALUE_LENGTH = 4096;
const validEntries = Object.entries(allEnv).filter(([key, value]) => {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) return false;
  if (value.length > MAX_ENV_VALUE_LENGTH) return false;
  return true;
});
```

### MEDIUM

**Session name `config.name` interpolated unquoted in exec commands** - `tmux-session-manager.ts:110,161,177,205,221,296`
**Confidence**: 82%
- Problem: The session name is interpolated directly into shell command strings without quoting: `tmux new-session -d -s ${config.name}`, `tmux kill-session -t ${name}`, `tmux send-keys -t ${name}`, etc. This is safe *only* because `SESSION_NAME_REGEX = /^beat-[a-z0-9-]+$/` validates the name beforehand, restricting it to characters that cannot cause shell injection. However, the session name is not quoted — it relies entirely on the regex validation. If `SESSION_NAME_REGEX` were ever relaxed (e.g., to allow underscores, spaces, or other characters), these interpolation sites would silently become injection vectors. Adding single quotes around the session name would provide defense-in-depth at zero cost.
- Impact: Low immediate risk (regex is restrictive), but violates defense-in-depth principle. The regex and the quoting should independently prevent injection.
- Fix: Quote the session name at all interpolation sites:
```typescript
// Before:
`tmux new-session -d -s ${config.name} ...`
// After:
`tmux new-session -d -s '${config.name}' ...`
```
This is safe even for the current character set and provides a second barrier.

**Wrapper `SESSIONS_DIR` assignment uses JS template literal single-quoting, not `shellSingleQuote`** - `tmux-hooks.ts:120`
**Confidence**: 80%
- Problem: The wrapper script line `SESSIONS_DIR='${sessionDir}'` embeds the session directory path using JS template literal interpolation directly into a single-quoted bash string. This relies on `SAFE_PATH_REGEX` having already rejected any single quotes in `sessionsDir` and `taskId`. However, the `shellSingleQuote()` function exists in the same file for exactly this purpose (escaping single quotes in bash contexts). Using inline `'${sessionDir}'` instead of the dedicated escaping function is inconsistent with the `agentArgs` handling (which uses `shellSingleQuote`). The path components are individually validated by `SAFE_PATH_REGEX` which rejects single quotes, but `sessionDir = path.join(config.sessionsDir, config.taskId)` — the joined result is not re-validated against `SAFE_PATH_REGEX`.
- Impact: Low immediate risk because both components are validated. But `path.join` could theoretically produce a path with characters not in either input (e.g., on Windows with backslash normalization, though this is macOS/Linux targeted). Using `shellSingleQuote(sessionDir)` would be more robust.
- Fix:
```typescript
// Before (line 120):
SESSIONS_DIR='${sessionDir}'
// After:
SESSIONS_DIR=${shellSingleQuote(sessionDir)}
```

## Issues in Code You Touched (Should Fix)

### MEDIUM

**`ExecFn` type accepts a raw command string — no structured command API** - `types.ts:189`
**Confidence**: 65% (moved to Suggestions)

### LOW

**`SAFE_PATH_REGEX` does not allow `~` (home directory shorthand)** - `types.ts:276`
**Confidence**: 85%
- Problem: The regex `/^(?!.*\.\.)([a-zA-Z0-9/_.\-]+)$/` does not include `~` in the character class. Paths like `~/sessions` or `/home/user/.config` with tilde are rejected. While `~` is typically expanded by the shell before reaching the application, if a caller passes a literal `~/sessions` string, the validation will fail with an unhelpful error. This is not a security vulnerability — it is overly restrictive in a way that could push callers to bypass the validation or use workarounds.
- Impact: Usability — callers with `~` in configured paths get an "unsafe path" error. Not a security issue.
- Fix: Document that paths must be absolute and fully resolved. Optionally, resolve `~` to `$HOME` before validation if the project wants to support it.

## Pre-existing Issues (Not Blocking)

(none — all files are new in this branch)

## Suggestions (Lower Confidence)

- **`ExecFn` raw string command pattern** - `types.ts:189` (Confidence: 65%) — The `ExecFn` type signature `(cmd: string) => ExecResult` accepts a raw shell command string. This pattern is inherently vulnerable to injection because it requires every caller to manually construct safe command strings. A structured API (e.g., `exec(command: string, args: string[])`) would eliminate the injection surface by design. This is an architectural suggestion for future phases rather than a blocking issue for Phase 1 — the current callers all perform validation before interpolation.

- **Communication target session names embedded in double quotes in paste-buffer** - `tmux-hooks.ts:76` (Confidence: 68%) — `tmux paste-buffer -b beat-payload -t "${t}"` embeds the target name in double quotes within the generated bash script. Since `t` has already been validated against `SESSION_NAME_REGEX` (which allows only `beat-[a-z0-9-]+`), double quotes are safe here. But single quotes would be more defensively correct for a bash context, consistent with the rest of the security posture. The `"${t}"` notation means the bash shell will interpret the variable — but since `t` is a JS-time literal (not a bash variable), the double quotes are fine. This is a style/consistency nit.

- **No length limit on `keys` parameter in `sendKeys`** - `tmux-session-manager.ts:200` (Confidence: 60%) — The `sendKeys` method accepts an arbitrary-length string. A very large string could cause issues with the shell command buffer or tmux itself. Consider adding a reasonable length cap (e.g., 64KB) as a DoS prevention measure.

## Summary

| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 1 | 2 | 0 |
| Should Fix | - | - | 0 | 1 |
| Pre-existing | - | - | - | - |

**Security Score**: 8/10
**Recommendation**: CHANGES_REQUESTED

## Assessment

This tmux abstraction layer demonstrates strong security awareness. The codebase applies a consistent reject-bad-input strategy at every trust boundary:

1. **Input validation**: `TASK_ID_REGEX`, `SESSION_NAME_REGEX`, `SAFE_PATH_REGEX`, and POSIX env key validation cover the primary injection surfaces. Each regex is appropriately restrictive.

2. **Shell escaping**: The `shellSingleQuote()` and `escapeSingleQuoted()` functions correctly implement the standard POSIX single-quote escaping technique. `agentArgs` are individually single-quoted. The `-l` literal flag on `tmux send-keys` prevents tmux key binding interpretation.

3. **Communication security**: Using `tmux load-buffer`/`paste-buffer` instead of `send-keys` for forwarding agent output is a sound design choice that prevents shell variable expansion of attacker-controlled content.

4. **Path traversal**: The `(?!.*\.\.)` negative lookahead in `SAFE_PATH_REGEX` blocks `..` traversal sequences. Both `taskId` and `sessionsDir` are validated before flowing into `path.join` and `rmSync` calls.

5. **File permissions**: Session directories and scripts are created with mode `0o700` (owner-only).

The three blocking findings are defense-in-depth improvements — quoting session names, using the dedicated escaping function for `SESSIONS_DIR`, and adding validation to env var values — rather than exploitable vulnerabilities. The current code is likely safe in practice, but these changes would make it resilient to future regressions.
