# Complexity Review Report

**Branch**: feat/176-tmux-abstraction-layer -> main
**Date**: 2026-05-17

## Issues in Your Changes (BLOCKING)

### HIGH

**`spawn()` exceeds 50-line function threshold (144 lines)** - `tmux-connector.ts:101-244`
**Confidence**: 95%
- Problem: The `spawn()` method is 144 lines long with 5 numbered phases inlined sequentially. It has a cyclomatic complexity of approximately 8 (multiple `if (!result.ok) return`, try/catch blocks, nested callback bodies). The staleness timer callback (lines 209-240) adds an additional inline closure with its own branching logic (3 branches: transient error, alive, dead).
- Impact: Difficult to unit-test individual phases. Adding a new phase (e.g., environment variable injection, retry logic) will push it further past maintainability thresholds.
- Fix: Extract the staleness timer setup into a private method `startStalenessTimer(session, config, callbacks)` and the watcher setup into `startWatchers(session, config, manifest, callbacks)`. Each phase becomes independently testable and spawn() becomes a sequencer:

```typescript
async spawn(config: TmuxSpawnConfig, callbacks: SpawnCallbacks): Promise<Result<TmuxHandle, AutobeatError>> {
  const validationResult = this.deps.validator.validate();
  if (!validationResult.ok) return validationResult;

  const manifestResult = this.generateManifest(config);
  if (!manifestResult.ok) return manifestResult;

  const session = this.buildSession(config, manifestResult.value, callbacks);
  this.startWatchers(session, config, manifestResult.value, callbacks);

  const sessionResult = this.launchSession(config, manifestResult.value, session);
  if (!sessionResult.ok) return sessionResult;

  this.startStalenessTimer(session, config, callbacks);
  this.activeSessions.set(config.taskId, session);
  return ok(session.handle);
}
```

---

**Duplicated `OutputMessage` shape validation (2 locations, ~7 lines each)** - `tmux-connector.ts:323-332` and `tmux-connector.ts:385-395`
**Confidence**: 95%
- Problem: The manual typeof-chain validation for `OutputMessage` is duplicated verbatim in `flushPendingFiles()` and `handleMessageFile()`. Both perform the same 6-condition check with the same `Record<string, unknown>` cast pattern. This is a maintenance risk -- if the `OutputMessage` shape changes, both locations must be updated in lockstep.
- Impact: Divergence risk, increased cognitive load when reading, and verbose casting noise (`parsed as Record<string, unknown>` repeated 4 times per block).
- Fix: Extract a type guard function:

```typescript
function isOutputMessage(value: unknown): value is OutputMessage {
  if (typeof value !== 'object' || value === null) return false;
  const obj = value as Record<string, unknown>;
  return (
    typeof obj.sequence === 'number' &&
    typeof obj.timestamp === 'string' &&
    typeof obj.type === 'string' &&
    typeof obj.content === 'string'
  );
}
```

Then both call sites become: `if (!isOutputMessage(parsed)) { continue; /* or return */ }`

---

**`flushPendingFiles()` nesting depth reaches 4 levels** - `tmux-connector.ts:292-351`
**Confidence**: 85%
- Problem: At 60 lines, `flushPendingFiles()` contains: re-entrancy guard -> try/finally -> nested try/catch (readdir) -> for loop -> nested try/catch (readFile/parse) -> if (validation). The deepest path is: method -> try -> for -> try -> continue, which is 4 levels of nesting. Combined with the validation block duplicated from `handleMessageFile`, this makes the function harder to follow than necessary.
- Impact: Adding flush-related logic (e.g., partial delivery confirmation) will push nesting further.
- Fix: After extracting the `isOutputMessage` type guard (see above), the inner loop body simplifies significantly. Optionally extract the per-file parsing to a private `tryParseMessageFile(filePath): OutputMessage | null` helper, which would flatten the for-loop body to ~3 lines.

### MEDIUM

**`createSession()` reaches 53 lines with mixed concerns** - `tmux-session-manager.ts:81-133`
**Confidence**: 82%
- Problem: `createSession()` handles validation, concurrency limit checking, session spawning, auto-variable injection, and environment variable injection in a single method. At 53 lines it is just past the 50-line warning threshold. The environment variable injection loop (lines 122-130) is a separate concern from session creation.
- Impact: The method will grow as new auto-injected variables or session options are added.
- Fix: Extract env var injection into a private `injectEnvironment(sessionName, config, autoVars)` method. This keeps `createSession()` focused on session lifecycle.

---

**`handleMessageFile()` at 46 lines with multiple responsibilities** - `tmux-connector.ts:373-418`
**Confidence**: 80%
- Problem: This method handles file reading, JSON parsing, shape validation, sequence buffering, ordered delivery, and gap recovery (the safety cap). The gap recovery block (lines 406-417) is a distinct concern that could be extracted.
- Impact: Moderate -- the method is currently below the 50-line threshold but combines distinct responsibilities that will grow independently.
- Fix: Extract the gap-recovery logic into `recoverMessageGap(session, callbacks)` -- a 10-line helper that the main method calls after delivery.

## Issues in Code You Touched (Should Fix)

### MEDIUM

**Magic numbers `0` and `1` in sentinel exit code defaults** - `tmux-connector.ts:369`
**Confidence**: 82%
- Problem: Line 369 reads `const exitCode = filename === '.done' ? (code ?? 0) : (code ?? 1);`. The fallback values `0` and `1` are conventional Unix exit codes but appear as raw literals. While commonly understood, they are embedded in a ternary that already has moderate cognitive load (filename check + nullish coalescing).
- Impact: Low -- conventional meaning, but naming would improve readability.
- Fix: Add named constants at the top of the file:

```typescript
/** Default exit codes when sentinel file content is unreadable */
const DEFAULT_SUCCESS_EXIT_CODE = 0;
const DEFAULT_FAILURE_EXIT_CODE = 1;
```

Then: `const exitCode = filename === '.done' ? (code ?? DEFAULT_SUCCESS_EXIT_CODE) : (code ?? DEFAULT_FAILURE_EXIT_CODE);`

## Pre-existing Issues (Not Blocking)

_None identified. All files are new in this branch._

## Suggestions (Lower Confidence)

- **`buildWrapperScript()` embeds multi-line bash as a template literal** - `tmux-hooks.ts:59-112` (Confidence: 70%) -- The function generates a ~50-line shell script as a JS template literal. This is inherently hard to test individual parts of (e.g., the `next_seq` function, the pipe+PIPESTATUS block). Consider extracting the shell script to a `.sh` template file or at minimum adding integration tests that execute the generated script with known inputs. Currently acceptable given the thorough unit tests in `hook-script-generation.test.ts`.

- **`ActiveSession` interface has 10 fields** - `tmux-connector.ts:61-81` (Confidence: 65%) -- At 10 fields, `ActiveSession` carries both lifecycle state (handle, exited, flushing), ordering state (lastDeliveredSeq, pendingMessages, nextExpectedSeq), and I/O resources (sentinelWatcher, messagesWatcher, stalenessTimer, debounceTimers). If the session object grows further, consider splitting into sub-objects (e.g., `OrderingState`, `WatcherSet`).

- **`listSessions()` output parsing has implicit format coupling** - `tmux-session-manager.ts:212-234` (Confidence: 62%) -- The `parts.length < 5` check and positional destructuring `[name, createdStr, attachedStr, widthStr, heightStr]` are tightly coupled to the `tmux list-sessions -F` format string. If fields are added or reordered, the parsing silently breaks. This is acceptable for now since the format string and parsing are co-located.

## Summary

| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 3 | 2 | 0 |
| Should Fix | - | 0 | 1 | 0 |
| Pre-existing | - | - | 0 | 0 |

**Complexity Score**: 7/10
**Recommendation**: CHANGES_REQUESTED

The codebase demonstrates good fundamentals: named constants for timeouts and caps, bounded iteration, dependency injection, and well-separated concerns at the class level. The primary issues are the 144-line `spawn()` method that would benefit from phase extraction, and the duplicated `OutputMessage` validation that should be a shared type guard. These are medium-effort refactors that will significantly improve readability and testability. No critical complexity issues were found.
