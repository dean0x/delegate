# Autobeat v1.5.2 — RETRY Loop Progress Preservation

Patch release fixing RETRY loop iterations that destroyed accumulated work on exit-condition-not-met results.

---

## Summary

RETRY loop iterations that completed their task successfully but didn't satisfy the exit condition were resetting the working directory via `git reset --hard` back to the loop start commit — destroying all accumulated progress from prior iterations. This affected orchestrators (rebuilding from scratch each iteration), test coverage loops (losing written tests), and any multi-step retry workflow in a git-tracked repository.

---

## What's Changed Since v1.5.1

- New `progress` iteration status for RETRY iterations that made forward progress but didn't satisfy the exit condition — commits work instead of resetting (#163)
- Crash recovery (`TaskFailed`) now resets to `preIterationCommitSha` instead of `gitStartCommitSha`, preserving progress from prior iterations (#163)
- `consecutiveFailures` now only tracks actual crashes (`TaskFailed`), not exit-condition-not-met iterations (#163)
- Dashboard UI: `progress` status displayed with cyan color and circle icon (#163)
- Migration v26: recreates `loop_iterations` table with updated CHECK constraint for `progress` status

---

## Database

- **Migration v26**: Recreates `loop_iterations` with updated CHECK constraint adding `progress` to the status enum. Auto-applied on startup.

---

## Migration Notes

No manual migration required. Migration v26 auto-applies on first startup. No breaking changes — `fail` status remains valid for `TaskFailed` events. OPTIMIZE strategy is completely untouched.

---

## Installation

```bash
npm install -g autobeat@1.5.2
```

Or use via npx in your Claude MCP config:

```json
{
  "mcpServers": {
    "autobeat": {
      "command": "npx",
      "args": ["-y", "autobeat@1.5.2", "mcp", "start"]
    }
  }
}
```

---

## Links

- [npm](https://www.npmjs.com/package/autobeat/v/1.5.2)
- [GitHub Release](https://github.com/dean0x/autobeat/releases/tag/v1.5.2)
- [Documentation](https://github.com/dean0x/autobeat#readme)
- [Issues](https://github.com/dean0x/autobeat/issues)
