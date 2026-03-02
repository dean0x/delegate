# E2E Test Plan: Worker Lifecycle

## Test Metadata
- **Test ID:** E2E-005
- **Category:** Core Functionality
- **Priority:** P0
- **Estimated Duration:** 60 seconds
- **Dependencies:** Claude CLI must be installed

## Test Description
Verify complete worker lifecycle: spawning with correct stdio configuration, task execution, output capture, and proper cleanup. Tests the core worker pool functionality.

## Prerequisites
```yaml
preconditions:
  - Claude CLI available in PATH
  - Clean process state (no orphaned workers)
  - Build completed successfully
```

## Test Steps

### Step 1: Verify Claude CLI Available
**Action:** Check Claude CLI installation
```bash
which claude && claude --version || echo "Claude CLI not found"
```
**Expected:** Claude CLI found and version shown
**Verify:**
- Path to claude binary shown
- Version output displayed

### Step 2: Clean Process State
**Action:** Kill any orphaned worker processes
```bash
pkill -f "claude.*worker" || true
ps aux | grep -E "claude.*worker" | grep -v grep || echo "No workers running"
```
**Expected:** No worker processes running
**Verify:**
- No claude worker processes in list
- Clean process table

### Step 3: Build Project
**Action:** Build the TypeScript project
```bash
npm run build
```
**Expected:** Build completes successfully
**Verify:**
- No TypeScript errors
- dist/ directory updated

### Step 4: Start Simple Worker Task
**Action:** Delegate a task that spawns a worker
```bash
node dist/cli.js run "echo 'Worker started' && sleep 3 && echo 'Worker completed'" --priority P0
```
**Expected:** Worker spawned for task
**Verify:**
- Task ID returned
- No immediate errors

### Step 5: Verify Worker Process Spawned
**Action:** Check for running worker process
```bash
sleep 1 && ps aux | grep -E "claude.*" | grep -v grep | head -3
```
**Expected:** Worker process visible
**Verify:**
- Claude process running
- Process has expected arguments

### Step 6: Check Worker Output Capture
**Action:** Get logs while worker is running
```bash
sleep 2 && node dist/cli.js logs $(node dist/cli.js status --json 2>/dev/null | grep -o '"id":"[^"]*"' | head -1 | cut -d'"' -f4) --tail 10
```
**Expected:** Partial output captured
**Verify:**
- "Worker started" message captured
- Output buffering working

### Step 7: Wait for Worker Completion
**Action:** Wait and check final status
```bash
sleep 5 && node dist/cli.js status $(node dist/cli.js status --json 2>/dev/null | grep -o '"id":"[^"]*"' | head -1 | cut -d'"' -f4)
```
**Expected:** Task completed
**Verify:**
- Status shows "completed"
- Worker finished execution

### Step 8: Verify Worker Cleanup
**Action:** Check that worker process terminated
```bash
ps aux | grep -E "claude.*worker" | grep -v grep || echo "Workers cleaned up successfully"
```
**Expected:** No worker processes remain
**Verify:**
- Worker process terminated
- Clean process table

### Step 9: Test Worker with Error Output
**Action:** Spawn worker that produces stderr
```bash
node dist/cli.js run "echo 'Normal output' && >&2 echo 'Error output' && exit 1"
```
**Expected:** Worker handles stderr
**Verify:**
- Task ID returned
- Worker spawns despite error command

### Step 10: Verify Error Capture
**Action:** Check both stdout and stderr captured
```bash
sleep 3 && node dist/cli.js logs $(node dist/cli.js status --json 2>/dev/null | grep -o '"id":"[^"]*"' | tail -1 | cut -d'"' -f4)
```
**Expected:** Both output streams captured
**Verify:**
- "Normal output" in logs
- "Error output" in logs

### Step 11: Test Multiple Concurrent Workers
**Action:** Spawn 3 workers simultaneously
```bash
for i in 1 2 3; do
  node dist/cli.js run "echo 'Worker $i starting' && sleep 2 && echo 'Worker $i done'" &
done
wait
```
**Expected:** Multiple workers spawn
**Verify:**
- 3 task IDs returned
- No conflicts

### Step 12: Verify Concurrent Execution
**Action:** Check all workers running
```bash
sleep 1 && ps aux | grep -E "claude" | grep -v grep | wc -l
```
**Expected:** Multiple worker processes
**Verify:**
- Count > 1 (multiple workers)
- Concurrent execution working

### Step 13: Test Worker Timeout
**Action:** Create task that will timeout
```bash
node dist/cli.js run "echo 'Starting long task' && sleep 300" --timeout 5000
```
**Expected:** Worker killed after timeout
**Verify:**
- Task created
- Timeout parameter accepted

### Step 14: Verify Timeout Enforcement
**Action:** Wait and check task failed due to timeout
```bash
sleep 7 && node dist/cli.js status $(node dist/cli.js status --json 2>/dev/null | grep -o '"id":"[^"]*"' | tail -1 | cut -d'"' -f4)
```
**Expected:** Task failed with timeout
**Verify:**
- Status shows "failed" or "timeout"
- Worker was terminated

### Step 15: Cleanup
**Action:** Clean up all test artifacts
```bash
pkill -f "claude" || true
rm -rf .backbeat/backbeat.db*
```
**Expected:** Cleanup successful
**Verify:**
- No worker processes
- Database removed

## Success Criteria
- [ ] Workers spawn with correct stdio configuration
- [ ] Both stdout and stderr captured properly
- [ ] Workers terminate cleanly after task completion
- [ ] Multiple workers can run concurrently
- [ ] Worker timeout enforcement works
- [ ] No orphaned processes after completion
- [ ] Output buffering handles large outputs
- [ ] Error outputs don't crash workers

## Rollback Plan
If test fails:
1. Force kill all workers: `pkill -9 -f claude`
2. Clear process table: `killall -9 node`
3. Check system resources: `top -b -n 1`
4. Verify Claude CLI: `claude --help`

## Notes
- Worker spawning is critical for task execution
- stdio: ['ignore', 'pipe', 'pipe'] configuration is essential
- Workers should be isolated from parent process
- Proper cleanup prevents resource leaks