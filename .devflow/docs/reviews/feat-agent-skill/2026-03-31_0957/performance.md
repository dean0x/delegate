# Performance Review Report

**Branch**: feat-agent-skill -> main
**Date**: 2026-03-31T09:57:00Z

## Issues in Your Changes (BLOCKING)

_No blocking performance issues found._

### CRITICAL

_None._

### HIGH

_None._

## Issues in Code You Touched (Should Fix)

_No should-fix performance issues found._

## Pre-existing Issues (Not Blocking)

_No critical pre-existing performance issues detected in reviewed files._

## Suggestions (Lower Confidence)

- **MCP_INSTRUCTIONS string allocated at module scope** - `src/adapters/mcp-instructions.ts:8` (Confidence: 65%) -- The ~3.5 KB template literal is allocated once at module load time and held in memory for the process lifetime. This is fine for a server that stays up, but if the string grew significantly (e.g., full capability-matrix docs were inlined), it could bloat the initialization payload sent to every connecting MCP client. Currently ~3.5 KB is well within acceptable limits. No action needed now; keep an eye on growth.

- **cpSync called per-agent without parallelization** - `src/cli/commands/init.ts:162` (Confidence: 62%) -- `defaultCopySkills` iterates agents sequentially, calling `cpSync` for each target directory. With the current 64 KB source directory and at most 3-4 target paths, this completes in single-digit milliseconds. If the skill content grew substantially (e.g., bundled large reference datasets), an async approach with `cp` from `fs/promises` could help, but this is a non-issue at the current scale.

- **skills/ directory added to npm package files** - `package.json:10` (Confidence: 60%) -- The `skills/` directory (64 KB, 6 files) is now included in the published npm tarball. This increases the package download size modestly (~54 KB of markdown). Not a performance concern at this scale, but worth noting in case the skills directory grows with future additions. Consider documenting a size budget or adding a CI check if this directory is expected to expand.

## Summary

| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 0 | 0 | - |
| Should Fix | - | 0 | 0 | - |
| Pre-existing | - | - | 0 | 0 |

**Performance Score**: 9/10
**Recommendation**: APPROVED

## Analysis Notes

### What was reviewed

This PR adds two features:
1. **Agent orchestration skill** -- A set of markdown reference documents (`skills/autobeat/`) packaged with the npm distribution and installable into project directories via `beat init --install-skills`.
2. **MCP server instructions** -- A static instruction string (`MCP_INSTRUCTIONS`) injected into the MCP `InitializeResult` so connecting agents learn Autobeat's capabilities.

Plus formatting cleanup in test files (biome lint/format fixes).

### Why no blocking issues

The runtime code changes are minimal and well-bounded:

- **MCP_INSTRUCTIONS** is a ~3.5 KB static string constant. It is allocated once at module load, referenced once during `Server` construction, and sent once per MCP client initialization. This adds negligible memory and zero hot-path overhead.

- **Skill install logic** (`defaultCopySkills`, `resolveSkillSource`, `getSkillTargetDirs`, `defaultSkillsExist`) runs exclusively during the `beat init` CLI command -- a one-time user-invoked setup operation, not on the server hot path. File I/O via `cpSync` on 64 KB of content is effectively instantaneous. The `existsSync` check in `defaultSkillsExist` is also fine for a CLI flow.

- **Package size impact** is +54 KB of markdown (6 files). This is a trivial addition to the npm tarball and has no runtime performance implication.

- **Test changes** are purely formatting (biome lint fixes) with no behavioral or performance impact.

- No new event handlers, database queries, or hot-path logic was introduced. No new dependencies were added. The `MCP_INSTRUCTIONS` import is a static ES module import that tree-shakes correctly.
