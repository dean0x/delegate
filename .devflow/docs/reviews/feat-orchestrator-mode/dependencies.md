# Dependencies Review Report

**Branch**: feat/orchestrator-mode -> main
**Date**: 2026-03-27
**PR**: #123

## Issues in Your Changes (BLOCKING)

### MEDIUM

**test:orchestration not included in test:all aggregate script** - `package.json:19`
**Confidence**: 95%
- Problem: The new `test:orchestration` script (line 21) adds 7 test files, but the `test:all` script (line 19) was not updated to include `npm run test:orchestration`. This means CI and `npm run validate` will not run any of the orchestration tests, leaving 70+ new tests uncovered by the standard quality gates.
- Fix: Append `&& npm run test:orchestration` to the `test:all` script:
  ```json
  "test:all": "npm run test:core && npm run test:handlers && npm run test:services && npm run test:repositories && npm run test:adapters && npm run test:implementations && npm run test:cli && npm run test:scheduling && npm run test:checkpoints && npm run test:error-scenarios && npm run test:integration && npm run test:orchestration",
  ```

## Issues in Code You Touched (Should Fix)

### MEDIUM

**Internal prompt length limit increased 4x without documentation update** - `src/services/loop-manager.ts:57`
**Confidence**: 82%
- Problem: The prompt length validation was changed from 4000 to 16000 characters. The inline comment on line 44 still reads `"Validate prompt: required 1-4000 chars unless pipeline mode"`, which is now stale. While the MCP-facing Zod schemas correctly keep the user-facing limit at 4000 (in `mcp-adapter.ts`), the discrepancy between the comment and the actual limit could confuse future maintainers. The 4x increase also has no migration or changelog note -- if any downstream consumer relied on the 4000-char internal limit, this is a silent breaking change.
- Fix: Update the stale comment at `src/services/loop-manager.ts:44`:
  ```typescript
  // Validate prompt: required 1-16000 chars (internal limit; MCP boundary enforces 4000 for user-facing prompts)
  ```

## Pre-existing Issues (Not Blocking)

No pre-existing dependency issues identified.

## Suggestions (Lower Confidence)

- **Consider adding orchestration tests to the test:handlers group** - `package.json:25` (Confidence: 65%) -- The `orchestration-handler.test.ts` file follows the same pattern as other handler tests and could arguably be included in `test:handlers` for consistency rather than in a standalone group. However, the standalone `test:orchestration` group is also a reasonable organizational choice.

## Summary

| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 0 | 1 | 0 |
| Should Fix | 0 | 0 | 1 | 0 |
| Pre-existing | 0 | 0 | 0 | 0 |

**Dependency Assessment**:
- No new external dependencies introduced (clean)
- No lockfile changes required (clean)
- All new code uses existing dependencies: `better-sqlite3`, `zod`, and Node.js built-ins (`fs`, `path`, `os`, `child_process`, `crypto`)
- npm audit: 0 vulnerabilities
- No typosquatting risk (no new packages)
- No license changes
- No version range changes
- No supply chain risk increase

**Dependencies Score**: 9/10
**Recommendation**: APPROVED_WITH_CONDITIONS

The dependency surface is clean -- zero new packages added. The only actionable finding is that the new `test:orchestration` script is not wired into `test:all`, meaning CI will silently skip 70+ orchestration tests. The stale comment in `loop-manager.ts` is a minor documentation gap. Both are straightforward fixes.
