/**
 * Dashboard App root component
 * ARCHITECTURE: Shell — composes data hook, keyboard hook, and view components
 * Pattern: State lives here; pure view components receive data as props
 */

import { Box, useApp } from 'ink';
import React, { useEffect, useState } from 'react';
import type { ReadOnlyContext } from '../read-only-context.js';
import { Footer } from './components/footer.js';
import { Header } from './components/header.js';
import type { DashboardMutationContext, NavState, ViewState } from './types.js';
import { useDashboardData } from './use-dashboard-data.js';
import { useKeyboard } from './use-keyboard.js';
import { DetailView } from './views/detail-view.js';
import { MainView } from './views/main-view.js';

interface AppProps {
  readonly ctx: ReadOnlyContext;
  readonly version: string;
  /**
   * Optional mutation context. When provided, 'c' and 'd' keybindings are
   * enabled for cancel/delete operations. Omitted in read-only contexts.
   */
  readonly mutations?: DashboardMutationContext;
}

/** Initial navigation state — focus on loops panel, no selection, no filters */
const INITIAL_NAV: NavState = {
  focusedPanel: 'loops',
  selectedIndices: { loops: 0, tasks: 0, schedules: 0, orchestrations: 0 },
  filters: { loops: null, tasks: null, schedules: null, orchestrations: null },
  scrollOffsets: { loops: 0, tasks: 0, schedules: 0, orchestrations: 0 },
};

/**
 * Root dashboard component.
 * Renders to stderr via the render() call in index.tsx.
 */
export const App: React.FC<AppProps> = React.memo(({ ctx, version, mutations }) => {
  const { exit } = useApp();

  const [view, setView] = useState<ViewState>({ kind: 'main' });
  const [nav, setNav] = useState<NavState>(INITIAL_NAV);

  // Shared animation frame counter — single interval drives all StatusBadge animations
  const [animFrame, setAnimFrame] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => {
      setAnimFrame((prev) => prev + 1);
    }, 250);
    return () => clearInterval(timer);
  }, []);

  const { data, error, refreshedAt, refreshNow } = useDashboardData(ctx, view);

  useKeyboard({
    view,
    nav,
    data,
    setView,
    setNav,
    refreshNow,
    exit,
    mutations,
  });

  return (
    <Box flexDirection="column" width="100%">
      <Header version={version} data={data} refreshedAt={refreshedAt} error={error} />
      {view.kind === 'main' ? (
        <MainView data={data} nav={nav} />
      ) : (
        <DetailView
          entityType={view.entityType}
          entityId={view.entityId}
          data={data}
          scrollOffset={nav.scrollOffsets[view.entityType]}
          animFrame={animFrame}
        />
      )}
      <Footer viewKind={view.kind} hasMutations={mutations !== undefined} />
    </Box>
  );
});

App.displayName = 'App';
