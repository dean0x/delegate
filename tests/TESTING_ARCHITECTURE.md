# Backbeat Testing Architecture Documentation

## Overview

This document provides a comprehensive overview of Backbeat's testing architecture, patterns, and best practices. The test suite validates the event-driven task delegation system through multiple testing layers.

## Testing Philosophy

### Core Principles

1. **Test Behavior, Not Implementation** - Focus on what the system does, not how
2. **Event-Driven Testing** - Validate event flows and handler interactions
3. **Result Type Safety** - All tests use Result types for error handling
4. **Isolation First** - Each test runs independently with clean state
5. **Real Over Mocked** - Prefer integration tests with real components

### Test Pyramid

```
         E2E Tests (10%)
        /          \
    Integration (30%) \
   /                   \
  Unit Tests (60%)      \
 /_____________________ \
```

## Test Structure

### Directory Organization

```
tests/
├── unit/                           # Isolated component tests
│   ├── Core Utilities
│   │   ├── pipe.test.ts           # Functional composition (54 tests)
│   │   ├── result.test.ts         # Result type patterns (47 tests)
│   │   └── errors.test.ts         # Error handling
│   │
│   ├── Event System
│   │   ├── event-bus.test.ts      # EventBus implementation (33 tests)
│   │   └── event-handlers.test.ts # Event handler logic
│   │
│   ├── Services
│   │   ├── task-manager.test.ts   # Task management service
│   │   ├── autoscaling-manager.test.ts # Autoscaling logic
│   │   ├── recovery-manager.test.ts    # Recovery mechanisms
│   │   └── worker-pool.test.ts    # Worker pool management
│   │
│   ├── Infrastructure
│   │   ├── task-repository.test.ts     # Database operations
│   │   ├── output-capture.test.ts      # Output buffering
│   │   ├── output-repository.test.ts   # Output persistence
│   │   └── database.test.ts       # SQLite interactions
│   │
│   ├── MCP Interface
│   │   └── mcp-adapter.test.ts    # MCP protocol adapter
│   │
│   └── Advanced Testing
│       ├── property-based.test.ts # Property-based testing
│       ├── error-scenarios.test.ts # Error edge cases
│       └── types.test.ts          # Type safety validation
│
├── integration/                    # Component interaction tests
│   ├── event-flow.test.ts        # End-to-end event flows
│   ├── task-delegation.test.ts   # Task delegation workflows
│   ├── task-persistence.test.ts  # Database integration
│   ├── worker-management.test.ts # Worker lifecycle
│   └── recovery.test.ts          # System recovery scenarios
│
├── e2e/                           # Full system tests
│   ├── cli-commands.test.ts      # CLI interface testing
│   ├── run-simple.test.ts   # Simple delegation flows
│   ├── mcp-server.test.ts        # MCP server integration
│   ├── mcp-server-comprehensive.test.ts # Complete MCP testing
│   └── claude-code-integration.test.ts  # Real Claude Code tests
│
├── stress/                        # Load and performance tests
│   └── concurrent-5.test.ts      # Concurrent worker stress
│
├── fixtures/                      # Test data and mocks
│   ├── mock-data.ts              # Reusable test data
│   └── test-helpers.ts           # Common test utilities
│
└── manual/                        # Human-driven tests
    └── prompt-based-tests.md     # Claude Code manual testing
```

## Testing Patterns

### 1. Event-Driven Testing Pattern

```typescript
describe('Event-driven workflow', () => {
  let eventBus: EventBus;
  let handler: EventHandler;

  beforeEach(() => {
    eventBus = new InMemoryEventBus();
    handler = new TaskHandler(eventBus);
  });

  it('should emit events on task completion', async () => {
    const events: Event[] = [];
    eventBus.on('TaskCompleted', (event) => events.push(event));

    await handler.processTask(mockTask);

    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('TaskCompleted');
  });
});
```

### 2. Result Type Testing Pattern

```typescript
describe('Service with Result types', () => {
  it('should return Ok on success', () => {
    const result = service.performOperation(validInput);

    expect(isOk(result)).toBe(true);
    expect(unwrap(result)).toEqual(expectedOutput);
  });

  it('should return Err on failure', () => {
    const result = service.performOperation(invalidInput);

    expect(isErr(result)).toBe(true);
    expect(unwrapErr(result).message).toContain('validation failed');
  });
});
```

### 3. Pipe Composition Testing

```typescript
describe('Pipeline operations', () => {
  it('should compose operations with pipe', () => {
    const pipeline = pipe(
      validateInput,
      transformData,
      persistResult,
      emitEvent
    );

    const result = pipeline(rawInput);
    expect(isOk(result)).toBe(true);
  });
});
```

### 4. Mock Isolation Pattern

```typescript
describe('Isolated component testing', () => {
  let mockDependency: MockedObject<Dependency>;

  beforeEach(() => {
    mockDependency = {
      method: vi.fn().mockReturnValue(ok('mocked'))
    };
  });

  it('should interact with dependency', () => {
    const component = new Component(mockDependency);
    component.execute();

    expect(mockDependency.method).toHaveBeenCalledWith(
      expect.objectContaining({ /* expected args */ })
    );
  });
});
```

## Test Categories

### Unit Tests (60% of suite)

**Purpose**: Test individual components in isolation

**Characteristics**:
- Fast execution (< 100ms per test)
- Heavy mocking of dependencies
- Focus on single responsibility
- High code coverage targets (> 80%)

**Key Files**:
- `pipe.test.ts` - 54 tests for functional composition
- `result.test.ts` - 47 tests for Result type patterns
- `event-bus.test.ts` - 33 tests for event system

**Testing Approach**:
```typescript
// Test single units with mocked dependencies
const mockRepo = { save: vi.fn().mockReturnValue(ok(saved)) };
const service = new TaskService(mockRepo);
const result = service.createTask(input);
expect(isOk(result)).toBe(true);
```

### Integration Tests (30% of suite)

**Purpose**: Validate component interactions

**Characteristics**:
- Medium execution time (< 5s per test)
- Minimal mocking (only I/O boundaries)
- Tests complete workflows
- Focus on event flows

**Key Files**:
- `event-flow.test.ts` - Event propagation testing
- `task-delegation.test.ts` - Complete delegation flows
- `recovery.test.ts` - System recovery scenarios

**Testing Approach**:
```typescript
// Test real components together
const eventBus = new InMemoryEventBus();
const repo = new SQLiteTaskRepository(':memory:');
const manager = new TaskManager(eventBus, repo);

await manager.delegateTask(task);
// Verify events were emitted and handled
```

### End-to-End Tests (10% of suite)

**Purpose**: Validate complete system behavior

**Characteristics**:
- Slower execution (< 30s per test)
- No mocking - real implementations
- Tests via CLI interface
- Validates user workflows

**Key Files**:
- `cli-commands.test.ts` - CLI command testing
- `mcp-server.test.ts` - MCP protocol validation
- `claude-code-integration.test.ts` - Real Claude Code tests

**Testing Approach**:
```typescript
// Test through CLI interface
const { stdout, stderr } = await execCommand(
  'beat run "analyze codebase"'
);
expect(stdout).toContain('Task delegated successfully');
```

## Test Configuration

### Vitest Configuration

```typescript
// vitest.config.ts
export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    testTimeout: 30000,
    hookTimeout: 30000,
    pool: 'forks',        // Better process isolation
    poolOptions: {
      forks: {
        maxForks: 2       // Prevent system overload
      }
    },
    sequence: {
      concurrent: false,  // Run stress tests sequentially
      shuffle: false
    }
  }
});
```

### Test Environment Setup

```typescript
// Common test setup
beforeEach(async () => {
  // Clean state
  process.env.TEST_MODE = 'true';
  process.env.DB_PATH = ':memory:';

  // Initialize test database
  await initTestDatabase();

  // Create isolated event bus
  testEventBus = new InMemoryEventBus();
});

afterEach(async () => {
  // Cleanup
  await cleanupTestArtifacts();
  vi.clearAllMocks();
});
```

## Common Testing Patterns

### 1. Testing Event Handlers

```typescript
describe('PersistenceHandler', () => {
  it('should persist task on TaskDelegated event', async () => {
    const handler = new PersistenceHandler(repo, eventBus);
    const task = createTestTask();

    eventBus.emit('TaskDelegated', { task });
    await waitForEvent(eventBus, 'TaskPersisted');

    const saved = await repo.getTask(task.id);
    expect(saved).toBeDefined();
  });
});
```

### 2. Testing Async Operations

```typescript
describe('Async operations', () => {
  it('should handle async workflows', async () => {
    const result = await pipeAsync(
      input,
      validateAsync,
      transformAsync,
      persistAsync
    );

    expect(isOk(result)).toBe(true);
  });
});
```

### 3. Testing Error Scenarios

```typescript
describe('Error handling', () => {
  it('should handle network failures gracefully', async () => {
    mockFetch.mockRejectedValue(new Error('Network error'));

    const result = await service.fetchData();

    expect(isErr(result)).toBe(true);
    expect(unwrapErr(result).message).toContain('Network error');
  });
});
```

### 4. Testing Resource Cleanup

```typescript
describe('Resource management', () => {
  it('should cleanup resources on failure', async () => {
    const resource = await acquireResource();

    try {
      await failingOperation(resource);
    } finally {
      expect(resource.isReleased()).toBe(true);
    }
  });
});
```

## Test Data Management

### Fixtures

```typescript
// tests/fixtures/mock-data.ts
export const createTestTask = (overrides?: Partial<Task>): Task => ({
  id: `test-${Date.now()}`,
  prompt: 'Test prompt',
  priority: 'P1',
  status: 'pending',
  createdAt: Date.now(),
  ...overrides
});

export const createTestWorker = (): Worker => ({
  id: `worker-${Date.now()}`,
  pid: process.pid,
  status: 'idle'
});
```

### Test Helpers

```typescript
// tests/fixtures/test-helpers.ts
export const waitForEvent = (
  eventBus: EventBus,
  eventType: string,
  timeout = 5000
): Promise<Event> => {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`Timeout waiting for ${eventType}`)),
      timeout
    );

    eventBus.once(eventType, (event) => {
      clearTimeout(timer);
      resolve(event);
    });
  });
};
```

## Performance Testing

### Stress Test Pattern

```typescript
describe('Concurrent operations stress test', () => {
  it('should handle 100 concurrent tasks', async () => {
    const tasks = Array.from({ length: 100 }, createTestTask);

    const startTime = Date.now();
    const results = await Promise.all(
      tasks.map(task => manager.delegateTask(task))
    );
    const duration = Date.now() - startTime;

    expect(results.every(isOk)).toBe(true);
    expect(duration).toBeLessThan(30000); // 30 seconds max
  });
});
```

### Memory Leak Detection

```typescript
describe('Memory management', () => {
  it('should not leak memory on repeated operations', async () => {
    const initialMemory = process.memoryUsage().heapUsed;

    for (let i = 0; i < 1000; i++) {
      await performOperation();
      if (i % 100 === 0) {
        global.gc?.(); // Force garbage collection if available
      }
    }

    const finalMemory = process.memoryUsage().heapUsed;
    const growth = finalMemory - initialMemory;

    expect(growth).toBeLessThan(50 * 1024 * 1024); // < 50MB growth
  });
});
```

## Test Coverage Goals

### Coverage Targets

- **Overall**: > 80% coverage
- **Core utilities** (pipe, result): > 95%
- **Event system**: > 90%
- **Services**: > 85%
- **Infrastructure**: > 80%
- **CLI interface**: > 70%

### Coverage Commands

```bash
# Run with coverage
npm run test:coverage

# Generate HTML report
npm run test:coverage -- --reporter=html

# Check coverage thresholds
npm run test:coverage -- --check-coverage
```

## CI/CD Integration

### GitHub Actions Workflow

```yaml
name: Test Suite
on: [push, pull_request]

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3
      - uses: actions/setup-node@v3
        with:
          node-version: '20'

      - run: npm ci
      - run: npm run build

      # Run tests in layers
      - run: npm test tests/unit/
      - run: npm test tests/integration/
      - run: npm test tests/e2e/

      # Coverage report
      - run: npm run test:coverage
      - uses: codecov/codecov-action@v3
```

## Debugging Tests

### Debug Commands

```bash
# Run with verbose output
npm test -- --reporter=verbose

# Run specific test file
npm test tests/unit/pipe.test.ts

# Run with pattern matching
npm test -- --grep "should handle concurrent"

# Debug with Node inspector
node --inspect-brk ./node_modules/.bin/vitest

# Set debug environment
DEBUG=backbeat:* npm test
```

### Common Debug Patterns

```typescript
// Add debug logging
it('should process task', async () => {
  console.log('Starting test with:', { taskId: task.id });

  const result = await manager.processTask(task);

  console.log('Result:', result);
  expect(isOk(result)).toBe(true);
});

// Use test.only for focused debugging
it.only('debug this specific test', () => {
  // Test implementation
});

// Add timeout for slow operations
it('should complete eventually', async () => {
  const result = await longRunningOperation();
  expect(result).toBeDefined();
}, 60000); // 60 second timeout
```

## Best Practices

### Do's

1. **Write descriptive test names** that explain the expected behavior
2. **Use beforeEach/afterEach** for consistent test setup/cleanup
3. **Test edge cases** including null, undefined, empty arrays
4. **Verify error messages** not just error occurrence
5. **Use test data factories** for consistent test objects
6. **Test both success and failure paths**
7. **Keep tests independent** - no shared state between tests
8. **Use meaningful assertions** with clear failure messages

### Don'ts

1. **Don't test implementation details** - focus on behavior
2. **Don't use real external services** in unit tests
3. **Don't ignore flaky tests** - fix or remove them
4. **Don't write tests after bugs** - write them first (TDD)
5. **Don't mock what you don't own** - wrap external APIs
6. **Don't use magic numbers** - use named constants
7. **Don't skip cleanup** - always restore state
8. **Don't couple tests** - each should run independently

## Test Maintenance

### Regular Tasks

1. **Weekly**: Review and fix flaky tests
2. **Monthly**: Update test dependencies
3. **Quarterly**: Review coverage reports and add missing tests
4. **Per Release**: Run full test suite including manual tests

### Test Refactoring Signs

- Tests taking > 30 seconds individually
- Frequent test failures unrelated to changes
- Complex setup requiring > 20 lines
- Tests requiring updates for unrelated changes
- Coverage dropping below thresholds

## Troubleshooting Guide

### Common Issues and Solutions

#### 1. Mock Setup Failures
**Problem**: `Cannot read property 'mockReturnValue' of undefined`
**Solution**: Ensure all mock properties are initialized before use

```typescript
const mock = {
  method: vi.fn(), // Initialize first
};
mock.method.mockReturnValue(value); // Then configure
```

#### 2. Event Timing Issues
**Problem**: Test fails waiting for events
**Solution**: Use proper event waiting utilities

```typescript
await waitForEvent(eventBus, 'TaskCompleted', 10000);
```

#### 3. Database Lock Errors
**Problem**: `SQLITE_BUSY: database is locked`
**Solution**: Use in-memory databases for tests

```typescript
const db = new Database(':memory:');
```

#### 4. Resource Cleanup Failures
**Problem**: Tests fail in CI but pass locally
**Solution**: Ensure proper cleanup in afterEach hooks

```typescript
afterEach(async () => {
  await pool?.shutdown();
  await db?.close();
  vi.clearAllMocks();
});
```

## Future Improvements

### Planned Enhancements

1. **Contract Testing** - Validate MCP protocol compliance
2. **Mutation Testing** - Ensure test quality with Stryker
3. **Visual Testing** - CLI output regression testing
4. **Performance Benchmarks** - Track performance over time
5. **Chaos Engineering** - Test failure scenarios systematically
6. **Test Parallelization** - Improve test execution speed
7. **AI-Assisted Testing** - Generate test cases with Claude

### Testing Roadmap

- **Q1 2024**: Achieve 90% code coverage
- **Q2 2024**: Implement contract testing for MCP
- **Q3 2024**: Add performance regression suite
- **Q4 2024**: Integrate chaos engineering tests

## Conclusion

Backbeat's testing architecture emphasizes:
- **Event-driven validation** matching the system architecture
- **Type-safe error handling** with Result types
- **Behavioral testing** over implementation details
- **Comprehensive coverage** across unit, integration, and E2E layers

The test suite ensures system reliability through rigorous validation of event flows, error scenarios, and real-world usage patterns.