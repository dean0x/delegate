# Security Review Report

**Branch**: feat-agent-skill -> main
**Date**: 2026-03-31T09:57:00Z

## Issues in Your Changes (BLOCKING)

### CRITICAL

(none)

### HIGH

**Missing path validation on skill copy destination** - `src/cli/commands/init.ts:125`
**Confidence**: 85%
- Problem: `getSkillTargetDirs` constructs target paths via `path.resolve(projectRoot, relative)` where `projectRoot` comes from `process.cwd()`. The `AGENT_SKILL_DIRS` constants are hardcoded relative paths (e.g., `.claude/skills/autobeat`), so they are safe. However, the `projectRoot` value is never validated to ensure it is a real, non-symlinked directory. If `process.cwd()` returns a symlinked path, `cpSync` could write files to an unexpected location. The project already has `validatePath()` in `src/utils/validation.ts` which resolves symlinks and prevents traversal -- this utility is not used here.
- Fix: Validate `projectRoot` using the existing `validatePath` utility before passing it to `getSkillTargetDirs` and `defaultCopySkills`:
```typescript
// In runSkillInstall, after const projectRoot = process.cwd();
import { validatePath } from '../../utils/validation.js';

const validatedRoot = validatePath(projectRoot, projectRoot);
if (!validatedRoot.ok) {
  return { code: 1, reason: `Invalid project root: ${validatedRoot.error.message}` };
}
const safeProjectRoot = validatedRoot.value;
```

**`cpSync` overwrites without integrity check** - `src/cli/commands/init.ts:162`
**Confidence**: 82%
- Problem: `cpSync(source, dir, { recursive: true })` copies the entire skill directory tree. If the target directory already exists (the `skillsExist` check confirms this case), `cpSync` with `{ recursive: true }` will overwrite existing files but will NOT remove files that exist in the target but not in the source. This means stale files from a previous skill version persist. While not a direct vulnerability, stale skill files could contain outdated instructions that reference deprecated or insecure patterns, and the user would believe they are running the latest version.
- Fix: Clear the target directory before copying, or use `{ recursive: true, force: true }` combined with pre-removal:
```typescript
import { rmSync } from 'fs';

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

## Issues in Code You Touched (Should Fix)

### MEDIUM

**`resolveSkillSource` relies on relative path traversal from `import.meta.url`** - `src/cli/commands/init.ts:110-112`
**Confidence**: 80%
- Problem: `resolveSkillSource()` computes the skill source path by navigating `../../..` from the current file's location. This works for the expected `dist/cli/commands/init.js` and `src/cli/commands/init.ts` layouts. However, if the package is installed in an unusual way (e.g., `npm link`, monorepo hoisting, or bundled), the three-level traversal could resolve to an unexpected directory. The function does check `existsSync(source)` in the caller (`defaultCopySkills`), so a wrong path would produce an error rather than silent failure. The risk is LOW in practice but the pattern is fragile.
- Fix: Consider verifying the resolved source contains expected files (e.g., check for `SKILL.md`):
```typescript
export function resolveSkillSource(): string {
  const thisFile = fileURLToPath(import.meta.url);
  const source = path.resolve(path.dirname(thisFile), '..', '..', '..', 'skills', 'autobeat');
  return source;
}
// In defaultCopySkills, after existsSync(source):
if (!existsSync(path.join(source, 'SKILL.md'))) {
  return { ok: false, error: `Skill source directory exists but is missing SKILL.md: ${source}` };
}
```

## Pre-existing Issues (Not Blocking)

(none)

## Suggestions (Lower Confidence)

- **MCP_INSTRUCTIONS string injection surface** - `src/adapters/mcp-instructions.ts:8` (Confidence: 65%) -- The `MCP_INSTRUCTIONS` constant is a large static string injected into the MCP `InitializeResult`. While the content is hardcoded (not user-supplied), it becomes part of the system prompt for connecting agents. If this string were ever templated with user input in the future, it could become a prompt injection vector. Current implementation is safe since it is a compile-time constant.

- **Skill content shipped in npm package** - `package.json` `files` array (Confidence: 60%) -- Adding `"skills"` to the `files` array means all markdown files under `skills/` are published to npm. The skill content includes example shell commands (e.g., `npm test`, `node scripts/benchmark.js`) and example file paths. These are documentation examples, not executable, but future additions to the skills directory should be reviewed to ensure no sensitive configuration templates or credentials are accidentally included.

- **No rate limiting on skill copy operations** - `src/cli/commands/init.ts:160-167` (Confidence: 62%) -- The `defaultCopySkills` function iterates over all target directories and copies recursively. With the current 3 agents and small skill file set, this is fine. If the skill content grows significantly or more agents are added, this could become a disk I/O concern, but it is not a security issue at current scale.

## Summary

| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 2 | 0 | - |
| Should Fix | - | 0 | 1 | - |
| Pre-existing | - | - | 0 | 0 |

**Security Score**: 7/10
**Recommendation**: CHANGES_REQUESTED

The two HIGH findings are both related to the new skill copy functionality: (1) missing path validation on the destination directory, and (2) stale files persisting after skill updates. The project already has a robust `validatePath` utility that should be reused here. The stale file concern is lower risk but worth addressing to avoid confusion about which skill version is active. No critical vulnerabilities were found -- the MCP instructions injection is safe as a static string, and the overall architecture (dependency injection, Result types, user confirmation prompts) follows secure patterns.
