# Autobeat v1.5.1 — Docs & Help Text Alignment

Patch release aligning CLI help text and documentation with v1.5.0 features.

---

## Summary

The v1.5.0 release introduced interactive orchestration, API translation proxy, Ollama runtime, and expanded agent configuration — but the CLI help output and top-level docs hadn't been updated to reflect them. This patch ships the aligned help text so `beat --help` documents all current capabilities.

---

## What's Changed Since v1.5.0

- Aligned CLI help text with v1.5.0 features: orchestrate commands, `--model`/`--system-prompt` flags, loop pause/resume, expanded agent config options (#161)
- Updated README and docs to match v1.5.0 feature set (#161)

---

## Migration Notes

No migration required. Documentation-only patch — no changes to runtime behavior, database, or APIs.

---

## Installation

```bash
npm install -g autobeat@1.5.1
```

Or via npx in your MCP config:

```json
{
  "mcpServers": {
    "autobeat": {
      "command": "npx",
      "args": ["-y", "autobeat@1.5.1", "mcp", "start"]
    }
  }
}
```

---

## Links

- [npm](https://www.npmjs.com/package/autobeat)
- [Documentation](https://github.com/dean0x/autobeat)
- [Issues](https://github.com/dean0x/autobeat/issues)
