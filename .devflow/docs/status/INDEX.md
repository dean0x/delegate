# Status Document Index

## Quick Reference
- [Latest Catch-Up Summary](../CATCH_UP.md) - For getting back up to speed
- [Latest Status](./2025-12-21_1514.md) - Most recent comprehensive status
- [Latest Compact](./compact/2025-12-21_1514.md) - Quick summary

## Pre-v0.4.0 Progress

| Priority | Item | Status |
|----------|------|--------|
| ~~P0~~ | ~~bootstrap() extraction~~ | ✅ PR #42 |
| ~~P1~~ | ~~findAll() pagination~~ | ✅ PR #43 |
| **P2** | Timing-based test waits | ⏳ Next |

## Recent Status Reports

| Date | Time | Focus | Full | Compact |
|------|------|-------|------|---------|
| 2025-12-21 | 15:14 | P1 Pagination Complete - PR #43 Merged | [Full](./2025-12-21_1514.md) | [Quick](./compact/2025-12-21_1514.md) |
| 2025-12-18 | 00:02 | PR #42 code review, handler extraction merge, tech debt update | [Full](./2025-12-18_0002.md) | [Quick](./compact/2025-12-18_0002.md) |
| 2025-12-14 | 21:38 | Code review resolution, PR #41 merge, tech debt cleanup | [Full](./2025-12-14_2138.md) | [Quick](./compact/2025-12-14_2138.md) |
| 2025-12-13 | 19:32 | Fix integration test crashes and test architecture issues | [Full](./2025-12-13_1932.md) | [Quick](./compact/2025-12-13_1932.md) |
| 2025-12-10 | 20:05 | Code review v0.3.2, release, v0.3.3 hotfix for broken npm package | [Full](./2025-12-10_2005.md) | [Quick](./compact/2025-12-10_2005.md) |
| 2025-12-08 | 20:11 | Tech debt validation - 2 real fixes, 4 false positives dismissed, Issue #31 updated | [Full](./2025-12-08_2011.md) | [Quick](./compact/2025-12-08_2011.md) |
| 2025-12-07 | 21:46 | MCP SDK security fix (1.24.3), spawn serialization docs update, PR #39 | [Full](./2025-12-07_2146.md) | [Quick](./compact/2025-12-07_2146.md) |
| 2025-12-06 | 22:56 | Fix TOCTOU race in spawn delay, code review triage, PR #38 merge | [Full](./2025-12-06_2256.md) | [Quick](./compact/2025-12-06_2256.md) |
| 2025-12-05 | 20:58 | Pre-v0.3.2 cleanup - closed issues, merged PRs, Qodo analysis | [Full](./2025-12-05_2058.md) | [Quick](./compact/2025-12-05_2058.md) |
| 2025-12-01 | 20:17 | Release v0.3.1 - Tech debt cleanup, code review, release automation | [Full](./2025-12-01_2017.md) | [Quick](./compact/2025-12-01_2017.md) |
| 2025-11-28 | 22:10 | Tech debt cleanup - DRY utilities, performance optimizations, docs (PR #33) | [Full](./2025-11-28_2210.md) | [Quick](./compact/2025-11-28_2210.md) |
| 2025-11-28 | 21:04 | Issue #28 deep copy fix + 11 code review improvements (PR #32 merged) | [Full](./2025-11-28_2104.md) | [Quick](./compact/2025-11-28_2104.md) |
| 2025-11-28 | 09:53 | Fix Issue #28 graph corruption + spawn burst protection (settling workers tracking) | [Full](./2025-11-28_0953.md) | [Quick](./compact/2025-11-28_0953.md) |
| 2025-11-21 | 22:15 | Code review follow-up fixes - Factory pattern, DoS prevention, TaskDeleted event (PR #29 merged) | [Full](./2025-11-21_2215.md) | [Quick](./compact/2025-11-21_2215.md) |
| 2025-11-21 | 06:01 | Incremental Graph Updates + Test Infrastructure Safety (technical safeguard for npm test) | [Full](./2025-11-21_0601.md) | [Quick](./compact/2025-11-21_0601.md) |
| 2025-11-19 | 19:56 | Incremental Graph Updates - Eliminate O(N) findAll() for 70-80% latency reduction (PR #27) | [Full](./2025-11-19_1956.md) | [Quick](./compact/2025-11-19_1956.md) |
| 2025-11-18 | 19:35 | v0.3.1 Quick Wins - Atomic Transactions, Input Validation, Code Review Fixes, PR #23 Merged | [Full](./2025-11-18_1935.md) | [Quick](./compact/2025-11-18_1935.md) |
| 22-10-2025 | 19:10 | Documentation housekeeping and organization (PR #22 merged) | [Full](./22-10-2025_1910.md) | [Quick](./compact/22-10-2025_1910.md) |
| 17-10-2025 | 19:22 | v0.3.0 post-merge quality improvements and roadmap consolidation (all 7 tasks completed) | [Full](./17-10-2025_1922.md) | [Quick](./compact/17-10-2025_1922.md) |
| 17-10-2025 | 18:21 | Task Dependencies v0.3.0 - comprehensive pre-PR review fixes (13/13 tasks completed) | [Full](./17-10-2025_1821.md) | [Quick](./compact/17-10-2025_1821.md) |
| 15-10-2025 | 20:47 | v0.2.3 release completion - code quality fixes & CI automation repair | [Full](./15-10-2025_2047.md) | [Quick](./compact/15-10-2025_2047.md) |
| 04-10-2025 | 22:27 | Comprehensive pre-PR review - 6 parallel sub-agents, quality assessment 71/100 | [Full](./04-10-2025_2227.md) | [Quick](./compact/04-10-2025_2227.md) |
| 04-10-2025 | 21:12 | Test suite stabilization - fixed all 13 failures, resolved database schema issues | [Full](./04-10-2025_2112.md) | [Quick](./compact/04-10-2025_2112.md) |
| 04-10-2025 | 18:51 | Post-PR review fixes - resolved all CRITICAL security & architecture issues | [Full](./04-10-2025_1851.md) | [Quick](./compact/04-10-2025_1851.md) |
| 03-10-2025 | 09:32 | Systematic test suite repair - fixed 64 failures across 12 files | [Full](./03-10-2025_0932.md) | [Quick](./compact/03-10-2025_0932.md) |
| 01-10-2025 | 21:51 | Test infrastructure cleanup & critical bug fixes | [Full](./01-10-2025_2151.md) | [Quick](./compact/01-10-2025_2151.md) |

## Usage

### Starting a Session?
1. **Quick start**: Use `/catch-up` command for AI-generated summary
2. **Full context**: Read the latest full status document
3. **Just the essentials**: Check the latest compact status

### During a Session?
- Document decisions and progress as you go
- Update TODOs if working on multi-step tasks
- Note any architectural decisions in code comments

### Ending a Session?
- **REQUIRED**: Use `/note-to-future-self` to document progress
- Creates both full and compact status documents
- Preserves agent todo list state for continuity

### Finding Information
- **Recent work**: Check status documents in reverse chronological order
- **Architectural decisions**: Look in full status documents or CLAUDE.md
- **Code TODOs**: Search codebase or check status document "Known Issues" section
- **Test status**: Check latest status document for current pass rate

## Document Types

### Full Status Documents
- **Purpose**: Comprehensive project state snapshot
- **Contains**:
  - Current focus and accomplishments
  - Architectural decisions with rationale
  - Known issues and technical debt
  - Agent todo list state (for session continuity)
  - Next steps and context for future developers
- **When to read**: Starting work after time away, need full context

### Compact Status Documents
- **Purpose**: Quick reference summary
- **Contains**:
  - Key accomplishments (bullet points)
  - Critical decisions (one-liners)
  - Top priority next actions
  - Critical issues
  - Key files modified
- **When to read**: Quick refresh, just need the highlights

### Catch-Up Summary
- **Purpose**: AI-generated session startup summary
- **Contains**:
  - Recent commit analysis
  - Current project state validation
  - Recommended next actions
  - Reality check on claimed accomplishments
- **When to read**: Starting a new session (use `/catch-up` command)

## Maintenance

### Automatic Updates
- This index is automatically updated when `/note-to-future-self` is run
- New entries are prepended to the table (newest first)
- Links are automatically generated

### Manual Updates
- If you create status documents manually, update this index
- Follow the table format above
- Keep entries in reverse chronological order (newest first)

## Tips

1. **Before Starting Work**: Always check latest status or run `/catch-up`
2. **After Completing Work**: Always run `/note-to-future-self` to document
3. **When Blocked**: Check status documents for known issues and gotchas
4. **When Making Decisions**: Document them in code comments AND status docs
5. **When Finding Bugs**: Note them in status docs, even if you fix them

## Related Documentation
- [CLAUDE.md](../../CLAUDE.md) - Project guidelines and architecture
- [TEST_STANDARDS.md](../../tests/TEST_STANDARDS.md) - Test quality requirements
- [ROADMAP.md](../../ROADMAP.md) - Future plans and milestones

---
*This index is automatically maintained by the `/note-to-future-self` command*
