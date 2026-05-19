# Dependencies Review Report

**Branch**: feat/worker-coordination-89 -> main
**Date**: 2026-03-17
**Commits**: 7324e28, 0c496f3

## Issues in Your Changes (BLOCKING)

### CRITICAL
None.

### HIGH
None.

### MEDIUM

**Missing exclusion in test:implementations script** - `package.json:28`
- Problem: The `test:implementations` script runs all tests in `tests/unit/implementations/` and excludes specific repository tests (dependency, task, database, checkpoint, output) to avoid double-running them with `test:repositories`. The new `worker-repository.test.ts` was correctly added to `test:repositories` but was NOT added to the exclusion list in `test:implementations`. This means `worker-repository.test.ts` runs twice during `test:all`.
- Impact: Wasted CI time and inconsistency with the established pattern for repository test grouping.
- Fix: Add `--exclude='**/worker-repository.test.ts'` to the `test:implementations` script:
```json
"test:implementations": "NODE_OPTIONS='--max-old-space-size=2048' vitest run tests/unit/implementations --exclude='**/dependency-repository.test.ts' --exclude='**/task-repository.test.ts' --exclude='**/database.test.ts' --exclude='**/checkpoint-repository.test.ts' --exclude='**/output-repository.test.ts' --exclude='**/worker-repository.test.ts' --no-file-parallelism",
```

## Issues in Code You Touched (Should Fix)

None.

## Pre-existing Issues (Not Blocking)

### HIGH

**4 high-severity transitive dependency vulnerabilities** - `package-lock.json`
- Problem: `npm audit` reports 4 high-severity vulnerabilities in transitive dependencies:
  1. `flatted <3.4.0` (via `@vitest/ui@4.0.18`) -- unbounded recursion DoS in `parse()` (GHSA-25h7-pfq9-p65f)
  2. `hono <=4.12.6` (via `@modelcontextprotocol/sdk@1.27.0`) -- 4 CVEs including prototype pollution, arbitrary file access, SSE injection, cookie injection
  3. `@hono/node-server <1.19.10` (via `@modelcontextprotocol/sdk@1.27.0`) -- authorization bypass for static paths (GHSA-wc8c-qw6v-h7f6)
  4. `express-rate-limit 8.2.0-8.2.1` -- IPv4-mapped IPv6 bypass (GHSA-46wh-pxpv-q5gq)
- Impact: The `hono` and `@hono/node-server` vulnerabilities are in the MCP SDK's HTTP transport layer. If Autobeat uses HTTP-based MCP transport (not just stdio), these could be exploitable. The `flatted` issue is in dev tooling only (`@vitest/ui`).
- Fix: Run `npm audit fix` to update transitive dependencies. All have fixes available.

### LOW

**Several outdated dependencies** - `package.json`
- Problem: Multiple dependencies have newer versions available:
  - `better-sqlite3`: 12.6.2 -> 12.8.0 (patch/minor)
  - `@modelcontextprotocol/sdk`: 1.27.0 -> 1.27.1 (patch, would also fix hono CVEs)
  - `cron-parser`: 4.9.0 -> 5.5.0 (major - review breaking changes)
  - `zod`: 3.25.76 -> 4.3.6 (major - review breaking changes)
  - `vitest`/`@vitest/*`: 4.0.18 -> 4.1.0 (minor)
  - `@biomejs/biome`: 2.4.4 -> 2.4.7 (patch)
- Impact: Missing bug fixes, performance improvements, and security patches. The major version bumps (cron-parser 5.x, zod 4.x) require separate migration effort.
- Fix: Address in a dedicated dependency update PR. Patch/minor updates can be done with `npm update`. Major versions need individual assessment.

## Dependency Change Summary

This PR introduces **zero new dependencies**. All new code uses existing packages:
- `better-sqlite3` (existing production dependency) -- used in new `SQLiteWorkerRepository`
- `os` and `child_process` (Node.js built-ins) -- used in modified resource monitor and process connector
- `vitest` (existing dev dependency) -- used in new test files

The `package.json` change is limited to the `test:repositories` script, adding the new `worker-repository.test.ts` to the test group. The lockfile is unchanged.

## Dependency Review Checklist

| Check | Status | Notes |
|-------|--------|-------|
| No known CVEs in added packages | PASS | No new packages added |
| Version ranges appropriate | PASS | No version changes |
| Lockfile updated and committed | PASS | No lockfile changes needed |
| Package actively maintained | N/A | No new packages |
| License compatible | N/A | No new packages |
| Package from verified publisher | N/A | No new packages |
| Transitive dependencies reviewed | N/A | No new packages |
| Package name verified (not typosquat) | N/A | No new packages |
| Bundle size impact considered | PASS | No new packages |
| Native alternatives considered | PASS | Uses existing better-sqlite3 |

## Summary

| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 0 | 1 | 0 |
| Should Fix | 0 | 0 | 0 | 0 |
| Pre-existing | 0 | 1 | 0 | 1 |

**Dependencies Score**: 9/10
**Recommendation**: APPROVED_WITH_CONDITIONS

The PR adds no new dependencies, which is excellent. The single blocking issue is the missing `--exclude` for `worker-repository.test.ts` in the `test:implementations` script, which is a minor consistency fix. The pre-existing audit vulnerabilities (particularly in `hono` via `@modelcontextprotocol/sdk`) should be addressed in a separate PR via `npm audit fix`.
