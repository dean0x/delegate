# Integration Tests

This directory contains integration tests that verify component interactions and service coordination within Backbeat.

## Overview

Integration tests bridge the gap between unit tests (isolated components) and E2E tests (full system via CLI). They test how services work together without spawning external processes or using the CLI.

## Test Files

### 1. `event-flow.test.ts`
Tests the event-driven architecture and coordination between services:
- Event bus message flow
- Task delegation through events
- Request-response patterns with timeout
- Event handler registration and cleanup
- Concurrent event handling

### 2. `task-persistence.test.ts`
Tests database operations and recovery mechanisms:
- Task persistence across restarts
- Database transaction rollback
- Queue persistence and priority ordering
- Concurrent database operations
- Recovery with partial data
- WAL mode and integrity

### 3. `worker-pool-management.test.ts`
Tests worker lifecycle and resource management:
- Worker pool spawn/terminate lifecycle
- Autoscaling with resource monitoring
- Output capture and streaming
- Worker retry with exponential backoff
- Resource limits enforcement
- Concurrent worker management

### 4. `service-initialization.test.ts`
Tests service bootstrap and configuration:
- Dependency injection container
- Configuration loading and validation
- Event handler registration during bootstrap
- Service health checks
- Graceful shutdown sequence

## Running Integration Tests

```bash
# Run all integration tests
npm test tests/integration/

# Run specific test file
npm test tests/integration/event-flow.test.ts

# Run with verbose output
npm test -- --reporter=verbose tests/integration/
```

## Key Differences from Other Test Types

### vs Unit Tests
- **Less Mocking**: Uses real implementations where possible (e.g., real SQLite database)
- **Component Interaction**: Tests multiple services working together
- **Realistic Scenarios**: Simulates actual system behavior

### vs E2E Tests
- **In-Process**: No external processes or CLI commands
- **Faster Execution**: Runs entirely within Node.js process
- **Controlled Environment**: Uses mock process spawner for workers
- **Focused Scope**: Tests specific integration points, not full workflows

## Test Infrastructure

### Real Components Used
- SQLite database (in temporary directory)
- Event bus (InMemoryEventBus)
- Task queue (PriorityTaskQueue)
- Output capture (BufferedOutputCapture)
- Resource monitor (SystemResourceMonitor)

### Mocked Components
- Process spawner (MockProcessSpawner) - prevents actual Claude Code spawning
- File system locations - uses temp directories

## Test Patterns

### Event-Driven Testing
```typescript
// Track events during test
const events: string[] = [];
eventBus.on('TaskDelegated', () => events.push('delegated'));

// Perform action
await taskManager.delegate(task);

// Verify events
assert(events.includes('delegated'));
```

### Database Testing
```typescript
// Use temporary database
const tempDir = await mkdtemp(join(tmpdir(), 'test-'));
const repository = new SQLiteTaskRepository(join(tempDir, 'test.db'));

// Test operations
await repository.create(task);

// Cleanup
await repository.close();
await rm(tempDir, { recursive: true });
```

### Async Coordination
```typescript
// Wait for async events to process
await new Promise(resolve => setTimeout(resolve, 100));

// Or use event promises
const completed = new Promise(resolve =>
  eventBus.once('TaskCompleted', resolve)
);
```

## Success Criteria

Integration tests should:
- ✅ Complete in < 5 seconds per test
- ✅ Clean up all resources (databases, files, subscriptions)
- ✅ Test realistic component interactions
- ✅ Use minimal mocking
- ✅ Be deterministic and repeatable
- ✅ Not depend on external services

## Common Issues

### Test Timeouts
- Increase timeout in test: `test('name', { timeout: 10000 }, async () => {})`
- Check for hanging promises or event listeners

### Database Locks
- Ensure `repository.close()` is called in finally blocks
- Use unique temp directories for each test

### Event Bus Cleanup
- Always call `eventBus.dispose()` in finally blocks
- Unsubscribe event handlers after test

### Resource Leaks
- Use try/finally for cleanup
- Track active resources (workers, streams, etc.)

## Future Improvements

- [ ] Add performance benchmarks
- [ ] Test memory usage patterns
- [ ] Add stress testing scenarios
- [ ] Test error propagation paths
- [ ] Add integration test coverage reporting