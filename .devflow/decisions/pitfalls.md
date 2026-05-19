<!-- TL;DR: 2 pitfalls. Key: PF-001, PF-002 -->
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
