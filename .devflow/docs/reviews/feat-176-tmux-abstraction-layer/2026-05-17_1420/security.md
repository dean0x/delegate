# Security Review Report

**Branch**: feat/176-tmux-abstraction-layer -> main
**Date**: 2026-05-17
**Reviewer Focus**: Injection flaws, shell escaping gaps, auth bypasses, hardcoded secrets, trust boundary violations

## Issues in Your Changes (BLOCKING)

### HIGH

**Env var value escaping incomplete -- backslash and exclamation mark not handled** - `tmux-session-manager.ts:128`
**Confidence**: 85%
- Problem: Environment variable values are escaped with only single-quote wrapping and internal single-quote escaping (`'${value.replace(/'/g, "'\\''")}'`). While this is the standard POSIX single-quote escaping idiom and prevents most injection, a value containing a literal backslash followed by a single-quote (`\'`) produces the sequence `'\''`, which prematurely closes the quoting context. The value also embeds into a `tmux set-environment` shell command via template literal, so the `exec` function interprets it through a shell. Specifically, consider a value like `a\' ; rm -rf /`. After the replace, this becomes: `'a\' ; rm -rf /'`. The shell sees: literal `a\` (with the backslash escaping the following `'`), then ` ; rm -rf /` as a separate command, then an unmatched `'`.
- Fix: Escape backslashes before escaping single quotes, matching the `escapeSendKeys` pattern:
```typescript
const quotedValue = `'${value.replace(/\\/g, '\\\\').replace(/'/g, "'\\''")}'`;
```

**`escapeSendKeys` missing double-quote escaping** - `tmux-session-manager.ts:44-56`
**Confidence**: 82%
- Problem: The `escapeSendKeys` function is used in `createSession` to wrap `config.command` in single quotes for the `tmux new-session` command (line 102). The escaping handles `\`, `'`, `$`, and `` ` `` but not `"`. While the command is wrapped in single quotes (which neutralize `"`), the same `escapeSendKeys` function is also used in `sendKeys` (line 171), where the escaped string is placed in single quotes: `'${escaped}'`. In this context, if the input contains characters like `!` followed by a word in certain interactive bash configurations, history expansion could trigger. In non-interactive shell contexts (the `exec` path uses `spawnSync` with `shell: true`), `!` is not expanded -- so this depends on how `ExecFn` is wired. The documented integration example uses `spawnSync` with `shell: true`, which spawns a non-interactive shell, making this safe in practice. Downgrading from CRITICAL to HIGH because the current integration pattern is safe, but the function lacks defense-in-depth against future callers wiring an interactive shell.
- Fix: Add a JSDoc comment documenting the non-interactive shell assumption, or add `"` escaping for completeness:
```typescript
// Ensure double-quotes are escaped if the surrounding quoting changes in the future
.replace(/"/g, '\\"')
```

### MEDIUM

**`taskId` used in path construction without validation** - `tmux-hooks.ts:60,122` and `tmux-connector.ts:313`
**Confidence**: 85%
- Problem: `taskId` is used in `path.join(config.sessionsDir, config.taskId)` to construct the session directory path. If a `taskId` contains path traversal characters (e.g., `../../etc`), it could write the session directory outside the intended `sessionsDir`. In the current codebase, `taskId` is generated internally via `crypto.randomUUID()` with a `task-` prefix, so this is not exploitable today. However, the tmux layer itself has no validation on `taskId`, creating a latent vulnerability if the layer is called from a context that accepts user-provided task IDs.
- Fix: Add a `taskId` format validation at the `TmuxHooks.generateWrapper` and `TmuxConnector.spawn` entry points:
```typescript
if (!/^[a-zA-Z0-9_-]+$/.test(config.taskId)) {
  return err(tmuxHookFailed('generateWrapper', `Invalid taskId: ${config.taskId}`));
}
```

**Communication block sends unescaped JSON through `send-keys -l`** - `tmux-hooks.ts:45`
**Confidence**: 80%
- Problem: The communication block generates: `tmux send-keys -t "{target}" -l "$PAYLOAD" Enter`. The `-l` flag in tmux makes all subsequent arguments literal (no key name lookup), which means `Enter` is sent as the literal text "Enter" rather than a carriage return. While this is a functional bug (not security), it means inter-session communication does not actually press Enter after sending the payload. The security concern is minor: if the intent was to execute the payload as a command in the target session, a missing Enter is actually safer. However, the use of `"$PAYLOAD"` (double-quoted variable) inside a bash script is safe because bash does not re-interpret `$` or `` ` `` inside an already-expanded variable.
- Fix: If Enter is needed, it should be sent as a separate non-literal command:
```bash
tmux send-keys -t "${t}" -l "$PAYLOAD"
tmux send-keys -t "${t}" Enter
```

## Issues in Code You Touched (Should Fix)

### MEDIUM

**`agentCommand` and `agentArgs` trust boundary not enforced at runtime** - `tmux-hooks.ts:89`
**Confidence**: 82%
- Problem: `config.agentCommand` and `config.agentArgs` are interpolated directly into the generated bash script without any escaping or validation: `${config.agentCommand} ${agentArgs}`. The JSDoc comment (line 11-13) explicitly documents this as a caller responsibility, and the KNOWLEDGE.md file documents this trust boundary. However, there is no runtime assertion or type-level guard preventing untrusted input from reaching this code path. If a future integration passes user-controlled data as `agentCommand`, it would be a direct shell injection vector. The `agentArgs` are joined with spaces (`config.agentArgs.join(' ')`, line 61), which means an arg containing spaces or shell metacharacters would be interpreted by bash.
- Fix: Either (a) add a runtime assertion that `agentCommand` matches an allowlist of known agent binaries, or (b) use a branded/opaque type for `agentCommand` to prevent accidental passing of untrusted strings:
```typescript
// Option A: Runtime validation
const ALLOWED_AGENTS = ['claude', 'codex', 'ollama'];
if (!ALLOWED_AGENTS.some(a => config.agentCommand.includes(a))) {
  return err(tmuxHookFailed('generateWrapper', `Unknown agent command: ${config.agentCommand}`));
}

// Option B: Branded type (compile-time guard)
type TrustedCommand = string & { readonly __brand: 'TrustedCommand' };
```

## Pre-existing Issues (Not Blocking)

(No pre-existing issues -- all files in scope are new in this branch.)

## Suggestions (Lower Confidence)

- **`flock` fallback silently proceeds on failure** - `tmux-hooks.ts:75` (Confidence: 65%) -- The wrapper script uses `flock -x 200 2>/dev/null || true`, which silently proceeds without the lock if `flock` is unavailable (e.g., on older macOS without GNU coreutils). This could cause sequence number collisions under concurrent writes, leading to message loss. Not a security issue but a reliability concern.

- **`config.cwd` is escaped but not validated for path traversal** - `tmux-session-manager.ts:99` (Confidence: 70%) -- The `cwd` value is single-quote-escaped for shell embedding but not validated as a legitimate directory. A `cwd` containing `../../` would be passed through to tmux. Since `cwd` comes from task configuration (not direct user input in the current architecture), this is low risk.

- **Wrapper script atomicity: `mv` over sentinel is not guaranteed atomic on all filesystems** - `tmux-hooks.ts:102-106` (Confidence: 60%) -- The wrapper uses `mv "$file.tmp" "$file"` for atomic writes. While `mv` (rename) is atomic on the same filesystem on POSIX, NFS and some network filesystems may not guarantee this. If sessions directories are on a network mount, sentinel detection could race.

## Summary

| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 2 | 2 | 0 |
| Should Fix | 0 | 0 | 1 | 0 |
| Pre-existing | 0 | 0 | 0 | 0 |

**Security Score**: 7/10
**Recommendation**: CHANGES_REQUESTED

### Assessment

The tmux abstraction layer demonstrates strong security awareness in its design. Key strengths:

- Session name validation (`/^beat-[a-z0-9-]+$/`) is applied consistently before every tmux CLI operation, preventing injection through session name parameters.
- Communication targets are validated against the same regex before embedding in generated scripts. Invalid targets are silently dropped -- a correct security posture (avoids PF-001: the security behavior is working correctly here, not deferred).
- Env var keys are validated against POSIX regex before injection.
- File permissions are set to `0o700` (owner-only) for all generated artifacts.
- The `jq` validation at spawn time with a defense-in-depth runtime guard prevents fallback to unsafe string formatting.
- `sendKeys` uses `-l` literal mode to prevent tmux key binding interpretation.
- The Result type pattern is used consistently -- no thrown exceptions in business logic.

The two HIGH findings (env var value escaping and `escapeSendKeys` completeness) are both defense-in-depth issues. They are not exploitable under the current integration patterns (internally generated values, non-interactive shell), but they represent escaping gaps that could become exploitable if the trust boundaries shift. Applies PF-001: these should be fixed now rather than deferred, since they are in newly added code.

Avoids PF-002: no backward-compatibility concerns -- this is new, unpublished infrastructure.
