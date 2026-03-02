# 🚀 Backbeat v0.4.0 - Latest Release

See [RELEASE_NOTES_v0.4.0.md](./RELEASE_NOTES_v0.4.0.md) for the latest release notes.

## Previous Releases
- [v0.3.0](./RELEASE_NOTES_v0.3.0.md) - Task Dependencies & DAG Support
- [v0.2.0](./RELEASE_NOTES_v0.2.0.md) - Concurrent Execution & Auto-scaling
- [v0.1.0](./RELEASE_NOTES_v0.1.0.md) - Initial Release

---

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

# Setup MCP configuration
./setup-mcp.sh
```

## 🎯 Use Cases

- **Parallel Development**: Work on API while tests update in background
- **Bulk Refactoring**: Update imports across entire codebase
- **Documentation Generation**: Auto-generate docs while coding
- **Test Execution**: Run test suites without blocking development
- **Code Analysis**: Analyze codebase complexity in background

## 📊 Example Usage

```javascript
// Delegate a task with custom directory
Use DelegateTask with:
- prompt: "Generate comprehensive API documentation"
- workingDirectory: "/workspace/docs"

// Check status
Use TaskStatus to monitor progress

// Get results
Use TaskLogs to retrieve the documentation
```

## 🔧 Configuration

Add to `~/.config/claude/mcp_servers.json`:

```json
{
  "mcpServers": {
    "delegate": {
      "command": "node",
      "args": ["/path/to/delegate/dist/index.js"],
      "env": {}
    }
  }
}
```

## 📈 Performance

- Server startup: <100ms
- Tool response: <50ms
- Task execution: 7-40s (depends on complexity)
- Memory usage: ~45MB base

## 🚦 Current Limitations

- Single task execution (concurrency coming in v0.2.0)
- 30-minute timeout per task
- Tasks don't persist across restarts (yet)

## 🗺️ Roadmap

### v0.2.0 (Next Week)
- Concurrent task execution (3-5 tasks)
- Task queue with FIFO processing
- ListTasks tool for overview

### v0.3.0 (2 Weeks)
- CLI interface for terminal usage
- Task persistence with SQLite
- Auto-retry for failed tasks

## 🤝 Contributing

Contributions are welcome! Please check out our [contributing guidelines](./CONTRIBUTING.md) and feel free to:
- Report bugs
- Suggest features
- Submit pull requests

## 📝 License

MIT License - see [LICENSE](./LICENSE) file for details

## 🙏 Acknowledgments

- Built with the [Model Context Protocol SDK](https://modelcontextprotocol.io)
- Created with Claude Code
- Special thanks to early testers and contributors

## 📞 Support

- **Issues**: [GitHub Issues](https://github.com/dean0x/delegate/issues)
- **Documentation**: [Full Docs](./docs/)
- **Examples**: [Use Cases](./examples/use-cases.md)

## 🎉 Get Started

1. Install Backbeat
2. Configure MCP
3. Start delegating tasks!

Ready to parallelize your development workflow? Let's go! 🚀

---

**Repository**: https://github.com/dean0x/delegate  
**Version**: 0.1.0  
**Release Date**: August 16, 2024