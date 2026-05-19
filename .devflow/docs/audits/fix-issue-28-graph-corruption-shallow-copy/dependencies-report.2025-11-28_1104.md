# Dependencies Audit Report

**Branch**: fix/issue-28-graph-corruption-shallow-copy
**Base**: main
**Date**: 2025-11-28 11:04:00

---

## Executive Summary

This branch successfully addresses **3 security vulnerabilities** via `npm audit fix`. The package-lock.json updates are legitimate security patches with no functional changes to direct dependencies.

| Severity | Before | After |
|----------|--------|-------|
| CRITICAL | 0 | 0 |
| HIGH | 1 | 0 |
| MODERATE | 2 | 0 |
| LOW | 0 | 0 |
| **Total** | **3** | **0** |

---

## Security Fixes Applied (Your Changes)

### 1. glob: 10.4.5 -> 10.5.0 (HIGH - CVE pending)

**Issue**: CLI command injection vulnerability
**File Changed**: `package-lock.json` (transitive dependency)
**Status**: FIXED

```diff
- "glob": "10.4.5"
+ "glob": "10.5.0"
```

### 2. body-parser: 2.2.0 -> 2.2.1 (MODERATE)

**Issue**: Denial of Service via malformed request body
**File Changed**: `package-lock.json` (transitive via @modelcontextprotocol/sdk -> express)
**Status**: FIXED

```diff
- "body-parser": "2.2.0"
+ "body-parser": "2.2.1"
```

### 3. vite: 7.1.9 -> 7.2.4 (MODERATE)

**Issue**: Path traversal vulnerability
**File Changed**: `package-lock.json` (dev dependency via vitest)
**Status**: FIXED

```diff
- "vite": "7.1.9"
+ "vite": "7.2.4"
```

---

## Issues in Your Changes (BLOCKING)

**None** - All changes are security fixes via npm audit. No new vulnerabilities introduced.

---

## Issues in Code You Touched (Should Fix)

**None** - The package-lock.json updates are automated security patches.

---

## Pre-existing Issues (Not Blocking)

### Outdated Dependencies

The following packages have newer versions available. These are informational and do not block merge:

| Package | Current | Wanted | Latest | Type | Risk |
|---------|---------|--------|--------|------|------|
| @modelcontextprotocol/sdk | 1.19.1 | 1.23.0 | 1.23.0 | prod | LOW - minor updates |
| @types/node | 24.3.0 | 24.10.1 | 24.10.1 | dev | LOW - type definitions |
| @vitest/coverage-v8 | 3.2.4 | 3.2.4 | 4.0.14 | dev | MEDIUM - major version |
| @vitest/ui | 3.2.4 | 3.2.4 | 4.0.14 | dev | MEDIUM - major version |
| better-sqlite3 | 12.4.1 | 12.4.6 | 12.4.6 | prod | LOW - patch updates |
| simple-git | 3.28.0 | 3.30.0 | 3.30.0 | prod | LOW - minor updates |
| tsx | 4.20.4 | 4.20.6 | 4.20.6 | dev | LOW - patch updates |
| typescript | 5.9.2 | 5.9.3 | 5.9.3 | dev | LOW - patch updates |
| vitest | 3.2.4 | 3.2.4 | 4.0.14 | dev | MEDIUM - major version |
| zod | 3.25.76 | 3.25.76 | 4.1.13 | prod | HIGH - major version |

#### Recommendations for Separate PRs:

1. **zod 3.x -> 4.x** (HIGH priority)
   - Major version bump with potential breaking changes
   - Requires dedicated migration effort
   - Create separate PR: `chore: upgrade zod to v4`

2. **vitest 3.x -> 4.x** (MEDIUM priority)
   - Major version change for test framework
   - May require test configuration updates
   - Create separate PR: `chore: upgrade vitest to v4`

3. **Minor/Patch Updates** (LOW priority)
   - `@modelcontextprotocol/sdk`, `better-sqlite3`, `simple-git`, `tsx`, `typescript`
   - Safe to batch update: `npm update`

---

## Dependency Tree Health

| Metric | Value | Status |
|--------|-------|--------|
| Total Dependencies | 288 | OK |
| Production | 125 | OK |
| Development | 164 | OK |
| Optional | 48 | OK |
| Vulnerabilities | 0 | OK |
| Deprecated Packages | 0 | OK |

---

## License Compliance

All dependencies use permissive open-source licenses:

| License | Count | Status |
|---------|-------|--------|
| MIT | 200 | OK |
| ISC | 21 | OK |
| BSD-3-Clause | 7 | OK |
| Apache-2.0 | 5 | OK |
| BlueOak-1.0.0 | 3 | OK |
| BSD-2-Clause | 1 | OK |
| MIT OR WTFPL | 1 | OK |

**Compatibility**: All licenses are compatible with MIT (project license).

---

## Supply Chain Analysis

### Direct Dependencies (Production)

| Package | Version | Downloads/Week | Last Updated | Risk |
|---------|---------|----------------|--------------|------|
| @modelcontextprotocol/sdk | 1.19.1 | High | Active | LOW |
| better-sqlite3 | 12.4.1 | High | Active | LOW |
| simple-git | 3.28.0 | High | Active | LOW |
| zod | 3.25.76 | Very High | Active | LOW |

### Transitive Dependency Updates (via npm audit fix)

| Package | Old | New | Source |
|---------|-----|-----|--------|
| debug | 4.4.1 | 4.4.3 | body-parser |
| http-errors | 2.0.0 | 2.0.1 | raw-body |
| iconv-lite | 0.6.3 | 0.7.0 | body-parser |
| raw-body | 3.0.0 | 3.0.2 | body-parser |

---

## Summary

**Your Changes:**
- 0 CRITICAL (no issues)
- 0 HIGH (no issues)
- 0 MEDIUM (no issues)

**Code You Touched:**
- 0 HIGH (no issues)
- 0 MEDIUM (no issues)

**Pre-existing (Informational):**
- 1 HIGH (zod major version outdated)
- 3 MEDIUM (vitest ecosystem major version outdated)
- 6 LOW (minor/patch updates available)

---

## Dependencies Score: 9/10

**Deductions:**
- -1: Major version lag on zod (3.x vs 4.x available)

**Strengths:**
- Zero vulnerabilities after npm audit fix
- All licenses compatible
- No deprecated packages
- Active maintenance on all direct dependencies

---

## Merge Recommendation: APPROVED

| Criteria | Status |
|----------|--------|
| Zero vulnerabilities | PASS |
| No breaking changes | PASS |
| Security fixes only | PASS |
| License compliance | PASS |

**Rationale**: This branch contains only security fixes via `npm audit fix`. All 3 vulnerabilities (1 HIGH, 2 MODERATE) have been resolved. The package-lock.json changes are transitive dependency updates that do not affect the project's direct dependencies or API.

**Post-merge Actions (Optional):**
1. Consider updating `better-sqlite3` to 12.4.6 (patch)
2. Consider updating `simple-git` to 3.30.0 (minor)
3. Plan zod 4.x migration in separate PR

---

*Generated by Dependencies Audit - 2025-11-28 11:04*
