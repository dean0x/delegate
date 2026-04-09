/**
 * MainView — 4-panel grid showing loops, tasks, schedules, orchestrations
 * ARCHITECTURE: Stateless view component, all state from props
 * Pattern: Functional core — pure rendering based on data/nav snapshot
 */

import { Box, Text } from 'ink';
import React, { useCallback } from 'react';
import type { Loop, Orchestration, Schedule, Task } from '../../../core/domain.js';
import { EmptyState } from '../components/empty-state.js';
import { Panel } from '../components/panel.js';
import { ScrollableList } from '../components/scrollable-list.js';
import { TableRow } from '../components/table-row.js';
import {
  formatElapsed,
  formatRunProgress,
  panelStatusSummary,
  relativeTime,
  scoreTrend,
  truncateCell,
} from '../format.js';
import type { DashboardData, NavState, PanelId } from '../types.js';

// Viewport height per panel (approximate — panels split the terminal height)
const PANEL_VIEWPORT_HEIGHT = 10;

interface MainViewProps {
  readonly data: DashboardData | null;
  readonly nav: NavState;
  readonly onSelect: (panelId: PanelId, entityId: string) => void;
}

// ============================================================================
// Row renderers — each returns a TableRow for the given entity
// ============================================================================

function renderLoopRow(loop: Loop, _index: number, isSelected: boolean): React.ReactNode {
  const iterProgress = formatRunProgress(loop.currentIteration, loop.maxIterations);
  const direction = loop.evalDirection ?? 'maximize';
  const scoreDisplay =
    loop.bestScore !== undefined
      ? `${loop.bestScore.toFixed(2)} ${scoreTrend(loop.bestScore, undefined, direction)}`
      : '—';
  const prompt = loop.taskTemplate.prompt;

  return (
    <Box key={loop.id} flexDirection="column">
      <TableRow
        selected={isSelected}
        cells={[
          { text: `${loop.status}`, width: 12 },
          { text: iterProgress, width: 6 },
          { text: scoreDisplay, width: 9 },
          { text: loop.strategy, width: 8 },
          { text: prompt, width: 28 },
        ]}
      />
    </Box>
  );
}

function renderTaskRow(task: Task, _index: number, isSelected: boolean): React.ReactNode {
  const agent = task.agent ?? '—';
  // For running tasks, show live elapsed; for others show relative time from startedAt
  const elapsed =
    task.startedAt !== undefined
      ? task.status === 'running'
        ? formatElapsed(task.startedAt)
        : relativeTime(task.startedAt)
      : '—';
  const prompt = task.prompt;
  const errorText = task.error instanceof Error ? task.error.message : undefined;

  return (
    <Box key={task.id} flexDirection="column">
      <TableRow
        selected={isSelected}
        cells={[
          { text: task.status, width: 12 },
          { text: agent, width: 8 },
          { text: elapsed, width: 10 },
          { text: prompt, width: 30 },
        ]}
      />
      {task.status === 'failed' && errorText ? (
        <Text dimColor>
          {'  '}
          {truncateCell(errorText, 40)}
        </Text>
      ) : null}
    </Box>
  );
}

function renderScheduleRow(schedule: Schedule, _index: number, isSelected: boolean): React.ReactNode {
  const type = schedule.scheduleType;
  const nextRun = schedule.nextRunAt !== undefined ? relativeTime(schedule.nextRunAt) : '—';
  const runsProgress = formatRunProgress(schedule.runCount, schedule.maxRuns);

  return (
    <TableRow
      key={schedule.id}
      selected={isSelected}
      cells={[
        { text: schedule.status, width: 12 },
        { text: type, width: 10 },
        { text: nextRun, width: 10 },
        { text: runsProgress, width: 8 },
      ]}
    />
  );
}

function renderOrchestrationRow(orch: Orchestration, _index: number, isSelected: boolean): React.ReactNode {
  const agent = orch.agent ?? '—';
  const goal = orch.goal;

  return (
    <TableRow
      key={orch.id}
      selected={isSelected}
      cells={[
        { text: orch.status, width: 12 },
        { text: agent, width: 8 },
        { text: goal, width: 36 },
      ]}
    />
  );
}

// ============================================================================
// Main view component
// ============================================================================

export const MainView: React.FC<MainViewProps> = React.memo(({ data, nav, onSelect }) => {
  // Apply filters per panel
  const filterLoops = useCallback(
    (items: readonly Loop[]) =>
      nav.filters.loops !== null ? items.filter((l) => l.status === nav.filters.loops) : items,
    [nav.filters.loops],
  );

  const filterTasks = useCallback(
    (items: readonly Task[]) =>
      nav.filters.tasks !== null ? items.filter((t) => t.status === nav.filters.tasks) : items,
    [nav.filters.tasks],
  );

  const filterSchedules = useCallback(
    (items: readonly Schedule[]) =>
      nav.filters.schedules !== null ? items.filter((s) => s.status === nav.filters.schedules) : items,
    [nav.filters.schedules],
  );

  const filterOrchestrations = useCallback(
    (items: readonly Orchestration[]) =>
      nav.filters.orchestrations !== null ? items.filter((o) => o.status === nav.filters.orchestrations) : items,
    [nav.filters.orchestrations],
  );

  const loops = filterLoops(data?.loops ?? []);
  const tasks = filterTasks(data?.tasks ?? []);
  const schedules = filterSchedules(data?.schedules ?? []);
  const orchestrations = filterOrchestrations(data?.orchestrations ?? []);

  // Render callbacks bound to entity id for onSelect
  const renderLoop = useCallback((loop: Loop, index: number, isSelected: boolean) => {
    // Using local renderLoopRow since onClick happens via keyboard in use-keyboard.ts
    return renderLoopRow(loop, index, isSelected);
  }, []);

  const renderTask = useCallback(
    (task: Task, index: number, isSelected: boolean) => renderTaskRow(task, index, isSelected),
    [],
  );

  const renderSchedule = useCallback(
    (schedule: Schedule, index: number, isSelected: boolean) => renderScheduleRow(schedule, index, isSelected),
    [],
  );

  const renderOrchestration = useCallback(
    (orch: Orchestration, index: number, isSelected: boolean) => renderOrchestrationRow(orch, index, isSelected),
    [],
  );

  return (
    <Box flexDirection="column" flexGrow={1}>
      {/* Top row: Loops + Tasks */}
      <Box flexDirection="row" flexGrow={1}>
        <Panel
          title="[1] Loops"
          statusSummary={panelStatusSummary(data?.loopCounts.byStatus ?? {})}
          focused={nav.focusedPanel === 'loops'}
          filterStatus={nav.filters.loops}
        >
          {loops.length === 0 ? (
            <EmptyState entityName="loops" filterStatus={nav.filters.loops} />
          ) : (
            <ScrollableList
              items={loops}
              selectedIndex={nav.selectedIndices.loops}
              scrollOffset={nav.scrollOffsets.loops}
              viewportHeight={PANEL_VIEWPORT_HEIGHT}
              renderItem={renderLoop}
            />
          )}
        </Panel>

        <Panel
          title="[2] Tasks"
          statusSummary={panelStatusSummary(data?.taskCounts.byStatus ?? {})}
          focused={nav.focusedPanel === 'tasks'}
          filterStatus={nav.filters.tasks}
        >
          {tasks.length === 0 ? (
            <EmptyState entityName="tasks" filterStatus={nav.filters.tasks} />
          ) : (
            <ScrollableList
              items={tasks}
              selectedIndex={nav.selectedIndices.tasks}
              scrollOffset={nav.scrollOffsets.tasks}
              viewportHeight={PANEL_VIEWPORT_HEIGHT}
              renderItem={renderTask}
            />
          )}
        </Panel>
      </Box>

      {/* Bottom row: Schedules + Orchestrations */}
      <Box flexDirection="row" flexGrow={1}>
        <Panel
          title="[3] Schedules"
          statusSummary={panelStatusSummary(data?.scheduleCounts.byStatus ?? {})}
          focused={nav.focusedPanel === 'schedules'}
          filterStatus={nav.filters.schedules}
        >
          {schedules.length === 0 ? (
            <EmptyState entityName="schedules" filterStatus={nav.filters.schedules} />
          ) : (
            <ScrollableList
              items={schedules}
              selectedIndex={nav.selectedIndices.schedules}
              scrollOffset={nav.scrollOffsets.schedules}
              viewportHeight={PANEL_VIEWPORT_HEIGHT}
              renderItem={renderSchedule}
            />
          )}
        </Panel>

        <Panel
          title="[4] Orchestrations"
          statusSummary={panelStatusSummary(data?.orchestrationCounts.byStatus ?? {})}
          focused={nav.focusedPanel === 'orchestrations'}
          filterStatus={nav.filters.orchestrations}
        >
          {orchestrations.length === 0 ? (
            <EmptyState entityName="orchestrations" filterStatus={nav.filters.orchestrations} />
          ) : (
            <ScrollableList
              items={orchestrations}
              selectedIndex={nav.selectedIndices.orchestrations}
              scrollOffset={nav.scrollOffsets.orchestrations}
              viewportHeight={PANEL_VIEWPORT_HEIGHT}
              renderItem={renderOrchestration}
            />
          )}
        </Panel>
      </Box>
    </Box>
  );
});

MainView.displayName = 'MainView';
