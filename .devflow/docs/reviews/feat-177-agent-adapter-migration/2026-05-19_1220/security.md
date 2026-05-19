# Security Review Report

**Branch**: feat/177-agent-adapter-migration -> main
**Date**: 2026-05-19
**PR**: #187

## Issues in Your Changes (BLOCKING)

### CRITICAL

(none)

### HIGH

(none)

### MEDIUM

**`taskId` used in path construction without validation at adapter layer** - `src/implementations/base-agent-adapter.ts:152`
**Confidence**: 82%
- Problem: `buildTmuxCommand` constructs a tmux session name as `beat-task-${options.taskId}` (line 152) and passes `options.taskId as TaskId` (line 158) without validating the taskId format at this layer. The `TaskId` branded type constructor (`domain.ts:16`) performs no validation — it is a bare `as` cast. While downstream consumers (`tmux-hooks.ts:168`) validate against `TASK_ID_REGEX` and the session manager validates against `SESSION_NAME_REGEX`, the adapter itself passes through arbitrary strings. A malicious or malformed `taskId` would be caught downstream, but defense-in-depth calls for validation at the boundary where user-supplied data enters the tmux config assembly.
- Mitigating factors: (1) TaskIds are generated server-side via `crypto.randomUUID()` with a `task-` prefix, not user-supplied. (2) Downstream `tmux-hooks.ts` validates both `taskId` and `sessionsDir` against strict regexes before any filesystem operations. (3) `TASK_ID_REGEX = /^[a-z0-9][a-z0-9_-]*$/` rejects path traversal characters. The downstream validation is solid — this is a defense-in-depth observation, not an exploitable gap.
- Fix: Add an early regex check in `buildTmuxCommand` before constructing the config:
  ```typescript
  const TASK_ID_REGEX = /^[a-z0-9][a-z0-9_-]*$/;
  if (!TASK_ID_REGEX.test(options.taskId)) {
    return err(agentMisconfigured(this.provider, `buildTmuxCommand: invalid taskId format`));
  }
  ```

## Issues in Code You Touched (Should Fix)

### MEDIUM

**`systemPromptPath` uses `taskId` directly in file path without format validation** - `src/implementations/base-agent-adapter.ts:305-306`
**Confidence**: 80%
- Problem: `resolveSystemPromptInjection` constructs a file path as `path.join(os.homedir(), '.autobeat', 'system-prompts', '${safeId}.md')` where `safeId` is either the raw `taskId` or a truncated UUID. While `taskId` values are server-generated UUIDs with a `task-` prefix (safe characters), the variable name `safeId` is misleading — it implies sanitization that does not occur. If taskId generation ever changes or a non-UUID taskId enters this path, path traversal is possible (e.g., `../../etc/passwd`).
- Mitigating factors: (1) This code is pre-existing (not introduced by this PR). (2) The `taskId` value comes from `crypto.randomUUID()` — no user-controlled input reaches this path today. (3) The fallback `crypto.randomUUID().substring(0, 8)` is safe.
- Fix: Validate or sanitize `safeId` before path construction:
  ```typescript
  const safeId = (taskId ?? crypto.randomUUID().substring(0, 8)).replace(/[^a-z0-9_-]/gi, '');
  ```

## Pre-existing Issues (Not Blocking)

(none found at CRITICAL severity in unchanged code)

## Suggestions (Lower Confidence)

- **`sessionsDir` passed through without validation in adapter layer** - `src/implementations/base-agent-adapter.ts:159` (Confidence: 68%) — `options.sessionsDir` is forwarded directly into `TmuxSpawnConfig` without validation at this layer. Downstream `tmux-hooks.ts:171` validates it against `SAFE_PATH_REGEX`, so this is defended. However, validating at the adapter boundary would catch issues earlier. Low confidence because downstream validation is comprehensive.

- **Migration v28 `UPDATE tasks SET agent = NULL WHERE agent = 'gemini'` is not reversible** - `src/implementations/database.ts:1077` (Confidence: 65%) — The migration nullifies `agent='gemini'` rows, which is a one-way data transformation. If a rollback is needed, the original agent value cannot be recovered. This is consistent with `avoids PF-002` (no backward-compatibility paths for features with zero users), and the PR description confirms Gemini is being intentionally dropped. Noted for awareness.

- **`AUTOBEAT_TASK_ID` env var injected without format validation** - `src/implementations/base-agent-adapter.ts:438` (Confidence: 62%) — Unlike `orchestratorId` (validated against `ORCHESTRATOR_ID_RE` on line 418-420), `taskId` is injected into the spawned process environment as `AUTOBEAT_TASK_ID` without any format check. The spawned process could receive an arbitrary string via this env var. Low risk because taskId is server-generated, but inconsistent with the orchestratorId validation pattern.

## Summary

| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 0 | 1 | 0 |
| Should Fix | 0 | 0 | 1 | 0 |
| Pre-existing | 0 | 0 | 0 | 0 |

**Security Score**: 8/10
**Recommendation**: APPROVED_WITH_CONDITIONS

### Conditions

1. The MEDIUM blocking finding (taskId validation in `buildTmuxCommand`) is a defense-in-depth improvement. Downstream validation in `tmux-hooks.ts` prevents exploitation, but adding validation at the adapter boundary would be consistent with the project's existing security patterns (e.g., `ORCHESTRATOR_ID_RE` validation, `SAFE_PATH_REGEX` checks).

### Positive Security Observations

- **Proper type narrowing**: The `as TmuxAgentType` cast was replaced with explicit conditional narrowing (line 141), eliminating a type safety bypass.
- **TaskId guard**: The `if (!options.taskId)` check (line 125) prevents undefined session names — a correctness and security improvement.
- **Migration data safety**: The `CASE WHEN judge_agent = 'gemini' THEN NULL ELSE judge_agent END` pattern in migration v28 (line 1138) safely handles existing data without risking constraint violations. `avoids PF-002` — no unnecessary backward-compatibility scaffolding for a dropped feature.
- **Downstream validation is comprehensive**: `tmux-hooks.ts` validates `taskId` against `TASK_ID_REGEX`, `sessionsDir` against `SAFE_PATH_REGEX`, and the session manager validates session names against `SESSION_NAME_REGEX`. The security boundary at the tmux layer is well-defended.
- **Cryptographic randomness**: Task IDs use `crypto.randomUUID()` — not predictable.
- **Environment sanitization**: `buildSpawnEnv` strips sensitive env var prefixes and validates `orchestratorId` format before injection.
