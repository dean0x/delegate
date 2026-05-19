# Code Review Summary

**Branch**: feat/134-system-prompt-support -> main
**Date**: 2026-04-17T22:18
**Reviewers**: 9 agents (security, architecture, performance, complexity, consistency, regression, testing, typescript, database)

## Merge Recommendation: CHANGES_REQUESTED

**Critical blocker**: Two HIGH issues in database layer cause silent data loss. The `systemPrompt` field is correctly threaded through the application but **Zod schemas in the schedule repository strip it during deserialization**, making all scheduled tasks (single-task, pipeline, loop) lose their system prompts on the first trigger after persistence. This is a silent, critical bug that must be fixed before merge.

Additional blockers: HIGH performance issue (synchronous mkdir per spawn), HIGH test gap (GeminiBasePromptCache entirely untested), MEDIUM security issue (path traversal guard), and 4 other MEDIUM issues.

---

## Issue Summary

| Category | CRITICAL | HIGH | MEDIUM | LOW | Total |
|----------|----------|------|--------|-----|-------|
| Blocking | 0 | 4 | 6 | 0 | **10** |
| Should Fix | 0 | 0 | 2 | 0 | **2** |
| Pre-existing | 0 | 0 | 3 | 0 | **3** |

---

## Blocking Issues (Must Fix Before Merge)

### CRITICAL

(None)

### HIGH (4 total)

**1. Database: Missing `systemPrompt` in schedule repository TaskRequestSchema** — `src/implementations/schedule-repository.ts:78-95`
- **Confidence**: 95%
- **Problem**: The `TaskRequestSchema` Zod schema omits `systemPrompt` even though `schedule-manager.ts` stores it in the `taskTemplate` JSON blob. On schedule persistence and reload, Zod strips the unknown field, silently discarding the system prompt. Next trigger creates tasks without it.
- **Impact**: CRITICAL silent data loss. All single-task and pipeline schedules lose system prompts after first trigger.
- **Fix**: Add `systemPrompt: z.string().optional()` to TaskRequestSchema.

**2. Database: Missing `systemPrompt` in schedule repository LoopConfigSchema** — `src/implementations/schedule-repository.ts:124-142`
- **Confidence**: 92%
- **Problem**: Same class of bug as above. `LoopConfigSchema` omits `systemPrompt` even though `LoopCreateRequest` defines it. Scheduled loops silently lose system prompts on database round-trip.
- **Impact**: CRITICAL silent data loss for scheduled loops.
- **Fix**: Add `systemPrompt: z.string().optional()` to LoopConfigSchema.

**3. Performance: Synchronous mkdir on every Gemini spawn** — `src/implementations/gemini-adapter.ts:37-59`
- **Confidence**: 85%
- **Problem**: `buildCombinedFile()` calls `mkdirSync()` on every task spawn that has a system prompt. Under concurrent Gemini spawning (e.g., maxWorkers=5), this serializes I/O on the event loop. The directory is stable and could be created once in the constructor.
- **Impact**: Blocks event loop, serializes Gemini task spawning under concurrency.
- **Fix**: Move `mkdirSync(this.#cacheDir, { recursive: true, mode: 0o700 })` to constructor, remove from `buildCombinedFile()`.

**4. Testing: No unit tests for GeminiBasePromptCache class** — `src/implementations/gemini-adapter.ts:17-95`
- **Confidence**: 92%
- **Problem**: The newly extracted class (commit abbd413) contains non-trivial logic: in-memory caching, staleness checks (30-day TTL), byte-size guards (64KB), file I/O, cleanup. Zero dedicated unit tests. The class could contain edge case bugs that are masked by end-to-end adapter tests.
- **Impact**: Untestable critical path for Gemini prompts (staleness handling, size fallback, invalidation, cleanup).
- **Fix**: Add dedicated `describe('GeminiBasePromptCache')` test suite in `agent-adapters.test.ts` covering:
  - Cache miss (no base file exists)
  - Staleness rejection (>30 days)
  - Size fallback (combined >64KB)
  - Memory cache hit (second call skips disk)
  - `invalidate()` forces re-read
  - `cleanupTaskFile()` succeeds and handles missing files

### MEDIUM (6 total)

**5. Security: Path traversal in GeminiBasePromptCache.cleanupTaskFile** — `src/implementations/gemini-adapter.ts:63-68`
- **Confidence**: 82%
- **Problem**: `cleanupTaskFile(taskId)` constructs a path via `path.join(this.#cacheDir, \`${taskId}.md\`)` and calls `unlinkSync()` without path containment validation. While task IDs are UUID-based in production, the defensive pattern (e.g., from `orchestration-manager.ts:136-140`) is absent.
- **Fix**: Add path containment check before unlinkSync:
  ```typescript
  const filePath = path.resolve(path.join(this.#cacheDir, `${taskId}.md`));
  const resolvedCacheDir = path.resolve(this.#cacheDir);
  if (!filePath.startsWith(resolvedCacheDir + path.sep)) return;
  ```

**6. Architecture: Schedule handler threads systemPrompt via taskTemplate but ScheduleLoop path does not** — `src/services/schedule-manager.ts:508-514`
- **Confidence**: 82%
- **Problem**: In `createScheduledLoop`, the `taskTemplate` omits `systemPrompt` while single-task and pipeline paths include it (lines 75, 304). This inconsistency means shape divergence if any code reads `schedule.taskTemplate.systemPrompt` for a loop.
- **Fix**: Add `systemPrompt: request.loopConfig.systemPrompt` to the taskTemplate object in `createScheduledLoop`.

**7. Testing: No tests for systemPrompt threading through schedule MCP tools** — `src/services/schedule-manager.ts:75`, `src/adapters/mcp-adapter.ts` schemas
- **Confidence**: 88%
- **Problem**: Three MCP tools (`ScheduleTask`, `SchedulePipeline`, `ScheduleLoop`) now accept `systemPrompt` fields, but none have test coverage. The pipeline step propagation (`systemPrompt: defaults.systemPrompt`) at `schedule-handler.ts:401` is untested — if the field is dropped, scheduled pipeline tasks silently lose system prompts.
- **Fix**: Add tests in `mcp-adapter.test.ts` for all three schedule tools verifying `systemPrompt` persists. Add test in schedule-handler suite verifying pipeline step inheritance.

**8. TypeScript: `as AgentProvider` cast bypasses Zod validation on new data** — `src/adapters/mcp-adapter.ts:2861` (and pre-existing pattern)
- **Confidence**: 82%
- **Problem**: `data.agent as AgentProvider | undefined` on Zod-parsed data (line 2861 in ScheduleLoop handler). Since the Zod schema uses `z.string()` (not `.enum()`), the cast silently passes invalid agent strings downstream.
- **Impact**: New ScheduleLoop MCP tool can accept invalid agents without runtime validation.
- **Note**: Pre-existing pattern (9+ lines), but line 2861 is new in this PR.
- **Fix**: Change schema to `z.enum(AGENT_PROVIDERS_TUPLE)` or apply cast narrowing. This is a consistency pass, not blocking if existing code uses this pattern.

**9. Performance: Worker pool registry lookup on every cleanup call** — `src/implementations/event-driven-worker-pool.ts:308-311`
- **Confidence**: 82%
- **Problem**: `cleanupWorkerState()` calls `this.agentRegistry.get(worker.task.agent)` for every completion with systemPrompt. The adapter was already resolved during spawn but isn't retained.
- **Fix**: Store adapter reference on WorkerState during registerWorker, use it directly in cleanup without re-resolving.

**10. Testing: Mock AgentAdapter missing cleanup() method** — `tests/unit/implementations/agent-registry.test.ts:13-20`
- **Confidence**: 82%
- **Problem**: `createMockAdapter()` returns `{ provider, spawn, kill, dispose }` but omits the newly-added `cleanup: vi.fn()` method. If any test calls cleanup, it will throw.
- **Fix**: Add `cleanup: vi.fn()` to the mock factory.

---

## Should-Fix Issues (Lower Priority, Same File/Function)

### MEDIUM (2 total)

**1. Testing: Worker pool cleanup delegation untested** — `src/implementations/event-driven-worker-pool.ts:304-312`
- **Confidence**: 85%
- **Problem**: The refactor from direct `unlinkSync` to `agentAdapter.cleanup(taskId)` is behavioral but untested. No tests verify that cleanup is called on the correct adapter, skipped when no systemPrompt, or handles thrown cleanup().
- **Fix**: Add tests verifying:
  - cleanup(taskId) called on correct adapter when worker with systemPrompt completes
  - cleanup() NOT called when task has no systemPrompt
  - Worker cleanup completes even if cleanup() throws

**2. Testing: Gemini adapter test console.error spy may leak** — `tests/unit/implementations/agent-adapters.test.ts:968`
- **Confidence**: 80%
- **Problem**: Test creates `vi.spyOn(console, 'error')` and calls `mockRestore()` inline. If test fails before restore, spy leaks into subsequent tests.
- **Fix**: Use try/finally or beforeEach/afterEach.

---

## Pre-existing Issues (Informational, Not Blocking)

### MEDIUM (3 total)

**1. Consistency: Inconsistent dash-guard pattern across CLI flags** — `src/cli.ts`, `src/cli/commands/loop.ts`, `src/cli/commands/orchestrate.ts`
- **Confidence**: 85%
- **Problem**: `--system-prompt` correctly uses `next === undefined` (accepting dash-prefixed values), but sibling flags like `--agent` use `!next.startsWith('-')`. This is intentional and correct (system prompts are freeform), but undocumented.
- **Note**: Reviewers agree this is a deliberate design choice, not a bug.
- **Suggestion**: Add inline comment explaining why `--system-prompt` differs from sibling flags.

**2. Complexity: CLI run command arg-parsing block is 162 lines with 5 nesting levels** — `src/cli.ts:63-224`
- **Confidence**: 82%
- **Problem**: Pre-existing pattern. The incremental addition of `--system-prompt` extends the if/else-if chain (now 10 branches).
- **Suggestion**: Future refactor could extract into `parseRunArgs()` helper (mirroring existing `parseLoopCreateArgs`, `parseOrchestrateCreateArgs`).

**3. Complexity: parseLoopCreateArgs is 153 lines with 21-branch if/else-if chain** — `src/cli/commands/loop.ts:211-363`
- **Confidence**: 85%
- **Problem**: Pre-existing. The system prompt branch (lines 318-323) was modified in this diff, but overall length is pre-existing.
- **Suggestion**: Consider table-driven parser pattern to flatten chain.

---

## Action Plan

### Phase 1: Critical Fixes (Must Merge)
1. Add `systemPrompt: z.string().optional()` to `TaskRequestSchema` in schedule-repository.ts
2. Add `systemPrompt: z.string().optional()` to `LoopConfigSchema` in schedule-repository.ts
3. Move `mkdirSync` to GeminiBasePromptCache constructor (remove from buildCombinedFile)
4. Add dedicated GeminiBasePromptCache unit test suite
5. Add path traversal guard to cleanupTaskFile
6. Add systemPrompt to scheduled-loop taskTemplate
7. Add MCP tool tests for schedule systemPrompt threading
8. Add mock cleanup method to createMockAdapter

### Phase 2: Quality Improvements (Before Merge or Follow-up PR)
9. Add worker pool cleanup delegation tests
10. Fix console.error spy leak in Gemini adapter test
11. Add inline comment to --system-prompt CLI handlers explaining dash-guard rationale
12. Store adapter reference on WorkerState to avoid registry lookup in cleanup path

### Phase 3: Future Refactors (Post-Merge)
- Extract CLI run command parsing into separate handler module
- Flatten parseLoopCreateArgs into table-driven pattern
- Standardize Zod schemas to use `.enum()` for validated agent fields

---

## Summary by Reviewer

| Reviewer | Score | Key Findings |
|----------|-------|--------------|
| **Security** | 8/10 | 1 MEDIUM path traversal; CLI args visible in process list (pre-existing design) |
| **Architecture** | 9/10 | 1 MEDIUM consistency gap (loop taskTemplate); GeminiBasePromptCache extraction well-designed |
| **Performance** | 8/10 | 1 HIGH mkdir per spawn; 1 MEDIUM registry lookup; caching improvement good |
| **Complexity** | 8/10 | 1 MEDIUM (extends pre-existing CLI pattern); extract utilities for future |
| **Consistency** | 8/10 | 1 MEDIUM (dash-guard justified); comment suggestion; consistent threading overall |
| **Regression** | 9/10 | 1 MEDIUM mock gap; stale cache behavior intentional; all threading complete |
| **Testing** | 6/10 | 2 HIGH (GeminiBasePromptCache tests, schedule MCP tests); 1 MEDIUM cleanup tests |
| **TypeScript** | 9/10 | 1 MEDIUM cast pattern; strong types overall; no `any` introduced |
| **Database** | 7/10 | 2 HIGH (Zod schemas strip systemPrompt); migration clean; silent data loss |

---

## Confidence-Adjusted Aggregation

**Total Issues**: 15 (4 HIGH, 6 MEDIUM blocking, 2 MEDIUM should-fix, 3 pre-existing MEDIUM)

**Blocking Issues Confirmed by Multiple Reviewers**:
- Database HIGH #1 (systemPrompt in TaskRequestSchema) — flagged by Database + Architecture + Testing = 3 reviewers
- Database HIGH #2 (systemPrompt in LoopConfigSchema) — flagged by Database + Testing = 2 reviewers
- Performance HIGH (mkdir per spawn) — flagged by Performance = 1 reviewer, but 85% confidence
- Testing HIGH (GeminiBasePromptCache tests) — flagged by Testing = 1 reviewer, but 92% confidence

The two database issues achieve highest confidence (92-95%) due to their structural impact: any code reading schedule.taskTemplate.systemPrompt for a loop after persistence will fail silently.

---

## Recommendation Detail

**CHANGES_REQUESTED** — Fix the 4 HIGH issues (database, performance, testing) and 6 MEDIUM blocking issues before merge.

The architecture, regression, and consistency scores are strong (8-9/10), indicating the feature is well-designed. However, the silent data loss in the database layer (systemPrompt stripped during deserialization) is a critical bug that undermines the feature's stated goal of persisting system prompts through retry/resume cycles. This must be fixed.

The HIGH performance issue (mkdir per spawn) is fixable in <2 minutes (move to constructor). The HIGH testing gap (GeminiBasePromptCache tests) requires ~30-45 minutes of test writing but is essential for confidence in the cache's edge cases (staleness, size guard, cleanup).

Once these blockers are resolved, the PR is merge-ready.
