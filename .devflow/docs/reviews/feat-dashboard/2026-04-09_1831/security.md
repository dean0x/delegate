# Security Review Report

**Branch**: feat-dashboard -> main
**Date**: 2026-04-09
**PR**: #131

## Issues in Your Changes (BLOCKING)

### CRITICAL

No CRITICAL security issues found.

### HIGH

No HIGH security issues found.

### MEDIUM

**Unvalidated JSON.parse of package.json** - `src/cli/dashboard/index.tsx:40`
**Confidence**: 82%
- Problem: `JSON.parse(readFileSync(...))` reads and parses `package.json` without a try/catch or schema validation. If the file is malformed or missing, this throws an unhandled exception. While `package.json` is a known internal file, the relative path traversal (`'..', '..', '..'`) could resolve unexpectedly if the module is relocated or bundled differently.
- Fix: Wrap in try/catch or use the existing `tryCatch` Result pattern consistent with the rest of the codebase:
```typescript
let version = '0.0.0';
try {
  const raw = readFileSync(path.join(dirname, '..', '..', '..', 'package.json'), 'utf-8');
  const pkg = JSON.parse(raw) as { version?: string };
  version = pkg.version ?? '0.0.0';
} catch {
  // Graceful fallback — version display is non-critical
}
```

## Issues in Code You Touched (Should Fix)

### MEDIUM

**Error messages in header may leak internal paths** - `src/cli/dashboard/components/header.tsx:76`
**Confidence**: 80%
- Problem: The header component displays raw database error messages to the terminal: `{error}` inside `"DB error: {error}, showing cached data"`. The error strings originate from `fetchAllData` in `use-dashboard-data.ts` which propagates `result.error.message` directly from repository failures. These messages can contain internal file paths (SQLite database path), SQL query fragments, or stack traces, which is information disclosure in a terminal UI.
- Fix: Truncate or sanitize error messages before display. Since this is a local CLI tool (not a web app), the severity is reduced, but sanitizing to a generic message or truncating to a fixed length is better practice:
```typescript
const displayError = error.length > 80 ? `${error.slice(0, 77)}...` : error;
```

## Pre-existing Issues (Not Blocking)

No pre-existing security issues relevant to this diff.

## Suggestions (Lower Confidence)

- **Global process handlers are registered once and never removed** - `src/cli/dashboard/index.tsx:71-88` (Confidence: 65%) -- The `process.once('SIGTERM')`, `process.once('uncaughtException')`, and `process.once('unhandledRejection')` handlers are never explicitly removed on normal exit. While `process.once` only fires once and `cleanup()` is idempotent, if `startDashboard` is ever called more than once in the same process (e.g., in tests or a future interactive mode), stale handlers could interfere.

- **Database context lifetime not bounded by timeout** - `src/cli/dashboard/use-dashboard-data.ts:168` (Confidence: 62%) -- The 1-second polling interval runs indefinitely with an open database connection. If the SQLite database becomes locked or unresponsive, the polling loop silently retries every second without any backoff. This is not exploitable but could lead to resource contention if another process holds a write lock for an extended period.

## Summary

| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 0 | 1 | 0 |
| Should Fix | 0 | 0 | 1 | 0 |
| Pre-existing | 0 | 0 | 0 | 0 |

**Security Score**: 9/10
**Recommendation**: APPROVED_WITH_CONDITIONS

### Security Assessment Notes

This PR introduces a **read-only terminal dashboard** (Ink/React CLI) with a clean security posture:

1. **No injection vectors**: All SQL queries use prepared statements with no user input interpolation. The four new `countByStatus()` methods are parameterless `GROUP BY` queries -- zero injection surface.

2. **No XSS/innerHTML**: All rendering uses React's safe text interpolation through Ink's `<Text>` components. No `dangerouslySetInnerHTML`, no `innerHTML`, no raw HTML.

3. **No secrets or credentials**: No hardcoded secrets, no API keys, no tokens in the new code. No `process.env` reads in the dashboard module.

4. **No command execution**: No `exec`, `spawn`, or `child_process` usage. The dashboard is purely a data display layer.

5. **No external network access**: Dashboard reads from the local SQLite database only. No HTTP requests, no external service calls.

6. **Read-only data access**: The `ReadOnlyContext` pattern correctly limits the dashboard to query-only repository methods. The `countByStatus()` additions are pure reads.

7. **Proper terminal cleanup**: Alternate screen, cursor state, and database connections are cleaned up via idempotent `cleanup()` with both try/finally and signal handlers.

The two MEDIUM findings are defensive improvements, not exploitable vulnerabilities. The conditions for approval are minor hardening items.
