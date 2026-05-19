# Performance Review Report

**Branch**: feat/dashboard-redesign-v1.3.0 -> main
**Date**: 2026-04-11 22:00
**Diff**: `git diff main...HEAD` (~12,500 LOC across dashboard, repos, handlers)
**Focus**: streaming I/O, polling cadence, query indexes, Ink re-renders, memory growth

---

## Issues in Your Changes (BLOCKING)

### CRITICAL

**Output streaming re-reads entire stdout buffer every 1s per child** — `src/cli/dashboard/use-task-output-stream.ts:283-339`, `src/implementations/output-repository.ts:105-129`
**Confidence**: 95%
- Problem: `useTaskOutputStream` claims to do "delta-parse" but the underlying `OutputRepository.get(taskId)` returns the **entire** `TaskOutput` blob from SQLite (or worse, reads the full file via `loadFromFile` for outputs over `fileStorageThreshold`). The "delta" in `buildStreamState` only extracts the suffix from a `Buffer.from(fullContent, 'utf-8')` after the I/O has already happened. So:
  - Per child panel, every 1s tick: 1 SQLite row read, 1 `JSON.parse` of all stdout chunks, 1 `Buffer.from(fullContent)` allocating the full byte buffer, 1 `buf.slice(...).toString('utf-8')` for the suffix.
  - For tasks whose output exceeds `fileStorageThreshold`, every tick does an `await fsPromises.readFile(filePath, 'utf-8')` (line 194) — full file re-read every second.
  - Cost grows **O(N · T)** where N is concurrent panels (up to 9 in 3×3 grid) and T is cumulative output size. A 5MB stdout buffer × 9 panels × 1Hz = ~45MB allocated/parsed/sliced per second on the dashboard process.
- The hook's `prev.totalBytes` short-circuit (line 116) only helps when the output hasn't grown — but on a running task, output **always** grows, so the short-circuit never fires while streaming.
- This is the dominant performance hot path of the redesign and the comment "Delta-parse, ANSI-stripped, delta-parse for efficiency" (line 3) is **misleading** — there's no I/O-side delta; the delta is purely a memory-side suffix extraction after the full buffer was already loaded.
- Fix: Either (a) extend `OutputRepository` with a true incremental API (`getSince(taskId, byteOffset)` that uses `fsPromises.read(fd, buf, 0, len, byteOffset)` for file-backed outputs and a SQLite `substr()` projection for DB-backed), or (b) cache the full buffer + offset in `useTaskOutputStream`'s ref and only re-fetch when `task_output.total_size` (a small projection) has actually grown. Option (b) is the smaller change:
  ```typescript
  // 1. Add a cheap size-only probe to OutputRepository
  async getSize(taskId: TaskId): Promise<Result<number | null>> {
    const row = this.sizeStmt.get(taskId) as { total_size: number } | undefined;
    return ok(row?.total_size ?? null);
  }
  // 2. In doPoll(): probe size first; only call .get() if size > prev.totalBytes
  ```
  This avoids re-parsing the JSON stdout array on the steady state where the producer hasn't flushed.

**Activity-feed query fan-out runs 7 SQL queries every 1s** — `src/cli/dashboard/use-dashboard-data.ts:204-220`, `src/implementations/loop-repository.ts:746-760`, `src/implementations/schedule-repository.ts:714-728`
**Confidence**: 90%
- Problem: When the metrics view is open (the default!), `fetchMetricsExtras` issues 7 queries on every 1s tick **on top of** the 8 baseline queries from `fetchAllData` (lines 106-115). That's **15 SQL round-trips per second** in steady state.
- Three of those `findUpdatedSince` queries are **un-indexed full table scans** because there is no index on `loops.updated_at`, `schedules.updated_at`, or `orchestrations.updated_at`. Only `tasks.findUpdatedSince` benefits indirectly from `idx_tasks_created_at` (and even then it sorts on `COALESCE(completed_at, started_at, created_at)` which the index does **not** cover).
- I verified the migrations:
  - `loops` (migration 10/11): only `idx_loops_status`, `idx_loops_schedule_id`. **No `idx_loops_updated_at`.**
  - `schedules` (migration 4): only `idx_schedules_status`, `idx_schedules_next_run`, `idx_schedules_due`. **No `idx_schedules_updated_at`.**
  - `orchestrations` (migration 14): only `idx_orchestrations_status`, `idx_orchestrations_loop_id`. **No `idx_orchestrations_updated_at`.**
  - `tasks` (migration 1): `idx_tasks_created_at` exists but the new `findUpdatedSinceStmt` (`task-repository.ts:170-179`) sorts on `COALESCE(completed_at, started_at, created_at)`, which forces a sort/temp B-tree.
- For users with thousands of accumulated tasks/loops/schedules/orchestrations (the v1.3.0 retention window is 7 days), this means 4 unindexed sorts per second every second the dashboard is open. SQLite is fast, but at 1Hz × 4 unindexed table scans, this becomes the dominant CPU cost on a busy server.
- Fix: Add indexes in a new migration (v20) for the four new query patterns, and rewrite the task scan to use a stored generated column or commit to a single sort key:
  ```sql
  CREATE INDEX IF NOT EXISTS idx_loops_updated_at ON loops(updated_at DESC);
  CREATE INDEX IF NOT EXISTS idx_schedules_updated_at ON schedules(updated_at DESC);
  CREATE INDEX IF NOT EXISTS idx_orchestrations_updated_at ON orchestrations(updated_at DESC);
  -- For tasks, add a stored column or change the query to use created_at as the sort key:
  CREATE INDEX IF NOT EXISTS idx_tasks_completed_or_created ON tasks(
    COALESCE(completed_at, started_at, created_at) DESC
  ) WHERE status IN ('completed', 'failed', 'cancelled', 'running');
  ```

**`sumByOrchestrationId` recursive CTE runs every 1s in detail/workspace views** — `src/implementations/usage-repository.ts:103-137`, `src/cli/dashboard/use-dashboard-data.ts:271-274, 336-344`
**Confidence**: 88%
- Problem: When a user opens the workspace or orchestration-detail view, `fetchWorkspaceExtras` and `fetchDetailExtra` fire `usageRepository.sumByOrchestrationId(orchId)` on every 1s poll. That query is a **recursive CTE** that:
  1. Joins `tasks` × `loop_iterations` × `orchestrations` to seed the recursion.
  2. Recurses on `tasks.retry_of` to follow the entire retry chain.
  3. LEFT JOINs `task_usage` for the SUM aggregate.
- There is **no index on `tasks.retry_of`** (verified migrations 1-19), so the recursive step does a full scan of the `tasks` table on each recursion depth. With a busy server (thousands of tasks, deep retry chains), this query gets progressively more expensive while the dashboard polls it 1×/sec.
- It is also a CRITICAL N+1 in another shape: when in the metrics view, `topOrchestrationsByCost` returns up to 3 orchestrations, but the workspace view fetches the cost for **only the focused** orchestration. A user paging through orchestrations in the nav causes 1 fresh recursive CTE per page change, plus one per 1s poll thereafter.
- Fix:
  1. Add `CREATE INDEX idx_tasks_retry_of ON tasks(retry_of) WHERE retry_of IS NOT NULL;` in a new migration.
  2. Cache the cost aggregate in the hook and only refetch when the orchestration's `updated_at` changes (cost can only change when a sub-task completes, which bumps the parent's `updated_at`).
  3. Decouple cost aggregation from the 1s poll cadence — 5s is more than fine for cost which only updates on task completion.

### HIGH

**File logger writes are fire-and-forget without backpressure or batching** — `src/implementations/file-logger.ts:135-160`
**Confidence**: 90%
- Problem: `FileLogger.write()` does `this.fileHandle.write(line).catch(...)` per log line and silently drops errors. Three problems:
  1. Each log call schedules an independent `write()` syscall — under heavy logging (e.g., resource monitor + 9 streaming children + 15 SQL queries × 1Hz), this can produce 50+ writes/second to a single file handle. `node:fs/promises`'s `FileHandle.write` does not internally batch; each call is a libuv work item.
  2. The async writes are **un-awaited** — if `dispose()` is called before all in-flight writes complete, the final `sync()` + `close()` (line 128-129) can race and lose the trailing entries. Worse: if writes pile up because the disk is slow, they accumulate **unboundedly** as floating promises in the microtask queue, holding their `line` strings live.
  3. Errors are completely silenced — a full disk or `EBADF` after `dispose()` becomes invisible.
- Fix: Use a small buffered writer (collect 10-20 lines or 4KB then flush) or switch to a `WriteStream` so Node manages the kernel-level write buffering. Keep a counter of in-flight writes and `await` them in `dispose()`. The current pattern works for low-volume logging but the dashboard's per-second activity creates exactly the wrong workload for it.
  ```typescript
  private pending: Promise<unknown>[] = [];
  private write(...) {
    const p = this.fileHandle.write(line).catch(...);
    this.pending.push(p);
    if (this.pending.length > 100) this.pending.shift();
  }
  async dispose() {
    await Promise.allSettled(this.pending);
    await this.fileHandle.sync();
    await this.fileHandle.close();
  }
  ```

**`useDashboardData` polls 8+ queries every 1s regardless of view** — `src/cli/dashboard/use-dashboard-data.ts:106-115, 433-442`
**Confidence**: 85%
- Problem: The base `fetchAllData` always issues 8 queries (4 list + 4 count) on every 1s tick **even when the user is in the workspace or detail view**, which only need a small subset of that data.
  - In workspace view, the user sees `data.workspaceData.children` and `costAggregate` — the 4 list-fetches and 4 count-fetches for the entity panels are wasted I/O.
  - In detail view, only one entity is shown — the 7 other lists/counts are wasted.
- Combined with the metrics-extras cost (HIGH above), the steady-state dashboard issues **8 + 7 = 15 queries per second** when on the main view, **8 + 2 = 10/s** in workspace, **8 + 3 = 11/s** in orchestration detail.
- Fix: Move the entity-list/count queries inside view-specific fetchers, and only run them when the metrics view is active (where the counts panel needs them). This roughly halves dashboard query load in non-metrics views and doesn't change the user-visible behavior.

**Liveness check serially walks orchestrations × 3-4 queries each** — `src/cli/dashboard/use-dashboard-data.ts:139-157`, `src/services/orchestration-liveness.ts:40-63`
**Confidence**: 92%
- Problem: For each `RUNNING` orchestration in the result set (up to 50, the `FETCH_LIMIT`), the dashboard sequentially awaits `checkOrchestrationLiveness`, which does 3 awaited queries: `getIterations(loopId, 1)` → `findById(taskId)` → `findByTaskId(taskId)`. That's **150 SQLite queries serially** worst-case, every 1 second.
  ```typescript
  for (const orch of orchestrations.value) {              // ❌ serial loop with awaits
    if (orch.status === OrchestratorStatus.RUNNING) {
      const liveness = await checkOrchestrationLiveness(orch, ...);   // 3 queries each
      ...
    }
  }
  ```
- Even with SQLite's sub-millisecond per-query latency, 150 sequential SQLite hits per second adds noticeable wall-clock latency to the poll cycle and starves the event loop. Better-sqlite3 is synchronous so this also blocks the JS thread for the duration.
- Fix:
  1. Run liveness checks in parallel via `Promise.all` (each individual check still does 3 awaits, but across orchestrations they parallelize).
  2. Cache liveness keyed by `(orchId, loopId.iteration_count)` and only re-probe when the iteration changes.
  3. Batch the inner queries via a `findByTaskIds(taskIds[])` method on `WorkerRepository` and `LoopRepository` so all 50 orchestrations resolve in 3 batched queries instead of 150 serial ones.

**Resource metrics polling double-counts because two pollers exist** — `src/cli/dashboard/use-resource-metrics.ts:11`, `src/implementations/resource-monitor.ts:256-292`
**Confidence**: 78%
- Problem: `useResourceMetrics` polls `resourceMonitor.getResources()` every 2s from the dashboard, but the same `SystemResourceMonitor` is also `startMonitoring()`-ing on a separate timer at `config.resourceMonitorIntervalMs` (default 5s) for the worker pool's spawning logic. Each `getResources()` call invokes `os.loadavg()` + `os.cpus()` + `os.totalmem()` + `os.freemem()` — these are cheap but **synchronous** OS calls.
- The bigger issue is that the dashboard's 2s cadence is hard-coded (`POLL_INTERVAL_MS = 2_000`) rather than reading from `Configuration`, so users can't slow it down on busy systems and the two pollers don't share their results.
- Fix: Subscribe to a `ResourceMonitorTick` event from the existing background poller instead of running a parallel poll loop in the hook. This eliminates the dual-poll, makes the cadence configurable, and reduces redundant OS calls. If event-driven is too invasive, at least make `POLL_INTERVAL_MS` configurable via `Configuration.resourceMonitorIntervalMs`.

### MEDIUM

**`buildActivityFeed` allocates a fresh `Date` per row before sorting** — `src/cli/dashboard/activity-feed.ts:90-131`
**Confidence**: 82%
- Problem: The function constructs `new Date(...)` for every entry across 4 source arrays, then sorts on `a.timestamp.getTime() - b.timestamp.getTime()`. The `getTime()` call inside the comparator runs O(n log n) times — each getter just returns the underlying number, but the `Date` allocations are wasted because the comparator immediately throws away the wrapper.
- With `limit = 50` entries from each source (200 total) the cost is small but it runs every 1s tick. Over a long-running dashboard session this creates GC pressure proportional to dashboard uptime.
- Fix: Store `timestamp` as the raw `number` (epoch ms) inside the merged feed, sort numerically, and only convert to `Date` in the renderer if needed. The `ActivityEntry` type can keep its `Date` field for backwards compat by using `new Date(epochMs)` lazily on render.

**Workspace view rebuilds `costsByTask` Map on every render** — `src/cli/dashboard/views/workspace-view.tsx:170-171`
**Confidence**: 75%
- Problem: `const costsByTask = new Map<TaskId, TaskUsage | null>(children.map((c) => [c.taskId, null]))` allocates a fresh Map on every render — and then immediately fills it with `null` values for all children. The map is currently always-null because the per-child cost split is "not available yet" per the comment. So this is a useless allocation that defeats `React.memo` on `TaskPanel` (the Map identity changes every render).
- Fix: Either remove the map until per-child costs land, or `useMemo` it on `children`. Without memoization, the `cost={costsByTask.get(child.taskId) ?? null}` prop on every `TaskPanel` is always-null but the prop reference changes, so `React.memo`'s shallow compare misses (it'd still pass since `null === null`, but the parent re-runs `.get()` on every render anyway).

**`shouldPollThisTick` for terminal tasks still iterates the entire taskIds list** — `src/cli/dashboard/use-task-output-stream.ts:283-295`
**Confidence**: 80%
- Problem: Every 1s tick, `doPoll` iterates **all** `taskIds`, including terminal ones, just to skip them via `terminalFetchedRef.has(taskId)`. For long-running orchestrations with many completed children, this is a constant per-tick overhead even when nothing is streaming.
- Fix: Maintain a separate `activeTaskIdsRef` that's the difference of `taskIds \ terminalFetchedRef` and iterate only that. Recompute when `taskIds` changes (which already triggers a separate effect at line 250).

**`refreshNow` callback is unstable across renders** — `src/cli/dashboard/use-task-output-stream.ts:363-366`
**Confidence**: 70%
- Problem: `refreshNow` is wrapped in `useCallback` with `[doPoll]` dep, but `doPoll` itself depends on `[outputRepo, taskIds, taskStatuses, enabled]`. Since `taskStatuses` is a `ReadonlyMap` constructed fresh in `app.tsx:99` every render, `doPoll` changes identity on every poll cycle, which means the `setInterval` re-installs (line 353) on every render while a task status updates. The interval is cleared and recreated, which can cause poll-cadence drift.
- Fix: Stabilize `taskStatuses` via `useMemo` keyed on a serialized status string (similar to the `taskIdsKey` pattern at line 245), or read it through a ref the way `viewStateRef` is used in `use-dashboard-data.ts:386-388`.

## Issues in Code You Touched (Should Fix)

### MEDIUM

**`getOrchestratorChildren` CTE has a UNION ALL without an index on `loop_iterations.loop_id`** — `src/implementations/orchestration-repository.ts:418-480`
**Confidence**: 80%
- Problem: The CTE branch for the iteration kind does `JOIN tasks t ON t.id = li.task_id WHERE li.loop_id = (SELECT loop_id FROM orchestrations WHERE id = :orchId)`. The subquery `SELECT loop_id FROM orchestrations WHERE id = :orchId` runs once (PK lookup, fast), but the outer `WHERE li.loop_id = ?` benefits from `idx_loop_iterations_loop_id` (which exists, good). The `WHERE t.orchestrator_id = :orchId` on the direct branch needs `idx_tasks_orchestrator_id` (which exists as a partial index, good).
- However the dedupe `ROW_NUMBER() OVER (PARTITION BY task_id ...)` requires an in-memory hash for distinct task_id grouping. With many iterations × many direct attributions, this temp table grows. Combined with the **count** query (lines 487-509) which runs the **same** UNION ALL CTE just to call COUNT(DISTINCT), every page change does the join twice.
- Fix: Memoize the count for an orchestration (it only changes when a new task is attributed) so paging doesn't re-run the count. Or fetch `total + page` in a single window function:
  ```sql
  SELECT *, COUNT(*) OVER () AS total FROM (...)
  ```

**`tasks.findUpdatedSince` ORDER BY does not match any index** — `src/implementations/task-repository.ts:170-179`
**Confidence**: 85%
- Problem: The query sorts by `COALESCE(completed_at, started_at, created_at) DESC`. SQLite cannot use `idx_tasks_created_at` for this expression because the index is on the bare column, not the COALESCE expression. Result: every call does a full sort over the filtered rows (filesort).
- Fix: Either store an `updated_at` column on tasks (cleaner long-term) or create an expression index:
  ```sql
  CREATE INDEX idx_tasks_updated_expr ON tasks(
    COALESCE(completed_at, started_at, created_at) DESC
  );
  ```

### LOW

**`OutputStreamView` re-renders all visible lines on every parent re-render** — `src/cli/dashboard/components/output-stream-view.tsx:48-58, 101-105`
**Confidence**: 65%
- Problem: The `lines.map((line, idx) => <Text key={...}>...</Text>)` creates a new `<Text>` element per visible line every render. Ink reconciles these against the previous frame, but when the parent (TaskPanel → WorkspaceView) re-renders for any reason (poll tick, animation frame, etc.), the entire line array is re-rendered. With 9 panels × ~20 visible lines each, that's 180 `<Text>` reconciliations per render at 4Hz from the animFrame interval.
- Fix: The `viewportHeight`-clipped slice is fine, but consider a `useMemo` on `visibleLines` keyed by `[lines, scrollOffset, viewportHeight, autoTail]` so unchanged frames skip the slice work.

## Pre-existing Issues (Not Blocking)

### MEDIUM

**`OutputRepository.append` is O(n²) over chunks** — `src/implementations/output-repository.ts:75-103`
**Confidence**: 90%
- Problem: Each `append()` does a full `get(taskId)` (read entire stdout), constructs a new array via spread `[...existing, data]`, and writes the entire stdout back via `save()`. For a task that emits 10000 chunks, this is O(n²) total work and O(n²) bytes written. The new dashboard amplifies this because the streaming reader reads back what append just wrote.
- This pre-dates v1.3.0 but the new dashboard makes it observable: live tasks now have their full output read 1×/sec while the producer writes chunks. With a chatty `claude` agent producing 100 chunks/sec, the producer is doing O(n²) writes while the reader is doing O(n) reads at 1Hz — the producer becomes the bottleneck.
- Fix: Switch `append` to a true append (open file in `'a'` mode for file-backed, use SQLite `||` concat for DB-backed) and stop round-tripping the entire output through JSON.

## Suggestions (Lower Confidence)

- **Animation frame timer at 4Hz triggers full app re-render** — `src/cli/dashboard/app.tsx:73-78` (Confidence: 60%) — The 250ms `setAnimFrame` interval rerenders the entire `App`, cascading through every memoized child whose props the React reconciler has to compare. Consider scoping the animation frame to only the components that visually animate (`StatusBadge`).
- **Workspace `OrchestratorNav.height` hard-coded to 24** — `src/cli/dashboard/views/workspace-view.tsx:206` (Confidence: 60%) — The comment says "actual height from terminal" — fixing this won't cause a perf regression, but the hard-coded 24 means the nav over-renders rows on small terminals.
- **Pipeline-tail tracking missing index on `loops.task_template`** (Confidence: 65%) — Not a v1.3.0 regression but worth tracking; loop iteration recovery uses string scans on JSON columns.

## Summary

| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 3 | 4 | 4 | 0 |
| Should Fix | - | 0 | 2 | 1 |
| Pre-existing | - | - | 1 | 0 |

**Performance Score**: 5/10
**Recommendation**: CHANGES_REQUESTED

### Top 3 Action Items

1. **Add a true incremental output read API** — the current "delta-parse" is a memory-side optimization that doesn't help the dominant I/O cost. Without this fix, the workspace view's per-tick cost grows linearly with cumulative task output, which on long-running orchestrations is the worst possible scaling shape.
2. **Add the four missing indexes** — `idx_loops_updated_at`, `idx_schedules_updated_at`, `idx_orchestrations_updated_at`, `idx_tasks_retry_of`, and the expression index for `tasks.findUpdatedSince`. Without these, the metrics view does 4 unindexed scans per second that get progressively more expensive as data accumulates.
3. **Parallelize and cache the liveness check fan-out** — the serial `for-await` loop over RUNNING orchestrations is a worst-case shape for SQLite + better-sqlite3's synchronous bridge; under load it can starve the event loop and skew the 1s poll cadence.

### Notes on the v1.3.0 design

The redesign is internally consistent and the test coverage (e.g., `flush-interval-benchmark.test.ts`, `use-task-output-stream.test.ts`, `orchestration-repository.test.ts`) demonstrates the team thought about cadence — the 1000ms output flush default is well-justified by the dashboard requirements. The performance issues above are not architectural mistakes; they are gaps between the intended "stream tail" model and the actual "re-read full buffer" implementation, plus standard SQLite hygiene (indexes for new query patterns) that wasn't carried into the migration.

The two highest-leverage fixes (incremental output read + the four missing indexes) are small, additive, and can land without changing the dashboard contract.
