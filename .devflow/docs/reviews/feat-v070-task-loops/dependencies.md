# Dependencies Review Report

**Branch**: feat/v070-task-loops -> main
**Date**: 2026-03-21

## Issues in Your Changes (BLOCKING)

### CRITICAL

No critical dependency issues found.

### HIGH

No high-severity dependency issues found.

### MEDIUM

**Missing exclude for loop-repository.test.ts in test:implementations script** - `package.json:28`
**Confidence**: 95%
- Problem: The `test:implementations` script runs all tests under `tests/unit/implementations/` but explicitly excludes files that already appear in `test:repositories` (dependency-repository, task-repository, database, checkpoint-repository, output-repository, worker-repository). The newly added `loop-repository.test.ts` was added to `test:repositories` (line 26) but was NOT added to the exclude list in `test:implementations` (line 28). This means `loop-repository.test.ts` will run in both `test:repositories` AND `test:implementations`, causing duplicate test execution during `test:all` runs and wasting CI time/resources.
- Fix: Add `--exclude='**/loop-repository.test.ts'` to the `test:implementations` script:
  ```json
  "test:implementations": "NODE_OPTIONS='--max-old-space-size=2048' vitest run tests/unit/implementations --exclude='**/dependency-repository.test.ts' --exclude='**/task-repository.test.ts' --exclude='**/database.test.ts' --exclude='**/checkpoint-repository.test.ts' --exclude='**/output-repository.test.ts' --exclude='**/worker-repository.test.ts' --exclude='**/loop-repository.test.ts' --no-file-parallelism"
  ```

## Issues in Code You Touched (Should Fix)

No should-fix dependency issues found.

## Pre-existing Issues (Not Blocking)

### HIGH

**Transitive dependencies with known CVEs via @modelcontextprotocol/sdk** - `package.json:91`
**Confidence**: 90%
- Problem: `@modelcontextprotocol/sdk@1.27.0` pulls in transitive dependencies with known high-severity vulnerabilities:
  - `@hono/node-server@1.19.9` - Authorization bypass for protected static paths via encoded slashes (GHSA-wc8c-qw6v-h7f6)
  - `hono@4.12.2` - 4 advisories including prototype pollution, cookie attribute injection, SSE control field injection, arbitrary file access (GHSA-v8w9-8mx6-g223, GHSA-p6xx-57qc-3wxr, GHSA-5pq2-9x2x-5p6w, GHSA-q5qw-h33p-qvwr)
  - `express-rate-limit@8.2.1` - IPv4-mapped IPv6 addresses bypass rate limiting (GHSA-46wh-pxpv-q5gq)
  - `flatted@3.3.3` (via @vitest/ui) - Unbounded recursion DoS and prototype pollution (GHSA-25h7-pfq9-p65f, GHSA-rf6f-7fwh-wjgh)
- Note: These are transitive and pre-existing. `npm audit fix` reports fixes are available. Consider addressing in a separate dependency-update PR.

### MEDIUM

**cron-parser pinned to v4, v5 available** - `package.json:93`
**Confidence**: 80%
- Problem: `cron-parser` is pinned to `^4.9.0` while v5.5.0 is available. This is a major version behind with potentially missing features and fixes. The `^4.9.0` range prevents automatic upgrade to v5.
- Note: Pre-existing, not introduced in this PR. Major version upgrades require testing for breaking changes.

## Suggestions (Lower Confidence)

- **Consider dependency audit as part of CI** - `package.json` (Confidence: 65%) -- Running `npm audit --audit-level=high` as a CI step would catch transitive vulnerability introductions automatically.

## Summary

| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 0 | 1 | 0 |
| Should Fix | 0 | 0 | 0 | 0 |
| Pre-existing | 0 | 1 | 1 | 0 |

**Key Observations**:
- No new npm dependencies were added in this PR. All new code uses only existing dependencies (`better-sqlite3`, `zod`) and Node.js built-ins (`child_process`).
- No changes to `package-lock.json`.
- The only dependency-file changes are additions of new test files to existing test group scripts in `package.json`.
- Version was not bumped (expected per release process).

**Dependencies Score**: 8/10
**Recommendation**: APPROVED_WITH_CONDITIONS

The one blocking MEDIUM issue (missing `--exclude` for `loop-repository.test.ts` in `test:implementations`) is a minor script consistency problem that causes duplicate test execution. It should be fixed but does not affect production code or correctness. Pre-existing transitive vulnerabilities should be addressed in a separate PR.
