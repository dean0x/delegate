# Plan: Dashboard Redesign — Metrics View + Workspace View + Responsive + Cost Tracking

## Context

Autobeat's current dashboard is a single-view Ink app with a hardcoded 2×2 panel grid (loops/tasks/schedules/orchestrations) and detail drill-downs. It has three problems:

1. **Low visibility** — you can see *that* an orchestrator is running but not *what* it's doing. Individual agent output is invisible; the dashboard renders only DB snapshots.
2. **No high-level overview** — no aggregate metrics (resources, cost, throughput). You learn health only by scanning rows.
3. **Fixed layout** — hardcoded 80×20 minimum, hardcoded viewport heights. Doesn't adapt to terminal size.

**Goal**: Deliver two complementary views, live streaming of agent output, cost/token tracking, responsive layout. This is a significant rebuild of `src/cli/dashboard/` but preserves the underlying data pipeline and most existing components.

### User decisions (captured during planning)

| # | Decision | Choice |
|---|---|---|
| 1 | Main view scope | **Redesign as metrics dashboard** (not preserve) |
| 2 | Cost/token tracking | **Include in this PR** — schema migration + Claude JSON parsing |
| 3 | Orchestrator child discovery | **Track `beat run` sub-tasks** via new `tasks.orchestrator_id` column |
| 4 | Streaming latency | **Lower default flush to 1s globally** |
| 5 | Cancel cascade | **Cascade** — cancelling an orchestrator also cancels its attributed sub-tasks |
| 6 | Browse-all UX | **Detail from Activity panel** — no dedicated browse view |
| 7 | Retry cost attribution | **Sum retries into the root task** via `retry_of` chain |
| 8 | Orchestration detail | **Modernize** — add children list + cost aggregate |

### Scope boundary

- Schema migrations: yes (v11 `tasks.orchestrator_id`; v12 `task_usage`).
- Token capture: **Claude only** in this PR (parses `--output-format json` final result). Codex/Gemini parsing deferred.
- `orchestrator_id` propagation: `AUTOBEAT_ORCHESTRATOR_ID` env var threaded through `beat run`, MCP `DelegateTask` (via METADATA, not env — Risk #8), AND the initial orchestrator task.
- Loop/task/schedule detail views: unchanged (they're already fit for purpose).
- Cancel/delete keybindings and liveness badges from the v1.2.1 fix stay — semantics updated for the new views (see §8).

---

## Architecture decisions

### 1. View model

Extend `ViewState` in `src/cli/dashboard/types.ts:55` with a new `workspace` variant. Existing `main` and `detail` variants keep their discriminator so the detail drill-down mechanism works unchanged.

```ts
export type ViewState =
  | { readonly kind: 'main' }                          // redesigned contents (see §3) — STILL called 'main'
  | { readonly kind: 'workspace'; readonly orchestrationId?: OrchestratorId }  // NEW
  | { readonly kind: 'detail'; readonly entityType: 'loops';          readonly entityId: LoopId;         readonly returnTo: 'main' | 'workspace' }
  | { readonly kind: 'detail'; readonly entityType: 'tasks';          readonly entityId: TaskId;         readonly returnTo: 'main' | 'workspace' }
  | { readonly kind: 'detail'; readonly entityType: 'schedules';      readonly entityId: ScheduleId;     readonly returnTo: 'main' | 'workspace' }
  | { readonly kind: 'detail'; readonly entityType: 'orchestrations'; readonly entityId: OrchestratorId; readonly returnTo: 'main' | 'workspace' };
```

**`returnTo` field is new** — Esc from a detail view should return to the kind it was opened from. Without it, pressing Enter in workspace → orchestration-detail → Esc sends the user back to main instead of workspace. Defaults to `'main'` for callers that don't pass it.

A parallel `WorkspaceNavState` is added (does NOT merge with `NavState` — keeps the main-view reducer independent):

```ts
interface WorkspaceNavState {
  readonly selectedOrchestratorIndex: number;
  readonly focusedPanelIndex: number;
  readonly panelScrollOffsets: Readonly<Record<TaskId, number>>;
  readonly fullscreenPanelIndex: number | null;  // cleared on orchestrator switch
  readonly gridPage: number;
  readonly autoTailEnabled: Readonly<Record<TaskId, boolean>>;  // output panels default to auto-tail
}
```

### 2. Keyboard routing

Three new global keys handled in `use-keyboard.ts:431` (BEFORE view dispatch):
- `v` — cycle between metrics (`main`) and `workspace` only. **Ignored in detail view** — user must Esc first. Prevents ambiguity about where detail's `returnTo` should point.
- `m` — jump to `main`. Also works from detail (acts like Esc→m).
- `w` — jump to `workspace`.

New `handleWorkspaceKeys` function:

| Key | Action |
|---|---|
| `↑ ↓ j k` | Move left-nav cursor. **Does NOT** immediately switch the displayed orchestrator — requires Enter to commit (prevents spurious re-fetches on every arrow key). |
| `Enter` (on nav focus) | Commit nav selection; grid re-fetches for the new orchestrator. |
| `Tab / Shift+Tab` | Cycle grid panels. |
| `1-9` | Jump to grid panel by index. |
| `Enter` (on grid focus) | Drill into `detail` view for that child's entity. `returnTo: 'workspace'`. |
| `f` | Toggle fullscreen on focused panel. |
| `[` `]` | Scroll focused panel's output stream (disables auto-tail; `]` at the bottom re-enables it). |
| `g` `G` | Jump to top / bottom of focused panel's output. |
| `PgUp` `PgDn` | Paginate grid when `children.length > visibleSlots`. |
| `Esc / Backspace` | Exit fullscreen if active; else return to `main`. |
| `q` `r` `c` `d` | Global — see §8 for their workspace-specific semantics. |

Detail view (existing) gains one key: pressing `Esc` now consults `view.returnTo` to decide where to go.

### 3. Responsive layout infrastructure

**New file**: `src/cli/dashboard/use-terminal-size.ts`
```ts
export function useTerminalSize(): { columns: number; rows: number }
```

Implementation nuances:
- Ink's dashboard renders to **stderr** (per `index.tsx:50-55` — `process.stderr.isTTY`, `process.stderr.columns`), NOT stdout. The hook must read from `process.stderr.columns`/`.rows` and listen to `process.stderr.on('resize')`. `useStdout()` returns the wrong stream for this dashboard.
- Fallback chain: `stderr.columns ?? stdout.columns ?? 80` and `stderr.rows ?? stdout.rows ?? 24`.
- Debounce resize events via a 50ms `setTimeout` to avoid thrash during drag-resize.
- Initial read on mount; cleanup listener on unmount.

**New file**: `src/cli/dashboard/layout.ts` — pure functions, trivially unit-testable:
```ts
computeMetricsLayout({ columns, rows }): MetricsLayout
computeWorkspaceLayout({ columns, rows, childCount }): WorkspaceLayout
```

`MetricsLayout`:
- `headerHeight: 2, footerHeight: 1`
- `availableHeight = rows - headerHeight - footerHeight`
- `topRowHeight = clamp(floor(availableHeight * 0.35), 8, 14)` — tiles row
- `bottomRowHeight = availableHeight - topRowHeight`
- `tileCount = columns >= 120 ? 4 : columns >= 90 ? 3 : 2` (Resources + Cost + Throughput when 3; + Counts when 4; Activity in bottom row)
- Degraded modes:
  - `columns < 60` → single-column stack: tiles collapse into a short header strip, activity fills the rest
  - `rows < 14` → flash "resize terminal to view metrics"; dashboard stays responsive to resize events

`WorkspaceLayout`:
- `mode`: `'nav+grid' | 'grid-only' | 'too-small'`
  - `columns < 60` → `grid-only` with breadcrumb header
  - `columns < 50 || rows < 15` → `too-small` (fallback message)
- `navWidth = clamp(round(columns * 0.2), 20, 32)` in `nav+grid` mode
- `gridCols`: 1 (`gridWidth < 80`), 2 (`< 120`), 3 (`< 160`), 4 (`>= 160`)
- `maxGridRows`: `rows >= 50 ? 4 : 3` (more rows for taller terminals)
- `visibleSlots = gridCols * maxGridRows`
- `panelWidth = floor(gridWidth / gridCols) - 1`
- `panelHeight = floor(gridAreaHeight / displayedGridRows) - 1`  (uses displayed rows, not max — keeps panels tall when few children)
- `outputViewportHeight = panelHeight - 3` (metric bar + border chrome)
- **Minimum panel viability**: if `panelWidth < 20 || panelHeight < 6`, render the panel as a compact one-line strip ("metric bar only, output hidden — resize terminal").

### 4. Orchestrator child discovery (loop chain + direct attribution)

**Schema migration v11** — new nullable column on `tasks`:
```sql
ALTER TABLE tasks ADD COLUMN orchestrator_id TEXT REFERENCES orchestrations(id) ON DELETE SET NULL;
CREATE INDEX idx_tasks_orchestrator_id ON tasks(orchestrator_id) WHERE orchestrator_id IS NOT NULL;
```

**Threading `orchestrator_id` through all spawn paths** (not just `beat run`):

| Spawn path | How orchestrator_id is plumbed |
|---|---|
| Orchestration's initial task (the orchestrator agent itself) | `orchestration-manager.ts:createOrchestration` sets `orchestratorId = orchestration.id` on the task it creates when starting the loop iteration |
| `beat run` from inside an orchestrator process (CLI) | `BaseAgentAdapter` injects `AUTOBEAT_ORCHESTRATOR_ID=<id>` into the child env when the task has an orchestratorId. `src/cli/commands/run.ts` reads this env var on startup and passes it to `taskManager.delegate()`. |
| MCP `DelegateTask` from inside an orchestrator process | **IMPORTANT — Risk #8**: the MCP server process is long-lived and shared across orchestrators. Env var injection doesn't work here. Instead, the orchestrator agent wrapper passes `orchestratorId` via the `metadata` field of each MCP call. `src/adapters/mcp-adapter.ts` reads `args.metadata?.orchestratorId` on each `DelegateTask` call. |
| MCP `CreateOrchestrator` from inside an orchestrator process | New orchestrations do NOT inherit an outer orchestrator's id. A nested orchestrator starts its own subtree. (Documented behavior; nesting is rare.) |
| Recovery on daemon restart | `RecoveryManager` reloads tasks including their `orchestrator_id` — no special handling needed since it's just a column read. |

**Safety**: when reading `AUTOBEAT_ORCHESTRATOR_ID`, validate it matches a real orchestration in the DB before persisting it on the task. If not found (stale env leak from a prior shell), log warn and drop the attribution. Prevents accidental cross-orchestration pollution.

**New method** on `OrchestrationRepository`:
```ts
getOrchestratorChildren(
  orchestrationId: OrchestratorId,
  limit: number,
): Promise<Result<readonly OrchestratorChild[]>>;
```

**SQL** (in `src/implementations/orchestration-repository.ts`):
```sql
-- Union of two sources, de-duped on task_id
WITH direct_attribution AS (
  SELECT 'direct' AS kind, t.id, NULL AS iteration_id,
         t.status, t.created_at, t.prompt, t.agent, t.updated_at
  FROM tasks t
  WHERE t.orchestrator_id = :orchId
),
loop_chain AS (
  SELECT 'iteration' AS kind, t.id, li.id AS iteration_id,
         t.status, t.created_at, t.prompt, t.agent, t.updated_at
  FROM loop_iterations li
  JOIN tasks t ON t.id = li.task_id
  WHERE li.loop_id = (SELECT loop_id FROM orchestrations WHERE id = :orchId)
)
SELECT * FROM direct_attribution
UNION
SELECT * FROM loop_chain
ORDER BY updated_at DESC, created_at DESC
LIMIT :limit;
```

Application-layer DISTINCT on `task_id` to dedupe a task that appears in both CTEs. Prefer the `iteration` kind annotation when present (it's more descriptive for the UI).

**Ordering**: newest-updated first. This surfaces actively-changing tasks at the top of the grid.

### 5. Live output streaming via polling

**Configuration change**: lower default `outputFlushIntervalMs` from 5000 → 1000 in `src/core/configuration.ts:44,78`. The zod `min(500)` constraint stays. Env var `OUTPUT_FLUSH_INTERVAL_MS` remains the escape hatch for users who hit contention.

**Benchmark criteria (pass/fail before merge)**:
- Baseline: spawn 5 concurrent tasks, each writing ~100 lines of output over 30 seconds.
- Measure:
  - Total wall-clock duration of the run (should stay within ±10% of the 5000ms-interval baseline)
  - SQLite WAL file size growth (should stay bounded — no runaway)
  - Any `SQLITE_BUSY` errors in the logs (should be zero)
- Fail criteria: duration >15% slower, WAL growth >2× baseline, or any `SQLITE_BUSY`.
- If fail: raise default to 2000ms instead of 1000ms, document reasoning.

**New hook**: `src/cli/dashboard/use-task-output-stream.ts`
```ts
export interface OutputStreamState {
  readonly lines: readonly string[];        // tail buffer, capped at MAX_LINES_PER_STREAM (500)
  readonly totalBytes: number;
  readonly lastFetchedAt: Date | null;
  readonly error: string | null;
  readonly droppedLines: number;            // ring buffer trim counter
  readonly taskStatus: 'queued' | 'running' | 'terminal'; // drives poll behavior
}

export function useTaskOutputStream(
  outputRepo: OutputRepository,
  taskIds: readonly TaskId[],
  taskStatuses: ReadonlyMap<TaskId, string>,  // from useDashboardData
  enabled: boolean,
): { streams: ReadonlyMap<TaskId, OutputStreamState>; refreshNow: () => void }
```

Implementation:
- Internal `Map<TaskId, OutputStreamState>` in a ref; React state holds a version counter (increments on any stream mutation).
- Polling tick at 1000ms (`setInterval`), gated by `enabled`.
- **Per-task poll gating** (new):
  - `'queued'` → poll every 5 ticks (less churn on tasks that haven't started producing output yet).
  - `'running'` → poll every tick (1s).
  - `'terminal'` → poll ONCE after transition (to grab the final output), then stop polling this taskId.
- Diff via byte-count comparison against the previous state. Parse only the new suffix (O(delta), not O(total)).
- **ANSI strip**: regex `/\x1b\[[0-?]*[ -/]*[@-~]/g` (more permissive — handles cursor moves, colors, clear-screen, etc.)
- Ring buffer at 500 lines. Trim from front, increment `droppedLines`.
- `fetching` ref prevents overlap (same pattern as `use-dashboard-data.ts:211`).
- On `taskIds` change: keep entries still present, purge gone entries. New entries start in `'pending-first-fetch'` transient state.
- On `taskStatus` transition RUNNING→terminal: one final fetch, mark `'terminal'` in the stream state, render a "✓ final output" badge.

Memory budget: 500 lines × ~200 chars × up to 12 panels ≈ 1.2 MB. OK.

### 6. Token / cost capture

**Schema migration v12** — new table:
```sql
CREATE TABLE task_usage (
  task_id                      TEXT PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE,
  input_tokens                 INTEGER NOT NULL DEFAULT 0,
  output_tokens                INTEGER NOT NULL DEFAULT 0,
  cache_creation_input_tokens  INTEGER NOT NULL DEFAULT 0,
  cache_read_input_tokens      INTEGER NOT NULL DEFAULT 0,
  total_cost_usd               REAL    NOT NULL DEFAULT 0,
  model                        TEXT,
  captured_at                  INTEGER NOT NULL
);
CREATE INDEX idx_task_usage_captured_at ON task_usage(captured_at);
```

**New domain type** `TaskUsage` in `src/core/domain.ts`.

**New repository** `UsageRepository` in `src/core/interfaces.ts`:
```ts
export interface UsageRepository {
  /** UPSERT-safe save — overwrites existing row if present (idempotent for retry) */
  save(usage: TaskUsage): Promise<Result<void>>;
  get(taskId: TaskId): Promise<Result<TaskUsage | null>>;
  /** Sum across ALL tasks attributed to the orchestration, following retry_of chains */
  sumByOrchestrationId(orchId: OrchestratorId): Promise<Result<TaskUsage>>;
  sumByLoopId(loopId: LoopId): Promise<Result<TaskUsage>>;
  /** Global sum, optionally filtered to tasks completed since a timestamp */
  sumGlobal(sinceMs?: number): Promise<Result<TaskUsage>>;
  /** Top N orchestrations by total cost in the given time window */
  topOrchestrationsByCost(sinceMs: number, limit: number): Promise<Result<readonly { orchestrationId: OrchestratorId; totalCost: number }[]>>;
}
```

Implementation at `src/implementations/usage-repository.ts` follows the `SQLiteOutputRepository` pattern — prepared statements, Result-wrapped, `operationErrorHandler`. The `save` uses `INSERT ... ON CONFLICT(task_id) DO UPDATE SET ...` for idempotency.

**Retry aggregation (user decision #7)**: `sumByOrchestrationId` walks the `retry_of` chain. The SQL uses a recursive CTE:
```sql
WITH RECURSIVE task_tree(root_id, task_id) AS (
  -- Base: tasks directly attributed to this orchestration
  SELECT id AS root_id, id AS task_id
    FROM tasks
    WHERE orchestrator_id = :orchId
       OR id IN (
         SELECT task_id FROM loop_iterations
           WHERE loop_id = (SELECT loop_id FROM orchestrations WHERE id = :orchId)
           AND task_id IS NOT NULL
       )
  UNION
  -- Recurse: all retries of tasks already in the tree
  SELECT tt.root_id, t.id FROM tasks t
    INNER JOIN task_tree tt ON t.retry_of = tt.task_id
)
SELECT
  SUM(u.input_tokens), SUM(u.output_tokens),
  SUM(u.cache_creation_input_tokens), SUM(u.cache_read_input_tokens),
  SUM(u.total_cost_usd)
FROM task_tree tt
LEFT JOIN task_usage u ON u.task_id = tt.task_id;
```

**Capture at task completion** (Claude only in this PR):
- Claude spawns with `--print --dangerously-skip-permissions --output-format json` (verified in `src/implementations/claude-adapter.ts:20`).
- Output includes a final `{"type": "result", ..., "usage": {...}, "total_cost_usd": 0.0012, ...}` message.
- **New module** `src/services/usage-parser.ts`:
  ```ts
  export function parseClaudeUsage(output: TaskOutput, model: string | undefined): Result<TaskUsage | null>
  ```
  - Concatenates ALL stdout chunks (handles both inline and file-backed storage uniformly because `OutputRepository.get` already merges them — verified at `output-repository.ts:115-125`).
  - Searches backwards from the end of the concatenated string for the last `{"type":"result"` marker, parses that JSON object (using a simple brace-counter OR `JSON.parse` on the trimmed suffix).
  - Returns `ok(null)` if no result object found, unparseable JSON, or missing required fields (graceful — cost capture is best-effort, not blocking).
  - Validates all numeric fields with reasonable bounds (rejects negative numbers, rejects cost > $1000 as likely-corrupt).
- **Wire-in point**: `WorkerHandler` (or the handler that emits `TaskCompleted`). Order of operations:
  1. `ProcessConnector` completes its final flush on process exit (already guaranteed by `process-connector.ts:42-47`).
  2. Worker handler emits `TaskCompleted`.
  3. **New subscriber** (`UsageCaptureHandler`) listens for `TaskCompleted`:
     - `if (task.agent !== 'claude') return;`
     - `const outputResult = await outputRepository.get(task.id);`
     - `const usageResult = parseClaudeUsage(outputResult.value, task.model);`
     - `if (usageResult.ok && usageResult.value) await usageRepository.save(usageResult.value);`
     - All errors logged as warn, never throw.
- **Timing guarantee**: the TaskCompleted event fires only AFTER `ProcessConnector.cleanup(taskId)` finishes its final flush (look at the handler chain to verify). This ensures `outputRepository.get` returns the complete output.

**Codex and Gemini**: parser returns null; no usage captured. Aggregate queries return 0 for those tasks. Dashboard UI shows "—" in the cost column when no usage row exists.

### 7. Metrics dashboard (redesigned main view)

New file: `src/cli/dashboard/views/metrics-view.tsx` replaces `main-view.tsx` as the root for `view.kind === 'main'`.

Tiles (all new files in `src/cli/dashboard/components/`):
- **`resources-tile.tsx`** — reads from `SystemResourceMonitor.getResources()` via new `useResourceMetrics()` hook (2s poll). CPU bar colors: green <50%, yellow <80%, red ≥80%. Shows "—" when the monitor returns `err`.
- **`cost-tile.tsx`** — reads rolling 24h from `usageRepository.sumGlobal(nowMs - 24*3600*1000)` + top-3 orchestrations via `topOrchestrationsByCost(nowMs - 24*3600*1000, 3)`. Renders $X.XX. Shows "$0.00" when empty (common on fresh DBs).
- **`throughput-tile.tsx`** — aggregates completions via new `taskRepository.getThroughputStats(windowMs)` method. Tasks/hr, loops/hr, success rate, avg duration.
- **`activity-panel.tsx`** — time-sorted merge of recent state changes across all 4 entity types. Data source: `fetchAllData` invokes a new `buildActivityFeed()` helper that merges `taskRepository.findUpdatedSince(...)`, loops, orchestrations, schedules. Sorted descending by `updated_at`, limit 50. Each row: time, kind, short id, status, action. Enter → detail view for that entity (preserves existing detail routing with `returnTo: 'main'`).
- **`counts-panel.tsx`** — compact aggregate counts. Same numbers as today's panel headers, just laid out vertically. Replaces the 2×2 entity grid.

**What happens to the old `main-view.tsx` tests?** Its 264-test suite was testing the 4-panel grid rendering. After this PR, those tests retarget the new components or are deleted. Budget: ~60-80 test reshuffles.

**`main-view.tsx` is deleted**; no backward compatibility shim.

### 8. Workspace view

New file: `src/cli/dashboard/views/workspace-view.tsx`

Components (all new):
- **`orchestrator-nav.tsx`** — left-nav list. Wraps `ScrollableList`. Shows **focused** row (keyboard cursor) distinctly from **committed** row (currently displayed in grid) — focused has a `>` prefix, committed has a filled background or bold text. Sort order: by `updated_at DESC` (most recent activity first), then by `created_at DESC`. Default selection: first RUNNING; fallback to index 0.
- **`task-panel.tsx`** — single grid cell. Top bar: kind (TASK/LOOP/SCHEDULE), status badge, elapsed, agent, bytes, cost (from `usageRepository.get(taskId)`). Body: `<OutputStreamView>` bound to the streaming hook. Degraded mode when `panelWidth < 20`: just the top bar.
- **`metrics-bar.tsx`** — compact one-line metric strip used by both grid cells and fullscreen.
- **`output-stream-view.tsx`** — viewport-clipped text view over `OutputStreamState.lines`. **Auto-tail logic**: starts pinned to bottom. When user scrolls up (presses `[`), pin disengages and shows `[paused]` in the top-right. `]` at bottom re-engages auto-tail. `G` jumps to bottom and re-engages. Shows `↑ more` / `↓ N more` scroll indicators and `(N dropped)` if ring buffer trimmed.
- **`empty-workspace.tsx`** — friendly empty state when there are 0 orchestrators OR focused orchestration has 0 children. Hints what to do (e.g., "Run `beat orchestrate` to create one").

**Fullscreen mode** (`f` on focused panel): single `<TaskPanel>` fills the grid area. `outputViewportHeight` recomputed for the larger area. Scroll state is preserved across toggles.

**Fullscreen state lifetime**: cleared to `null` when the committed orchestrator changes (prevents confusing carry-over).

**Grid pagination**: if `children.length > gridCols * maxGridRows`, footer shows "page X of Y". `PgUp`/`PgDn` adjusts `workspaceNav.gridPage`. Snap back to page 0 if the child count shrinks below the current page's range.

**Task transition during view**:
- RUNNING → COMPLETED: panel stays but metric bar turns green, streaming hook polls once more and stops. "✓ final" badge.
- RUNNING → FAILED: panel stays, metric bar turns red. Error message visible in output.
- QUEUED → RUNNING: normal poll cadence kicks in.
- Task disappears (e.g., deleted by another tool): panel removed at next `fetchAllData` tick.

### 9. Cancel / delete semantics in new views (user decision #5)

**Cancel cascade (user decision #5)** — new `orchestrationService.cancelOrchestration(id, reason, opts)` behavior:
- Option flag `opts.cancelAttributedTasks: boolean` (default `true`).
- When `true`: the service queries `taskRepository.findByOrchestratorId(orchId, { statuses: ['queued', 'running'] })` and cancels each via `taskManager.cancel(taskId, reason)`. Errors logged, don't block.
- Keep existing cancel behavior for the orchestrator's own task via loopService.cancelLoop (which cancels the loop's current iteration task).
- Add a test for the cascade: create orch + loop + 3 direct-attribution tasks, cancel orch, assert all 4 tasks are CANCELLED.

**Keybindings**:

Metrics view (`main`):
- `c` — cancel the entity on the focused Activity row (if terminal, footer hint "already terminal"). Dispatches by `kind` to the right service (orchestration/loop/task/schedule). Orchestration cancel triggers the cascade.
- `d` — delete the entity on the focused Activity row (terminal status only). Same 4-way dispatch as v1.2.1's `d` handler.

Workspace view:
- `c` — depends on current focus:
  - If nav focus → cancel the highlighted orchestration (triggers cascade; all orchestrator_id-attributed tasks also cancelled).
  - If grid focus → cancel the task in the focused panel.
- `d` — deletes the terminal entity (grid focus only; nav cannot delete orchestrations while they have running children).

Detail view: inherits semantics of the `returnTo` view (behavior unchanged).

### 10. Data flow

`DashboardData` gains the following optional fields (existing ones untouched):

```ts
interface DashboardData {
  // ...existing fields...

  // Metrics view extras
  resourceMetrics?: SystemResources;
  costRollup24h?: TaskUsage;
  topOrchestrationsByCost?: readonly { orchestrationId: OrchestratorId; totalCost: number }[];
  throughputStats?: { tasksPerHour: number; loopsPerHour: number; successRate: number; avgDurationMs: number };
  activityFeed?: readonly ActivityEntry[];

  // Workspace view extras
  workspaceData?: {
    focusedOrchestration: Orchestration;
    children: readonly OrchestratorChild[];
    childTaskIds: readonly TaskId[];
    childTaskStatuses: ReadonlyMap<TaskId, string>;  // fed into the streaming hook's per-task gating
    costAggregate: TaskUsage;
  };
}
```

`ActivityEntry` (new):
```ts
interface ActivityEntry {
  readonly timestamp: Date;
  readonly kind: 'task' | 'loop' | 'orchestration' | 'schedule';
  readonly entityId: string;
  readonly status: string;
  readonly action: string;  // short verb: 'created', 'completed', 'failed', 'iteration 3'
}
```

`fetchAllData` (in `use-dashboard-data.ts`) gains two branches:
- **Main view branch**: in addition to existing fetches, runs the metric tile queries in parallel (`Promise.all`). ~6 extra queries per tick, all aggregates. Bounded.
- **Workspace view branch**: resolves focused orchestration → `getOrchestratorChildren(orchId, 20)` → builds `childTaskIds` + `childTaskStatuses` → calls `usageRepository.sumByOrchestrationId(orchId)` for the header cost.

**`useTaskOutputStream`** runs as a separate hook in `app.tsx`, keyed off `data?.workspaceData?.childTaskIds`. `enabled` is `view.kind === 'workspace' && view.kind !== 'detail'`. Does not interact with `useDashboardData`'s polling — runs its own timer for independent cadence control.

**ResourceMonitor dual-instance concern**: the daemon (MCP server) also creates a ResourceMonitor. The dashboard creates its own via `bootstrap({mode:'cli'})`. Both read from `os.cpus()`, `os.freemem()`, etc. — they're read-only OS calls, no shared state, no collision. Verified by reading `SystemResourceMonitor` — it doesn't write anywhere, doesn't emit events outside its own instance.

### 11. Orchestration detail view modernization (user decision #8)

`src/cli/dashboard/views/orchestration-detail.tsx` gains two new sections:

**Children list** (scrollable, reuses `ScrollableList`):
- Fetched via `getOrchestratorChildren(id, 50)` when entering the detail view (one-shot, not streaming).
- Each row: task ID, kind (direct vs iteration), status, agent, prompt preview.
- Enter on a row → drill into task-detail (new nested detail, `returnTo: 'orchestrations'`).

**Cost aggregate** (compact section):
- Fetched via `usageRepository.sumByOrchestrationId(id)`.
- Shows: `$X.XX · <input tokens> in / <output tokens> out · <cache savings>`.
- Hidden when all values are 0 (e.g., fresh orchestration).

Layout uses the existing `<Field>` / `<LongField>` components. No new primitives.

---

## Implementation phases (single PR, sequential commits)

Each phase ends in a compilable state with passing tests. Commits conventional-commits.

**Phase A — Data layer and instrumentation**
1. Migration v11: `tasks.orchestrator_id` + index
2. Migration v12: `task_usage` table + index
3. Domain types: `TaskUsage`, `OrchestratorChild`, `ActivityEntry`
4. `UsageRepository` interface + SQLite implementation (with UPSERT + recursive CTE for retries)
5. `getOrchestratorChildren` on `OrchestrationRepository`
6. `findByOrchestratorId`, `getThroughputStats`, `findUpdatedSince` on `TaskRepository`; `findUpdatedSince` on loop/orch/schedule repos
7. `parseClaudeUsage` + unit tests
8. `UsageCaptureHandler` + unit tests + handler-setup wiring
9. `orchestration-manager.ts`: set `orchestratorId` on initial task; implement cancel cascade
10. `base-agent-adapter.ts`: inject `AUTOBEAT_ORCHESTRATOR_ID` env var (validated against DB)
11. `run.ts`: read env var, pass through to delegate (validated)
12. `mcp-adapter.ts`: read orchestratorId from `args.metadata` (NOT env var — Risk #8), pass through on DelegateTask
13. `task-manager.ts`: accept `orchestratorId` in delegate input
14. `bootstrap.ts`: register `usageRepository`
15. `read-only-context.ts`: extend with `usageRepository`
16. `configuration.ts`: lower default `outputFlushIntervalMs` to 1000
17. Run flush benchmark test, verify pass criteria

Commit: `feat(data): task usage tracking + orchestrator_id propagation + cancel cascade + 1s flush default`.

**Phase B — Responsive infrastructure**
18. `use-terminal-size.ts` + tests (reads stderr, debounced)
19. `layout.ts` + tests (pure functions)

Commit: `feat(dashboard): responsive layout hook + pure layout math`.

**Phase C — Metrics view**
20. `use-resource-metrics.ts` hook (2s polling)
21. `activity-feed.ts` helper
22. Tiles: `resources-tile`, `cost-tile`, `throughput-tile`
23. Panels: `activity-panel`, `counts-panel`
24. `metrics-view.tsx`
25. `use-dashboard-data.ts`: main-view fetch branch
26. `types.ts`: extend `DashboardData`
27. `app.tsx`: use metrics-view as main
28. Delete `main-view.tsx`

Commit: `feat(dashboard): metrics view — resources/cost/throughput/activity/counts tiles`.

**Phase D — Workspace view + streaming**
29. `use-task-output-stream.ts` + tests
30. `workspace-types.ts`
31. `output-stream-view.tsx` + tests
32. `task-panel.tsx`, `metrics-bar.tsx`, `orchestrator-nav.tsx`, `empty-workspace.tsx`
33. `workspace-view.tsx`
34. `use-dashboard-data.ts`: workspace branch
35. `types.ts`: extend `ViewState` with `workspace` + `returnTo`
36. `app.tsx`: workspaceNav state + view dispatcher branch
37. Integration test: workspace data pipeline

Commit: `feat(dashboard): workspace view with per-orchestrator grid and live streaming`.

**Phase E — Keyboard wiring and detail updates**
38. Global `v/m/w` keys
39. `handleWorkspaceKeys`
40. `c`/`d` handler updates for both view kinds
41. Detail view `returnTo` plumbing
42. `orchestration-detail.tsx` children + cost sections
43. Footer hints per view kind
44. Header `[M]`/`[W]` breadcrumb

Commit: `feat(dashboard): workspace keybindings + orchestration-detail modernization`.

**Phase F — Cleanup, docs, release prep**
45. Delete obsolete fixtures
46. Update `CLAUDE.md` and `docs/FEATURES.md`
47. Draft `docs/releases/RELEASE_NOTES_v1.3.0.md`
48. Manual repro pass
49. Snyk scan

Commit: `docs: dashboard redesign notes + v1.3.0 release prep`.

---

## Risks and mitigations (key ones)

- **Risk #8 RESOLVED**: MCP adapter orchestrator_id propagation uses `args.metadata.orchestratorId` (per-request), NOT env var. The MCP server is long-lived and daemon-started.
- **Risk #5**: TaskCompleted must fire AFTER ProcessConnector final flush. Verify chain. If not, add explicit flush before TaskCompleted.
- **Risk #4**: `AUTOBEAT_ORCHESTRATOR_ID` validated against DB before persisting on task row. Drop silently if not found.
- **Risk #22**: `useTerminalSize` reads `process.stderr.columns/rows` and listens to `process.stderr.on('resize')`, NOT stdout.
- **Risk #2**: Flush benchmark must pass — 5 concurrent tasks, ±10% wall-clock baseline, bounded WAL growth, zero SQLITE_BUSY. If fails, raise to 2000ms.
- **Risk #14**: Budget ~60-80 dashboard test reshuffles after `main-view.tsx` deletion.

---

## Critical file checklist

| Area | Check |
|---|---|
| Migration v11 | `sqlite3 $DB ".schema tasks" \| grep orchestrator_id` |
| Migration v12 | `sqlite3 $DB ".schema task_usage"` |
| Config | `grep 'outputFlushIntervalMs' src/core/configuration.ts \| grep 1000` |
| Env injection | `grep AUTOBEAT_ORCHESTRATOR_ID src/implementations/base-agent-adapter.ts src/cli/commands/run.ts` |
| MCP metadata | `grep 'metadata.*orchestratorId' src/adapters/mcp-adapter.ts` |
| Cost parsing | `grep parseClaudeUsage src/services/usage-parser.ts src/services/handlers/usage-capture-handler.ts` |
| Cascade | `grep findByOrchestratorId src/services/orchestration-manager.ts` |
| ViewState | `grep 'workspace' src/cli/dashboard/types.ts` |
| Layout hook | `test -f src/cli/dashboard/use-terminal-size.ts && test -f src/cli/dashboard/layout.ts` |
| Streaming hook | `test -f src/cli/dashboard/use-task-output-stream.ts` |
| Metrics view | `test -f src/cli/dashboard/views/metrics-view.tsx && ! test -f src/cli/dashboard/views/main-view.tsx` |
| Workspace view | `test -f src/cli/dashboard/views/workspace-view.tsx` |
| Orch detail modern | `grep -E 'children.*list\|cost.*aggregate' src/cli/dashboard/views/orchestration-detail.tsx` |

---

## Verification

```bash
npm run typecheck && npm run check && npm run build
# Grouped test suites
npm run test:core && npm run test:handlers && npm run test:services \
  && npm run test:repositories && npm run test:adapters \
  && npm run test:implementations && npm run test:cli \
  && npm run test:dashboard && npm run test:integration
```
