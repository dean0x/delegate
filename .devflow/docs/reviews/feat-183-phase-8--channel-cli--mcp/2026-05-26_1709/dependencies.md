# Dependencies Review Report

**Branch**: feat-183-phase-8--channel-cli--mcp -> main
**Date**: 2026-05-26

## Issues in Your Changes (BLOCKING)

### CRITICAL
(none)

### HIGH
(none)

## Issues in Code You Touched (Should Fix)
(none)

## Pre-existing Issues (Not Blocking)

### HIGH

**Known vulnerability in fast-uri (<=3.1.1)** - `package-lock.json`
**Confidence**: 95%
- Problem: `fast-uri` has two advisories: path traversal via percent-encoded dot segments (GHSA-q3j6-qgpj-74h6) and host confusion via percent-encoded authority delimiters (GHSA-v39h-62p7-jpjc). Both rated HIGH severity.
- Fix: Run `npm audit fix` to upgrade `fast-uri` to a patched version. This is a transitive dependency and the fix is available.

### MEDIUM

**5 moderate-severity vulnerabilities in transitive dependencies** - `package-lock.json`
**Confidence**: 95%
- `hono` (<=4.12.17): 5 advisories covering CSS injection, JWT validation, cache leakage, bodyLimit bypass, HTML injection
- `ip-address` (<=10.1.0): XSS in Address6 HTML-emitting methods (via `express-rate-limit`)
- `qs` (6.11.1-6.15.1): DoS via TypeError on null/undefined entries
- `ws` (8.0.0-8.20.0): Uninitialized memory disclosure
- Problem: These are all pre-existing (identical vulnerability count on main branch). None were introduced by this PR.
- Fix: Run `npm audit fix` in a separate maintenance PR. All have fixes available.

## Suggestions (Lower Confidence)

(none)

## Summary
| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 0 | 0 | - |
| Should Fix | - | 0 | 0 | - |
| Pre-existing | - | 1 | 1 | 0 |

**Dependencies Score**: 9/10
**Recommendation**: APPROVED

### Rationale

This PR makes a single, minimal change to `package.json`: extending the `test:cli` script to include two new test files (`tests/unit/cli/channel.test.ts`, `tests/unit/cli/msg.test.ts`). No new runtime or dev dependencies are added. No version ranges are changed. The lockfile (`package-lock.json`) is untouched. All imports in new source files reference either local project modules or existing dependencies (`@modelcontextprotocol/sdk`, `zod`, `ink`, `ansi-escapes`, `react`, `vitest`). The 6 npm audit findings are pre-existing on main and should be addressed in a separate maintenance PR.
