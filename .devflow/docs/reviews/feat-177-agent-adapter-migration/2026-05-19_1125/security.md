# Security Review Report

**Branch**: feat/177-agent-adapter-migration -> main
**Date**: 2026-05-19

## Issues in Your Changes (BLOCKING)

### CRITICAL

(none)

### HIGH

(none)

### MEDIUM

(none)

## Issues in Code You Touched (Should Fix)

(none)

## Pre-existing Issues (Not Blocking)

(none)

## Suggestions (Lower Confidence)

(none)

## Summary

| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 0 | 0 | - |
| Should Fix | - | 0 | 0 | - |
| Pre-existing | - | - | 0 | 0 |

**Security Score**: 9/10
**Recommendation**: APPROVED

## Detailed Analysis

### 1. Shell Injection / Command Injection

The primary security surface in this PR is the new `buildTmuxCommand()` method on `BaseAgentAdapter` (line 114 of `base-agent-adapter.ts`), which constructs a `TmuxSpawnConfig` that eventually flows into `TmuxConnector.spawn()` and the generated wrapper script.

**Trust boundary analysis:**
- `agentArgs` is populated by `buildTmuxArgs()` (Claude/Codex adapters) which constructs args from hardcoded flag strings and an optional model string from config.
- `systemPromptArgs` come from `getSystemPromptConfig()` which produces args from trusted adapter logic.
- These args are forwarded via `config.agentArgs` in `TmuxSpawnConfig` to `TmuxConnector.spawn()`, then to `TmuxHooks.generateWrapper()`.
- In `tmux-hooks.ts:96`, each arg is individually escaped via `singleQuoteToken()` before embedding in the wrapper script. This is the correct defense against word splitting, glob expansion, and shell metacharacters.
- `agentCommand` is validated against `SAFE_PATH_REGEX` (line 189 of `tmux-hooks.ts`) before embedding.
- The feature knowledge documents the trust boundary for `agentCommand`/`agentArgs` in `WrapperConfig` (Constraints section): "Callers must ensure these come from trusted configuration, not user input." This contract holds -- `buildTmuxArgs()` constructs args from adapter-controlled constants and config-file model strings, never from untrusted user input.

**Verdict:** The arg flow is secure. `singleQuoteToken()` correctly handles the `'` -> `'\''` escaping pattern per POSIX shell rules. The args originate from trusted adapter code, not user input.

### 2. Database Migration (v28) -- CHECK Constraint Narrowing

The migration at `database.ts:1070-1143` recreates the `loops` table with a narrowed `CHECK(judge_agent IN ('claude', 'codex'))` constraint, removing `'gemini'`.

**Security aspects:**
- Existing `judge_agent='gemini'` rows are mapped to `NULL` via `CASE WHEN judge_agent = 'gemini' THEN NULL ELSE judge_agent END` (line 1132). This is safe -- `NULL` is explicitly allowed by the CHECK constraint (`judge_agent IS NULL OR ...`).
- The migration runs inside a transaction (the migration framework at line 232 wraps each migration in `db.transaction()`), preventing partial state.
- All three indexes (`idx_loops_status`, `idx_loops_schedule_id`, `idx_loops_updated_at`) are recreated after the table swap.
- The `convergence_enabled` column from v27 is preserved in the new schema.
- Tests verify the CHECK constraint rejects `'gemini'` and accepts `'claude'`, `'codex'`, and `NULL`.
- Uses parameterized queries for all data operations (avoids PF-002 -- clean break, no migration shim for the never-published gemini feature).

**Verdict:** Migration is correct and safe. No SQL injection risk. Data integrity preserved.

### 3. AgentProvider Type Narrowing

`AgentProvider` in `agents.ts:19` is narrowed from `'claude' | 'codex' | 'gemini'` to `'claude' | 'codex'`. This is a compile-time change that narrows the attack surface by removing a code path.

The `TmuxAgentType` (already `Extract<AgentProvider, 'claude' | 'codex'>`) is unchanged because `AgentProvider` was already being narrowed by the Extract. The `as TmuxAgentType` cast at `base-agent-adapter.ts:136` is now safe because the runtime guard at line 118 (`if (this.provider !== 'claude' && this.provider !== 'codex')`) ensures only valid providers reach the cast.

**Verdict:** Type narrowing is sound. The runtime guard precedes the cast.

### 4. Gemini Adapter Deletion

The deleted `gemini-adapter.ts` contained security-relevant code:
- Path traversal guards in `GeminiBasePromptCache.buildCombinedFile()` and `cleanupTaskFile()`
- `0o700` / `0o600` file permissions
- Size limit (`MAX_COMBINED_PROMPT_BYTES = 64KB`)
- Staleness check on cached base prompt

All of this code is deleted, not moved. Since Gemini support is being removed entirely (avoids PF-002 -- no backward-compat for never-published features), the deletion is correct and no security patterns are lost for active code paths.

### 5. Secrets and Credentials

- No hardcoded secrets, tokens, or API keys introduced.
- The `AGENT_AUTH` constant (now `claude` + `codex` only) continues to reference `ANTHROPIC_API_KEY` and `OPENAI_API_KEY` via environment variables, not hardcoded values.
- The `resolveAuth()` flow in `base-agent-adapter.ts` is unchanged and correctly handles API key injection from config files.

### 6. TmuxConnector agentArgs Forwarding

The single-line change at `tmux-connector.ts:166` replaces hardcoded `agentArgs: []` with `agentArgs: config.agentArgs`. This connects the adapter-produced args to the wrapper script generator.

The args flow through `singleQuoteToken()` escaping before shell embedding (tmux-hooks.ts:95-96), providing defense-in-depth even though the args come from trusted adapter code.

### 7. Environment Variable Handling

The `buildSpawnEnv()` method (base-agent-adapter.ts:381-420) correctly:
- Strips nested agent env vars via `envPrefixesToStrip`
- Validates `orchestratorId` against a strict UUID regex before injecting as env var
- Does not expose secrets in log output
- Removes `AUTOBEAT_WORKER` for interactive mode

No changes to these security-critical paths in this PR.

### Decisions Context

- **avoids PF-002**: The PR makes a clean break removing Gemini support rather than adding migration/backward-compatibility paths for the gemini agent (which was never widely deployed). Migration v28 maps existing `judge_agent='gemini'` rows to `NULL` rather than maintaining a deprecated codepath.
- **avoids PF-001**: No security issues are being deferred -- all reviewed patterns are addressed in-branch.
