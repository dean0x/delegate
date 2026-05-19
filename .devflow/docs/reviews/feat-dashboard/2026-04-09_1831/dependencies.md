# Dependencies Review Report

**Branch**: feat/dashboard -> main
**Date**: 2026-04-09

## Issues in Your Changes (BLOCKING)

### HIGH

**string-width version mismatch causes duplicate installs** - `package.json:dependencies`
**Confidence**: 90%
- Problem: The project pins `string-width` at `^7.2.0`, but `ink` (the primary consumer of string-width in this dashboard feature) depends on `string-width ^8.1.1`. This results in **two separate versions** installed: 7.2.0 at top level and 8.2.0 nested under `ink/node_modules/`, `cli-truncate/node_modules/`, and `widest-line/node_modules/`. The dashboard code in `src/cli/dashboard/format.ts` imports `string-width` and gets v7.2.0, while Ink internally uses v8.2.0, meaning the same string could measure differently between the project's truncation logic and Ink's rendering logic.
- Fix: Upgrade to `string-width ^8.1.1` to align with Ink's dependency and deduplicate to a single version:
  ```json
  "string-width": "^8.1.1"
  ```

### MEDIUM

**react and ansi-escapes are production dependencies but only used by the CLI dashboard** - `package.json:dependencies`
**Confidence**: 85%
- Problem: This is an MCP server package. Adding `react` (^19.2.5), `ink` (^6.8.0), `ansi-escapes` (^7.3.0), and `string-width` to production dependencies means every consumer installing `autobeat` pulls in the React runtime, Ink's full dependency tree (including `yoga-layout`, `react-reconciler`, `ws`, `chalk`, and ~20 other packages), even if they only use the MCP server functionality. The lockfile grew from 262 to 322 packages (+23%). The `ansi-escapes` package is already a dependency of `ink` and is used in exactly one file (`src/cli/dashboard/index.tsx`), so it could potentially be imported from Ink's re-export or listed as a direct dependency only if truly needed independently.
- Fix: Consider whether these should be optional/peer dependencies, or document the bundle size tradeoff. If the dashboard is CLI-only and never used in MCP server mode, this is an acceptable tradeoff for a CLI tool but worth noting for library consumers. At minimum, `ansi-escapes` is redundant as a direct dependency since `ink` already brings it in at the same version range.

## Issues in Code You Touched (Should Fix)

_No issues found._

## Pre-existing Issues (Not Blocking)

### LOW

**prebuild-install is deprecated** - `package-lock.json` (transitive dependency of `better-sqlite3`)
**Confidence**: 85%
- Problem: The `prebuild-install` package is marked as deprecated in the lockfile: "No longer maintained. Please contact the author of the relevant native addon." This is a transitive dependency of `better-sqlite3` and pre-dates this PR.
- Fix: Monitor `better-sqlite3` releases for migration to a maintained prebuild mechanism. No action needed in this PR.

## Suggestions (Lower Confidence)

- **Consider exact pinning for picocolors precedent** - `package.json` (Confidence: 65%) -- The project already pins `picocolors` exactly at `1.1.1` (no caret/tilde), suggesting a conscious pinning strategy for certain packages. The new dependencies all use caret ranges (`^`), which is the project's default pattern and is fine, but worth confirming this is intentional given the existing exact pin.

## Summary

| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 1 | 1 | 0 |
| Should Fix | 0 | 0 | 0 | 0 |
| Pre-existing | 0 | 0 | 0 | 1 |

### Dependency Checklist

- [x] No known CVEs in added packages (`npm audit` clean)
- [x] Version ranges appropriate (caret ranges, consistent with project convention)
- [x] Lockfile updated and committed (808 lines added)
- [x] Packages actively maintained (ink, react, string-width all actively maintained)
- [x] Licenses compatible (all MIT -- compatible with project's MIT license)
- [x] Packages from verified publishers (ink by Sindre Sorhus/Vadim Demedes, react by Meta)
- [ ] Transitive dependencies reviewed -- 60 new packages added (262 -> 322), acceptable for Ink+React
- [x] Package names verified (no typosquats)
- [ ] Bundle size impact considered -- ~1.4MB new (react 252K, ink 1.1M, ansi-escapes 40K, string-width 20K)
- [x] Dev dependencies correctly categorized (@testing-library/react, @types/react, ink-testing-library all in devDependencies)

**Dependencies Score**: 7/10
**Recommendation**: CHANGES_REQUESTED
