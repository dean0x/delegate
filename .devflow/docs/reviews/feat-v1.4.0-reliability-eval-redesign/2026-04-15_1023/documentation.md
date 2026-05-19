# Documentation Review Report

**Branch**: feat/v1.4.0-reliability-eval-redesign -> main
**PR**: #136
**Diff base**: 33abbb78c6c566480ef474d5b98d20087051a929...HEAD
**Date**: 2026-04-15 10:23

Scope: documentation drift, release-note alignment with CLAUDE.md template, JSDoc on new helpers (WHY not WHAT), and stale references to the old `spawn()` positional signature.

---

## Issues in Your Changes (BLOCKING)

### CRITICAL

**Release notes mis-document the `evalType` enum values** — `docs/releases/RELEASE_NOTES_v1.4.0.md:16` (and CHANGELOG.md:16)
**Confidence**: 99%
- Problem: Release notes and CHANGELOG state:
  > `evalType` field on `Loop` domain object (`agent` | `feedforward` | `judge`); defaults to `agent` for backward compatibility
  The actual enum in `src/core/domain.ts:580-585` is `feedforward | judge | schema`. There is no `agent` value. The DB migration's CHECK constraint enforces exactly `('feedforward', 'judge', 'schema')` (`src/implementations/database.ts:901`), and `CompositeExitConditionEvaluator` switches on these three values (`src/services/composite-exit-condition-evaluator.ts:46-51`). `loop.evalType` defaults to `EvalType.FEEDFORWARD`, not `'agent'`.
- Impact: Users following the release notes will pass `evalType: 'agent'`, which will be rejected at the DB CHECK constraint and produce a confusing failure. The `schema` mode (the structured-output Claude path) is entirely undocumented in the release notes despite being one of three first-class options. MCP server-side instructions (`src/adapters/mcp-instructions.ts:44-46`) correctly list all three values — so the release notes and CHANGELOG are the only sources advertising the wrong API.
- Fix: In RELEASE_NOTES_v1.4.0.md and CHANGELOG.md, change the `evalType` line to:
  ```
  - `evalType` field on `Loop` domain object (`feedforward` | `judge` | `schema`); defaults to `feedforward` for backward-compatible agent-mode loops (#136)
  ```
  Add a third "Schema" subsection under "New Evaluation Modes" describing `evalType: schema` (Claude `--json-schema` deterministic pass/fail), since that is what the migration enables and what `AgentExitConditionEvaluator` now implements.

**Release notes claim "No new migrations in v1.4.0" while the PR adds migrations 21 and 22** — `docs/releases/RELEASE_NOTES_v1.4.0.md:118`
**Confidence**: 99%
- Problem: The "Database" section says:
  > No new migrations in v1.4.0. All changes are in-process behaviour.
  The PR diff adds two migrations to `src/implementations/database.ts`:
  - **Migration 21** — "Add worker heartbeat, loop eval columns (v1.4.0)" (line 841-859): adds `workers.last_heartbeat`, `loop_iterations.eval_response`, `loops.eval_type` (DEFAULT `'feedforward'`), `loops.judge_agent`, `loops.judge_prompt`.
  - **Migration 22** — "Add CHECK constraints on eval_type and judge_agent in loops table (v1.4.0)" (line 862+): full table recreation to add CHECK constraints. This is a non-trivial table-rebuild migration.
- Impact: Operators reading the release notes will not back up before upgrading and will be surprised by a table-rebuild migration on a hot `loops` table. CLAUDE.md release process requires the Database section to "list any migrations" and Migration Notes to call out "auto-applied migrations." Both sections currently mislead.
- Fix: Replace the Database section with:
  ```
  ## Database

  Two new auto-applied migrations:

  - **Migration 21** — Adds `workers.last_heartbeat` (stale-worker detection beyond PID checks), `loop_iterations.eval_response` (raw agent eval output capture), and `loops.eval_type` / `loops.judge_agent` / `loops.judge_prompt` columns. Existing rows default to `eval_type='feedforward'` for backward compatibility.
  - **Migration 22** — Adds CHECK constraints on `loops.eval_type` (`'feedforward' | 'judge' | 'schema'`) and `loops.judge_agent` (`'claude' | 'codex' | 'gemini'`). Implemented as a safe table recreation (same pattern as v2/v3/v11) because SQLite cannot ALTER an existing column to add a CHECK.
  ```
  Update Migration Notes to add: "Database: Migrations 21 and 22 auto-applied on first startup. Migration 22 rebuilds the `loops` table — back up `~/.autobeat/autobeat.db` before upgrading if you have long-running loops you cannot afford to lose on rollback."

### HIGH

**Release notes mis-state the unique-decision-file location** — `docs/releases/RELEASE_NOTES_v1.4.0.md:37`
**Confidence**: 95%
- Problem: Release notes say:
  > Judge agent (phase 2): reads findings and writes a structured JSON decision to `.autobeat-judge-{judgeTaskId}` in the working directory
  The `judgeTaskId` is the synthetic ID of the *judge* task (e.g., `task-…`), which is not a stable user-visible identifier. The exact filename is built by `judgeDecisionFilePath(workingDirectory, judgeTaskId)` (`src/services/judge-exit-condition-evaluator.ts:60-62`), where the literal prefix is `.autobeat-judge-` plus the full task id (which begins with `task-`). The user-facing example would actually be e.g. `.autobeat-judge-task-9b1f...`. Copy-pasting `.autobeat-judge-{judgeTaskId}` as if `judgeTaskId` is a known short token is misleading.
- Impact: Users debugging stale decision files (or auditing TOCTOU claims) will look for files matching the wrong pattern.
- Fix: Replace the sentence with: "Judge agent (phase 2): reads findings and writes a structured JSON decision to `.autobeat-judge-<judge-task-id>` in the working directory (the exact filename includes the full judge task id, e.g. `.autobeat-judge-task-9b1f0…`). The unique per-task filename prevents TOCTOU because the work agent only knows its own task id."

**Release notes describe FeedforwardEvaluator behavior incorrectly when `evalPrompt` is unset** — `docs/releases/RELEASE_NOTES_v1.4.0.md:14, 18-29`
**Confidence**: 90%
- Problem: Release notes say feedforward "gathers agent findings on every iteration." That is true *only when `evalPrompt` is configured*. The implementation explicitly returns `{passed: false, decision: 'continue', feedback: undefined}` without spawning any eval agent when `evalPrompt` is unset (`src/services/feedforward-evaluator.ts:46-50`). The CHANGELOG entry has the same overstatement.
- Impact: Users will assume feedforward always spawns an eval agent (and therefore costs tokens per iteration). A workflow that omits `evalPrompt` will silently behave as a pure pass-through, which is correct but undocumented.
- Fix: Add to the Feedforward subsection (after the example): "If `evalPrompt` is omitted, feedforward is a pure pass-through — no eval agent is spawned and no findings are gathered. The loop simply runs to `maxIterations`."

**`docs/FEATURES.md` and `docs/ROADMAP.md` not updated for v1.4.0** — `docs/FEATURES.md:5,7` / `docs/ROADMAP.md:3`
**Confidence**: 92%
- Problem: CLAUDE.md release process (#2 "Files to Update") requires:
  - `docs/FEATURES.md` — "If new user-facing feature: Add `## ✅ <Feature> (v<version>)` section, update 'Last Updated' header"
  - `docs/ROADMAP.md` — "If feature advances roadmap: Update current status, add to Released Versions, remove delivered items from upcoming sections"
  v1.4.0 introduces three user-facing features (feedforward eval, judge eval, schema eval) and FEATURES.md still says "Last Updated: April 2026 (2026-04-11)" with v1.3.0 as the most recent entry. ROADMAP.md still says "Current Status: v1.3.0 RELEASED (2026-04-11)" and lists no v1.4.0 entry.
- Impact: Users browsing FEATURES.md or ROADMAP.md will think v1.4.0 doesn't exist or is internal-only — yet the release notes and CHANGELOG document new public CLI/MCP-visible behavior (`evalType`, `judgeAgent`, `judgePrompt`).
- Fix: Add a `## ✅ Evaluator Redesign (v1.4.0)` section to FEATURES.md describing the three eval types (feedforward / judge / schema) and update the "Last Updated" header. In ROADMAP.md, change "Current Status" to v1.4.0 and add a "v1.4.0 - Evaluator Redesign & Reliability ✅" entry.

---

## Issues in Code You Touched (Should Fix)

### MEDIUM

**`composite-exit-condition-evaluator.ts:33` JSDoc says "feedforward is the default evalType for agent mode" but the comment talks about competing options that no longer match the enum** — `src/services/composite-exit-condition-evaluator.ts:30-36`
**Confidence**: 85%
- Problem: The DECISION JSDoc says "schema only works with Claude; judge requires explicit judgeAgent config." This is correct content but reads as if `schema` is an additional optional default candidate when in fact the enum has exactly three values and the dispatcher uses all three. The comment could be tightened to align with the actual exhaustive switch. Also note the throw-on-unhandled change at line 56 (good) is undocumented in this DECISION block — the previous "safe fallback at runtime" comment is gone but the behavior is now strict.
- Fix: Add a sentence to the DECISION block: "Unknown `evalType` values now throw rather than silently falling through — silent fallback masked misconfiguration in production."

**`SpawnOptions` JSDoc on `jsonSchema` says "v1.4.0, Claude only" without explaining the contract for non-Claude adapters** — `src/core/agents.ts:244-245`
**Confidence**: 82%
- Problem: The field comment says `Optional JSON schema string for structured output (v1.4.0, Claude only)`. That is the WHAT, not the WHY. The actual contract — accepted-but-ignored by Codex/Gemini adapters via `_jsonSchema` rename (`src/implementations/codex-adapter.ts:20`, `src/implementations/gemini-adapter.ts:20`) — is the load-bearing decision. Per CLAUDE.md global rules, JSDoc on new helpers should be WHY not WHAT.
- Fix: Replace with: "Optional JSON schema for structured output. CONTRACT: only the Claude adapter wires this through `--json-schema`; Codex and Gemini adapters accept and ignore the value (no error). Callers must not assume non-Claude agents will honor the schema."

---

## Pre-existing Issues (Not Blocking)

(None of significance for documentation. The pre-existing JSDoc on legacy spawn paths in `tests/fixtures/mock-process-spawner.ts:17` and `tests/fixtures/no-op-spawner.ts:80` use the old positional shape, but those implement the `ProcessSpawner` interface (lower level), not `AgentAdapter`, so they correctly stayed positional. No drift.)

---

## Suggestions (Lower Confidence)

- **Release notes "Extracted Pure Functions" list omits return signatures for callers** — `docs/releases/RELEASE_NOTES_v1.4.0.md:106-112` (Confidence: 70%) — Functions like `acquirePidFile(pidPath, pid)` could include `→ Result<'acquired' | 'already-running', Error>` (already shown for `acquirePidFile` higher up at line 68 — inconsistent presentation across the doc).
- **Highlight bullet "SpawnOptions refactor" should mention this is internal-only** — `docs/releases/RELEASE_NOTES_v1.4.0.md:11` (Confidence: 65%) — The Migration Notes correctly say "internal refactor — no observable behaviour change," but the Highlights bullet sits next to user-facing changes and reads like a public API change at first glance.
- **CHANGELOG `### Changed` lists `AgentAdapter.spawn()` signature change without the `### Breaking` marker that v1.3.0 used** — `CHANGELOG.md:25-26` (Confidence: 60%) — v1.3.0 used `### Breaking` to flag interface-level changes affecting external consumers. v1.4.0's spawn() change is similarly interface-level (anyone with a custom AgentAdapter needs to update). For consistency with v1.3.0/v0.8.0 conventions, this could move under a `### Breaking` heading. (Lower confidence because the change is genuinely internal-only by design — most consumers won't have custom adapters.)

---

## Summary

| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 2 | 3 | 0 | - |
| Should Fix | - | 0 | 2 | - |
| Pre-existing | - | - | 0 | 0 |

**Documentation Score**: 5/10
**Recommendation**: CHANGES_REQUESTED

The two CRITICAL issues are factual misrepresentations of the v1.4.0 public API: the wrong `evalType` enum values and the false "no migrations" claim. Both will be repeated verbatim into the GitHub Release notes via the release workflow's `--notes-file` flag and into npm tarball docs once published, so they must be corrected before triggering the release. The HIGH issues compound the public-API misalignment (judge filename, feedforward-without-prompt behavior, missing FEATURES/ROADMAP updates per the project's own release checklist).

Notable strengths:
- New helpers (`acquirePidFile`, `buildEvalPromptBase`, `checkActiveSchedules`, `registerSignalHandlers`, `startIdleCheckLoop`, `judgeDecisionFilePath`) all have meaningful WHY-focused JSDoc with explicit DECISION blocks. The `acquirePidFile` JSDoc in particular correctly documents the residual TOCTOU window and why the sentinel return shape was chosen.
- The judge evaluator class header (`src/services/judge-exit-condition-evaluator.ts:1-20`) explains the two-phase ARCHITECTURE and the file-based-decision DECISION clearly.
- The recent fix commit (`6c5dafa`) caught and corrected a stale loop reference in `completeLoop` and a doc comment in the judge evaluator — good discipline.
- No stale references to the old positional `spawn()` signature in production code (the only remaining positional `spawn` calls are in `ProcessSpawner` callers, which is a different interface intentionally kept positional).
