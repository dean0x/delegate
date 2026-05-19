# Security Review Report

**Branch**: feature/agent-config-passthrough -> main
**Date**: 2026-04-03T01:51:00Z

## Issues in Your Changes (BLOCKING)

### MEDIUM

**Missing baseUrl validation in CLI path** - `src/cli/commands/agents.ts:106`
**Confidence**: 85%
- Problem: The CLI `beat agents config set <agent> baseUrl <value>` accepts any string value and saves it directly to the config file without URL validation. The MCP path correctly validates with `z.string().url()` (line 250 in `mcp-adapter.ts`), but the CLI path skips validation entirely. A malformed or malicious URL (e.g., `file:///etc/passwd`, `javascript:alert(1)`, or a non-URL string) would be stored in config and later injected as the `ANTHROPIC_BASE_URL` / `OPENAI_BASE_URL` / `GEMINI_BASE_URL` environment variable for spawned agent processes.
- Fix: Add URL validation in the CLI path before calling `saveAgentConfig`:
```typescript
if (key === 'baseUrl') {
  try {
    new URL(value);
  } catch {
    ui.error(`Invalid URL for baseUrl: "${value}". Must be a valid URL (e.g. https://proxy.example.com/v1)`);
    process.exit(1);
  }
}
```

**Inconsistent model validation in JSON Schema inputSchema blocks** - `src/adapters/mcp-adapter.ts` (multiple locations)
**Confidence**: 82%
- Problem: Several JSON Schema `inputSchema` definitions for the `model` field omit `minLength` and `maxLength` constraints, while the corresponding Zod schemas correctly enforce `min(1).max(200)`. The JSON schemas are used by MCP clients for client-side validation and documentation. Inconsistent constraints between the two schemas mean that MCP clients relying on the JSON Schema may send values that pass client-side validation but would be rejected by the Zod parse. This is not exploitable (Zod is the server-side gate), but the inconsistency creates a discoverability gap -- the JSON Schema descriptions for DelegateTask (line ~564), ScheduleTask (line ~625), and ConfigureAgent (line ~1329) `model` fields lack `minLength`/`maxLength` while the `model` field in CreatePipeline inputSchema (line ~703) does include them. More importantly, for ConfigureAgent the JSON Schema for `model` does not enforce `minLength: 1` which means it would document that empty strings are acceptable, contradicting the Zod `.min(1)` constraint.
- Fix: Add `minLength: 1, maxLength: 200` to all `model` field definitions in inputSchema blocks for consistency with the Zod schemas. The inputSchema for ConfigureAgent `model` field at around line 1340 should be:
```typescript
model: {
  type: 'string',
  description: 'Default model for this agent (set action, overridden by per-task model)',
  minLength: 1,
  maxLength: 200,
},
```

## Issues in Code You Touched (Should Fix)

### MEDIUM

**baseUrl value leaks to CLI output without sanitization** - `src/cli/commands/agents.ts:154`, `src/adapters/mcp-adapter.ts` (ConfigureAgent check/set responses)
**Confidence**: 80%
- Problem: When displaying stored config via `beat agents config show` or the MCP `ConfigureAgent` check/set actions, the `baseUrl` value is echoed back in its entirety to stdout/JSON response. While this is generally acceptable for URLs, if the stored value contains unexpected characters (e.g., from a malformed save), it could produce confusing or misleading output. The `apiKey` field is correctly masked via `maskApiKey()`. The `baseUrl` field does not need masking (it is not a secret), but it should at minimum be displayed in a way that prevents terminal injection (control characters). Since the CLI uses `ui.note()` which writes to stderr and the MCP path uses `JSON.stringify()`, the actual risk is very low.
- Fix: Consider adding a basic sanitization for display (strip control characters) or accept current behavior as adequate given the URL validation recommended in the BLOCKING section above.

## Pre-existing Issues (Not Blocking)

No critical pre-existing security issues identified in the reviewed files.

## Suggestions (Lower Confidence)

- **Model string used directly in CLI arguments without sanitization** - `src/implementations/claude-adapter.ts:23`, `codex-adapter.ts`, `gemini-adapter.ts` (Confidence: 65%) -- The `model` value is passed as a CLI argument via `['--model', model]`. While `child_process.spawn()` with array arguments (not shell: true) prevents shell injection, an adversarial model name containing special characters could potentially cause unexpected behavior in the target CLI. The Zod `.max(200)` constraint limits length, and `.min(1)` prevents empty strings, which is reasonable. The risk is mitigated by the fact that model strings are opaque identifiers passed to the target CLI's own parsing.

- **No SSRF protection on baseUrl** - `src/implementations/base-agent-adapter.ts:75-85` (Confidence: 70%) -- The `baseUrl` from config is injected as an environment variable (e.g., `ANTHROPIC_BASE_URL`) and used by the spawned agent CLI to route API requests. If a user sets baseUrl to an internal network address (e.g., `http://169.254.169.254/latest/meta-data/`), the spawned agent process would make requests to that address. This is a user-configured value (requires explicit `beat agents config set` or `ConfigureAgent` MCP call), so the trust boundary is appropriate -- the user is already authenticated and running processes. However, in multi-tenant or shared environments, this could be a concern.

- **Config file permissions on write are correct** - `src/core/configuration.ts:194-196` (Confidence: 60%) -- The config file containing API keys, baseUrl, and model settings is written with `mode: 0o600` and the directory with `mode: 0o700`. This is good practice. The `chmodSync` call on line 196 ensures existing files also get the correct permissions. No issue found, noting as positive.

## Summary
| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 0 | 2 | 0 |
| Should Fix | 0 | 0 | 1 | 0 |
| Pre-existing | 0 | 0 | 0 | 0 |

**Security Score**: 8/10
**Recommendation**: APPROVED_WITH_CONDITIONS

Conditions:
1. Add URL validation for `baseUrl` in the CLI path (`src/cli/commands/agents.ts`) to match the MCP path's `z.string().url()` validation. This is the most actionable finding and closes a validation gap between two input surfaces.
2. Consider normalizing JSON Schema `inputSchema` model constraints to match the Zod schemas for consistency, though this is non-blocking.

Overall, the security posture of this PR is good:
- API keys remain properly masked and stored with secure file permissions (0o600)
- Input validation at the MCP boundary uses Zod schemas with appropriate constraints
- Process spawning uses `spawn()` with array arguments (no shell injection)
- The `baseUrl` is injected as an environment variable, not interpolated into shell commands
- The config file write path handles permissions correctly
- The `--` separator in CLI args prevents argument injection through prompts
