/**
 * ScheduleDetail — full-screen schedule detail view
 * ARCHITECTURE: Pure view component — all data passed as props
 * Pattern: Functional core, no side effects
 */

import { Box, Text } from 'ink';
import React from 'react';
import type { Schedule } from '../../../core/domain.js';
import type { ScheduleExecution } from '../../../core/interfaces.js';
import { Field, StatusField } from '../components/field.js';
import { ScrollableList } from '../components/scrollable-list.js';
import { StatusBadge } from '../components/status-badge.js';
import { formatRunProgress, relativeTime, truncateCell } from '../format.js';

interface ScheduleDetailProps {
  readonly schedule: Schedule;
  readonly executions: readonly ScheduleExecution[] | undefined;
  readonly scrollOffset: number;
}

/** Render a single execution row */
function renderExecutionRow(exec: ScheduleExecution, index: number, isSelected: boolean): React.ReactNode {
  const taskId = exec.taskId ? truncateCell(exec.taskId, 12) : '—';
  const loopId = exec.loopId ? truncateCell(exec.loopId, 12) : '—';
  const scheduledFor = relativeTime(exec.scheduledFor);
  const executedAt = exec.executedAt !== undefined ? relativeTime(exec.executedAt) : '—';
  const errorMsg = exec.errorMessage ? truncateCell(exec.errorMessage, 18) : '—';

  const bg = isSelected ? 'blue' : undefined;
  const statusColor =
    exec.status === 'completed' || exec.status === 'triggered'
      ? 'green'
      : exec.status === 'failed' || exec.status === 'missed'
        ? 'red'
        : undefined;

  return (
    <Box key={exec.id} flexDirection="row" backgroundColor={bg}>
      <Text bold={isSelected} color={isSelected ? 'white' : undefined}>
        {String(index + 1).padStart(3, ' ')}
      </Text>
      <Text> </Text>
      <Text color={statusColor}>{exec.status.padEnd(10, ' ')}</Text>
      <Text> </Text>
      <Text dimColor>{scheduledFor.padEnd(12, ' ')}</Text>
      <Text> </Text>
      <Text dimColor>{executedAt.padEnd(12, ' ')}</Text>
      <Text> </Text>
      <Text dimColor>{taskId.padEnd(14, ' ')}</Text>
      <Text> </Text>
      <Text dimColor>{loopId.padEnd(14, ' ')}</Text>
      <Text> </Text>
      {exec.status === 'failed' || exec.status === 'missed' ? (
        <Text color="red" dimColor>
          {errorMsg}
        </Text>
      ) : null}
    </Box>
  );
}

const EXECUTION_VIEWPORT_HEIGHT = 12;

export const ScheduleDetail: React.FC<ScheduleDetailProps> = React.memo(({ schedule, executions, scrollOffset }) => {
  const runsProgress = formatRunProgress(schedule.runCount, schedule.maxRuns);

  return (
    <Box flexDirection="column" paddingLeft={1} paddingRight={1}>
      {/* Header */}
      <Box marginBottom={1}>
        <Text bold>Schedule Detail</Text>
      </Box>

      <Field label="ID">{truncateCell(schedule.id, 60)}</Field>
      <StatusField>
        <StatusBadge status={schedule.status} />
      </StatusField>
      <Field label="Schedule Type">{schedule.scheduleType}</Field>
      {schedule.cronExpression ? <Field label="Cron Expression">{schedule.cronExpression}</Field> : null}
      {schedule.scheduledAt !== undefined ? (
        <Field label="Scheduled At">{relativeTime(schedule.scheduledAt)}</Field>
      ) : null}
      <Field label="Timezone">{schedule.timezone}</Field>
      {schedule.nextRunAt !== undefined ? <Field label="Next Run">{relativeTime(schedule.nextRunAt)}</Field> : null}
      {schedule.lastRunAt !== undefined ? <Field label="Last Run">{relativeTime(schedule.lastRunAt)}</Field> : null}
      <Field label="Runs">{runsProgress}</Field>
      <Field label="Missed Run Policy">{schedule.missedRunPolicy}</Field>
      {schedule.expiresAt !== undefined ? <Field label="Expires At">{relativeTime(schedule.expiresAt)}</Field> : null}
      <Field label="Created">{relativeTime(schedule.createdAt)}</Field>
      <Field label="Updated">{relativeTime(schedule.updatedAt)}</Field>

      {/* Execution history */}
      <Box marginTop={1} marginBottom={0}>
        <Text bold>Execution History</Text>
        <Text dimColor>{` (${executions?.length ?? 0} total)`}</Text>
      </Box>

      {/* Table header */}
      <Box flexDirection="row">
        <Text dimColor bold>
          {'  # STATUS     SCHEDULED    EXECUTED     TASK ID       LOOP ID       ERROR'}
        </Text>
      </Box>

      {executions === undefined || executions.length === 0 ? (
        <Text dimColor>No executions yet</Text>
      ) : (
        <ScrollableList
          items={executions}
          selectedIndex={-1}
          scrollOffset={scrollOffset}
          viewportHeight={EXECUTION_VIEWPORT_HEIGHT}
          renderItem={renderExecutionRow}
        />
      )}
    </Box>
  );
});

ScheduleDetail.displayName = 'ScheduleDetail';
