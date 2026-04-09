/**
 * OrchestrationDetail — full-screen orchestration detail view
 * ARCHITECTURE: Pure view component — all data passed as props
 * Pattern: Functional core, no side effects
 */

import { Box, Text } from 'ink';
import React from 'react';
import type { Orchestration } from '../../../core/domain.js';
import { Field, LongField, StatusField } from '../components/field.js';
import { StatusBadge } from '../components/status-badge.js';
import { relativeTime, truncateCell } from '../format.js';

interface OrchestrationDetailProps {
  readonly orchestration: Orchestration;
}

export const OrchestrationDetail: React.FC<OrchestrationDetailProps> = React.memo(({ orchestration }) => {
  return (
    <Box flexDirection="column" paddingLeft={1} paddingRight={1}>
      {/* Header */}
      <Box marginBottom={1}>
        <Text bold>Orchestration Detail</Text>
      </Box>

      <Field label="ID">{truncateCell(orchestration.id, 60)}</Field>
      <StatusField>
        <StatusBadge status={orchestration.status} />
      </StatusField>

      {/* Goal (full, wrapped) */}
      <LongField label="Goal" value={orchestration.goal} />

      {orchestration.agent ? <Field label="Agent">{orchestration.agent}</Field> : null}
      {orchestration.model ? <Field label="Model">{orchestration.model}</Field> : null}
      {orchestration.loopId ? <Field label="Loop ID">{truncateCell(orchestration.loopId, 50)}</Field> : null}
      <Field label="Max Depth">{String(orchestration.maxDepth)}</Field>
      <Field label="Max Workers">{String(orchestration.maxWorkers)}</Field>
      <Field label="Max Iterations">{String(orchestration.maxIterations)}</Field>
      <Field label="Working Directory">{truncateCell(orchestration.workingDirectory, 50)}</Field>
      <Field label="State File">{truncateCell(orchestration.stateFilePath, 50)}</Field>
      <Field label="Created">{relativeTime(orchestration.createdAt)}</Field>
      <Field label="Updated">{relativeTime(orchestration.updatedAt)}</Field>
      {orchestration.completedAt !== undefined ? (
        <Field label="Completed">{relativeTime(orchestration.completedAt)}</Field>
      ) : null}
    </Box>
  );
});

OrchestrationDetail.displayName = 'OrchestrationDetail';
