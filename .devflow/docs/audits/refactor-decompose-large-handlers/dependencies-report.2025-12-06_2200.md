# Dependencies Audit Report

**Branch**: refactor/decompose-large-handlers
**Base**: main
**Date**: 2025-12-06 22:00

---

## Executive Summary

This branch contains **NO dependency changes**. All dependency issues identified are pre-existing in the main branch. However, there is a **HIGH severity security vulnerability** that should be addressed.

| Category | Count |
|----------|-------|
| BLOCKING (in your changes) | 0 |
| SHOULD FIX (pre-existing security) | 1 |
| PRE-EXISTING (outdated packages) | 10 |

---

## BLOCKING Issues in Your Changes

**None** - This branch does not modify `package.json` or `package-lock.json`.

Changed files in this branch:
- `docs/architecture/HANDLER-DECOMPOSITION-INVARIANTS.md` (new)
- `src/services/handlers/dependency-handler.ts`
- `src/services/handlers/worker-handler.ts`
- `tests/fixtures/test-doubles.ts`
- `tests/unit/services/handlers/dependency-handler.test.ts`
- `tests/unit/services/handlers/worker-handler.test.ts`

All changes are code refactoring - no new dependencies added, no dependency versions changed.

---

## SHOULD FIX Issues (Pre-existing but Security-Critical)

### HIGH: @modelcontextprotocol/sdk DNS Rebinding Vulnerability

**Severity**: HIGH
**CVE**: GHSA-w48q-cv73-mx4w
**CWE**: CWE-350 (Reliance on Reverse DNS Resolution for a Security-Critical Action), CWE-1188 (Insecure Default Initialization of Resource)

**Current Version**: 1.19.1
**Fixed Version**: >= 1.24.0
**Latest Version**: 1.24.3

**Description**:
The Model Context Protocol (MCP) TypeScript SDK does not enable DNS rebinding protection by default. This vulnerability could allow attackers to bypass same-origin policies via DNS rebinding attacks.

**Impact**:
An attacker could potentially:
- Bypass browser same-origin protections
- Access internal network resources through the MCP server
- Exfiltrate data via rebinding to attacker-controlled domains

**Recommendation**:
```bash
npm update @modelcontextprotocol/sdk
```

Update `package.json`:
```json
"@modelcontextprotocol/sdk": "^1.24.0"
```

**Note**: This vulnerability exists in the main branch as well (`^1.19.1`). While not introduced by this PR, it should be addressed as a priority.

---

## PRE-EXISTING Issues (Not Blocking)

### Outdated Production Dependencies

| Package | Current | Wanted | Latest | Risk Level |
|---------|---------|--------|--------|------------|
| @modelcontextprotocol/sdk | 1.19.1 | 1.24.3 | 1.24.3 | **HIGH** (security) |
| better-sqlite3 | 12.4.1 | 12.5.0 | 12.5.0 | LOW |
| simple-git | 3.28.0 | 3.30.0 | 3.30.0 | LOW |
| zod | 3.25.76 | 3.25.76 | 4.1.13 | MEDIUM (major) |

### Outdated Dev Dependencies

| Package | Current | Wanted | Latest | Risk Level |
|---------|---------|--------|--------|------------|
| @types/node | 24.3.0 | 24.10.1 | 24.10.1 | LOW |
| @vitest/coverage-v8 | 3.2.4 | 3.2.4 | 4.0.15 | LOW (major) |
| @vitest/ui | 3.2.4 | 3.2.4 | 4.0.15 | LOW (major) |
| tsx | 4.20.4 | 4.21.0 | 4.21.0 | LOW |
| typescript | 5.9.2 | 5.9.3 | 5.9.3 | LOW |
| vitest | 3.2.4 | 3.2.4 | 4.0.15 | LOW (major) |

### Notes on Major Version Updates

**zod 3.x -> 4.x**:
- Breaking changes expected
- Requires migration effort
- Recommend: Separate PR for migration

**vitest 3.x -> 4.x**:
- Breaking changes expected
- Dev dependency only - lower risk
- Recommend: Evaluate after stable release

---

## License Analysis

All dependencies use permissive licenses compatible with MIT:

| License | Count |
|---------|-------|
| MIT | 108 |
| ISC | 10 |
| Apache-2.0 | 2 |
| BSD-3-Clause | 2 |
| BSD-2-Clause | 1 |
| MIT OR WTFPL | 1 |
| BSD-2-Clause OR MIT OR Apache-2.0 | 1 |

**Status**: PASS - No license conflicts detected.

---

## Peer Dependencies

All unmet dependencies are **OPTIONAL** and platform-specific:
- `@vitest/browser@3.2.4` - Optional browser testing
- `@esbuild/*` - Platform-specific binaries (only current platform needed)
- `fsevents` - macOS-only file watching
- Various CSS/SASS preprocessors - Not used by this project

**Status**: PASS - All required peer dependencies satisfied.

---

## Dependency Tree Summary

| Category | Count |
|----------|-------|
| Production | 125 |
| Development | 164 |
| Optional | 48 |
| **Total** | 288 |

---

## Supply Chain Analysis

**Direct Dependencies**: 4 production, 7 development

| Package | Weekly Downloads | Maintainer | Risk |
|---------|-----------------|------------|------|
| @modelcontextprotocol/sdk | High | Anthropic | LOW |
| better-sqlite3 | Very High | Active OSS | LOW |
| simple-git | Very High | Active OSS | LOW |
| zod | Very High | Active OSS | LOW |

**Status**: All dependencies are well-maintained with active communities.

---

## Recommendations

### Immediate (Before Merge)

None required - this branch does not introduce dependency changes.

### Short-term (Next Sprint)

1. **Update @modelcontextprotocol/sdk** to >= 1.24.0 (security fix)
   ```bash
   npm update @modelcontextprotocol/sdk
   ```

2. **Update minor versions** of production dependencies:
   ```bash
   npm update better-sqlite3 simple-git
   ```

### Medium-term (Next Quarter)

1. **Evaluate zod 4.x migration** - Review breaking changes, plan migration

2. **Evaluate vitest 4.x** - Wait for stable release, plan upgrade

---

## Summary

**Your Changes**:
- BLOCKING: 0
- No dependency modifications in this branch

**Code You Touched**:
- N/A - No dependency-related code changes

**Pre-existing**:
- HIGH: 1 (security vulnerability in @modelcontextprotocol/sdk)
- MEDIUM: 1 (major version available for zod)
- LOW: 8 (minor updates available)

**Dependencies Score**: 7/10
- Deducted 2 points for HIGH severity vulnerability
- Deducted 1 point for outdated packages

---

## Merge Recommendation

**APPROVED** - This branch makes no dependency changes.

However, a separate PR should be created to address the HIGH severity vulnerability in `@modelcontextprotocol/sdk` before it becomes a blocking issue for future releases.

| Issue | Status | Action |
|-------|--------|--------|
| Security vulnerability | Pre-existing | Fix in separate PR |
| Outdated packages | Pre-existing | Fix in separate PR |
| License compliance | PASS | None required |
| Peer dependencies | PASS | None required |

---

*Report generated by Dependencies Audit Agent*
*Powered by Claude Opus 4.5*
