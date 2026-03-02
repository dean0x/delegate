# 🚀 Backbeat v0.2.2 - Enhanced Reliability & Developer Experience

## Major Features

- **🔄 Retry Logic with Exponential Backoff**: Smart retry mechanism for transient failures in git operations and GitHub API calls, improving reliability in unstable network conditions
- **🏷️ Process Naming**: Easy process identification with named processes (`beat-cli`, `beat-mcp`) and environment variables for workers, enabling better process management
- **🌳 Git Worktree Support**: Branch-based task isolation using git worktrees prevents conflicts between parallel tasks
- **🐙 GitHub Integration**: Automatic PR creation from task results with configurable merge strategies and custom PR titles/descriptions

## Improvements

- **CLI/MCP Parameter Alignment**: Full parameter parity between CLI and MCP tools
  - Added `--tail` parameter to logs command
  - Added `reason` parameter to cancel command
- **Error Handling**: Fixed deprecated `listTasks()` method usage in CLI status command
- **Process Management**: Workers now include `BACKBEAT_WORKER` environment variable with task ID
- **Documentation**: Comprehensive updates to README, ROADMAP, CLAUDE.md, and FEATURES.md

## Bug Fixes

- Fixed CLI commands not exiting properly after successful execution
- Corrected typo in `.gitignore` (`ouput` → `output`)
- Removed tracked `.docs` folder from git while preserving local files

## Developer Experience

- Task retry mechanism design documented for handling interrupted tasks
- Improved test configuration and fixed flaky tests
- All 135 tests passing consistently

## Breaking Changes

**None** - All changes are backward compatible

## Installation

```bash
npm install -g backbeat@0.2.2
```

## What's Next

- Implementation of automatic task retry on interruption
- Enhanced resource monitoring and adaptive scaling
- WebSocket support for real-time task updates

See [ROADMAP.md](./ROADMAP.md) for the complete list of upcoming features.

## Contributors

This release includes contributions from Claude Code 🤖

---

For more information, visit the [GitHub repository](https://github.com/dean0x/delegate)