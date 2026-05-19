# Code Review Summary

**Branch**: feat/134-system-prompt-support -> main
**Date**: 2026-04-18_2349
**Reviewers**: 8 parallel agents (security, architecture, performance, complexity, consistency, regression, testing, typescript)

## Merge Recommendation: CHANGES_REQUESTED

The system prompt feature is architecturally sound and well-tested, but **3 blocking issues** across architectural, consistency, and TypeScript domains must be resolved before merge. These are fixable in 1-2 hours with straightforward refactors; none require design changes.

---

## Issue Summary

| Category | CRITICAL | HIGH | MEDIUM | LOW | Total |
|----------|----------|------|--------|-----|-------|
| **Blocking** | 0 | 3 | 1 | 0 | **4** |
| **Should Fix** | 0 | 1 | 0 | 0 | **1** |
| **Pre-existing** | 0 | 0 | 7 | 0 | **7** |

**Total Issues Found**: 12  
**Confidence ≥80% (blocking threshold)**: 9  
**Deferred/Pre-existing**: 7 (informational only)

---

## Blocking Issues

### 1. ARCHITECTURE: Duplicated operational knowledge (HIGH) — 85% confidence
**File**: `src/services/orchestrator-prompt.ts:56-161`

**Problem**: The `operationalContract` (lines 141-159) manually duplicates content from the `systemPrompt` (lines 56-134). Both reference the state file path, working directory, beat CLI commands, and constraints. When either section is updated, the other must be manually kept in sync — a DRY violation that will drift over time.

**Impact**: Maintenance hazard. Future updates to prompt content risk leaving `operationalContract` stale, causing orchestrator agents with custom system prompts to lose operational knowledge.

**Fix**: Extract shared sections into named constants, then compose both prompts:
```typescript
const stateFileSection = `STATE FILE: ${stateFilePath}\n...`;
const cliCommandsSection = `DELEGATION (via beat CLI):\n...`;
const constraintsSection = `CONSTRAINTS:\n...`;

const operationalContract = `REQUIRED -- ORCHESTRATOR CONTRACT:\n\n${stateFileSection}\n${cliCommandsSection}\n${constraintsSection}`;
const systemPrompt = `ROLE: ...\n\n${stateFileSection}\n\n...full sections...\n\n${constraintsSection}\n\n...`;
```

**Estimated effort**: 30 minutes  
**Merge blocker**: YES — must fix before merge

---

### 2. CONSISTENCY: Pipeline systemPrompt asymmetry (HIGH) — 90% confidence
**File**: `src/services/schedule-manager.ts:363-371`

**Problem**: `createPipeline()` threads `priority`, `workingDirectory`, `agent`, and `model` to per-step schedules but does not thread `systemPrompt`. Meanwhile, `PipelineCreateRequest` lacks a `systemPrompt` field entirely, while `ScheduledPipelineCreateRequest` includes it and correctly threads it. This creates silent asymmetry: scheduled pipelines support custom system prompts, but immediate (non-scheduled) pipelines do not.

**Impact**: Users of the MCP `CreatePipeline` tool cannot pass system prompts, while `SchedulePipeline` users can. This is an API consistency gap.

**Fix**: Add `systemPrompt?: string` to both `PipelineCreateRequest` and `PipelineStepRequest` (in `src/core/domain.ts`), then thread it through `createPipeline()`:
```typescript
systemPrompt: step.systemPrompt ?? request.systemPrompt,
```

**Estimated effort**: 15 minutes (update 2 types + 1 method)  
**Merge blocker**: YES — inconsistent API

---

### 3. TYPESCRIPT: Non-null assertion bypasses narrowing (HIGH) — 90% confidence
**File**: `src/services/orchestration-manager.ts:228`

**Problem**: `request.systemPrompt!` uses a non-null assertion despite being guarded by `hasCustomSystemPrompt = Boolean(request.systemPrompt?.trim())`. TypeScript cannot narrow through a separate boolean variable, so the `!` bypasses the compiler's type safety. If the guard logic is refactored, the assertion becomes a latent crash site.

**Impact**: Reduced type safety. The guard should be expressible without `!` by restructuring the control flow.

**Fix**: Use inline narrowing with the trimmed value to eliminate both the separate `hasCustomSystemPrompt` variable and the `!` assertion:
```typescript
const customSystemPrompt = request.systemPrompt?.trim();
const finalSystemPrompt = customSystemPrompt ? request.systemPrompt : orchestratorSystemPrompt;
const finalUserPrompt = customSystemPrompt
  ? `${operationalContract}\n\n${userPrompt}`
  : userPrompt;
```

This also simplifies the logic by eliminating a variable.

**Estimated effort**: 10 minutes  
**Merge blocker**: YES — violates TypeScript strict-nulls discipline

---

### 4. TESTING: Uninitialized variable with non-null assertion (MEDIUM) — 85% confidence
**File**: `tests/unit/implementations/agent-adapters.test.ts:980`

**Problem**: `result` is declared with `let result: ReturnType<typeof adapter.spawn>` and assigned inside a `try` block (line 969). The assertion `result!.ok` on line 980 uses a non-null assertion on a potentially uninitialized variable. If `adapter.spawn()` throws, `result` is never assigned and `result!` crashes with a misleading `TypeError` instead of a clear failure message.

**Impact**: Test robustness. While the current code path never throws, the non-null assertion obscures the root cause if an exception occurs.

**Fix**: Initialize or assert definite assignment before accessing:
```typescript
let result: ReturnType<typeof adapter.spawn> | undefined;
try {
  result = adapter.spawn({ ... });
} finally {
  consoleSpy.mockRestore();
  adapter.dispose();
}
expect(result).toBeDefined();
expect(result!.ok).toBe(true);
```

**Estimated effort**: 5 minutes  
**Merge blocker**: YES — test robustness concern (test is blocking PR per review methodology)

---

## Should Fix Issues

### 1. COMPLEXITY: `createOrchestration()` exceeds 200-line limit (HIGH) — 85% confidence
**File**: `src/services/orchestration-manager.ts:60-316` (257 lines)

**Problem**: The `createOrchestration()` method spans 257 lines and handles 8+ distinct responsibilities: input validation, state file setup, orchestration persistence, compensation logic, prompt construction, loop creation, conditional status updates, and event emission. This PR adds 25 more lines to an already large method. The sheer length makes it difficult to review changes in isolation and increases risk of bugs in adjacent sections.

**Impact**: Code review burden. Developers modifying prompt logic must mentally load the entire compensation flow and state file setup. Future changes become riskier.

**Fix**: Extract the prompt construction section (lines 205-249) into a private method:
```typescript
private buildFinalPrompts(
  request: OrchestratorCreateRequest,
  orchestration: Orchestration,
  stateFilePath: string,
  validatedWorkingDirectory: string,
  agent: AgentProvider,
): { finalSystemPrompt: string; finalUserPrompt: string } {
  const { systemPrompt: orchestratorSystemPrompt, userPrompt, operationalContract } =
    buildOrchestratorPrompt({ ... });
  const customSystemPrompt = request.systemPrompt?.trim();
  const finalSystemPrompt = customSystemPrompt ? request.systemPrompt : orchestratorSystemPrompt;
  const finalUserPrompt = customSystemPrompt
    ? `${operationalContract}\n\n${userPrompt}`
    : userPrompt;
  return { finalSystemPrompt, finalUserPrompt };
}
```

Additionally, extract input validation (lines 73-103) and state file setup (lines 109-151) into separate methods to bring each under 50 lines.

**Estimated effort**: 1-1.5 hours  
**Merge blocker**: NO — may be deferred to follow-up PR if urgent, but should be addressed soon

---

## Pre-existing Issues (Informational Only)

### 1. SECURITY: Path traversal in `buildCombinedFile` (MEDIUM) — 65% confidence
**File**: `src/implementations/gemini-adapter.ts:40`

The `buildCombinedFile` method accepts an arbitrary `outputPath` string and writes to it via `writeFileSync` without validating that it's within the expected cache directory. While the caller (`base-agent-adapter.ts:195`) constructs the path safely (UUID-based taskId), the method signature is public and a future caller could pass an attacker-controlled path.

**Mitigation**: Apply the same `path.resolve` + `startsWith` guard used in `cleanupTaskFile`.

---

### 2. ARCHITECTURE: Synchronous I/O on spawn path (MEDIUM) — 82% confidence
**File**: `src/implementations/gemini-adapter.ts:32, 60, 71`

The `GeminiBasePromptCache` uses `writeFileSync`, `readFileSync`, and `mkdirSync` synchronously. These block the event loop during task spawn. However, mitigating factors: (1) mkdirSync runs once at startup (moved from `buildCombinedFile`), (2) `buildCombinedFile` called once per task, (3) cache avoids repeated reads, (4) files are small (<64KB). This is a known architectural exception noted in prior reviews and deferred for "cache class extraction."

**Note**: The `mkdirSync` hoisting in this PR is a performance improvement (avoids redundant calls).

---

### 3. ARCHITECTURE: Runtime registry lookup during cleanup (MEDIUM) — 80% confidence
**File**: `src/implementations/event-driven-worker-pool.ts:307-318`

The `cleanupWorkerState` method resolves the adapter via `this.agentRegistry.get(worker.task.agent ?? 'claude')` at cleanup time. This is a runtime lookup in what should be a fast path. If the registry is disposed or the adapter is deregistered, the lookup fails silently. The `?? 'claude'` fallback also masks missing agent assignment.

**Recommended fix**: Store the adapter reference on `WorkerState` at spawn time to eliminate the runtime lookup.

---

### 4-7. PERFORMANCE & SUGGESTIONS: Minor observations
- **Lazy operationalContract construction** (60% confidence) — String is always built even when unused; negligible cost
- **Test setup duplication** (70% confidence) — Helper function could reduce boilerplate in adapter cleanup tests
- **Test naming convention** (65% confidence) — Minor stylistic observation; not a violation

---

## Summary by Reviewer Focus

| Focus | Score | Recommendation | Issues |
|-------|-------|-----------------|--------|
| **Security** | 9/10 | APPROVED | 0 blocking; 1 pre-existing |
| **Architecture** | 8/10 | APPROVED_WITH_CONDITIONS | 1 blocking; 2 pre-existing |
| **Performance** | 9/10 | APPROVED | 0 blocking; 0 pre-existing |
| **Complexity** | 7/10 | APPROVED_WITH_CONDITIONS | 0 blocking; 1 should-fix |
| **Consistency** | 8/10 | CHANGES_REQUESTED | 1 blocking |
| **Regression** | 9/10 | APPROVED | 0 blocking; 0 pre-existing |
| **Testing** | 9/10 | APPROVED_WITH_CONDITIONS | 1 blocking |
| **TypeScript** | 8/10 | APPROVED_WITH_CONDITIONS | 1 blocking |

---

## Positive Patterns Observed

1. **Strong architectural alignment** — System prompt feature correctly follows project's established patterns (DI, event-driven, immutability, Strategy pattern for agent adapters)
2. **Comprehensive test coverage** — 37+ new tests across all layers (adapters, repositories, services, integration)
3. **Security best practices** — Path traversal guards, restrictive file permissions (0o700 / 0o600), try/catch around cleanup to prevent resource leaks
4. **Backward compatibility** — All changes additive (optional fields); no breaking changes; existing flows unchanged
5. **Error handling consistency** — Result types used throughout; structured logging with context

---

## Action Plan (to Unblock Merge)

**Priority 1 (Must fix — 1.5 hours):**
1. Extract shared prompt sections in `orchestrator-prompt.ts` to eliminate duplication
2. Add `systemPrompt` field to `PipelineCreateRequest` and thread through `createPipeline()`
3. Refactor `request.systemPrompt!` in `orchestration-manager.ts` to eliminate non-null assertion

**Priority 2 (Should fix — 1-1.5 hours, may defer):**
4. Extract prompt construction into `buildFinalPrompts()` private method to reduce `createOrchestration()` size

**Priority 3 (Test robustness):**
5. Fix uninitialized variable assertion in agent-adapters.test.ts

**Estimated total time to address blocking issues**: 1.5-2 hours

After fixes, run full test suite (`npm run test:all` in terminal, or grouped suites in Claude Code) to confirm no regressions.

---

## Notes

- **PR Size**: 13 commits, 25+ files, 565 additions / 22 deletions — appropriate for a full-stack feature
- **Code Quality**: No CRITICAL issues; architecture is sound
- **Test Health**: 2,397 tests passing; all new tests well-structured
- **Deferred Item**: GeminiSystemPromptCache class extraction remains deferred (noted as pre-existing exception)
