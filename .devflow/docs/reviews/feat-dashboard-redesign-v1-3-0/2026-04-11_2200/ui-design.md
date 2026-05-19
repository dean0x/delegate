# UI Design Review Report

**Branch**: feat/dashboard-redesign-v1.3.0 -> main
**Date**: 2026-04-11 22:00
**Scope**: Terminal UI (Ink). Web design principles translated to text-grid analogues.

## Iron Law Reminder

> AESTHETICS MUST HAVE INTENT. In a text grid that means: every padding, color, casing,
> and column choice must be justified by hierarchy or scanning behavior. Defaults are not
> justifications.

---

## Issues in Your Changes (BLOCKING)

### CRITICAL

None.

### HIGH

**Inconsistent tile chrome — only one of three top-row tiles has a border**
**Confidence**: 95%
- `src/cli/dashboard/components/cost-tile.tsx:31`, `src/cli/dashboard/components/resources-tile.tsx:41,55`, `src/cli/dashboard/components/throughput-tile.tsx:40`
- Problem: The three sibling tiles in `MetricsView`'s top row (`ResourcesTile`, `CostTile`, `ThroughputTile`) all render with `<Box flexDirection="column" paddingX={1}>` and **no border**. Meanwhile their sibling panels in the bottom row (`ActivityPanel`, `CountsPanel`) use `borderStyle="round"`. The "tile" metaphor in the file headers (`/* Tile */`) is undermined: visually these are three loose stacks of text floating against the background, not tiles. Ink renders them as a flush row with no visible separation between Resources / Cost / Throughput; the eye cannot tell where one tile ends and the next begins. This is a violation of Gestalt proximity (whitespace is the only thing telling Resources from Cost and there's only `paddingX={1}`, a 1-column gutter).
- Impact: Users cannot scan the metrics row at a glance. The intended "3 tile dashboard" layout reads as one wide blob.
- Fix: Pick one rule and apply it to **every** tile + panel:
  ```tsx
  // resources-tile.tsx, cost-tile.tsx, throughput-tile.tsx
  <Box flexDirection="column" borderStyle="round" paddingX={1} flexGrow={1}>
    ...
  </Box>
  ```
  And give each tile `flexGrow={1}` so they share the row width evenly. Without this, the row is left-packed and the right side of the terminal is empty. This is the single most impactful change in the PR for visual hierarchy.

**Tile widths are unconstrained — top row is left-packed, not justified**
**Confidence**: 90%
- `src/cli/dashboard/views/metrics-view.tsx:114-119`
- Problem: The top row is `<Box flexDirection="row" height={layout.topRowHeight}>` with three child tiles that have no `flexGrow`, no `width`, and no `flexBasis`. In Ink/Yoga this means each tile shrinks to its intrinsic content width, then the row's remaining columns are wasted. Result: on a 200-col terminal the three tiles cluster in the leftmost ~60 cols and the right 140 cols are empty. The `tileCount` field on `MetricsLayout` (2|3|4) is computed in `layout.ts:74` but **never read by the view**, so the responsive intent is dead code.
- Impact: Defeats the entire responsive `tileCount` design. On wide screens the dashboard looks broken/cramped in the upper-left.
- Fix:
  ```tsx
  <Box flexDirection="row" height={layout.topRowHeight}>
    <Box flexBasis={0} flexGrow={1}><ResourcesTile .../></Box>
    <Box flexBasis={0} flexGrow={1}><CostTile .../></Box>
    <Box flexBasis={0} flexGrow={1}><ThroughputTile .../></Box>
  </Box>
  ```
  Or push `flexGrow={1}` into the root `<Box>` of each tile component. Either way, **read `layout.tileCount`** and conditionally render fewer tiles when it's `2`.

**Counts panel labels have a phantom leading space — column is misaligned**
**Confidence**: 92%
- `src/cli/dashboard/components/counts-panel.tsx:34`
- Problem: The "running" count is rendered as `<Text color="green"> run {group.running}</Text>` — note the leading space inside the string. The `done` and `fail` siblings have no leading space. Combined with the `gap={1}` on the parent flex row, this produces visible double-spacing before "run" and single-spacing before "done" / "fail":
  ```
  Orchestrations
    run 2 done 5 fail 1   ← actual render
   run 2  done 5  fail 1  ← what gap={1} would produce alone
  ```
  This breaks the grid for any user scanning vertically across the four sections (Orchestrations, Loops, Tasks, Schedules), because the indent of "run" jitters relative to the section label depending on whether other status pills are present.
- Impact: The first column never aligns with the section label, breaking the visual grid.
- Fix: Remove the leading space:
  ```tsx
  <Text color="green">run {group.running}</Text>
  ```

**Counts panel: zero-state collapses entire status row, breaking vertical rhythm**
**Confidence**: 90%
- `src/cli/dashboard/components/counts-panel.tsx:34-36`
- Problem: `done` and `fail` are conditionally rendered (`{group.failed > 0 && ...}`), but `done` is **always** shown (no zero gate) while `running` has no zero gate either. So the row width changes per section: a section with `run 0 done 5` is narrower than `run 2 done 5 fail 1`. The four sections (Orchestrations / Loops / Tasks / Schedules) thus have different widths, ruining the column grid. Worse: when a section has `run 0 done 0 fail 0`, you still get `run 0 done 0` rendered — noise that draws the eye to "nothing happened here" instead of the active sections.
- Impact: Inconsistent row widths across sections; noisy zero values.
- Fix: Either always render all three pills with consistent padding, or hide all zero values uniformly. Recommend always render with padded fixed widths so columns align:
  ```tsx
  <Box flexDirection="row" gap={2}>
    <Text color="green">{`run  ${String(group.running).padStart(3)}`}</Text>
    <Text dimColor>{`done ${String(group.completed).padStart(3)}`}</Text>
    <Text color="red">{`fail ${String(group.failed).padStart(3)}`}</Text>
  </Box>
  ```
  This guarantees grid alignment regardless of values, and the padding makes the numbers easy to scan.

**Activity feed columns are not grid-aligned — only one of five columns is fixed-width**
**Confidence**: 95%
- `src/cli/dashboard/components/activity-panel.tsx:47-64`
- Problem: `renderActivityRow` builds a row by concatenating `timeStr`, `kind`, `id`, `status`, `action` separated by `'  '` literal string spacers. Of these only `status` is `padEnd(12)` for fixed width. `id` is `shortId()` which returns the **first 12 chars of the entity ID** — but `entityId` length varies by entity kind: a `TaskId` like `task_01J...` is one length, an orchestration UUID `019...` is another, and the slice is from the start so trailing alphanumeric variance jitters per row. `action` and `timeStr` happen to be fixed, but `id` is not. Result: the `status` column starts at a different column on every row, and so does `action`.
- Impact: The activity feed reads as a ragged list, not a table. Users cannot vertically scan a single column (e.g. "show me only failed rows").
- Fix: Either pad each column explicitly, or use a flex Box layout per row instead of a single Text node:
  ```tsx
  return (
    <Box key={entry.entityId}>
      <Box width={6}><Text>{timeStr}</Text></Box>
      <Box width={6}><Text>{kind}</Text></Box>
      <Box width={14}><Text>{id}</Text></Box>
      <Box width={14}><Text>{status}</Text></Box>
      <Box flexGrow={1}><Text wrap="truncate">{action}</Text></Box>
    </Box>
  );
  ```
  Note: this also gives you a free truncation for long actions, which the current single-Text approach lacks.

**CostTile: empty `<Text>` wrapper around the headline cost adds a blank row**
**Confidence**: 88%
- `src/cli/dashboard/components/cost-tile.tsx:33-35`
- Problem:
  ```tsx
  <Text bold>Cost (24h)</Text>
  <Text>
    <Text bold>{formatCost(totalCostUsd)}</Text>
  </Text>
  ```
  The middle `<Text>` is an empty wrapper around an inner `<Text bold>`. This serves no purpose — Ink will render it as a row with just the bold cost — but the design intent (presumably "make the headline visually dominant by giving it its own line") is lost because there's no size differentiation between "Cost (24h)" and "$12.34". Both render at the same scale, both bold. There is no visual hierarchy: the label and the value have equal weight.
- Impact: The KPI you most want to draw attention to (the dollar figure) does not stand out from its label.
- Fix: Make the value visually dominant relative to the label:
  ```tsx
  <Text bold dimColor>COST (24H)</Text>
  <Text bold color="green">{formatCost(totalCostUsd)}</Text>
  ```
  The label uses `dimColor` + uppercase to recede, and the value uses bold + a semantic color (green = money/success). This is the TUI analogue to the type-scale + color-tone hierarchy described in `devflow:ui-design` patterns.

**Color semantics collide: cyan = "running" AND "info/focused" AND "primary"**
**Confidence**: 90%
- `src/cli/dashboard/components/metrics-bar.tsx:30`, `src/cli/dashboard/format.ts:54`, `src/cli/dashboard/components/orchestrator-nav.tsx:43`, `src/cli/dashboard/components/activity-panel.tsx:69,74`, `src/cli/dashboard/components/empty-workspace.tsx:23`, `src/cli/dashboard/components/header.tsx:85`
- Problem: Cyan is overloaded in this PR with three different meanings:
  1. `statusColor()` returns `'cyan'` for `running`/`active`/`planning` (semantic = work in progress)
  2. `OrchestratorNav` uses `color="cyan"` for the **focused/keyboard-cursor** row (semantic = UI focus)
  3. `ActivityPanel` uses `color="cyan"` for the **focused panel header + border** (semantic = UI focus)
  4. `Header` uses `color="cyan"` for the **brand "Autobeat v..."** title (semantic = brand/primary)
  5. `EmptyWorkspace` uses `color="cyan"` for the inline `\`beat orchestrate\`` code hint (semantic = link/code)
  When a running task is also the focused row in a focused panel inside a brand-cyan-titled view, the user cannot tell which signal "cyan" represents at any given location. This is a textbook color-collision.
- Impact: Color stops conveying meaning. Users learn to ignore color, which then breaks the green=success/red=error/yellow=warn signaling that does work.
- Fix: Pick one of:
  - **Option A (recommended)**: Reserve `cyan` for **state = running** only. Use a different color for UI focus (e.g. `magenta` or a dim+bold treatment). Use a third for brand. The `devflow:ui-design` color-system principle: each token has exactly one semantic role.
  - **Option B**: Establish a documented color token mapping in `format.ts` (or a new `colors.ts`) and treat `running`-cyan and `focus`-cyan as the same intentional choice (because they never co-occur with the same UI affordance). Document the reasoning so future devs don't expand the collision.

**MetricsBar status `gray` and `white` defaults conflict with color-blind users and dark themes**
**Confidence**: 80%
- `src/cli/dashboard/components/metrics-bar.tsx:36-42`
- Problem: `statusColor()` here (a **second copy** of the function — see the consistency issue below) returns `'gray'` for `queued`/`pending` and `'white'` for unknown. On many dark-themed terminals (Solarized Dark, OneDark), `gray` is barely distinguishable from background dim text, and `white` collides with the default foreground. Worse: this function disagrees with `format.ts:statusColor()` — the canonical version returns `'gray'` only via the `default` case, not for `queued`. Two identically named functions, two different semantic mappings.
- Impact: Same status renders different colors in different parts of the dashboard.
- Fix: Delete the local `statusColor` in `metrics-bar.tsx:28-43` and import from `format.ts`. If MetricsBar needs different colors (which it shouldn't), make the difference explicit and documented.

### MEDIUM

**Inconsistent label casing across tiles and panels**
**Confidence**: 92%
- `src/cli/dashboard/components/cost-tile.tsx:32`, `src/cli/dashboard/components/resources-tile.tsx:42,56`, `src/cli/dashboard/components/throughput-tile.tsx:41`, `src/cli/dashboard/components/counts-panel.tsx:44`, `src/cli/dashboard/components/activity-panel.tsx:74,84`
- Problem: Tile and panel headers mix Title Case ("Resources", "Cost (24h)", "Throughput", "Counts", "Activity", "Orchestrations", "Loops", "Tasks", "Schedules") with arbitrary parenthetical annotation ("Cost (24h)" vs no annotation on the others). Inside tiles, sub-labels mix Title Case + Sentence case ("CPU" / "Mem" / "Workers" / "Load" — initial cap, no period) with abbreviations ("Avg dur" — abbrev, capital first, lowercase second). The activity feed kind labels go further into lowercase ("task ", "loop ", "orch ", "sched"). There is no rule. In a text grid, casing IS your typographic scale (you have no font size); inconsistent casing = inconsistent type hierarchy.
- Impact: The dashboard reads as several different products glued together.
- Fix: Adopt **one** rule and apply it everywhere. Recommended:
  - Tile/panel **headers**: `UPPERCASE BOLD DIM` (the TUI equivalent of an h2)
  - Sub-labels inside tiles: `Sentence case` non-bold
  - Status pill labels: `lowercase` (already done in counts-panel)
  Then apply uniformly:
  ```tsx
  <Text bold dimColor>RESOURCES</Text>
  <Text bold dimColor>COST · 24H</Text>
  <Text bold dimColor>THROUGHPUT</Text>
  <Text bold dimColor>COUNTS</Text>
  <Text bold dimColor>ACTIVITY</Text>
  ```

**Footer help bars: inconsistent separators, inconsistent grouping**
**Confidence**: 90%
- `src/cli/dashboard/components/footer.tsx:15-20`
- Problem: Three help-text strings with three different separator/grouping styles:
  ```
  MAIN_HELP:           'v: workspace · Tab: activity · ↑↓: select · Enter: detail · f: filter · r refresh · q quit'
  WORKSPACE_HELP:      'v: metrics · ↑↓: orch · Enter commit/detail · Tab panel · f fullscreen · [/] scroll · G tail · c/d · Esc'
  DETAIL_HELP:         'Esc back · ↑↓ scroll · r refresh · q quit'
  ```
  Issues:
  1. Some hints use `key: action` (with colon: `v: workspace`, `↑↓: select`), others use `key action` (no colon: `r refresh`, `q quit`, `↑↓ scroll`). Mixed within the **same string** in MAIN_HELP.
  2. Hints are not grouped by action type. They should cluster: navigation (↑↓, Tab, Enter, Esc), mode-switch (v, f), action (c, d, r), exit (q).
  3. WORKSPACE_HELP cryptic abbreviations: `c/d` is "cancel/delete" but the user has to guess; `G tail` is git-tail-pager-like but not in the rest of the dashboard's vocabulary.
- Impact: Users have to read each footer fresh because there's no muscle memory across views.
- Fix: Pick a single format. Recommendation:
  ```ts
  // Format: 'KEY action · KEY action · ... | KEY action · KEY action'
  // Pipes separate groups: navigation | mode | actions | exit
  const MAIN_HELP =
    '↑↓ select · Enter detail · Tab activity feed | v workspace · f filter | r refresh | q quit';
  ```
  Always `KEY action` (no colon). Always grouped. Always lowercase action (consistent with prior pattern).

**OrchestratorNav uses both `>` prefix AND `inverse` AND `bold` AND `cyan` for state — too many cues**
**Confidence**: 85%
- `src/cli/dashboard/components/orchestrator-nav.tsx:38-45`
- Problem: The renderer uses **four** simultaneous visual cues to distinguish focused vs. committed:
  - `prefix = '>'` (focused only)
  - `bold` (committed only)
  - `inverse` (committed only)
  - `color: 'cyan'` (focused only)
  When focus AND committed coincide on the same row, the cell becomes a `> bold inverse cyan` block, which is hard to read because cyan-on-cyan-background becomes near-illegible on most terminal palettes (cyan inverse = black text on cyan = OK; but the bold cyan text becomes black under inverse — losing the cyan signal entirely). The "four cues" approach also gives you no headroom: if you later add a "selected" or "muted" state, you've used all your visual channels.
- Impact: Visual states collide; cyan signal is destroyed under `inverse`.
- Fix: Use **two** channels max — one for focus, one for committed. E.g.:
  - Focused: `>` prefix + bold
  - Committed: `★` prefix (or different glyph) + cyan color
  - Both: `★` prefix + bold + cyan
  This keeps each state independently legible.

**Header breadcrumb is rendered as `[M] Metrics` / `[W] Workspace` / `[D] Detail` — bracket notation is hostile**
**Confidence**: 80%
- `src/cli/dashboard/components/header.tsx:64-75`
- Problem: `buildBreadcrumb` uses `[M]`, `[W]`, `[D]` square-bracket key hints inside the breadcrumb. Two issues:
  1. There IS no `M` keybinding to switch to metrics — you press `v` (per `WORKSPACE_HELP` and `MAIN_HELP`). The bracket implies a key that doesn't exist.
  2. Real breadcrumbs use `>` separators and show ancestry (e.g., `Metrics > Activity > Task abc123`). This is a static label dressed up as a breadcrumb.
- Impact: User presses `M` thinking it switches views, nothing happens. Confusion compounds because workspace footer says `v: metrics` but header says `[M] Metrics`.
- Fix: Either drop the brackets (just render `Metrics` / `Workspace` / `Detail`), or fix the keybinding to actually be `M`/`W`/`D`. Prefer the former since the existing `v` toggle is documented in footer help text.

**Header health summary collapses three concepts into one row with semantic glyphs that don't match status icons**
**Confidence**: 78%
- `src/cli/dashboard/components/header.tsx:46-50`, `src/cli/dashboard/format.ts:73-81`
- Problem: `buildHealthSummary` uses these glyphs: `●` (running), `○` (queued), `✗` (failed). But `format.ts:STATUS_ICONS` has `running: '●'`, `queued: '○'`, `failed: '✗'` AND **also** `paused: '⏸'`, `completed: '✓'`. The header omits paused and completed entirely — yet `Counts` panel shows them. So a user with 3 paused loops sees them in `Counts` but not in the header health summary, which silently buckets them under `queued` instead. There's also a mismatch: `cancelled` is bucketed into "failed" in the header but `format.ts:statusColor` gives `cancelled` red (same as failed) and `STATUS_ICONS` gives it `✗` (same as failed) — fine, but `expired` is bucketed into "queued" in the header (`scheduleCounts.byStatus['paused']`) which is semantically wrong. Schedule "cancelled" is bucketed into "failed" in the header — also semantically wrong (cancellation is intentional, failure is not).
- Impact: Header health summary lies. A user with cancelled (intentional) schedules sees a "1 fail" badge.
- Fix: Either show only `running` / `queued` / `failed` and document that "failed = unhealthy state count, including cancelled" — or split into 4-5 categories. Recommend the latter; the `gap={2}` flex row in the header has plenty of room.

**EmptyWorkspace text uses backticks for code, but renders them as literal characters**
**Confidence**: 92%
- `src/cli/dashboard/components/empty-workspace.tsx:22-23`
- Problem:
  ```tsx
  <Text dimColor>
    Run <Text color="cyan">`beat orchestrate`</Text> to create one.
  </Text>
  ```
  The backticks `\`` are inside the JSX text node and render literally as backtick characters around `beat orchestrate`. This is markdown habit leaking into a TUI: in markdown, backticks become code formatting; in Ink Text, they're just characters. The user sees:
  ```
  Run `beat orchestrate` to create one.
  ```
  Not exactly broken but not what was intended — the cyan color is doing the "this is code" job already, the backticks are visual noise.
- Impact: Cluttered empty state.
- Fix: Drop the backticks; rely on cyan + bold:
  ```tsx
  Run <Text color="cyan" bold>beat orchestrate</Text> to create one.
  ```

**MetricsBar truncation thresholds are magic numbers, not derived from anything**
**Confidence**: 75%
- `src/cli/dashboard/components/metrics-bar.tsx:59-62`
- Problem:
  ```tsx
  if (width > 40) parts.push(elapsedPart);
  if (width > 55 && agentPart) parts.push(agentPart);
  if (width > 65) parts.push(bytesPart);
  if (width > 75 && costPart) parts.push(costPart);
  ```
  The thresholds 40/55/65/75 are not derived from string widths and are not documented. If `kind` becomes 6 chars instead of 5 (say, "ORCH " becomes "ORCHE"), or `status` becomes longer ("recovering" instead of "running"), the bar overruns and Ink truncates with `wrap="truncate"` — silently dropping content that fits the threshold check. The "responsive" design is fragile.
- Impact: Silent content loss when status/kind change.
- Fix: Compute the thresholds from the actual joined width:
  ```tsx
  const sep = ' · ';
  const parts: string[] = [kindPart, statusPart];
  function tryAdd(part: string): void {
    if (!part) return;
    const next = [...parts, part].join(sep);
    if (next.length <= width) parts.push(part);
  }
  tryAdd(elapsedPart);
  tryAdd(agentPart);
  tryAdd(bytesPart);
  tryAdd(costPart);
  ```
  Now the bar truncates at the **actual** column width, not at hardcoded thresholds.

**OrchestratorNav has hardcoded `height={24}` — defeats responsive layout**
**Confidence**: 90%
- `src/cli/dashboard/views/workspace-view.tsx:206`
- Problem:
  ```tsx
  <OrchestratorNav
    ...
    height={24} // reasonable default; actual height from terminal
  />
  ```
  The comment literally says "actual height from terminal" — but the value is hardcoded. On a 30-row terminal you waste 6 rows; on a 50-row terminal the nav cuts off at 24 even though you have 26 rows left. The whole `layout.ts` exercise (175 lines of responsive math) is bypassed for this single component.
- Impact: Workspace nav is the wrong height on every terminal that isn't exactly 24 rows tall.
- Fix: Plumb `rows - headerHeight - footerHeight` (or a layout field like `layout.navHeight`) into `OrchestratorNav`:
  ```ts
  // layout.ts WorkspaceLayout
  readonly navHeight: number;
  // computeWorkspaceLayout
  const navHeight = rows - headerHeight - footerHeight - 1; // -1 for "Orchestrations" header row
  ```
  Then `<OrchestratorNav ... height={layout.navHeight} />`.

**OrchestrationDetail child rows: status `padEnd(10)` and `padEnd(8)` plus single space — column drift from the children listing in workspace-view**
**Confidence**: 78%
- `src/cli/dashboard/views/orchestration-detail.tsx:46-58`
- Problem: This view renders child rows as:
  ```tsx
  const status = child.status.toString().slice(0, 10).padEnd(10);
  const agent = (child.agent ?? '—').slice(0, 8).padEnd(8);
  const line = `${shortId}  ${kind}  ${status}  ${agent}  ${promptPreview}`;
  ```
  Meanwhile `ActivityPanel` uses `padEnd(12)` for status (line 47) and a different column order. The same conceptual table (a list of tasks) has different column widths in two different views. User memory of "status starts at column 30" is invalidated when they navigate from Activity to Orchestration Detail.
- Impact: No consistency across "list of tasks" surfaces.
- Fix: Extract a single `<TaskRow>` component that takes a `child` and renders consistent columns. Use it in both views.

**`isSelected` styling in OrchestrationDetail uses three cues simultaneously**
**Confidence**: 72%
- `src/cli/dashboard/views/orchestration-detail.tsx:54-57`
- Problem:
  ```tsx
  <Text color={isSelected ? 'blue' : undefined} inverse={isSelected} dimColor={!isSelected}>
  ```
  Selected rows get `blue` + `inverse` + `not-dim`; unselected rows get `undefined` color + `not-inverse` + `dim`. Combined with `inverse`, blue text on a blue background = invisible on most terminal palettes. (Inverse swaps fg/bg; on a default-dark terminal, blue text becomes blue background; but the actual rendered color depends on terminal theme — Solarized renders this as near-invisible.)
- Impact: Selected child row may be unreadable depending on terminal theme.
- Fix: Pick one cue per axis. For selection use `inverse` only (terminal-theme-safe). For "this is the highlighted entity kind" use a stable color or a left-bar prefix (`▶ `).

### LOW

**`shortId` slices to 12 chars but `OrchestratorNav` uses `slice(-8)` — different short-id schemes in the same dashboard**
**Confidence**: 90%
- `src/cli/dashboard/format.ts:248`, `src/cli/dashboard/components/orchestrator-nav.tsx:39`, `src/cli/dashboard/views/workspace-view.tsx:176`, `src/cli/dashboard/views/orchestration-detail.tsx:46`
- Problem: Three different abbreviation strategies for entity IDs:
  - `format.ts:shortId` → `id.slice(0, 12)` (first 12 chars)
  - `OrchestratorNav` → `id.slice(-8)` (last 8 chars)
  - `workspace-view headerText` → `id.slice(-8)` (last 8 chars)
  - `OrchestrationDetail child rows` → `child.taskId.slice(0, 12)` (first 12)
  - `ActivityPanel` (via `shortId`) → first 12
  The same orchestration appears as `019d3a7c1234` in the activity feed and `7c123456` (last 8) in the workspace nav. They look like different entities.
- Impact: Users cannot correlate IDs across views.
- Fix: Standardize on `shortId(id)` from `format.ts` everywhere. If `slice(-8)` is preferred for orchestrations because the prefixes are deterministic, change `shortId` to do that and apply universally.

**ResourcesTile bar: 10-cell width is fixed regardless of tile width**
**Confidence**: 70%
- `src/cli/dashboard/components/resources-tile.tsx:16`
- Problem: `BAR_WIDTH = 10` is constant. On a wide terminal where the tile gets 60+ columns, the 10-cell bar is dwarfed by whitespace and looks tiny. On a narrow terminal where the tile is 20 cols, the bar plus label plus percent is cramped.
- Impact: Bar visualization doesn't use available space.
- Fix: Plumb tile width down to ResourcesTile and compute `BAR_WIDTH = clamp(Math.floor((tileWidth - 14) / 1), 6, 20)` or similar.

**ResourcesTile: `Workers` and `Load` have no visual treatment differentiating them from CPU/Mem (which have bars)**
**Confidence**: 68%
- `src/cli/dashboard/components/resources-tile.tsx:67-70`
- Problem:
  ```tsx
  <Text>Workers {workerCount}</Text>
  <Text>
    Load {loadAverage[0].toFixed(1)} {loadAverage[1].toFixed(1)} {loadAverage[2].toFixed(1)}
  </Text>
  ```
  Labels are same casing as CPU/Mem (which render as bars), so the four rows look like the same kind of metric, but two are visualizations and two are raw numbers. There's no visual hint about which is which.
- Impact: Inconsistent metric presentation within a single tile.
- Fix: Either give Workers/Load a visualization (a load-average bar) OR group them visually (e.g., a thin dim divider line, or a separate sub-section header).

**OutputStreamView `[paused]` indicator uses lowercase brackets and dim color — easy to miss**
**Confidence**: 70%
- `src/cli/dashboard/components/output-stream-view.tsx:91-97`
- Problem: When the user explicitly pauses streaming, the indicator is `<Text dimColor>[paused]</Text>` — dim, lowercase, in brackets. The `prefers-reduced-motion` analogue here is "make state transitions visible." A dim lowercase tag is the opposite: it disappears.
- Impact: Users may not realize their stream is paused.
- Fix: Make the paused indicator more prominent — yellow background, bold uppercase, or with a glyph:
  ```tsx
  <Text color="yellow" bold>⏸ PAUSED</Text>
  ```

**`MetricsView` narrow mode skips `ThroughputTile` entirely without explanation**
**Confidence**: 78%
- `src/cli/dashboard/views/metrics-view.tsx:90-97`
- Problem: In narrow mode the view renders `ResourcesTile` and `CostTile` but **not** `ThroughputTile`. The reasoning isn't documented and users don't know information is being hidden. Worse: if a user is on a narrow terminal looking for throughput stats, they'll search the docs/menus instead of resizing.
- Impact: Silent feature hiding.
- Fix: Either include `ThroughputTile` in narrow mode (it's tiny, just 4 lines), or add a hint:
  ```tsx
  <Text dimColor>Narrow terminal — Throughput hidden. Resize to ≥60 cols to view.</Text>
  ```

**Header right cluster uses `gap={2}` but adds `q=quit` to a help-bar position — duplicates Footer**
**Confidence**: 75%
- `src/cli/dashboard/components/header.tsx:93-96`
- Problem: The header right side renders `<Text dimColor>q=quit</Text>` next to the timestamp. But the footer also shows `q quit` (or `q: quit`, depending on view). The hint is duplicated, occupying valuable header column space, and it uses the **third** key-hint format (`q=quit` with equals sign) — different from both footer styles (`q quit` and `q: quit`).
- Impact: Visual noise + format collision.
- Fix: Remove `q=quit` from the header. The footer is the canonical place for keybindings.

**`Cost (24h)` parenthetical annotation is the only one of its kind**
**Confidence**: 70%
- `src/cli/dashboard/components/cost-tile.tsx:32`
- Problem: Only the cost tile has a time-window annotation in its title. Throughput shows `Tasks/hr` — a per-hour rate, but the tile title is just "Throughput" not "Throughput (1h)". Resources show current snapshots with no time annotation. The CostTile is the outlier.
- Impact: User cannot tell what time window each tile represents.
- Fix: Either add `(now)` / `(1h)` to all tiles, or remove `(24h)` from CostTile and put it in a sub-row:
  ```tsx
  <Text bold dimColor>COST</Text>
  <Text dimColor>last 24h</Text>
  ```

**`HeaderProps.viewKind` is optional with a vague comment** (consistency, not visual)
**Confidence**: 80%
- `src/cli/dashboard/components/header.tsx:19`
- Problem: `viewKind?: 'main' | 'workspace' | 'detail';` with comment "Optional for backward compatibility with tests that don't pass it." That's a test-shape concern leaking into production prop typing. Visually, when omitted, the breadcrumb area is empty — the user gets no view-context label. Tests should be fixed to always pass `viewKind`.
- Impact: Header is contextless when used outside the App shell.
- Fix: Make `viewKind` required, update tests to pass it.

---

## Issues in Code You Touched (Should Fix)

**Two `statusColor` functions exist with different mappings**
**Confidence**: 95%
- `src/cli/dashboard/format.ts:50-70` (canonical) and `src/cli/dashboard/components/metrics-bar.tsx:28-43` (local copy)
- Problem: Two implementations of `statusColor`. The canonical one in `format.ts` returns `'cyan'` for `running` but the metrics-bar copy also returns `'cyan'` for running — at least they agree on that one. But:
  - format.ts: `paused → 'yellow'`, `queued → 'gray'` (via default), `expired → 'gray'`
  - metrics-bar.ts: `queued → 'gray'`, `pending → 'gray'`, no paused/expired handling
  - format.ts has `'active' → 'cyan'` and `'planning' → 'cyan'`; metrics-bar.ts has neither, so an active/planning task in MetricsBar falls into `default → 'white'` instead of `'cyan'`.
- Impact: A planning task shows cyan in the activity feed and white in the metrics bar of its task panel. Same status, two colors.
- Fix: Delete `metrics-bar.tsx:statusColor` and import from `format.ts`. This is a single 1-line change that eliminates an entire class of color drift.

**Activity feed `kindLabel` uses 5-char fixed widths but the labels mix abbreviation and spacing**
**Confidence**: 85%
- `src/cli/dashboard/components/activity-panel.tsx:30-41`
- Problem:
  ```tsx
  case 'task': return 'task ';   // 5 chars (4 + space)
  case 'loop': return 'loop ';   // 5 chars
  case 'orch': return 'orch ';   // 5 chars
  case 'schedule': return 'sched';  // 5 chars (no space)
  ```
  Three of four have a trailing space; the fourth uses the space for the 5th letter. This works for column alignment, but the inconsistency means a future maintainer will break it. Document or normalize.
- Fix:
  ```tsx
  case 'task': return 'TASK ';
  case 'loop': return 'LOOP ';
  case 'orchestration': return 'ORCH ';
  case 'schedule': return 'SCHED';
  ```
  Uppercase pulls these into the type-scale role of "tag" — distinct from the content.

**`Header.formatTime` uses `toLocaleTimeString` while `ActivityPanel.formatTime` uses manual `padStart` — same operation, two implementations**
**Confidence**: 88%
- `src/cli/dashboard/components/header.tsx:56-58`, `src/cli/dashboard/components/activity-panel.tsx:24-28`
- Problem: Same conceptual function, two implementations. `toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false })` and the manual `${h}:${m}` produce identical output 99% of the time, but locale variants can diverge.
- Fix: Add a single `formatTimeHHMM(date: Date): string` to `format.ts` and use it from both.

---

## Pre-existing Issues (Not Blocking)

None significant that this PR didn't touch.

---

## Suggestions (Lower Confidence)

- **`MetricsView` narrow mode shows the warning text every render, even when user has been in narrow mode for minutes** - `src/cli/dashboard/views/metrics-view.tsx:92` (Confidence: 65%) — Consider showing the hint only on first transition into narrow mode, or auto-hiding after 3s. Persistent hint becomes noise.
- **Tile horizontal alignment of label-vs-value pairs is inconsistent** - `src/cli/dashboard/components/throughput-tile.tsx:42-45`, `src/cli/dashboard/components/resources-tile.tsx:67-70` (Confidence: 62%) — Throughput uses `Tasks/hr {n}` (label-value with single space), Resources uses `Workers {n}` (same), but the values aren't right-aligned. In a TUI, right-aligning the numbers would let users scan them vertically. Consider a 2-column flex layout per row.
- **Footer border uses `borderTop borderBottom={false} borderLeft={false} borderRight={false}` — verbose pattern** - `src/cli/dashboard/components/footer.tsx:33` (Confidence: 60%) — Wrap in a `BorderTop` helper or use a comment explaining why the asymmetric border style is needed.

---

## Summary

| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 8 | 11 | 8 |
| Should Fix | - | 3 | 0 | - |
| Pre-existing | - | - | 0 | 0 |

**UI Design Score**: 5/10

The redesign introduces strong **structural** primitives (responsive layout math in `layout.ts`, separation of view/components, pure rendering, well-tested) but the **visual** design is inconsistent at the surface level. The most damaging issues are:

1. **Tiles have no visible boundaries** — the row reads as a blob (HIGH 1-2)
2. **Color semantics are overloaded** — cyan means 4 different things (HIGH 7)
3. **Casing has no rule** — labels mix Title/lowercase/abbreviation arbitrarily (MEDIUM 1)
4. **Two `statusColor` functions diverge** — same status renders different colors in different views (Should-Fix 1)
5. **Hardcoded `height={24}` in OrchestratorNav** — bypasses the responsive layout system (MEDIUM 5)

These are all fixable in <1 day of focused polish. The architecture is sound; the visual layer needs a consistency pass before merge.

**Recommendation**: **CHANGES_REQUESTED** — fix the 8 HIGH issues before merging. The MEDIUM and LOW items can land in a follow-up polish PR, but the HIGH items materially harm the dashboard's first impression and the cyan-collision issue compounds future design work.
