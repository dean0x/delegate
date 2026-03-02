# E2E Test Plan Overview

## Purpose
This document provides an overview of all E2E test plans for Backbeat. These tests are designed to be executed by Claude Code directly by reading the markdown files and running the bash commands within them.

## Test Execution Method
1. Claude Code reads the test plan markdown file
2. Executes each step's bash commands using the Bash tool
3. Verifies expected outcomes
4. Updates RESULTS_TABLE.md with test results
5. Tracks test freshness using SHA256 hashes

## Test Categories and Coverage

### P0 - Critical (Core Functionality)
These tests verify the fundamental operations that Backbeat depends on.

| Test ID | Test Name | Description | Duration |
|---------|-----------|-------------|----------|
| E2E-001 | Basic Task Delegation | Verify basic task delegation and CLI functionality | 30s |
| E2E-002 | Concurrent Tasks | Test multiple simultaneous task execution | 45s |
| E2E-003 | Task Retry and Failure | Test retry mechanism and failure handling | 60s |
| E2E-004 | Task Persistence | Database persistence and recovery | 45s |
| E2E-005 | Worker Lifecycle | Worker spawn, execution, and cleanup | 60s |
| E2E-006 | Event Bus Coordination | Event-driven architecture verification | 40s |

### P1 - High Priority
These tests cover important features and edge cases.

| Test ID | Test Name | Description | Duration |
|---------|-----------|-------------|----------|
| E2E-007 | Priority Queue | Task priority handling and FIFO ordering | 50s |
| E2E-008 | Queue Overflow | Queue behavior with 50+ tasks | 90s |
| E2E-009 | Autoscaling Basic | Scale up/down based on load | 60s |
| E2E-010 | Autoscaling Resource Limits | CPU and memory threshold enforcement | 45s |
| E2E-013 | Worker Crash Recovery | Crash detection and retry logic | 60s |
| E2E-014 | Timeout Handling | Task timeout enforcement | 40s |
| E2E-015 | Database Corruption Recovery | Database resilience and recovery | 45s |

### P2 - Normal Priority
These tests cover additional features, integration, and edge cases.

| Test ID | Test Name | Description | Duration |
|---------|-----------|-------------|----------|
| E2E-016 | CLI All Commands | Test all CLI command variations | 60s |
| E2E-017 | CLI Error Handling | Invalid arguments and error cases | 30s |
| E2E-018 | Output Capture | stdout/stderr capture and buffering | 40s |
| E2E-019 | Large Output Handling | 100MB+ output scenarios | 60s |
| E2E-022 | MCP Server Integration | JSON-RPC and tool handling | 50s |
| E2E-023 | Performance Baseline | Latency and response time benchmarks | 30s |
| E2E-024 | Stress Test 100 Tasks | System under heavy load | 120s |
| E2E-025 | Empty Task Handling | Null and empty input edge cases | 20s |
| E2E-026 | Special Characters | Unicode and shell injection prevention | 30s |
| E2E-027 | Filesystem Limits | Disk full and permission scenarios | 40s |
| E2E-028 | Cleanup Verification | Resource cleanup validation | 30s |

## Test Best Practices Applied

### 1. **Atomic Tests**
- Each test focuses on one specific feature
- Clear boundaries between test scenarios
- No test depends on another test's state

### 2. **Independent Execution**
- Tests can run in any order
- Each test sets up its own prerequisites
- Clean state before and after execution

### 3. **Repeatable Results**
- Same inputs produce same outputs
- Timing-dependent tests have appropriate waits
- Random elements are controlled or seeded

### 4. **Clear Pass/Fail Criteria**
- Each step has explicit expected outcomes
- Success criteria checklist at the end
- Specific error messages to check

### 5. **Self-Cleaning**
- Every test cleans up its artifacts
- Rollback plan for failure scenarios
- No persistent side effects

### 6. **Realistic Scenarios**
- Tests mirror actual usage patterns
- Use real CLI commands and tools
- Test both success and failure paths

## Execution Guidelines

### Running Individual Tests
```bash
# Claude Code reads and executes test plan
Read: tests/e2e/test-plans/001-basic-task-delegation.md
# Then executes each step using Bash tool
```

### Running Test Suites
```bash
# Run all P0 (Critical) tests
for test in tests/e2e/test-plans/00{4,5,6}-*.md; do
  # Execute test plan
done

# Run all P1 (High Priority) tests
for test in tests/e2e/test-plans/0{07..15}-*.md; do
  # Execute test plan
done
```

### Updating Results Table
After each test run, update `tests/e2e/RESULTS_TABLE.md`:
1. Record test ID, name, and timestamp
2. Note pass/fail status and duration
3. Calculate and store test file hash
4. Mark previous runs as stale if test changed

## Success Metrics

### Coverage Goals
- **Core Functionality**: 100% coverage (P0 tests)
- **Major Features**: 90% coverage (P1 tests)
- **Edge Cases**: 70% coverage (P2 tests)

### Performance Targets
- Test suite completion: < 30 minutes for all tests
- Individual test timeout: Maximum 2 minutes
- Result reporting: Real-time updates to table

### Quality Indicators
- **Pass Rate**: Target 95% for stable builds
- **Flaky Tests**: < 5% intermittent failures
- **False Positives**: < 1% incorrect passes
- **Recovery Rate**: 100% cleanup success

## Common Issues and Solutions

### Issue: Tests fail due to missing dependencies
**Solution**: Check prerequisites in each test plan, install required tools

### Issue: Tests timeout or hang
**Solution**: Check system resources, verify timeout parameters, kill orphaned processes

### Issue: Database corruption during tests
**Solution**: Use rollback plan, remove `.backbeat/backbeat.db`, restart clean

### Issue: Port conflicts with MCP server
**Solution**: Check for running instances, use different port configuration

## Maintenance

### Adding New Tests
1. Follow naming convention: `{number}-{feature-name}.md`
2. Use next available number in sequence
3. Assign appropriate priority (P0/P1/P2)
4. Include all required sections from template
5. Test locally before committing

### Updating Existing Tests
1. Modify test plan markdown file
2. Test changes work correctly
3. Old results automatically marked stale via hash
4. Document breaking changes in notes

### Deprecating Tests
1. Move to `archived/` subdirectory
2. Update this overview document
3. Remove from automated test runs
4. Keep for historical reference

## Test Plan Template
```markdown
# E2E Test Plan: [Feature Name]

## Test Metadata
- **Test ID:** E2E-XXX
- **Category:** [Category]
- **Priority:** P0|P1|P2
- **Estimated Duration:** XXs
- **Dependencies:** [List any]

## Test Description
[Brief description of what this test verifies]

## Prerequisites
\`\`\`yaml
preconditions:
  - [Condition 1]
  - [Condition 2]
\`\`\`

## Test Steps
[Steps with bash commands and verification]

## Success Criteria
- [ ] [Criterion 1]
- [ ] [Criterion 2]

## Rollback Plan
[Steps to recover if test fails]

## Notes
[Any additional context]
```

## Next Steps
1. Complete remaining P2 test plans (016-028)
2. Set up automated test execution schedule
3. Create dashboard for test results visualization
4. Implement test result trending analysis
5. Add performance regression detection