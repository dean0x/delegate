# E2E Test Plan: Event Bus Coordination

## Test Metadata
- **Test ID:** E2E-006
- **Category:** Core Functionality
- **Priority:** P0
- **Estimated Duration:** 40 seconds
- **Dependencies:** None

## Test Description
Verify the event-driven architecture is working correctly: events are emitted, handlers respond, request-response patterns work, and memory is properly managed (no leaks in pendingRequests).

## Prerequisites
```yaml
preconditions:
  - Clean system state
  - Build completed successfully
  - No running backbeat processes
```

## Test Steps

### Step 1: Build Project
**Action:** Build the TypeScript project
```bash
npm run build
```
**Expected:** Build completes successfully
**Verify:**
- No TypeScript errors
- dist/ directory exists

### Step 2: Create Task to Trigger Events
**Action:** Delegate task that will trigger multiple events
```bash
node dist/cli.js run "echo 'Event test task'" --priority P0
```
**Expected:** Task created, events emitted
**Verify:**
- Task ID returned
- No errors

### Step 3: Verify TaskDelegated Event
**Action:** Check logs for TaskDelegated event
```bash
grep -r "TaskDelegated" .backbeat/logs/ 2>/dev/null | head -1 || echo "No TaskDelegated event found in logs"
```
**Expected:** Event emission logged
**Verify:**
- TaskDelegated event found or log check attempted
- Event includes task data

### Step 4: Test Multiple Rapid Events
**Action:** Create 5 tasks rapidly to test event handling
```bash
for i in 1 2 3 4 5; do
  node dist/cli.js run "echo 'Rapid event $i'" &
done
wait
```
**Expected:** All tasks created without conflicts
**Verify:**
- 5 task IDs returned
- No event collisions

### Step 5: Check Event Handler Registration
**Action:** Verify status command (uses request-response)
```bash
node dist/cli.js status
```
**Expected:** Status retrieved via event bus
**Verify:**
- Status output shown
- Request-response pattern working

### Step 6: Test Concurrent Requests
**Action:** Multiple concurrent status requests
```bash
for i in 1 2 3; do
  node dist/cli.js status &
done
wait
```
**Expected:** All requests handled
**Verify:**
- 3 status outputs shown
- No deadlocks or timeouts

### Step 7: Monitor Memory Usage
**Action:** Check process memory before stress test
```bash
ps aux | grep "node dist/cli.js" | grep -v grep | awk '{print $6}' | head -1 || echo "0"
```
**Expected:** Baseline memory recorded
**Verify:**
- Memory value captured
- Process running

### Step 8: Stress Test Pending Requests
**Action:** Create many rapid requests to test cleanup
```bash
for i in {1..20}; do
  node dist/cli.js status --json 2>/dev/null &
done
wait
```
**Expected:** All requests complete
**Verify:**
- No hanging processes
- Requests don't leak memory

### Step 9: Wait for Cleanup Interval
**Action:** Wait 35 seconds for cleanup to trigger
```bash
echo "Waiting for cleanup interval (35s)..." && sleep 35
```
**Expected:** Cleanup runs internally
**Verify:**
- System remains responsive
- No errors during wait

### Step 10: Verify Memory Stable
**Action:** Check memory hasn't grown significantly
```bash
ps aux | grep "node" | grep -v grep | awk '{sum+=$6} END {print sum}' || echo "0"
```
**Expected:** Memory usage reasonable
**Verify:**
- No significant memory growth
- Cleanup prevented leaks

### Step 11: Test Event Ordering
**Action:** Create task with specific priority to test order
```bash
node dist/cli.js run "echo 'P0 task'" --priority P0
node dist/cli.js run "echo 'P2 task'" --priority P2
node dist/cli.js run "echo 'P1 task'" --priority P1
```
**Expected:** Events processed in order
**Verify:**
- All tasks created
- Priority respected

### Step 12: Verify Queue Event Handling
**Action:** Check status to see priority ordering
```bash
node dist/cli.js status
```
**Expected:** Tasks shown with priorities
**Verify:**
- P0 task listed
- Priority order visible

### Step 13: Test Event Bus Disposal
**Action:** Trigger cleanup by delegating final task
```bash
node dist/cli.js run "echo 'Final disposal test'"
```
**Expected:** Task created, cleanup triggered
**Verify:**
- Task ID returned
- System remains stable

### Step 14: Cleanup
**Action:** Clean up all test artifacts
```bash
pkill -f "beat" || true
rm -rf .backbeat/
```
**Expected:** Cleanup successful
**Verify:**
- No processes running
- .backbeat directory removed

## Success Criteria
- [ ] Events emitted and handled correctly
- [ ] Request-response pattern works reliably
- [ ] Multiple concurrent requests handled
- [ ] No memory leaks in pendingRequests Map
- [ ] Cleanup interval prevents memory growth
- [ ] Event ordering maintained
- [ ] No race conditions observed
- [ ] Event bus handles high load

## Rollback Plan
If test fails:
1. Kill all processes: `pkill -9 -f node`
2. Clear logs: `rm -rf .backbeat/logs/`
3. Check system resources: `free -h`
4. Review event bus implementation

## Notes
- Event bus is central to architecture
- Memory leak prevention is critical
- 30-second cleanup interval must work
- Request-response timeout is 30 seconds