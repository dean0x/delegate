/**
 * Dashboard App root component
 * ARCHITECTURE: Shell — composes data hook, keyboard hook, and view components
 * Pattern: State lives here; pure view components receive data as props
 */

import { Box, useApp } from 'ink';
import React, { useState } from 'react';
import type { ReadOnlyContext } from '../read-only-context.js';
import { Footer } from './components/footer.js';
import { Header } from './components/header.js';
import type { NavState, PanelId, ViewState } from './types.js';
import { useDashboardData } from './use-dashboard-data.js';
import { useKeyboard } from './use-keyboard.js';
import { DetailView } from './views/detail-view.js';
import { MainView } from './views/main-view.js';

interface AppProps {
  readonly ctx: ReadOnlyContext;
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
export const App: React.FC<AppProps> = React.memo(({ ctx }) => {
  const { exit } = useApp();

  const [view, setView] = useState<ViewState>({ kind: 'main' });
  const [nav, setNav] = useState<NavState>(INITIAL_NAV);

  const { data, error, refreshedAt, refreshNow } = useDashboardData(ctx, view);

  const handleSelect = React.useCallback((panelId: PanelId, entityId: string) => {
    setView({ kind: 'detail', entityType: panelId, entityId });
  }, []);

  useKeyboard({
    view,
    nav,
    data,
    setView,
    setNav,
    refreshNow,
    exit,
  });

  return (
    <Box flexDirection="column" width="100%">
      <Header data={data} refreshedAt={refreshedAt} error={error} />
      {view.kind === 'main' ? (
        <MainView data={data} nav={nav} onSelect={handleSelect} />
      ) : (
        <DetailView
          entityType={view.entityType}
          entityId={view.entityId}
          data={data}
          scrollOffset={nav.scrollOffsets[view.entityType]}
        />
      )}
      <Footer viewKind={view.kind} />
    </Box>
  );
});

App.displayName = 'App';
