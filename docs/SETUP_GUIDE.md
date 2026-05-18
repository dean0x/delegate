# Autobeat Setup Guide

## Quick Setup (2 minutes)

### Step 1: Build Autobeat
```bash
cd /workspace/autobeat
npm run build
```

### Step 2: Configure MCP

**Option A: Automatic Setup**
```bash
./setup-mcp.sh
```

**Option B: Manual Setup**

1. Check if config exists:
```bash
cat ~/.config/claude/mcp_servers.json
```

2. If it exists, ADD this to it:
```json
{
  "mcpServers": {
    "autobeat": {
      "command": "node",
      "args": ["/workspace/autobeat/dist/index.js"],
      "env": {
        "MOCK_MODE": "true"
      }
    }
  }
}
```

3. If it doesn't exist, create it:
```bash
mkdir -p ~/.config/claude
cp /workspace/autobeat/config/mcp-config-ready.json ~/.config/claude/mcp_servers.json
```

### Step 3: Start a New Coding Session

**Important**: Must be a NEW session, not `--continue`
```bash
# Exit current session
exit

# Start fresh session
claude "Let's test Autobeat MCP tools"
```

### Step 4: Test Integration

In the new coding session, try:

1. **Check available tools**:
   > "What MCP tools are available?"

2. **Test delegation**:
   > "Use DelegateTask to run: echo 'Autobeat is working!'"

3. **Check status**:
   > "Use TaskStatus to check the current task"

## Expected Behavior

When working correctly, you should see:
- 4 tools available: DelegateTask, TaskStatus, TaskLogs, CancelTask
- Task IDs in UUID format
- Mock output (since MOCK_MODE=true)

## Troubleshooting

### "Tools not found"
- Ensure NEW session (not --continue)
- Check config exists: `ls ~/.config/claude/mcp_servers.json`
- Verify path is correct: `/workspace/autobeat/dist/index.js`

### "Server won't start"
```bash
# Test directly
MOCK_MODE=true node /workspace/autobeat/dist/index.js

# Should see: "Autobeat MCP Server running"
```

### "Build errors"
```bash
npm run clean
npm install
npm run build
```

## Using a Real Agent CLI

To use with an actual agent CLI (not mock):
To use with an actual agent CLI (not mock):

1. Remove `"MOCK_MODE": "true"` from config
2. Ensure your chosen agent CLI is installed (e.g., `claude`, `codex`)
3. Test with real tasks
3. Test with real tasks

## What You Can Do Now

With Autobeat running, you can:

1. **Parallel Development**:
   > "Use DelegateTask to run: Update all test files while I work on the API"

2. **Long Running Tasks**:
   > "Use DelegateTask to run: Run the full test suite and create a report"
   > "Use TaskStatus to check progress"
   > "Use TaskLogs to see the output"

3. **Background Analysis**:
   > "Use DelegateTask to run: Analyze all TypeScript files for potential issues"

4. **Cancel If Needed**:
   > "Use CancelTask with taskId: <id> and reason: Taking too long"

## Verification Commands

```bash
# Check if MCP config exists
ls -la ~/.config/claude/mcp_servers.json

# View current config
cat ~/.config/claude/mcp_servers.json

# Test server directly
MOCK_MODE=true timeout 5 node /workspace/autobeat/dist/index.js

# Run full validation
npm run validate
```

## Success!

Once you see the tools in your MCP client, Autobeat is ready!
You can now delegate tasks to background AI agent instances.

---

**Need help?** 
- Check logs: `npm run dev`
- Run tests: `npm run test:mock`
- Validate setup: `npm run validate`