/**
 * LoopDetail — full-screen loop detail view
 * ARCHITECTURE: Pure view component — all data passed as props
 * Pattern: Functional core, no side effects
 *
 * Phase C additions:
 *  - Full eval config fields: evalType, judgeAgent, judgePrompt (LongField)
 *  - Best score highlight: iteration matching bestIterationId shown in bold green
 *  - Git diff summary: per-iteration dimColor line when gitDiffSummary present
 *
 * #168 additions:
 *  - Iteration table selection wiring via selectedIterationNumber prop
 *  - Expanded eval section below the table for the selected iteration
 *  - Convergence trend for optimize loops (renderConvergenceLine, exported for tests)
 */

import { Box, Text } from 'ink';
import React from 'react';
import type { IterationStatus, Loop, LoopIteration } from '../../../core/domain.js';
import { Field, LongField, StatusField } from '../components/field.js';
import { ScrollableList } from '../components/scrollable-list.js';
import { StatusBadge } from '../components/status-badge.js';
import { formatDuration, formatRunProgress, relativeTime, statusIcon, truncateCell } from '../format.js';
import { resolveIterationIndex } from '../keyboard/helpers.js';

interface LoopDetailProps {
  readonly loop: Loop;
  readonly iterations: readonly LoopIteration[] | undefined;
  readonly scrollOffset: number;
  readonly animFrame: number;
  /** iterationNumber of the highlighted row (null = first row) — #168 */
  readonly selectedIterationNumber?: number | null;
}

/** Map an iteration status to its display color. Best iterations override to green. */
function iterationStatusColor(status: IterationStatus, isBest: boolean): string | undefined {
  if (isBest) return 'green';
  if (status === 'pass' || status === 'keep') return 'green';
  if (status === 'fail' || status === 'crash') return 'red';
  if (status === 'progress') return 'cyan'; // work committed, exit condition not yet met
  return undefined;
}

/**
 * Create a renderIterationRow function that closes over bestIterationId for highlighting.
 * The best iteration is highlighted in bold green to surface the top-scoring run quickly.
 */
function makeRenderIterationRow(
  bestIterationId: number | undefined,
): (iter: LoopIteration, index: number, isSelected: boolean) => React.ReactNode {
  return function renderIterationRow(iter: LoopIteration, _index: number, isSelected: boolean): React.ReactNode {
    const isBest = bestIterationId !== undefined && iter.iterationNumber === bestIterationId;
    const score = iter.score !== undefined ? iter.score.toFixed(2) : '—';
    const taskId = iter.taskId ? truncateCell(iter.taskId, 12) : '—';
    const sha = iter.gitCommitSha ? iter.gitCommitSha.slice(0, 8) : '—';
    // Increased truncation from 18→30 chars; also show [eval] badge when evalResponse present
    const feedbackRaw = iter.evalFeedback ?? '';
    const hasEvalResponse = Boolean(iter.evalResponse);
    const feedbackDisplay =
      (iter.status === 'fail' || iter.status === 'crash')
        ? truncateCell(iter.errorMessage ?? '—', 30)
        : truncateCell(feedbackRaw || '—', 30);
    const evalBadge = hasEvalResponse ? ' [eval]' : '';

    const duration = formatDuration(iter.startedAt, iter.completedAt);

    const bg = isSelected ? 'blue' : undefined;
    const statusText = `${statusIcon(iter.status)} ${iter.status}`;
    return (
      <Box flexDirection="column">
        <Box flexDirection="row" backgroundColor={bg}>
          <Text bold={isSelected || isBest} color={isSelected ? 'white' : isBest ? 'green' : undefined}>
            {String(iter.iterationNumber).padStart(3, ' ')}
          </Text>
          <Text> </Text>
          <Text bold={isBest} color={iterationStatusColor(iter.status, isBest)}>
            {statusText.padEnd(11, ' ')}
          </Text>
          <Text> </Text>
          <Text bold={isBest} color={isBest ? 'green' : undefined}>
            {score.padEnd(6, ' ')}
          </Text>
          <Text> </Text>
          <Text dimColor>{taskId.padEnd(14, ' ')}</Text>
          <Text> </Text>
          <Text dimColor>{sha.padEnd(9, ' ')}</Text>
          <Text> </Text>
          <Text dimColor>{duration.padEnd(8, ' ')}</Text>
          <Text> </Text>
          <Text dimColor>{feedbackDisplay}</Text>
          {hasEvalResponse && <Text dimColor color="cyan">{evalBadge}</Text>}
        </Box>
        {/* Git diff summary — shown as dimColor line below the row when present */}
        {iter.gitDiffSummary !== undefined && (
          <Box paddingLeft={4}>
            <Text dimColor>{truncateCell(iter.gitDiffSummary, 70)}</Text>
          </Box>
        )}
      </Box>
    );
  };
}

/**
 * Render the convergence trend for optimize loops.
 * Returns a string like: "Score Trend  3.2→ 4.1↑ 3.8↓ 5.2↑"
 *
 * DECISION (#168): Exported for unit testability. Pure function — no side effects.
 *
 * Algorithm:
 *  1. Reverse DESC-ordered iterations to chronological order
 *  2. Filter to scored iterations only (skip null scores and `progress` status)
 *  3. Take last 20 scored iterations
 *  4. Track running best; emit ↑ (improved), → (same), ↓ (regressed)
 *     respecting evalDirection ('maximize' default = higher is better)
 */
export function renderConvergenceLine(
  iterations: readonly LoopIteration[],
  evalDirection: 'maximize' | 'minimize' | undefined,
): string {
  const direction = evalDirection ?? 'maximize';

  // iterations arrive DESC (latest first) — reverse to chronological
  const chronological = [...iterations].reverse();

  // Filter to scored, non-progress iterations, take last 20
  const scored = chronological
    .filter((i) => i.score !== undefined && i.status !== 'progress')
    .slice(-20) as readonly (LoopIteration & { score: number })[];

  if (scored.length === 0) return '';

  let runningBest: number = scored[0].score;
  const parts: string[] = [];

  for (const iter of scored) {
    const s = iter.score.toFixed(1);
    let arrow: string;
    if (direction === 'maximize') {
      if (iter.score > runningBest) {
        arrow = '↑';
        runningBest = iter.score;
      } else if (iter.score < runningBest) {
        arrow = '↓';
      } else {
        arrow = '→';
      }
    } else {
      // minimize: lower is better
      if (iter.score < runningBest) {
        arrow = '↑';
        runningBest = iter.score;
      } else if (iter.score > runningBest) {
        arrow = '↓';
      } else {
        arrow = '→';
      }
    }
    parts.push(`${s}${arrow}`);
  }

  return parts.join(' ');
}

// ============================================================================
// Expanded eval section for selected iteration
// ============================================================================

/**
 * Try to parse evalResponse as JSON and extract structured fields.
 * Returns null if not JSON or missing expected fields.
 */
function parseEvalResponseJson(
  raw: string,
): { decision?: string; score?: number; reasoning?: string } | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return null;
    const obj = parsed as Record<string, unknown>;
    return {
      decision: typeof obj.decision === 'string' ? obj.decision : undefined,
      score:
        typeof obj.score === 'number'
          ? obj.score
          : typeof obj.score === 'string' && !Number.isNaN(Number(obj.score))
            ? Number(obj.score)
            : undefined,
      reasoning: typeof obj.reasoning === 'string' ? obj.reasoning : undefined,
    };
  } catch {
    return null;
  }
}

interface SelectedIterationEvalProps {
  readonly iter: LoopIteration;
}

/**
 * Expanded eval section — shown below the iteration table for the selected iteration.
 * Renders full evalFeedback, structured evalResponse (if JSON), or raw evalResponse.
 */
function SelectedIterationEval({ iter }: SelectedIterationEvalProps): React.ReactElement | null {
  const hasContent =
    iter.evalFeedback ||
    iter.evalResponse ||
    iter.exitCode !== undefined ||
    iter.errorMessage ||
    iter.gitDiffSummary;

  if (!hasContent) return null;

  const parsed = iter.evalResponse ? parseEvalResponseJson(iter.evalResponse) : null;

  return (
    <Box flexDirection="column" marginTop={1}>
      <Text bold dimColor>
        {`Iteration #${iter.iterationNumber} Detail`}
      </Text>

      {/* Full evalFeedback */}
      {iter.evalFeedback ? <LongField label="Eval Feedback" value={iter.evalFeedback} /> : null}

      {/* Structured evalResponse — JSON path */}
      {iter.evalResponse && parsed !== null ? (
        <Box flexDirection="column">
          <Text bold dimColor>
            Eval Response
          </Text>
          {parsed.decision !== undefined ? <Field label="Decision">{parsed.decision}</Field> : null}
          {parsed.score !== undefined ? <Field label="Score">{String(parsed.score)}</Field> : null}
          {parsed.reasoning !== undefined ? <LongField label="Reasoning" value={parsed.reasoning} /> : null}
        </Box>
      ) : iter.evalResponse ? (
        // Raw evalResponse — non-JSON path, cap at 512 chars
        <LongField label="Eval Response (raw)" value={iter.evalResponse.slice(0, 512)} />
      ) : null}

      {/* Exit info */}
      {iter.exitCode !== undefined ? <Field label="Exit Code">{String(iter.exitCode)}</Field> : null}
      {iter.errorMessage ? <LongField label="Error Message" value={iter.errorMessage} /> : null}
      {iter.gitDiffSummary ? <LongField label="Git Diff Summary" value={iter.gitDiffSummary} /> : null}

      {/* Drill hint */}
      {iter.taskId ? (
        <Box marginTop={0}>
          <Text dimColor>Enter to drill into task detail</Text>
        </Box>
      ) : null}
    </Box>
  );
}

const ITERATION_VIEWPORT_HEIGHT = 12;

export const LoopDetail: React.FC<LoopDetailProps> = React.memo(
  ({ loop, iterations, scrollOffset, animFrame, selectedIterationNumber = null }) => {
    const iterProgress = formatRunProgress(loop.currentIteration, loop.maxIterations);
    const bestScore = loop.bestScore !== undefined ? loop.bestScore.toFixed(2) : '—';
    const bestIterationIdDisplay = loop.bestIterationId !== undefined ? String(loop.bestIterationId) : '—';

    // Create renderer that closes over bestIterationId for best-score highlighting
    const renderIterationRow = React.useMemo(
      () => makeRenderIterationRow(loop.bestIterationId),
      [loop.bestIterationId],
    );

    // Resolve selected index for the ScrollableList
    const selectedIndex = React.useMemo(
      () => resolveIterationIndex(selectedIterationNumber, iterations ?? []),
      [selectedIterationNumber, iterations],
    );

    // The selected iteration object (for expanded eval section)
    const selectedIteration = iterations !== undefined && iterations.length > 0 ? iterations[selectedIndex] : undefined;

    // Convergence trend — only for optimize loops with 2+ scored iterations
    const showTrend =
      loop.strategy === 'optimize' &&
      iterations !== undefined &&
      iterations.filter((i) => i.score !== undefined && i.status !== 'progress').length >= 2;

    const convergenceLine = showTrend && iterations !== undefined ? renderConvergenceLine(iterations, loop.evalDirection) : '';

    return (
      <Box flexDirection="column" paddingLeft={1} paddingRight={1}>
        {/* Header section */}
        <Box marginBottom={1}>
          <Text bold>Loop Detail</Text>
        </Box>

        <Field label="ID">{truncateCell(loop.id, 60)}</Field>
        <StatusField>
          <StatusBadge status={loop.status} animFrame={animFrame} />
        </StatusField>
        <Field label="Strategy">{loop.strategy}</Field>
        <Field label="Eval Mode">{loop.evalMode}</Field>
        {/* Full eval config — Phase C */}
        {loop.evalType !== undefined ? <Field label="Eval Type">{loop.evalType}</Field> : null}
        {loop.judgeAgent !== undefined ? <Field label="Judge Agent">{loop.judgeAgent}</Field> : null}
        {loop.judgePrompt !== undefined ? <LongField label="Judge Prompt" value={loop.judgePrompt} /> : null}
        {loop.evalPrompt !== undefined ? <LongField label="Eval Prompt" value={loop.evalPrompt} /> : null}
        <Field label="Iteration Progress">{iterProgress}</Field>
        <Field label="Best Score">{bestScore}</Field>
        <Field label="Best Iteration ID">{bestIterationIdDisplay}</Field>
        {loop.bestIterationCommitSha ? (
          <Field label="Best Commit SHA">{loop.bestIterationCommitSha.slice(0, 16)}</Field>
        ) : null}
        <Field label="Consecutive Failures">{String(loop.consecutiveFailures)}</Field>
        <Field label="Cooldown">{`${loop.cooldownMs}ms`}</Field>
        {loop.gitBranch ? <Field label="Git Branch">{loop.gitBranch}</Field> : null}
        {loop.gitStartCommitSha ? <Field label="Git Start Commit">{loop.gitStartCommitSha.slice(0, 16)}</Field> : null}
        <Field label="Working Directory">{truncateCell(loop.workingDirectory, 50)}</Field>
        <Field label="Exit Condition">{truncateCell(loop.exitCondition, 50)}</Field>
        <Field label="Created">{relativeTime(loop.createdAt)}</Field>
        <Field label="Updated">{relativeTime(loop.updatedAt)}</Field>
        {loop.completedAt ? <Field label="Completed">{relativeTime(loop.completedAt)}</Field> : null}

        {/* Convergence trend — between config fields and iteration table (#168) */}
        {showTrend && convergenceLine !== '' ? (
          <Box marginTop={0}>
            <Text dimColor bold>Score Trend  </Text>
            <Text dimColor>{convergenceLine}</Text>
          </Box>
        ) : null}

        {/* Iteration history */}
        <Box marginTop={1} marginBottom={0}>
          <Text bold>Iteration History</Text>
          <Text dimColor>{` (${iterations?.length ?? 0} total)`}</Text>
        </Box>

        {/* Table header */}
        <Box flexDirection="row">
          <Text dimColor bold>
            {'  # STATUS    SCORE  TASK ID       SHA       DUR      FEEDBACK/ERROR'}
          </Text>
        </Box>

        {iterations === undefined || iterations.length === 0 ? (
          <Text dimColor>No iterations yet</Text>
        ) : (
          <ScrollableList
            items={iterations}
            selectedIndex={selectedIndex}
            scrollOffset={scrollOffset}
            viewportHeight={ITERATION_VIEWPORT_HEIGHT}
            renderItem={renderIterationRow}
            keyExtractor={(item) => String(item.id)}
          />
        )}

        {/* Expanded eval section for selected iteration (#168) */}
        {selectedIteration !== undefined ? <SelectedIterationEval iter={selectedIteration} /> : null}
      </Box>
    );
  },
);

LoopDetail.displayName = 'LoopDetail';
