# TypeScript Review Report

**Branch**: feat/dashboard-redesign-v1.3.0 -> main
**Date**: 2026-04-11 22:00
**Focus**: TypeScript type safety, parse-don't-validate, branded types, discriminated unions

## Summary at a Glance

The v1.3.0 dashboard redesign introduces ~7,000 lines of new TypeScript across the dashboard, repositories, and event handlers. Type safety is generally strong — **no `any` types appear in any new code**, the new view-state and pagination types correctly use discriminated unions and branded IDs, and almost every fallible operation returns `Result<T,E>`. The two notable exceptions are:

1. **The new SQLite paths in `orchestration-repository.ts` and the entire `usage-repository.ts` skip Zod parsing**, casting raw rows directly with `as TaskStatus` / `as TaskId`. This is inconsistent with the Zod-validated `findById` paths in the same files and contradicts the project convention "Parse, don't validate — use Zod schemas at boundaries". A corrupt or migrated row reaches the UI as a malformed `OrchestratorChild`.
2. **`ActivityEntry` is a flat interface with `entityId: string` and `kind: 'task'|'loop'|'orchestration'|'schedule'`**, not a discriminated union with branded IDs. This forces ~12 `as TaskId` / `as LoopId` / `as never` casts at every consumer site. The casts compile but defeat the branded-type guard for `ActivityEntry → openDetail` flows.

Other type safety is solid. The new `ViewState` discriminated union is well-modeled, `DetailReturnTarget` correctly uses object discriminants for D3 drill-through, and `use-keyboard.ts` (771 lines) contains zero `any` and zero `as any`.

---

## Issues in Your Changes (BLOCKING)

### HIGH

**SQLiteUsageRepository skips Zod validation on every read path** — `src/implementations/usage-repository.ts:88, 132, 184–187, 209, 221–231, 234–245`
**Confidence**: 95%
- Problem: The repository never imports Zod. Every `rowToUsage` and `aggregateRowToUsage` cast does `(row.input_tokens as number) ?? 0`, `row.task_id as TaskId`, `row.captured_at as number`, etc. SQLite columns are typed `Record<string, unknown>`, so each `as` is an unchecked assertion. Sister repositories (`orchestration-repository.ts:33–48`, `loop-repository.ts`, `schedule-repository.ts`, `task-repository.ts`) all use `z.object({...}).parse(row)`. The new `UsageRepository` is the only repo in the codebase that bypasses this.
- Impact: Migration drift, manual DB edits, or `task_usage` rows whose numeric columns are `null`/`""` (legal in SQLite even with `INTEGER NOT NULL` if foreign-write paths exist) will be silently coerced. The dashboard then renders `$NaN` and `Infinity tokens`. The `as TaskId` cast on `row.task_id` cannot fail, but on the aggregate methods `taskId: TaskId('')` is silently substituted — a magic empty-string ID that flows into `topOrchestrationsByCost` callers.
- Fix:
  ```typescript
  import { z } from 'zod';

  const UsageRowSchema = z.object({
    task_id: z.string(),
    input_tokens: z.number().int().nonnegative(),
    output_tokens: z.number().int().nonnegative(),
    cache_creation_input_tokens: z.number().int().nonnegative(),
    cache_read_input_tokens: z.number().int().nonnegative(),
    total_cost_usd: z.number().nonnegative(),
    model: z.string().nullable().optional(),
    captured_at: z.number().int(),
  });

  private rowToUsage(row: unknown): TaskUsage {
    const data = UsageRowSchema.parse(row);
    return {
      taskId: TaskId(data.task_id),
      inputTokens: data.input_tokens,
      // ...
    };
  }
  ```
  Apply the same to `aggregateRowToUsage` and the row inside `topOrchestrationsByCost`.

**Orchestration paginated read paths skip Zod validation** — `src/implementations/orchestration-repository.ts:456–476, 502–509, 514–522`
**Confidence**: 90%
- Problem: `getOrchestratorChildren`, `countOrchestratorChildren`, and `findUpdatedSince` all use raw `as Array<{...}>` row casts plus per-field `as TaskId` / `as 'direct' | 'iteration'` / `as TaskStatus` / `as OrchestratorChild['agent']`. Compare with the existing `findById` path on the same class (lines 209–214) which routes through `OrchestrationRowSchema.parse(row)`. The new methods are the only ones in this class that bypass Zod.
- Impact: A `tasks.status` of `'pending'` (legal CHECK constraint state at one point) flows into `OrchestratorChild.status: TaskStatus` despite not being a `TaskStatus` enum value, then gets compared to `TERMINAL_STATUSES.tasks` in `use-keyboard.ts:563, 581` via `as TaskStatus` and produces wrong cancel/delete gating. The `kind as 'direct' | 'iteration'` cast can never fail today (only emitted by the SQL UNION), but is fragile if the SQL is edited.
- Fix:
  ```typescript
  const ChildRowSchema = z.object({
    kind: z.enum(['direct', 'iteration']),
    task_id: z.string(),
    iteration_id: z.number().int().nullable(),
    status: z.enum(['queued', 'running', 'completed', 'failed', 'cancelled']),
    created_at: z.number(),
    updated_at: z.number(),
    prompt: z.string(),
    agent: z.enum(AGENT_PROVIDERS_TUPLE).nullable(),
  });

  const rows = stmt.all({orchId: orchestrationId, limit, offset});
  return rows.map((raw) => {
    const row = ChildRowSchema.parse(raw);
    return {
      taskId: TaskId(row.task_id),
      kind: row.kind,
      // ...
    };
  });
  ```

### MEDIUM

**`ActivityEntry` is not a discriminated union — forces 12+ `as` casts at consumers** — `src/core/domain.ts:827–833`
**Confidence**: 85%
- Problem: The interface declares `entityId: string` plus `kind: 'task' | 'loop' | 'orchestration' | 'schedule'` as parallel fields, instead of being modelled as a discriminated union. As a result, every consumer that opens a detail view from an activity row must manually re-brand the ID. There are 12 such casts in the diff:
  - `src/cli/dashboard/use-keyboard.ts:705, 708, 714, 722, 745, 751, 755, 759, 781, 787, 793, 799` — `entry.entityId as TaskId | LoopId | OrchestratorId | ScheduleId`
  - `src/cli/dashboard/app.tsx:131, 134, 137, 140` — `entry.entityId as never` (worse — `never` means "trust me, it's fine")
- Impact: The branded-type guarantee that motivates `TaskId`/`LoopId`/`OrchestratorId` is gone for the entire activity-feed flow. Any future bug that swaps `kind` and `entityId` (e.g. an off-by-one in `buildActivityFeed`) won't be caught at compile time. The `as never` casts in `app.tsx` are particularly worrying — `never` is the bottom type and TypeScript will accept *any* operation on a `never`-typed value without complaint.
- Fix: Convert `ActivityEntry` to a discriminated union of branded variants:
  ```typescript
  export type ActivityEntry =
    | { kind: 'task';          entityId: TaskId;         status: string; action: string; timestamp: Date }
    | { kind: 'loop';          entityId: LoopId;         status: string; action: string; timestamp: Date }
    | { kind: 'orchestration'; entityId: OrchestratorId; status: string; action: string; timestamp: Date }
    | { kind: 'schedule';      entityId: ScheduleId;     status: string; action: string; timestamp: Date };
  ```
  Then `buildActivityFeed` constructs each variant with `TaskId(task.id)` etc., and consumers narrow with `switch (entry.kind)` and use `entry.entityId` directly with no cast. Also enables a `never` exhaustiveness check at the bottom of `activityKindToEntityType` and the cancel/delete switches.

**`MetricsView.ZERO_USAGE` uses `'' as never` to satisfy `TaskId`** — `src/cli/dashboard/views/metrics-view.tsx:25–33`
**Confidence**: 95%
- Problem: The placeholder `ZERO_USAGE.taskId` is declared as `'' as never`. `as never` is the strongest possible escape hatch in TypeScript — it tells the compiler "this expression has no possible value". The placeholder is the only `as never` cast in any new view file (other than `app.tsx`'s activity dispatchers).
- Impact: Future refactors that change `TaskUsage.taskId` to a non-string brand (e.g. nominal record) will not flag this site. Identical `ZERO_USAGE` placeholders elsewhere (`use-dashboard-data.ts:286–294`) correctly use `TaskId('')` — the inconsistency suggests this was a quick fix.
- Fix:
  ```typescript
  import { TaskId } from '../../../core/domain.js';

  const ZERO_USAGE: TaskUsage = {
    taskId: TaskId(''),
    inputTokens: 0,
    // ...
  };
  ```
  Same fix applies to `app.tsx:131–140`: replace `entry.entityId as never` with the proper branding helper based on `entry.kind`. Better yet, fix at the source by making `ActivityEntry` a discriminated union (see previous finding).

**`OrchestrationDetailProps.children` shadows React's intrinsic `children` prop** — `src/cli/dashboard/views/orchestration-detail.tsx:27–40`
**Confidence**: 80%
- Problem: `interface OrchestrationDetailProps { ... readonly children?: readonly OrchestratorChild[] ... }` overrides the implicit `children?: ReactNode` that `React.FC` adds. This compiles because `OrchestratorChild[]` is the explicit declaration, but it confuses readers (children look like JSX children) and breaks the conventional pattern. Renaming would make the array nature explicit.
- Impact: Subtle source of confusion. Tests passing JSX children to `<OrchestrationDetail>...</OrchestrationDetail>` would silently get a type error because `ReactNode` is no longer assignable. Also makes the prop self-documenting — `childTasks` is what they actually are.
- Fix: Rename the prop to `childTasks` (or `attributedTasks`) at the interface, the destructure, and all 7 consumers in `detail-view.tsx:74–84` and `orchestration-detail.test.tsx`.

---

## Issues in Code You Touched (Should Fix)

### MEDIUM

**Non-exhaustive `if/else` on `MetricsLayout.mode` and `WorkspaceLayout.mode` — no `never` exhaustiveness** — `src/cli/dashboard/views/metrics-view.tsx:80–97`, `src/cli/dashboard/views/workspace-view.tsx:144–192`, `src/cli/dashboard/components/footer.tsx:22–30`
**Confidence**: 85%
- Problem: The mode field is a string literal union (`'full' | 'narrow' | 'too-small'` for `MetricsLayout`, `'nav+grid' | 'grid-only' | 'too-small'` for `WorkspaceLayout`), but consumers branch with `if (mode === 'too-small') { return ... } if (mode === 'narrow') { return ... } /* fall through to full */` without an exhaustive check. TS won't error if a future fourth mode is added — the new mode silently falls through to the "full" branch. The TypeScript convention in this project (and the skill checklist) is `default: const _: never = mode`.
- Fix: Convert to a `switch` and add the exhaustiveness check:
  ```typescript
  switch (layout.mode) {
    case 'too-small': return <TooSmall/>;
    case 'narrow':    return <Narrow/>;
    case 'full':      return <Full/>;
    default: { const _: never = layout.mode; throw new Error(`Unhandled mode: ${_}`); }
  }
  ```

**`OutputStreamState` mixes orthogonal concerns — flat shape allows illegal state combinations** — `src/cli/dashboard/use-task-output-stream.ts:25–34`
**Confidence**: 70%
- Problem: `error: string | null` and `lines: readonly string[]` and `taskStatus: 'pending'|'queued'|'running'|'terminal'` are all on the same flat record, so any combination is representable. In particular, `{taskStatus: 'terminal', error: 'fetch failed', lines: [...]}` is legal but ambiguous (did the final fetch succeed?). The hook uses this as a cumulative state where the error coexists with the last good buffer, which is fine for display, but a discriminated union would document intent.
- Fix (optional, lower confidence): Either keep the flat shape and rename `error` to `lastError` to clarify it's not a state, or model as `{ status: 'idle' } | { status: 'streaming'; lines, totalBytes, droppedLines } | { status: 'error'; lastError, lines, totalBytes }`. The pure helpers (`buildStreamState`) become much easier to read with discriminated narrowing.

### LOW

**`getThroughputStats` cast on aggregation row** — `src/implementations/task-repository.ts:447–457`
**Confidence**: 80%
- Problem: `taskStatsStmt.get(since) as { total: number; completed: number; avg_duration_ms: number | null }` — same parse-don't-validate pattern violation as the usage repo, just smaller. `SUM(...)` may return string in some SQLite drivers when AVG operates on a column with NULLs.
- Fix: Add a small Zod schema or use `Number(row.total ?? 0)` defensively.

**Logger swap in `bootstrap.ts:184–193` registers a captured Logger instance instead of factory** — `src/bootstrap.ts:181–193`
**Confidence**: 75%
- Problem: The `if (options.logger)` branch captures `providedLogger` from closure and registers a factory `() => providedLogger`. This is type-correct but the singleton container assumes factories are deterministic. The pattern works (returns the same instance every call) but is subtle. A cleaner pattern is `container.registerValue('logger', options.logger)`.
- Fix: Use `container.registerValue` if the container exposes it (the diff shows it's used elsewhere for handlers).

---

## Pre-existing Issues (Not Blocking)

### LOW

**`EventBus.on/once/emit` use `any[]` for variadic compat** — `src/core/events/event-bus.ts:28, 31, 308, 313, 328`, `src/core/events/handlers.ts:48, 54`
**Confidence**: 95%
- Problem: Pre-existing shim methods for legacy EventEmitter compatibility. Marked with `biome-ignore lint/suspicious/noExplicitAny`.
- Note: Out of scope for this PR. Tracked as architectural exception.

---

## Suggestions (Lower Confidence)

- **`use-keyboard.ts:1018–1090` — `useKeyboard` declares 8+ params with overlapping types** - `src/cli/dashboard/use-keyboard.ts:57–83` (Confidence: 65%) — The hook signature is becoming a god-object. Consider grouping `view`/`nav`/`workspaceNav`/`setView`/`setNav`/`setWorkspaceNav` into a single `state` object.
- **`runTask` uses raw `process.env.AUTOBEAT_ORCHESTRATOR_ID` without a Zod boundary parse** - `src/cli/commands/run.ts:184` (Confidence: 70%) — A Zod schema like `z.string().regex(/^orchestrator-/).optional()` matching the MCP-side validation would unify the boundary checks across the two code paths.
- **`ScrollableList` uses `as <T>(...)` cast to keep generic typing through `React.memo`** - `src/cli/dashboard/components/scrollable-list.tsx:85` (Confidence: 60%) — A documented limitation of React+generics. The cast is the standard workaround. No action needed.

---

## Summary Table

| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 2 | 4 | - |
| Should Fix | - | 0 | 2 | 2 |
| Pre-existing | - | - | 0 | 1 |

**TypeScript Score**: 7/10
**Recommendation**: CHANGES_REQUESTED

The PR demonstrates strong type discipline overall — 7,000+ lines of new code with no `any`, well-modeled discriminated unions for view state and pagination, and thorough use of branded IDs. **The two HIGH-severity findings are both about the same pattern** (skipping Zod parsing on new SQLite read paths), and both fix to ~30 lines of additional code. The MEDIUM `ActivityEntry` discriminated-union refactor is the largest cleanup but also the highest-leverage — it eliminates 16 `as` casts at once.

Once the parse-don't-validate findings are addressed and `ActivityEntry` is converted to a proper discriminated union, this is APPROVED material.
