# Performance Review Report

**Branch**: feat/agent-skill -> main
**Date**: 2026-03-31

## Issues in Your Changes (BLOCKING)

### CRITICAL

(none)

### HIGH

(none)

## Issues in Code You Touched (Should Fix)

### MEDIUM

**Redundant `getSkillTargetDirs` computation on the happy path** - `src/cli/commands/init.ts:139,156`
**Confidence**: 82%
- Problem: `defaultSkillsExist` calls `getSkillTargetDirs(agents, projectRoot)` at line 139, and then `defaultCopySkills` calls the same function with the same arguments at line 156. In the `runSkillInstall` flow (lines 319-334), when skills already exist and the user confirms the update, both functions execute sequentially for the same `(agents, projectRoot)` pair, duplicating the path resolution and Set-based deduplication work.
- Impact: Low in absolute terms (this is a CLI init command, not a hot path). The `getSkillTargetDirs` function iterates over agents and their skill dirs with a dedup Set, then `path.resolve` is called for each. For 3 agents this is trivial. However, it represents unnecessary repeated computation on principle.
- Fix: This is injectable via `deps`, so the production wiring could cache or the two functions could share a pre-computed dirs list. However, given this is a one-shot CLI command, the practical impact is negligible. Consider consolidating only if more callers emerge.

**Redundant `existsSync` before `rmSync` with `force: true`** - `src/cli/commands/init.ts:161-163`
**Confidence**: 85%
- Problem: The code checks `if (existsSync(dir))` before calling `rmSync(dir, { recursive: true, force: true })`. The `force: true` flag already suppresses `ENOENT` errors, making the existence check redundant. This is also a TOCTOU window (the directory could be created or removed between the check and the operation), though this is not a security concern for a local CLI tool.
- Impact: Two synchronous filesystem calls where one suffices. Minimal wall-clock cost, but the pattern is misleading to future readers who may think `rmSync` without `force` requires the guard.
- Fix: Remove the existence check and call `rmSync` unconditionally:
  ```typescript
  for (const dir of dirs) {
    try {
      rmSync(dir, { recursive: true, force: true });
      cpSync(source, dir, { recursive: true });
      installed.push(dir);
    } catch (e) {
      return err(`Failed to copy skills to ${dir}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  ```

## Pre-existing Issues (Not Blocking)

(none)

## Suggestions (Lower Confidence)

- **MCP instructions string is ~4.5KB allocated at module scope** - `src/adapters/mcp-instructions.ts:8` (Confidence: 65%) -- The `MCP_INSTRUCTIONS` string constant is ~4.5KB and is always loaded even if the MCP adapter is never instantiated (e.g., CLI-only paths). This is a one-time module-level cost and not concerning at this size, but worth noting if the string grows significantly.

- **`resolveSkillSource` recomputes `fileURLToPath` on every call** - `src/cli/commands/init.ts:108-112` (Confidence: 60%) -- Each invocation calls `fileURLToPath(import.meta.url)` and does multiple `path.resolve` joins. Currently called once per `defaultCopySkills`, but if ever called in a loop or multiple times per request, the result could be cached as a module-level lazy constant.

## Summary

| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 0 | 0 | - |
| Should Fix | - | 0 | 2 | - |
| Pre-existing | - | - | 0 | 0 |

**Performance Score**: 9/10
**Recommendation**: APPROVED

This diff is overwhelmingly documentation (skill content files, capability matrix, reference docs) and formatting-only test changes (import reordering, line wrapping by Biome). The actual runtime code changes are:

1. A new `MCP_INSTRUCTIONS` constant injected into the MCP server initialization (one-time cost, appropriate).
2. New skill install logic in `init.ts` (CLI-only, one-shot command, not performance-sensitive).
3. No changes to hot paths (task execution, event handling, worker management, database queries).

The two MEDIUM findings are correctness/cleanliness improvements rather than performance risks. No blocking issues.
