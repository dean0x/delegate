<!-- TL;DR: 3 pitfalls. Key: PF-001, PF-002, PF-003 -->
# Known Pitfalls

Area-specific gotchas, fragile areas, and past bugs.

## PF-001: Do not unilaterally defer code review issues to a future PR — always ask user before deferring

- **Area**: code review resolution strategy — the assistant categorized 3 issues as 'Pre-existing' and implicitly left them for later
- **Issue**: user directed to fix all pre-existing issues found, not just the new ones
- **Impact**: user had to explicitly redirect to include pre-existing items
- **Resolution**: when resolving review findings, do not treat 'pre-existing' as a deferral category — surface each item and ask whether to fix now or track. User's standing posture is 'fix it while we're here.'
- **Status**: Active
- **Source**: self-learning:obs_q7m2r5

## PF-002: Do not add migration or backward-compatibility paths for features with zero users — clean break is correct

- **Area**: renaming the `translate` config field to `proxy` in AgentConfig — a field that shipped in v1.4.0 with no known users
- **Issue**: assistant treated the config rename as a blocking issue requiring a migration fallback
- **Impact**: user had to explicitly reject it with 'clean break forward'
- **Resolution**: before proposing migration or deprecation scaffolding, verify whether anyone actually uses the feature. If adoption is zero or negligible, a clean break is always preferable.
- **Status**: Active
- **Source**: self-learning:obs_f8b3r7

## PF-003: Always verify and checkout the feature branch before starting implementation — commits can accidentally land on main

- **Area**: git workflow / branch discipline
- **Issue**: Assistant began implementing Phase 6 channel domain feature directly on `main` without first creating and checking out the feature branch, causing two feature commits to land on main
- **Impact**: Required a local `git reset --hard HEAD~2` + branch creation to recover. Safe only because changes had not been pushed upstream. If already pushed, this would require force-push or revert commits.
- **Resolution**: Before writing any feature code, run `git branch --show-current` and verify the branch. If not on the expected feature branch, create and checkout it explicitly. When the plan or issue specifies a branch name (e.g. `feat/181-channel-domain-persistence`), use it verbatim from the start.
- **Status**: Active
- **Source**: sidecar:obs_a4f7c2
