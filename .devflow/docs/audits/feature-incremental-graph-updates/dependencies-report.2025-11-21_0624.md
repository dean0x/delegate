# Dependencies Audit Report

**Branch**: feature/incremental-graph-updates
**Base**: main
**Date**: 2025-11-21 06:24:00

---

## Executive Summary

This branch modifies **scripts only** in `package.json` and `vitest.config.ts`. No new runtime dependencies were added, no dependency versions were changed, and no security posture was altered by this PR.

**Key Finding**: The changes are internal tooling improvements (test execution strategy) with zero impact on the dependency graph.

---

## 🔴 Issues in Your Changes (BLOCKING)

**None identified.**

### Analysis of Changes

The diff shows modifications to:

1. **package.json (lines 19-32)**: Script changes only
   - Replaced `"test"` script with a safeguard warning
   - Added granular test scripts (`test:core`, `test:handlers`, etc.)
   - Added `NODE_OPTIONS='--max-old-space-size=2048'` memory limits

2. **vitest.config.ts (lines 33-50)**: Configuration changes only
   - Changed pool from `forks` to `threads`
   - Added `memoryLimit: '1024MB'` for worker restart threshold
   - Added `isolate: false` for performance

**No dependency-related changes were made:**
- No new packages added to `dependencies`
- No new packages added to `devDependencies`
- No version bumps or downgrades
- No lock file modifications (beyond potential integrity updates)

---

## ⚠️ Issues in Code You Touched (SHOULD FIX)

### 1. Validate Script - References Blocked Test Command

**File**: `/workspace/delegate/package.json`
**Line**: 51
**Severity**: MEDIUM

```json
"validate": "npm run typecheck && npm run build && npm test",
```

**Issue**: The `validate` script calls `npm test` which is now blocked with `exit 1`. This breaks the validation workflow.

**Recommendation**: Update to use `npm run test:all` or the granular test commands:
```json
"validate": "npm run typecheck && npm run build && npm run test:all",
```

### 2. Missing Memory Limit on test:stress

**File**: `/workspace/delegate/package.json`  
**Line**: 37
**Severity**: LOW

```json
"test:stress": "vitest tests/stress --timeout 300000",
```

**Issue**: Unlike other test scripts, `test:stress` lacks `NODE_OPTIONS='--max-old-space-size=2048'`. Stress tests are more likely to exhaust memory than unit tests.

**Recommendation**:
```json
"test:stress": "NODE_OPTIONS='--max-old-space-size=2048' vitest tests/stress --timeout 300000",
```

---

## ℹ️ Pre-existing Issues (OPTIONAL)

### Security Vulnerabilities (npm audit)

**2 vulnerabilities found** - these exist in main branch and are not introduced by this PR.

| Package | Severity | Description | Fix Available |
|---------|----------|-------------|---------------|
| `glob` (10.2.0 - 10.4.5) | **HIGH** | Command injection via -c/--cmd with shell:true | Yes, `npm audit fix` |
| `vite` (7.1.0 - 7.1.10) | MODERATE | server.fs.deny bypass on Windows | Yes, `npm audit fix` |

**Note**: Both are transitive dependencies (pulled in by vitest/dev tooling), not direct runtime dependencies. They do not affect production builds.

**Recommendation**: Run `npm audit fix` in a separate PR to address these.

### Outdated Dependencies

| Package | Current | Latest | Type | Risk |
|---------|---------|--------|------|------|
| `@modelcontextprotocol/sdk` | 1.19.1 | 1.22.0 | runtime | LOW - patch updates |
| `better-sqlite3` | 12.4.1 | 12.4.5 | runtime | LOW - patch updates |
| `simple-git` | 3.28.0 | 3.30.0 | runtime | LOW - minor updates |
| `vitest` | 3.2.4 | 4.0.12 | dev | MEDIUM - major version |
| `@vitest/coverage-v8` | 3.2.4 | 4.0.12 | dev | MEDIUM - major version |
| `@vitest/ui` | 3.2.4 | 4.0.12 | dev | MEDIUM - major version |
| `zod` | 3.25.76 | 4.1.12 | runtime | HIGH - major version, breaking changes |

**Recommendations**:
1. **Patch updates** (better-sqlite3, tsx, typescript, simple-git, @types/node): Safe to update
2. **Vitest 4.x**: Evaluate changelog for breaking changes before upgrade
3. **Zod 4.x**: Major version with breaking API changes - requires migration effort

### License Compatibility

All dependencies use permissive licenses compatible with MIT:
- `@modelcontextprotocol/sdk`: MIT
- `better-sqlite3`: MIT
- `simple-git`: MIT
- `zod`: MIT
- All devDependencies: MIT

**No license conflicts detected.**

---

## Dependency Changes Summary

| Category | Main Branch | This Branch | Change |
|----------|-------------|-------------|--------|
| Runtime dependencies | 4 | 4 | No change |
| Dev dependencies | 7 | 7 | No change |
| Total packages | 11 | 11 | No change |
| Known vulnerabilities | 2 | 2 | No change |
| Outdated packages | 10 | 10 | No change |

---

## Summary

**Your Changes:**
- 🔴 CRITICAL: 0
- 🔴 HIGH: 0
- MEDIUM: 0
- LOW: 0

**Code You Touched:**
- ⚠️ MEDIUM: 1 (`validate` script broken)
- ⚠️ LOW: 1 (`test:stress` missing memory limit)

**Pre-existing:**
- ℹ️ HIGH: 1 (glob vulnerability - transitive)
- ℹ️ MEDIUM: 4 (vite vulnerability + vitest major version outdated)
- ℹ️ LOW: 6 (other outdated packages)

---

## Dependencies Score: 8/10

**Deductions:**
- -1: `validate` script now broken due to test safeguard
- -1: Pre-existing security vulnerabilities (not blocking)

---

## Merge Recommendation

### ✅ APPROVED WITH CONDITIONS

**Conditions:**
1. Fix the `validate` script to use `npm run test:all` instead of `npm test`
2. (Optional) Add memory limit to `test:stress` script

**Rationale:**
- No new dependencies introduced
- No security posture degradation
- Changes are internal tooling improvements only
- Pre-existing vulnerabilities are in dev dependencies and should be addressed in a separate PR

---

## Action Items

### Before Merge (Required)
- [ ] Update `validate` script: `"validate": "npm run typecheck && npm run build && npm run test:all"`

### Separate PR (Recommended)
- [ ] Run `npm audit fix` to address glob and vite vulnerabilities
- [ ] Evaluate vitest 4.x upgrade
- [ ] Consider patch updates for runtime dependencies

---

*Report generated by Dependencies Audit*
