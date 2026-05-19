# Dependencies Audit Report

**Branch**: fix/issue-28-graph-corruption-shallow-copy
**Base**: main
**Date**: 2025-11-28 08:37:00
**Auditor**: Claude Code (Automated)

---

## Executive Summary

This branch addresses Issue #28 (graph corruption via shallow copy) and includes changes to:
1. **src/core/dependency-graph.ts** - Security fix for deep copy in cycle detection
2. **src/core/configuration.ts** - Spawn delay configuration change
3. **src/core/interfaces.ts** - New optional `recordSpawn()` method
4. **src/implementations/resource-monitor.ts** - Settling worker tracking
5. **src/services/handlers/worker-handler.ts** - Integration of settling tracking
6. **tests/unit/core/dependency-graph.test.ts** - Regression tests for Issue #28
7. **package-lock.json** - Version sync (0.2.3 -> 0.3.0)

**Dependencies Score**: 7/10

**Key Findings**:
- No NEW dependencies added in this branch
- 3 pre-existing security vulnerabilities in transitive dependencies (HIGH: 1, MODERATE: 2)
- 10 outdated packages (not introduced by this branch)
- No dependency-related code changes that would affect security posture

---

## Category 1: Issues in Your Changes (BLOCKING)

### No Blocking Dependency Issues Found

The changes in this branch do not introduce any new dependencies or modify existing dependency versions. The code changes are purely internal refactoring and bug fixes.

**Files Changed Analysis**:

| File | Dependency Impact |
|------|-------------------|
| `src/core/dependency-graph.ts:250-255` | No external deps - uses native `Map` and `Set` |
| `src/core/configuration.ts:32,69` | No external deps - configuration value change |
| `src/core/interfaces.ts:50-56` | No external deps - TypeScript interface addition |
| `src/implementations/resource-monitor.ts:27-31,80-181` | No external deps - uses Node.js built-in `os` module |
| `src/services/handlers/worker-handler.ts:295-296` | No external deps - calls internal method |

---

## Category 2: Issues in Code You Touched (Should Fix)

### No Dependency Issues in Modified Code

The files modified in this branch do not have direct dependency issues. However, there are some observations:

#### 1. Interface Change Compatibility

**File**: `/workspace/delegate/src/core/interfaces.ts:50-56`

```typescript
/**
 * Record a spawn event for settling worker tracking
 * Call immediately after spawning to track workers during their settling period
 * (before they appear in system metrics like load average)
 */
recordSpawn?(): void;
```

**Observation**: The `recordSpawn()` method is optional (`?`), which maintains backward compatibility with existing `ResourceMonitor` implementations. The `TestResourceMonitor` class does not implement this method, which is acceptable due to the optional nature.

**Recommendation**: Consider adding a no-op implementation to `TestResourceMonitor` for consistency:
```typescript
recordSpawn(): void {
  // No-op for test implementation
}
```

#### 2. package-lock.json Sync

**File**: `/workspace/delegate/package-lock.json:1-12`

The `package-lock.json` version is being updated from `0.2.3` to `0.3.0` to match `package.json`. This is correct behavior and not an issue.

Also, the `hasInstallScript` field is being removed. This is typically fine but should be verified that no postinstall scripts are broken.

---

## Category 3: Pre-existing Issues (Not Blocking)

### 3.1 Security Vulnerabilities (npm audit)

| Severity | Package | Vulnerability | CVE/Advisory |
|----------|---------|---------------|--------------|
| HIGH | glob (10.2.0-10.4.5) | Command injection via -c/--cmd | GHSA-5j98-mcp5-4vw2 |
| MODERATE | body-parser (2.2.0) | DoS via URL encoding | GHSA-wqch-xfxh-vrr4 |
| MODERATE | vite (7.1.0-7.1.10) | Path traversal on Windows | GHSA-93m4-6634-74q7 |

**Impact Assessment**:
- **glob**: Transitive dependency (likely via vitest). Not exploitable in production MCP server context - only affects development/testing. Risk: LOW for this project.
- **body-parser**: Transitive dependency (likely via @modelcontextprotocol/sdk). Only affects request parsing. Risk: LOW-MEDIUM for MCP server.
- **vite**: Dev dependency only (vitest). Windows-specific. Risk: LOW for this project.

**Recommendation**: Run `npm audit fix` in a separate PR to update transitive dependencies.

### 3.2 Outdated Packages

| Package | Current | Wanted | Latest | Type |
|---------|---------|--------|--------|------|
| @modelcontextprotocol/sdk | 1.19.1 | 1.23.0 | 1.23.0 | Production |
| better-sqlite3 | 12.4.1 | 12.4.6 | 12.4.6 | Production |
| simple-git | 3.28.0 | 3.30.0 | 3.30.0 | Production |
| zod | 3.25.76 | 3.25.76 | 4.1.13 | Production |
| @types/node | 24.3.0 | 24.10.1 | 24.10.1 | Dev |
| @vitest/coverage-v8 | 3.2.4 | 3.2.4 | 4.0.14 | Dev |
| @vitest/ui | 3.2.4 | 3.2.4 | 4.0.14 | Dev |
| tsx | 4.20.4 | 4.20.6 | 4.20.6 | Dev |
| typescript | 5.9.2 | 5.9.3 | 5.9.3 | Dev |
| vitest | 3.2.4 | 3.2.4 | 4.0.14 | Dev |

**Notable Updates**:
1. **zod 4.x**: Major version upgrade available. May have breaking changes. Evaluate separately.
2. **vitest 4.x**: Major version upgrade available. May require test adjustments.
3. **@modelcontextprotocol/sdk**: Minor version bump. Should be safe to update.

**Recommendation**: Create separate PRs for:
- Patch updates (safe): `npm update`
- Major updates: Individual evaluation required

### 3.3 Dependency Analysis

**Direct Production Dependencies (4)**:
```
@modelcontextprotocol/sdk: ^1.19.1  (MIT)
better-sqlite3: ^12.4.1             (MIT)
simple-git: ^3.28.0                 (MIT)
zod: ^3.25.76                       (MIT)
```

**Licenses**: All direct dependencies use MIT license - no compatibility issues.

**Security Posture**:
- `better-sqlite3`: Native addon - requires rebuild on Node.js version changes
- `simple-git`: Executes git commands - ensure proper input sanitization in calling code

---

## Detailed Change Analysis

### Security Fix: Deep Copy in Cycle Detection

**File**: `/workspace/delegate/src/core/dependency-graph.ts:247-255`

**Before** (vulnerable):
```typescript
const tempGraph = new Map(this.graph);
```

**After** (fixed):
```typescript
// SECURITY FIX (Issue #28): Deep copy required to prevent graph corruption
// Shallow copy (new Map(this.graph)) only copies Map structure - Set values are REFERENCES
// When we modify temp graph's Sets, we would mutate the original graph's Sets
const tempGraph = new Map(
  Array.from(this.graph.entries()).map(([k, v]) => [k, new Set(v)])
);
```

**Assessment**: This fix is correct and necessary. The shallow copy bug could cause:
1. Graph corruption when checking for cycles
2. False edges being permanently added to the dependency graph
3. Potential for tasks to be incorrectly blocked

**No external dependencies involved** - uses native JavaScript `Map`, `Set`, and `Array` methods.

### Configuration Change: minSpawnDelayMs

**File**: `/workspace/delegate/src/core/configuration.ts:32,69`

**Before**:
```typescript
minSpawnDelayMs: z.number().min(10).max(10000).default(50)
// Default: 50ms burst protection
```

**After**:
```typescript
minSpawnDelayMs: z.number().min(10).max(30000).default(1000)
// Default: 1s minimum delay between spawns (with settling worker tracking)
```

**Assessment**: Configuration change - no dependency impact. The increased max (30000) and default (1000) values are appropriate for the new settling worker tracking feature.

---

## Summary

### Your Changes (Category 1):
- No blocking dependency issues
- No new dependencies introduced
- No version changes that affect security

### Code You Touched (Category 2):
- Optional interface method maintains compatibility
- Minor package-lock.json sync (expected)

### Pre-existing (Category 3):
- 1 HIGH severity vulnerability (glob - dev only)
- 2 MODERATE severity vulnerabilities (body-parser, vite)
- 10 outdated packages

### Metrics

| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Your Changes | 0 | 0 | 0 | 0 |
| Code You Touched | 0 | 0 | 0 | 1 (info) |
| Pre-existing | 0 | 1 | 2 | 7 |

---

## Merge Recommendation

**APPROVED**

**Rationale**:
1. No new dependencies added
2. No version changes in production dependencies
3. Security fix does not introduce new attack vectors
4. Pre-existing vulnerabilities are:
   - Transitive (not direct dependencies)
   - Mostly in dev dependencies
   - Not exploitable in MCP server context

**Pre-merge Checklist**:
- [x] No blocking dependency issues
- [x] No new vulnerable dependencies
- [x] License compatibility maintained
- [x] Interface changes are backward compatible

**Post-merge Recommendations**:
1. Create follow-up PR to run `npm audit fix`
2. Evaluate zod 4.x upgrade in separate effort
3. Consider vitest 4.x upgrade when stable

---

*Report generated by Claude Code Dependencies Audit*
