# E2E Test Plan: Concurrent Task Execution

## Test Metadata
- **Test ID:** E2E-002
- **Category:** Scalability
- **Priority:** P0
- **Estimated Duration:** 60 seconds
- **Dependencies:** MCP server running, sufficient resources

## Test Description
Verify that Backbeat can handle multiple concurrent tasks and properly manage worker pool scaling.

## Prerequisites
```yaml
preconditions:
  - At least 4GB RAM available
  - CPU usage below 50%
  - No running backbeat processes
```

## Test Steps

### Step 1: Start MCP Server
**Action:** Start MCP server with debug logging
```bash
LOG_LEVEL=debug beat mcp start &
```
**Expected:** Server starts with debug logging enabled
**Verify:** Process running

### Step 2: Submit Multiple Tasks Rapidly
**Action:** Submit 5 tasks in quick succession
```bash
for i in {1..5}; do
  beat run "sleep $((i*2)) && echo Task $i completed"
done
```
**Expected:** All tasks are accepted
**Verify:** 5 different task IDs returned

### Step 3: Monitor Worker Scaling
**Action:** Check worker count
```bash
ps aux | grep 'claude ' | grep -v grep | wc -l
```
**Expected:** Multiple workers spawned (2-5 based on resources)
**Verify:** Worker count > 1

### Step 4: Verify Concurrent Execution
**Action:** Check all tasks are running or queued
```bash
beat status
```
**Expected:** Tasks in various states
**Verify:** 
- Some tasks RUNNING
- Some tasks QUEUED or COMPLETED
- No FAILED tasks

### Step 5: Wait for Completion
**Action:** Wait for all tasks to complete
```bash
sleep 15
beat status
```
**Expected:** All tasks completed
**Verify:** All 5 tasks show COMPLETED status

### Step 6: Verify Output Order
**Action:** Check task outputs
```bash
for i in {1..5}; do
  beat logs $(beat status --json | jq -r ".tasks[$((i-1))].id")
done
```
**Expected:** Each task has correct output
**Verify:** Task N contains "Task N completed"

### Step 7: Check Resource Cleanup
**Action:** Verify workers terminated
```bash
ps aux | grep 'claude ' | grep -v grep
```
**Expected:** No orphaned worker processes
**Verify:** No claude processes except MCP server

### Step 8: Cleanup
**Action:** Stop server
```bash
killall beat
```
**Expected:** Clean shutdown
**Verify:** All processes terminated

## Success Criteria
- [ ] All 5 tasks complete successfully
- [ ] Workers scale up automatically
- [ ] No resource exhaustion
- [ ] Clean resource cleanup
- [ ] Total execution time < 60 seconds

## Failure Scenarios
- If worker scaling fails, check resource limits
- If tasks fail, check for port conflicts
- If cleanup fails, manually kill processes

## Notes
- Tests autoscaling behavior
- Validates concurrent execution
- Important for production readiness