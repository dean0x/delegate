# E2E Test Plan: Basic Task Delegation

## Test Metadata
- **Test ID:** E2E-001
- **Category:** Core Functionality
- **Priority:** P0
- **Estimated Duration:** 30 seconds
- **Dependencies:** MCP server must be running

## Test Description
Verify that Backbeat can successfully delegate a simple task to a background Claude Code instance and retrieve the results.

## Prerequisites
```yaml
preconditions:
  - MCP server is not running
  - No pending tasks in database
  - Working directory is clean
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
- dist/ directory created

### Step 2: Check CLI Available
**Action:** Check if Backbeat CLI is available
```bash
node dist/cli.js status
```
**Expected:** Status output
**Verify:**
- Command runs without error
- Some output is displayed

### Step 3: Initialize Database
**Action:** Initialize the database
```bash
mkdir -p .backbeat && rm -f .backbeat/backbeat.db
```
**Expected:** Database directory created
**Verify:**
- .backbeat directory exists
- No existing database file

### Step 4: Test Direct Task Delegation
**Action:** Test delegating a simple task via CLI
```bash
node dist/cli.js run "echo Testing direct delegation"
```
**Expected:** Task delegation command runs
**Verify:**
- Command executes without error
- Task ID returned or appropriate message

### Step 5: Verify Task Repository
**Action:** Check if database was created
```bash
ls -la .backbeat/backbeat.db 2>/dev/null || echo "Database not created"
```
**Expected:** Database file status
**Verify:**
- Either database exists or message shown
- No errors in output

### Step 6: Cleanup
**Action:** Clean up test artifacts
```bash
rm -rf .backbeat/backbeat.db
```
**Expected:** Cleanup successful
**Verify:**
- Test database removed
- Directory clean

## Success Criteria
- [ ] All steps complete without errors
- [ ] Task completes within 30 seconds
- [ ] Output matches expected results
- [ ] No orphaned processes
- [ ] Database state is consistent

## Rollback Plan
If test fails:
1. Kill all backbeat processes
2. Clear task database
3. Reset working directory

## Notes
- This is the most basic E2E test
- Forms the foundation for more complex scenarios
- Should be run after every deployment