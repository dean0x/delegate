# Security Review Report

**Branch**: task-2025-01-25_2210 -> main
**Date**: 2026-02-18
**Focus**: Security vulnerability analysis (injection, auth bypass, crypto misuse, OWASP vulnerabilities, input validation gaps, unsafe deserialization, resource exhaustion vectors)
**Post-Debate Update**: Confidence levels added based on adversarial cross-review round.

---

## Issues in Your Changes (BLOCKING)

### HIGH

**H1: Missing `workingDirectory` path validation in `handleScheduleTask`** - `/Users/dean/Sandbox/delegate/src/adapters/mcp-adapter.ts:913`
**Confidence: HIGH** (Unchallenged by all reviewers)

- **Problem**: The `handleScheduleTask` method passes `data.workingDirectory` directly into the task template without calling `validatePath()`. The existing `handleDelegateTask` method (line 521-537) correctly validates workingDirectory using `validatePath()` to prevent path traversal. The schedule handler skips this entirely, meaning a malicious cron-scheduled task could specify a workingDirectory like `../../etc` or a symlink-based traversal path.
- **Impact**: Path traversal attack vector. Scheduled tasks could execute Claude Code in arbitrary filesystem locations, potentially accessing sensitive files or directories outside the intended workspace. This is OWASP A01 (Broken Access Control).
- **Category**: BLOCKING - This is code added in this PR.
- **Fix**:
```typescript
// In handleScheduleTask, after parsing data, add path validation:
let validatedWorkingDirectory: string | undefined;
if (data.workingDirectory) {
  const pathValidation = validatePath(data.workingDirectory);
  if (!pathValidation.ok) {
    return {
      content: [{ type: 'text', text: `Invalid working directory: ${pathValidation.error.message}` }],
      isError: true,
    };
  }
  validatedWorkingDirectory = pathValidation.value;
}

// Then use validatedWorkingDirectory in the schedule creation:
const schedule = createSchedule({
  taskTemplate: {
    prompt: data.prompt,
    priority: data.priority as Priority | undefined,
    workingDirectory: validatedWorkingDirectory,  // was: data.workingDirectory
  },
  // ...
});
```

---

**H2: Unsafe JSON deserialization of `task_template` without schema validation** - `/Users/dean/Sandbox/delegate/src/implementations/schedule-repository.ts:402-405`
**Confidence: HIGH** (Reinforced by TypeScript reviewer; no challenges)

- **Problem**: The `rowToSchedule` method deserializes `task_template` from the database using `JSON.parse()` and then applies a bare type assertion (`as DelegateRequest`) without any Zod schema validation. While the ScheduleRowSchema validates the column exists as a string, it does not validate the structure of the JSON content. If the database is corrupted, manually edited, or subject to a stored injection, the deserialized object could have unexpected shape or malicious properties (e.g., extra fields, wrong types for `prompt`, `priority`, etc.).
- **Impact**: OWASP A08 (Data Integrity Failures / Unsafe Deserialization). The code trusts that the stored JSON conforms to `DelegateRequest` interface without runtime validation. This is inconsistent with the project's "parse, don't validate" principle applied elsewhere (e.g., ScheduleRowSchema validates all other fields). A corrupted or tampered `task_template` could cause tasks to execute with unexpected parameters.
- **Category**: BLOCKING - New code in this PR.
- **Cross-reviewer support**: TypeScript reviewer independently flagged the `as DelegateRequest` cast as unsafe (unsafe `as` pattern). Database reviewer noted `task_template` column has no size limit or validation.
- **Fix**: Add a Zod schema for DelegateRequest validation:
```typescript
const DelegateRequestSchema = z.object({
  prompt: z.string().min(1).max(4000),
  priority: z.enum(['P0', 'P1', 'P2']).optional(),
  workingDirectory: z.string().optional(),
  // ... other fields as needed
});

// In rowToSchedule:
let taskTemplate: DelegateRequest;
try {
  const parsed = JSON.parse(data.task_template);
  taskTemplate = DelegateRequestSchema.parse(parsed);
} catch (e) {
  throw new Error(`Invalid task_template for schedule ${data.id}: ${e}`);
}
```

---

**H3 (NEW - adopted from Quality H3): Infinite retrigger on `getNextRunTime` failure creates DoS amplification** - `/Users/dean/Sandbox/delegate/src/services/handlers/schedule-handler.ts:299-306`
**Confidence: HIGH** (Originally Quality reviewer finding; endorsed by Security, Database, and Architecture reviewers)

- **Problem**: When `getNextRunTime` fails for a CRON schedule (line 299-306), `newNextRunAt` remains `undefined`. The update spread at line 335 (`...(newNextRunAt !== undefined ? { nextRunAt: newNextRunAt } : {})`) means `nextRunAt` is NOT cleared. The schedule retains its old (already-past) `nextRunAt`, causing the executor's `findDue` query to return it again on the next tick (every 60 seconds). This creates an infinite loop of task creation.
- **Impact**: A single malformed cron expression or timezone misconfiguration causes unbounded task creation at 1 task per 60 seconds, indefinitely. This is a denial-of-service amplification vector: one bad schedule input produces infinite resource consumption. OWASP A04 (Insecure Design).
- **Category**: BLOCKING - New code in this PR.
- **Fix**: On `getNextRunTime` failure, pause the schedule and clear `nextRunAt`:
```typescript
if (nextResult.ok) {
  newNextRunAt = nextResult.value;
} else {
  this.logger.error('Failed to calculate next run, pausing schedule', nextResult.error);
  newStatus = ScheduleStatus.PAUSED;
  // nextRunAt must be explicitly cleared to stop retrigger loop
}

// Change the update spread to always include nextRunAt:
const updates: Partial<Schedule> = {
  runCount: newRunCount,
  lastRunAt: triggeredAt,
  nextRunAt: newNextRunAt,  // Always set, even if undefined
  ...(newStatus !== undefined ? { status: newStatus } : {}),
};
```

---

### MEDIUM

**M1: No rate limiting on schedule creation** - `/Users/dean/Sandbox/delegate/src/adapters/mcp-adapter.ts:821-961`
**Confidence: HIGH** (Unchallenged)

- **Problem**: The `handleScheduleTask` endpoint has no limit on the number of schedules a user can create. An attacker could create thousands of cron schedules, each of which would be checked every 60 seconds by the executor's tick loop, causing unbounded database queries and memory consumption.
- **Impact**: OWASP A04 (Insecure Design) - Resource exhaustion via schedule flooding. The `findDue` query would return increasingly large result sets, and each schedule's task would be delegated. The comment at line 147-149 mentions "DoS protection handled at resource level" for task delegation, but schedule creation itself is not rate-limited.
- **Category**: BLOCKING - New code in this PR.
- **Fix**: Add a schedule count check before creation:
```typescript
// In handleScheduleTask, before saving:
const countResult = await this.scheduleRepository.count();
if (countResult.ok && countResult.value >= MAX_SCHEDULES) {
  return {
    content: [{ type: 'text', text: `Maximum schedule limit (${MAX_SCHEDULES}) reached` }],
    isError: true,
  };
}
```

---

**M2: Concurrent execution prevention uses in-memory Map, not persisted** - `/Users/dean/Sandbox/delegate/src/services/schedule-executor.ts:58`
**Confidence: MEDIUM** (Challenged by Database reviewer as LOW design debt; I partially accepted, maintaining MEDIUM because duplicate execution of non-idempotent tasks is a tangible consequence)

- **Problem**: The `runningSchedules` Map that prevents concurrent execution of the same schedule is entirely in-memory. If the process restarts, all running state is lost. A schedule that had a task in progress will have no record of it and could trigger a duplicate execution.
- **Impact**: After a process restart, in-flight scheduled tasks could be duplicated. This is a design gap rather than a direct exploit, but the consequence is real: non-idempotent tasks (creating PRs, sending messages, modifying files) would execute twice. OWASP A04 (Insecure Design).
- **Debate note**: Database reviewer argued this is LOW design debt and suggested a better startup-time fix: query `schedule_executions WHERE status = 'triggered'` and cross-reference with task status. This is a more practical approach than the per-trigger check originally suggested.
- **Category**: BLOCKING (reduced severity) - New code in this PR.
- **Fix**: On startup, populate `runningSchedules` from `schedule_executions` with `status = 'triggered'` cross-referenced against tasks still in RUNNING state. At minimum, document this limitation.

---

**M3: `ScheduleUpdatedEvent` accepts `Partial<Schedule>` - unrestricted field updates** - `/Users/dean/Sandbox/delegate/src/services/handlers/schedule-handler.ts:475-491`
**Confidence: HIGH** (Reinforced by TypeScript reviewer's finding that `ScheduleUpdate` type exists but is unused; Architecture reviewer noted same concern about unrestricted updates)

- **Problem**: The `handleScheduleUpdated` event handler passes `update` directly to `this.scheduleRepo.update()` without validating which fields are being updated. The event type `ScheduleUpdatedEvent` carries `update: Partial<Schedule>`, which means any field on Schedule can be modified, including `id`, `createdAt`, `runCount`, and `taskTemplate`. The project defines `ScheduleUpdate` type (domain.ts:302) that restricts updateable fields, but it is never used.
- **Impact**: If an attacker can emit a `ScheduleUpdated` event (e.g., via another MCP tool or compromised component), they could modify the task template to execute arbitrary prompts, change the schedule status to bypass cancellation, or reset the runCount to avoid maxRuns limits.
- **Category**: BLOCKING - New code in this PR.
- **Fix**: Use the existing `ScheduleUpdate` type instead of `Partial<Schedule>` in both the event definition and the repository interface. This enforces the field whitelist at the type level:
```typescript
// In events.ts:
export interface ScheduleUpdatedEvent extends BaseEvent {
  type: 'ScheduleUpdated';
  scheduleId: ScheduleId;
  update: ScheduleUpdate;  // was: Partial<Schedule>
}

// In interfaces.ts:
update(id: ScheduleId, update: ScheduleUpdate): Promise<Result<void>>;
```

---

**M4: `toMissedRunPolicy` and `toScheduleStatus` silently default on unknown values** - `/Users/dean/Sandbox/delegate/src/implementations/schedule-repository.ts:449-479`
**Confidence: HIGH** (Independently flagged by Security, Database, TypeScript, and Quality reviewers -- 4/8 reviewers)

- **Problem**: Both conversion methods have a `default` case that silently returns `MissedRunPolicy.SKIP` or `ScheduleStatus.ACTIVE` for unrecognized values. Given the database has CHECK constraints that should prevent invalid values, hitting the default case indicates data corruption or a code/schema mismatch. Silently defaulting to ACTIVE is dangerous because it would re-activate a schedule that should be in a different state.
- **Impact**: A corrupted or tampered status value would silently revert to ACTIVE, potentially re-triggering a schedule that was cancelled or expired. This is a defense-in-depth concern (OWASP A08 - Data Integrity Failures).
- **Category**: BLOCKING - New code in this PR.
- **Fix**: Throw on unknown values (the Zod schema at line 398 validates enum values before these methods are called, so reaching the default indicates a bug, not user input):
```typescript
private toScheduleStatus(value: string): ScheduleStatus {
  switch (value) {
    case 'active': return ScheduleStatus.ACTIVE;
    case 'paused': return ScheduleStatus.PAUSED;
    case 'completed': return ScheduleStatus.COMPLETED;
    case 'cancelled': return ScheduleStatus.CANCELLED;
    case 'expired': return ScheduleStatus.EXPIRED;
    default:
      throw new Error(`Unknown schedule status: ${value} - possible data corruption`);
  }
}
```

---

## Cross-Reviewer Security Positions

### Defended Against Challenges

**Performance reviewer Finding #4 (Zod validation on every row read)**: The performance reviewer suggests removing Zod validation from `rowToSchedule` on the `findDue` hot path. I **strongly disagree** and defended this during debate. Rationale:
1. The database is a system boundary. SQLite files are plain files on disk -- corruption, manual editing, and concurrent access bugs are real threats.
2. The CPU cost of Zod parsing ~10 objects every 60 seconds is microseconds, not milliseconds. This is a 60-second polling interval, not a tight loop.
3. The project's own CLAUDE.md mandates "Validate at boundaries" and "Parse, don't validate (Zod schemas)."
4. Removing boundary validation to save negligible CPU is a net negative for security.

### Endorsed Findings From Other Reviewers (Security Relevance)

| Finding | Reviewer | Security Impact |
|---------|----------|----------------|
| Dual-write in MCPAdapter (save then emit) | Architecture | Crash window leaves schedule in DB without `nextRunAt`, causing undefined executor behavior |
| TOCTOU race in `update()` | Database, Architecture, Performance | Two ticks can process same schedule concurrently, both with stale data |
| No executor shutdown during graceful shutdown | Quality | Timer ticks fire during shutdown, racing with closed database/workers |
| Event subscription leak in ScheduleExecutor | Performance | Repeated stop/start cycles accumulate orphaned handlers, hitting EventBus limits |

---

## Issues in Code You Touched (Should Fix)

### MEDIUM

**SF1: `handleScheduleQuery` uses unsafe type assertions to access EventBus internals** - `/Users/dean/Sandbox/delegate/src/services/handlers/schedule-handler.ts:503-556`
**Confidence: HIGH** (Independently flagged by Architecture, TypeScript, and Quality reviewers)

- **Problem**: The query handler casts `this.eventBus` to inline type assertions like `(this.eventBus as { respond?: ... }).respond?.()` and `(this.eventBus as { respondError?: ... }).respondError?.()`. This bypasses TypeScript's type system and assumes the EventBus implementation has `respond`/`respondError` methods not declared in the interface.
- **Impact**: Circumvents the type system and could hide issues where query responses are silently dropped. If a different EventBus implementation is used, these calls silently no-op.
- **Category**: Should Fix - same module, adjacent code.
- **Fix**: Add `respond` and `respondError` to the EventBus interface, or use a proper request-response pattern.

---

## Pre-existing Issues (Not Blocking)

### MEDIUM

**PE1: MCP tool handler uses `z.any()` for arguments** - `/Users/dean/Sandbox/delegate/src/adapters/mcp-adapter.ts:141`
**Confidence: HIGH**

- **Problem**: The top-level MCP request handler schema uses `arguments: z.any()` which allows any structure through before per-tool validation.
- **Impact**: Low risk since per-tool schemas catch issues, but `z.any()` is a code smell that weakens defense in depth.

---

**PE2: Error messages may leak internal details** - Various locations
**Confidence: MEDIUM**

- **Problem**: Error messages in several handlers include internal details like file paths, database error messages, and cron parsing error strings.
- **Impact**: Information disclosure (OWASP A05). Minor in an MCP server context where the consumer is another AI, but still not best practice.

---

## Summary

| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 3 | 3 | 0 |
| Should Fix | 0 | 0 | 1 | 0 |
| Pre-existing | 0 | 0 | 2 | 0 |

### Confidence Summary

| Finding | Confidence | Basis |
|---------|------------|-------|
| H1: Path traversal in handleScheduleTask | HIGH | Unchallenged; clear parity gap with handleDelegateTask |
| H2: Unsafe task_template deserialization | HIGH | Reinforced by TypeScript + Database reviewers |
| H3: Infinite retrigger DoS amplification | HIGH | 4 reviewers endorsed (Quality origin, Security/Database/Architecture agreed) |
| M1: No rate limiting on schedule creation | HIGH | Unchallenged |
| M2: In-memory concurrent execution guard | MEDIUM | Challenged by Database reviewer; downgraded from hard security to design gap with tangible consequences |
| M3: Unrestricted Partial<Schedule> updates | HIGH | Reinforced by TypeScript reviewer's ScheduleUpdate type finding |
| M4: Silent enum defaults to ACTIVE/SKIP | HIGH | 4 independent reviewers flagged same issue |

**Security Score**: 4/10 (adjusted down from initial 5/10 after H3 was added from cross-review)

**Recommendation**: **CHANGES_REQUESTED**

The scheduling feature introduces three HIGH-severity security issues and three MEDIUM-severity issues, all in newly added code. The most dangerous findings are:

1. **H1 (Path traversal)**: Direct exploitability -- scheduled tasks bypass the path validation that all other tasks go through.
2. **H3 (Infinite retrigger)**: A single bad cron expression causes unbounded task creation at 1 task/60s forever. This is a DoS amplification vector with no self-limiting behavior.
3. **H2 (Unsafe deserialization)**: The `task_template` JSON is deserialized without schema validation, inconsistent with the project's "parse, don't validate" principle applied everywhere else.

All three HIGH findings are straightforward to fix and should be addressed before merge.
