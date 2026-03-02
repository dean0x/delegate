# E2E Test Plan: Autoscaling Basic

## Test Metadata
- **Test ID:** E2E-009
- **Category:** Autoscaling
- **Priority:** P1
- **Estimated Duration:** 60 seconds
- **Dependencies:** System with at least 2 CPU cores

## Test Description
Verify basic autoscaling behavior: scale up when resources available and tasks pending, scale down when no tasks, respect min/max worker limits.

## Prerequisites
```yaml
preconditions:
  - Clean system state
  - CPU usage < 50%
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

### Step 3: Check System Resources
**Action:** Verify sufficient resources
```bash
nproc
free -m | grep "^Mem:" | awk '{print "Free RAM: " $4 " MB"}'
uptime | awk -F'load average:' '{print "Load average:" $2}'
```
**Expected:** Resources available
**Verify:**
- At least 2 CPU cores
- Free RAM > 1000 MB
- Load average < cores count

### Step 4: Create Initial Tasks
**Action:** Add tasks to trigger scaling
```bash
for i in {1..10}; do
  beat run "echo 'Scaling test $i' && sleep 5" --priority P1
done
```
**Expected:** 10 tasks queued
**Verify:**
- 10 task IDs returned
- Tasks in queue

### Step 5: Check Initial Workers
**Action:** Count worker processes after 2 seconds
```bash
sleep 2
ps aux | grep -E "claude.*worker" | grep -v grep | wc -l
```
**Expected:** 1+ workers spawned
**Verify:**
- At least 1 worker running
- Autoscaling started

### Step 6: Monitor Scale Up
**Action:** Watch workers scale up over 10 seconds
```bash
for i in {1..5}; do
  echo "=== Check $i (after ${i}s) ==="
  workers=$(ps aux | grep -E "claude" | grep -v grep | wc -l)
  echo "Active workers: $workers"
  echo "CPU Usage:"
  top -bn1 | head -5 | tail -2
  sleep 2
done
```
**Expected:** Worker count increases
**Verify:**
- Worker count grows (up to CPU limit)
- CPU usage increases
- Multiple workers running

### Step 7: Add More Tasks
**Action:** Add tasks to maintain scaling
```bash
for i in {11..20}; do
  beat run "echo 'Additional task $i' && sleep 3" --priority P1
done
```
**Expected:** More tasks queued
**Verify:**
- 10 more task IDs
- Queue has pending tasks

### Step 8: Check Max Workers
**Action:** Verify scaling respects limits
```bash
sleep 5
max_workers=$(ps aux | grep -E "claude" | grep -v grep | wc -l)
echo "Maximum workers reached: $max_workers"
cpu_percent=$(top -bn1 | grep "Cpu(s)" | awk '{print $2}' | cut -d'%' -f1)
echo "CPU usage: ${cpu_percent}%"
```
**Expected:** Scaling stops at limit
**Verify:**
- Workers <= system capacity
- CPU usage < 80%
- No excessive scaling

### Step 9: Wait for Task Completion
**Action:** Let all tasks complete
```bash
echo "Waiting for tasks to complete..."
timeout 60 bash -c 'while [ $(node dist/cli.js status | grep -c "queued\|running") -gt 0 ]; do sleep 2; done' || echo "Some tasks still active"
```
**Expected:** Tasks complete
**Verify:**
- Most tasks completed
- Queue emptying

### Step 10: Monitor Scale Down
**Action:** Watch workers scale down
```bash
echo "Monitoring scale down..."
for i in {1..10}; do
  workers=$(ps aux | grep -E "claude" | grep -v grep | wc -l)
  queued=$(node dist/cli.js status | grep -c "queued" || echo "0")
  echo "Check $i: Workers=$workers, Queued=$queued"
  [ $queued -eq 0 ] && [ $workers -eq 0 ] && echo "✓ Scaled down to zero" && break
  sleep 3
done
```
**Expected:** Workers terminate
**Verify:**
- Worker count decreases
- Eventually reaches 0
- Clean scale down

### Step 11: Test Min Workers Config
**Action:** Test with minimum worker setting
```bash
export BACKBEAT_MIN_WORKERS=2
for i in {1..5}; do
  beat run "echo 'Min worker test $i' && sleep 2" --priority P1
done
sleep 3
min_workers=$(ps aux | grep -E "claude" | grep -v grep | wc -l)
echo "Workers with MIN_WORKERS=2: $min_workers"
```
**Expected:** At least 2 workers
**Verify:**
- Workers >= 2
- Min limit respected

### Step 12: Test Max Workers Config
**Action:** Test maximum worker limit
```bash
export BACKBEAT_MAX_WORKERS=3
for i in {1..15}; do
  beat run "echo 'Max worker test $i' && sleep 5" --priority P1
done
sleep 5
max_workers=$(ps aux | grep -E "claude" | grep -v grep | wc -l)
echo "Workers with MAX_WORKERS=3: $max_workers"
[ $max_workers -le 3 ] && echo "✓ Max limit respected" || echo "✗ Max limit exceeded"
```
**Expected:** Max 3 workers
**Verify:**
- Workers <= 3
- Max limit enforced

### Step 13: Test Resource-Based Limits
**Action:** Check CPU threshold enforcement
```bash
# Create CPU load
stress --cpu 2 --timeout 10 &
sleep 2
# Try to scale
for i in {1..5}; do
  beat run "echo 'Resource limit test $i'" --priority P0
done
sleep 3
workers_under_load=$(ps aux | grep -E "claude" | grep -v grep | wc -l)
echo "Workers under high CPU load: $workers_under_load"
```
**Expected:** Limited scaling
**Verify:**
- Fewer workers spawn
- CPU limit respected

### Step 14: Cleanup
**Action:** Clean up test artifacts
```bash
unset BACKBEAT_MIN_WORKERS BACKBEAT_MAX_WORKERS
pkill -f "stress" || true
pkill -f "backbeat" || true
rm -rf .backbeat/
```
**Expected:** Cleanup successful
**Verify:**
- Environment cleared
- Processes terminated

## Success Criteria
- [ ] Workers scale up with pending tasks
- [ ] Workers scale down when idle
- [ ] Scaling respects CPU limits (< 80%)
- [ ] Min workers configuration works
- [ ] Max workers configuration works
- [ ] No excessive resource usage
- [ ] Clean worker termination
- [ ] Resource-based scaling works

## Rollback Plan
If test fails:
1. Kill all workers: `pkill -9 -f claude`
2. Clear environment: `unset BACKBEAT_MIN_WORKERS BACKBEAT_MAX_WORKERS`
3. Check CPU: `top -bn1`
4. Review autoscaling logic

## Notes
- Default scaling: 0 to CPU cores count
- CPU threshold: 80% (leaves 20% headroom)
- RAM threshold: 1GB free minimum
- Scale up delay: 5 seconds
- Scale down delay: 10 seconds