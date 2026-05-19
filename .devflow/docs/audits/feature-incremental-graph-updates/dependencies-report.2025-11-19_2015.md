# Dependencies Audit Report

**Branch**: feature/incremental-graph-updates
**Base**: main
**Date**: 2025-11-19 20:16:21

---

## 🔴 Issues in Your Changes (BLOCKING)

**No blocking issues found.**

This branch does NOT modify `package.json` or `package-lock.json`. All changes are implementation-only:
- `src/core/dependency-graph.ts` (+93 lines)
- `src/implementations/dependency-repository.ts` (refactored)
- `tests/unit/core/dependency-graph.test.ts` (+282 lines)

No new dependencies were added or removed in this PR.

---

## ⚠️ Issues in Code You Touched (Should Fix)

**No dependency-specific issues in touched code.**

The modified files do not introduce dependency-related concerns:
- Pure TypeScript implementation changes
- No new external package imports
- Refactoring existing dependency management logic

---

## ℹ️ Pre-existing Issues (Not Blocking)

### 1. Security Vulnerabilities (Pre-existing)

#### MODERATE: vite - Path Traversal on Windows
- **Severity**: MODERATE
- **Package**: `vite` (dev dependency via vitest)
- **Current Version**: 7.1.0-7.1.10
- **CVE**: GHSA-93m4-6634-74q7
- **CVSS**: Not scored (Windows-specific)
- **Description**: vite allows `server.fs.deny` bypass via backslash on Windows
- **Impact**: Dev-only dependency (test tooling), not production code
- **Fix Available**: Yes
- **Recommendation**: 
  ```bash
  npm audit fix
  ```
  This will update vitest's transitive vite dependency to a patched version.

#### HIGH: glob - Command Injection
- **Severity**: HIGH
- **Package**: `glob` (dev dependency via vitest)
- **Current Version**: 10.2.0-10.4.5
- **CVE**: GHSA-5j98-mcp5-4vw2
- **CVSS**: 7.5 (High)
- **CWE**: CWE-78 (Command Injection)
- **Description**: glob CLI allows command injection via `-c/--cmd` flag executing matches with `shell:true`
- **Impact**: Dev-only dependency (test tooling), not production code. Requires attacker control over glob CLI arguments.
- **Fix Available**: Yes
- **Recommendation**: 
  ```bash
  npm audit fix
  ```
  This will update to glob >= 10.5.0.

**Risk Assessment**: Both vulnerabilities are in dev dependencies used only during testing. They do NOT affect production runtime. However, they should be fixed to maintain security hygiene.

---

### 2. Outdated Dependencies (Pre-existing)

#### Production Dependencies

**MEDIUM: @modelcontextprotocol/sdk**
- **Severity**: MEDIUM
- **Current**: 1.19.1
- **Wanted**: 1.22.0
- **Latest**: 1.22.0
- **Type**: Production dependency
- **Description**: Core MCP SDK is 3 minor versions behind
- **Recommendation**: 
  ```bash
  npm update @modelcontextprotocol/sdk
  ```
  Review changelog for breaking changes before updating.

**LOW: simple-git**
- **Severity**: LOW
- **Current**: 3.28.0
- **Wanted**: 3.30.0
- **Latest**: 3.30.0
- **Type**: Production dependency
- **Description**: 2 patch versions behind
- **Recommendation**: 
  ```bash
  npm update simple-git
  ```

**CRITICAL: zod**
- **Severity**: CRITICAL (Major version behind)
- **Current**: 3.25.76
- **Latest**: 4.1.12
- **Type**: Production dependency
- **Description**: Major version upgrade available (v3 → v4)
- **Breaking Changes**: Yes (major version bump)
- **Recommendation**: 
  - Do NOT auto-update (breaking changes)
  - Plan migration to v4 in separate PR
  - Review v4 migration guide: https://github.com/colinhacks/zod/releases
  - Current v3.25.76 is still maintained

#### Development Dependencies

**LOW: @types/node**
- **Severity**: LOW
- **Current**: 24.3.0
- **Wanted**: 24.10.1
- **Latest**: 24.10.1
- **Type**: Dev dependency
- **Recommendation**: 
  ```bash
  npm update @types/node
  ```

**LOW: typescript**
- **Severity**: LOW
- **Current**: 5.9.2
- **Wanted**: 5.9.3
- **Latest**: 5.9.3
- **Type**: Dev dependency
- **Recommendation**: 
  ```bash
  npm update typescript
  ```

**LOW: tsx**
- **Severity**: LOW
- **Current**: 4.20.4
- **Wanted**: 4.20.6
- **Latest**: 4.20.6
- **Type**: Dev dependency
- **Recommendation**: 
  ```bash
  npm update tsx
  ```

**INFO: vitest ecosystem**
- **Severity**: INFO
- **Current**: 3.2.4
- **Latest**: 4.0.10
- **Packages**: vitest, @vitest/coverage-v8, @vitest/ui
- **Description**: Major version upgrade available (v3 → v4)
- **Breaking Changes**: Yes (major version bump)
- **Recommendation**: 
  - Do NOT auto-update (breaking changes)
  - Plan migration to v4 in separate PR
  - Current v3.2.4 is still supported

---

### 3. License Compliance (Pre-existing)

**STATUS: COMPLIANT**

All dependencies use permissive licenses compatible with MIT:
- **MIT License**: @modelcontextprotocol/sdk, better-sqlite3, simple-git, typescript, tsx, vitest
- **Apache 2.0**: zod (compatible with MIT)
- **ISC**: Various transitive dependencies (compatible with MIT)

**No GPL or restrictive licenses detected.**

---

### 4. Dependency Health Metrics

**Total Dependencies**: 289
- Production: 126
- Development: 164
- Optional: 48

**Vulnerability Summary**:
- Critical: 0
- High: 1 (dev-only)
- Moderate: 1 (dev-only)
- Low: 0
- Info: 0

**Update Summary**:
- Major versions behind: 2 (zod, vitest)
- Minor versions behind: 1 (@modelcontextprotocol/sdk)
- Patch versions behind: 5

---

## Summary

### Your Changes (feature/incremental-graph-updates):
- **New dependencies added**: 0
- **Dependencies removed**: 0
- **Dependencies modified**: 0
- **Security issues introduced**: 0

### Pre-existing Issues:
- 🔴 **CRITICAL**: 1 (zod major version v4 available - planned upgrade)
- ⚠️ **HIGH**: 1 (glob command injection in dev deps - fixable)
- ⚠️ **MEDIUM**: 2 (vite path traversal, @modelcontextprotocol/sdk outdated)
- ℹ️ **LOW**: 4 (minor dev dependency updates)

### Dependencies Score: 7/10

**Breakdown**:
- Security: 8/10 (vulnerabilities in dev deps only, fixable)
- Freshness: 6/10 (2 major versions behind, several minor updates available)
- License Compliance: 10/10 (all permissive licenses)
- Production Impact: 10/10 (no production vulnerabilities)

---

## Merge Recommendation

### ✅ APPROVED

**Rationale**: This branch introduces ZERO dependency changes. All identified issues are pre-existing and affect the main branch.

**Action Items for Separate PRs**:

1. **Immediate (Security)**:
   ```bash
   npm audit fix
   ```
   Fixes glob and vite vulnerabilities in dev dependencies.

2. **Short-term (Stability)**:
   ```bash
   npm update @modelcontextprotocol/sdk simple-git @types/node typescript tsx
   ```
   Updates production dependencies to latest compatible versions.

3. **Long-term (Major Upgrades)**:
   - Plan zod v3 → v4 migration (breaking changes)
   - Plan vitest v3 → v4 migration (breaking changes)
   - Review changelogs and create migration PRs

---

## Recommended Commands

```bash
# Fix security vulnerabilities (run after merge)
npm audit fix

# Update non-breaking dependencies (run after merge)
npm update @modelcontextprotocol/sdk simple-git @types/node typescript tsx

# Check for remaining issues
npm audit
npm outdated

# For major version upgrades (separate PRs):
# - zod v4 migration
# - vitest v4 migration
```

---

**Generated**: 2025-11-19 20:16:21
**Auditor**: Claude Code Dependencies Specialist
**Report Location**: `/workspace/delegate/.docs/audits/feature-incremental-graph-updates/dependencies-report.2025-11-19_2015.md`
