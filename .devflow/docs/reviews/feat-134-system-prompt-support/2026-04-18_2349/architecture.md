# Architecture Review Report

**Branch**: feat/134-system-prompt-support -> main
**Date**: 2026-04-18

## Issues in Your Changes (BLOCKING)

### HIGH

**Duplicated operational knowledge between systemPrompt and operationalContract** - `src/services/orchestrator-prompt.ts:56-161`
**Confidence**: 85%
- Problem: The `operationalContract` (lines 141-159) is a manually maintained subset of the `systemPrompt` (lines 56-134). The state file path, working directory, beat CLI commands, and constraints are copy-pasted rather than composed from shared fragments. When the full systemPrompt is updated (e.g., new CLI commands, changed constraint names), the operationalContract must be manually kept in sync. This is a DRY violation that will drift over time.
- Fix: Extract the shared operational sections (state file, working dir, CLI commands, constraints) into a helper function or template literals, then compose both `systemPrompt` and `operationalContract` from those shared pieces:
  ```typescript
  const stateFileSection = `STATE FILE: ${stateFilePath}\n...`;
  const cliCommandsSection = `DELEGATION (via beat CLI):\n...`;
  const constraintsSection = `CONSTRAINTS:\n...`;
  
  const operationalContract = `REQUIRED -- ORCHESTRATOR CONTRACT:\n\n${stateFileSection}\n${cliCommandsSection}\n${constraintsSection}`;
  const systemPrompt = `ROLE: ...\n\n${stateFileSection}\n\n...full sections...\n\n${constraintsSection}\n\n...`;
  ```

## Issues in Code You Touched (Should Fix)

### MEDIUM

**GeminiBasePromptCache uses synchronous I/O (mkdirSync/writeFileSync/unlinkSync) on the spawn path** - `src/implementations/gemini-adapter.ts:32,60,71`
**Confidence**: 82%
- Problem: The `buildCombinedFile()` method calls `writeFileSync()` and `mkdirSync()` synchronously. These are called from `GeminiAdapter.spawn()`, which is invoked from `EventDrivenWorkerPool.spawn()` -- a method on the main event loop path. Synchronous filesystem calls block the event loop and can cause latency spikes under load, especially if the filesystem is slow (network mount, high I/O contention). The constructor also calls `mkdirSync` synchronously, but that is acceptable for one-time initialization.
- Fix: This is a known architectural exception noted in the prior review (deferred as "cache class extraction"). The recommendation stands: convert `buildCombinedFile` to async (`writeFile` from `fs/promises`) and propagate the async boundary up through `getSystemPromptConfig` and `spawn`. This is a non-trivial refactor deferred for a follow-up.

## Pre-existing Issues (Not Blocking)

### MEDIUM

**`cleanupWorkerState` performs adapter registry lookup on cleanup path** - `src/implementations/event-driven-worker-pool.ts:307-318`
**Confidence**: 80%
- Problem: The `cleanupWorkerState` method resolves the adapter via `this.agentRegistry.get(worker.task.agent ?? 'claude')` to call `cleanup()`. This is a runtime lookup in what should be a fast, deterministic cleanup path. If the registry was disposed or the adapter was deregistered between spawn and completion (e.g., during hot-reload or shutdown), the lookup would fail silently (the `if (agentResult.ok)` guard swallows the failure). The `?? 'claude'` fallback also masks missing agent assignment -- it should have been caught by the guard in `spawn()`.
- Fix: Store the adapter reference (or just the cleanup function) on the `WorkerState` at spawn time, removing the need for a runtime registry lookup during cleanup. The `?? 'claude'` fallback is harmless in practice because `spawn()` already guards against missing agent, but it could be replaced with a non-null assertion or the stored reference.

## Suggestions (Lower Confidence)

- **Operational contract completeness gap** - `src/services/orchestrator-prompt.ts:141-159` (Confidence: 70%) -- The `operationalContract` omits several sections from the full systemPrompt that may be important for agent functioning with a custom system prompt: LOOP MANAGEMENT, AGENT EVAL MODE, DECISION PROTOCOL, VALIDATION PATTERN, CI FEEDBACK PATTERN, CONFLICT AVOIDANCE, WORKER ISOLATION, and RESILIENCE. If a user provides a custom systemPrompt, their agent loses all of these capabilities. Consider whether the contract should include at least the loop management commands and resilience instructions.

- **`createPipeline` does not thread `systemPrompt`** - `src/services/schedule-manager.ts:361-372` (Confidence: 65%) -- The `createPipeline` method threads `priority`, `workingDirectory`, `agent`, and `model` from shared request to per-step `createSchedule` calls, but does not thread `systemPrompt`. However, `PipelineCreateRequest` does not include a `systemPrompt` field, so this is consistent with the type design. If `systemPrompt` support for instant pipelines is desired in the future, both the type and the threading would need to be added.

## Summary
| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 1 | 0 | - |
| Should Fix | - | 0 | 1 | - |
| Pre-existing | - | - | 1 | 0 |

**Architecture Score**: 8/10
**Recommendation**: APPROVED_WITH_CONDITIONS

The system prompt feature follows the project's established architectural patterns well:
- **Dependency injection**: Properly maintained throughout (adapters, repositories, event bus)
- **Event-driven architecture**: No violations -- systemPrompt threads through existing event/domain pipelines
- **Immutability**: Domain objects remain frozen; `systemPrompt` added as readonly fields
- **Layering**: Clean separation maintained -- domain types define the field, adapters implement the mechanism, services orchestrate
- **Strategy pattern**: Each agent adapter implements its own systemPrompt injection mechanism (Claude: CLI flag, Codex: config, Gemini: env var + file), correctly following the existing Strategy pattern for agent differences
- **SRP**: The `operationalContract` extraction is a good separation of concerns, ensuring the orchestrator agent can function even with custom system prompts

The one blocking issue (duplicated operational knowledge) is a maintainability concern that should be addressed before merge to prevent drift. The synchronous I/O in GeminiBasePromptCache is a known deferred item.
