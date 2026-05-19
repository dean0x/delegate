# TypeScript Review Report

**Branch**: feat/system-prompt-support -> main
**Date**: 2026-04-17T16:41
**PR**: #147

## Issues in Your Changes (BLOCKING)

### HIGH

**`--system-prompt` rejects legitimate prompts starting with `-`** - `src/cli.ts:182`, `src/cli/commands/loop.ts:319`, `src/cli/commands/orchestrate.ts:164`
**Confidence**: 90%
- Problem: The `!next.startsWith('-')` guard on `--system-prompt` value parsing rejects any system prompt that begins with a hyphen (e.g., `"- You are a helpful assistant"` or `"-Follow these rules:"`). This is a real use case for system prompts which commonly contain markdown list items at the start.
- Impact: Users providing a markdown-formatted system prompt via CLI get an unhelpful `--system-prompt requires a prompt string` error with no way to pass the value.
- Fix: Use a separator pattern (e.g., `--system-prompt="..."`) or remove the `startsWith('-')` guard for this particular flag since system prompt values are inherently free-form text. Alternative: check `next !== undefined` only, consistent with how `--eval-prompt` handles its value in `loop.ts:250` (no `startsWith('-')` guard).

```typescript
// Current (cli.ts:182, loop.ts:319, orchestrate.ts:164):
if (!next || next.startsWith('-')) {

// Suggested — remove the startsWith check for free-form text args:
if (!next) {
```

---

**Gemini `getSystemPromptConfig` performs synchronous filesystem I/O with no length validation** - `src/implementations/gemini-adapter.ts:76-81`
**Confidence**: 85%
- Problem: `readFileSync(baseCachePath, 'utf8')` reads the entire cached base prompt into memory without any size check, then concatenates it with the user's system prompt and writes the combined content. If `gemini-base.md` is corrupted or unexpectedly large (e.g., Gemini CLI writes debug output into it), this creates an unbounded allocation. Furthermore, the Zod schema limits `systemPrompt` to 16000 chars but there is no validation on the combined `baseContent + systemPrompt` total.
- Impact: Potential OOM on spawn if the cache file is corrupted. No way for the user to know the combined prompt exceeds agent limits until the Gemini CLI rejects it at runtime.
- Fix: Add a size guard on the read content and validate combined length.

```typescript
const baseContent = readFileSync(baseCachePath, 'utf8');
const MAX_COMBINED = 64_000; // reasonable ceiling
if (baseContent.length + systemPrompt.length > MAX_COMBINED) {
  console.error(JSON.stringify({
    level: 'warn',
    message: `gemini-adapter: combined system prompt exceeds ${MAX_COMBINED} chars, falling back to prompt prepend`,
    baseLen: baseContent.length,
    userLen: systemPrompt.length,
  }));
  return { args: [], env: {}, prependToPrompt: true };
}
const combined = `${baseContent}\n\n${systemPrompt}`;
```

### MEDIUM

**Temp file path uses taskId but `taskId` can be `undefined` in SpawnOptions** - `src/implementations/base-agent-adapter.ts:193`
**Confidence**: 88%
- Problem: The temp path computation `${taskId ?? 'unknown'}.md` means all spawns without a taskId (if any) write to the same file `unknown.md`, creating a race condition. While in practice taskId is always set in production paths, the type allows `undefined` and the fallback to `'unknown'` conflates multiple tasks.
- Impact: Low practical risk since `taskId` is always provided from `EventDrivenWorkerPool.spawn()`, but the type contract doesn't guarantee it. If two tasks spawned simultaneously both had `taskId === undefined`, their system prompt files would collide.
- Fix: Generate a unique suffix when taskId is missing.

```typescript
const safeId = taskId ?? `anon-${crypto.randomUUID().substring(0, 8)}`;
const systemPromptPath = path.join(os.homedir(), '.autobeat', 'system-prompts', `${safeId}.md`);
```

---

**Cleanup in `cleanupWorkerState` unconditionally tries to unlink for every task** - `src/implementations/event-driven-worker-pool.ts:307-312`
**Confidence**: 82%
- Problem: `unlinkSync(systemPromptPath)` is called for every worker cleanup, not just workers whose tasks had a `systemPrompt`. While the catch block handles the ENOENT case, this is an unnecessary syscall on every task completion. More importantly, the `task` object is available on the `worker` but `cleanupWorkerState` only receives `taskId` -- it cannot check `task.systemPrompt` to decide whether cleanup is needed.
- Impact: Minor perf: unnecessary `unlink` syscall per task. The empty catch silences potential non-ENOENT errors (e.g., EPERM).
- Fix: Only attempt unlink when the task had a system prompt, or at minimum log non-ENOENT errors.

```typescript
// Option A: Conditional cleanup
const worker = this.workers.get(workerId);
if (worker?.task.systemPrompt) {
  const systemPromptPath = path.join(os.homedir(), '.autobeat', 'system-prompts', `${taskId}.md`);
  try {
    unlinkSync(systemPromptPath);
  } catch (e: unknown) {
    if (e instanceof Error && 'code' in e && (e as NodeJS.ErrnoException).code !== 'ENOENT') {
      this.logger.warn('Failed to clean up system prompt file', { taskId, error: (e as Error).message });
    }
  }
}
```

## Issues in Code You Touched (Should Fix)

### MEDIUM

**`refreshBasePrompt` uses `process.exit()` in an `async` function** - `src/cli/commands/agents.ts:228-301`
**Confidence**: 80%
- Problem: The `refreshBasePrompt` function is declared `async` but calls `process.exit(0)` and `process.exit(1)` in multiple branches. This is consistent with other CLI commands in this codebase (e.g., `listAgents`, `checkAgents`), so it follows the existing pattern. However, it means any cleanup logic in calling code after `await refreshBasePrompt()` never executes. The function mixes early-exit (`process.exit`) with the `async` return type that suggests the caller controls flow.
- Impact: Low -- consistent with codebase pattern. Noted for awareness.

---

**`spawnSync` stderr piped but stdout/stdin ignored** - `src/cli/commands/agents.ts:259`
**Confidence**: 80%
- Problem: The `stdio` config is `['ignore', 'ignore', 'pipe']` which captures stderr but discards stdout. If the Gemini CLI writes useful diagnostics to stdout (some CLI tools do), they are lost. The comment says "we only care about the file" which is reasonable, but if the spawn fails without writing the file, the user only sees stderr.
- Impact: Low -- stderr is the standard diagnostic channel. Noted as a potential debugging gap.

## Pre-existing Issues (Not Blocking)

_No CRITICAL pre-existing issues found in changed files._

## Suggestions (Lower Confidence)

- **Codex `-c` flag with `=` value may have shell escaping issues** - `src/implementations/codex-adapter.ts:41` (Confidence: 70%) -- If `systemPrompt` contains shell-significant characters (`'`, `"`, `$`, newlines), passing it as `-c developer_instructions=<text>` may require additional escaping depending on how `spawn()` handles the args array. Node's `spawn` does not use a shell by default (safe), but the Codex CLI's own parsing of the `-c key=value` format may be sensitive to embedded newlines or equals signs.

- **Version reference mismatch: JSDoc says v1.4.0 but v1.4.0 was folded into v1.3.0** - Multiple files (Confidence: 65%) -- Comments reference "v1.4.0" throughout the diff, but per MEMORY.md, v1.4.0 was folded into v1.3.0 for the consolidation release. These may need updating before release, though they are comments rather than runtime behavior.

- **`console.error` used for structured logging in gemini-adapter** - `src/implementations/gemini-adapter.ts:66,90,102` (Confidence: 60%) -- The adapter uses `console.error(JSON.stringify({...}))` for warnings rather than the injected `Logger`. This is because `BaseAgentAdapter` does not receive a `Logger` dependency. While functional, it is inconsistent with the codebase's structured logging pattern.

## Summary
| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 2 | 2 | 0 |
| Should Fix | 0 | 0 | 2 | 0 |
| Pre-existing | 0 | 0 | 0 | 0 |

**TypeScript Score**: 8/10
**Recommendation**: CHANGES_REQUESTED

The type safety of the `systemPrompt` threading is well-executed: the field flows correctly through `TaskRequest -> Task -> SpawnOptions -> getSystemPromptConfig` with consistent `readonly` and optional typing. Zod schemas are updated in lockstep with TypeScript interfaces (task-repository, loop-repository). The `getSystemPromptConfig` abstract method return type `{ args: readonly string[]; env: Record<string, string>; prependToPrompt: boolean }` is clean and well-documented. The orchestrator prompt refactor from `string` to `{ systemPrompt, userPrompt }` is a good separation. The main concerns are the CLI flag parsing rejecting valid inputs and the Gemini adapter's unbounded file read.
