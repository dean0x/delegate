# Backbeat Test Standards and Guidelines

**Version**: 2.0.0
**Last Updated**: 2025-01-26
**Quality Target**: 85/100 minimum

## 🎯 Test Quality Requirements

### MANDATORY for ALL Tests

1. **NO FAKE TESTS** - Never test mock implementations
2. **USE TEST INFRASTRUCTURE** - Always use factories and test doubles
3. **NO MAGIC NUMBERS** - Use constants from `/tests/constants.ts`
4. **3-5 ASSERTIONS PER TEST** - Comprehensive validation
5. **AAA PATTERN** - Arrange, Act, Assert structure
6. **BEHAVIORAL TESTING** - Test WHAT, not HOW
7. **ERROR CASES REQUIRED** - Every component needs error tests

### Test Quality Metrics

| Metric | Target | Current |
|--------|--------|---------|
| Coverage (lines) | >90% | ~70% |
| Coverage (branches) | >80% | ~45% |
| Assertion Density | 3-5 per test | 3.1 |
| Mock Usage | <30% of tests | ~70% |
| Test Execution Time | <30 seconds | ~23s |

## 📁 Test Infrastructure

### Use These INSTEAD of Creating Your Own

#### Test Factories (`/tests/fixtures/factories.ts`)

```typescript
import { TaskFactory, WorkerFactory, ConfigFactory } from '../fixtures/factories';

// ✅ GOOD - Use factories
const task = new TaskFactory()
  .withPrompt('echo hello')
  .withPriority('P0')
  .running('worker-123')
  .build();

// ❌ BAD - Don't create inline
const task = {
  id: 'task-123',
  prompt: 'echo hello',
  // ... manual object creation
};
```

#### Test Doubles (`/tests/fixtures/test-doubles.ts`)

```typescript
import { TestEventBus, TestLogger, TestRepository } from '../fixtures/test-doubles';

// ✅ GOOD - Use test doubles with behavior
const eventBus = new TestEventBus();
await eventBus.emit('TaskDelegated', task);
expect(eventBus.hasEmitted('TaskDelegated')).toBe(true);

// ❌ BAD - Don't use mocks
const eventBus = {
  emit: vi.fn().mockResolvedValue({ ok: true })
};
```

#### Constants (`/tests/constants.ts`)

```typescript
import { TIMEOUTS, BUFFER_SIZES, ERROR_MESSAGES } from '../constants';

// ✅ GOOD - Use semantic constants
await waitFor(TIMEOUTS.SHORT);
const buffer = Buffer.alloc(BUFFER_SIZES.MEDIUM);

// ❌ BAD - Don't use magic numbers
await waitFor(100);  // What is 100?
const buffer = Buffer.alloc(1048576);  // What size is this?
```

## ✅ Test Patterns (GOOD)

### 1. Behavioral Test Pattern

```typescript
describe('TaskManager', () => {
  it('should delegate task and track its lifecycle', async () => {
    // Arrange - Use factories and test doubles
    const taskManager = new TaskManagerService(eventBus, repository, logger, config);
    const request = new TaskFactory()
      .withPrompt('analyze codebase')
      .withPriority('P0')
      .build();

    // Act - Test the behavior
    const result = await taskManager.delegate(request);

    // Assert - Multiple comprehensive assertions
    expect(result.ok).toBe(true);
    expect(result.value.status).toBe('queued');
    expect(eventBus.hasEmitted('TaskDelegated')).toBe(true);
    expect(repository.hasTask(result.value.id)).toBe(true);
  });
});
```

### 2. Error Handling Pattern

```typescript
describe('Error Scenarios', () => {
  it('should handle database connection failure gracefully', async () => {
    // Arrange - Set up failure condition
    const repository = new TestRepository();
    repository.setSaveError(new Error('Connection lost'));

    // Act - Attempt operation
    const result = await taskManager.save(task);

    // Assert - Verify graceful failure
    expect(result.ok).toBe(false);
    expect(result.error.message).toContain('Connection lost');
    expect(logger.hasLog('error', 'Failed to save task')).toBe(true);
    expect(eventBus.hasEmitted('TaskSaveFailed')).toBe(true);
  });
});
```

### 3. Concurrency Test Pattern

```typescript
describe('Concurrent Operations', () => {
  it('should handle multiple simultaneous task delegations', async () => {
    // Arrange
    const tasks = new TaskFactory().buildMany(5);

    // Act - Concurrent operations
    const results = await Promise.allSettled(
      tasks.map(task => taskManager.delegate(task))
    );

    // Assert - All should complete
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(5);
    expect(repository.getTaskCount()).toBe(5);
    expect(eventBus.getEventCount('TaskDelegated')).toBe(5);
  });
});
```

### 4. State Transition Pattern

```typescript
describe('Task State Transitions', () => {
  it('should transition task through complete lifecycle', async () => {
    // Arrange
    const task = new TaskFactory().build();
    const states: string[] = [];

    eventBus.subscribeAll(async (event) => {
      if (event.type.startsWith('Task')) {
        states.push(event.type);
      }
    });

    // Act - Move through states
    await taskManager.delegate(task);
    await taskManager.start(task.id);
    await taskManager.complete(task.id, 0);

    // Assert - Verify state progression
    expect(states).toEqual([
      'TaskDelegated',
      'TaskQueued',
      'TaskStarted',
      'TaskCompleted'
    ]);
  });
});
```

## ❌ Test Anti-Patterns (BAD)

### 1. Testing Mock Behavior (NEVER DO THIS)

```typescript
// ❌ BAD - Testing the mock, not the code
it('should call repository save', async () => {
  const mockSave = vi.fn().mockResolvedValue({ ok: true });
  repository.save = mockSave;

  await taskManager.delegate(task);

  expect(mockSave).toHaveBeenCalledWith(task);  // Useless!
});
```

### 2. Single Assertion Tests (INSUFFICIENT)

```typescript
// ❌ BAD - Only one assertion
it('should create task', () => {
  const task = createTask({ prompt: 'test' });
  expect(task).toBeDefined();  // That's it?
});
```

### 3. Magic Numbers and Strings

```typescript
// ❌ BAD - Magic values everywhere
it('should timeout after delay', async () => {
  await sleep(5000);  // What's 5000?
  expect(result.error).toBe('Operation timeout exceeded');  // Magic string
});
```

### 4. Console Spying

```typescript
// ❌ BAD - Spying on global objects
it('should log message', () => {
  const spy = vi.spyOn(console, 'log');
  logger.info('test');
  expect(spy).toHaveBeenCalled();
});

// ✅ GOOD - Use TestLogger instead
it('should log message', () => {
  const logger = new TestLogger();
  logger.info('test');
  expect(logger.hasLog('info', 'test')).toBe(true);
});
```

### 5. Implementation Testing

```typescript
// ❌ BAD - Testing HOW not WHAT
it('should set internal _state property', () => {
  taskManager.delegate(task);
  expect(taskManager._internalState).toBe('processing');  // Private!
});
```

## 📝 Test Organization

### File Structure

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { TaskFactory, WorkerFactory } from '../fixtures/factories';
import { TestEventBus, TestRepository } from '../fixtures/test-doubles';
import { TIMEOUTS, ERROR_MESSAGES } from '../constants';

describe('ComponentName - Behavioral Description', () => {
  // Setup
  let component: Component;
  let dependencies: Dependencies;

  beforeEach(() => {
    // Initialize with test doubles
  });

  afterEach(() => {
    // Cleanup
  });

  describe('Feature Group', () => {
    it('should perform expected behavior when condition', () => {
      // AAA Pattern
    });

    it('should handle error case gracefully', () => {
      // Error scenario
    });
  });

  describe('Error Handling', () => {
    // REQUIRED section for all components
  });
});
```

### Test Naming Convention

```typescript
// ✅ GOOD - Descriptive behavioral names
it('should delegate task to available worker when resources permit')
it('should retry task with exponential backoff on transient failure')
it('should emit TaskFailed event when max retries exceeded')

// ❌ BAD - Vague or implementation-focused
it('works')
it('test delegate')
it('calls emit method')
```

## 🧪 Required Test Categories

### For EVERY Component

1. **Happy Path** - Normal successful operations
2. **Error Cases** - All failure modes
3. **Edge Cases** - Boundary conditions
4. **Concurrent Operations** - Race conditions
5. **Resource Cleanup** - Proper teardown

### Example Test Suite Structure

```typescript
describe('TaskQueue', () => {
  describe('Normal Operations', () => {
    it('should enqueue tasks in priority order');
    it('should dequeue highest priority task first');
    it('should maintain FIFO within same priority');
  });

  describe('Error Handling', () => {
    it('should reject enqueue when queue is full');
    it('should return empty result when dequeuing empty queue');
    it('should handle concurrent enqueue/dequeue operations');
  });

  describe('Edge Cases', () => {
    it('should handle maximum queue size');
    it('should handle single item queue');
    it('should handle rapid enqueue/dequeue cycling');
  });

  describe('Resource Management', () => {
    it('should not leak memory with large queues');
    it('should clean up on disposal');
  });
});
```

## 🚀 Performance Test Requirements

```typescript
import { bench, describe } from 'vitest';
import { PERFORMANCE_THRESHOLDS } from '../constants';

describe('Performance Benchmarks', () => {
  bench('task throughput', async () => {
    const tasks = new TaskFactory().buildMany(100);
    const start = Date.now();

    for (const task of tasks) {
      await taskManager.delegate(task);
    }

    const throughput = 100 / ((Date.now() - start) / 1000);
    expect(throughput).toBeGreaterThan(PERFORMANCE_THRESHOLDS.TASK_THROUGHPUT_MIN);
  });
});
```

## 🔒 Security Test Requirements

```typescript
describe('Security', () => {
  it('should prevent SQL injection in task queries', async () => {
    const maliciousInput = "'; DROP TABLE tasks; --";
    const task = new TaskFactory()
      .withPrompt(maliciousInput)
      .build();

    const result = await repository.save(task);

    expect(result.ok).toBe(true);
    expect(await repository.findAll()).toBeDefined();  // Table still exists
  });

  it('should validate and sanitize user input', () => {
    const invalidInput = '<script>alert("xss")</script>';
    const result = validateTaskPrompt(invalidInput);

    expect(result.ok).toBe(false);
    expect(result.error.code).toBe('INVALID_INPUT');
  });
});
```

## 📊 Coverage Requirements

### Minimum Coverage by Component Type

| Component Type | Line Coverage | Branch Coverage |
|---------------|---------------|-----------------|
| Core Domain | 95% | 90% |
| Services | 90% | 85% |
| Implementations | 85% | 80% |
| Utilities | 90% | 85% |
| Error Handlers | 100% | 100% |

### Excluded from Coverage

- Test files themselves
- Type definitions
- Interfaces
- Constants
- Index files

## 🔄 Migration Guide

### Converting Old Tests to New Standards

#### Step 1: Replace Inline Objects with Factories

```typescript
// OLD
const task = {
  id: 'task-123',
  prompt: 'test',
  status: 'pending'
};

// NEW
const task = new TaskFactory()
  .withId('task-123')
  .withPrompt('test')
  .build();
```

#### Step 2: Replace Mocks with Test Doubles

```typescript
// OLD
const mockEmit = vi.fn();
const eventBus = { emit: mockEmit };

// NEW
const eventBus = new TestEventBus();
```

#### Step 3: Replace Magic Numbers

```typescript
// OLD
await sleep(1000);

// NEW
await sleep(TIMEOUTS.MEDIUM);
```

#### Step 4: Add Missing Assertions

```typescript
// OLD
expect(result.ok).toBe(true);

// NEW
expect(result.ok).toBe(true);
expect(result.value).toBeDefined();
expect(result.value.status).toBe('queued');
expect(eventBus.hasEmitted('TaskQueued')).toBe(true);
```

## 🚦 Pre-commit Checklist

Before committing test changes:

- [ ] Uses test factories instead of inline objects
- [ ] Uses test doubles instead of mocks
- [ ] No magic numbers (uses constants)
- [ ] 3-5 assertions per test
- [ ] Follows AAA pattern
- [ ] Includes error cases
- [ ] No console spying
- [ ] Tests behavior, not implementation
- [ ] Descriptive test names
- [ ] Proper cleanup in afterEach

## 📚 Resources

- [Test Factories](./fixtures/factories.ts) - Data builders
- [Test Doubles](./fixtures/test-doubles.ts) - Mock implementations
- [Constants](./constants.ts) - Test configuration
- [Audit Report](../.docs/test-audits/audit-2025-01-26.md) - Quality baseline
- [Improvement Summary](../.docs/test-audits/improvement-summary-2025-01-26.md) - Progress tracking