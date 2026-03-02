# E2E Test Plan: Queue Overflow

## Test Metadata
- **Test ID:** E2E-008
- **Category:** Priority and Queue Management
- **Priority:** P1
- **Estimated Duration:** 90 seconds
- **Dependencies:** None

## Test Description
Test queue behavior under heavy load with 50+ pending tasks. Verify memory usage remains bounded, tasks are not lost, and system handles queue overflow gracefully.

## Prerequisites
```yaml
preconditions:
  - Clean system state
  - At least 2GB free RAM
  - Build completed successfully
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

### Step 3: Check Initial Memory
**Action:** Record baseline memory usage
```bash
free -m | grep "^Mem:" | awk '{print "Available RAM: " $7 " MB"}'
```
**Expected:** Memory baseline recorded
**Verify:**
- Available RAM > 1000 MB
- System has sufficient memory

### Step 4: Create 50 Tasks Rapidly
**Action:** Flood queue with tasks
```bash
for i in {1..50}; do
  priority=$((i % 3))
  case $priority in
    0) p="P0" ;;
    1) p="P1" ;;
    2) p="P2" ;;
  esac
  beat run "echo 'Task $i Priority $p' && sleep 1" --priority $p &
done
wait
```
**Expected:** 50 tasks created
**Verify:**
- All beat commands complete
- No immediate crashes

### Step 5: Check Queue Size
**Action:** Verify all tasks queued
```bash
node dist/cli.js status | grep -c "task-" || echo "0"
```
**Expected:** 50 tasks in system
**Verify:**
- Count equals 50
- Queue accepted all tasks

### Step 6: Monitor Memory During Load
**Action:** Check memory usage under load
```bash
ps aux | grep "node dist" | grep -v grep | awk '{sum+=$6} END {print "Node processes using: " sum/1024 " MB"}'
```
**Expected:** Memory usage reasonable
**Verify:**
- Memory < 500 MB for node processes
- No excessive growth

### Step 7: Check Database Size
**Action:** Verify database isn't growing unbounded
```bash
ls -lh .backbeat/backbeat.db 2>/dev/null | awk '{print "Database size: " $5}'
```
**Expected:** Database size reasonable
**Verify:**
- Size < 10 MB
- Database exists

### Step 8: Test Queue Operations Under Load
**Action:** Perform operations while queue full
```bash
# Status check
node dist/cli.js status | head -10
# New task delegation
beat run "echo 'Task 51 added under load'" --priority P0
```
**Expected:** Operations still work
**Verify:**
- Status command responds
- New task accepted

### Step 9: Add 25 More Tasks
**Action:** Push queue further
```bash
for i in {51..75}; do
  beat run "echo 'Overflow task $i' && sleep 0.5" --priority P2 &
done
wait
```
**Expected:** Additional tasks handled
**Verify:**
- Commands complete
- System remains responsive

### Step 10: Check Total Queue Size
**Action:** Verify 75+ tasks in system
```bash
count=$(node dist/cli.js status | grep -c "task-")
echo "Total tasks in system: $count"
[ $count -ge 75 ] && echo "✓ Queue handling 75+ tasks" || echo "✗ Missing tasks"
```
**Expected:** 75+ tasks tracked
**Verify:**
- Count >= 75
- No task loss

### Step 11: Monitor Worker Processing
**Action:** Watch workers process queue
```bash
for i in {1..5}; do
  echo "=== Check $i ==="
  completed=$(node dist/cli.js status | grep -c "completed" || echo "0")
  running=$(node dist/cli.js status | grep -c "running" || echo "0")
  queued=$(node dist/cli.js status | grep -c "queued" || echo "0")
  echo "Completed: $completed, Running: $running, Queued: $queued"
  sleep 3
done
```
**Expected:** Queue processing steadily
**Verify:**
- Completed count increasing
- Running workers active
- Queued count decreasing

### Step 12: Test Memory Stability
**Action:** Check memory after processing
```bash
ps aux | grep "node dist" | grep -v grep | awk '{sum+=$6} END {print "Node processes using: " sum/1024 " MB"}'
free -m | grep "^Mem:" | awk '{print "Available RAM: " $7 " MB"}'
```
**Expected:** Memory stable
**Verify:**
- No significant memory growth
- System RAM not exhausted

### Step 13: Stress Test with 100 More Tasks
**Action:** Add 100 tasks to test limits
```bash
echo "Adding 100 more tasks..."
for i in {76..175}; do
  beat run "echo 'Stress task $i'" --priority P2 2>/dev/null &
  # Small delay to prevent command overflow
  [ $((i % 10)) -eq 0 ] && wait
done
wait
```
**Expected:** System handles or rejects gracefully
**Verify:**
- No system crash
- Clear feedback if limit reached

### Step 14: Check Queue Limit Behavior
**Action:** Verify system behavior at limits
```bash
total=$(node dist/cli.js status | grep -c "task-")
echo "Total tasks after stress test: $total"
# Check for any error messages about queue full
grep -i "queue.*full\|limit\|maximum" .backbeat/logs/*.log 2>/dev/null | head -5 || echo "No queue limit messages found"
```
**Expected:** Graceful handling
**Verify:**
- Total count reported
- Any limit messages clear

### Step 15: Wait for Partial Completion
**Action:** Let some tasks complete
```bash
echo "Waiting 30 seconds for processing..."
sleep 30
completed=$(node dist/cli.js status | grep -c "completed")
echo "Tasks completed: $completed"
```
**Expected:** Progress made
**Verify:**
- Some tasks completed
- System still processing

### Step 16: Cleanup
**Action:** Clean up test artifacts
```bash
pkill -f "backbeat" || true
rm -rf .backbeat/
```
**Expected:** Cleanup successful
**Verify:**
- All processes terminated
- Database removed

## Success Criteria
- [ ] Queue accepts 50+ tasks without crash
- [ ] Memory usage remains bounded
- [ ] Database size stays reasonable
- [ ] Operations work under load
- [ ] No task loss or corruption
- [ ] System gracefully handles limits
- [ ] Workers continue processing
- [ ] Clear feedback when limits reached

## Rollback Plan
If test fails:
1. Force kill all processes: `pkill -9 -f node`
2. Clear database: `rm -rf .backbeat/`
3. Check system resources: `free -h && df -h`
4. Review queue implementation for memory leaks
5. Check max queue size configuration

## Notes
- Queue should handle 1000+ tasks ideally
- Memory usage should scale linearly with queue size
- Database WAL mode helps with concurrent writes
- Consider implementing queue size limits if needed