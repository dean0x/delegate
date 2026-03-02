# E2E Test Plan: Task Failure and Retry

## Test Metadata
- **Test ID:** E2E-003
- **Category:** Error Handling
- **Priority:** P1
- **Estimated Duration:** 45 seconds
- **Dependencies:** MCP server, network access

## Test Description
Test error handling, task failure scenarios, and retry mechanisms.

## Prerequisites
```yaml
preconditions:
  - Clean task database
  - MCP server not running
```

## Test Steps

### Step 1: Start Server
**Action:** Start MCP server
```bash
beat mcp start &
```
**Expected:** Server starts
**Verify:** Process running

### Step 2: Submit Failing Task
**Action:** Submit task that will fail
```bash
beat run "exit 1"
```
**Expected:** Task accepted
**Verify:** Task ID returned

### Step 3: Wait for Failure
**Action:** Check task status
```bash
sleep 5 && beat status {TASK_ID}
```
**Expected:** Task fails
**Verify:** Status is FAILED

### Step 4: Check Error Details
**Action:** Get task logs
```bash
beat logs {TASK_ID}
```
**Expected:** Error information present
**Verify:** 
- Exit code is 1
- Error message present

### Step 5: Retry Failed Task
**Action:** Retry the task
```bash
beat retry {TASK_ID}
```
**Expected:** New task created
**Verify:** New task ID returned

### Step 6: Submit Task with Timeout
**Action:** Submit long-running task with short timeout
```bash
beat run "sleep 60" --timeout 5000
```
**Expected:** Task times out
**Verify:** Status is FAILED with timeout error

### Step 7: Test Network Failure Recovery
**Action:** Submit task that simulates network issue
```bash
beat run "curl http://nonexistent.domain.local"
```
**Expected:** Task fails gracefully
**Verify:** 
- Task completes with FAILED status
- Error message indicates network issue

### Step 8: Verify Database Consistency
**Action:** Check database state
```bash
sqlite3 .backbeat/backbeat.db "SELECT status, COUNT(*) FROM tasks GROUP BY status"
```
**Expected:** Correct task counts
**Verify:** Failed tasks properly recorded

### Step 9: Cleanup
**Action:** Stop server
```bash
killall beat
```
**Expected:** Clean shutdown
**Verify:** Processes terminated

## Success Criteria
- [ ] Failed tasks properly recorded
- [ ] Retry mechanism works
- [ ] Timeout handling works
- [ ] Error messages are informative
- [ ] Database remains consistent

## Notes
- Tests error resilience
- Validates retry logic
- Important for reliability