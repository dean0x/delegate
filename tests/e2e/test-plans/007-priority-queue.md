# E2E Test Plan: Priority Queue

## Test Metadata
- **Test ID:** E2E-007
- **Category:** Priority and Queue Management
- **Priority:** P1
- **Estimated Duration:** 50 seconds
- **Dependencies:** None

## Test Description
Verify that task priority handling works correctly: P0 tasks execute before P1 and P2, FIFO ordering within same priority level, and queue persistence across restarts.

## Prerequisites
```yaml
preconditions:
  - Clean database and queue state
  - Build completed successfully
  - No running tasks
```

## Test Steps

### Step 1: Clean State
**Action:** Ensure clean starting state
```bash
rm -rf .backbeat/
pkill -f "backbeat" || true
```
**Expected:** Clean state achieved
**Verify:**
- No existing database
- No running processes

### Step 2: Build Project
**Action:** Build the TypeScript project
```bash
npm run build
```
**Expected:** Build completes successfully
**Verify:**
- No TypeScript errors
- dist/ directory exists

### Step 3: Create P2 Tasks First
**Action:** Add low priority tasks to queue
```bash
beat run "echo 'P2 Task 1' && sleep 2" --priority P2
beat run "echo 'P2 Task 2' && sleep 2" --priority P2
beat run "echo 'P2 Task 3' && sleep 2" --priority P2
```
**Expected:** Three P2 tasks queued
**Verify:**
- Three task IDs returned
- All marked as P2 priority

### Step 4: Create P1 Tasks
**Action:** Add medium priority tasks
```bash
beat run "echo 'P1 Task 1' && sleep 2" --priority P1
beat run "echo 'P1 Task 2' && sleep 2" --priority P1
```
**Expected:** Two P1 tasks queued
**Verify:**
- Two task IDs returned
- All marked as P1 priority

### Step 5: Create P0 Tasks
**Action:** Add high priority tasks
```bash
beat run "echo 'P0 Task 1' && sleep 2" --priority P0
beat run "echo 'P0 Task 2' && sleep 2" --priority P0
```
**Expected:** Two P0 tasks queued
**Verify:**
- Two task IDs returned
- All marked as P0 priority

### Step 6: Check Queue Order
**Action:** Display current queue status
```bash
node dist/cli.js status
```
**Expected:** Tasks shown in priority order
**Verify:**
- P0 tasks listed first
- P1 tasks in middle
- P2 tasks last

### Step 7: Monitor Execution Order
**Action:** Watch task execution for 10 seconds
```bash
for i in {1..5}; do
  echo "=== Check $i ==="
  node dist/cli.js status | grep -E "P0|P1|P2|running|completed" | head -5
  sleep 2
done
```
**Expected:** P0 tasks execute first
**Verify:**
- P0 tasks show "running" or "completed" first
- P1/P2 tasks remain "queued" initially

### Step 8: Verify FIFO Within Priority
**Action:** Check that tasks of same priority maintain order
```bash
node dist/cli.js logs $(node dist/cli.js status --json 2>/dev/null | grep -o '"id":"[^"]*"' | sed -n '1p' | cut -d'"' -f4) 2>/dev/null | grep "P0 Task"
node dist/cli.js logs $(node dist/cli.js status --json 2>/dev/null | grep -o '"id":"[^"]*"' | sed -n '2p' | cut -d'"' -f4) 2>/dev/null | grep "P0 Task"
```
**Expected:** P0 Task 1 before P0 Task 2
**Verify:**
- First P0 task executed first
- FIFO order preserved

### Step 9: Test Queue Persistence
**Action:** Kill process while tasks queued
```bash
# Get current queue state
node dist/cli.js status > /tmp/queue_before.txt
# Kill process
pkill -f "backbeat" || true
sleep 2
```
**Expected:** Process killed with tasks pending
**Verify:**
- Process terminated
- Queue state saved

### Step 10: Restart and Check Queue
**Action:** Check queue restored from database
```bash
node dist/cli.js status > /tmp/queue_after.txt
diff /tmp/queue_before.txt /tmp/queue_after.txt || echo "Queue state may have progressed"
```
**Expected:** Queue state preserved
**Verify:**
- Same tasks present
- Priority order maintained

### Step 11: Test Priority Override
**Action:** Add urgent P0 task to existing queue
```bash
beat run "echo 'URGENT P0 Task' && sleep 1" --priority P0
sleep 3
node dist/cli.js status | grep -E "URGENT|running"
```
**Expected:** Urgent task prioritized
**Verify:**
- New P0 task jumps queue
- Executes before P1/P2 tasks

### Step 12: Wait for All Completion
**Action:** Wait for all tasks to complete
```bash
timeout 30 bash -c 'while [ $(node dist/cli.js status | grep -c "completed") -lt 8 ]; do sleep 2; done' || echo "Some tasks still running"
```
**Expected:** All tasks eventually complete
**Verify:**
- 8 tasks show completed status
- No tasks stuck

### Step 13: Verify Final Execution Order
**Action:** Check completion timestamps
```bash
sqlite3 .backbeat/backbeat.db "SELECT priority, status, completedAt FROM tasks ORDER BY completedAt;" 2>/dev/null | head -10
```
**Expected:** Completion follows priority
**Verify:**
- P0 tasks completed first
- P1 tasks completed second
- P2 tasks completed last

### Step 14: Cleanup
**Action:** Clean up test artifacts
```bash
pkill -f "backbeat" || true
rm -rf .backbeat/ /tmp/queue_*.txt
```
**Expected:** Cleanup successful
**Verify:**
- No processes running
- Files removed

## Success Criteria
- [ ] P0 tasks execute before P1 and P2
- [ ] P1 tasks execute before P2
- [ ] FIFO order maintained within same priority
- [ ] Queue persists across process restarts
- [ ] New high priority tasks jump queue
- [ ] All tasks eventually complete
- [ ] No queue corruption or task loss
- [ ] Priority stored correctly in database

## Rollback Plan
If test fails:
1. Kill all processes: `pkill -9 -f backbeat`
2. Clear database: `rm -rf .backbeat/`
3. Check queue implementation in code
4. Verify priority enum values (P0=0, P1=1, P2=2)

## Notes
- Lower priority number = higher priority (P0 > P1 > P2)
- Queue should handle 1000+ tasks
- Priority changes after queuing not supported
- FIFO within priority level is critical