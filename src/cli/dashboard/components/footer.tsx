/**
 * Footer component — context-sensitive keyboard help bar
 * ARCHITECTURE: Pure leaf component, no side effects
 */

import { Box, Text } from 'ink';
import React from 'react';

interface FooterProps {
  readonly viewKind: 'main' | 'workspace' | 'detail';
  /** When true, adds c: cancel · d: delete (terminal only) hints to the main view help bar */
  readonly hasMutations?: boolean;
}

const MAIN_HELP = 'v: workspace · Tab: activity · ↑↓: select · Enter: detail · f: filter · r refresh · q quit';
const MAIN_HELP_MUTATIONS =
  'v: workspace · Tab: activity · ↑↓: select · Enter: detail · c cancel · d delete (terminal) · f: filter · r refresh · q quit';
const WORKSPACE_HELP =
  'v: metrics · ↑↓: orch · Enter commit/detail · Tab panel · f fullscreen · [/] scroll · G tail · c/d · Esc';
const DETAIL_HELP = 'Esc back · ↑↓ scroll · r refresh · q quit';

export const Footer: React.FC<FooterProps> = React.memo(({ viewKind, hasMutations }) => {
  let helpText: string;
  if (viewKind === 'detail') {
    helpText = DETAIL_HELP;
  } else if (viewKind === 'workspace') {
    helpText = WORKSPACE_HELP;
  } else {
    helpText = hasMutations ? MAIN_HELP_MUTATIONS : MAIN_HELP;
  }

  return (
    <Box borderStyle="single" borderTop borderBottom={false} borderLeft={false} borderRight={false} paddingX={1}>
      <Text dimColor>{helpText}</Text>
    </Box>
  );
});

Footer.displayName = 'Footer';
