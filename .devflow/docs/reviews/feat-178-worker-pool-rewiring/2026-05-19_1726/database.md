# Database Review Report

**Branch**: feat/178-worker-pool-rewiring -> main
**Date**: 2026-05-19T17:26

## Issues in Your Changes (BLOCKING)

### HIGH

**Orchestration liveness check does not account for tmux workers (pid=0 sentinel)** - `src/services/orchestration-liveness.ts:68`
**Confidence**: 85%
- Problem: `checkOrchestrationLiveness()` traces the chain `orchestration -> loop -> iteration -> task -> worker -> isProcessAlive(ownerPid)`. For tmux workers, `pid=0` and `ownerPid` is the bootstrap process PID. During normal operation (same process), `isProcessAlive(ownerPid)` returns `true` even when the tmux session has died. This means the dashboard liveness indicator and `failZombieRunningOrchestrations()` will report "live" for orchestrations whose tmux session crashed, until the next server restart triggers `cleanDeadWorkerRegistrations()`.
- Impact: Zombie orchestrations with dead tmux sessions show as "live" in the dashboard and are not auto-failed. The recovery-at-startup path in `cleanDeadWorkerRegistrations()` (lines 169-176) correctly handles tmux liveness, but `orchestration-liveness.ts` does not. These two code paths drift in behavior.
- Fix: Update `LivenessDeps` interface and `checkOrchestrationLiveness()` to accept an optional tmux session liveness checker:
```typescript
// orchestration-liveness.ts
export interface LivenessDeps {
  readonly loopRepo: LoopRepository;
  readonly taskRepo: TaskRepository;
  readonly workerRepo: WorkerRepository;
  readonly isProcessAlive: (pid: number) => boolean;
  readonly isTmuxSessionAlive?: (sessionName: string) => boolean;
}

// At line 64-68, after getting workerResult:
const worker = workerResult.value;
const isTmuxWorker = worker.pid === 0;
if (isTmuxWorker) {
  if (!worker.sessionName || !deps.isTmuxSessionAlive) return 'unknown';
  return deps.isTmuxSessionAlive(worker.sessionName) ? 'live' : 'dead';
}
return deps.isProcessAlive(worker.ownerPid) ? 'live' : 'dead';
```

## Issues in Code You Touched (Should Fix)

(none)

## Pre-existing Issues (Not Blocking)

(none)

## Suggestions (Lower Confidence)

- **`deleteByOwnerPid` may inadvertently miss tmux workers** - `src/implementations/worker-repository.ts:76` (Confidence: 65%) -- `deleteByOwnerPidStmt` queries `WHERE owner_pid = ?`. For tmux workers, `ownerPid` is the bootstrap process PID, not 0. This method is not currently called from production code paths (only tests and the interface), so no immediate impact. However, if it is used in a future cleanup sweep, it would correctly match tmux workers by the ownerPid that registered them. Noting for completeness.

- **No DB-level CHECK constraint on workers.pid sentinel value** - `src/implementations/database.ts:1200` (Confidence: 60%) -- The convention that `pid=0` means "tmux worker" is enforced only at the application layer. A CHECK constraint like `CHECK(pid >= 0)` would at minimum prevent negative PIDs. A more expressive constraint (`CHECK(pid = 0 OR pid > 0)`) does not add much value since both branches are valid. The current approach (application-layer convention + JSDoc) is consistent with how the project handles other semantic values.

- **Migration v29 skips version 28 gap check** - `src/implementations/database.ts:1196` (Confidence: 62%) -- Migration v28 (Gemini removal) and v29 (session_name) are in sequence. There is no gap -- v28 exists. This is a false alarm on my part; included only because migration numbering integrity is a common database review concern.

## Summary
| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 1 | 0 | - |
| Should Fix | - | 0 | 0 | - |
| Pre-existing | - | - | 0 | 0 |

**Database Score**: 8/10
**Recommendation**: CHANGES_REQUESTED

### What was done well

1. **Migration v29 is clean and idempotent**: Uses `ALTER TABLE ADD COLUMN` with nullable TEXT and a partial index -- the correct pattern for non-breaking schema evolution in SQLite. Follows the established migration pattern used throughout the codebase (v21, v23, v25, etc.).

2. **Worker repository session_name handling**: The `WorkerRowSchema` correctly declares `session_name` as `z.string().nullable().optional()`, and `rowToRegistration` maps `null` to `undefined` via the `?? undefined` pattern. This matches the existing `lastHeartbeat` pattern exactly. Tests cover all three cases (present, absent, legacy NULL row).

3. **RecoveryManager tmux-aware liveness**: The dual-path liveness check in `cleanDeadWorkerRegistrations()` (lines 169-176) and `recoverRunningTasks()` (lines 427-432) correctly distinguishes tmux workers (`pid === 0`) from process-based workers and routes to the appropriate liveness check. The incomplete-registration fallback (`false` when no sessionName) is the safe default.

4. **Partial index on session_name**: `idx_workers_session_name` uses `WHERE session_name IS NOT NULL`, keeping the index small since legacy process-based rows do not have session names. This is the correct pattern for sparse columns.

5. **No data migration needed**: `session_name` is nullable with no default, so existing rows naturally have NULL. `avoids PF-002` -- no migration path is needed for a column that has zero pre-existing data.

### Database-specific notes

- The `getPath()` method added to `Database` (line 192-195) is used by bootstrap to derive `sessionsDir`. This is a clean read-only accessor that does not expose mutable state.
- The `workers.pid = 0` sentinel convention is documented in JSDoc and enforced at the application layer. The one code path that does not yet account for it is `orchestration-liveness.ts` (the blocking finding above).
