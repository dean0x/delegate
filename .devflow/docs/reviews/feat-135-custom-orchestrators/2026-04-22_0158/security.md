# Security Review Report

**Branch**: feat/135-custom-orchestrators -> main
**Date**: 2026-04-22

## Issues in Your Changes (BLOCKING)

### CRITICAL

No critical issues found.

### HIGH

No high issues found.

### MEDIUM

**Unsanitized `model` string interpolated into shell command instruction text** - `src/services/orchestrator-prompt.ts:74`, `src/adapters/mcp-adapter.ts:3296`
**Confidence**: 82%
- Problem: The `model` field is validated only as `z.string().min(1).max(200)` and then interpolated directly into delegation instruction text via template literals (e.g., `beat run --model ${model} "<prompt>"`). While these strings are instructional text for an AI agent (not directly executed), a crafted model string like `"; rm -rf / #` could appear in the generated shell command examples. An AI agent following these instructions literally could execute the injected command. The `agent` field is safe because it uses `z.enum()` with a fixed allowlist. This is a pre-existing pattern in `buildOrchestratorPrompt` (line 178), but this PR exposes it through two new surfaces: the snippet builders and the InitCustomOrchestrator MCP tool response.
- Fix: Add a regex validation to the model field in `InitCustomOrchestratorSchema` (and ideally to all model schemas) to restrict characters to alphanumerics, hyphens, dots, and underscores:
  ```typescript
  model: z.string().min(1).max(200).regex(/^[a-zA-Z0-9._-]+$/, 'Model name contains invalid characters').optional()
  ```

## Issues in Code You Touched (Should Fix)

No should-fix issues found.

## Pre-existing Issues (Not Blocking)

### MEDIUM

**Exit condition script is world-readable on some systems** - `src/core/orchestrator-state.ts:139`
**Confidence**: 80%
- Problem: The exit condition script is written with mode `0o700` (owner rwx), but state files at line 99 use `0o600` (owner rw). The script file permissions are appropriate. However, the `mkdirSync` on line 130 uses `0o700` but `mkdirSync` with `recursive: true` may not apply the mode to already-existing parent directories. If `~/.autobeat` already exists with broader permissions, the state directory inherits those permissions. This is pre-existing behavior (not introduced by this PR).

## Suggestions (Lower Confidence)

- **Goal string not length-limited** - `src/adapters/mcp-adapter.ts:339` (Confidence: 65%) -- The `goal` field in `InitCustomOrchestratorSchema` has `.min(1)` but no `.max()`. An extremely long goal is written to the state file JSON and embedded in instruction strings. Consider adding a reasonable max length (e.g., 10000 characters) to prevent oversized state files and prompt strings.

- **State file path exposed in MCP response** - `src/adapters/mcp-adapter.ts:3316` (Confidence: 62%) -- The full filesystem path to `~/.autobeat/orchestrator-state/` is returned in the MCP tool response. This reveals the home directory path to the MCP client. This is consistent with how `CreateOrchestrator` already operates and is an inherent part of the design (the client needs the path to use it), but worth noting for environments where the home directory path is sensitive.

## Summary

| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 0 | 1 | 0 |
| Should Fix | 0 | 0 | 0 | 0 |
| Pre-existing | 0 | 0 | 1 | 0 |

**Security Score**: 8/10
**Recommendation**: APPROVED_WITH_CONDITIONS

The PR demonstrates good security practices overall:
- Input validation via Zod schemas at the MCP boundary
- Path traversal protection via `validatePath()` with symlink resolution
- Restrictive file permissions (0o700/0o600) on generated files
- Atomic writes (temp + rename) for state files
- Safe script generation using `JSON.stringify()` for path embedding
- Agent field uses enum validation (not free-form)
- State file directory is hardcoded (not user-controllable)

The one blocking MEDIUM finding (unsanitized model string in shell command examples) is a defense-in-depth concern. The model string passes through Zod validation and the generated text is instructional (not directly executed), but adding a character-class restriction would eliminate the theoretical injection vector at low cost.
