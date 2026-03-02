# Backbeat Test Suite

**Quality Score**: 75/100 (Target: 85/100)
**Standards**: [TEST_STANDARDS.md](./TEST_STANDARDS.md) - **MUST READ BEFORE WRITING TESTS**

This directory contains comprehensive tests for Backbeat's task delegation system following strict quality standards.

## Test Structure

```
tests/
├── unit/                    # Unit tests for individual components
│   ├── core/               # Core domain logic tests
│   │   ├── configuration.test.ts
│   │   ├── domain.test.ts
│   │   ├── errors.test.ts
│   │   ├── events/
│   │   │   ├── event-bus.test.ts
│   │   │   └── event-bus-request.test.ts
│   │   └── result.test.ts
│   ├── error-scenarios/    # ⭐ NEW: Error handling test suites
│   │   ├── database-failures.test.ts
│   │   └── network-failures.test.ts
│   ├── implementations/    # Implementation tests
│   │   ├── database.test.ts
│   │   ├── logger.test.ts
│   │   ├── output-capture.test.ts
│   │   ├── process-spawner.test.ts
│   │   ├── resource-monitor.test.ts
│   │   └── task-queue.test.ts
│   ├── services/           # Service layer tests
│   └── utils/              # Utility function tests
│       └── retry.test.ts
├── integration/            # Integration test scenarios
│   ├── README.md
│   ├── event-flow.test.ts # Event-driven architecture tests
│   └── *.test.ts          # Other integration tests
├── e2e/                    # End-to-end test plans
│   ├── README.md           # E2E framework documentation
│   ├── TEST_PLAN_OVERVIEW.md # Complete test inventory
│   ├── RESULTS_TABLE.md   # Test execution results
│   └── test-plans/        # Plain English test plans (001-028)
├── fixtures/               # ⭐ ENHANCED: Test infrastructure
│   ├── factories.ts       # ⭐ NEW: Test data factories (builder pattern)
│   ├── test-doubles.ts    # ⭐ NEW: Test double implementations
│   ├── mock-process-spawner.ts # Mock process spawner
│   └── test-data.ts       # Static test data
├── constants.ts            # ⭐ NEW: Centralized test constants (no magic numbers!)
├── TEST_STANDARDS.md       # ⭐ NEW: Mandatory test quality guidelines
├── README.md              # This file
└── TESTING_ARCHITECTURE.md # Testing strategy document
```

## Test Categories

### 1. Unit Tests (`/unit`)
- **Focus**: Individual components in isolation
- **Coverage**: 95%+ of core business logic
- **Execution**: Fast (< 5 seconds total)
- **Framework**: Node.js test runner with TypeScript

**Run unit tests:**
```bash
npm test                    # Run all unit tests
npm test -- tests/unit/core # Run specific directory
npm test -- --grep "EventBus" # Run tests matching pattern
```

### 2. Integration Tests (`/integration`)
- **Focus**: Component interactions and workflows
- **Documentation**: TEST_SCENARIOS.md contains test scenarios
- **Purpose**: Validate service coordination and data flow

**Note**: Integration tests are documented scenarios rather than executable code, designed for manual validation or future automation.

### 3. E2E Tests (`/e2e`)
- **Focus**: Complete system functionality via CLI
- **Execution**: Plain English markdown files executed by Claude Code
- **Coverage**: 28 comprehensive test plans (001-028)
- **Tracking**: Results tracked in RESULTS_TABLE.md with freshness indicators

**E2E Test Execution by Claude Code:**
1. Read test plan: `tests/e2e/test-plans/XXX-*.md`
2. Execute bash commands step by step
3. Verify expected outcomes
4. Update RESULTS_TABLE.md with results

**Test Plans Available:**
- **P0 (Critical)**: 001-006 - Core functionality tests
- **P1 (High)**: 007-015 - Priority, autoscaling, error handling
- **P2 (Normal)**: 016-028 - CLI, integration, performance, edge cases

## Running Tests

### Quick Start
```bash
# Run all unit tests
npm test

# Run with coverage
npm run test:coverage

# Run specific test file
npm test tests/unit/core/domain.test.ts

# Run tests in watch mode (if configured)
npm test -- --watch
```

### Test Coverage
Current coverage targets:
- Unit tests: 95%+ coverage of business logic
- Integration scenarios: Documented for all major workflows
- E2E tests: 28 comprehensive test plans covering all features

## Test Data Management

### Fixtures (`/fixtures`)
Reusable test data and mocks:
- `mock-data.ts`: Dynamic data generators
- `test-data.ts`: Static test constants
- `mocks.ts`: Service mocks
- `test-db.ts`: In-memory database for tests

### Temporary Files
Tests create temporary artifacts in:
- `.backbeat/` - Temporary databases

**Cleanup**: Tests automatically clean up after execution

## Best Practices - UPDATED 2025

### ⚠️ MANDATORY: Read [TEST_STANDARDS.md](./TEST_STANDARDS.md) Before Writing Tests

### Writing Unit Tests - NEW STANDARDS
```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { TaskFactory } from '../fixtures/factories';  // USE FACTORIES!
import { TestEventBus, TestRepository } from '../fixtures/test-doubles';  // USE TEST DOUBLES!
import { TIMEOUTS, ERROR_MESSAGES } from '../constants';  // NO MAGIC NUMBERS!

describe('TaskManager - Behavioral Tests', () => {
  it('should delegate task and track its lifecycle', async () => {
    // Arrange - Use factories, not inline objects
    const task = new TaskFactory()
      .withPrompt('analyze codebase')
      .withPriority('P0')
      .build();

    // Act - Test the behavior
    const result = await taskManager.delegate(task);

    // Assert - 3-5 assertions per test (MANDATORY)
    expect(result.ok).toBe(true);
    expect(result.value.status).toBe('queued');
    expect(eventBus.hasEmitted('TaskDelegated')).toBe(true);
    expect(repository.hasTask(result.value.id)).toBe(true);
  });

  // ERROR CASES ARE MANDATORY
  it('should handle database failure gracefully', async () => {
    repository.setSaveError(new Error(ERROR_MESSAGES.DATABASE_LOCKED));

    const result = await taskManager.delegate(task);

    expect(result.ok).toBe(false);
    expect(result.error.message).toContain('Database');
    expect(logger.hasLog('error', 'Failed to save task')).toBe(true);
  });
});
```

### ❌ BANNED Patterns
- NO fake tests that test their own implementations
- NO `as any` type assertions
- NO console.log spying - use TestLogger
- NO magic numbers - use constants
- NO single assertion tests
- NO testing mock behavior

### Test Infrastructure Usage

#### 1. Test Factories (ALWAYS USE THESE)
```typescript
import { TaskFactory, WorkerFactory, ConfigFactory } from '../fixtures/factories';

// Create test data with builder pattern
const task = new TaskFactory()
  .withPrompt('test prompt')
  .withPriority('P0')
  .completed(0)  // Helper for completed state
  .build();

// Create multiple items
const tasks = new TaskFactory().buildMany(10, (factory, index) => {
  factory.withId(`task-${index}`);
});
```

#### 2. Test Doubles (USE INSTEAD OF MOCKS)
```typescript
import { TestEventBus, TestLogger, TestRepository } from '../fixtures/test-doubles';

// TestEventBus tracks emissions
const eventBus = new TestEventBus();
await eventBus.emit('TaskDelegated', task);
expect(eventBus.hasEmitted('TaskDelegated')).toBe(true);
expect(eventBus.getEventCount('TaskDelegated')).toBe(1);

// TestLogger captures logs
const logger = new TestLogger();
logger.error('Test error', new Error('boom'));
expect(logger.hasLog('error', 'Test error')).toBe(true);
```

#### 3. Constants (NO MAGIC NUMBERS)
```typescript
import { TIMEOUTS, BUFFER_SIZES, ERROR_MESSAGES } from '../constants';

await sleep(TIMEOUTS.SHORT);  // Not sleep(100)
const buffer = Buffer.alloc(BUFFER_SIZES.MEDIUM);  // Not Buffer.alloc(10485760)
expect(error.message).toBe(ERROR_MESSAGES.TASK_NOT_FOUND);
```

### Writing E2E Test Plans
E2E tests are written in markdown with:
1. Clear metadata (ID, priority, duration)
2. Prerequisites and setup
3. Step-by-step bash commands
4. Expected outcomes
5. Success criteria
6. Cleanup procedures

## Common Issues and Solutions

### Unit Test Issues
- **Import errors**: Ensure `.js` extensions in imports
- **Async issues**: Always await async operations
- **Mock leakage**: Reset mocks in afterEach hooks

### E2E Test Issues
- **Database locks**: Clean `.backbeat/` directory
- **Orphaned processes**: Run `pkill -f beat`
- **Orphaned processes**: Run `pkill -f "claude.*backbeat"`

## CI/CD Integration

Tests run automatically on:
- Pull requests (unit tests)
- Main branch commits (full suite)
- Release tags (comprehensive validation)

GitHub Actions workflow handles:
1. Environment setup
2. Dependency installation
3. Build verification
4. Test execution
5. Coverage reporting

## Contributing - UPDATED REQUIREMENTS

### Before Writing ANY Test:
1. **READ** [TEST_STANDARDS.md](./TEST_STANDARDS.md)
2. **USE** test factories from `/fixtures/factories.ts`
3. **USE** test doubles from `/fixtures/test-doubles.ts`
4. **USE** constants from `/constants.ts`
5. **FOLLOW** AAA pattern (Arrange, Act, Assert)
6. **INCLUDE** error cases for every component
7. **ENSURE** 3-5 assertions per test

### When Adding Tests:
1. **Unit tests**: Add to appropriate subdirectory under `/unit`
   - MUST include error scenarios
   - MUST use test infrastructure
   - MUST follow behavioral testing
2. **Integration tests**: Add to `/integration` with `.test.ts` extension
3. **E2E tests**: Create numbered markdown file in `/e2e/test-plans`
4. **Error scenarios**: Add to `/unit/error-scenarios/`
5. **Performance tests**: Add to `/performance/` (when created)
6. **Security tests**: Add to `/security/` (when created)

### Naming Conventions
- Unit tests: `{component}.test.ts`
- Error tests: `{failure-type}-failures.test.ts`
- E2E plans: `{number}-{feature-name}.md`
- Factories: Use existing ones in `factories.ts`
- Test doubles: Use existing ones in `test-doubles.ts`

### Quality Checklist (MANDATORY)
- [ ] No fake tests (testing actual behavior)
- [ ] No magic numbers (using constants)
- [ ] No console spying (using TestLogger)
- [ ] 3-5 assertions per test
- [ ] Error cases included
- [ ] Using test factories
- [ ] Using test doubles
- [ ] Following AAA pattern
- [ ] Descriptive test names

## Testing Standards and Architecture

### Required Reading
1. **[TEST_STANDARDS.md](./TEST_STANDARDS.md)** - MANDATORY test quality guidelines (READ FIRST!)
2. **[TESTING_ARCHITECTURE.md](./TESTING_ARCHITECTURE.md)** - Overall testing strategy
3. **[Audit Report](./.docs/test-audits/audit-2025-01-26.md)** - Quality baseline and issues to avoid
4. **[Improvement Summary](./.docs/test-audits/improvement-summary-2025-01-26.md)** - Progress tracking

### Quick Quality Check
Run this before committing:
```bash
# Check test quality metrics
npm run test:coverage

# Verify no console.log or console.error spying
grep -r "spyOn(console" tests/ && echo "❌ Remove console spying!" || echo "✅ No console spying"

# Check for magic numbers
grep -r "\(1000\|5000\|10000\)" tests/ --include="*.test.ts" && echo "⚠️ Magic numbers found!" || echo "✅ No magic numbers"

# Check for 'as any'
grep -r "as any" tests/ --include="*.test.ts" && echo "❌ Remove 'as any'!" || echo "✅ No 'as any'"
```