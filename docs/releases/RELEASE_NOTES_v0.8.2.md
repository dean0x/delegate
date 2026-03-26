# Autobeat v0.8.2 — Package Rename

The npm package has been renamed from `backbeat` to `autobeat`. The CLI binary `beat` is unchanged — all commands work exactly as before.

---

## Breaking Changes

| Component | Before | After |
|-----------|--------|-------|
| npm package | `backbeat` | `autobeat` |
| Environment variables | `BACKBEAT_*` | `AUTOBEAT_*` |
| Data directory | `~/.backbeat/` | `~/.autobeat/` |
| Database file | `backbeat.db` | `autobeat.db` |
| Error class | `BackbeatError` | `AutobeatError` |
| Type guard | `isBackbeatError` | `isAutobeatError` |
| Converter | `toBackbeatError` | `toAutobeatError` |
| Event union | `BackbeatEvent` | `AutobeatEvent` |
| MCP server name | `backbeat` | `autobeat` |
| Config file | `~/.backbeat/config.json` | `~/.autobeat/config.json` |
| Patches dir | `.backbeat-patches/` | `.autobeat-patches/` |
| Log prefix | `[Backbeat]` | `[Autobeat]` |
| GitHub repo | `dean0x/backbeat` | `dean0x/autobeat` |

### What's Unchanged

- CLI binary: `beat` (all commands work as before)
- All MCP tool names (`DelegateTask`, `TaskStatus`, etc.)
- All functionality, features, and APIs
- SQLite schema and data format

---

## New: `beat migrate` Command

Automated migration from the old `backbeat` layout to `autobeat`. No database connection needed — pure filesystem operation.

### What it does:

1. **Data directory**: Moves `~/.backbeat/` → `~/.autobeat/`
2. **Database file**: Renames `backbeat.db` → `autobeat.db` (including WAL/SHM files)
3. **MCP configs**: Updates `backbeat` → `autobeat` server key in:
   - `.mcp.json` (cwd and home)
   - Claude Desktop config (`~/Library/Application Support/Claude/claude_desktop_config.json`)
4. **Env var reminder**: Scans shell profiles for `BACKBEAT_*` variables and prints which files need manual updates

### Safety:

- **Idempotent**: If `~/.backbeat/` doesn't exist, prints "nothing to migrate"
- **Conflict detection**: If both `~/.backbeat/` and `~/.autobeat/` exist, aborts with error
- **Non-destructive**: Only renames/moves — never deletes data

---

## Migration Guide

```bash
# 1. Install the new package
npm install -g autobeat
# (or: npm uninstall -g backbeat && npm install -g autobeat)

# 2. Run the migration
beat migrate

# 3. Update environment variables in shell profiles
# (beat migrate prints which files contain BACKBEAT_ variables)
# Replace BACKBEAT_ with AUTOBEAT_ manually

# 4. If using as a library, update imports:
#    BackbeatError → AutobeatError
#    isBackbeatError → isAutobeatError
#    toBackbeatError → toAutobeatError
#    BackbeatEvent → AutobeatEvent
```

---

## Environment Variables

| Before | After |
|--------|-------|
| `BACKBEAT_DATABASE_PATH` | `AUTOBEAT_DATABASE_PATH` |
| `BACKBEAT_DATA_DIR` | `AUTOBEAT_DATA_DIR` |
| `BACKBEAT_DEFAULT_AGENT` | `AUTOBEAT_DEFAULT_AGENT` |
| `BACKBEAT_WORKER` | `AUTOBEAT_WORKER` |
| `BACKBEAT_TASK_ID` | `AUTOBEAT_TASK_ID` |
| `BACKBEAT_LOOP_ID` | `AUTOBEAT_LOOP_ID` |
| `BACKBEAT_ITERATION` | `AUTOBEAT_ITERATION` |

No backward compatibility fallback is provided — this is a clean break. The `beat migrate` command handles the filesystem migration; update environment variables manually.
