/**
 * ProgressBar — visual step-based progress bar for pipeline stage tracking
 * ARCHITECTURE: Pure presentational component, no side effects
 * Pattern: Each step maps to a fixed-width block of characters
 *
 * Renders:
 *   [██████▓░░░░░░] 2/5 steps · Step 3 running
 *
 * Characters:
 *   █  completed (green)
 *   ▓  running (cyan)
 *   ▒  failed (red)
 *   ░  pending (dim gray)
 */

import { Box, Text } from 'ink';
import React from 'react';

type StepStatus = 'completed' | 'running' | 'failed' | 'pending';

interface ProgressBarStep {
  readonly status: StepStatus;
}

interface ProgressBarProps {
  readonly steps: readonly ProgressBarStep[];
  readonly width: number;
}

const STEP_CHARS: Record<StepStatus, string> = {
  completed: '█',
  running: '▓',
  failed: '▒',
  pending: '░',
};

const STEP_COLORS: Record<StepStatus, string | undefined> = {
  completed: 'green',
  running: 'cyan',
  failed: 'red',
  pending: undefined,
};

/**
 * ProgressBar — renders a Unicode block-character progress bar.
 * Each step occupies floor(width / steps.length) characters.
 * Any remainder columns are filled with the last step's character.
 */
export const ProgressBar: React.FC<ProgressBarProps> = React.memo(({ steps, width }) => {
  if (steps.length === 0) return null;

  const completedCount = steps.filter((s) => s.status === 'completed').length;
  const runningStep = steps.findIndex((s) => s.status === 'running');
  const failedCount = steps.filter((s) => s.status === 'failed').length;

  // Build array of colored text segments, one per step
  const charPerStep = Math.max(1, Math.floor(width / steps.length));

  const summary =
    failedCount > 0
      ? `${completedCount}/${steps.length} steps · ${failedCount} failed`
      : runningStep >= 0
        ? `${completedCount}/${steps.length} steps · Step ${runningStep + 1} running`
        : `${completedCount}/${steps.length} steps`;

  return (
    <Box flexDirection="row" gap={1}>
      <Text>{'['}</Text>
      {steps.map((step, idx) => (
        <Text key={idx} color={STEP_COLORS[step.status]} dimColor={step.status === 'pending'}>
          {STEP_CHARS[step.status].repeat(charPerStep)}
        </Text>
      ))}
      <Text>{']'}</Text>
      <Text dimColor>{summary}</Text>
    </Box>
  );
});

ProgressBar.displayName = 'ProgressBar';
