# Documentation Review Report

**Branch**: feat-agent-skill -> main
**Date**: 2026-03-31T09:57

## Issues in Your Changes (BLOCKING)

### HIGH

**Incorrect parameter name in MCP instructions** - `src/adapters/mcp-instructions.ts:63`
**Confidence**: 95%
- Problem: The MCP instructions reference `OrchestratorStatus with orchestrationId` but the actual Zod schema in `mcp-adapter.ts:212` uses `orchestratorId`. Any agent following these instructions will send the wrong parameter name and get a validation error.
- Fix: Change line 63 from:
  ```
  - OrchestratorStatus with orchestrationId -> see plan steps and progress
  ```
  to:
  ```
  - OrchestratorStatus with orchestratorId -> see plan steps and progress
  ```

### MEDIUM

**Capability matrix missing `--skills-agents` and `--yes` flags for `beat init`** - `skills/autobeat/references/capability-matrix.md:413-415`
**Confidence**: 85%
- Problem: The Setup Commands section documents `beat init --install-skills` but omits `--skills-agents <agents>` and `--yes` (`-y`) flags that are implemented in `src/cli/commands/init.ts`. Agents reading the capability matrix cannot discover how to do non-interactive skill installs for specific agent targets.
- Fix: Expand the setup commands section:
  ```
  beat init                                     Interactive setup
  beat init --agent <name>                      Non-interactive setup
  beat init --install-skills                    Install agent skills
  beat init --install-skills --skills-agents claude,codex  Install for specific agents
  beat init --yes                               Skip confirmation prompts
  beat agents list                              Show agents with status
  beat help                                     Show help
  ```

**README.md not updated with skill installation instructions** - `README.md`
**Confidence**: 82%
- Problem: The README Quick Start section shows `beat init` but does not mention the new `--install-skills` capability or the agent skill feature. Users installing autobeat for the first time will not discover that skills can be installed to improve agent orchestration awareness. The README is the primary user-facing documentation and the entry point for new users.
- Fix: Add a brief mention of skill installation after the existing `beat init` in the Quick Start section, e.g.:
  ```bash
  # Initialize - detects installed agents, sets defaults, installs skills
  beat init --install-skills
  ```

## Issues in Code You Touched (Should Fix)

### MEDIUM

**CLAUDE.md MCP Tools table missing `--install-skills` init flag** - `CLAUDE.md`
**Confidence**: 80%
- Problem: The CLAUDE.md Quick Start section shows `beat init` without the new `--install-skills` flag, and the File Locations table does not include the new `src/adapters/mcp-instructions.ts` file or the `skills/` directory. Developers working on the project will not know where to find or modify the skill content.
- Fix: Add `mcp-instructions.ts` and `skills/` entries to the File Locations table:
  ```
  | MCP instructions | `src/adapters/mcp-instructions.ts` |
  | Agent skill content | `skills/autobeat/` |
  ```

## Pre-existing Issues (Not Blocking)

No pre-existing documentation issues identified.

## Suggestions (Lower Confidence)

- **Missing `docs/FEATURES.md` entry for skill installation** - `docs/FEATURES.md` (Confidence: 70%) -- The features doc has no mention of the new skill installation feature. This is an established pattern in the project for documenting capabilities.

- **No versioning or changelog entry for skill/MCP-instructions feature** - `docs/releases/` (Confidence: 65%) -- The skill installer and MCP instructions are user-facing features that would benefit from a release notes entry when the version is bumped.

- **Skill SKILL.md frontmatter `user-invocable: false` undocumented** - `skills/autobeat/SKILL.md:7` (Confidence: 62%) -- The skill uses frontmatter fields (`user-invocable`, `allowed-tools`) that follow a convention but are not documented anywhere in this project for maintainers to understand the contract.

## Summary

| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 1 | 1 | 0 |
| Should Fix | 0 | 0 | 1 | 0 |
| Pre-existing | 0 | 0 | 0 | 0 |

**Documentation Score**: 7/10
**Recommendation**: CHANGES_REQUESTED

The documentation content itself is comprehensive and well-structured -- the skill files, capability matrix, and reference documents are thorough and largely accurate. The blocking HIGH issue is a concrete bug: the MCP instructions tell agents to use `orchestrationId` when the actual API expects `orchestratorId`, which will cause runtime failures for any agent following the instructions. The MEDIUM issues are about discoverability of the new skill installation feature in existing user-facing docs (README, CLAUDE.md, capability matrix).
