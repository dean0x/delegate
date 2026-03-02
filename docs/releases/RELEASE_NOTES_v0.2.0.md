# 🚀 Backbeat v0.2.0 - Task Persistence & Stability

## Major Features

### ✨ Task Persistence
- **SQLite-based persistence**: All tasks are now stored in a local SQLite database
- **Automatic recovery**: Tasks queued before a crash are automatically re-queued on startup
- **Platform-specific storage**: 
  - Unix/Mac: `~/.backbeat/backbeat.db`
  - Windows: `%APPDATA%/delegate/backbeat.db`
- **Task history**: Complete history of all delegated tasks with status, logs, and metadata

### 🔧 MCP Connection Stability
- **Fixed stdout/stderr separation**: Logs now properly go to stderr, keeping stdout clean for MCP protocol
- **Improved CLI integration**: Fixed dynamic import issues for reliable MCP server startup
- **Better error handling**: Graceful handling of connection issues and proper error reporting

### 🎯 Claude CLI Integration
- **Corrected CLI flags**: Using `--print` for non-interactive mode (not `--no-interaction`)
- **Proper prompt passing**: Prompts now passed as command arguments with `--print` flag
- **Maintained permission bypass**: `--dangerously-skip-permissions` for automated execution

## Architecture Improvements

### SOLID Refactoring
- **Dependency Injection**: Complete DI container implementation
- **Result Types**: Functional error handling without exceptions
- **Clean Interfaces**: Well-defined contracts between components
- **Immutable State**: No mutations, always return new objects
- **Composable Functions**: Pipe-based function composition

### Database Design
- **WAL mode**: Write-Ahead Logging for better concurrency
- **Prepared statements**: Efficient and secure database operations
- **Automatic migrations**: Database schema created automatically
- **Output overflow handling**: Large outputs (>100KB) stored as files

## Bug Fixes
- Fixed MCP server connection issues
- Resolved Claude CLI command execution errors
- Fixed process spawning with correct arguments
- Corrected logging to avoid stdout pollution
- Fixed task recovery on startup

## Breaking Changes
- None - fully backward compatible with v0.1.x

## Migration Guide
No migration needed. The database will be created automatically on first run.

## What's Next
- Phase 2: Git worktree support for isolated task execution
- Phase 3: Web dashboard for task monitoring
- Phase 4: Task dependencies and chaining
- Phase 5: Distributed execution across multiple machines

## Installation

```bash
# npm
npm install -g backbeat

# or use npx
npx backbeat mcp start
```

## Configuration

Add to your MCP configuration:

```json
{
  "mcpServers": {
    "delegate": {
      "command": "delegate",
      "args": ["mcp", "start"]
    }
  }
}
```

## Contributors
- Initial implementation and architecture
- SOLID refactoring and persistence layer
- MCP protocol fixes and stability improvements

---

For detailed documentation, visit: https://github.com/dean0x/delegate