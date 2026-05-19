# Dependencies Review Report

**Branch**: feat/178-worker-pool-rewiring -> main
**Date**: 2026-05-19

## Issues in Your Changes (BLOCKING)

### CRITICAL

(none)

### HIGH

(none)

## Issues in Code You Touched (Should Fix)

### MEDIUM

**Undocumented system-level runtime dependency on tmux >= 3.0** - `README.md` (missing)
**Confidence**: 85%
- Problem: This PR rewires the entire worker runtime from child processes to tmux sessions. The `TmuxValidator` enforces `tmux >= 3.0` at runtime, and `CLAUDE.md` documents "Requires tmux >= 3.0", but `README.md` does not mention tmux as a prerequisite anywhere. Users installing via `npm install -g autobeat` will have no warning that tmux is required until they attempt to spawn a worker, at which point they receive a runtime error. The `engines` field in `package.json` only specifies `node >= 20.0.0`. While npm's `engines` field does not support system-level binaries, the README's Quick Start and installation sections should list tmux as a prerequisite so users can install it before hitting a runtime failure.
- Fix: Add a "Prerequisites" or "Requirements" section to `README.md` listing `tmux >= 3.0` alongside the existing Node.js >= 20 requirement. Example:
  ```markdown
  ## Prerequisites
  - **Node.js** >= 20.0.0
  - **tmux** >= 3.0 (workers run as tmux sessions)
  ```

## Pre-existing Issues (Not Blocking)

(none)

## Suggestions (Lower Confidence)

- **Consider documenting tmux installation commands per OS** - `README.md` (Confidence: 65%) -- Users unfamiliar with tmux would benefit from platform-specific install instructions (e.g., `brew install tmux` on macOS, `apt install tmux` on Ubuntu).

## Summary

| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 0 | 0 | - |
| Should Fix | - | 0 | 1 | - |
| Pre-existing | - | - | 0 | 0 |

### Dependency Change Analysis

| Aspect | Status |
|--------|--------|
| npm dependencies added | 0 |
| npm dependencies removed | 0 |
| devDependencies added | 0 |
| devDependencies removed | 0 |
| Lockfile updated | No changes needed (no dependency changes) |
| New Node.js built-in imports | `child_process.spawnSync`, `fs`, `path` (in `bootstrap.ts`) |
| New system-level dependency | **tmux >= 3.0** (runtime, validated by `TmuxValidator`) |
| Version ranges | Unchanged -- all existing ranges remain appropriate |
| License impact | None -- no new npm packages |
| Supply chain impact | None -- no new npm packages |
| Bundle size impact | None -- `child_process`, `fs`, `path` are Node.js built-ins |
| Script changes | `test:services` removed deleted `process-connector.test.ts` reference (correct) |

### Key Observations

1. **No npm dependency changes**: The `dependencies` and `devDependencies` objects are byte-identical between main and this branch. The lockfile (`package-lock.json`) is untouched.

2. **System dependency shift**: The PR replaces the child-process-based worker runtime with tmux sessions. This introduces `tmux >= 3.0` as a hard system-level runtime dependency. The validation is handled at runtime by `TmuxValidator` (cached after first success, retried on failure), which provides clear error messages. However, the README omits this prerequisite.

3. **Script consistency**: The `test:services` script correctly removes the reference to the deleted `process-connector.test.ts`. The `test:all` script already includes `test:tmux` and `test:tmux:integration` (added on main before this branch).

4. **No unused dependencies introduced**: The deleted `ProcessConnector` class used only Node.js built-ins (`child_process.ChildProcess`) and internal types. No npm package became orphaned by this removal.

**Dependencies Score**: 9/10
**Recommendation**: APPROVED_WITH_CONDITIONS

Condition: Document `tmux >= 3.0` as a system prerequisite in `README.md` before or alongside this PR's merge. The runtime validator provides a safety net, but user-facing documentation should not rely on runtime error messages as the primary discovery mechanism for a required system dependency.
