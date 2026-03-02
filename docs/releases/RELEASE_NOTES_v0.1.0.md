# 🚀 Backbeat v0.1.0 - Initial Release

## Introducing Backbeat: Your MCP Sidekick for Claude Code

Backbeat is an MCP (Model Context Protocol) server that enables Claude Code to delegate tasks to background Claude Code instances, allowing for true parallel task execution without context switching.

## ✨ Features

### Core Tools
- **DelegateTask**: Spawn background Claude Code processes with custom prompts
- **TaskStatus**: Monitor task execution state in real-time
- **TaskLogs**: Retrieve captured output from delegated tasks
- **CancelTask**: Gracefully terminate running tasks

### Advanced Capabilities
- **Custom Working Directories**: Control exactly where tasks execute
- **Git Worktree Isolation**: Run experimental changes in isolated environments
- **Auto-Permissions**: Skip file permission prompts with `--dangerously-skip-permissions`
- **Smart Output Capture**: 10MB buffer with overflow protection

## 📦 Installation

```bash
# Clone the repository
git clone https://github.com/dean0x/delegate.git
cd delegate

# Install and build
npm install
npm run build

# Test the installation
node dist/cli.js mcp test
```

## 🎯 Use Cases

- **Parallel Development**: Work on API while tests update in background
- **Bulk Refactoring**: Update imports across entire codebase
- **Documentation Generation**: Auto-generate docs while coding
- **Test Execution**: Run test suites without blocking development
- **Code Analysis**: Analyze codebase complexity in background

## 📊 Example Usage

In Claude Code, after configuring MCP:

```
Use DelegateTask to run: "Generate comprehensive API documentation"

Use TaskStatus to check the current task

Use TaskLogs to retrieve the output
```

With optional parameters:
```
Use DelegateTask with workingDirectory "/workspace/docs" to run: "Create README"

Use DelegateTask with useWorktree true to run: "Experimental refactor"
```

## 🔧 Configuration

Add to `~/.config/claude/mcp_servers.json`:

```json
{
  "mcpServers": {
    "delegate": {
      "command": "node",
      "args": ["/absolute/path/to/delegate/dist/index.js"],
      "env": {}
    }
  }
}
```

## 🖥️ CLI Usage

```bash
# Start the MCP server manually
delegate mcp start

# Test server startup and validation
delegate mcp test

# Show help
delegate help
```

## 📈 Performance

- Server startup: <100ms
- Tool response: <50ms
- Task execution: Variable based on task complexity
- Memory usage: ~45MB base

## 🚦 Current Limitations (MVP)

- Single task execution (no concurrency yet)
- In-memory state (no persistence)
- No task dependencies or priorities
- 30-minute timeout per task

## 🗺️ Roadmap

### v0.2.0 - Concurrency
- Multiple concurrent tasks (3-5)
- Task queue management
- Priority levels

### v0.3.0 - CLI Interface
- Direct task delegation: `beat delegate "task"`
- Status monitoring: `beat status`
- Log retrieval: `beat logs <id>`

### v0.4.0 - Persistence
- SQLite task history
- Resume after restart
- Task search and filtering

## 🤝 Contributing

We welcome contributions! Feel free to:
- Report bugs via [GitHub Issues](https://github.com/dean0x/delegate/issues)
- Suggest features
- Submit pull requests

## 📝 License

MIT License - see [LICENSE](./LICENSE) file for details

## 🙏 Acknowledgments

- Built with [Anthropic's MCP SDK](https://github.com/modelcontextprotocol/sdk)
- Developed with Claude Code
- Special thanks to the MCP community

## 📞 Support

- **Issues**: [GitHub Issues](https://github.com/dean0x/delegate/issues)
- **Documentation**: [Full Docs](./docs/)
- **Examples**: [Use Cases](./examples/use-cases.md)

## 🎉 Get Started

1. Clone and install Backbeat
2. Configure MCP in Claude Code
3. Start delegating tasks!

Ready to parallelize your Claude Code workflow? Let's go! 🚀

---

**Repository**: https://github.com/dean0x/delegate  
**Version**: 0.1.0  
**Release Date**: August 17, 2025