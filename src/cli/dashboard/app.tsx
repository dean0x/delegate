/**
 * Dashboard App root component
 * ARCHITECTURE: Minimal shell — renders placeholder text, handles q-to-quit
 * Phase 3+ will add panel components and navigation
 */

import { Text, useApp, useInput } from 'ink';
import React from 'react';
import type { ReadOnlyContext } from '../read-only-context.js';

interface AppProps {
  readonly ctx: ReadOnlyContext;
}

/**
 * Root dashboard component.
 * Renders to stderr via the render() call in index.tsx.
 */
export const App: React.FC<AppProps> = React.memo(({ ctx: _ctx }) => {
  const { exit } = useApp();

  useInput((input) => {
    if (input === 'q') {
      exit();
    }
  });

  return <Text>Autobeat Dashboard</Text>;
});

App.displayName = 'App';
