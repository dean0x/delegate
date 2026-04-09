/**
 * LoopDetail — full-screen loop detail view
 * ARCHITECTURE: Pure view component — all data passed as props
 * Pattern: Functional core, no side effects
 */

import { Box, Text } from 'ink';
import React from 'react';
import type { Loop, LoopIteration } from '../../../core/domain.js';
import { ScrollableList } from '../components/scrollable-list.js';
import { StatusBadge } from '../components/status-badge.js';
import { formatRunProgress, relativeTime, truncateCell } from '../format.js';

interface LoopDetailProps {
  readonly loop: Loop;
  readonly iterations: readonly LoopIteration[] | undefined;
  readonly scrollOffset: number;
}

/** Render a single field row with label + value */
function Field({
  label,
  children,
}: {
  readonly label: string;
  readonly children: React.ReactNode;
}): React.ReactElement {
  return (
    <Box flexDirection="row" marginBottom={0}>
      <Text bold color="cyan">
        {label.padEnd(22, ' ')}
      </Text>
      <Text>{children}</Text>
    </Box>
  );
}

/** Render a single iteration row for the scrollable table */
function renderIterationRow(iter: LoopIteration, _index: number, isSelected: boolean): React.ReactNode {
  const score = iter.score !== undefined ? iter.score.toFixed(2) : '—';
  const taskId = iter.taskId ? truncateCell(iter.taskId, 12) : '—';
  const sha = iter.gitCommitSha ? iter.gitCommitSha.slice(0, 8) : '—';
  const feedback = iter.evalFeedback ? truncateCell(iter.evalFeedback, 18) : '—';
  const errorMsg = iter.errorMessage ? truncateCell(iter.errorMessage, 18) : '—';

  // Duration
  let duration = '—';
  if (iter.startedAt !== undefined && iter.completedAt !== undefined) {
    const ms = iter.completedAt - iter.startedAt;
    const secs = Math.floor(ms / 1_000);
    const mins = Math.floor(secs / 60);
    duration = mins > 0 ? `${mins}m ${secs % 60}s` : `${secs}s`;
  }

  const bg = isSelected ? 'blue' : undefined;
  return (
    <Box key={iter.id} flexDirection="row" backgroundColor={bg}>
      <Text bold={isSelected} color={isSelected ? 'white' : undefined}>
        {String(iter.iterationNumber).padStart(3, ' ')}
      </Text>
      <Text> </Text>
      <Text
        color={
          iter.status === 'pass' || iter.status === 'keep'
            ? 'green'
            : iter.status === 'fail' || iter.status === 'crash'
              ? 'red'
              : undefined
        }
      >
        {iter.status.padEnd(9, ' ')}
      </Text>
      <Text> </Text>
      <Text>{score.padEnd(6, ' ')}</Text>
      <Text> </Text>
      <Text dimColor>{taskId.padEnd(14, ' ')}</Text>
      <Text> </Text>
      <Text dimColor>{sha.padEnd(9, ' ')}</Text>
      <Text> </Text>
      <Text dimColor>{duration.padEnd(8, ' ')}</Text>
      <Text> </Text>
      <Text dimColor>{iter.status === 'fail' || iter.status === 'crash' ? errorMsg : feedback}</Text>
    </Box>
  );
}

const ITERATION_VIEWPORT_HEIGHT = 12;

export const LoopDetail: React.FC<LoopDetailProps> = React.memo(({ loop, iterations, scrollOffset }) => {
  const iterProgress = formatRunProgress(loop.currentIteration, loop.maxIterations);
  const bestScore = loop.bestScore !== undefined ? loop.bestScore.toFixed(2) : '—';
  const bestIterationId = loop.bestIterationId !== undefined ? String(loop.bestIterationId) : '—';

  return (
    <Box flexDirection="column" paddingLeft={1} paddingRight={1}>
      {/* Header section */}
      <Box marginBottom={1}>
        <Text bold>Loop Detail</Text>
      </Box>

      <Field label="ID">{truncateCell(loop.id, 60)}</Field>
      <Box flexDirection="row" marginBottom={0}>
        <Text bold color="cyan">
          {'Status'.padEnd(22, ' ')}
        </Text>
        <StatusBadge status={loop.status} />
      </Box>
      <Field label="Strategy">{loop.strategy}</Field>
      <Field label="Eval Mode">{loop.evalMode}</Field>
      <Field label="Iteration Progress">{iterProgress}</Field>
      <Field label="Best Score">{bestScore}</Field>
      <Field label="Best Iteration ID">{bestIterationId}</Field>
      {loop.bestIterationCommitSha ? (
        <Field label="Best Commit SHA">{loop.bestIterationCommitSha.slice(0, 16)}</Field>
      ) : null}
      <Field label="Consecutive Failures">{String(loop.consecutiveFailures)}</Field>
      <Field label="Cooldown">{`${loop.cooldownMs}ms`}</Field>
      {loop.gitBranch ? <Field label="Git Branch">{loop.gitBranch}</Field> : null}
      {loop.gitStartCommitSha ? <Field label="Git Start Commit">{loop.gitStartCommitSha.slice(0, 16)}</Field> : null}
      <Field label="Working Directory">{truncateCell(loop.workingDirectory, 50)}</Field>
      <Field label="Exit Condition">{truncateCell(loop.exitCondition, 50)}</Field>
      {loop.evalPrompt ? <Field label="Eval Prompt">{truncateCell(loop.evalPrompt, 50)}</Field> : null}
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

      {iterations === undefined || iterations.length === 0 ? (
        <Text dimColor>No iterations yet</Text>
      ) : (
        <ScrollableList
          items={iterations}
          selectedIndex={-1}
          scrollOffset={scrollOffset}
          viewportHeight={ITERATION_VIEWPORT_HEIGHT}
          renderItem={renderIterationRow}
        />
      )}
    </Box>
  );
});

LoopDetail.displayName = 'LoopDetail';
