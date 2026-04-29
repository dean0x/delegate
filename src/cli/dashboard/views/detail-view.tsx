/**
 * DetailView — dispatcher that routes to the correct entity detail view
 * ARCHITECTURE: Thin dispatch layer — no business logic, pure routing
 * Pattern: Discriminated union on entityType → correct leaf view
 */

import { Box, Text } from 'ink';
import React from 'react';
import type { Task, TaskId } from '../../../core/domain.js';
import type { DashboardData, PanelId } from '../types.js';
import { LoopDetail } from './loop-detail.js';
import { OrchestrationDetail } from './orchestration-detail.js';
import { PipelineDetail } from './pipeline-detail.js';
import { ScheduleDetail } from './schedule-detail.js';
import { TaskDetail } from './task-detail.js';

interface TaskDependencyInfo {
  readonly dependencies: Array<{ taskId: string; status: string }> | undefined;
  readonly dependents: Array<{ taskId: string; status: string }> | undefined;
}

/**
 * Resolve dependency and dependent refs for a task detail view.
 * Dependencies: tasks this task depends on (depId → status lookup).
 * Dependents: sibling tasks whose dependsOn list includes this task's ID.
 */
function resolveTaskDependencyInfo(
  task: Task,
  taskId: string,
  allTasks: readonly Task[] | undefined,
): TaskDependencyInfo {
  const dependencies =
    task.dependsOn !== undefined && task.dependsOn.length > 0
      ? task.dependsOn.map((depId) => {
          const depTask = allTasks?.find((t) => t.id === depId);
          return { taskId: depId, status: depTask?.status ?? 'unknown' };
        })
      : undefined;

  const rawDependents = allTasks
    ?.filter((t) => t.dependsOn?.includes(taskId as TaskId))
    .map((t) => ({ taskId: t.id, status: t.status }));
  const dependents = rawDependents && rawDependents.length > 0 ? rawDependents : undefined;

  return { dependencies, dependents };
}

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
        const { dependencies, dependents } = resolveTaskDependencyInfo(task, entityId, data?.tasks);
        // TODO(Phase C): usage data requires a dedicated TaskUsage lookup by taskId —
        // DashboardData does not carry per-task usage; fetch from UsageRepository when
        // detail-view extras are extended (similar to orchestrationCostAggregate pattern).
        return <TaskDetail task={task} animFrame={animFrame} dependencies={dependencies} dependents={dependents} />;
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
      case 'pipelines': {
        const pipeline = data?.pipelines.find((p) => p.id === entityId);
        if (pipeline === undefined) return <NotFound entityType={entityType} entityId={entityId} />;
        // Resolve step tasks from the pipeline's stepTaskIds
        const stepTasks = pipeline.stepTaskIds.map((taskId) =>
          taskId !== null ? (data?.tasks.find((t) => t.id === taskId) ?? null) : null,
        );
        return (
          <PipelineDetail pipeline={pipeline} stepTasks={stepTasks} scrollOffset={scrollOffset} animFrame={animFrame} />
        );
      }
    }
  },
);

DetailView.displayName = 'DetailView';
