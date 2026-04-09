/**
 * OrchestrationDetail — full-screen orchestration detail view
 * ARCHITECTURE: Pure view component — all data passed as props
 * Pattern: Functional core, no side effects
 */

import { Box, Text } from 'ink';
import React from 'react';
import type { Orchestration } from '../../../core/domain.js';
import { StatusBadge } from '../components/status-badge.js';
import { relativeTime, truncateCell } from '../format.js';

interface OrchestrationDetailProps {
  readonly orchestration: Orchestration;
}

/** Render a field row with label + value */
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

/** Render a multi-line value under a label (for long text like goal) */
function LongField({ label, value }: { readonly label: string; readonly value: string }): React.ReactElement {
  return (
    <Box flexDirection="column" marginBottom={0}>
      <Text bold color="cyan">
        {label}
      </Text>
      <Box paddingLeft={2}>
        <Text wrap="wrap">{value}</Text>
      </Box>
    </Box>
  );
}

export const OrchestrationDetail: React.FC<OrchestrationDetailProps> = React.memo(({ orchestration }) => {
  return (
    <Box flexDirection="column" paddingLeft={1} paddingRight={1}>
      {/* Header */}
      <Box marginBottom={1}>
        <Text bold>Orchestration Detail</Text>
      </Box>

      <Field label="ID">{truncateCell(orchestration.id, 60)}</Field>
      <Box flexDirection="row" marginBottom={0}>
        <Text bold color="cyan">
          {'Status'.padEnd(22, ' ')}
        </Text>
        <StatusBadge status={orchestration.status} />
      </Box>

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
