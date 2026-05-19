# Observed Patterns

## Bulk Rename Strategy
- **Pattern**: Use `sed` for unique identifiers (DelegateError, DelegateEvent, etc.) because no collision risk
- **Exception**: Use targeted Edit tool for collisions or context-sensitive changes (comments, help text, fixtures)
- **Benefit**: Bulk sed is faster and maintains consistency; targeted Edit handles nuance (discovered: 2026-03-03)

## Pre-commit Hook Auto-commit Behavior
- **Pattern**: Biome auto-fix (import sorting) triggers pre-commit hook that auto-commits changes
- **Risk**: Can silently commit formatting changes; always verify git status after running `check:fix`
- **Mitigation**: Check git status immediately after linter auto-fixes (discovered: 2026-03-03)

## Background Agent Parallelization
- **Pattern**: Launch background agents for independent, non-blocking work (docs updates, GitHub file changes) while continuing main work
- **Benefit**: Eliminates context switching; multiple independent updates proceed concurrently
- **Trade-off**: Must collect and verify agent results before committing (discovered: 2026-03-03)

## Test Suite Memory Management
- **Pattern**: Sequential test groups (test:core, test:cli, test:adapters, etc.) prevent Vitest worker memory accumulation
- **Root cause**: Vitest workers don't fully release memory between test files; sequential groups restart fresh
- **Config**: vmMemoryLimit: '1024MB' triggers worker restart; --max-old-space-size=2048 global limit
- **Impact**: test:all can run safely; `npm test` is blocked to prevent Claude Code crashes (discovered: 2026-02-26)

## Multi-faceted Sweep Strategy
- **Pattern**: Use distinct grep passes for different reference types:
  - Type names (DelegateError, DelegateEvent, DelegateRequest)
  - Environment variables (DELEGATE_DATABASE_PATH, DELEGATE_DATA_DIR)
  - File paths (.delegate/, delegate.db)
  - Process titles (delegate-cli, delegate-mcp)
  - Comments/docs (Windows APPDATA comment, JSDoc usage examples)
- **Benefit**: Catches systematic gaps; different patterns reveal different miss categories
- **Implementation**: Use regex anchors (-w for word boundary) and context (-C) to confirm intent (discovered: 2026-03-03)

## Verb vs Branding Reference Distinction
- **Pattern**: Preserve "delegate" (verb) but rename "Delegate" (brand) — requires careful exception handling in sed
- **Risk**: Simple global sed can accidentally rename verbs (must use grep to exclude first)
- **Mitigation**: Grep for exceptions before running sed; verify no verb-usage collisions in affected files (discovered: 2026-03-03)

## Lockfile Regeneration Timing
- **Pattern**: Regenerate package-lock.json AFTER all source/test changes, before final commit
- **Reason**: npm install reads package.json name; early regen requires package.json to already be renamed
- **Verification**: Check package-lock.json head for new package name (discovered: 2026-03-03)

## Two-Pass Comprehensive Audit for Bulk Renames
- **Pattern**: Run comprehensive grep sweep TWICE — once after initial implementation, again after verification — to catch systematic gaps
- **Benefit**: Second pass catches references scattered across rarely-edited files (scripts, release notes, CONTRIBUTING guides)
- **Categories**: Different reference types surface in different files; first pass catches main code, second catches peripheral files
- **Implementation**: Use regex anchors (-w), exclusion filters (grep -vi), and multi-pattern passes. Always verify no verb-usage collisions remain.
- **Result**: Zero stragglers on final audit (discovered: 2026-03-03)

## GitHub Repository Rename via API
- **Pattern**: Use `gh api repos/{owner}/{repo} --method PATCH --field name={newname}` for programmatic repo rename
- **Benefit**: Atomic rename; GitHub auto-redirects old URLs to new location
- **Follow-up**: Update local remote URL and pull to verify sync
- **Downstream**: Requires separate step to update all hardcoded URLs in docs/code/configs (discovered: 2026-03-03)

## Branch Protection Override for Merge
- **Pattern**: When PRs fail merge due to branch protection (no merge commits allowed), use `gh pr merge --squash --admin` to override
- **Caveat**: Only works for admins; requires explicit permission. Regular contributors must wait for review/approval.
- **Workflow**: Squash merge combines all commits atomically; branch auto-deletes on merge (discovered: 2026-03-03)

## Bulk URL Updates Across Codebase
- **Pattern**: Find all tracked files with old URL pattern, then bulk sed replace across all files in single command
- **Benefit**: Atomic change across 15+ files; guarantees consistency in one operation
- **Verification**: Search for remaining old URLs post-replacement; verify build/lint pass
- **Implementation**: `git ls-files | xargs grep -l "old-pattern" | xargs sed -i '' 's|old-pattern|new-pattern|g'` (discovered: 2026-03-03)

## Multi-agent Comprehensive Audit for Bulk Renames
- **Pattern**: Launch 5 parallel explorer agents, each auditing a distinct codebase surface (source code, docs, config, tests, CLI/UX)
- **Benefit**: Comprehensive coverage with zero human bias; agents catch references humans might overlook (comments, scripts, fixtures, peripheral files)
- **Scope per agent**: Type names, env vars, file paths, process titles, comments, help text, verb usage distinctions
- **Result**: Final verification that zero stragglers remain; all audit findings consolidated into single report
- **Implementation**: Use Explore subagent_type with distinct "MISSION" prompts per surface area; run in parallel; collect and consolidate results (discovered: 2026-03-03)
