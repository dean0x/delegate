# Complexity Review Report

**Branch**: fix/orchestrator-loop-termination -> main
**Date**: 2026-05-14

## Issues in Your Changes (BLOCKING)

### HIGH

**`buildOrchestratorPrompt` conditional duplication increases branching complexity** - `src/services/orchestrator-prompt.ts:186-238`
**Confidence**: 85%
- Problem: The function now has three separate ternary conditionals that branch on `stateFilePath` truthiness (`stateFileSection`, `decisionProtocol`, `resilienceSection`), each producing multi-line template literal variants. This increases the cyclomatic complexity of `buildOrchestratorPrompt` from ~3 to ~6 and makes the two "modes" (state-file vs agent-eval) harder to reason about as a unit. The conditional is semantically the same check repeated three times with different content, which makes it easy for the two variants to drift apart during maintenance.
- Fix: Extract the two prompt variants into a helper that returns all three strings from a single branch:
```typescript
function buildStateAwareSections(stateFilePath?: string): {
  stateFileSection: string;
  decisionProtocol: string;
  resilienceSection: string;
} {
  if (stateFilePath) {
    return {
      stateFileSection: `STATE FILE: ${stateFilePath}\n...`,
      decisionProtocol: `DECISION PROTOCOL:\n1. Read state file...`,
      resilienceSection: `RESILIENCE:\n- If the state file...`,
    };
  }
  return {
    stateFileSection: '',
    decisionProtocol: `DECISION PROTOCOL:\n1. Check status...`,
    resilienceSection: `RESILIENCE:\n- If context is lost...`,
  };
}
```
This consolidates the branching to a single decision point and makes it obvious that both paths must stay in sync.

### MEDIUM

**`checkConvergence` nesting depth reaches 4 levels in git convergence signal** - `src/services/handlers/loop-handler.ts:1211-1268`
**Confidence**: 82%
- Problem: The git convergence signal path nests: `if (isGitLoop)` > `if (iterationsWithGitTracking.length >= ...)` > `if (changedLines.every(...))` > construct reason + log + complete. This is 4 levels of nesting inside a method that also has a second convergence signal (score plateau) with 3 levels of nesting. The function is 57 lines total (acceptable length) but the nesting depth makes the two signals harder to verify independently.
- Fix: Extract each convergence signal into its own private method to flatten nesting:
```typescript
private async checkGitDiffConvergence(loop: Loop, recent: LoopIteration[]): Promise<boolean> {
  if (!loop.gitBranch && !loop.gitStartCommitSha) return false;
  const tracked = recent.filter(it => it.preIterationCommitSha != null);
  if (tracked.length < CONVERGENCE_MIN_ITERATIONS) return false;
  const changedLines = tracked.map(it => parseGitDiffChangedLines(it.gitDiffSummary));
  if (!changedLines.every(lines => lines < CONVERGENCE_MAX_CHANGED_LINES)) return false;
  // ... log and complete
  return true;
}
```

**Binary search truncation recomputes `Buffer.byteLength` on each probe with `slice` + `join`** - `src/services/handlers/loop-handler.ts:1701-1718`
**Confidence**: 80%
- Problem: The binary search loop calls `Buffer.byteLength(lines.slice(0, mid).join('\n'))` on each iteration. While the loop is bounded at O(log n) iterations, each probe allocates a new array via `slice`, joins it into a string, and computes byte length. For the expected input size (~15 git log lines + diff stat, well under 4KB), this is not a performance issue. However, the algorithmic claim in the commit message ("O(n log n) instead of O(n^2)") is misleading -- each `join` is O(n) in array length, making this O(n log n), same as claimed, but with a higher constant factor than a prefix-sum approach. This is a readability/maintainability concern: the code is more complex than a simple prefix-sum solution that would achieve O(n) with a single pass.
- Fix: A prefix-sum approach is simpler and faster:
```typescript
const lines = gitContext.split('\n');
const lineBytes = lines.map(l => Buffer.byteLength(l));
let total = 0;
let keepLines = 0;
for (let i = 0; i < lineBytes.length; i++) {
  const next = total + lineBytes[i] + (i > 0 ? 1 : 0); // +1 for \n separator
  if (next > MAX_GIT_CONTEXT_BYTES) break;
  total = next;
  keepLines = i + 1;
}
gitContext = lines.slice(0, keepLines).join('\n');
```
This is O(n) in a single pass, allocates less, and is arguably easier to read.

## Issues in Code You Touched (Should Fix)

### MEDIUM

**`loop-handler.ts` file length at 2056 lines with 30+ methods** - `src/services/handlers/loop-handler.ts`
**Confidence**: 85%
- Problem: The file was already large (pre-existing) and this PR adds ~161 lines via `parseGitDiffChangedLines`, `enrichPromptWithGitContext`, and `checkConvergence`. The file now has 2056 lines and the `LoopHandler` class has 30+ private/static methods. This exceeds the 500-line file warning threshold significantly. The class handles: event subscription, loop lifecycle (create/cancel/pause/resume), iteration engine (start/schedule), result handling (retry/optimize), git operations, prompt enrichment, convergence detection, pipeline management, recovery, and in-memory map management. While each method is individually well-decomposed, the cognitive load of reasoning about the entire class is high.
- Fix: The convergence detection and git context enrichment added in this PR are natural extraction candidates into a `LoopConvergenceDetector` collaborator or a standalone module (`loop-convergence.ts`). This would house `parseGitDiffChangedLines`, `checkConvergence`, `checkGitDiffConvergence`, `checkScorePlateau`, and the convergence constants. Similarly, `enrichPromptWithGitContext` could live alongside `enrichPromptWithCheckpoint` in a `loop-prompt-enrichment.ts` module. This is not blocking since the current structure follows existing patterns, but it should be tracked.

**`createOrchestration` inline `evalPrompt` template literal** - `src/services/orchestration-manager.ts:237-247`
**Confidence**: 80%
- Problem: The 11-line eval prompt template is embedded inline in the `createOrchestration` method. This mixes prompt engineering content with orchestration lifecycle logic, making both harder to read independently. If the eval prompt needs tuning, a developer must navigate the orchestration creation flow to find it.
- Fix: Extract to a named function or constant near the prompt builders in `orchestrator-prompt.ts`:
```typescript
export function buildGoalEvalPrompt(goal: string): string {
  return `You are evaluating whether an orchestration goal has been achieved.\n\nGoal: "${goal}"\n\n...`;
}
```

## Pre-existing Issues (Not Blocking)

(None at CRITICAL severity in changed files.)

## Suggestions (Lower Confidence)

- **`buildOrchestratorPrompt` operationalContract stateFile block inconsistency** - `src/services/orchestrator-prompt.ts:308-314` (Confidence: 70%) -- The `stateFileContractBlock` ternary appends a trailing blank line when `stateFilePath` is set (`\n\n`) but concatenates directly with `workingDirectorySection` when not set. The resulting whitespace differs between modes. Minor cosmetic inconsistency.

- **`enrichPromptWithCheckpoint` feedback loop uses O(n) byte accumulation pattern while `enrichPromptWithGitContext` uses binary search** - `src/services/handlers/loop-handler.ts:1658-1669` vs `1701-1718` (Confidence: 65%) -- Two adjacent methods that both cap byte-sized output use different truncation strategies. The feedback loop uses a simple accumulate-and-break pattern (O(n), single pass), while git context uses binary search. The inconsistency is not a bug, but a developer seeing both patterns may wonder which is canonical.

## Summary
| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 1 | 2 | 0 |
| Should Fix | 0 | 0 | 2 | 0 |
| Pre-existing | 0 | 0 | 0 | 0 |

**Complexity Score**: 7/10
**Recommendation**: APPROVED_WITH_CONDITIONS

The new code is well-structured at the individual function level: `parseGitDiffChangedLines` is a clean pure function, the convergence detection has clear named constants, and the binary search loop is explicitly bounded (avoids PF-001 -- all issues surfaced here, none deferred). The main complexity concerns are (1) the triple-ternary branching in `buildOrchestratorPrompt` which should be consolidated into a single decision point, and (2) the continued growth of `loop-handler.ts` which is approaching the point where extraction into collaborator modules would meaningfully improve navigability. No critical issues; all findings are improvement-grade.
