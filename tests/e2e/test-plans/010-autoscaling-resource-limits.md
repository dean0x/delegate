# E2E Test Plan: Autoscaling Resource Limits

## Test Metadata
- **Test ID:** E2E-010
- **Category:** Autoscaling
- **Priority:** P1
- **Estimated Duration:** 45 seconds
- **Dependencies:** stress tool, 2+ CPU cores

## Test Description
Test autoscaling behavior under resource constraints: stop scaling when CPU > 80%, stop when RAM < 1GB free, verify resource monitoring accuracy.

## Prerequisites
```yaml
preconditions:
  - stress tool installed (apt install stress)
  - Clean system state
  - At least 2GB total RAM
  - Build completed successfully
```

## Test Steps

### Step 1: Install Stress Tool
**Action:** Ensure stress tool available
```bash
which stress || echo "stress tool not found - install with: apt install stress"
```
**Expected:** Stress tool path shown
**Verify:**
- Tool available
- Or installation message shown

### Step 2: Clean State
**Action:** Ensure clean starting state
```bash
rm -rf .backbeat/
pkill -f "backbeat" || true
pkill -f "stress" || true
```
**Expected:** Clean state achieved
**Verify:**
- No existing database
- No running processes

### Step 3: Build Project
**Action:** Build the TypeScript project
```bash
npm run build
```
**Expected:** Build completes successfully
**Verify:**
- No TypeScript errors
- dist/ directory exists

### Step 4: Baseline Resource Check
**Action:** Record baseline resources
```bash
echo "=== Baseline Resources ==="
nproc
free -m | grep "^Mem:"
top -bn1 | grep "Cpu(s)" | head -1
```
**Expected:** Baseline recorded
**Verify:**
- CPU cores shown
- Memory values shown
- CPU idle > 50%

### Step 5: Create High CPU Load
**Action:** Use stress to consume CPU
```bash
# Use cores-1 to leave some headroom
cores=$(nproc)
stress_cores=$((cores - 1))
stress --cpu $stress_cores --timeout 60 &
STRESS_PID=$!
echo "Started stress with PID: $STRESS_PID"
sleep 3
```
**Expected:** CPU load created
**Verify:**
- Stress process running
- PID captured

### Step 6: Check CPU Usage
**Action:** Verify high CPU usage
```bash
top -bn1 | grep "Cpu(s)" | head -1
ps aux | grep stress | grep -v grep | head -2
```
**Expected:** CPU usage > 80%
**Verify:**
- High CPU utilization
- Stress processes visible

### Step 7: Attempt Scaling Under CPU Load
**Action:** Create tasks while CPU loaded
```bash
for i in {1..5}; do
  beat run "echo 'CPU limit test $i' && sleep 3" --priority P0
done
```
**Expected:** Tasks created
**Verify:**
- 5 task IDs returned
- Tasks queued

### Step 8: Verify Limited Scaling
**Action:** Check worker count under CPU load
```bash
sleep 5
workers=$(ps aux | grep -E "claude" | grep -v grep | wc -l)
echo "Workers under CPU load: $workers"
[ $workers -le 2 ] && echo "✓ Scaling limited by CPU" || echo "⚠ More workers than expected"
```
**Expected:** Minimal workers
**Verify:**
- Few workers spawned (1-2)
- CPU limit enforced

### Step 9: Stop CPU Load
**Action:** Kill stress process
```bash
kill $STRESS_PID 2>/dev/null || pkill -f "stress"
sleep 3
echo "CPU load removed"
top -bn1 | grep "Cpu(s)" | head -1
```
**Expected:** CPU usage drops
**Verify:**
- Stress process terminated
- CPU usage < 50%

### Step 10: Verify Scaling Resumes
**Action:** Check if scaling resumes
```bash
sleep 5
workers_after=$(ps aux | grep -E "claude" | grep -v grep | wc -l)
echo "Workers after CPU load removed: $workers_after"
[ $workers_after -gt 2 ] && echo "✓ Scaling resumed" || echo "⚠ Scaling not resumed"
```
**Expected:** More workers spawn
**Verify:**
- Worker count increases
- Normal scaling resumed

### Step 11: Create Memory Pressure
**Action:** Consume RAM to test memory limits
```bash
# Get available memory in MB
available=$(free -m | grep "^Mem:" | awk '{print $7}')
# Leave only 800MB free
consume=$((available - 800))
if [ $consume -gt 0 ]; then
  stress --vm 1 --vm-bytes ${consume}M --timeout 30 &
  MEM_STRESS_PID=$!
  echo "Consuming ${consume}MB RAM, PID: $MEM_STRESS_PID"
else
  echo "Not enough RAM to test memory limits safely"
fi
sleep 3
```
**Expected:** Memory consumed
**Verify:**
- Memory stress started
- Available RAM < 1GB

### Step 12: Check Memory Status
**Action:** Verify low available memory
```bash
free -m | grep "^Mem:" | awk '{print "Available: " $7 " MB"}'
```
**Expected:** Available < 1000 MB
**Verify:**
- Low available memory
- System still responsive

### Step 13: Test Scaling Under Memory Pressure
**Action:** Try to scale with low memory
```bash
for i in {1..5}; do
  beat run "echo 'Memory limit test $i' && sleep 2" --priority P0
done
sleep 5
workers_low_mem=$(ps aux | grep -E "claude" | grep -v grep | wc -l)
echo "Workers under memory pressure: $workers_low_mem"
```
**Expected:** Limited scaling
**Verify:**
- Few workers spawn
- Memory limit respected

### Step 14: Release Memory
**Action:** Stop memory stress
```bash
[ ! -z "$MEM_STRESS_PID" ] && kill $MEM_STRESS_PID 2>/dev/null
pkill -f "stress.*vm" || true
sleep 3
free -m | grep "^Mem:" | awk '{print "Available after release: " $7 " MB"}'
```
**Expected:** Memory released
**Verify:**
- Memory stress stopped
- Available RAM increased

### Step 15: Test Combined Limits
**Action:** Test CPU and memory limits together
```bash
# Moderate CPU load
stress --cpu 1 --timeout 15 &
# Moderate memory load
stress --vm 1 --vm-bytes 500M --timeout 15 &
sleep 2

for i in {1..3}; do
  beat run "echo 'Combined limit test $i'" --priority P0
done

sleep 5
workers_combined=$(ps aux | grep -E "claude" | grep -v grep | wc -l)
echo "Workers under combined load: $workers_combined"
```
**Expected:** Very limited scaling
**Verify:**
- Minimal workers (1-2)
- Both limits respected

### Step 16: Cleanup
**Action:** Clean up all test artifacts
```bash
pkill -f "stress" || true
pkill -f "backbeat" || true
rm -rf .backbeat/
```
**Expected:** Cleanup successful
**Verify:**
- All stress stopped
- Processes terminated

## Success Criteria
- [ ] CPU limit (80%) prevents scaling
- [ ] Memory limit (1GB free) prevents scaling
- [ ] Scaling resumes when resources available
- [ ] Resource monitoring is accurate
- [ ] Combined limits work correctly
- [ ] No system instability under load
- [ ] Graceful handling of resource constraints
- [ ] Workers don't crash under pressure

## Rollback Plan
If test fails:
1. Kill all stress: `pkill -9 stress`
2. Kill all workers: `pkill -9 -f claude`
3. Clear memory cache: `sync && echo 3 > /proc/sys/vm/drop_caches`
4. Check system: `free -h && top -bn1`

## Notes
- CPU threshold: 80% (configurable)
- Memory threshold: 1GB free (configurable)
- Resource check interval: 5 seconds
- Scale decision based on both CPU and RAM
- Should prevent system exhaustion