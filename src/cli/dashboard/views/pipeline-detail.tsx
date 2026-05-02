/**
 * PipelineDetail — full-screen pipeline detail view
 * ARCHITECTURE: Pure view component — all data passed as props
 * Pattern: Functional core, no side effects
 *
 * Sections:
 *  1. Header fields — ID, Status, Source, Priority, Agent, Model, Working Directory
 *  2. Progress bar — visual step completion indicator
 *  3. Stage list — scrollable per-step detail (index, status, task, elapsed, prompt)
 */

import { Box, Text } from 'ink';
import React from 'react';
import type { Pipeline, PipelineStepDefinition, Task } from '../../../core/domain.js';
import { Field, StatusField } from '../components/field.js';
import { ProgressBar } from '../components/progress-bar.js';
import { ScrollableList } from '../components/scrollable-list.js';
import { StatusBadge } from '../components/status-badge.js';
import { formatDuration, relativeTime, statusColor, statusIcon, truncateCell } from '../format.js';

interface PipelineDetailProps {
  readonly pipeline: Pipeline;
  /** Task objects matching pipeline.stepTaskIds — null when no task yet for that step */
  readonly stepTasks: readonly (Task | null)[];
  readonly scrollOffset: number;
  readonly animFrame: number;
}

/** Map a pipeline step task status to a ProgressBar step status */
function toProgressStatus(task: Task | null): 'completed' | 'running' | 'failed' | 'pending' {
  if (task === null) return 'pending';
  switch (task.status) {
    case 'completed':
      return 'completed';
    case 'running':
      return 'running';
    case 'failed':
    case 'cancelled':
      return 'failed';
    default:
      return 'pending';
  }
}

/** Render a single stage row in the step list */
function renderStageRow(
  item: { readonly step: PipelineStepDefinition; readonly task: Task | null },
  _index: number,
  isSelected: boolean,
): React.ReactNode {
  const { step, task } = item;
  const idx = String(step.index + 1).padStart(2, ' ');
  const icon = task !== null ? statusIcon(task.status) : '◦';
  const statusText = (task !== null ? task.status : 'pending').padEnd(10, ' ');
  const taskShortId = task !== null ? task.id.slice(0, 12) : '—'.padEnd(12, ' ');
  const elapsed =
    task !== null
      ? formatDuration(task.startedAt, task.completedAt ?? (task.status === 'running' ? Date.now() : undefined))
      : '—';
  const promptPreview = truncateCell(step.prompt, 40);

  const color = task !== null ? statusColor(task.status) : undefined;
  const bg = isSelected ? 'blue' : undefined;

  return (
    <Box flexDirection="row" backgroundColor={bg}>
      <Text bold={isSelected}>{idx}</Text>
      <Text> </Text>
      <Text color={color}>{icon}</Text>
      <Text> </Text>
      <Text color={color}>{statusText}</Text>
      <Text> </Text>
      <Text dimColor>{taskShortId.padEnd(13, ' ')}</Text>
      <Text> </Text>
      <Text dimColor>{elapsed.padEnd(8, ' ')}</Text>
      <Text> </Text>
      <Text dimColor>{promptPreview}</Text>
    </Box>
  );
}

const STAGE_VIEWPORT_HEIGHT = 12;

export const PipelineDetail: React.FC<PipelineDetailProps> = React.memo(
  ({ pipeline, stepTasks, scrollOffset, animFrame }) => {
    // Build progress bar steps from stepTasks alignment
    const progressSteps = React.useMemo(
      () => stepTasks.map((task) => ({ status: toProgressStatus(task) })),
      [stepTasks],
    );

    // Zip steps and tasks for stage list rendering
    const stageItems = React.useMemo(
      () =>
        pipeline.steps.map((step, idx) => ({
          step,
          task: stepTasks[idx] ?? null,
        })),
      [pipeline.steps, stepTasks],
    );

    return (
      <Box flexDirection="column" paddingLeft={1} paddingRight={1}>
        {/* Header */}
        <Box marginBottom={1}>
          <Text bold>Pipeline Detail</Text>
        </Box>

        <Field label="ID">{truncateCell(pipeline.id, 60)}</Field>
        <StatusField>
          <StatusBadge status={pipeline.status} animFrame={animFrame} />
        </StatusField>
        {pipeline.priority !== undefined ? <Field label="Priority">{pipeline.priority}</Field> : null}
        {pipeline.agent !== undefined ? <Field label="Agent">{pipeline.agent}</Field> : null}
        {pipeline.model !== undefined ? <Field label="Model">{pipeline.model}</Field> : null}
        {pipeline.workingDirectory !== undefined ? (
          <Field label="Working Directory">{truncateCell(pipeline.workingDirectory, 50)}</Field>
        ) : null}

        {/* Source attribution — schedule or loop */}
        {pipeline.scheduleId !== undefined ? (
          <Field label="Schedule">{truncateCell(pipeline.scheduleId, 50)}</Field>
        ) : null}
        {pipeline.loopId !== undefined ? <Field label="Loop">{truncateCell(pipeline.loopId, 50)}</Field> : null}
        {pipeline.loopIteration !== undefined ? (
          <Field label="Loop Iteration">{String(pipeline.loopIteration)}</Field>
        ) : null}

        {/* Timing */}
        <Field label="Created">{relativeTime(pipeline.createdAt)}</Field>
        <Field label="Updated">{relativeTime(pipeline.updatedAt)}</Field>
        {pipeline.completedAt !== undefined ? (
          <Field label="Completed">{relativeTime(pipeline.completedAt)}</Field>
        ) : null}

        {/* Progress bar */}
        <Box marginTop={1}>
          <ProgressBar steps={progressSteps} width={40} />
        </Box>

        {/* Stage list */}
        <Box marginTop={1} marginBottom={0}>
          <Text bold>Stages</Text>
          <Text dimColor>{` (${pipeline.steps.length} total)`}</Text>
        </Box>

        {/* Table header */}
        <Box flexDirection="row">
          <Text dimColor bold>
            {'## STATUS     TASK ID       ELAPSED  PROMPT'}
          </Text>
        </Box>

        {pipeline.steps.length === 0 ? (
          <Text dimColor>No steps defined</Text>
        ) : (
          <ScrollableList
            items={stageItems}
            selectedIndex={-1}
            scrollOffset={scrollOffset}
            viewportHeight={STAGE_VIEWPORT_HEIGHT}
            renderItem={renderStageRow}
            keyExtractor={(item) => String(item.step.index)}
          />
        )}
      </Box>
    );
  },
);

PipelineDetail.displayName = 'PipelineDetail';
