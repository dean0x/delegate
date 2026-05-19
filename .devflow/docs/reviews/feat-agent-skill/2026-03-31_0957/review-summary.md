# Code Review Summary

**Branch**: feat-agent-skill -> main
**Date**: 2026-03-31T09:57:00Z
**Reviewed Commits**: a4a1775 (feat: add agent orchestration skill and skill installer), 498049b (style: fix pre-existing biome lint and format issues)

## Merge Recommendation: CHANGES_REQUESTED

The PR introduces well-architected skill installation and MCP instructions features with excellent test coverage and dependency injection patterns. However, there are **3 blocking issues that must be fixed before merge**:

1. **HIGH (95% confidence)**: Incorrect parameter name in MCP instructions (`orchestrationId` should be `orchestratorId`)
2. **HIGH (90% confidence)**: Variable `p` shadows `@clack/prompts` import, creating maintenance hazard
3. **HIGH (85% confidence)**: Missing path validation on skill copy destination; existing `validatePath` utility not used

All three are straightforward to fix. The PR will be approvable once these are resolved.

---

## Issue Summary

| Category | CRITICAL | HIGH | MEDIUM | LOW | Total |
|----------|----------|------|--------|-----|-------|
| Blocking | 0 | 3 | 0 | - | **3** |
| Should Fix | - | 0 | 5 | - | **5** |
| Pre-existing | - | - | 0 | 1 | **1** |

---

## Blocking Issues (HIGH - Must Fix Before Merge)

### 1. Incorrect MCP Instructions Parameter Name
**File**: `src/adapters/mcp-instructions.ts:63`
**Confidence**: 95%

The MCP instructions reference `OrchestratorStatus with orchestrationId`, but the actual Zod schema in `mcp-adapter.ts:212` uses `orchestratorId`. Agents following these instructions will send the wrong parameter name and get validation errors.

**Fix**:
```typescript
// Change line 63 from:
- OrchestratorStatus with orchestrationId -> see plan steps and progress
// to:
- OrchestratorStatus with orchestratorId -> see plan steps and progress
```

---

### 2. Variable Shadowing: `p` Shadows @clack/prompts Import
**Files**: `src/cli/commands/init.ts:479`, `src/cli/commands/init.ts:490`
**Confidence**: 90%

The loop variable `for (const p of result.skillPaths)` shadows the module-level `import * as p from '@clack/prompts'`. While the shadowed import isn't used in the loop body now, this creates a fragile maintenance hazard. Any future `p.log()` or `p.note()` call inside the loop would silently fail.

**Fix**:
```typescript
// Rename both occurrences (lines 479 and 490):
for (const skillPath of result.skillPaths) {
  ui.step(`  ${skillPath}`);
}
```

---

### 3. Missing Path Validation on Skill Copy Destination
**File**: `src/cli/commands/init.ts:125` (in `runSkillInstall`)
**Confidence**: 85%

The `getSkillTargetDirs` constructs target paths via `path.resolve(projectRoot, relative)` where `projectRoot` comes from `process.cwd()`. The project already has a robust `validatePath()` utility in `src/utils/validation.ts` that resolves symlinks and prevents directory traversal. This utility is not used here, creating a potential security issue if `process.cwd()` returns a symlinked path.

**Fix**:
```typescript
import { validatePath } from '../../utils/validation.js';

// In runSkillInstall, after const projectRoot = process.cwd();
const validatedRoot = validatePath(projectRoot, projectRoot);
if (!validatedRoot.ok) {
  return { code: 1, reason: `Invalid project root: ${validatedRoot.error.message}` };
}
const safeProjectRoot = validatedRoot.value;

// Then use safeProjectRoot in getSkillTargetDirs and defaultCopySkills calls
```

---

## Should-Fix Issues (MEDIUM - Should Address Together)

### 1. Duplicated Skill-Path Display Logic
**Files**: `src/cli/commands/init.ts:477-482`, `src/cli/commands/init.ts:488-493`
**Reviewers**: Architecture (90%), Complexity (90%), Consistency (85%), TypeScript (85%)
**Aggregate Confidence**: 87%

The interactive and non-interactive branches contain identical 5-line blocks for displaying installed skill paths. This violates DRY and risks divergence if one branch is updated but not the other.

**Fix**:
```typescript
function displaySkillPaths(paths: readonly string[]): void {
  if (paths.length > 0) {
    ui.success('Agent skills installed:');
    for (const skillPath of paths) {
      ui.step(`  ${skillPath}`);
    }
  }
}

// Then in initCommand, call once before the if (isInteractive) branch:
if ('agent' in result) {
  if (result.status.hint) {
    ui.info(result.status.hint);
  }
  displaySkillPaths(result.skillPaths ?? []);
  // ... rest of logic
}
```

---

### 2. Stale Files Persist After Skill Copy
**File**: `src/cli/commands/init.ts:162`
**Confidence**: 82%

`cpSync(source, dir, { recursive: true })` copies files but does NOT remove files that exist in the target but not in the source. Stale files from previous skill versions could persist, and users would believe they're running the latest version while actually running outdated instructions.

**Fix**:
```typescript
for (const dir of dirs) {
  try {
    if (existsSync(dir)) {
      rmSync(dir, { recursive: true, force: true });
    }
    cpSync(source, dir, { recursive: true });
    installed.push(dir);
  } catch (e) {
    return { ok: false, error: `Failed to copy skills to ${dir}: ${e instanceof Error ? e.message : String(e)}` };
  }
}
```

---

### 3. `parseSkillsAgents` Uses Union Instead of Result Type
**File**: `src/cli/commands/init.ts:175`
**Reviewers**: TypeScript (80%), Consistency (82%)
**Aggregate Confidence**: 81%

The function returns `readonly AgentProvider[] | string` (where `string` is an error), not the project's canonical `Result<T, E>` type. This is inconsistent with the engineering principle "Always use Result types" and deviates from the pattern used in other CLI command parsers.

**Fix**:
```typescript
import { type Result, ok, err } from '../../core/result.js';

export function parseSkillsAgents(value: string): Result<readonly AgentProvider[], string> {
  const parts = value.split(',').map((s) => s.trim()).filter(Boolean);
  for (const part of parts) {
    if (!isAgentProvider(part)) {
      return err(`Unknown agent in --skills-agents: "${part}". Available: ${AGENT_PROVIDERS.join(', ')}`);
    }
  }
  return ok(parts as AgentProvider[]);
}

// Update caller:
const parsed = parseSkillsAgents(options.skillsAgents);
if (!parsed.ok) {
  return { code: 1, reason: parsed.error };
}
agents = parsed.value;
```

---

### 4. `defaultCopySkills` Uses Ad-Hoc Shape Instead of Result Type
**File**: `src/cli/commands/init.ts:148-170`
**Confidence**: 80%

The function returns `{ ok: true; paths: readonly string[] } | { ok: false; error: string }` instead of the canonical `Result<readonly string[], string>`. While structurally similar, it avoids the project's standardized type.

**Fix**:
```typescript
import { type Result, ok, err } from '../../core/result.js';

export function defaultCopySkills(
  agents: readonly AgentProvider[],
  projectRoot: string,
): Result<readonly string[], string> {
  // ... implementation ...
  return ok(installed);
  // or:
  return err(`Failed to copy skills to ${dir}: ...`);
}

// Update return type on InitDeps:
readonly copySkills?: (agents: readonly AgentProvider[], projectRoot: string) => Result<readonly string[], string>;
```

---

### 5. `process.cwd()` Not Injected as Dependency
**File**: `src/cli/commands/init.ts:277`
**Confidence**: 82%

`runSkillInstall` hardcodes `const projectRoot = process.cwd()` instead of receiving it as a parameter or through `InitDeps`. This couples the function to global process state and makes testing with custom project roots impossible without changing the actual working directory.

**Fix**:
```typescript
// Option 1: Add parameter
async function runSkillInstall(
  defaultAgent: AgentProvider,
  options: InitOptions,
  deps: InitDeps,
  projectRoot: string,  // Add this
): Promise<SkillInstallResult> {
  // Use projectRoot instead of process.cwd()
}

// Option 2: Add to InitDeps
readonly getProjectRoot?: () => string;
// Then: const projectRoot = deps.getProjectRoot?.() ?? process.cwd();
```

---

## Documentation Issues (Should Address)

### 1. Missing Flags in Capability Matrix
**File**: `skills/autobeat/references/capability-matrix.md:413-415`
**Confidence**: 85%

The Setup Commands section documents `beat init --install-skills` but omits `--skills-agents <agents>` and `--yes` (`-y`) flags that are implemented. Agents cannot discover how to do non-interactive skill installs for specific agent targets.

**Fix**: Expand setup commands section to include:
```
beat init --install-skills --skills-agents claude,codex
beat init --yes
```

---

### 2. README Not Updated with Skill Installation
**File**: `README.md`
**Confidence**: 82%

The Quick Start section shows `beat init` but doesn't mention the new `--install-skills` capability. New users won't discover skills can be installed. The README is the primary entry point.

**Fix**: Add brief mention after existing `beat init`:
```bash
# Initialize and install agent skills
beat init --install-skills
```

---

### 3. CLAUDE.md Project Guide Not Updated
**File**: `CLAUDE.md`
**Confidence**: 80%

The File Locations table doesn't include `src/adapters/mcp-instructions.ts` or the `skills/` directory. Developers working on the project won't know where to find or modify the skill content.

**Fix**: Add to File Locations table:
```
| MCP instructions | `src/adapters/mcp-instructions.ts` |
| Agent skill content | `skills/autobeat/` |
```

---

## Additional Testing Gaps (Informational)

### 1. No Direct Unit Tests for Utility Functions
**File**: `src/cli/commands/init.ts:109-186`
**Confidence**: 85%

Five new exported functions (`resolveSkillSource`, `getSkillTargetDirs`, `defaultSkillsExist`, `defaultCopySkills`, `AGENT_SKILL_DIRS`) lack direct unit tests. They're only exercised indirectly through high-level integration tests. The `getSkillTargetDirs` deduplication logic (especially with multiple agents sharing directories) deserves direct coverage.

---

### 2. No MCP Instructions Coverage in Adapter Tests
**File**: `src/adapters/mcp-adapter.ts:403`, `src/adapters/mcp-instructions.ts`
**Confidence**: 82%

The 99 adapter tests don't verify that the `instructions` field is set on the server's initialize response. This is a user-facing behavioral change that should have test coverage.

---

## Pre-existing Issues (Not Your Responsibility)

### Hint Display Block Already Duplicated
**File**: `src/cli/commands/init.ts:474-476`, `485-487`
**Confidence**: 85%

The `result.status.hint` display was already duplicated before this PR. Mentioned for context when refactoring the skill-path display.

---

## Quality Assessment

| Dimension | Score | Notes |
|-----------|-------|-------|
| **Security** | 7/10 | HIGH issues with path validation and stale files, but no critical vulnerabilities |
| **Architecture** | 8/10 | Excellent DI patterns; code duplication and optional deps fragmentation are design considerations |
| **Performance** | 9/10 | No blocking issues; 3.5 KB MCP string and 64 KB skill files are negligible |
| **Complexity** | 8/10 | Well-structured; `runSkillInstall` at 11 branches is upper-end acceptable for a CLI flow |
| **Consistency** | 7/10 | Deviations from Result type pattern and variable shadowing need attention |
| **Regression** | 9/10 | All new deps optional; existing flows untouched; 425 tests pass |
| **Testing** | 7/10 | 46 tests cover high-level flow well; utility function coverage gaps |
| **TypeScript** | 8/10 | HIGH issue with variable shadowing; MEDIUM issues with immutability and type patterns |
| **Documentation** | 7/10 | HIGH issue with incorrect parameter name; MEDIUM gaps in user-facing docs |

---

## Summary by Reviewer

| Reviewer | Recommendation | Key Finding |
|----------|----------------|-------------|
| Security | CHANGES_REQUESTED | Path validation missing; stale files persist |
| Architecture | APPROVED_WITH_CONDITIONS | Extract duplicated display logic; optional deps design |
| Performance | APPROVED | No issues found; 3.5 KB and 64 KB are negligible |
| Complexity | APPROVED_WITH_CONDITIONS | High duplication in display logic; reasonable cyclomatic complexity |
| Consistency | CHANGES_REQUESTED | Variable shadowing; Result type deviation; code duplication |
| Regression | APPROVED | No regression risk; all 425 tests pass |
| Testing | APPROVED_WITH_CONDITIONS | Good high-level coverage; utility function gaps |
| TypeScript | APPROVED_WITH_CONDITIONS | Variable shadowing and type pattern issues |
| Documentation | CHANGES_REQUESTED | Incorrect parameter name in instructions; missing flags in docs |

---

## Action Plan

**Before Merge** (Priority Order):

1. Fix HIGH (95%): Correct `orchestrationId` → `orchestratorId` in MCP instructions
2. Fix HIGH (90%): Rename loop variable `p` → `skillPath` (2 places)
3. Fix HIGH (85%): Add path validation using existing `validatePath` utility
4. Fix MEDIUM (87%): Extract duplicated skill-path display logic into helper function
5. Fix MEDIUM (82%): Remove stale files before copying: add `rmSync` call
6. Fix MEDIUM (81%): Convert `parseSkillsAgents` to use `Result` type
7. Fix MEDIUM (80%): Convert `defaultCopySkills` return to use `Result` type
8. Fix MEDIUM (80%): Inject `projectRoot` as parameter or through `InitDeps`

**Documentation Updates** (After code fixes):

9. Update capability matrix with `--skills-agents` and `--yes` flags
10. Update README Quick Start with `--install-skills`
11. Update CLAUDE.md File Locations table with new files

**Optional** (Can be deferred to follow-up PR):

- Add direct unit tests for `getSkillTargetDirs` deduplication logic
- Add MCP instructions coverage in adapter tests

---

## Technical Notes

- **Design patterns**: The skill installer follows excellent DI patterns and is fully testable without mocks
- **Test coverage**: 46 tests covering interactive, non-interactive, cancellation, error, and multi-agent flows
- **Skill content**: Comprehensive SKILL.md and 5 well-structured reference documents
- **No dependencies added**: Pure filesystem operations using built-in Node APIs
- **No regression risk**: All new `InitDeps` fields are optional; existing code paths untouched

The feature is well-designed and the implementation is solid. The issues are fixable and none require architectural changes.
