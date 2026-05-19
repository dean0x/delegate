# Security Review Report

**Branch**: feat-176-tmux-abstraction-layer -> main
**Date**: 2026-05-17

## Issues in Your Changes (BLOCKING)

### HIGH

**Shell injection via unescaped `cwd` in createSession** - `src/implementations/tmux/tmux-session-manager.ts:99`
**Confidence**: 90%
- Problem: The `config.cwd` value is interpolated into a single-quoted shell argument without escaping single quotes. If `cwd` contains a single quote (e.g., a path like `/Users/dean/it's-a-project`), it breaks out of the single-quoted string enabling arbitrary shell command injection via the `exec()` call on line 101-102.
- Impact: Although `cwd` is described as config-only, the FEATURE_KNOWLEDGE states that only `agentCommand`/`agentArgs` are explicitly trusted. The `cwd` typically derives from task configuration which may originate from MCP tool input. Defense-in-depth requires escaping at this layer.
- Fix: Apply the same single-quote escaping used for env var values:
```typescript
const cwdEscaped = config.cwd.replace(/'/g, "'\\''");
const cwdFlag = config.cwd ? ` -c '${cwdEscaped}'` : '';
```

**Shell injection via unescaped `communicationTargets` in wrapper script** - `src/implementations/tmux/tmux-hooks.ts:38`
**Confidence**: 85%
- Problem: Communication target names are embedded inside double-quoted strings in the generated bash script (`tmux send-keys -t "${t}" -l "$PAYLOAD" Enter`). If a target contains shell metacharacters like `$(cmd)` or backticks, these would be interpreted when the bash script executes. There is no validation that targets match `SESSION_NAME_REGEX`.
- Impact: A malicious or malformed `communicationTargets` entry could execute arbitrary commands inside the wrapper script.
- Fix: Validate targets against `SESSION_NAME_REGEX` before embedding:
```typescript
import { SESSION_NAME_REGEX } from './types.js';

function buildCommunicationBlock(config: WrapperConfig): string {
  const { communicationTargets: targets } = config;
  if (!targets || targets.length === 0) return '';

  // Validate all targets match the safe session name pattern
  const validTargets = targets.filter((t) => SESSION_NAME_REGEX.test(t));
  if (validTargets.length === 0) return '';

  const sendLines = validTargets.map((t) => `  tmux send-keys -t "${t}" -l "$PAYLOAD" Enter`).join('\n');
  // ...rest unchanged
}
```

**Missing session name validation in `sendKeys`** - `src/implementations/tmux/tmux-session-manager.ts:174`
**Confidence**: 92%
- Problem: `sendKeys` interpolates `name` directly into a shell command (`tmux send-keys -t ${name} -l '...'`) without calling `validateSessionName()` first. `createSession` and `destroySession` both validate, but `sendKeys` does not. A name containing shell metacharacters (e.g., spaces, semicolons) would enable command injection.
- Impact: If a TmuxHandle with a corrupted or malicious `sessionName` is passed (even via a bug), shell injection occurs.
- Fix: Add validation at the top of the method, consistent with other methods:
```typescript
sendKeys(name: string, keys: string): Result<void, AutobeatError> {
  const nameCheck = validateSessionName(name, 'sendKeys');
  if (!nameCheck.ok) return nameCheck;

  const escaped = escapeSendKeys(keys);
  const result = this.deps.exec(`tmux send-keys -t ${name} -l '${escaped}'`);
  // ...
}
```

**Missing validation in `getSessionEnvironment`** - `src/implementations/tmux/tmux-session-manager.ts:243-244`
**Confidence**: 90%
- Problem: Neither `name` nor `varName` are validated before interpolation into the shell command `tmux show-environment -t ${name} ${varName}`. The `varName` parameter is completely unchecked and could contain shell metacharacters or injection payloads.
- Impact: Arbitrary command execution if either parameter contains shell metacharacters.
- Fix: Validate both parameters:
```typescript
getSessionEnvironment(name: string, varName: string): Result<string | undefined, AutobeatError> {
  const nameCheck = validateSessionName(name, 'getSessionEnvironment');
  if (!nameCheck.ok) return nameCheck;

  // Validate varName matches POSIX env var pattern
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(varName)) {
    return err(tmuxSessionFailed('getSessionEnvironment', `Invalid variable name: "${varName}"`, { varName }));
  }

  const result = this.deps.exec(`tmux show-environment -t ${name} ${varName}`);
  // ...
}
```

### MEDIUM

**Missing session name validation in `isAlive`** - `src/implementations/tmux/tmux-session-manager.ts:188-189`
**Confidence**: 85%
- Problem: `isAlive` interpolates the session name into `tmux has-session -t ${name}` without validation. While the blast radius is lower (no data-modifying side effects from `has-session`), it's inconsistent with the security posture of other methods.
- Impact: Potential shell injection (lower severity since `has-session` is read-only, but the shell itself still interprets the string).
- Fix: Add `validateSessionName` call or at minimum ensure callers only pass validated names. For consistency:
```typescript
isAlive(name: string): Result<boolean, AutobeatError> {
  const nameCheck = validateSessionName(name, 'isAlive');
  if (!nameCheck.ok) return nameCheck;

  const result = this.deps.exec(`tmux has-session -t ${name}`);
  return ok(result.status === 0);
}
```

## Issues in Code You Touched (Should Fix)

_None identified._

## Pre-existing Issues (Not Blocking)

_None identified._

## Suggestions (Lower Confidence)

- **Unbounded `deliveredSequences` Set growth** - `src/implementations/tmux/tmux-connector.ts:309` (Confidence: 65%) — The `deliveredSequences` Set grows without bound for long-running sessions. For very long-lived agents producing thousands of messages, this could become a memory concern. Consider pruning sequences below `nextExpectedSeq`.

- **taskId not validated in TmuxHooks before path.join** - `src/implementations/tmux/tmux-hooks.ts:107` (Confidence: 70%) — The `taskId` is used in `path.join(config.sessionsDir, config.taskId)` to create directories. If a `taskId` contained path traversal characters (e.g., `../`), it could write outside the intended sessions directory. The session name regex enforces `[a-z0-9-]` at the session manager layer, but `TmuxHooks.generateWrapper` receives `taskId` directly without its own validation.

- **`jq` fallback in wrapper script could produce invalid JSON** - `src/implementations/tmux/tmux-hooks.ts:78` (Confidence: 62%) — If `jq` is not available, the fallback `printf '"%s"'` does not properly escape embedded double quotes or backslashes in stdout lines, which could produce malformed JSON consumed by the connector's `JSON.parse`.

## Summary
| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 4 | 1 | 0 |
| Should Fix | 0 | 0 | 0 | 0 |
| Pre-existing | 0 | 0 | 0 | 0 |

**Security Score**: 5/10
**Recommendation**: CHANGES_REQUESTED

The core security pattern of validating session names via `SESSION_NAME_REGEX` is well-designed and correctly applied to `createSession`/`destroySession`, but is inconsistently applied to `sendKeys`, `isAlive`, and `getSessionEnvironment`. The `cwd` path and `communicationTargets` lack escaping/validation. Given that the FEATURE_KNOWLEDGE explicitly identifies "sendKeys escaping, env var injection prevention, session name regex validation" as security concerns for this feature area, these gaps should be closed before merge.
