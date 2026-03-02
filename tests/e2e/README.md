# E2E Testing Framework for Backbeat

## Overview

This directory contains plain English test plans designed to be executed directly by Claude Code. The framework tracks test results with freshness indicators to show when tests need re-running.

## How It Works

1. **Test Plans**: Written in markdown (`test-plans/*.md`) with natural language descriptions and bash commands
2. **Execution**: Claude Code reads the markdown files and executes commands step-by-step using the Bash tool
3. **Results Tracking**: Updates `RESULTS_TABLE.md` with pass/fail status and freshness indicators
4. **Freshness**: SHA256 hashes detect when test plans change, marking old results as stale

## Test Plan Structure

Each test plan follows this format:

```markdown
# E2E Test Plan: [Test Name]

## Test Metadata
- **Test ID:** E2E-XXX
- **Category:** [Category Name]
- **Priority:** P0|P1|P2
- **Estimated Duration:** XX seconds
- **Dependencies:** [List requirements]

## Test Description
[What this test validates]

## Prerequisites
- [Preconditions that must be met]

## Test Steps

### Step N: [Description]
**Action:** [What to do]
```bash
[Command to execute]
```
**Expected:** [Expected outcome]
**Verify:** [What to check]

## Success Criteria
- [ ] [Criteria 1]
- [ ] [Criteria 2]

## Rollback Plan
[Recovery steps if test fails]
```

## Available Test Plans

### P0 - Critical (Must Pass)
- **001-003**: Basic functionality (delegation, concurrency, retry)
- **004-006**: Core systems (persistence, workers, events)

### P1 - High Priority
- **007-008**: Queue management (priority, overflow)
- **009-010**: Autoscaling (basic, resource limits)
- **013**: Worker crash recovery

### P2 - Normal Priority
- **016-028**: CLI, integration, performance, edge cases (planned)

See [TEST_PLAN_OVERVIEW.md](./TEST_PLAN_OVERVIEW.md) for complete inventory.

## Executing Tests with Claude Code

### Run a Single Test
1. Read the test plan file
2. Execute each step's bash command
3. Verify expected outcomes
4. Update results table

Example:
```
Read: tests/e2e/test-plans/001-basic-task-delegation.md
[Execute each step using Bash tool]
Update: tests/e2e/RESULTS_TABLE.md
```

### Run Multiple Tests
Execute tests in priority order (P0 → P1 → P2) to ensure critical functionality first.

### Interpreting Results

**RESULTS_TABLE.md** shows:
- **Status**: ✅ Passed | ❌ Failed | ⚠️ Partial | 🚫 Aborted
- **Fresh**: 🟢 Test unchanged | 🔴 Test modified since run
- **Duration**: Time taken to execute
- **Steps Passed**: X/Y steps successful

## Writing New Test Plans

1. Use next available number (e.g., `012-feature-name.md`)
2. Follow the template structure above
3. Include clear bash commands
4. Add success criteria and rollback plan
5. Update TEST_PLAN_OVERVIEW.md

## Best Practices

- **Atomic**: Each test focuses on one feature
- **Independent**: Tests don't depend on each other
- **Repeatable**: Same results on every run
- **Self-cleaning**: Always include cleanup steps
- **Clear verification**: Explicit pass/fail criteria

## Troubleshooting

### Common Issues
- **Database locks**: Clean `.backbeat/` directory
- **Orphaned processes**: Run `pkill -f beat`
- **Stale results**: Re-run tests marked with 🔴

### Test Timeouts
Most tests complete in 30-90 seconds. If a test hangs:
1. Check for blocking commands
2. Verify timeout parameters
3. Kill orphaned processes

## Maintenance

- Review stale results weekly
- Update test plans as features change
- Archive obsolete tests
- Keep results table under 100 entries