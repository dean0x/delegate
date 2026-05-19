# Architecture Audit Report

**Branch**: fix/timing-based-test-waits
**Base**: main
**Date**: 2025-12-28 22:51
**PR**: #44

---

## Summary

This PR replaces timing-based test waits (`setTimeout`) with deterministic event-driven synchronization (`flushEventLoop()`). The approach is architecturally sound and improves test reliability.

### Changed Files

| File | Type |
|------|------|
| src/bootstrap.ts | Production |
| tests/fixtures/test-doubles.ts | Test utility |
| tests/utils/event-helpers.ts | Test utility (new) |
| tests/integration/event-flow.test.ts | Test |
| tests/integration/service-initialization.test.ts | Test |
| tests/integration/task-dependencies.test.ts | Test |
| tests/integration/worker-pool-management.test.ts | Test |
| tests/unit/core/domain.test.ts | Test |
| tests/unit/core/events/event-bus-request.test.ts | Test |
| tests/unit/core/result.test.ts | Test |
| tests/unit/implementations/dependency-repository.test.ts | Test |
| tests/unit/services/handlers/dependency-handler.test.ts | Test |
| tests/unit/services/handlers/worker-handler.test.ts | Test |

---

## Issues in Your Changes (Should Fix)

### 1. TestEventBus.removeListener() is broken

**File**: `/workspace/delegate/tests/fixtures/test-doubles.ts`
**Lines**: 264-270
**Severity**: MEDIUM

The `removeListener()` method cannot actually remove handlers that were subscribed via `once()` or any method that wraps the original handler.

**Problem:**
- `once()` at line 250 wraps the handler in `wrappedHandler`
- `removeListener()` tries to delete by reference to the original handler
- But `wrappedHandler !== handler`, so `handlers.delete(handler)` does nothing
- `waitForCondition()` in event-helpers.ts relies on this to cleanup on timeout

**Impact:** Memory leak - handlers accumulate in test runs.

**Current code:**
```typescript
removeListener(eventType: string, handler: (data: any) => void): void {
  const handlers = this.handlers.get(eventType);
  if (handlers) {
    // Note: This is a simplified implementation - in tests we typically
    // rely on dispose() for full cleanup rather than individual removal
    handlers.delete(handler as any);
  }
}
```

**Suggested Fix:** Track handler-to-subscriptionId mapping:
```typescript
private handlerToSubscriptionId = new Map<Function, string>();

once(eventType: string, handler: (data: any) => void): string {
  let subscriptionId: string | undefined;
  const wrappedHandler = async (event: any) => {
    if (subscriptionId) {
      this.unsubscribe(subscriptionId);
    }
    handler(event);
  };
  const result = this.subscribe(eventType, wrappedHandler);
  subscriptionId = result.ok ? result.value : undefined;
  if (subscriptionId) {
    this.handlerToSubscriptionId.set(handler, subscriptionId);
  }
  return subscriptionId ?? '';
}

removeListener(eventType: string, handler: (data: any) => void): void {
  const subscriptionId = this.handlerToSubscriptionId.get(handler);
  if (subscriptionId) {
    this.unsubscribe(subscriptionId);
    this.handlerToSubscriptionId.delete(handler);
  }
}
```

---

### 2. TestEventBus.waitFor() leaks on timeout

**File**: `/workspace/delegate/tests/fixtures/test-doubles.ts`
**Lines**: 219-232
**Severity**: MEDIUM

When `waitFor()` times out and rejects, the subscribed handler is never removed from the handlers Map.

**Current code:**
```typescript
return new Promise((resolve, reject) => {
  const timer = setTimeout(() => {
    reject(new Error(`Timeout waiting for '${eventType}' after ${timeout}ms`));
  }, timeout);

  const handler = async (event: any) => {
    if (filter(event)) {
      clearTimeout(timer);
      resolve(event);
    }
  };

  this.subscribe(eventType, handler);  // Never unsubscribed on timeout!
});
```

**Suggested Fix:**
```typescript
return new Promise((resolve, reject) => {
  const result = this.subscribe(eventType, handler);
  const subscriptionId = result.ok ? result.value : undefined;

  const timer = setTimeout(() => {
    if (subscriptionId) this.unsubscribe(subscriptionId);
    reject(new Error(`Timeout waiting for '${eventType}' after ${timeout}ms`));
  }, timeout);

  const handler = async (event: any) => {
    if (filter(event)) {
      clearTimeout(timer);
      if (subscriptionId) this.unsubscribe(subscriptionId);
      resolve(event);
    }
  };
});
```

---

### 3. TestEventBus.once() never unsubscribes

**File**: `/workspace/delegate/tests/fixtures/test-doubles.ts`
**Lines**: 250-258
**Severity**: MEDIUM

Handler wrapper is subscribed but never removed even after calling - just sets `called=true` flag but handler stays in Map.

**Current code:**
```typescript
once(eventType: string, handler: (data: any) => void): void {
  let called = false;
  const wrappedHandler = async (event: any) => {
    if (!called) {
      called = true;
      handler(event);  // Never unsubscribes wrappedHandler!
    }
  };
  this.subscribe(eventType, wrappedHandler);
}
```

**Impact:** Every `once()` call adds a handler that is never removed.

---

## Good Patterns in Your Changes

### 1. Bootstrap.ts resourceMonitor DI option

**File**: `/workspace/delegate/src/bootstrap.ts`
**Lines**: 22-23, 224-228
**Quality**: GOOD

Follows established pattern for ProcessSpawner injection. Clean dependency injection that enables testing without real resource monitoring.

```typescript
export interface BootstrapOptions {
  processSpawner?: ProcessSpawner;
  resourceMonitor?: ResourceMonitor;  // New - follows same pattern
  skipResourceMonitoring?: boolean;
}
```

### 2. flushEventLoop() utility

**File**: `/workspace/delegate/tests/utils/event-helpers.ts`
**Lines**: 124-126
**Quality**: GOOD

Simple, deterministic replacement for `setTimeout` waits. Uses `setImmediate` which processes I/O callbacks - appropriate for event-driven tests.

```typescript
export function flushEventLoop(): Promise<void> {
  return new Promise(resolve => setImmediate(resolve));
}
```

### 3. Test file changes

All test files correctly replace `setTimeout(resolve, N)` with `flushEventLoop()`:
- Removes non-deterministic timing
- Tests are more reliable
- Execution is faster (no artificial delays)

---

## Pre-existing Issues (Not Blocking)

None identified in this review scope.

---

## Summary

| Category | Count |
|----------|-------|
| CRITICAL | 0 |
| HIGH | 0 |
| MEDIUM | 3 |
| LOW | 0 |

**Your Changes:**
- MEDIUM: 3 (memory leaks in test utilities)

**Code You Touched:**
- No additional issues

**Pre-existing:**
- No issues identified

**Architecture Score**: 7/10

The core approach is correct:
- Replacing timeouts with event-based sync is the right pattern
- DI for resourceMonitor follows established patterns
- Test utility implementations have memory leaks but are contained to test code

**Merge Recommendation**: APPROVED WITH CONDITIONS

The memory leaks are in test-only code and don't affect production. They will cleanup when the test process exits. However, for long test runs or test watch mode, these leaks could accumulate.

**Conditions:**
1. Consider fixing the memory leaks in a follow-up PR
2. Or accept the leaks as acceptable technical debt for test utilities

---

## PR Comments

- Created: 1 (summary comment with all issues)
- Skipped: 0 (line-level comments not supported via gh CLI for this PR)

---

*Generated by Claude Code Architecture Review*
