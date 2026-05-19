# Consistency Review Report

**Branch**: feat/dashboard-redesign-v1.3.0 -> main
**Date**: 2026-04-11 22:00
**PR**: dean0x/autobeat#133 — feat: dashboard redesign v1.3.0
**Diff base**: `git diff main...HEAD`

## Scope
97 changed files / +12,498 / -819. Probed:
- New Repository classes/methods (`usage-repository.ts`, paginated/findUpdatedSince methods on `task-repository.ts`, `loop-repository.ts`, `schedule-repository.ts`, `orchestration-repository.ts`)
- New `UsageCaptureHandler` vs existing handlers (Checkpoint, Loop, Persistence)
- New `MCPAdapter.DelegateTask` `metadata.orchestratorId` field vs existing schema style
- New dashboard components, hooks, views, and tests
- New `FileLogger` vs the existing `Logger` implementations
- New `ActivityEntry` type vs existing time field conventions
- `OrchestrationManagerService.createOrchestration` event/throw pattern in `LoopHandler.handleLoopCreated`
- Test naming, fixture style, and `describe`/`it` consistency

---

## Issues in Your Changes (BLOCKING)

### CRITICAL
None.

### HIGH

**`ActivityEntry.timestamp` is `Date`, not epoch ms — breaks the project-wide time-field convention** — `src/core/domain.ts:826` (and `src/cli/dashboard/activity-feed.ts:92,102,112,122,131`)
**Confidence**: 92%
- Problem: Every existing time field across the domain uses `number` (epoch ms): `Task.createdAt/updatedAt/completedAt`, `Schedule.createdAt/updatedAt/nextRunAt`, `Loop.createdAt/updatedAt/completedAt`, `LoopIteration.startedAt/completedAt`, `Orchestration.createdAt/updatedAt/completedAt`, `ScheduleExecution.scheduledFor/executedAt/createdAt`, `TaskUsage.capturedAt`. The new `ActivityEntry.timestamp: Date` is the only outlier.
  - `activity-feed.ts` wraps every entry's epoch ms back into a `new Date(...)`, then `entries.sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime())` immediately calls `.getTime()` to undo the wrapping. This is purely overhead and an inversion of the project's "Date.now() epoch ms everywhere" convention.
  - The memory note about loops using `Date` was reverted before merge — `Loop.createdAt: number` confirms this. There is no precedent in `main` for `Date`-typed timestamps on a domain entity.
- Fix:
  ```typescript
  // src/core/domain.ts
  export interface ActivityEntry {
    readonly timestamp: number; // epoch ms — match Task/Loop/Schedule/Orchestration convention
    readonly kind: 'task' | 'loop' | 'orchestration' | 'schedule';
    readonly entityId: string;
    readonly status: string;
    readonly action: string;
  }

  // src/cli/dashboard/activity-feed.ts (drop the new Date(...) wrapping and getTime() call)
  entries.push({
    timestamp: task.updatedAt ?? task.createdAt ?? 0,
    ...
  });
  entries.sort((a, b) => b.timestamp - a.timestamp);
  ```
  Format-on-render in `ActivityPanel` (`activity-panel.tsx:24-28`) becomes `formatTime(new Date(entry.timestamp))` — a single boundary conversion at the view layer, exactly like `format.ts:relativeTime` already does for orchestration/loop timestamps.

**`LoopHandler.handleLoopCreated` throws while every other event handler returns Result-or-logs** — `src/services/handlers/loop-handler.ts:170-195`
**Confidence**: 85%
- Problem: The new code re-throws inner Result errors so emit() returns err(...). This is a deliberate departure from the established handler pattern in `CheckpointHandler.handleTaskCompleted`, `PersistenceHandler.*`, `QueueHandler.*`, `ScheduleHandler.*`, and `OrchestrationHandler.*`, all of which use `await this.handleEvent(event, ...)` and let the base class log errors. The DECISION comment is accurate about why, but it leaves the handler API inconsistent: only LoopCreated propagates failures via emit(), every other event silently logs and continues. A reader debugging "why does my LoopCreated fail loudly but my TaskFailed doesn't" has to read this single-decision comment to understand the divergence.
  - Concretely, the project rule "stick to ONE async pattern" (CLAUDE.md) is partially violated: handlers as a class are now mixed-mode.
- Fix: Either (a) make all handlers throw inner Result errors so emit() callers can react uniformly, or (b) keep the pattern consistent (log-and-drop) and ensure the orchestration manager checks for the orphan loop ID by other means (e.g., `loopRepo.findById(loopId)` after `emit('LoopCreated', ...)` to confirm it persisted). Option (a) is the cleaner long-term fix; option (b) restores immediate consistency. Either way, document the chosen pattern in `BaseEventHandler` JSDoc and update CheckpointHandler/Persistence/Queue/Schedule/Orchestration to match.

**FileLogger ignores the configured `LogLevel` — every level is written regardless of `--log-level` config** — `src/implementations/file-logger.ts:100-114, 135-160`
**Confidence**: 90%
- Problem: `StructuredLogger` and `ConsoleLogger` (existing implementations of `Logger`) both check `this.level` before emitting to filter `debug` < `info` < `warn` < `error`. `FileLogger` accepts no level parameter and writes every call to disk unconditionally. When the dashboard runs (which forces `FileLogger` via `bootstrap({ mode: 'cli', logger: fileLogger })`), the configured `config.logLevel` is silently ignored — `dashboard.log` will balloon with `debug` lines that the same code in MCP-server mode would have suppressed.
  - This isn't a feature gap, it's a contract violation. Two implementations of the same `Logger` interface have observably different filtering behavior.
- Fix:
  ```typescript
  // file-logger.ts: accept and respect LogLevel like StructuredLogger
  import { LogLevel } from './logger.js';

  static async create(
    filePath: string = DEFAULT_DASHBOARD_LOG_PATH,
    level: LogLevel = LogLevel.INFO,
  ): Promise<DisposableLogger> { ... }

  debug(message, context) {
    if (this.level > LogLevel.DEBUG) return;
    this.write('debug', message, undefined, context);
  }
  // ... same for info/warn/error
  ```
  And in `index.tsx`, pass `config.logLevel` mapped through `LOG_LEVEL_MAP` from `bootstrap.ts`.

## Issues in Code You Touched (Should Fix)

### MEDIUM

**`OrchestrationDetailProps.children` shadows React's reserved `children` prop** — `src/cli/dashboard/views/orchestration-detail.tsx:31, src/cli/dashboard/views/detail-view.tsx:78`
**Confidence**: 88%
- Problem: `OrchestrationDetailProps` declares `readonly children?: readonly OrchestratorChild[]` and `DetailView` passes it via `<OrchestrationDetail children={data?.orchestrationChildren ?? []} />`. React reserves the `children` prop name for nested JSX content. While TypeScript and React tolerate the override, this is the only place in the dashboard codebase where a domain prop named `children` shadows the built-in. Other components consistently rename collection props (e.g., `WorkspaceViewProps.streams`, `OrchestratorNavProps.orchestrations`, `ActivityPanelProps.activityFeed`) to avoid the collision.
  - Risk: future maintainers wrapping `<OrchestrationDetail>...</OrchestrationDetail>` will silently overwrite the data prop.
- Fix: Rename the prop to `childTasks` or `childList` (matches `OrchestratorChild` domain term) and update both the interface and the call site:
  ```typescript
  interface OrchestrationDetailProps {
    readonly orchestration: Orchestration;
    readonly animFrame?: number;
    readonly childTasks?: readonly OrchestratorChild[];
    // ...
  }

  // detail-view.tsx
  <OrchestrationDetail
    orchestration={orchestration}
    childTasks={data?.orchestrationChildren ?? []}
    ...
  />
  ```

**`metadata.orchestratorId` MCP schema is the only nested-object field on `DelegateTaskSchema` — flat is the established style** — `src/adapters/mcp-adapter.ts:71-83`
**Confidence**: 78%
- Problem: Every other field on `DelegateTaskSchema` is flat (`prompt`, `priority`, `workingDirectory`, `timeout`, `dependsOn`, `parentTaskId`, `continueFrom`, `agent`, `model`). The new `metadata: z.object({ orchestratorId: ... }).optional()` is the only nested object. The DECISION comment justifies why per-request metadata is correct (vs env var), but does not explain why nesting under `metadata`.
  - All other MCP tool schemas in this file use flat top-level fields (e.g., `TaskStatusSchema`, `RetryTaskSchema`, `CreatePipelineSchema`). A future review will ask "what other things go under `metadata`?", and the answer is "nothing else" — the field exists solely to bag a single string.
- Fix: Promote it to a flat `orchestratorId?: string` at the top of the schema. Keep the regex validator and the JSDoc comment about "intentionally per-request, NOT env var" as-is. This matches the rest of the file and removes a one-off shape.
  ```typescript
  orchestratorId: z
    .string()
    .regex(/^orchestrator-/)
    .optional()
    .describe('Per-request orchestration attribution. Validated against DB; dropped silently if not found. (v1.3.0)'),
  ```
  If you specifically want a `metadata` namespace for forward-compat (more fields coming in v1.4+), add a one-line code comment and a brief design note — the current code says nothing about the intent.

**`'fs' / 'os' / 'path'` vs `'node:fs/promises' / 'node:os' / 'node:path'` — new files use the prefixed form, the rest of the codebase uses the bare form** — `src/implementations/file-logger.ts:14-16`, `src/cli/dashboard/index.tsx:12-14`, `tests/unit/cli/dashboard/render-options.test.ts:13-14`
**Confidence**: 80%
- Problem: 15 source files in `src/` (including `orchestration-repository.ts`, `database.ts`, `orchestration-manager.ts`, `output-repository.ts`, `resource-monitor.ts`, `cli.ts`, `validation.ts`, etc.) import node builtins as bare specifiers (`from 'fs'`, `from 'path'`, `from 'os'`). Two new files in this PR use the `node:` prefix form. Biome's linter doesn't enforce either, so this is purely a stylistic inconsistency, but it's the kind of thing that gets normalized over time and right now the new code is the outlier.
- Fix: Drop the `node:` prefix in the two new files to match the rest of the codebase, OR open a separate, focused PR converting the whole codebase to `node:` prefixes (which is the ESM-recommended form) and configure `useNodejsImportProtocol` in biome to enforce it. Don't mix both styles.

## Pre-existing Issues (Not Blocking)

### MEDIUM

**Repo update signatures are inconsistent across repositories — pre-existing inconsistency surfaced by `updateIfStatus` addition** — `src/core/interfaces.ts:117, 326, 599, 779`
**Confidence**: 95%
- Problem: This is pre-existing in `main` and not introduced by the PR, but the new `updateIfStatus(orchestration, expectedStatus)` highlights it:
  - `TaskRepository.update(taskId: TaskId, update: Partial<Task>)` — partial-update by ID
  - `ScheduleRepository.update(id: ScheduleId, update: Partial<Schedule>)` — partial-update by ID
  - `LoopRepository.update(loop: Loop)` — full-replace
  - `OrchestrationRepository.update(orchestration: Orchestration)` — full-replace
  - New `OrchestrationRepository.updateIfStatus(orchestration, expectedStatus)` — full-replace, conditional
  Two distinct call patterns coexist in repositories that look symmetric from the interface name. The new method follows the orchestration-repo style correctly, so this report just notes the legacy divergence.
- Recommendation: Out of scope for this PR. Track as tech debt; pick one canonical update style and migrate the others in a dedicated refactor.

## Suggestions (Lower Confidence)

- **`ResourcesTile` accepts `error: string | null` prop but renames it to `_error` and never renders it** - `src/cli/dashboard/components/resources-tile.tsx:38` (Confidence: 70%) — Prop is in the interface but always discarded; either render it (consistent with `Header.error` rendering) or remove it from the interface and the parent call site.
- **`bootstrap.ts` import block ordering: top-level service interface imports moved into the middle of the file** - `src/bootstrap.ts:107` (Confidence: 65%) — `SQLiteUsageRepository` is added below the `// Adapters` and `// Services` comment dividers but before the `// Services` block, wedging a single import out of group order. Cleanup pass to alphabetize within each section would normalize this.
- **`UsageRepository` private helpers `rowToUsage` and `aggregateRowToUsage` duplicate the column-extraction logic** - `src/implementations/usage-repository.ts:221-245` (Confidence: 65%) — Both helpers map the same five numeric columns; consolidate into one helper that takes an optional `taskId` and `capturedAt` for the aggregate case.

## Summary
| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 3 | 0 | 0 |
| Should Fix | - | 0 | 3 | 0 |
| Pre-existing | - | - | 1 | 0 |

**Consistency Score**: 7/10
- Strengths: New repo classes follow `Result<T>`/`tryCatchAsync`/`operationErrorHandler` exactly. `UsageCaptureHandler` mirrors `CheckpointHandler` factory pattern character-for-character. Dashboard components consistently use kebab-case files, `React.FC` + `React.memo` + `displayName`, readonly props, and existing primitives (`ScrollableList`, `StatusBadge`, `Field`). Tests use the project's `describe`/`it` style and follow existing fixture conventions. New CLI/`run.ts` env-var handling is well-commented and matches `MCPAdapter` validation pattern.
- Weaknesses: One domain-shape inconsistency (`ActivityEntry.timestamp: Date`), one mixed-mode handler exception (`LoopHandler` throws), one Logger contract divergence (`FileLogger` ignores log level), and a clutch of small style outliers (nested MCP metadata, `node:` prefix, React `children` prop name).

**Recommendation**: CHANGES_REQUESTED

The blocking items are all addressable in <100 LOC of mechanical edits and they preserve all existing v1.3.0 functionality. Resolve the three HIGH findings (timestamp type, handler throw pattern, FileLogger level filtering), and the PR is APPROVED.
