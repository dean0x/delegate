# Dependencies Review Report

**Branch**: feat/183-phase-8--channel-cli--mcp -> main
**Date**: 2026-05-26

## Issues in Your Changes (BLOCKING)

No blocking dependency issues found.

## Issues in Code You Touched (Should Fix)

No should-fix dependency issues found.

## Pre-existing Issues (Not Blocking)

### MEDIUM
**6 npm audit vulnerabilities (1 high, 5 moderate)** - `package-lock.json`
**Confidence**: 95%
- Problem: `npm audit` reports 6 vulnerabilities across transitive dependencies: `fast-uri` (high -- path traversal, host confusion), `hono` (moderate -- 5 advisories including CSS injection, JWT validation, cache leakage, bodyLimit bypass, HTML injection), `ip-address` (moderate -- XSS), `qs` (moderate -- DoS), `ws` (moderate -- uninitialized memory disclosure). All are fixable via `npm audit fix`.
- Fix: These are pre-existing (identical on `main`). Run `npm audit fix` in a separate PR to address all 6. The `fast-uri` path traversal (GHSA-q3j6-qgpj-74h6) is the highest priority as it is severity high.
- Note: No new dependencies were added by this branch, so no new attack surface was introduced.

## Suggestions (Lower Confidence)

No lower-confidence suggestions.

## Summary
| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 0 | 0 | - |
| Should Fix | - | 0 | 0 | - |
| Pre-existing | - | 0 | 1 | 0 |

**Dependencies Score**: 9/10
**Recommendation**: APPROVED

### Rationale

This branch makes a single, minimal change to `package.json`: the `test:cli` script is extended to include two new test files (`tests/unit/cli/channel.test.ts` and `tests/unit/cli/msg.test.ts`). The change is correct and well-scoped:

1. **No new dependencies added** -- Zero new production or dev dependencies. The dependency count remains at 10 production + 11 dev. No new attack surface introduced.
2. **No lockfile changes** -- `package-lock.json` is untouched, confirming no transitive dependency tree mutations.
3. **Script change is additive and correct** -- The two test files added to the `test:cli` script both exist on disk and follow the established naming/path convention (`tests/unit/cli/*.test.ts`). The `NODE_OPTIONS` memory limit and `--no-file-parallelism` flags are preserved.
4. **All imports are internal** -- The only new external import across all 18 changed files is `node:path` (Node.js built-in). Every other import is a relative project import or `vitest`. No new third-party runtime code is pulled in.
5. **Audit findings are pre-existing** -- The 6 `npm audit` vulnerabilities exist identically on `main` and are not introduced by this branch. They should be addressed in a dedicated maintenance PR (applies ADR-003 -- pre-existing issues tracked separately).
