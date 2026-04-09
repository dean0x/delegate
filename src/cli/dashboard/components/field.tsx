/**
 * Field components — shared label+value layout for detail views
 * ARCHITECTURE: Pure leaf components, no side effects
 */

import { Box, Text } from 'ink';
import React from 'react';

interface FieldProps {
  readonly label: string;
  readonly children: React.ReactNode;
}

/** Inline field row: bold cyan label (padded to 22 chars) followed by value */
export function Field({ label, children }: FieldProps): React.ReactElement {
  return (
    <Box flexDirection="row" marginBottom={0}>
      <Text bold color="cyan">
        {label.padEnd(22, ' ')}
      </Text>
      <Text>{children}</Text>
    </Box>
  );
}

interface LongFieldProps {
  readonly label: string;
  readonly value: string;
}

/** Multi-line field: bold cyan label above indented wrapped value */
export function LongField({ label, value }: LongFieldProps): React.ReactElement {
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

interface StatusFieldProps {
  readonly children: React.ReactNode;
}

/** Inline field row pre-labelled "Status" — accepts a StatusBadge as children */
export function StatusField({ children }: StatusFieldProps): React.ReactElement {
  return (
    <Box flexDirection="row" marginBottom={0}>
      <Text bold color="cyan">
        {'Status'.padEnd(22, ' ')}
      </Text>
      {children}
    </Box>
  );
}
