# E2E Test Plan: Worker Crash Recovery

## Test Metadata
- **Test ID:** E2E-013
- **Category:** Error Handling and Recovery
- **Priority:** P1
- **Estimated Duration:** 60 seconds
- **Dependencies:** None

## Test Description
Test worker failure handling: detect crashed workers, retry tasks with exponential backoff, mark tasks as failed after max retries.

## Prerequisites
```yaml
preconditions:
  - Clean system state
  - Build completed successfully
  - No running workers
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

### Step 3: Create Task That Will Crash
**Action:** Delegate task that exits abruptly
```bash
beat run "echo 'Starting task' && sleep 2 && exit 1" --priority P0
TASK_ID=$(node dist/cli.js status --json 2>/dev/null | grep -o '"id":"[^"]*"' | head -1 | cut -d'"' -f4)
echo "Task ID: $TASK_ID"
```
**Expected:** Task created
**Verify:**
- Task ID captured
- Task delegated

### Step 4: Monitor Initial Attempt
**Action:** Watch first execution attempt
```bash
sleep 3
node dist/cli.js status $TASK_ID | grep -E "status|attempt"
```
**Expected:** Task running or failed
**Verify:**
- Status shown
- First attempt recorded

### Step 5: Wait for First Retry
**Action:** Wait for exponential backoff and retry
```bash
echo "Waiting for first retry (backoff ~2s)..."
sleep 4
node dist/cli.js status $TASK_ID | grep -E "status|attempt|retry"
```
**Expected:** Retry attempted
**Verify:**
- Retry count > 0
- Task retrying

### Step 6: Check Retry Delay Pattern
**Action:** Monitor exponential backoff timing
```bash
for i in {1..20}; do
  status=$(node dist/cli.js status $TASK_ID 2>/dev/null | grep -oE "attempt.*|retry.*|status.*" | head -1)
  echo "Second $((i*2)): $status"
  sleep 2
done
```
**Expected:** Exponential delays
**Verify:**
- Delays increase (2s, 4s, 8s...)
- Multiple retry attempts

### Step 7: Verify Max Retries
**Action:** Check task fails after max attempts
```bash
# Default max retries is usually 3
sleep 20
final_status=$(node dist/cli.js status $TASK_ID | grep "status" | head -1)
echo "Final status: $final_status"
echo "$final_status" | grep -i "failed" && echo "✓ Task marked as failed" || echo "❌ Task not failed"
```
**Expected:** Task marked failed
**Verify:**
- Status is "failed"
- No more retries

### Step 8: Test Worker Hang Detection
**Action:** Create task that hangs (simulated)
```bash
beat run "echo 'Hanging task' && sleep 300" --timeout 5000 --priority P0
HANG_TASK=$(node dist/cli.js status --json 2>/dev/null | grep -o '"id":"[^"]*"' | tail -1 | cut -d'"' -f4)
echo "Hang task ID: $HANG_TASK"
```
**Expected:** Task with timeout
**Verify:**
- Task ID captured
- Timeout set to 5s

### Step 9: Verify Timeout Kill
**Action:** Check worker killed after timeout
```bash
sleep 7
node dist/cli.js status $HANG_TASK | grep -E "status|timeout|failed"
ps aux | grep -E "sleep 300" | grep -v grep || echo "✓ Hanging process killed"
```
**Expected:** Task timed out
**Verify:**
- Task failed due to timeout
- Process terminated

### Step 10: Test Crash During Output
**Action:** Task crashes while producing output
```bash
beat run "for i in {1..10}; do echo 'Output line $i'; sleep 0.5; done; exit 1" --priority P0
OUTPUT_TASK=$(node dist/cli.js status --json 2>/dev/null | grep -o '"id":"[^"]*"' | tail -1 | cut -d'"' -f4)
echo "Output task ID: $OUTPUT_TASK"
```
**Expected:** Task with partial output
**Verify:**
- Task ID captured
- Task running

### Step 11: Verify Partial Output Saved
**Action:** Check output captured before crash
```bash
sleep 8
node dist/cli.js logs $OUTPUT_TASK | grep -c "Output line" || echo "0"
node dist/cli.js status $OUTPUT_TASK | grep "status"
```
**Expected:** Partial output saved
**Verify:**
- Some output lines captured
- Task retrying or failed

### Step 12: Test SIGKILL Recovery
**Action:** Force kill a worker process
```bash
beat run "echo 'Kill test' && sleep 30" --priority P0 &
sleep 2
# Find and kill the worker
worker_pid=$(ps aux | grep -E "claude.*worker" | grep -v grep | awk '{print $2}' | head -1)
if [ ! -z "$worker_pid" ]; then
  echo "Killing worker PID: $worker_pid"
  kill -9 $worker_pid
else
  echo "No worker found to kill"
fi
```
**Expected:** Worker killed
**Verify:**
- Worker process terminated
- PID shown or not found

### Step 13: Verify SIGKILL Detection
**Action:** Check task detected crash and retries
```bash
KILL_TASK=$(node dist/cli.js status --json 2>/dev/null | grep -o '"id":"[^"]*"' | tail -1 | cut -d'"' -f4)
sleep 5
node dist/cli.js status $KILL_TASK | grep -E "status|retry|attempt"
```
**Expected:** Crash detected
**Verify:**
- Task retrying
- Worker crash handled

### Step 14: Test Recovery After Multiple Crashes
**Action:** Create task that crashes multiple times
```bash
# This will crash 3 times then might be marked failed
beat run "echo 'Multi-crash test attempt' && exit 1" --priority P0
MULTI_TASK=$(node dist/cli.js status --json 2>/dev/null | grep -o '"id":"[^"]*"' | tail -1 | cut -d'"' -f4)

for i in {1..5}; do
  echo "=== Check $i ==="
  node dist/cli.js status $MULTI_TASK | grep -E "status|attempt"
  sleep 10
done
```
**Expected:** Multiple retries then failure
**Verify:**
- Attempt count increases
- Eventually marked failed

### Step 15: Cleanup
**Action:** Clean up test artifacts
```bash
pkill -f "backbeat" || true
rm -rf .backbeat/
```
**Expected:** Cleanup successful
**Verify:**
- Processes terminated
- Database removed

## Success Criteria
- [ ] Crashed workers detected
- [ ] Tasks retry with exponential backoff
- [ ] Max retry limit enforced (3 attempts)
- [ ] Timeout kills hanging workers
- [ ] Partial output preserved on crash
- [ ] SIGKILL detection works
- [ ] Tasks marked failed after max retries
- [ ] No orphaned processes

## Rollback Plan
If test fails:
1. Kill all workers: `pkill -9 -f claude`
2. Clear database: `rm -rf .backbeat/`
3. Check for orphans: `ps aux | grep claude`
4. Review retry logic in code

## Notes
- Default max retries: 3
- Exponential backoff: 2^attempt seconds
- Timeout enforcement via process kill
- Worker health checked periodically
- Crash detection via exit code and signals