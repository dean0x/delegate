/**
 * Footer component — context-sensitive keyboard help bar
 * ARCHITECTURE: Pure leaf component, no side effects
 */

import { Box, Text } from 'ink';
import React from 'react';

interface FooterProps {
  readonly viewKind: 'main' | 'detail';
}

const MAIN_HELP = 'Tab cycle · 1-4 jump · ↑↓ select · Enter detail · f filter · r refresh · q quit';
const DETAIL_HELP = 'Esc back · ↑↓ scroll · r refresh · q quit';

export const Footer: React.FC<FooterProps> = React.memo(({ viewKind }) => {
  const helpText = viewKind === 'detail' ? DETAIL_HELP : MAIN_HELP;

  return (
    <Box borderStyle="single" borderTop borderBottom={false} borderLeft={false} borderRight={false} paddingX={1}>
      <Text dimColor>{helpText}</Text>
    </Box>
  );
});

Footer.displayName = 'Footer';
