/**
 * TaskDetail — full-screen task detail view
 * ARCHITECTURE: Pure view component — all data passed as props
 * Pattern: Functional core, no side effects
 *
 * Phase C additions:
 *  - Orchestrator attribution: shows parent orchestratorId when present
 *  - Dependencies section: blocked-by and blocks lists with status icons
 *  - Usage section: token/cost summary from task_usage table
 *
 * #165 additions:
 *  - Ref-based metadata height measurement via Ink's measureElement()
 *  - Output stream rendering below metadata when outputVisible=true
 *  - computeDetailOutputLayout() for adaptive viewport sizing
 */

import type { DOMElement } from 'ink';
import { Box, measureElement, Text } from 'ink';
import React, { useEffect, useRef, useState } from 'react';
import type { Task, TaskUsage } from '../../../core/domain.js';
import { TaskStatus } from '../../../core/domain.js';
import { Field, LongField, StatusField } from '../components/field.js';
import { OutputStreamView } from '../components/output-stream-view.js';
import { StatusBadge } from '../components/status-badge.js';
import { formatElapsed, relativeTime, statusIcon, truncateCell } from '../format.js';
import { computeDetailOutputLayout } from '../layout.js';
import type { OutputStreamState } from '../use-task-output-stream.js';

interface TaskDependencyRef {
  readonly taskId: string;
  readonly status: string;
}

interface TaskDetailProps {
  readonly task: Task;
  readonly animFrame: number;
  /** Phase C: tasks that this task depends on (blocked-by) */
  readonly dependencies?: readonly TaskDependencyRef[];
  /** Phase C: tasks that depend on this task (blocks) */
  readonly dependents?: readonly TaskDependencyRef[];
  /** Phase C: token/cost usage summary from task_usage table */
  readonly usage?: TaskUsage;
  /** #165: live output stream for this task */
  readonly stream?: OutputStreamState;
  /** #165: whether the output panel is visible */
  readonly outputVisible?: boolean;
  /** #165: whether the output auto-tails */
  readonly outputAutoTail?: boolean;
  /** #165: scroll offset when in paused mode */
  readonly outputScrollOffset?: number;
  /** #165: terminal row count for layout computation */
  readonly terminalRows?: number;
}

export const TaskDetail: React.FC<TaskDetailProps> = React.memo(
  ({
    task,
    animFrame,
    dependencies,
    dependents,
    usage,
    stream,
    outputVisible = true,
    outputAutoTail = true,
    outputScrollOffset = 0,
    terminalRows = 24,
  }) => {
    // Compute elapsed for running tasks
    const elapsedDisplay =
      task.status === 'running' && task.startedAt !== undefined ? formatElapsed(task.startedAt) : undefined;

    const errorMsg = task.error instanceof Error ? task.error.message : undefined;

    // Ref-based metadata height measurement for adaptive output viewport (#165)
    const metadataRef = useRef<DOMElement>(null);
    const [metadataHeight, setMetadataHeight] = useState(0);

    useEffect(() => {
      if (metadataRef.current) {
        const { height } = measureElement(metadataRef.current);
        if (height !== metadataHeight) {
          setMetadataHeight(height);
        }
      }
    });

    const outputLayout = computeDetailOutputLayout({ rows: terminalRows, metadataHeight });

    return (
      <Box flexDirection="column" paddingLeft={1} paddingRight={1}>
        {/* Metadata section — measured for adaptive output viewport */}
        <Box ref={metadataRef} flexDirection="column">
          {/* Header */}
          <Box marginBottom={1}>
            <Text bold>Task Detail</Text>
          </Box>

          <Field label="ID">{truncateCell(task.id, 60)}</Field>
          <StatusField>
            <StatusBadge status={task.status} animFrame={animFrame} />
          </StatusField>
          <Field label="Priority">{task.priority}</Field>
          {task.agent ? <Field label="Agent">{task.agent}</Field> : null}
          {task.model ? <Field label="Model">{task.model}</Field> : null}
          {task.workingDirectory ? (
            <Field label="Working Directory">{truncateCell(task.workingDirectory, 50)}</Field>
          ) : null}
          {/* Orchestrator attribution — shows parent orchestration when present */}
          {task.orchestratorId !== undefined ? <Field label="Orchestrator">{task.orchestratorId}</Field> : null}

          {/* Prompt (full, wrapped) */}
          <LongField label="Prompt" value={task.prompt} />

          {/* Timing */}
          <Field label="Created">{relativeTime(task.createdAt)}</Field>
          {task.startedAt !== undefined ? <Field label="Started">{relativeTime(task.startedAt)}</Field> : null}
          {task.completedAt !== undefined ? <Field label="Completed">{relativeTime(task.completedAt)}</Field> : null}
          {elapsedDisplay !== undefined ? <Field label="Elapsed">{elapsedDisplay}</Field> : null}

          {/* Execution limits */}
          {task.timeout !== undefined ? <Field label="Timeout">{`${task.timeout}ms`}</Field> : null}
          {task.maxOutputBuffer !== undefined ? (
            <Field label="Max Output Buffer">{`${task.maxOutputBuffer} bytes`}</Field>
          ) : null}

          {/* Dependencies */}
          {task.dependsOn !== undefined && task.dependsOn.length > 0 ? (
            <Field label="Depends On">{task.dependsOn.join(', ')}</Field>
          ) : null}
          {task.dependents !== undefined && task.dependents.length > 0 ? (
            <Field label="Dependents">{task.dependents.join(', ')}</Field>
          ) : null}
          {task.dependencyState !== undefined ? <Field label="Dependency State">{task.dependencyState}</Field> : null}

          {/* Retry chain */}
          {task.retryCount !== undefined && task.retryCount > 0 ? (
            <Field label="Retry Count">{String(task.retryCount)}</Field>
          ) : null}
          {task.retryOf !== undefined ? <Field label="Retry Of">{task.retryOf}</Field> : null}
          {task.parentTaskId !== undefined ? <Field label="Parent Task ID">{task.parentTaskId}</Field> : null}

          {/* Exit */}
          {task.exitCode !== undefined ? <Field label="Exit Code">{String(task.exitCode)}</Field> : null}
          {errorMsg !== undefined ? (
            <Box flexDirection="column" marginBottom={0}>
              <Text bold color="cyan">
                Error Message
              </Text>
              <Box paddingLeft={2}>
                <Text color="red" wrap="wrap">
                  {errorMsg}
                </Text>
              </Box>
            </Box>
          ) : null}

          {/* Dependencies section — only shown when dependency data is present */}
          {((dependencies !== undefined && dependencies.length > 0) ||
            (dependents !== undefined && dependents.length > 0)) && (
            <Box flexDirection="column" marginTop={1}>
              <Text bold dimColor>
                Dependencies
              </Text>
              {dependencies !== undefined && dependencies.length > 0 && (
                <Field label="Blocked by">
                  {dependencies.map((d) => `${d.taskId.slice(0, 12)} ${statusIcon(d.status)} ${d.status}`).join(', ')}
                </Field>
              )}
              {dependents !== undefined && dependents.length > 0 && (
                <Field label="Blocks">
                  {dependents.map((d) => `${d.taskId.slice(0, 12)} ${statusIcon(d.status)} ${d.status}`).join(', ')}
                </Field>
              )}
            </Box>
          )}

          {/* Usage section — token/cost summary from task_usage table */}
          {usage !== undefined && (usage.inputTokens > 0 || usage.totalCostUsd > 0) && (
            <Box flexDirection="column" marginTop={1}>
              <Text bold dimColor>
                Usage
              </Text>
              <Field label="Tokens">
                {[
                  `In: ${usage.inputTokens > 1000 ? `${Math.round(usage.inputTokens / 1000)}K` : String(usage.inputTokens)}`,
                  `Out: ${usage.outputTokens > 1000 ? `${Math.round(usage.outputTokens / 1000)}K` : String(usage.outputTokens)}`,
                  (usage.cacheCreationInputTokens ?? 0) + (usage.cacheReadInputTokens ?? 0) > 0
                    ? `Cache: ${Math.round(((usage.cacheCreationInputTokens ?? 0) + (usage.cacheReadInputTokens ?? 0)) / 1000)}K`
                    : null,
                  usage.totalCostUsd > 0 ? `Cost: $${usage.totalCostUsd.toFixed(2)}` : null,
                ]
                  .filter(Boolean)
                  .join(' · ')}
              </Field>
            </Box>
          )}
        </Box>

        {/* Output stream section (#165) */}
        {outputVisible && stream !== undefined && metadataHeight > 0 ? (
          outputLayout.tooSmall ? (
            <Box marginTop={0}>
              <Text dimColor>(terminal too small for output)</Text>
            </Box>
          ) : (
            <Box flexDirection="column" marginTop={0}>
              <Text dimColor>{'─'.repeat(20)}</Text>
              {stream.lines.length === 0 ? (
                <Box height={Math.min(3, outputLayout.outputViewportHeight)}>
                  <Text dimColor>
                    {task.status === TaskStatus.QUEUED || task.status === TaskStatus.RUNNING
                      ? 'Waiting for output...'
                      : stream.totalBytes === 0
                        ? 'No output captured'
                        : 'Loading output...'}
                  </Text>
                </Box>
              ) : (
                <OutputStreamView
                  stream={stream}
                  viewportHeight={outputLayout.outputViewportHeight}
                  scrollOffset={outputScrollOffset}
                  autoTail={outputAutoTail}
                />
              )}
            </Box>
          )
        ) : null}
      </Box>
    );
  },
);

TaskDetail.displayName = 'TaskDetail';
