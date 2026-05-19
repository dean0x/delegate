# Complexity Review Report

**Branch**: `feat/dashboard-redesign-v1.3.0` → `main`
**Date**: 2026-04-11 22:00
**Focus**: complexity
**Diff command**: `git diff main...HEAD`
**Files inspected**: dashboard hooks (`use-keyboard.ts`, `use-dashboard-data.ts`, `use-task-output-stream.ts`), helpers (`activity-feed.ts`, `layout.ts`, `types.ts`, `workspace-types.ts`), `services/orchestration-manager.ts`, `services/usage-parser.ts`, dashboard test files.

---

## Issues in Your Changes (BLOCKING)

### CRITICAL

**`handleMainKeys` is a 381-line dispatcher with cyclomatic complexity ≈30 and 5-level nesting** — `src/cli/dashboard/use-keyboard.ts:624-1005`
**Confidence**: 96%

- Problem: A single function handles every key in the main view: Tab/Shift-Tab cycling, panel jumps 1–4, activity-mode arrows, activity-mode Enter (with a 4-way switch on `entityType`), activity-mode `c` (4-way switch + async IIFE), activity-mode `d` (4-way switch + terminal-status guard), panel arrows, panel Enter (4-way switch on `panel`), panel `c` (4-arm `if/else if` chain over panel + status guard), panel `d` (4-arm switch + terminal guard), and `f` filter cycling. The function is 381 lines long, contains at least 30 distinct decision points, and the deepest path (`if (input === 'd') → if (data) → void async → switch → case → if (TERMINAL...) → await`) reaches 6 levels of nesting. Per the complexity skill thresholds (`> 200 lines`, `complexity > 20`, `nesting > 6`), this clears the **CRITICAL** bar on every metric except nesting (which lands at the warning ceiling).
- Impact: 
  1. Every new key, panel, or entity type forces another arm to be added to **four different switch statements** that are silently coupled (Enter, c, d in panel mode plus c/d in activity mode all enumerate the same four entity kinds). Adding a 5th panel — already foreseeable from the 5-tile metrics work — is a 5-touch refactor with 5 chances to forget a case. The compiler will catch the `switch` arms but not the chained `if/else if` in the panel-mode `c` handler (lines 909-929), which has no exhaustiveness guarantee.
  2. The 1331-line `use-keyboard.test.tsx` file across 15 `describe` blocks is a downstream symptom: a single behavior (cancel) needs separate test groups for `c: cancel keybinding`, `activity-row cancel/delete (D2)`, plus the workspace `c` group in `workspace-keyboard.test.tsx`. The tests are testing the *dispatcher* rather than the *cancel domain logic*.
  3. The activity-focused Enter switch (lines 703-726) and the panel-focused Enter switch (lines 869-887) are near-duplicate 4-arm `setView({ kind: 'detail', ... })` blocks that differ only in the source of `entityId`. Same for the cancel and delete blocks.
- Fix: Decompose along **two orthogonal axes** that already exist in the code:
  ```ts
  // 1. Extract a per-entity dispatch table that owns the type-safe id cast
  //    AND the cancel/delete/openDetail logic for one entity kind.
  interface EntityOps<E extends { id: string; status: string }> {
    readonly openDetail: (id: E['id'], returnTo: DetailReturnTarget) => ViewState;
    readonly cancel: (m: DashboardMutationContext, id: E['id'], reason: string) => Promise<void>;
    readonly delete: (m: DashboardMutationContext, id: E['id']) => Promise<void>;
    readonly terminalStatuses: readonly string[];
  }
  const ENTITY_OPS: Record<PanelId, EntityOps<...>> = { loops: ..., tasks: ..., schedules: ..., orchestrations: ... };

  // 2. Extract three per-mode handlers
  function handlePanelGridKeys(input, key, params): boolean { ... }      // Tab/jump/arrow/enter/f
  function handleActivityFocusKeys(input, key, params): boolean { ... }  // arrows/enter/c/d in activity
  function handleEntityActionKeys(input, key, params, ops): boolean {... }// shared c/d via ENTITY_OPS

  function handleMainKeys(input, key, params): boolean {
    if (handleGlobalEsc(input, key, params)) return true;
    if (handleFocusCycle(input, key, params)) return true;
    if (params.nav.activityFocused) return handleActivityFocusKeys(input, key, params);
    return handlePanelGridKeys(input, key, params);
  }
  ```
  Each per-mode helper drops to ≤80 lines. The `ENTITY_OPS` table makes a 5th panel a single-line registration. Tests can target each helper directly without driving stdin through Ink's render loop.

**`handleWorkspaceKeys` is a 274-line, 12-branch dispatcher** — `src/cli/dashboard/use-keyboard.ts:319-593`
**Confidence**: 94%

- Problem: 274 lines, 12 top-level `if` branches gating on key, plus an internal `nav vs grid` focus split inside several of them. The `[`, `]`, `g`, `G` blocks (lines 446-522) are **four near-identical copies** of the same shape: `data → children → child → setWorkspaceNav` with 4 levels of nesting and a per-block `if (children && children.length > 0)` guard. The `c` handler (lines 542-572) duplicates the cancel-task pattern from `handleMainKeys` with different state plumbing. Cyclomatic complexity ≈18.
- Impact: A panel-focused operation cannot be unit-tested without mounting the wrapper component used in `tests/unit/cli/dashboard/workspace-keyboard.test.tsx` (555 lines, 8 describe blocks). The four scroll/jump operations should be one parameterized helper; instead each operation re-implements the "find focused child by panel index" lookup, which is itself a candidate for extraction.
- Fix:
  ```ts
  function withFocusedChild<R>(
    workspaceNav: WorkspaceNavState,
    data: DashboardData | null,
    fn: (child: OrchestratorChild, taskId: TaskId) => R | undefined,
  ): R | undefined {
    const children = data?.workspaceData?.children;
    if (!children || children.length === 0) return undefined;
    const child = children[workspaceNav.focusedPanelIndex];
    if (!child) return undefined;
    return fn(child, child.taskId);
  }

  function applyScroll(prev, taskId, delta, autoTail): WorkspaceNavState { ... }

  // [, ], g, G all become 3-line bodies
  if (input === '[') return withFocusedChild(workspaceNav, data, (_, id) =>
    setWorkspaceNav((p) => applyScroll(p, id, -1, false))) ?? true;
  ```
  Decompose `handleWorkspaceKeys` into `handleWorkspaceFocusCycle`, `handleWorkspaceNavCursor`, `handleWorkspaceGridScroll`, `handleWorkspaceMutation`. Each ≤60 lines.

### HIGH

**`createOrchestration` is a 238-line method with embedded helpers, three failure-compensation branches, and inline IIFE-style cleanup** — `src/services/orchestration-manager.ts:80-318`
**Confidence**: 93%

- Problem: The method does input validation (lines 91-118), agent resolution (120-123), state-file setup with 5-line nested try/catch (129-152), inline `isWithinStateDir` and `cleanupFiles` helper closures (156-171), domain object construction (177), DB save (180-187), inline `compensate` async closure with its own logger calls and conditional cancel (196-223), prompt build (229-237), loop creation (239-259), conditional update with TOCTOU race handling and another error branch (269-296), event emission (299-306), and final logging (308-315). That is 11 sequentially branching responsibilities in one method, with an effective cyclomatic complexity of ~16 (each `if (!result.ok)`, the inner try/catch, and the conditional `if (loopIdToCancel)` and `if (!updateResult.value)`). At 238 lines, it sails past the CRITICAL function-length bar but I'm rating HIGH because the individual branches are each shallow and well-commented — the issue is *aggregation*, not unreadable control flow.
- Impact:
  1. The two inline closures (`cleanupFiles`, `compensate`) capture `stateFilePath`, `exitConditionScript`, `orchestration`, and `this`. When you read the method linearly the closures execute in three different places (lines 185, 222, 257, 280, 290), and the only way to know what files exist at each compensation point is to scroll back. This is exactly the "if you need a diagram to understand control flow, refactor" antipattern from the complexity skill.
  2. The unit test file `tests/unit/services/orchestration-manager.test.ts` is 108 lines (modest), but it can only test happy-path + a couple of failure paths because every compensation branch needs the same 6-layer mock setup.
- Fix: Extract a `OrchestrationCreator` collaborator or factor into private methods that own each phase:
  ```ts
  async createOrchestration(request): Promise<Result<Orchestration>> {
    const validated = validateRequest(request, this.config); // Result
    if (!validated.ok) return validated;

    const stateFiles = await this.setupStateFiles(validated.value.goal); // Result; owns try/catch
    if (!stateFiles.ok) return stateFiles;

    const orch = createOrchestration(validated.value, stateFiles.value.path, validated.value.workingDirectory);
    const saveResult = await this.orchestrationRepo.save(orch);
    if (!saveResult.ok) {
      stateFiles.value.cleanup();
      return err(saveResult.error);
    }

    return this.attachLoopToOrchestration(orch, stateFiles.value); // owns compensate logic
  }

  private async attachLoopToOrchestration(orch, stateFiles): Promise<Result<Orchestration>> { ... }
  ```
  Each helper ≤60 lines, single responsibility, individually testable.

**`use-keyboard.ts` is 1091 lines — a single dashboard hook owns all key routing for 3 view modes, 4 entity types, and an activity feed** — `src/cli/dashboard/use-keyboard.ts:1-1091`
**Confidence**: 91%

- Problem: File size **3.6× the warning threshold and 2.2× the critical threshold** for files in the complexity skill (`> 500` is critical). The file already documents its three handler functions in the top-level comment, suggesting the author saw the split but kept everything in one module. There is no exported sub-module per view; all three handlers, all helpers (`toIdentifiables`, `getPanelItems`, `filteredLength`, `clamp`, `resolveChildIndex`, `activityKindToEntityType`), and the constants tables (`PANEL_ORDER`, `FILTER_CYCLES`, `PANEL_JUMP_KEYS`, `TERMINAL_STATUSES`) live together.
- Impact: The matching test file is 1331 lines, and `workspace-keyboard.test.tsx` exists as a *separate* file containing 555 more lines of tests for the same hook — strong evidence that the team is already informally sharding the test surface because the SUT is too large. New developers cannot grok the keyboard contract without scrolling.
- Fix: Move each `handleXxxKeys` to its own file and re-export from `use-keyboard.ts`:
  ```
  src/cli/dashboard/keyboard/
    constants.ts          // PANEL_ORDER, FILTER_CYCLES, PANEL_JUMP_KEYS, TERMINAL_STATUSES
    helpers.ts            // toIdentifiables, getPanelItems, filteredLength, clamp, resolveChildIndex
    handle-detail.ts      // handleDetailKeys
    handle-workspace.ts   // handleWorkspaceKeys
    handle-main.ts        // handleMainKeys
    use-keyboard.ts       // useKeyboard hook only — wires the three handlers
  ```
  This is a mechanical refactor that immediately allows each handler to be tested without an Ink render harness — the per-handler helpers are already pure functions taking `KeyHandlerParams`.

**Triple duplication of the entity-action switch (`Enter` / `c` / `d`)** — `src/cli/dashboard/use-keyboard.ts:703-726, 743-762, 778-803, 869-887, 909-929, 948-973`
**Confidence**: 95%

- Problem: Six near-identical switch/case constructs over the four entity kinds (`tasks`, `loops`, `schedules`, `orchestrations`), each performing the same shape of work (cast id, call service or repo, refresh):
  - **Activity-mode Enter** (lines 703-726): 4-arm switch on `entityType` to call `setView`
  - **Activity-mode c** (lines 743-762): 4-arm switch on `entry.kind` to call cancel service
  - **Activity-mode d** (lines 778-803): 4-arm switch on `entry.kind` with terminal guard to call delete repo
  - **Panel-mode Enter** (lines 869-887): 4-arm switch on `panel` to call `setView`
  - **Panel-mode c** (lines 909-929): 4-arm `if/else if` chain on `panel` (NOT a switch — exhaustiveness lost) to call cancel service
  - **Panel-mode d** (lines 948-973): 4-arm switch on `panel` with terminal guard to call delete repo
- Impact: 
  1. Six times the maintenance burden when adding an entity kind. The compiler catches missing `switch` arms when the discriminated union changes, but the **panel-mode `c` `if/else if` chain (lines 909-929)** has no exhaustiveness check — adding a 5th panel will silently leave its `c` cancel a no-op until manual testing finds it.
  2. The terminal-status guard for `d` is hardcoded into each arm (`if (TERMINAL_STATUSES.tasks.includes(...))`) instead of being driven by the existing `TERMINAL_STATUSES` table indexed by panel.
- Fix: Build the entity-ops table proposed in the `handleMainKeys` finding above. Then:
  ```ts
  function dispatchCancel(panel: PanelId, item: Identifiable, mutations, refreshNow): void {
    if (TERMINAL_STATUSES[panel].includes(item.status as never)) return;
    void (async () => {
      await ENTITY_OPS[panel].cancel(mutations, item.id as never, REASON_USER_DASHBOARD);
      refreshNow();
    })();
  }
  function dispatchDelete(panel, item, mutations, refreshNow) { ... }
  ```
  All six call sites collapse to two helper invocations, and the panel-mode `c` chain becomes exhaustively typed.

### MEDIUM

**`buildStreamState` mixes byte/char accounting with three early-return branches and a ring-buffer mutation** — `src/cli/dashboard/use-task-output-stream.ts:101-177`
**Confidence**: 86%

- Problem: 76 lines, cyclomatic complexity ≈8. Three "no-op" early returns (`output === null`, `newTotalBytes <= prev.totalBytes && prev.lines.length > 0`, `newLines.length === 0`), one "no new bytes inside the delta calculation" early return (lines 137-144), and an in-place `combined.splice(0, excess)` mutation on a freshly-built array (line 166). The byte/char arithmetic on lines 129-134 (`Buffer.byteLength` then `buf.slice(prev.totalBytes).toString('utf-8')`) is correct but takes ~3 minutes to verify because it's interleaved with the early-return ladder.
- Impact: Each early return is a pre-warm exit before the actual business logic runs, but they're scattered through the function instead of grouped at the top — a reader has to track three separate "if everything is unchanged, return shallow update of prev" branches that all do slightly different things (one updates `taskStatus`, one also updates `lastFetchedAt`, one also updates `totalBytes`). The pure helper `buildStreamState` is exported for testing — the test file is 246 lines for this one function, which is a fair indicator of the branch combinatorics.
- Fix:
  ```ts
  export function buildStreamState(prev, output, nextStatus): OutputStreamState {
    if (output === null) return { ...prev, taskStatus: nextStatus };

    const newContent = computeNewContent(prev, output);  // pure helper
    if (newContent === null) return { ...prev, taskStatus: nextStatus, lastFetchedAt: new Date() };

    const newLines = mergeOutputLines(stripAnsi(newContent));
    return appendLinesToBuffer(prev, newLines, output.totalSize, nextStatus); // pure helper
  }
  ```
  Each helper ≤20 lines, no early returns inside the main function, and the byte/char conversion lives in `computeNewContent` where its precondition (`prev.totalBytes < Buffer.byteLength(...)`) reads as a single check.

**`useTaskOutputStream`'s `doPoll` callback has 4 levels of nesting and an inner async closure inside a loop** — `src/cli/dashboard/use-task-output-stream.ts:273-343`
**Confidence**: 84%

- Problem: 70 lines, function declaration nesting reaches 4 (`async () => try { for (taskId of taskIds) { const fetchTask = async () => { try { ... } catch { ... } }; fetches.push(fetchTask()); } }`). The inner `fetchTask` closure contains its own `try/catch` and three sequential decisions (`closingRef.current` check, `result.ok` branch, terminal-status flag set), each of which mutates the same `streamsRef.current` map.
- Impact: Two write paths to the same Map (success at line 314, error at line 307 and again at 326) make it hard to verify the error-overwrites-stale-state semantics. The 246-line test file for this hook tests `buildStreamState` extensively but cannot easily test the loop behavior because the mutable Map is exposed only as a read-only view.
- Fix: Extract the inner closure to a top-level pure-ish helper:
  ```ts
  async function pollSingleTask(
    taskId: TaskId,
    outputRepo: OutputRepository,
    streamsRef: MutableRefObject<Map<TaskId, OutputStreamState>>,
    rawStatus: string,
    closingRef: MutableRefObject<boolean>,
  ): Promise<void> { ... }
  ```
  Then `doPoll` becomes a thin orchestrator: filter eligible task ids, map to `pollSingleTask` promises, `await Promise.all`, bump version. Drops the function to ≤30 lines and 2 nesting levels.

**`fetchAllData` has eight sequential `unwrapOrErr` boilerplate blocks** — `src/cli/dashboard/use-dashboard-data.ts:117-133`
**Confidence**: 82%

- Problem: 17 lines of `if (!x.ok) return err(x.error)` repetition for the eight parallel results. Each pair is identical except for the variable name and label string. The pattern is well-justified (labelled errors) but the call site is screaming for a helper.
- Impact: Adding a new fetched repository requires three places to update (`Promise.all` arg, `unwrapOrErr` line, the destructure for the return). It's working code, but the noise hides the actual data-flow shape.
- Fix:
  ```ts
  function unwrapAll(...labeled: ReadonlyArray<[string, Result<unknown, Error>]>): Result<unknown[], string> {
    const values: unknown[] = [];
    for (const [label, result] of labeled) {
      if (!result.ok) return err(`${label} fetch failed: ${result.error.message}`);
      values.push(result.value);
    }
    return ok(values);
  }
  // OR (better, type-preserving):
  const merged = mergeResults({
    tasks: tasksResult, loops: loopsResult, schedules: schedulesResult, orchestrations: orchestrationsResult,
    taskCounts: taskCountsResult, ...
  });
  if (!merged.ok) return err(merged.error);
  const { tasks, loops, schedules, ... } = merged.value;
  ```
  Drops 17 lines to 5 and removes the per-add boilerplate.

---

## Issues in Code You Touched (Should Fix)

### MEDIUM

**`handleDetailKeys` early-return ladder — orchestration sub-handler should be its own function** — `src/cli/dashboard/use-keyboard.ts:173-300`
**Confidence**: 88%

- Problem: 127 lines doing two unrelated things: (1) Esc/Backspace return-to logic with a 3-arm `returnTo` discriminator (lines 181-198) and (2) orchestration-detail-specific child navigation: 5 sub-blocks for ↑/↓, Enter, PgUp, PgDn (lines 201-271), then (3) generic scroll for non-orchestration detail (lines 274-299). The orchestration block alone is 70 lines and has 5 levels of nesting (`if entityType === orchestrations → if key.upArrow → setNav((prev) → resolveChildIndex → return`).
- Fix: Extract `handleOrchestrationDetailKeys(input, key, params)` and `handleEntityScrollKeys(input, key, params)`. The dispatcher becomes:
  ```ts
  function handleDetailKeys(input, key, params): boolean {
    if (params.view.kind !== 'detail') return false;
    if (handleDetailReturnTo(input, key, params)) return true;
    if (params.view.entityType === 'orchestrations') return handleOrchestrationDetailKeys(input, key, params);
    return handleEntityScrollKeys(input, key, params);
  }
  ```

**`use-dashboard-data.ts` `fetchAllData` does work for 4 view modes via post-hoc spreads instead of dispatch** — `src/cli/dashboard/use-dashboard-data.ts:89-190`
**Confidence**: 81%

- Problem: After the parallel base fetch, the function does conditional fetching for `viewState.kind === 'detail'`, conditional metrics fetching for `viewState.kind === 'main'`, conditional workspace fetching for `viewState.kind === 'workspace'`, then spreads them all into the return. The control flow does not match the data flow: the function returns the same `DashboardData` shape regardless of view, but the contents that are populated depend on the view in a way that is not type-checked.
- Fix: Make `DashboardData` a discriminated union per view, or extract per-view fetchers to a `Record<ViewState['kind'], (ctx, viewState) => Promise<...>>`. Either way, the conditional spreads disappear and the type system tracks "metricsExtras only present in main view".

---

## Pre-existing Issues (Not Blocking)

None observed in this review — `activity-feed.ts`, `layout.ts`, `usage-parser.ts`, `workspace-types.ts`, and `types.ts` are all within complexity guidelines:

- `activity-feed.ts` (135 lines): The `buildActivityFeed` function is 50 lines but is a flat for-loop merge — well within bounds. The 4 verb-mapping helpers are 1-line lookups and could be inlined or table-driven, but that's stylistic.
- `layout.ts` (175 lines): `computeMetricsLayout` (32 lines) and `computeWorkspaceLayout` (66 lines) are pure, branch on degraded modes early, and use `clamp` consistently. The `gridCols` ladder (lines 139-148) is the only spot that could be a constant table, but at 4 entries it's not worth abstracting. **Exemplary complexity hygiene** — the rest of the dashboard should look like this.
- `usage-parser.ts` (143 lines): `extractUsage` is 80 lines but is a linear validation funnel with early returns — cyclomatic complexity ≈10, no nesting deeper than 2. Acceptable for a parser at the system boundary.
- `workspace-types.ts` (43 lines): trivial.

---

## Suggestions (Lower Confidence)

- **`OrchestrationManagerService` constructor takes 7 deps (5 required + 2 optional)** — `src/services/orchestration-manager.ts:69` (Confidence: 72%) — borderline parameter overcount. The optional `taskRepository`/`taskManager` pair is suspicious: either both are needed (cancel cascade) or neither is. Consider a single optional `cascadeOps?: { taskRepository, taskManager }` so callers can't pass one without the other.
- **`UseKeyboardParams` has 11 fields** — `src/cli/dashboard/use-keyboard.ts:57-83` (Confidence: 70%) — at 11 readonly props with two pairs that travel together (`workspaceNav`/`setWorkspaceNav`, `view`/`setView`, `nav`/`setNav`), the parameter object is approaching "missing abstraction" territory. After the per-view file split suggested above, each per-view handler should accept only the slice of state it needs, which would naturally collapse this.
- **`use-task-output-stream.ts:245` joins `taskIds.join(',')` to use as effect dep key** — Confidence: 65% — This is a known React pattern but worth a small comment that the order-sensitivity is intentional.

---

## Summary

| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 2 | 4 | 3 | - |
| Should Fix | - | - | 2 | - |
| Pre-existing | - | - | - | 0 |

**Complexity Score**: 5/10

**Recommendation**: **CHANGES_REQUESTED**

The branch ships meaningful features and uses good patterns where the code is **new and small** (`layout.ts`, `activity-feed.ts`, `usage-parser.ts`, `workspace-types.ts` are exemplary). But the keyboard hook (`use-keyboard.ts`) is the highest-complexity file in the dashboard subtree by a wide margin and is already showing scaling pain: 1091 lines of source against 1886 lines of dedicated tests, with six duplicated entity dispatch tables and a 381-line dispatcher function. The same pattern is starting in `orchestration-manager.ts:createOrchestration` (238 lines). These are not bugs — the code works and is well-commented — but they represent compounding maintenance debt that will make every subsequent dashboard iteration (orchestration redesign, task panels, future entity types) progressively harder.

The two CRITICAL items are mechanical refactors that can be done in this PR without behavior change: (1) split `use-keyboard.ts` into a `keyboard/` directory with one file per view, (2) extract the entity-ops table to collapse the six duplicated dispatch switches. Together they would drop the per-handler size below 100 lines and let new entity types be added in one place. The HIGH `createOrchestration` finding is independent and can ship in this PR or as a follow-up.
