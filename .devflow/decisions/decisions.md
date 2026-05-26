<!-- TL;DR: 3 decisions. Key: ADR-001, ADR-002, ADR-003 -->
# Architecture Decision Records

Explicit design choices and trade-offs made during development.

## ADR-001: Channel name validation constrained to tmux SESSION_NAME_REGEX compatibility

- **Context**: Channel domain design for Phase 6 of tmux migration epic — channels map directly to tmux sessions
- **Decision**: `CHANNEL_NAME_REGEX` is constrained to be a subset of tmux `SESSION_NAME_REGEX` so channel names can be used as tmux session names without transformation
- **Rationale**: Avoids a separate sanitization/mapping step and keeps channel-to-session name derivation deterministic and collision-free. Any valid channel name is a valid tmux session name by construction.
- **Status**: Active
- **Source**: sidecar:obs_b8e1d6

## ADR-002: Greptile code review false positives dismissed with explicit reply explanations

- **Context**: PR review resolution cycle with automated Greptile review comments (2x P1, 2x P2)
- **Decision**: False positives and intentional design choices receive explicit reply comments rather than being silently closed or ignored
- **Rationale**: Keeps the review thread auditable, documents reasoning for anyone reading the PR later, and prevents the same issues being re-raised in future review cycles. The 300ms hardcoded wait in the tmux worker path was specifically documented as intentional (no feedback signal available).
- **Status**: Active
- **Source**: sidecar:obs_c3d9e5

## ADR-003: Pre-existing design gaps found during PR review are tracked as GitHub issues rather than fixed in-scope

- **Context**: PR #193 (channel service layer) — Greptile surfaced a P1 about recovered tmux sessions having no output callbacks, a limitation in `TmuxConnectorPort` that predates the PR
- **Decision**: Pre-existing gaps not introduced by the current PR are replied to with an explanation and tracked as a GitHub issue (e.g. #194) rather than fixed in-scope
- **Rationale**: Keeps PR scope bounded and avoids scope creep on already-large feature PRs. A GitHub issue provides a durable record that a reply comment alone would not — it cannot be forgotten and can be prioritized, assigned, and referenced in future work.
- **Status**: Active
- **Source**: sidecar:obs_e2c7b3
