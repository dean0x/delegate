# 🚀 Backbeat v0.2.1 - Event-Driven Architecture & CLI Interface

## Major Features

### 🖥️ Direct CLI Interface
No more MCP reconnections needed for testing! New commands:
```bash
delegate delegate "analyze the codebase for security issues"
delegate status                    # Check all tasks  
delegate status <task-id>          # Check specific task
delegate logs <task-id>            # Get task output
delegate cancel <task-id> "reason" # Cancel with reason
```

### 🏗️ Complete Event-Driven Architecture Overhaul
- **EventBus Coordination**: All components now communicate through events, not direct method calls
- **Zero Direct State Management**: TaskManager is purely event-driven
- **Specialized Event Handlers**:
  - `PersistenceHandler` - Database operations
  - `QueueHandler` - Task queue management  
  - `WorkerHandler` - Worker lifecycle
  - `OutputHandler` - Output capture and logs
- **Race Condition Elimination**: Event-driven design prevents worker pool races

## Critical Bug Fixes

### 🐛 Process Handling
- **Fixed Claude CLI Hanging**: Replaced stdin JSON injection hack with proper `stdio: ['ignore', 'pipe', 'pipe']`
- **Robust Process Spawning**: No more meaningless workarounds or stdin expectations

### 🐛 Exit Code Preservation
- **Fixed Success Status Bug**: Changed `code || null` to `code ?? null` to preserve exit code 0
- **Proper Task Completion**: Tasks now correctly complete with success status instead of failing

### 🐛 Event System
- **Fixed Missing TaskQueued Events**: Tasks were stuck in queued status due to missing event emissions
- **Singleton EventBus**: All components now share the same EventBus instance

## Documentation Overhaul

### 📚 Golden Circle Framework
- **README.md**: Applied Sinek's WHY → HOW → WHAT structure for better user engagement
- **Clear Problem Statement**: Specific pain points users face with sequential Claude Code execution
- **Compelling Vision**: Transform servers into AI powerhouses

### 📚 Complete Documentation Update
- **CLAUDE.md**: Rewritten to reflect event-driven architecture
- **FEATURES.md**: Updated with v0.2.1 capabilities and event patterns
- **CHANGELOG.md**: Consolidated and accurate version history

## Technical Improvements

### 🔧 Architecture
- **Event-Driven Coordination**: `TaskDelegated`, `TaskQueued`, `WorkerSpawned` events
- **Cleaner Separation**: Each handler has clear, isolated responsibilities
- **Better Error Handling**: Improved error propagation through Result pattern

### 🔧 Developer Experience  
- **Faster Testing**: CLI commands eliminate MCP reconnection overhead
- **Better Debugging**: Event flow easier to trace than direct method calls
- **Production Ready**: Significantly more stable and reliable

## Breaking Changes

**None** - All changes are internal architecture improvements. MCP tools remain fully compatible.

## Migration

- **Automatic**: No user action required
- **Backward Compatible**: All existing MCP tool usage continues to work
- **CLI Addition**: New CLI commands are additive features

## Installation

```bash
# Global installation (recommended)
npm install -g backbeat@0.2.1

# Or from source
git clone https://github.com/dean0x/delegate.git
cd delegate
npm install && npm run build
```

## What's Next

See [ROADMAP.md](./ROADMAP.md):
- **v0.3.0**: Task dependency resolution (Q4 2025)
- **v0.4.0**: Distributed processing (Q1 2026)

---

**Full Details**: [CHANGELOG.md](./CHANGELOG.md)  
**Repository**: https://github.com/dean0x/delegate  
**Issues**: [GitHub Issues](https://github.com/dean0x/delegate/issues)