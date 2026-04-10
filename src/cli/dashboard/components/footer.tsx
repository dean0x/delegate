/**
 * Footer component — context-sensitive keyboard help bar
 * ARCHITECTURE: Pure leaf component, no side effects
 */

import { Box, Text } from 'ink';
import React from 'react';

interface FooterProps {
  readonly viewKind: 'main' | 'detail';
  /** When true, adds c: cancel · d: delete (terminal only) hints to the main view help bar */
  readonly hasMutations?: boolean;
}

const MAIN_HELP = 'Tab cycle · 1-4 jump · ↑↓ select · Enter detail · f filter · r refresh · q quit';
const MAIN_HELP_MUTATIONS =
  'Tab cycle · 1-4 jump · ↑↓ select · Enter detail · c cancel · d delete (terminal) · f filter · r refresh · q quit';
const DETAIL_HELP = 'Esc back · ↑↓ scroll · r refresh · q quit';

export const Footer: React.FC<FooterProps> = React.memo(({ viewKind, hasMutations }) => {
  const helpText = viewKind === 'detail' ? DETAIL_HELP : hasMutations ? MAIN_HELP_MUTATIONS : MAIN_HELP;

  return (
    <Box borderStyle="single" borderTop borderBottom={false} borderLeft={false} borderRight={false} paddingX={1}>
      <Text dimColor>{helpText}</Text>
    </Box>
  );
});

Footer.displayName = 'Footer';
