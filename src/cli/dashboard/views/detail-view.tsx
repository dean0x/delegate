/**
 * DetailView — dispatcher that routes to the correct entity detail view
 * ARCHITECTURE: Thin dispatch layer — no business logic, pure routing
 * Pattern: Discriminated union on entityType → correct leaf view
 */

import { Box, Text } from 'ink';
import React from 'react';
import type { Loop, Orchestration, Schedule, Task } from '../../../core/domain.js';
import type { DashboardData, PanelId } from '../types.js';
import { LoopDetail } from './loop-detail.js';
import { OrchestrationDetail } from './orchestration-detail.js';
import { ScheduleDetail } from './schedule-detail.js';
import { TaskDetail } from './task-detail.js';

interface DetailViewProps {
  readonly entityType: PanelId;
  readonly entityId: string;
  readonly data: DashboardData | null;
  readonly scrollOffset: number;
}

/**
 * Look up entity from the appropriate collection in data.
 * Returns undefined if data is null or entity is not found.
 */
function findEntity(
  data: DashboardData | null,
  entityType: PanelId,
  entityId: string,
): Loop | Task | Schedule | Orchestration | undefined {
  if (data === null) {
    return undefined;
  }
  switch (entityType) {
    case 'loops':
      return data.loops.find((l) => l.id === entityId);
    case 'tasks':
      return data.tasks.find((t) => t.id === entityId);
    case 'schedules':
      return data.schedules.find((s) => s.id === entityId);
    case 'orchestrations':
      return data.orchestrations.find((o) => o.id === entityId);
  }
}

export const DetailView: React.FC<DetailViewProps> = React.memo(({ entityType, entityId, data, scrollOffset }) => {
  const entity = findEntity(data, entityType, entityId);

  if (entity === undefined) {
    return (
      <Box paddingLeft={1} paddingTop={1}>
        <Text dimColor>{`Entity not found — returning to dashboard (${entityType} ${entityId})`}</Text>
      </Box>
    );
  }

  switch (entityType) {
    case 'loops':
      return <LoopDetail loop={entity as Loop} iterations={data?.iterations} scrollOffset={scrollOffset} />;
    case 'tasks':
      return <TaskDetail task={entity as Task} />;
    case 'schedules':
      return <ScheduleDetail schedule={entity as Schedule} executions={data?.executions} scrollOffset={scrollOffset} />;
    case 'orchestrations':
      return <OrchestrationDetail orchestration={entity as Orchestration} />;
  }
});

DetailView.displayName = 'DetailView';
