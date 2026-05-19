# Accessibility Review Report

**Branch**: feat/dashboard-redesign-v1.3.0 -> main
**Date**: 2026-04-11 22:00
**Focus**: Terminal accessibility (Ink TUI)
**PR**: dean0x/autobeat#133

## Scope translation: web a11y rules → terminal patterns

The `devflow:accessibility` skill targets WCAG 2.2 AA for web/DOM. This dashboard is an Ink-based **terminal** UI; ARIA roles, DOM focus management, and the WCAG contrast ratios that depend on RGB sRGB calculations don't directly apply. I translated the web rules into the equivalent terminal-accessibility concerns and reviewed against those:

| Web rule | Terminal equivalent applied here |
|---|---|
| Keyboard navigation (WCAG 2.1) | Every action must have a documented keybinding; nothing should be reachable only by undocumented chord |
| Focus indicator (WCAG 2.4.11) | Focused panel/row must be distinguishable by **at least two** channels (border + label, color + glyph, etc.) |
| Color is not the only carrier (WCAG 1.4.1) | All status conveyed by `color="..."` must also have a glyph or text label |
| Contrast (WCAG 1.4.3) | Avoid `dimColor` on entire content blocks where critical info lives; never rely on dim+gray as the only readable channel |
| Reduced motion (WCAG 2.3.3) | Spinners/animations must be disable-able |
| Skip links / discoverability | Footer hint bar must list every binding for the current view; provide a `?`/`h` help affordance |
| Reflow / responsive (WCAG 1.4.10) | Narrow-terminal degradation must not silently drop content; the user must know what's hidden |
| Screen reader compat | Avoid Unicode-only carriers for critical state; pair box drawing/glyphs with text |

---

## Issues in Your Changes (BLOCKING)

### CRITICAL

(none — no issues meet the CRITICAL bar of "no keyboard access at all" or "data loss / functional exclusion")

### HIGH

**Hidden keybindings — multiple actions reachable only by undocumented keys** — Confidence: 95%
- Files: `src/cli/dashboard/components/footer.tsx:15-20`, `src/cli/dashboard/use-keyboard.ts:1018-1067`
- Problem: The footer hint bars list a subset of actually-bound keys. The following bindings are functional but appear in **no footer**, so a user has to read the source to discover them. WCAG 2.1 SC 2.1.1 (Keyboard) is met (everything is reachable by keyboard), but the equivalent terminal "discoverability" rule is not — keyboard-only users cannot learn the binding without reading the code:

  | Binding | Where it works | Function | Documented? |
  |---|---|---|---|
  | `m` | global | jump to main view | NO |
  | `w` | global | jump to workspace view | NO |
  | `j` / `k` | every view | vim-style up/down | NO |
  | `1`–`4` | main view | jump to panel by number | NO |
  | `1`–`9` | workspace grid | jump to grid panel by number | NO |
  | `g` | workspace | jump to top of focused panel | NO (only `G` is in footer) |
  | `Shift+Tab` | main, workspace | reverse focus cycle | NO |
  | `PgUp` / `PgDn` | workspace, orchestration detail | paginate | NO in main; partially in workspace ("navigate" not stated) |
  | `Backspace` | every view | same as Esc | NO |
  | `r` | detail | refresh (only listed in DETAIL_HELP, missing in WORKSPACE_HELP) | partial |

  In particular, **m** and **w** are global shortcuts the v1.3.0 redesign relies on for the primary navigation between Metrics and Workspace, yet they appear nowhere in the UI — the footer says `v: workspace` (toggle) but never `w` (jump from anywhere).

- Impact: New users (and assistive-technology users) cannot discover the full keyboard surface. This is the terminal equivalent of the WCAG "Skip links / discoverability" requirement.
- Fix:
  1. Extend the help footer to list the missing keys, or split into a two-line footer.
  2. **Add a `?` (or `h`) help affordance** that opens a modal/overlay listing every binding for the current view. This is the standard pattern in `htop`, `vim`, `lazygit`, `k9s`, etc., and it's the canonical answer to "how does a user discover keybindings without reading source?"
  3. At minimum, document `j/k` and `m/w` somewhere in `MAIN_HELP`/`WORKSPACE_HELP`.

**Footer's `Tab: activity` hint is misleading** — Confidence: 90%
- File: `src/cli/dashboard/components/footer.tsx:15`
- Problem: `MAIN_HELP` reads `v: workspace · Tab: activity · ↑↓: select · ...`. This implies one Tab press jumps to the Activity feed. In reality, `handleMainKeys` (`use-keyboard.ts:638-653`) cycles through `loops → tasks → schedules → orchestrations → activity`, so it takes **four** Tab presses from the default focus to reach Activity. Conversely, when activity is focused, `↑↓` does NOT mean "select" in any panel — it scrolls the activity feed.
- Impact: Users following the hint will press Tab once, see focus advance to "tasks", and conclude that the Activity feed is broken or the hint is wrong. This breaks the terminal equivalent of WCAG "labels match their function" (SC 2.5.3).
- Fix: Rewrite the hint to be accurate, e.g.:
  ```
  v: workspace · Tab: cycle (loops→tasks→schedules→orch→activity) · ↑↓ jk: select · Enter: detail · 1-4: jump to panel · f: filter · r: refresh · q: quit
  ```
  Or, simpler: split the footer into a two-line stack — one line for the panel cycle keys, one line for the per-panel keys.

**Resources tile: utilization conveyed only by bar color** — Confidence: 88%
- File: `src/cli/dashboard/components/resources-tile.tsx:25-29, 56-66`
- Problem: The CPU and Memory rows render a unicode block bar (`█░`) that is **green** below 50%, **yellow** 50–80%, **red** ≥80%. Severity is communicated entirely through `color={barColor(...)}`. There is no glyph, no `[OK]`/`[WARN]`/`[CRIT]` label, no asterisk, no text marker. A user with red-green color blindness, on a monochrome terminal, or with a screen reader cannot distinguish "75% — yellow warn" from "90% — red critical." The WCAG SC 1.4.1 (Use of Color) terminal equivalent is violated.
- Impact: Resource saturation alerts (the primary purpose of the tile) are invisible to color-impaired users.
- Fix: Pair the color with a text marker. For example:
  ```tsx
  function barLevel(percent: number): { color: string; label: string } {
    if (percent >= 80) return { color: 'red', label: 'CRIT' };
    if (percent >= 50) return { color: 'yellow', label: 'WARN' };
    return { color: 'green', label: ' OK ' };
  }
  // ...
  const level = barLevel(cpuUsage);
  return (
    <Box>
      <Text>CPU </Text>
      <Text color={level.color}>{renderBar(cpuUsage)}</Text>
      <Text> {cpuUsage.toFixed(0)}% [{level.label}]</Text>
    </Box>
  );
  ```
  Alternatively, change the bar fill character at thresholds (`█` ok / `▓` warn / `▒` crit) so the bar itself encodes severity in monochrome.

**MetricsBar status conveyed only by `statusColor()`** — Confidence: 87%
- File: `src/cli/dashboard/components/metrics-bar.tsx:28-43, 67`
- Problem: Each task panel's top metrics strip wraps the entire bar text in `<Text color={statusColor(status)}>`. The status word is present (`running`/`completed`/`failed`/`cancelled`), so the **word** still tells the user the state — that's good. **However**, the only differentiator between `failed` and `cancelled` is color (both map to `'red'`), and there's no leading glyph that would make the row scannable in a wall of panels. In contrast, `StatusBadge` (status-badge.tsx:50-54) renders glyph + text + color — a triple-channel cue. MetricsBar is missing the glyph channel.
- Impact: At a glance across a 4×4 grid, the user can't easily distinguish task states without reading the word. Color-blind users get no second channel for `failed` vs `cancelled`.
- Fix: Prefix the bar with the same glyph that `StatusBadge` uses (`statusIcon(status)` from `format.ts:87-89`), e.g.:
  ```tsx
  const glyph = statusIcon(status);
  const parts: string[] = [glyph, kindPart, statusPart];
  ```

**Counts panel: only "fail" gets a non-default color, "run" is green-only** — Confidence: 85%
- File: `src/cli/dashboard/components/counts-panel.tsx:30-39`
- Problem: The `Section` component renders `run N` in green and `fail N` in red, while `done N` uses `dimColor`. The "running" indicator's only visual cue beyond the literal word is the green color — there's no glyph. More concerning: `fail N` is conditionally rendered **only when `> 0`**, meaning a user who scans for failures sees nothing where there are no failures (correct), but a user who needs a heads-up that a column is healthy gets only the colored "run" word as the at-a-glance cue.
- Impact: Lower priority than the resources tile, but the same color-only meaning rule applies.
- Fix: Prefix each count with a glyph: `● run N`, `✓ done N`, `✗ fail N`. The glyphs are already used in the header health summary (`header.tsx:46-48`) — this just makes the dashboard internally consistent.

---

## Issues in Code You Touched (Should Fix)

### HIGH

**Narrow metrics layout silently drops Throughput, Activity, and Counts** — Confidence: 92%
- File: `src/cli/dashboard/views/metrics-view.tsx:88-97`
- Problem: When `layout.mode === 'narrow'` (`columns < 60`), the view renders only `ResourcesTile` and `CostTile`. **`ThroughputTile`, `ActivityPanel`, and `CountsPanel` are silently omitted.** The release notes (RELEASE_NOTES_v1.3.0.md:13) explicitly call out "Adapts to terminal size; degrades gracefully on narrow or small terminals" — this is the responsive behavior the PR claims, but it's missing the disclosure required by WCAG 1.4.10 Reflow's terminal equivalent: the user must know what's hidden.

  The current hint just says `Narrow terminal — expand to see full dashboard`. It does not list which content is hidden.
- Impact: A user on a 50-col terminal trying to triage failures will miss the entire CountsPanel (the failure totals) and the entire ActivityPanel (recent activity feed), with no indication these exist on a wider terminal. Equally important, a screen-reader user polling the dashboard will see different content depending on terminal width and have no way to know.
- Fix: List the hidden sections explicitly, and consider keeping a one-line counts summary visible:
  ```tsx
  <Text dimColor>Narrow terminal — Throughput, Activity, Counts hidden. Resize to ≥60 cols.</Text>
  ```
  Or render a stacked single-column version of all five widgets so nothing is dropped.

**Esc semantics inconsistent across views** — Confidence: 86%
- Files: `src/cli/dashboard/use-keyboard.ts:181-198, 330-337, 632-635`
- Problem: The `Esc` key behavior varies across the three view handlers in non-obvious ways:

  | View | Esc behavior |
  |---|---|
  | detail (orchestration kind) | return to `view.returnTo` (could be main, workspace, or parent orchestration) |
  | detail (other) | same |
  | workspace + fullscreen | exit fullscreen, stay in workspace |
  | workspace (not fullscreen) | return to main |
  | main + activity-focused | leave activity focus → focus loops panel |
  | main + panel-focused | nothing — Esc is silently swallowed by `useInput` (no return false) |

  The "Esc does nothing in main panel focus" case is the surprising one — users expect Esc to "back out" to the highest level. The current behavior leaves them with nowhere to back out from in the main view.

  Worse, the workspace footer says `Esc` (no qualifier), so a user on the workspace view who presses Esc once (intending to back to main) will exit fullscreen instead and have to press Esc twice. This isn't documented anywhere.
- Impact: Inconsistent Esc breaks WCAG 2.4.3 (Focus Order) terminal equivalent — back-out should be predictable.
- Fix:
  1. In main view panel-focus, treat Esc as a no-op explicitly OR have it open the help overlay (see the `?` help recommendation above).
  2. In the workspace footer, document the two-step Esc behavior: `Esc fullscreen→grid · Esc twice → back`.
  3. Consider a single global rule: "Esc always backs up one level. If you're at main, Esc shows the help/quit overlay."

### MEDIUM

**Orchestration detail children list: 14 of 15 rows are dim** — Confidence: 84%
- File: `src/cli/dashboard/views/orchestration-detail.tsx:54-58`
- Problem: `renderChildRow` returns `<Text color={isSelected ? 'blue' : undefined} inverse={isSelected} dimColor={!isSelected}>`. Every non-selected row in a 15-row child list is rendered with `dimColor`, which on most terminal themes is gray-on-gray. The user has 14 rows of nearly-unreadable text and 1 highlighted row. This breaks the WCAG 1.4.3 (Contrast Minimum) terminal equivalent — content should be readable, not just the focus row.
- Impact: Users with low vision cannot read the unselected children. The list becomes "the row I'm on" instead of "the list of all children."
- Fix: Drop `dimColor={!isSelected}` and rely on `inverse={isSelected}` + bold for the focus cue. Test:
  ```tsx
  return (
    <Text bold={isSelected} inverse={isSelected}>
      {line}
    </Text>
  );
  ```

**`OutputStreamView` `[paused]` indicator is `dimColor`** — Confidence: 78%
- File: `src/cli/dashboard/components/output-stream-view.tsx:88-98`
- Problem: When auto-tail is disabled (paused), the indicator `[paused]` is rendered with `dimColor`. This is the only way to tell that the stream is paused — yet the marker itself is rendered in the lowest-contrast styling. The same applies to the `↑ more` and `↓ N more` indicators and the dropped-lines footer.
- Impact: Users may not realize the panel is paused, leading to confusion when output appears stale.
- Fix: Render the `[paused]` indicator without `dimColor` (or with `color="yellow"` to match other "warning/state" cues), and reserve `dimColor` for genuinely tertiary information like ranks/timestamps.

**Empty state messages all `dimColor`** — Confidence: 75%
- File: `src/cli/dashboard/components/empty-workspace.tsx:18-33`
- Problem: Both empty-state messages render every line with `<Text dimColor>...</Text>`, including the actionable hint `Run \`beat orchestrate\` to create one.` On a low-contrast terminal theme this advice is almost unreadable.
- Impact: First-time users (who see the empty workspace first) get poor onboarding because the most important text is the dimmest.
- Fix: Drop `dimColor` from at least the action hint line. Or use neutral (no color) for the first line and `dimColor` only on the secondary "Waiting for first iteration..." line.

**`workspaceNav.focusArea === 'nav'` has no text/visual cue at the page level** — Confidence: 72%
- Files: `src/cli/dashboard/views/workspace-view.tsx:198-208`, `src/cli/dashboard/components/orchestrator-nav.tsx:49-77`
- Problem: When the user is in the workspace view, `focusArea` can be `'nav'` (left orchestrator list) or `'grid'` (task panels). The grid panels display `borderStyle="double"` and `borderColor="cyan"` when focused. **The OrchestratorNav has no visible focus state — `focusArea === 'nav'` is not signaled at all in the rendered nav.** The selected nav row gets a `>` prefix and `cyan` color (`orchestrator-nav.tsx:43`), but those cues are present whether focusArea is `nav` or `grid`. A user can't tell from the screen whether their next ↑/↓ press will move the nav cursor or do nothing because focus is on the grid.
- Impact: Confusing focus model. The terminal equivalent of WCAG 2.4.7 (Focus Visible) says the **container** with focus must be visually distinguishable.
- Fix: When `focusArea === 'nav'`, render the `OrchestratorNav` with a `borderStyle="single"` `borderColor="cyan"` (or any other border) so the user can see "I'm in the nav list now". Then when `focusArea === 'grid'`, drop the nav border. The grid focus already has a per-panel cue, so this would make the model symmetric.

**Reduced-motion env var is undocumented** — Confidence: 80%
- File: `src/cli/dashboard/components/status-badge.tsx:20`
- Problem: Animation cycling is disabled if `AUTOBEAT_REDUCE_MOTION=1` or `NO_MOTION=1` is set. **Neither variable is documented** in the release notes, the README, the dashboard help text, or the CLI help. A motion-sensitive user has no way to discover this opt-out without reading source.
- Impact: WCAG 2.3.3 (Animation from Interactions) and WCAG 2.2.2 (Pause, Stop, Hide) terminal equivalents — the mechanism exists but is hidden.
- Fix:
  1. Add to RELEASE_NOTES_v1.3.0.md and README under "Accessibility" or "Environment variables".
  2. Optionally surface a `?` help overlay item: "Set NO_MOTION=1 to disable spinners".
  3. Honor the de-facto standard `NO_COLOR=1` env var as well (not part of this PR but worth filing).

---

## Pre-existing Issues (Not Blocking)

**Status indicators in `format.ts` map `queued` and `expired` to the same `gray` color** — Confidence: 70%
- File: `src/cli/dashboard/format.ts:65-68`
- Problem: `statusColor()` returns `'gray'` for `queued`, `expired`, and the default fallback. A user filtering by status sees the same color for active queue items and expired schedules. There's an icon distinction (`queued: '○'`, no icon for `expired`), but the icon-less default falls back to `'○'` (`format.ts:88`).
- Note: This file changed in this PR (+8 lines), but the color/icon mapping itself looks pre-existing. Treat as informational.

**Header `q=quit` hint uses `dimColor`** — Confidence: 68%
- File: `src/cli/dashboard/components/header.tsx:95`
- Problem: The only persistent quit hint is dim. New users may miss the only way to leave the app gracefully.
- Note: Pre-existing pattern; flagging for awareness rather than blocking.

---

## Suggestions (Lower Confidence)

- **`OrchestratorNav` doesn't react to terminal height** — `src/cli/dashboard/views/workspace-view.tsx:206` (Confidence: 65%) — passes hardcoded `height={24}` instead of computing from terminal rows; on tall or short terminals the nav scrolls with the wrong viewport. Not strictly an a11y issue but it interacts with reflow.
- **`shortId(...).slice(0, 8)` truncation** — `orchestrator-nav.tsx:39` (Confidence: 60%) — relies on string slice rather than `truncateCell`; harmless for ASCII IDs, fragile if a unicode emoji ever lands in an ID.
- **MetricsBar `wrap="truncate"` silently truncates** — `metrics-bar.tsx:67` (Confidence: 65%) — when content is wider than the bar, the user sees a sharp cut with no `…`. Pair with a width-aware truncation that appends an ellipsis.

---

## Summary

| Category | CRITICAL | HIGH | MEDIUM | LOW |
|---|---|---|---|---|
| Blocking | 0 | 5 | 0 | 0 |
| Should Fix | 0 | 2 | 5 | 0 |
| Pre-existing | 0 | 0 | 2 | 0 |

**Accessibility Score**: 6 / 10
**Recommendation**: CHANGES_REQUESTED

### Why not BLOCK
The dashboard is fully **operable** by keyboard — every action has a binding, no action is mouse-only, and `Esc` is consistent enough that no user is trapped. There are no functional exclusions for any user group. The reduced-motion opt-out exists. Keyboard-only users can complete every workflow.

### Why CHANGES_REQUESTED rather than APPROVED_WITH_CONDITIONS
The five HIGH-severity findings in the diff (hidden bindings, misleading footer, color-only resources, color-only metrics bar, color-only counts) collectively mean a meaningful population of users — color-blind, low-vision, screen-reader, or first-time — will have a degraded experience that the redesign was supposed to improve. The fixes are small and mechanical (add glyphs, update help text, drop a few `dimColor`s). They should land in this PR rather than be deferred.

### Suggested merge ordering
1. **Easy wins first (under 30 lines total):**
   - Remove `dimColor={!isSelected}` from `orchestration-detail.tsx:55`
   - Add glyph prefixes to `metrics-bar.tsx` and `counts-panel.tsx`
   - Add `[CRIT]`/`[WARN]`/`[OK]` labels to `resources-tile.tsx`
   - Fix the misleading `Tab: activity` hint in `footer.tsx`
2. **Discoverability (next iteration):**
   - Add a `?`/`h` help overlay listing all bindings for the current view
   - Document `NO_MOTION` / `AUTOBEAT_REDUCE_MOTION` in release notes
3. **Reflow (can be a follow-up):**
   - Render hidden-content disclosure in narrow mode
   - Add focus border to `OrchestratorNav` when `focusArea === 'nav'`

---

## Web a11y rules that did NOT translate to this PR

For completeness, the following rules from `devflow:accessibility` were checked and confirmed inapplicable in this terminal context:

| Web rule | Why inapplicable here |
|---|---|
| ARIA roles, `aria-label`, `aria-describedby`, `role="alert"` | Ink does not render to a DOM; there is no accessibility tree. Screen readers in terminals read the raw character stream. |
| Form labels (`<label htmlFor="">`) | No forms in this dashboard. |
| Focus trapping in modals | Ink doesn't have modals as separate windows; the closest equivalent is fullscreen mode in the workspace view, which is correctly exited by Esc. |
| Skip links | The terminal equivalent (jump-by-letter `m`/`w` for views) exists but is undocumented (see HIGH finding above). |
| Touch target size (≥24×24px) | No touch input in a terminal. |
| Copy-paste in auth fields | No auth in this dashboard. |
| `prefers-reduced-motion` CSS media query | The Ink equivalent is `AUTOBEAT_REDUCE_MOTION` env var, which is implemented but undocumented. |
| Color contrast ratio (4.5:1) | Cannot be measured numerically in a terminal — themes are user-controlled. The applicable rule is "don't rely on color alone" (1.4.1), which IS violated and is reported above. |
| Live regions (`aria-live`) | Terminal equivalent is the auto-refresh of the dashboard. Already in place via `useDashboardData`. |
