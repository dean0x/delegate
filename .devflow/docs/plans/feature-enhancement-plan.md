# Feature Enhancement Plan - Addressing Current Limitations

## Current Limitations (from README)
1. One task at a time (no queue or concurrency)
2. No persistence (tasks lost on restart)
3. 30-minute timeout per task
4. 10MB output buffer limit
5. No git worktree isolation (this was actually implemented but README needs updating)

## Prioritized Feature Enhancements

### Priority 1: Concurrency & Queue (Most impactful)
**Why First**: This would allow multiple background tasks, dramatically improving productivity

Implementation Plan:
- Add TaskQueue class with configurable max workers (default 3)
- Implement queue status showing pending/running tasks
- Add priority levels (P0 = critical, P1 = high, P2 = normal)
- Resource management per task
- Prevent resource exhaustion
- Add ListTasks tool to show all tasks in queue

Technical Details:
- Use worker pool pattern
- Implement semaphore for concurrency control
- Add queue persistence for crash recovery
- Memory/CPU limits per task

### Priority 2: Task Persistence (Reliability)
**Why Second**: Tasks should survive server restarts for reliability

Implementation Plan:
- SQLite database for task history
- Resume interrupted tasks on restart
- Query past task results
- Export task logs
- Task search and filtering
- Automatic cleanup of old tasks (30 days)

Database Schema:
- tasks table: id, prompt, status, created_at, started_at, completed_at, exit_code
- task_logs table: task_id, output, errors, timestamp
- task_metadata table: task_id, working_directory, use_worktree, etc.

### Priority 3: Configuration Improvements
**Why Third**: Make limits configurable for different use cases

Implementation Plan:
- Adjustable timeout (default 30min, max 2hrs)
- Configurable output buffer size (default 10MB, max 100MB)
- Max concurrent tasks setting
- Resource limits per task (CPU, memory)
- Configuration via environment variables or config file

Config Structure:
```json
{
  "maxConcurrentTasks": 3,
  "defaultTimeout": 1800000,
  "maxTimeout": 7200000,
  "outputBufferSize": 10485760,
  "resourceLimits": {
    "maxMemoryMB": 512,
    "cpuShares": 1024
  }
}
```

### Priority 4: Enhanced Task Management
**Why Fourth**: Advanced features for power users

Implementation Plan:
- Cancel multiple tasks at once
- Task dependencies (task B waits for task A)
- Scheduled tasks (cron-like)
- Task templates/presets
- Task grouping and batch operations
- Task result webhooks

### Priority 5: Bug Fixes & Polish
- Fix README to mention git worktree is implemented
- Better error messages
- Improved logging
- Health check endpoint
- Metrics endpoint

## Implementation Timeline

### Phase 1 (Week 1-2): Concurrency MVP
- Basic queue implementation
- 3 concurrent tasks max
- Simple FIFO queue
- Update MCP tools for queue management

### Phase 2 (Week 3-4): Persistence
- SQLite integration
- Basic CRUD operations
- Resume on restart
- Task history

### Phase 3 (Week 5-6): Configuration
- Config file support
- Environment variables
- Dynamic limits
- Validation

### Phase 4 (Week 7-8): Polish
- Testing
- Documentation
- Examples
- Performance optimization

## Success Metrics
- Support 5+ concurrent tasks without issues
- <100ms response time for status checks
- Zero task loss on restart
- 95% task completion rate
- <500ms queue operation latency

## Technical Considerations
- Use Promise.all with concurrency limit
- Implement proper cleanup on shutdown
- Add graceful shutdown with task completion
- Memory leak prevention
- Proper error boundaries

## Breaking Changes
- None expected - all changes backward compatible
- New optional parameters only
- Existing single-task mode remains default