/**
 * Footer component — context-sensitive keyboard help bar
 * ARCHITECTURE: Pure leaf component, no side effects
 * Pattern: Delegates hint string construction to keyboard/hints.ts so Footer
 * stays a leaf node and hint updates require changes only in one place.
 */

import { Box, Text } from 'ink';
import React from 'react';
import { getHints } from '../keyboard/hints.js';

interface FooterProps {
  readonly viewKind: 'main' | 'workspace' | 'detail';
  /** When true, adds c: cancel · d: delete mutation hints to the main view help bar */
  readonly hasMutations?: boolean;
}

export const Footer: React.FC<FooterProps> = React.memo(({ viewKind, hasMutations }) => {
  const helpText = getHints(viewKind, hasMutations ?? false);

  return (
    <Box borderStyle="single" borderTop borderBottom={false} borderLeft={false} borderRight={false} paddingX={1}>
      <Text dimColor>{helpText}</Text>
    </Box>
  );
});

Footer.displayName = 'Footer';
