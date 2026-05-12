---
format_version: 1
project_type: npm
version_strategy: manual
tag_format: "v{version}"
created: 2026-05-12T09:00:00Z
last_updated: 2026-05-12T09:00:00Z
---

## Packages

- name: autobeat
  version_file: package.json
  lock_file: package-lock.json
  bump_command_intent: npm-version-no-git-tag
  publish_target: npm

## Pre-release Checks

- clean_working_tree: true
- branch: main
- git_pull: true
- npm_auth: npm whoami
- gh_auth: gh auth status
- no_open_release_prs: true
- tag_not_exists: true

## Changelog

- format: keep-a-changelog
- file: CHANGELOG.md
- unreleased_header: "[Unreleased]"

## Build & Test

- build_tool: npm
- build_intent: typecheck + lint + build
- test_tool: npm
- test_intent: grouped-suites
- grouped_suites:
  - test:core
  - test:handlers
  - test:services
  - test:repositories
  - test:adapters
  - test:implementations
  - test:cli
  - test:dashboard
  - test:scheduling
  - test:checkpoints
  - test:error-scenarios
  - test:orchestration
  - test:translation
  - test:integration

## Release Files

- package.json + package-lock.json (always)
- docs/releases/RELEASE_NOTES_v{version}.md (always)
- CHANGELOG.md (always)
- docs/releases/RELEASE_NOTES.md (always, update index)
- docs/FEATURES.md (minor/major only)
- docs/ROADMAP.md (minor/major only)

## Publish

- method: ci-driven
- workflow: release.yml
- trigger: workflow_dispatch
- ref: main
- post_merge_required: true

## Post-release

- verify_npm: npm view autobeat version
- verify_gh_release: gh release view v{version}
- verify_tag: git fetch --tags && git tag -l v{version}
- verify_workflow: gh run list --workflow=release.yml --limit=1

## Snyk

- scan_intent: best-effort
- severity_threshold: medium
- block_on: high/critical in new code only
- pre_existing: note and continue
