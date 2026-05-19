# Code Review Summary

**Branch**: feat/135-custom-orchestrators -> main
**Date**: 2026-04-22T01:58:00Z
**Reviewers**: 9 (security, architecture, performance, complexity, consistency, regression, testing, typescript, documentation)

## Merge Recommendation: BLOCK MERGE

This PR introduces a critical security vulnerability (unsanitized model string in shell examples) and an unresolved architectural conflict (snippet builders documented as single source of truth but not called by main prompt builder). Both must be fixed before merge.

---

## Issue Summary

| Category | CRITICAL | HIGH | MEDIUM | LOW | Total |
|----------|----------|------|--------|-----|-------|
| Blocking | 1 | 2 | 4 | - | **7** |
| Should Fix | - | - | 4 | - | **4** |
| Pre-existing | - | - | 3 | 4 | **7** |

---

## Blocking Issues (Must Fix Before Merge)

### 1. CRITICAL: Unsanitized Model String in Shell Command Examples
**Files**: `src/services/orchestrator-prompt.ts:74`, `src/adapters/mcp-adapter.ts:3296`
**Confidence**: 100% (validated by security + architecture reviewers)

The `model` field is validated as `z.string().min(1).max(200)` but interpolated directly into shell command instruction text (e.g., `beat run --model ${model} "<prompt>"`). A crafted model string like `"; rm -rf / #` could appear in generated examples that an AI agent might execute literally.

**Fix**: Add regex validation to restrict model names to alphanumerics, hyphens, dots, and underscores:
```typescript
model: z.string().min(1).max(200).regex(/^[a-zA-Z0-9._-]+$/, 'Model name contains invalid characters').optional()
```

---

### 2. HIGH: Snippet Builders Duplicate Inline Templates — Documentation vs Implementation Mismatch
**Files**: `src/services/orchestrator-prompt.ts:71-150, 210-241`, `tests/unit/services/orchestrator-prompt-snippets.test.ts:141-207`
**Confidence**: 100% (validated by architecture, complexity, testing, regression, performance reviewers)

**Problem**: The DECISION comment at line 12-14 states: "buildOrchestratorPrompt continues to use its own internal template variables -- **no risk of output drift** ... kept in sync as a single source of truth via this exported function." However, the implementation does NOT support this claim:

- `buildOrchestratorPrompt` uses inline variables (`stateFileSection`, `delegationSection`, `constraintsSection`)
- The snippet builders (`buildStateManagementInstructions`, `buildDelegationInstructions`, `buildConstraintInstructions`) produce nearly identical text but are NOT called by the main prompt builder
- The main builder has resilience/completion guidance and qualitative constraints not present in the inline sections
- Two independent sources of truth → inevitable drift when either is edited independently

The non-regression test only validates that `buildOrchestratorPrompt` itself is stable; it does NOT compare snippet builder output against the main prompt.

**Fix**: Refactor `buildOrchestratorPrompt` to call the snippet builders internally rather than maintaining parallel inline templates:
```typescript
const systemPrompt = `ROLE: ...

${buildStateManagementInstructions({ stateFilePath })}

${workingDirectorySection}

${buildDelegationInstructions({ agent, model })}

${buildConstraintInstructions({ maxWorkers, maxDepth })}

DECISION PROTOCOL: ...`;
```

This consolidates the text into one source of truth. The non-regression test would catch any character-level changes.

---

### 3. HIGH: handleInitCustomOrchestrator Error Response Boilerplate Inflates Function to 99 Lines
**File**: `src/adapters/mcp-adapter.ts:3230-3329`
**Confidence**: 85%

The function spans 99 lines with three separate error branches, each constructing identical `{ content: [{ type: 'text', text: JSON.stringify(...) }], isError: true }` objects. Cyclomatic complexity is estimated at 6.

**Fix**: Extract a private helper method:
```typescript
private errorResponse(error: string): MCPToolResponse {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify({ success: false, error }, null, 2) }],
    isError: true,
  };
}
```

This reduces the function to 50-60 lines and makes error branches one-liners. (Note: This is a codebase-wide improvement opportunity—many handlers share this pattern.)

---

### 4. HIGH: validatePath Called with mustExist=true — Inconsistent with CreateOrchestrator
**Files**: `src/adapters/mcp-adapter.ts:3255`, `src/cli/commands/orchestrate.ts:580`
**Confidence**: 82%

Both new call sites use `validatePath(path, undefined, true)` (requiring directory existence), but `CreateOrchestrator` calls `validatePath(data.workingDirectory)` with the default `mustExist=false`. Same field, inconsistent validation.

**Fix**: Remove the third argument to match the existing pattern in `handleCreateOrchestrator`:
```typescript
validatePath(data.workingDirectory)  // mustExist defaults to false
```

If strict existence checking is intentional for `init`, add a DECISION comment explaining the difference.

---

### 5. MEDIUM: `type: 'text' as const` Deviates from Codebase Norm
**File**: `src/adapters/mcp-adapter.ts:3237, 3261, 3287, 3313, 3326` (5 occurrences in handleInitCustomOrchestrator)
**Confidence**: 92%

The rest of the file uses `type: 'text'` (90 occurrences) without `as const`. TypeScript already narrows the literal type from the object literal context; `as const` is unnecessary.

**Fix**: Replace all 5 occurrences with `type: 'text'` to match the established pattern.

---

### 6. MEDIUM: Missing Exhaustive Switch Case with never Assertion
**File**: `src/cli/commands/orchestrate.ts:678`
**Confidence**: 82%

The `switch (parsed.kind)` handles all five variants of `OrchestrateParsed` union but has no `default` case with `never` assertion. If a future variant is added, the compiler won't flag the missing case.

**Fix**: Add exhaustive check:
```typescript
default: {
  const _exhaustive: never = parsed;
  throw new Error(`Unhandled subcommand kind: ${(_exhaustive as OrchestrateParsed).kind}`);
}
```

(This PR modified the union type, making it "code you touched".)

---

### 7. MEDIUM: Validation Error Format Diverges from Dominant Pattern
**File**: `src/adapters/mcp-adapter.ts:3232-3248`
**Confidence**: 80%

The new handler formats validation errors as `JSON.stringify({ success: false, error: ... })` but 24 other handlers use plain text: `Validation error: ${parseResult.error.message}`. Only `ConfigureAgent` uses the structured format. The 24-to-2 ratio is inconsistent.

**Fix**: Either adopt the dominant pattern for consistency or document an explicit DECISION comment explaining why stateless handlers intentionally use structured format.

---

## Should-Fix Issues (High Priority Bugs in Code You Touched)

### 1. MEDIUM: Parser Arg Duplication — parseOrchestrateInitArgs vs parseOrchestrateCreateArgs
**File**: `src/cli/commands/orchestrate.ts:142-216, 226-274`
**Confidence**: 82%

Both parsers share 5 out of 7 flag-parsing branches (--working-directory, --agent, --model, --max-depth, --max-workers) with identical logic. Maintenance cost: a bug fix or new shared flag requires updates in two places.

**Fix**: Extract a shared `parseCommonOrchestrateFlags` helper that both variants call.

---

### 2. MEDIUM: No Test for Snippet Builder Drift Detection
**File**: `tests/unit/services/orchestrator-prompt-snippets.test.ts`
**Confidence**: 85%

The non-regression test only checks that `buildOrchestratorPrompt` still works; it does NOT compare snippet builder output against the main prompt builder. If either is edited independently in the future, the two paths will diverge silently.

**Fix**: Add a test that extracts sections from `buildOrchestratorPrompt().systemPrompt` and asserts that key structural markers (e.g., `beat run`, `beat status`, `Max concurrent workers`) appear in the corresponding snippet builder output.

---

### 3. MEDIUM: MCP Adapter Test Does Not Cover scaffoldCustomOrchestrator Failure Path
**File**: `tests/unit/adapters/init-custom-orchestrator.test.ts`
**Confidence**: 82%

The test covers Zod validation failure and path validation failure but not the scenario where `scaffoldCustomOrchestrator` returns an error (e.g., disk full, permissions).

**Fix**: Mock `writeStateFile` to throw an error and verify the adapter catches and returns the error with proper format.

---

### 4. MEDIUM: CLI Handler has No Test Coverage
**File**: `src/cli/commands/orchestrate.ts:578-639`
**Confidence**: 83%

The new `handleOrchestrateInit` function (path validation, scaffolding, formatted output) has zero test coverage. Only `parseOrchestrateInitArgs` is tested. (This follows the existing pattern where handlers aren't unit-tested, but since `init` is new with non-trivial logic, it would benefit from at least a smoke test.)

---

## Pre-existing Issues (Informational)

### HIGH
- **mcp-adapter.ts is 3514 lines** — Exceeds CRITICAL threshold of 500 lines (informational; each new MCP tool adds ~150-200 lines)
- **Duplicate state-file setup logic** between orchestration-manager.ts and orchestrator-scaffold.ts

### MEDIUM
- **Orphaned state files from custom orchestrators accumulate indefinitely** (no automatic cleanup)
- **State file path exposed in MCP response** (reveals home directory path; consistent with CreateOrchestrator design)
- **Exit condition script permissions** (mkdirSync with recursive:true may not apply mode to parent directories)
- **CLAUDE.md Documentation Structure not updated** with new docs/CUSTOM_ORCHESTRATORS.md file
- **docs/CUSTOM_ORCHESTRATORS.md flag table inaccurate** for --working-directory description

---

## Key Insights

1. **Security + Architecture synergy**: The model string vulnerability and documentation mismatch both stem from the same root — insufficient validation at the MCP boundary combined with multiple sources of truth.

2. **Snippet builder design is sound, but implementation doesn't match documentation**: The builders are pure, testable functions placed correctly in the codebase. The issue is that the main prompt builder was not refactored to call them, violating the "single source of truth" claim.

3. **Test suite is structurally sound but has coverage gaps**: 4 test files with 883 lines follow AAA pattern, use real temp directories, and avoid brittle implementation coupling. The gaps are in drift detection and error path coverage.

4. **Consistency issues are straightforward fixes**: Type annotations, validation patterns, and error formatting follow established conventions; the new code deviates in a few places but all deviations are fixable in <5 minutes per issue.

5. **Documentation asymmetry between CLI and MCP**: The CLI doesn't embed working directory in the suggested loop command, but the MCP usage includes it. This creates confusion for users following different paths.

---

## Action Plan

**Before Merge** (blocker fixes, estimated 1-2 hours):
1. Add model string regex validation (5 min)
2. Refactor buildOrchestratorPrompt to call snippet builders (30-45 min)
3. Extract error response helper in MCP adapter (10 min)
4. Add exhaustive switch default case (5 min)
5. Fix validatePath mustExist inconsistency (5 min)
6. Fix type annotation inconsistencies (5 min)
7. Fix validation error format (10 min)

**Post-Merge (should-fix, estimated 1-2 hours)**:
8. Extract parseCommonOrchestrateFlags helper (15 min)
9. Add snippet drift detection test (15 min)
10. Add scaffold error path test (15 min)
11. Add CLI handler smoke test (20 min)
12. Update CLAUDE.md documentation index (5 min)
13. Fix flag table description in docs (5 min)

**Follow-up (optional, separate PR)**:
- Clean up orphaned state files (cleanup mechanism or --prune flag)
- Consolidate state-file setup logic into single function
- Refactor mcp-adapter.ts to reduce file size
