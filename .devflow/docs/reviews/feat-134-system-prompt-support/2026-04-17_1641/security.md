# Security Review Report

**Branch**: feat/134-system-prompt-support -> main
**Date**: 2026-04-17T16:41
**PR**: #147
**Commits**: 7 (c43d303..ef16f93)

## Issues in Your Changes (BLOCKING)

### HIGH

**System prompt temp files written with default umask (0644) instead of restricted permissions** - `src/implementations/gemini-adapter.ts:80-81`, `src/cli/commands/agents.ts:242`
**Confidence**: 90%
- Problem: `writeFileSync(systemPromptPath, combined, 'utf8')` and `mkdirSync(cacheDir, { recursive: true })` use the default umask, creating world-readable files and directories under `~/.autobeat/system-prompts/`. System prompts may contain sensitive instructions, proprietary context, or API usage patterns. The codebase already uses `mode: 0o700` for the orchestrator state directory (`orchestration-manager.ts:113`), agent config directory (`configuration.ts:166`), and orchestrator state files (`orchestrator-state.ts:97,130`), establishing the convention that `~/.autobeat/` subdirectories should be owner-only.
- Impact: On shared systems or multi-tenant environments, other users can read system prompt contents from temp files. The `gemini-base.md` cache and per-task combined prompt files persist on disk during task execution.
- Fix:
  ```typescript
  // gemini-adapter.ts:80
  mkdirSync(cacheDir, { recursive: true, mode: 0o700 });
  writeFileSync(systemPromptPath, combined, { encoding: 'utf8', mode: 0o600 });

  // agents.ts:242
  mkdirSync(cacheDir, { recursive: true, mode: 0o700 });

  // agents.ts:295 (metadata file)
  writeFileSync(metaPath, JSON.stringify(meta, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 });
  ```

### MEDIUM

**Codex `-c developer_instructions=<text>` may truncate system prompt at first newline depending on CLI arg parsing** - `src/implementations/codex-adapter.ts:41`
**Confidence**: 80%
- Problem: The Codex CLI receives `['-c', 'developer_instructions=<full system prompt text>']`. If the Codex CLI internally splits on `=` and then further parses the value, multi-line system prompts or prompts containing `=` may behave unexpectedly. While `child_process.spawn` correctly passes the full string as a single argv element (no shell interpretation), the Codex CLI's internal `-c key=value` parsing is an external contract that is not validated in tests.
- Impact: System prompts with certain characters could be silently truncated or misinterpreted by the Codex CLI, leading to unexpected agent behavior. This is not a direct code injection vulnerability (spawn uses argv, not shell), but it is a data integrity concern at the security boundary between autobeat and the Codex CLI.
- Fix: Add a test with a multi-line system prompt containing `=` characters to verify round-trip through the Codex adapter. If the Codex CLI has documented limitations, document them in the adapter's JSDoc and validate/reject unsupported patterns at the boundary.

**No system prompt size validation on the CLI path** - `src/cli.ts:180-188`, `src/cli/commands/loop.ts:318-323`, `src/cli/commands/orchestrate.ts:162-166`
**Confidence**: 82%
- Problem: The MCP adapter enforces `.max(16000)` via Zod on systemPrompt, but the CLI path (`beat run --system-prompt`, `beat loop --system-prompt`, `beat orchestrate --system-prompt`) accepts arbitrarily large strings. The only check is `!next.startsWith('-')`. A user could pass a multi-megabyte system prompt via the CLI that bypasses the 16KB limit enforced on MCP callers. This prompt is then stored in SQLite (no column length constraint) and written to temp files.
- Impact: Inconsistent boundary validation between MCP and CLI entry points. Very large system prompts could cause performance degradation in SQLite storage, temp file creation, and arg passing to child processes. Defense in depth requires consistent limits at all boundaries.
- Fix:
  ```typescript
  // In each CLI --system-prompt parser:
  const MAX_SYSTEM_PROMPT_LENGTH = 16_000;
  if (next.length > MAX_SYSTEM_PROMPT_LENGTH) {
    return err(`--system-prompt must not exceed ${MAX_SYSTEM_PROMPT_LENGTH} characters (got ${next.length})`);
  }
  ```

## Issues in Code You Touched (Should Fix)

### MEDIUM

**CLI `--system-prompt` rejects prompts starting with `-`, blocking legitimate content** - `src/cli.ts:182`, `src/cli/commands/loop.ts:319`, `src/cli/commands/orchestrate.ts:163`
**Confidence**: 85%
- Problem: All three CLI parsers use `!next.startsWith('-')` to distinguish flags from values. A system prompt that legitimately starts with a dash (e.g., `"- Follow these rules:\n1. ..."`) is rejected. The MCP path does not have this restriction. This is a functional issue with a security dimension: the inconsistency between CLI and MCP validation surfaces means behavior differs per entry point.
- Impact: Users who provide system prompts starting with `-` via CLI get a confusing error ("--system-prompt requires a prompt string") while the same prompt works fine via MCP. Workaround exists (prepend a space), but inconsistent validation is a maintenance hazard.
- Fix: Use a dedicated sentinel or `--` separator pattern, or document the constraint. Alternatively, always consume the next arg as the value:
  ```typescript
  } else if (arg === '--system-prompt') {
    const next = foregroundArgs[i + 1];
    if (next === undefined) {
      ui.error('--system-prompt requires a prompt string');
      process.exit(1);
    }
    options.systemPrompt = next;
    i++;
  }
  ```

## Pre-existing Issues (Not Blocking)

No critical pre-existing security issues found in the touched files.

## Suggestions (Lower Confidence)

- **System prompt content not sanitized for control characters before CLI arg injection** - `src/implementations/claude-adapter.ts:48`, `src/implementations/codex-adapter.ts:41` (Confidence: 65%) -- While `child_process.spawn` with an argv array prevents shell injection, system prompts containing NUL bytes (`\x00`) could truncate the argument at the C level in the child process. Consider stripping NUL bytes from systemPrompt before passing to adapters.

- **TOCTOU on gemini-base.md cache read** - `src/implementations/gemini-adapter.ts:61-81` (Confidence: 62%) -- The adapter checks `existsSync(baseCachePath)`, then `statSync`, then `readFileSync` in separate calls. Another process could modify or delete the file between checks. The `try/catch` fallback to `prependToPrompt` mitigates this to a graceful degradation, but the stat check for staleness could report incorrect age.

- **Cleanup of system prompt temp files is best-effort with silent catch** - `src/implementations/event-driven-worker-pool.ts:305-312` (Confidence: 70%) -- The `unlinkSync` cleanup catches all errors silently. On long-running servers, orphan `.md` files accumulate in `~/.autobeat/system-prompts/`. Consider periodic cleanup (e.g., during task cleanup) or logging a warning when unlink fails for reasons other than ENOENT.

## Summary

| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 1 | 2 | 0 |
| Should Fix | 0 | 0 | 1 | 0 |
| Pre-existing | 0 | 0 | 0 | 0 |

**Security Score**: 7/10
**Recommendation**: CHANGES_REQUESTED

The PR demonstrates good security awareness in several areas: it uses `child_process.spawn` with argv arrays (preventing shell injection), validates orchestratorId format at the spawn boundary, and applies Zod validation on the MCP entry points. The primary concerns are: (1) temp file permissions inconsistent with the project's established `0o700`/`0o600` convention for sensitive data, and (2) missing size validation on the CLI entry point that bypasses the 16KB limit enforced on MCP callers.

### What went well (security positives in this PR)

- **No shell injection risk**: All three adapters pass systemPrompt through `child_process.spawn` argv arrays, never through shell string interpolation.
- **Path traversal not possible**: taskId is always `task-<uuid>` (hex + dashes only), so `path.join(homedir, '.autobeat', 'system-prompts', taskId + '.md')` cannot escape the target directory.
- **Zod boundary validation on MCP**: All MCP tool schemas enforce `.max(16000)` on systemPrompt.
- **Graceful degradation**: Gemini adapter falls back to prompt prepend when cache is unavailable, rather than failing open or throwing.
- **System prompt inheritance on retry/resume**: Both `retry()` and `resume()` in task-manager.ts correctly propagate systemPrompt from the original task, maintaining consistent security context.
