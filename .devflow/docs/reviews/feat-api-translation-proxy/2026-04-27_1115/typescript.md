# TypeScript Review Report

**Branch**: feat/api-translation-proxy -> main
**Date**: 2026-04-27

## Issues in Your Changes (BLOCKING)

### HIGH

**Missing exhaustive `never` check in `serializeContentBlock` switch** - `src/translation/codecs/anthropic-codec.ts:178`
**Confidence**: 90%
- Problem: The `serializeContentBlock` function was refactored from if/else to a switch statement (good), but the `default` case returns a silent fallback (`{ type: 'text', text: '' }`) instead of using the `never` exhaustive check pattern. This means if a new `CanonicalContent` variant is added to the discriminated union (e.g., a future `audio` type), the compiler will NOT flag this function as needing an update. The Anthropic stream serializer in the same file correctly uses `const _exhaustive: never = event` (line 324), so the pattern exists in this codebase but was not applied here.
- Fix: Handle all known unrepresentable types explicitly and add exhaustive check:
```typescript
case 'image':
case 'document':
case 'json':
case 'tool_result':
  // Not representable in Anthropic wire format
  return { type: 'text', text: '' };
default: {
  const _exhaustive: never = content;
  return { type: 'text', text: '' };
}
```

**`rawError` cast `as NodeJS.ErrnoException` bypasses type narrowing** - `src/utils/url-probe.ts:101`
**Confidence**: 82%
- Problem: The error handler casts `rawError` (typed `unknown`) directly to `NodeJS.ErrnoException` without a type guard. While `http.ClientRequest` errors are conventionally `Error` instances, the `unknown` parameter type exists precisely to prevent unsafe assumptions. The cast silences the type checker. The pattern `error instanceof Error ? error.message : String(error)` is used correctly in `bootstrap.ts:262` for the same scenario.
- Fix: Narrow properly before accessing `ErrnoException` fields:
```typescript
req.on('error', (rawError: unknown) => {
  clearTimeout(timeoutHandle);
  const durationMs = Date.now() - startMs;
  const error = rawError instanceof Error
    ? (rawError as NodeJS.ErrnoException)
    : Object.assign(new Error(String(rawError)), { code: undefined }) as NodeJS.ErrnoException;
  if (error.name === 'AbortError' || controller.signal.aborted) {
    // ...
  }
  resolve({ error, durationMs });
});
```

### MEDIUM

**`httpRequest` return type uses structural shape instead of discriminated union** - `src/utils/url-probe.ts:63`
**Confidence**: 85%
- Problem: The return type `Promise<HttpResult | { error: NodeJS.ErrnoException; durationMs: number }>` relies on structural duck-typing (`'error' in baseResult`) to discriminate the two shapes. This works but is fragile -- if `HttpResult` ever gains an `error` field (e.g., for HTTP-level error info), the `'error' in` check silently breaks. The project already uses `Result<T, E>` discriminated unions extensively.
- Fix: Use a proper discriminated union or the project's Result type:
```typescript
type ProbeHttpResult =
  | { ok: true; statusCode: number; headers: http.IncomingHttpHeaders; durationMs: number }
  | { ok: false; error: NodeJS.ErrnoException; durationMs: number };
```

**Inline `SetPayload` interface removed -- response shape now untyped** - `src/adapters/mcp-adapter.ts:3527`
**Confidence**: 80%
- Problem: The previous code defined `interface SetPayload { success: boolean; message: string; warning?: string; }` and typed the response through it. The new code constructs the JSON inline in `JSON.stringify({...})` with no type annotation. The shape is correct by inspection, but removing the type means the compiler no longer validates the response shape. The `check` action still uses `CheckPayload` (line 3366), so this is an inconsistency.
- Fix: Keep a local type for the set response payload, or at minimum annotate with `satisfies`:
```typescript
text: JSON.stringify(
  {
    success: true,
    message: `${agent}: ${attempts.map((a) => a.label).join(', ')}`,
    ...(warnings.length > 0 && { warning: warnings.join('. ') }),
  } satisfies { success: boolean; message: string; warning?: string },
  null,
  2,
),
```

## Issues in Code You Touched (Should Fix)

### MEDIUM

**`bootstrap.ts` database registration changes from lazy singleton to eager try/catch with `throw error` escape** - `src/bootstrap.ts:274`
**Confidence**: 82%
- Problem: When the caught error does NOT contain `NODE_MODULE_VERSION`, the code does `throw error` where `error` is typed `unknown`. The `bootstrap` function returns `Promise<Result<Container>>` -- it should never throw. All other failure paths in this function return `err(...)`. The `throw` breaks the Result-based contract: callers will get an unhandled exception instead of an `err` result.
- Fix: Wrap the re-throw in an `err` return:
```typescript
} catch (error: unknown) {
  const msg = error instanceof Error ? error.message : String(error);
  if (msg.includes('NODE_MODULE_VERSION')) {
    return err(
      new AutobeatError(
        ErrorCode.SYSTEM_ERROR,
        `better-sqlite3 was compiled for a different Node.js version.\n\n` +
          `  Current Node:  ${process.version}\n` +
          `  Fix:           npm rebuild better-sqlite3 -g\n` +
          `                 (or reinstall: npm install -g autobeat)\n`,
      ),
    );
  }
  return err(
    new AutobeatError(
      ErrorCode.SYSTEM_ERROR,
      `Failed to initialize database: ${msg}`,
    ),
  );
}
```

## Pre-existing Issues (Not Blocking)

_None above CRITICAL threshold._

## Suggestions (Lower Confidence)

- **`messageForError` uses long if-chain instead of switch or map** - `src/utils/url-probe.ts:121` (Confidence: 65%) -- The chain of `if (code === ...)` checks could be a `switch` or `Map<string, (url: URL) => string>` for clarity and to enable exhaustive checking if error codes are ever typed as a union.

- **`probeUrl` deep probe silently swallows errors** - `src/utils/url-probe.ts:245-248` (Confidence: 70%) -- When the deep probe network request fails (`'error' in deepResult`), the code falls through to the base probe result with no logging. While the JSDoc comment explains this, a debug-level log would help operators diagnose why a deep probe was attempted but its result is absent.

- **`generated/version.ts` is not `export`-guarded in generation script** - `scripts/generate-version.mjs:12` (Confidence: 60%) -- The generation script has no error handling for write failures. If `writeFileSync` throws (permissions, disk full), the build proceeds with a stale or missing version file. A try/catch with `process.exit(1)` would make the build fail fast.

## Summary

| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 2 | 2 | 0 |
| Should Fix | 0 | 0 | 1 | 0 |
| Pre-existing | 0 | 0 | 0 | 0 |

**TypeScript Score**: 7/10
**Recommendation**: CHANGES_REQUESTED

The code is generally well-typed and follows project conventions (Result types, readonly properties, discriminated unions in IR types). The new `ThinkingStartEvent`/`ThinkingStopEvent` types are properly integrated into the `CanonicalStreamEvent` union with exhaustive checking in the stream serializer. The `url-probe.ts` utility is well-structured with DI for testing. Key issues: the `serializeContentBlock` switch lacks exhaustive `never` checking (inconsistent with the same file's stream serializer), the `httpRequest` error cast bypasses `unknown` narrowing, and the `bootstrap` throw breaks the Result contract.
