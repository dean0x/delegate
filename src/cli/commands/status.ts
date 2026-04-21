import { TaskId } from '../../core/domain.js';
import { taskNotFound } from '../../core/errors.js';
import { truncatePrompt } from '../../utils/format.js';
import type { ReadOnlyContext } from '../read-only-context.js';
import { errorMessage, exitOnError, exitOnNull, withReadOnlyContext } from '../services.js';
import * as ui from '../ui.js';

export async function getTaskStatus(taskId?: string, options: { showSystemPrompt?: boolean } = {}): Promise<void> {
  const s = ui.createSpinner();
  let ctx: ReadOnlyContext | undefined;
  try {
    s.start(taskId ? `Fetching status for ${taskId}...` : 'Fetching tasks...');
    ctx = withReadOnlyContext(s);

    if (taskId) {
      const result = await ctx.taskRepository.findById(TaskId(taskId));
      const found = exitOnError(result, s, 'Failed to get task status');
      const task = exitOnNull(found, s, `Failed to get task status: ${taskNotFound(taskId).message}`);
      s.stop('Task found');

      const lines: string[] = [];
      lines.push(`ID:       ${task.id}`);
      lines.push(`Status:   ${ui.colorStatus(task.status)}`);
      lines.push(`Priority: ${task.priority}`);
      lines.push(`Agent:    ${task.agent ?? 'unknown'}`);
      if (task.startedAt) lines.push(`Started:  ${new Date(task.startedAt).toISOString()}`);
      if (task.completedAt) lines.push(`Completed: ${new Date(task.completedAt).toISOString()}`);
      if (task.exitCode !== undefined) lines.push(`Exit Code: ${task.exitCode}`);
      if (task.completedAt && task.startedAt) {
        lines.push(`Duration: ${ui.formatDuration(task.completedAt - task.startedAt)}`);
      }
      lines.push(`Prompt:   ${truncatePrompt(task.prompt, 100)}`);
      if (options.showSystemPrompt && task.systemPrompt) {
        lines.push(`System:   ${truncatePrompt(task.systemPrompt, 200)}`);
      }

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
      const result = await ctx.taskRepository.findAll();
      const tasks = exitOnError(result, s, 'Failed to get tasks');

      if (tasks.length > 0) {
        s.stop(`${tasks.length} task${tasks.length === 1 ? '' : 's'}`);

        for (const task of tasks) {
          const prompt = truncatePrompt(task.prompt, 50);
          ui.step(`${ui.dim(task.id)}  ${ui.colorStatus(task.status.padEnd(10))}  ${prompt}`);
        }
      } else {
        s.stop('Done');
        ui.info('No tasks found');
      }
    }
  } catch (error) {
    s.stop('Failed');
    ui.error(errorMessage(error));
    process.exit(1);
  } finally {
    ctx?.close();
  }
  process.exit(0);
}
