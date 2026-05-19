# Code Review Summary

**Branch**: feat/134-system-prompt-support -> main
**Date**: 2026-04-17_1641
**PR**: #147
**Commits**: 7 (c43d303..ef16f93)
**Files Changed**: 22 (+571, -82)

## Merge Recommendation: BLOCK MERGE

Multiple CRITICAL and HIGH blocking issues must be resolved before merge. See blocking issues below.

---

## Issue Summary

| Category | CRITICAL | HIGH | MEDIUM | LOW | Total |
|----------|----------|------|--------|-----|-------|
| **Blocking** | 2 | 7 | 6 | 0 | **15** |
| **Should Fix** | 0 | 0 | 4 | 0 | **4** |
| **Pre-existing** | 0 | 0 | 4 | 0 | **4** |

---

## Blocking Issues (MUST FIX)

### CRITICAL (2)

**[CRITICAL] No test coverage for core feature — system prompt injection (3 adapters)** — Confidence: 95%
- **Files**: `src/implementations/claude-adapter.ts:44-49`, `src/implementations/codex-adapter.ts:37-42`, `src/implementations/gemini-adapter.ts:52-110`
- **Problem**: The feature's behavioral pivot point — per-agent `getSystemPromptConfig()` — has zero test coverage. Claude uses `--append-system-prompt`, Codex uses `-c developer_instructions=<text>`, Gemini uses `GEMINI_SYSTEM_MD` env var with file writes and fallback logic. None are tested.
- **Impact**: CRITICAL. Process spawn boundary is hardest place to debug in production. A typo in adapter args/env injection could silently lose system prompts or cause spawn failures with no test to catch it.
- **Fix**: Add test suite following the `model passthrough` pattern. Test each adapter's `getSystemPromptConfig` return value and full `spawn()` invocation with systemPrompt set.

**[CRITICAL] No tests for task-repository system_prompt persistence round-trip** — Confidence: 95%
- **Files**: `src/implementations/task-repository.ts:40,68,102,108,134,142-199,264,422`
- **Problem**: Migration v23 adds `system_prompt` column; repo saves/reads it. But no tests verify round-trip through save/findById. A typo in SQL parameter binding (`@systemPrompt` vs column `system_prompt`) would silently lose the system prompt on persist.
- **Impact**: CRITICAL. Data loss risk. Tasks with system prompts would not persist correctly, and the failure would only manifest during task execution.
- **Fix**: Add `system_prompt field persistence` test block matching the `model field persistence` template. Test save/read with and without systemPrompt.

---

### HIGH (7)

**[HIGH] Incomplete MCP API surface — ScheduleTask, SchedulePipeline, ScheduleLoop lack systemPrompt** — Confidence: 88-92%
- **Files**: `src/adapters/mcp-adapter.ts:146-171,232-262,426-472`
- **Problem**: `DelegateTask` accepts `systemPrompt`, but the three schedule tools do not. Users who schedule tasks or loops with system prompts get silent no-op behavior (Zod strips the unknown field). The feature works for immediate `DelegateTask` but fails for `ScheduleTask` and `ScheduleLoop`.
- **Impact**: HIGH. Inconsistent API surface. Users discover `systemPrompt` on `DelegateTask`, expect it on `ScheduleTask`/`ScheduleLoop`, and get silently different behavior.
- **Fix**: Add `systemPrompt` to `ScheduleTaskSchema`, `SchedulePipelineSchema`, and `ScheduleLoopSchema` Zod schemas and their handlers. Thread value into `ScheduleCreateRequest` and `loopConfig`.

**[HIGH] System prompt temp files written with world-readable permissions (0644)** — Confidence: 90%
- **Files**: `src/implementations/gemini-adapter.ts:80-81`, `src/cli/commands/agents.ts:242,295`
- **Problem**: `writeFileSync(systemPromptPath, combined, 'utf8')` and `mkdirSync(cacheDir, { recursive: true })` use default umask, creating world-readable files under `~/.autobeat/system-prompts/`. The codebase already uses `mode: 0o700` (dirs) and `0o600` (files) for orchestrator state (`orchestration-manager.ts:113`, `orchestrator-state.ts:97,130`), establishing the convention. System prompts may contain sensitive instructions or proprietary context.
- **Impact**: HIGH. On shared systems or multi-tenant environments, other users can read system prompt files. The combined prompt files persist on disk during task execution.
- **Fix**: Add `mode: 0o700` to `mkdirSync` calls; add `{ encoding: 'utf8', mode: 0o600 }` to all `writeFileSync` calls writing system prompts.

**[HIGH] Synchronous file I/O in spawn hot path (Gemini adapter)** — Confidence: 90%
- **Files**: `src/implementations/gemini-adapter.ts:61-81`
- **Problem**: `getSystemPromptConfig()` performs `existsSync`, `statSync`, `readFileSync`, `mkdirSync`, `writeFileSync` synchronously in the spawn path. The `readFileSync` reads an entire base prompt file (could be several KB) on every Gemini spawn. With 20 concurrent Gemini spawns, this serializes into 20-100ms of blocked event loop.
- **Impact**: HIGH. Performance regression. Event loop blocked for spawn I/O, delaying heartbeat timers, event bus emissions, and dashboard polling.
- **Fix**: Implement in-memory caching: read `gemini-base.md` once into a class instance field, invalidate only when user runs `refresh-base-prompt`. Eliminates 3 syscalls per spawn.

**[HIGH] Synchronous unlinkSync on every worker cleanup (unconditional)** — Confidence: 92%
- **Files**: `src/implementations/event-driven-worker-pool.ts:305-312`
- **Problem**: `cleanupWorkerState` calls `unlinkSync(systemPromptPath)` for every task completion, even tasks without systemPrompt (majority). The try/catch silences ENOENT, but the syscall still blocks the event loop (~0.1ms per task, but pure waste for tasks without systemPrompt).
- **Impact**: HIGH. Every task completion pays cost of failed syscall. Dashboard polling (1Hz) compounds this.
- **Fix**: Guard cleanup behind `if (task?.systemPrompt)` check. Move check before `this.workers.delete(workerId)` or capture task reference earlier.

**[HIGH] Gemini adapter getSystemPromptConfig performs I/O inside method — violates adapter pattern** — Confidence: 82%
- **Files**: `src/implementations/gemini-adapter.ts:52-110`
- **Problem**: `getSystemPromptConfig` is documented as "declare how this adapter injects" (base-agent-adapter.ts:57), but Gemini implementation performs file reads, writes, stat checks, and staleness logging (60 lines of I/O with 3 error paths). Claude and Codex adapters are pure 3-line functions. The pattern becomes asymmetrically complex: unclear whether `getSystemPromptConfig` should be pure or effectful.
- **Impact**: HIGH. Architecture pattern becomes confusing. Testing Gemini requires filesystem fixtures. Future adapters will be unclear on contract.
- **Fix**: Extract cache I/O into separate `GeminiSystemPromptCache` class injected via constructor, keeping `getSystemPromptConfig` as thin delegation.

**[HIGH] System prompt temp file cleanup coupled to worker pool instead of adapter** — Confidence: 85%
- **Files**: `src/implementations/event-driven-worker-pool.ts:304-312`
- **Problem**: Worker pool unconditionally attempts `unlinkSync` on system prompt temp file. This cleanup concern belongs to the adapter that wrote the file (GeminiAdapter), not worker pool. Worker pool now has knowledge of file path convention that is Gemini implementation detail. Claude and Codex never write this file, yet pool tries to delete it for every task.
- **Impact**: HIGH. Layering violation. Worker pool depends on adapter implementation detail; if Gemini cache path changes, must update pool. The `try/catch` suppresses errors, so functional impact is low, but coupling is real.
- **Fix**: Add `cleanup(taskId: string): void` method to `AgentAdapter` interface. Adapter owns cleanup of files it wrote. Worker pool calls `adapter.cleanup(taskId)` instead of reaching into filesystem.

**[HIGH] Version references hardcoded to v1.4.0 (unreleased)** — Confidence: 95%
- **Files**: Multiple (15+ occurrences across `mcp-adapter.ts`, `domain.ts`, `agents.ts`, `base-agent-adapter.ts`, `database.ts`, `event-driven-worker-pool.ts`, `orchestration-manager.ts`)
- **Problem**: Comments reference "v1.4.0" throughout source, but `package.json` is at v1.3.1. v1.4.0 was previously folded into v1.3.0 (Session 279 memory). This feature will ship in whatever the next version is — referencing v1.4.0 presumes a decision not yet made. Critically, migration v23 description reads: `'Add system_prompt column to tasks table (v1.4.0)'` — this persists permanently in database, becoming inaccurate if shipped as v1.3.2 or v2.0.0.
- **Impact**: HIGH. Database drift (PF-009). Once a migration is deployed, its description cannot be updated. Hardcoding an unreleased version number creates permanent inaccuracy.
- **Fix**: Remove all v1.4.0 references or use placeholder like `(v1.x.0)` or `(next minor)`. Migration description should use placeholder and be updated at release time.

---

### MEDIUM (6)

**[MEDIUM] Version inconsistency — @design JSDoc tag introduced without project precedent** — Confidence: 82%
- **Files**: Multiple (9 occurrences in `mcp-adapter.ts`, `database.ts`, `base-agent-adapter.ts`, `loop-repository.ts`, `claude-adapter.ts`, `codex-adapter.ts`, `gemini-adapter.ts`, `orchestrator-prompt.ts`)
- **Problem**: Codebase has 55 `DECISION:` and `ARCHITECTURE:` comment markers (established convention). This PR introduces `@design` JSDoc tag (9 occurrences) with no precedent. Project memory specifies: "add `DECISION:` or `ARCHITECTURE:` JSDoc comments at every non-obvious choice point." The new `@design` tag diverges from this standard.
- **Impact**: MEDIUM. Consistency violation. Developers will be confused by two patterns for documenting decisions.
- **Fix**: Replace all `@design` with `DECISION:` inline comment pattern (existing convention).

**[MEDIUM] No tests for Gemini fallback path (prependToPrompt when cache missing)** — Confidence: 92%
- **Files**: `src/implementations/gemini-adapter.ts:99-109`, `src/implementations/base-agent-adapter.ts:197-199`
- **Problem**: When `gemini-base.md` cache does not exist, adapter returns `{ prependToPrompt: true }` and base class prepends system prompt to user prompt. This graceful degradation silently changes behavior. No test verifies fallback fires or that prepend produces `"${systemPrompt}\n\n${prompt}"`.
- **Impact**: MEDIUM. Behavior change not tested. If fallback logic is broken, it silently uses degraded injection strategy.
- **Fix**: Test Gemini adapter's `getSystemPromptConfig` with no cache file; test full `spawn()` with systemPrompt set but no cache, verifying spawn args include concatenated prompt.

**[MEDIUM] No tests for includeSystemPrompt flag on MCP TaskStatus and LoopStatus** — Confidence: 90%
- **Files**: `src/adapters/mcp-adapter.ts:123,402,1684,1726,2515,2556`
- **Problem**: New `includeSystemPrompt` boolean flag controls whether `systemPrompt` appears in response. Default is `false` (compact). No tests verify: (1) field omitted by default, (2) setting flag true includes it.
- **Impact**: MEDIUM. Behavioral contract for MCP clients not validated. Flag could be silently ignored.
- **Fix**: Add tests in MCP adapter suite for TaskStatus and LoopStatus with and without `includeSystemPrompt=true`.

**[MEDIUM] No tests for CLI --system-prompt flag parsing** — Confidence: 90%
- **Files**: `src/cli.ts:180-188`, `src/cli/commands/loop.ts:318-323`, `src/cli/commands/orchestrate.ts:162-166`
- **Problem**: Three CLI commands now accept `--system-prompt`. The parsers are pure functions (`parseLoopCreateArgs`, etc.) that are tested for other flags, but no tests verify `--system-prompt` parses correctly, that missing value returns error, or value threads through to service call.
- **Impact**: MEDIUM. CLI contract not validated. A typo in parsing could silently drop the flag.
- **Fix**: Add tests to `cli.test.ts`, `cli/orchestrate.test.ts` following existing flag parsing test patterns.

**[MEDIUM] Gemini adapter unbounded file read — no size validation on combined prompt** — Confidence: 85%
- **Files**: `src/implementations/gemini-adapter.ts:76-81`
- **Problem**: `readFileSync(baseCachePath, 'utf8')` reads entire cache file without size check, then concatenates with user systemPrompt. Zod limits systemPrompt to 16KB, but combined `baseContent + systemPrompt` is not validated. If cache is corrupted or unexpectedly large, unbounded allocation risk.
- **Impact**: MEDIUM. OOM risk on spawn if cache is large. User has no way to know combined prompt exceeds agent limits until Gemini CLI rejects at runtime.
- **Fix**: Add size guard on read and validate combined length. Consider fallback to prependToPrompt if combined exceeds reasonable ceiling (e.g., 64KB).

---

## Should-Fix Issues (STRONGLY RECOMMENDED)

### MEDIUM (4)

**[MEDIUM] System prompt temp file naming uses taskId which can be undefined** — Confidence: 72-88%
- **Files**: `src/implementations/base-agent-adapter.ts:193`
- **Problem**: When `SpawnOptions.taskId` is undefined, path becomes `~/.autobeat/system-prompts/unknown.md`. Two concurrent tasks without taskIds both have systemPrompt would overwrite same file. Type allows undefined even though production always provides ID.
- **Impact**: Race condition risk if taskId ever becomes undefined.
- **Fix**: Generate unique suffix when taskId is missing: `const safeId = taskId ?? crypto.randomUUID().substring(0, 8)`.

**[MEDIUM] CLI --system-prompt flag rejects legitimate prompts starting with `-`** — Confidence: 85-90%
- **Files**: `src/cli.ts:182`, `src/cli/commands/loop.ts:319`, `src/cli/commands/orchestrate.ts:164`
- **Problem**: Check `!next.startsWith('-')` rejects system prompts starting with dash (e.g., `"- Follow these rules"`). Valid use case for markdown-formatted prompts. MCP path has no such restriction.
- **Impact**: MEDIUM. Users providing markdown prompts via CLI get confusing error; same prompt works via MCP.
- **Fix**: Remove `startsWith('-')` guard for this flag or use `--system-prompt="..."` syntax. Alternatively, provide `--system-prompt-file` for long prompts.

**[MEDIUM] beat status --system-prompt undocumented in help text** — Confidence: 85%
- **Files**: `src/cli.ts:225-238`
- **Problem**: `beat run` documents `--system-prompt` help text, but `beat status` accepts the flag without any documentation. User has no way to discover flag from `--help`.
- **Impact**: MEDIUM. Usability issue. Flag exists but is undocumented.
- **Fix**: Add help text for `--system-prompt` in `beat status` usage pattern.

**[MEDIUM] Loop auto-commit artifact included in PR branch** — Confidence: 90%
- **Files**: Commit `ebc9603` ("Loop loop-76aa2848-... iteration 1 -- pass")
- **Problem**: Auto-generated loop commit modified 4 source files. This is development artifact, not deliberate feature. Known gotcha per Session 279 memory.
- **Impact**: MEDIUM. Muddies commit history; artifact commits should not land in PR.
- **Fix**: Before merging, squash commits or interactive-rebase to drop loop commit and fold changes into proper feature commits.

---

## Pre-existing Issues (INFORMATIONAL)

### MEDIUM (4)

**PF-006 (Known pitfall)** — ProcessSpawnerAdapter silently discards extra SpawnOptions fields (noted in architecture review at HIGH confidence, regression review at 85% confidence)
- **Impact**: Informational. Already documented as known pitfall. New `systemPrompt` field correctly flows through since `SpawnOptions` is passed as bag.

**PF-004 (Known pitfall)** — `findByOrchestratorId` status-filter path uses inline `db.prepare()`
- **Impact**: Pre-existing; not introduced by this PR. Noted in database and performance reviews.

**PF-009 (Known pitfall)** — Release notes desync from code
- **Impact**: This PR contributes to PF-009 by hardcoding v1.4.0 in migration description. Flagged as HIGH blocking issue above.

---

## Summary by Reviewer

| Reviewer | Score | Recommendation | Key Blockers |
|----------|-------|-----------------|--------------|
| Security | 7/10 | CHANGES_REQUESTED | Temp file permissions (HIGH); missing systemPrompt size validation on CLI (MEDIUM) |
| Architecture | 7/10 | CHANGES_REQUESTED | Incomplete schedule tools surface (HIGH); Gemini adapter I/O coupling (HIGH); temp file cleanup wrong layer (HIGH) |
| Performance | 7/10 | CHANGES_REQUESTED | Sync I/O in spawn hot path (HIGH); unconditional unlinkSync (HIGH); system_prompt in all queries (MEDIUM) |
| Complexity | 7/10 | APPROVED_WITH_CONDITIONS | BaseAgentAdapter.spawn() growing (HIGH); Gemini getSystemPromptConfig complexity (MEDIUM) |
| Consistency | 6/10 | CHANGES_REQUESTED | v1.4.0 hardcoded in unreleased version (HIGH); @design JSDoc vs DECISION: pattern (HIGH); loop auto-commit (MEDIUM) |
| Regression | 7/10 | CHANGES_REQUESTED | ScheduleLoop/ScheduleTask incomplete migration (HIGH); CLI dash-prefix rejection (MEDIUM) |
| Testing | 3/10 | CHANGES_REQUESTED | **CRITICAL**: No adapter injection tests (CRITICAL); no persistence round-trip tests (CRITICAL); no Gemini fallback tests (HIGH); no includeSystemPrompt tests (HIGH); no CLI flag tests (HIGH) |
| TypeScript | 8/10 | CHANGES_REQUESTED | CLI dash-prefix rejection (HIGH); Gemini unbounded read (HIGH); taskId undefined handling (MEDIUM) |
| Database | 9/10 | APPROVED | Migration v23 safe and correct; paired-interface drift (PF-006) addressed; all prepared statements updated consistently |

---

## Action Plan

### CRITICAL (Do Not Ship)
1. **Add test suite for adapter injection** — Claude, Codex, Gemini getSystemPromptConfig and full spawn paths
2. **Add test suite for task persistence** — system_prompt round-trip save/findById
3. **Remove v1.4.0 hardcoded references** — Use placeholder or release-time assignment
4. **Add systemPrompt to schedule tools** — ScheduleTask, SchedulePipeline, ScheduleLoop

### HIGH (Do Not Ship)
5. **Fix temp file permissions** — `mode: 0o700` (dirs), `mode: 0o600` (files)
6. **Implement Gemini base cache in-memory caching** — Eliminate sync I/O on every spawn
7. **Guard unlinkSync behind systemPrompt check** — Eliminate unnecessary syscalls
8. **Extract Gemini cache I/O to separate class** — Restore adapter pattern clarity
9. **Move temp file cleanup to adapter** — Add `cleanup()` method to AgentAdapter interface
10. **Add Gemini size validation** — Validate combined prompt length before write

### MEDIUM (Strongly Recommended Before Merge)
11. **Replace @design JSDoc with DECISION: pattern** — Align with project conventions
12. **Add Gemini fallback (prependToPrompt) tests**
13. **Add includeSystemPrompt flag tests** — TaskStatus and LoopStatus
14. **Add CLI --system-prompt parsing tests** — All three commands
15. **Fix CLI dash-prefix rejection** — Remove startsWith('-') guard or use file-based input
16. **Document beat status --system-prompt** — Add help text
17. **Fix taskId undefined case** — Generate unique suffix
18. **Squash loop auto-commit** — Clean up commit history

---

## Positive Aspects

- **Database changes well-executed**: Migration v23 follows established patterns; all prepared statements updated consistently; no paired-interface drift (PF-006).
- **Adapter pattern overall sound**: The abstract `getSystemPromptConfig` method cleanly separates per-agent logic from base spawn. Domain-to-persistence threading complete for primary tools.
- **Zod validation at boundaries**: MCP tool schemas properly validate systemPrompt with `.max(16000)`.
- **No shell injection risk**: All adapters use `spawn` argv arrays, not shell interpolation.
- **Graceful degradation**: Gemini adapter falls back to prompt prepend when cache unavailable, rather than failing open.
- **System prompt inheritance on retry/resume**: Correctly propagates systemPrompt from original task, maintaining security context.

---

## Confidence Aggregation Notes

- **Temp file permissions (HIGH)**: Security (90%), TypeScript (88%) → boosted to 90% blocking threshold
- **Schedule tool incompleteness (HIGH)**: Architecture (88%), Regression (92%) → consensus across multiple reviewers
- **Sync I/O in spawn (HIGH)**: Performance (90%), TypeScript (85%) → critical path concern
- **v1.4.0 hardcoding (HIGH)**: Consistency (95%), Regression (60% as suggestion) → database permanence makes this blocking
- **Testing gaps (CRITICAL)**: Testing (95% x2) → dual CRITICAL findings on core feature behavior and data persistence
