/**
 * LoopDetail — full-screen loop detail view
 * ARCHITECTURE: Pure view component — all data passed as props
 * Pattern: Functional core, no side effects
 *
 * Phase C additions:
 *  - Full eval config fields: evalType, judgeAgent, judgePrompt (LongField)
 *  - Best score highlight: iteration matching bestIterationId shown in bold green
 *  - Git diff summary: per-iteration dimColor line when gitDiffSummary present
 */

import { Box, Text } from 'ink';
import React from 'react';
import type { Loop, LoopIteration } from '../../../core/domain.js';
import { Field, LongField, StatusField } from '../components/field.js';
import { ScrollableList } from '../components/scrollable-list.js';
import { StatusBadge } from '../components/status-badge.js';
import { formatDuration, formatRunProgress, relativeTime, statusIcon, truncateCell } from '../format.js';

interface LoopDetailProps {
  readonly loop: Loop;
  readonly iterations: readonly LoopIteration[] | undefined;
  readonly scrollOffset: number;
  readonly animFrame: number;
}

/** Map an iteration status to its display color. Best iterations override to green. */
function iterationStatusColor(status: string, isBest: boolean): string | undefined {
  if (isBest) return 'green';
  if (status === 'pass' || status === 'keep') return 'green';
  if (status === 'fail' || status === 'crash') return 'red';
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
    const feedback = iter.evalFeedback ? truncateCell(iter.evalFeedback, 18) : '—';
    const errorMsg = iter.errorMessage ? truncateCell(iter.errorMessage, 18) : '—';

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
          <Text dimColor>{iter.status === 'fail' || iter.status === 'crash' ? errorMsg : feedback}</Text>
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

const ITERATION_VIEWPORT_HEIGHT = 12;

export const LoopDetail: React.FC<LoopDetailProps> = React.memo(({ loop, iterations, scrollOffset, animFrame }) => {
  const iterProgress = formatRunProgress(loop.currentIteration, loop.maxIterations);
  const bestScore = loop.bestScore !== undefined ? loop.bestScore.toFixed(2) : '—';
  const bestIterationIdDisplay = loop.bestIterationId !== undefined ? String(loop.bestIterationId) : '—';

  // Create renderer that closes over bestIterationId for best-score highlighting
  const renderIterationRow = React.useMemo(() => makeRenderIterationRow(loop.bestIterationId), [loop.bestIterationId]);

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

      {/* TODO: Iteration row selection — selectedIndex is fixed at -1 (no keyboard selection).
           To enable Enter-to-drill-through on iteration rows, this would require:
           1. Adding iterationSelectedIndex to NavState in types.ts
           2. Updating handleDetailKeys (keyboard/handle-detail-keys.ts) to handle ↑/↓/Enter for loops,
              mirroring the orchestration drill-through pattern (D3 detail Enter → task detail)
           3. Wiring Enter on a selected iteration row to push a task-detail view using iter.taskId
           This is deferred as a future enhancement — requires changes across 3+ files. */}
      {iterations === undefined || iterations.length === 0 ? (
        <Text dimColor>No iterations yet</Text>
      ) : (
        <ScrollableList
          items={iterations}
          selectedIndex={-1}
          scrollOffset={scrollOffset}
          viewportHeight={ITERATION_VIEWPORT_HEIGHT}
          renderItem={renderIterationRow}
          keyExtractor={(item) => String(item.id)}
        />
      )}
    </Box>
  );
});

LoopDetail.displayName = 'LoopDetail';
