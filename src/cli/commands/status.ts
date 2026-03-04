import type { Task } from '../../core/domain.js';
import { TaskId } from '../../core/domain.js';
import { errorMessage, withServices } from '../services.js';
import * as ui from '../ui.js';

export async function getTaskStatus(taskId?: string) {
  const s = ui.createSpinner();
  try {
    s.start(taskId ? `Fetching status for ${taskId}...` : 'Fetching tasks...');
    const { taskManager } = await withServices(s);

    if (taskId) {
      const result = await taskManager.getStatus(TaskId(taskId));
      if (result.ok) {
        const task = result.value as Task;
        s.stop('Task found');

        const lines: string[] = [];
        lines.push(`ID:       ${task.id}`);
        lines.push(`Status:   ${ui.colorStatus(task.status)}`);
        lines.push(`Priority: ${task.priority}`);
        lines.push(`Agent:    ${task.agent ?? 'claude'}`);
        if (task.startedAt) lines.push(`Started:  ${new Date(task.startedAt).toISOString()}`);
        if (task.completedAt) lines.push(`Completed: ${new Date(task.completedAt).toISOString()}`);
        if (task.exitCode !== undefined) lines.push(`Exit Code: ${task.exitCode}`);
        if (task.completedAt && task.startedAt) {
          lines.push(`Duration: ${ui.formatDuration(task.completedAt - task.startedAt)}`);
        }
        lines.push(`Prompt:   ${task.prompt.substring(0, 100)}${task.prompt.length > 100 ? '...' : ''}`);

        // Dependencies
        if (task.dependsOn && task.dependsOn.length > 0) {
          lines.push('');
          lines.push(`Depends On: ${task.dependsOn.join(', ')}`);
          if (task.dependencyState) {
            lines.push(`Dep State:  ${task.dependencyState}`);
            if (task.dependencyState === 'blocked') {
              lines.push(`            Waiting for dependencies to complete`);
            } else if (task.dependencyState === 'ready') {
              lines.push(`            All dependencies satisfied`);
            }
          }
        }

        if (task.dependents && task.dependents.length > 0) {
          lines.push('');
          lines.push(`Dependents: ${task.dependents.join(', ')}`);
        }

        ui.note(lines.join('\n'), 'Task Details');
      } else {
        s.stop('Not found');
        ui.error(`Failed to get task status: ${result.error.message}`);
        process.exit(1);
      }
    } else {
      const result = await taskManager.getStatus();
      if (result.ok && Array.isArray(result.value) && result.value.length > 0) {
        s.stop(`${result.value.length} task${result.value.length === 1 ? '' : 's'}`);

        for (const task of result.value as Task[]) {
          const prompt = task.prompt.substring(0, 50) + (task.prompt.length > 50 ? '...' : '');
          ui.step(`${ui.dim(task.id)}  ${ui.colorStatus(task.status.padEnd(10))}  ${prompt}`);
        }
      } else if (result.ok) {
        s.stop('Done');
        ui.info('No tasks found');
      } else {
        s.stop('Failed');
        ui.error(`Failed to get tasks: ${result.error.message}`);
        process.exit(1);
      }
    }
    process.exit(0);
  } catch (error) {
    s.stop('Failed');
    ui.error(errorMessage(error));
    process.exit(1);
  }
}
