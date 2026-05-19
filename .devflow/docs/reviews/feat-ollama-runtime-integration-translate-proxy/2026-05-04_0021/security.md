# Security Review Report

**Branch**: feat/ollama-runtime-integration-translate-proxy -> main
**Date**: 2026-05-04
**PR**: #157

## Issues in Your Changes (BLOCKING)

### CRITICAL

(none)

### HIGH

(none)

### MEDIUM

**`--yes` flag auto-accepts ollama prompts without user awareness** - `src/implementations/base-agent-adapter.ts:205`
**Confidence**: 82%
- Problem: The `--yes` flag passed to `ollama launch` auto-accepts all interactive prompts (e.g., model download, EULA acceptance). When a user configures `runtime: 'ollama'` with a model name, ollama may download large model files (multi-GB) from the internet without explicit user confirmation at spawn time. This is a consent and bandwidth concern rather than a direct vulnerability, but it means configuring a model name could trigger large automatic downloads on the host system.
- Fix: Document the `--yes` behavior in the MCP instructions and CLI help text so users are aware. Consider adding a `beat agents config set claude runtime ollama` CLI note that mentions automatic model downloading. No code change strictly required since `--yes` is necessary for non-interactive spawns, but user awareness is the mitigation.

## Issues in Code You Touched (Should Fix)

(none)

## Pre-existing Issues (Not Blocking)

### MEDIUM

**CLI `model` config value is not validated against the MCP regex** - `src/cli/commands/agents.ts:175`
**Confidence**: 82%
- Problem: The MCP adapter validates model names with `/^[a-zA-Z0-9._-]+$/` (via `modelSchema`), but the CLI `beat agents config set <agent> model <value>` path passes the value directly to `saveAgentConfig` without regex validation. A model name like `../../../etc/passwd` could be saved to config. This is not exploitable because `child_process.spawn` passes args as arrays (no shell interpolation), and ollama's `--model` flag also takes it as a simple string argument. However, it is an inconsistency in boundary validation between the two input paths (MCP vs CLI).
- Fix: Add the same regex validation to the CLI path for model values, matching the MCP boundary schema.

**No Ollama model name validation at the boundary** - `src/implementations/base-agent-adapter.ts:201-202`
**Confidence**: 80%
- Problem: The `effectiveModel` value (from `taskModel` or `agentConfig.model`) is passed to ollama `--model` without validating it matches Ollama's model naming conventions (e.g., `namespace/model:tag`). While the MCP path validates model names with a strict regex, the stored config path (via CLI) allows arbitrary strings. Since `spawn()` uses array-based args (not shell), this cannot cause command injection, but passing a malformed model name to `ollama launch --model` would produce confusing errors at runtime rather than a clear validation message at config time.
- Fix: Share the `modelSchema` regex validation across both MCP and CLI boundaries, or validate in `resolveRuntime` before passing to spawn args.

## Suggestions (Lower Confidence)

- **Runtime-proxy mutual exclusivity enforced only as warning** - `src/bootstrap.ts:413-415`, `src/adapters/mcp-adapter.ts:3648` (Confidence: 65%) -- When both `runtime` and `proxy` are configured, the system warns but proceeds with `runtime` taking precedence. A misconfigured user might not notice the warning and wonder why their proxy is not being used. Consider making this an error at bootstrap time rather than a warning, or at minimum log at WARN level during bootstrap.

- **Ollama availability not verified at config time** - `src/cli/commands/agents.ts:100-103` (Confidence: 62%) -- The CLI `check` subcommand shows whether ollama is found in PATH, but `config set runtime ollama` succeeds even when ollama is not installed. The error surfaces only at spawn time. Consider adding a non-blocking warning during `config set` when the runtime binary is not found.

- **Non-assertive `this.proxyUrl!` usage after null check** - `src/translation/proxy/proxy-manager.ts:118,157` (Confidence: 70%) -- Two `this.proxyUrl!` non-null assertions appear where the property should always be defined (port is set). While not a security vulnerability, non-null assertions can mask bugs if the code path changes. A local variable capturing the URL string would be safer.

## Summary

| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 0 | 1 | 0 |
| Should Fix | 0 | 0 | 0 | 0 |
| Pre-existing | 0 | 0 | 2 | 0 |

**Security Score**: 9/10
**Recommendation**: APPROVED_WITH_CONDITIONS

### Security Assessment

This PR is well-designed from a security perspective:

1. **No command injection risk**: All process spawning uses `child_process.spawn` with array-based arguments (no shell interpolation). The `runtimeConfig.command` is always the hardcoded string `'ollama'`, and `this.command` is always one of `'claude'`/`'codex'`/`'gemini'`.

2. **Strong boundary validation**: The `runtime` field is validated via Zod enum at the MCP boundary (only `'ollama'` or `''` accepted) and via `RUNTIME_TARGETS` array check at the CLI boundary. The `RUNTIME_AGENT_SUPPORT` compatibility check prevents unsupported agent-runtime combinations.

3. **Proper auth suppression**: When runtime handles auth (`suppressAuth: true`), stored API keys are not leaked into the child process environment. The `suppressBaseUrl` flag similarly prevents injecting a stale base URL that would conflict with ollama's routing.

4. **Config file security preserved**: The existing `0o700` directory and `0o600` file permissions are maintained. No new paths are introduced for config storage.

5. **Exhaustive runtime guard**: The `never` type exhaustive check at line 214 ensures any future runtime additions must be explicitly handled, preventing silent fallthrough.

6. **Existing security patterns respected**: The orchestratorId regex validation, env var stripping, and AUTOBEAT_ prefix preservation all continue to work correctly through the runtime path.

The single blocking MEDIUM is a user-awareness issue (auto-download behavior), not a vulnerability. The pre-existing model validation gap is worth addressing but predates this PR.
