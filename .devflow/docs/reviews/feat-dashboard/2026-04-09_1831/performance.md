# Performance Review Report

**Branch**: feat-dashboard -> main
**Date**: 2026-04-09
**PR**: #131

## Issues in Your Changes (BLOCKING)

### HIGH

**Polling interval fires 8 parallel SQLite queries every 1 second** - `src/cli/dashboard/use-dashboard-data.ts:168`
**Confidence**: 90%
- Problem: `useDashboardData` runs 8 database queries in parallel (`Promise.all` of 4 `findAll(50)` + 4 `countByStatus()`) every 1,000ms via `setInterval`. SQLite is fundamentally single-threaded with WAL mode, so these 8 queries serialize at the engine level while occupying the Node event loop with 8 scheduled microtasks per second. At 1s intervals, a slow query (e.g., during heavy writes from running tasks) could cause poll overlap where the next interval fires before the previous completes. The `closing` ref guards against post-unmount state updates but does not prevent concurrent in-flight fetches.
- Impact: Under load (many running tasks/loops writing to the same DB), overlapping polls can queue up, increasing latency and causing stale-looking UI. In the detail view, an additional `fetchDetailExtra` call adds a 9th query per cycle.
- Fix: Add a guard to skip the poll if a previous fetch is still in-flight, and consider increasing the default interval to 2-3 seconds (still responsive for a dashboard):

```typescript
// In useDashboardData:
const fetching = useRef(false);

const doFetch = useCallback(async (): Promise<void> => {
  if (fetching.current) return; // Skip if previous poll still running
  fetching.current = true;
  try {
    const result = await fetchAllData(ctx, viewState);
    if (closing.current) return;
    if (!result.ok) {
      setError(result.error);
      return;
    }
    setData(result.value);
    setError(null);
    setRefreshedAt(new Date());
  } catch (e) {
    if (!closing.current) {
      const message = e instanceof Error ? e.message : String(e);
      setError(`Unexpected fetch error: ${message}`);
    }
  } finally {
    fetching.current = false;
  }
}, [ctx, viewState]);

// And increase interval:
const intervalId = setInterval(() => { void doFetch(); }, 2_000);
```

---

**`truncateCell` calls `stringWidth` per character in a loop** - `src/cli/dashboard/format.ts:107-116`
**Confidence**: 85%
- Problem: The `truncateCell` function iterates over each character of the input string and calls `stringWidth(char)` for every single character. `stringWidth` internally processes ANSI escape sequences and Unicode width tables. This is O(n) per character, making the overall truncation O(n^2) in the worst case for wide strings. This function is called in hot render paths: every `TableRow` calls it for each cell, and detail views call it for iteration/execution rows -- all re-rendered every 1 second.
- Impact: For typical short strings (task prompts under 60 chars), the overhead is negligible. But prompts can be long, and with 50 items per panel times multiple cells per row, this adds up on every poll-triggered re-render.
- Fix: Call `stringWidth` once upfront to check if truncation is needed (already done on line 98), then use a single-pass approach that accumulates width without per-character `stringWidth` calls. Alternatively, use a simple byte-length heuristic for ASCII-only strings:

```typescript
export function truncateCell(text: string, maxWidth: number): string {
  if (stringWidth(text) <= maxWidth) return text;

  // For ASCII-only text, simple slice is sufficient
  if (/^[\x20-\x7E]*$/.test(text)) {
    return `${text.slice(0, maxWidth - 1)}...`;
  }

  // Unicode path: accumulate width character-by-character
  const targetWidth = maxWidth - 1;
  let result = '';
  let currentWidth = 0;
  for (const char of text) {
    const charWidth = stringWidth(char);
    if (currentWidth + charWidth > targetWidth) break;
    result += char;
    currentWidth += charWidth;
  }
  return `${result}...`;
}
```

### MEDIUM

**`filteredLength` in `useKeyboard` re-filters the full array on every keystroke** - `src/cli/dashboard/use-keyboard.ts:45-49`
**Confidence**: 82%
- Problem: `filteredLength` calls `items.filter(...)` to count filtered items. This is invoked inside the `setNav` updater for every up/down arrow key press and every filter cycle. It also captures `data` from the outer closure (line 163), which may be stale relative to the state updater's `prev` argument.
- Impact: With 50 items per panel, the filtering itself is trivially fast. The concern is the stale closure: `data` is captured when `useInput` fires, but `setNav` runs asynchronously. In practice with 50-item limits this is a UI correctness nit rather than a performance bottleneck, so severity is MEDIUM.
- Fix: Move the clamping logic to the render phase (compute filtered length from the data that is actually rendered) rather than inside the keyboard handler. Alternatively, pass `data` into the `setNav` updater via a ref to ensure freshness:

```typescript
const dataRef = useRef(data);
dataRef.current = data;
// Then in handler:
const length = filteredLength(panel, dataRef.current, prev.filters[panel]);
```

---

**StatusBadge animation creates a `setInterval` per animated badge** - `src/cli/dashboard/components/status-badge.tsx:52-55`
**Confidence**: 80%
- Problem: Each `StatusBadge` with an animated status ('running', 'active', 'planning') creates its own `setInterval` at 250ms. In a dashboard showing, say, 10 running tasks + 3 running loops + 2 active schedules, that is 15 independent intervals each triggering a React state update 4 times per second. Combined with the 1s polling interval, this creates a high re-render frequency.
- Impact: Ink re-renders the entire component tree on each state change. 15 badges at 250ms = 60 state updates/second just for animation, on top of the 1/s data poll. This can cause visible flicker or CPU usage in terminals with many active entities.
- Fix: Lift the animation frame to a single shared interval at the `App` level (or a shared context), and pass the current frame index down as a prop. This reduces N intervals to 1:

```typescript
// In App or a shared hook:
const [animFrame, setAnimFrame] = useState(0);
useEffect(() => {
  const id = setInterval(() => setAnimFrame(f => (f + 1) % 4), 250);
  return () => clearInterval(id);
}, []);
// Pass animFrame to StatusBadge as a prop
```

## Issues in Code You Touched (Should Fix)

### MEDIUM

**`readFileSync` used at startup for `package.json`** - `src/cli/dashboard/index.tsx:40`
**Confidence**: 82%
- Problem: `readFileSync` is a synchronous blocking I/O call. The performance skill flags all `readFileSync` usage. However, this call happens once at startup (before the React render loop), not in a hot path.
- Impact: Minimal in practice -- a single blocking read of a small JSON file at startup. The terminal is not yet rendering when this executes. This is LOW severity given the one-time nature, but flagged for consistency with the project's async-first patterns.
- Fix: Use `await fs.promises.readFile(...)` for consistency, or accept this as an acceptable startup-path exception. The current approach is pragmatic and not a real bottleneck.

---

**`findEntity` in DetailView uses `.find()` linear scan** - `src/cli/dashboard/views/detail-view.tsx:37-44`
**Confidence**: 80%
- Problem: `findEntity` does a linear `.find()` over the entity array each render cycle (every 1s). With the 50-item limit, this is O(50) worst case.
- Impact: Negligible. O(50) linear scan is effectively instant. Only worth noting because it runs on every poll-triggered re-render. If the limit were ever raised significantly, a `Map` lookup would be preferred.
- Fix: No action needed at current scale. If item limits increase beyond 200+, consider building a lookup Map from the data arrays.

## Pre-existing Issues (Not Blocking)

_No pre-existing performance issues identified in touched files._

## Suggestions (Lower Confidence)

- **`toLocaleTimeString` called on every render** - `src/cli/dashboard/components/header.tsx:52` (Confidence: 65%) -- `toLocaleTimeString` with options object allocates an `Intl.DateTimeFormat` internally on each call. At 1 call/second this is negligible, but a cached formatter could avoid repeated allocation.

- **`applyFilter` in MainView creates new arrays each render** - `src/cli/dashboard/views/main-view.tsx:140-143` (Confidence: 70%) -- Four `.filter()` calls run on every render even when filters are null (in which case the identity spread `data?.loops ?? []` already returns the original array). The `React.memo` on `MainView` mitigates this since it only re-renders when `data` or `nav` change.

- **`panelStatusSummary` in MainView called 4 times per render** - `src/cli/dashboard/views/main-view.tsx:151-225` (Confidence: 60%) -- Pure function with small inputs; the cost is trivial. Could be memoized via `useMemo` if profiling shows it matters, but likely not worth the complexity.

## Summary

| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 2 | 2 | 0 |
| Should Fix | - | 0 | 2 | 0 |
| Pre-existing | - | - | 0 | 0 |

**Performance Score**: 7/10
**Recommendation**: CHANGES_REQUESTED

The architecture is well-structured with good separation of concerns, `React.memo` on all components, and efficient `countByStatus` SQL queries. The two HIGH issues are: (1) the 1-second polling interval with no in-flight guard can cause query pile-up under write-heavy conditions, and (2) the per-character `stringWidth` call in `truncateCell` is quadratic. Both have straightforward fixes. The StatusBadge per-instance animation interval is a moderate concern that scales with the number of active entities.
