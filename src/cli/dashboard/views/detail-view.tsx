/**
 * DetailView — dispatcher that routes to the correct entity detail view
 * ARCHITECTURE: Thin dispatch layer — no business logic, pure routing
 * Pattern: Discriminated union on entityType → correct leaf view
 */

import { Box, Text } from 'ink';
import React from 'react';
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
  readonly animFrame: number;
  /** D3 drill-through: taskId of the highlighted child row in orchestration detail */
  readonly orchestrationChildSelectedTaskId?: string | null;
  /** D3 drill-through: 0-based page number within orchestration detail children */
  readonly orchestrationChildPage?: number;
  /** D3 drill-through: total count of children for pagination footer */
  readonly orchestrationChildrenTotal?: number;
}

const NotFound: React.FC<{ entityType: PanelId; entityId: string }> = ({ entityType, entityId }) => (
  <Box paddingLeft={1} paddingTop={1}>
    <Text dimColor>{`Entity not found — returning to dashboard (${entityType} ${entityId})`}</Text>
  </Box>
);

export const DetailView: React.FC<DetailViewProps> = React.memo(
  ({
    entityType,
    entityId,
    data,
    scrollOffset,
    animFrame,
    orchestrationChildSelectedTaskId,
    orchestrationChildPage = 0,
    orchestrationChildrenTotal,
  }) => {
    switch (entityType) {
      case 'loops': {
        const loop = data?.loops.find((l) => l.id === entityId);
        if (loop === undefined) return <NotFound entityType={entityType} entityId={entityId} />;
        return (
          <LoopDetail loop={loop} iterations={data?.iterations} scrollOffset={scrollOffset} animFrame={animFrame} />
        );
      }
      case 'tasks': {
        const task = data?.tasks.find((t) => t.id === entityId);
        if (task === undefined) return <NotFound entityType={entityType} entityId={entityId} />;
        return <TaskDetail task={task} animFrame={animFrame} />;
      }
      case 'schedules': {
        const schedule = data?.schedules.find((s) => s.id === entityId);
        if (schedule === undefined) return <NotFound entityType={entityType} entityId={entityId} />;
        return (
          <ScheduleDetail
            schedule={schedule}
            executions={data?.executions}
            scrollOffset={scrollOffset}
            animFrame={animFrame}
          />
        );
      }
      case 'orchestrations': {
        const orchestration = data?.orchestrations.find((o) => o.id === entityId);
        if (orchestration === undefined) return <NotFound entityType={entityType} entityId={entityId} />;
        return (
          <OrchestrationDetail
            orchestration={orchestration}
            animFrame={animFrame}
            children={data?.orchestrationChildren ?? []}
            costAggregate={data?.orchestrationCostAggregate}
            childSelectedTaskId={orchestrationChildSelectedTaskId ?? null}
            currentPage={orchestrationChildPage}
            childrenTotal={orchestrationChildrenTotal}
          />
        );
      }
      case 'pipelines':
        // Pipeline detail view is Phase C — not yet implemented
        return <NotFound entityType={entityType} entityId={entityId} />;
    }
  },
);

DetailView.displayName = 'DetailView';
