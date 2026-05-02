import { describe, expect, it, vi } from 'vitest';
import {
  canCancel,
  comparePriority,
  createTask,
  isTerminalState,
  Priority,
  type Task,
  TaskId,
  type TaskRequest,
  TaskStatus,
  updateTask,
  type Worker,
  WorkerId,
} from '../../../src/core/domain';
import { BUFFER_SIZES, TIMEOUTS } from '../../constants';
import { TaskFactory } from '../../fixtures/factories';

describe('Domain Models - REAL Behavior Tests', () => {
  describe('Branded types', () => {
    it('should create TaskId', () => {
      const id = TaskId('task-123');
      expect(id).toBe('task-123');
      expect(typeof id).toBe('string');
    });

    it('should create WorkerId', () => {
      const id = WorkerId('worker-456');
      expect(id).toBe('worker-456');
      expect(typeof id).toBe('string');
    });
  });

  describe('createTask', () => {
    it('should create task with minimum requirements', () => {
      const request: TaskRequest = {
        prompt: 'echo hello world',
      };

      const task = createTask(request);

      expect(task.id).toMatch(/^task-[a-f0-9-]+$/);
      expect(task.prompt).toBe('echo hello world');
      expect(task.status).toBe(TaskStatus.QUEUED);
      expect(task.priority).toBe(Priority.P2); // Default

      expect(task.timeout).toBeUndefined();
      expect(task.maxOutputBuffer).toBeUndefined();
      expect(task.workingDirectory).toBeUndefined();
      expect(task.startedAt).toBeUndefined();
      expect(task.completedAt).toBeUndefined();
      expect(typeof task.createdAt).toBe('number');
      expect(task.createdAt).toBeGreaterThan(0);
      expect(task.updatedAt).toBe(task.createdAt);
    });

    it('should create task with full configuration', () => {
      const request: TaskRequest = {
        prompt: 'complex task',
        priority: Priority.P0,
        workingDirectory: '/workspace',
        timeout: 60000,
        maxOutputBuffer: BUFFER_SIZES.SMALL,
      };

      const task = createTask(request);

      expect(task.priority).toBe(Priority.P0);
      expect(task.workingDirectory).toBe('/workspace');
      expect(task.timeout).toBe(60000);
      expect(task.maxOutputBuffer).toBe(BUFFER_SIZES.SMALL);
      expect(task.prompt).toBe('complex task');
      expect(task.status).toBe(TaskStatus.QUEUED);
      expect(task.id).toMatch(/^task-[a-f0-9-]+$/);
      expect(typeof task.createdAt).toBe('number');
      expect(task.updatedAt).toBe(task.createdAt);
    });

    it('should generate unique task IDs', () => {
      const tasks = Array.from({ length: 100 }, () => new TaskFactory().withPrompt('test').build());

      const ids = new Set(tasks.map((t) => t.id));
      expect(ids.size).toBe(100);

      for (const task of tasks) {
        expect(task.id).toMatch(/^task-[a-f0-9-]+$/);
      }
    });
  });

  describe('updateTask', () => {
    it('should update task status', () => {
      const task = createTask({ prompt: 'test' });
      const updated = updateTask(task, { status: TaskStatus.RUNNING });

      expect(updated.status).toBe(TaskStatus.RUNNING);
      expect(updated.updatedAt).toBeGreaterThanOrEqual(task.createdAt);
      expect(updated.prompt).toBe('test'); // Unchanged
      expect(updated.id).toBe(task.id); // Unchanged
      expect(updated).not.toBe(task); // New object created
    });

    it('should update multiple fields', () => {
      const task = createTask({ prompt: 'test' });
      const updated = updateTask(task, {
        status: TaskStatus.COMPLETED,
        exitCode: 0,
        duration: TIMEOUTS.LONG,
        completedAt: Date.now(),
      });

      expect(updated.status).toBe(TaskStatus.COMPLETED);
      expect(updated.exitCode).toBe(0);
      expect(updated.duration).toBe(TIMEOUTS.LONG);
      expect(updated.completedAt).toBeDefined();
    });

    it('should preserve immutability', () => {
      const dateSpy = vi
        .spyOn(Date, 'now')
        .mockReturnValueOnce(1000) // createTask
        .mockReturnValueOnce(2000); // updateTask

      const task = createTask({ prompt: 'test' });
      const updated = updateTask(task, { status: TaskStatus.FAILED });

      dateSpy.mockRestore();

      expect(task.status).toBe(TaskStatus.QUEUED);
      expect(task.updatedAt).toBe(1000);
      expect(updated.status).toBe(TaskStatus.FAILED);
      expect(task).not.toBe(updated);
      expect(updated.updatedAt).toBe(2000);
    });

    it('should update worker assignment', () => {
      const task = createTask({ prompt: 'test' });
      const workerId = WorkerId('worker-123');

      const updated = updateTask(task, {
        status: TaskStatus.RUNNING,
        workerId,
        startedAt: Date.now(),
      });

      expect(updated.workerId).toBe(workerId);
      expect(updated.startedAt).toBeDefined();
    });

    it('should handle error updates', () => {
      const task = createTask({ prompt: 'test' });
      const error = { message: 'Command failed', code: 1 };

      const updated = updateTask(task, {
        status: TaskStatus.FAILED,
        error,
        exitCode: 1,
      });

      expect(updated.error).toEqual(error);
      expect(updated.exitCode).toBe(1);
    });
  });

  describe('isTerminalState', () => {
    it('should identify terminal states', () => {
      expect(isTerminalState(TaskStatus.COMPLETED)).toBe(true);
      expect(isTerminalState(TaskStatus.FAILED)).toBe(true);
      expect(isTerminalState(TaskStatus.CANCELLED)).toBe(true);
    });

    it('should identify non-terminal states', () => {
      expect(isTerminalState(TaskStatus.QUEUED)).toBe(false);
      expect(isTerminalState(TaskStatus.RUNNING)).toBe(false);
    });
  });

  describe('canCancel', () => {
    it('should allow cancelling queued tasks', () => {
      const task = createTask({ prompt: 'test' });
      expect(canCancel(task)).toBe(true);
    });

    it('should allow cancelling running tasks', () => {
      const task = createTask({ prompt: 'test' });
      const running = updateTask(task, { status: TaskStatus.RUNNING });
      expect(canCancel(running)).toBe(true);
    });

    it('should not allow cancelling completed tasks', () => {
      const task = createTask({ prompt: 'test' });
      const completed = updateTask(task, { status: TaskStatus.COMPLETED });
      expect(canCancel(completed)).toBe(false);
    });

    it('should not allow cancelling failed tasks', () => {
      const task = createTask({ prompt: 'test' });
      const failed = updateTask(task, { status: TaskStatus.FAILED });
      expect(canCancel(failed)).toBe(false);
    });

    it('should not allow cancelling already cancelled tasks', () => {
      const task = createTask({ prompt: 'test' });
      const cancelled = updateTask(task, { status: TaskStatus.CANCELLED });
      expect(canCancel(cancelled)).toBe(false);
    });
  });

  describe('comparePriority', () => {
    it('should order priorities correctly', () => {
      expect(comparePriority(Priority.P0, Priority.P1)).toBeLessThan(0);
      expect(comparePriority(Priority.P0, Priority.P2)).toBeLessThan(0);
      expect(comparePriority(Priority.P1, Priority.P2)).toBeLessThan(0);
    });

    it('should handle equal priorities', () => {
      expect(comparePriority(Priority.P0, Priority.P0)).toBe(0);
      expect(comparePriority(Priority.P1, Priority.P1)).toBe(0);
      expect(comparePriority(Priority.P2, Priority.P2)).toBe(0);
    });

    it('should order reverse priorities', () => {
      expect(comparePriority(Priority.P2, Priority.P1)).toBeGreaterThan(0);
      expect(comparePriority(Priority.P2, Priority.P0)).toBeGreaterThan(0);
      expect(comparePriority(Priority.P1, Priority.P0)).toBeGreaterThan(0);
    });

    it('should work with array sort', () => {
      const tasks = [
        createTask({ prompt: 'p2', priority: Priority.P2 }),
        createTask({ prompt: 'p0', priority: Priority.P0 }),
        createTask({ prompt: 'p1', priority: Priority.P1 }),
        createTask({ prompt: 'p2-2', priority: Priority.P2 }),
        createTask({ prompt: 'p0-2', priority: Priority.P0 }),
      ];

      tasks.sort((a, b) => comparePriority(a.priority, b.priority));

      expect(tasks[0].prompt).toContain('p0');
      expect(tasks[1].prompt).toContain('p0');
      expect(tasks[2].prompt).toBe('p1');
      expect(tasks[3].prompt).toContain('p2');
      expect(tasks[4].prompt).toContain('p2');
    });
  });

  describe('Type definitions', () => {
    it('should enforce Task immutability at runtime', () => {
      // Test RUNTIME immutability enforcement
      const task: Task = Object.freeze(createTask({ prompt: 'test' }));

      // Test that frozen objects prevent mutations
      const attemptStatusChange = () => {
        'use strict';
        // @ts-expect-error - Testing runtime immutability enforcement
        task.status = TaskStatus.FAILED;
      };

      const attemptPromptChange = () => {
        'use strict';
        // @ts-expect-error - Testing runtime immutability enforcement
        task.prompt = 'changed';
      };

      expect(attemptStatusChange).toThrow(TypeError);
      expect(attemptPromptChange).toThrow(TypeError);

      // Verify values remain unchanged
      expect(task.status).toBe(TaskStatus.QUEUED); // FIX: Default status is QUEUED not PENDING
      expect(task.prompt).toBe('test');
    });

    it('should have correct Worker structure', () => {
      const worker: Worker = {
        id: WorkerId('worker-123'),
        taskId: TaskId('task-456'),
        pid: 12345,
        startedAt: Date.now(),
        cpuUsage: 25.5,
        memoryUsage: BUFFER_SIZES.SMALL,
      };

      expect(worker.id).toBe('worker-123');
      expect(worker.taskId).toBe('task-456');
      expect(worker.pid).toBe(12345);
    });
  });

  describe('Real-world scenarios', () => {
    it('should handle task lifecycle', () => {
      // Create
      let task = createTask({
        prompt: 'npm test',
        priority: Priority.P1,
      });
      expect(task.status).toBe(TaskStatus.QUEUED);
      expect(canCancel(task)).toBe(true);

      // Start
      task = updateTask(task, {
        status: TaskStatus.RUNNING,
        workerId: WorkerId('worker-1'),
        startedAt: Date.now(),
      });
      expect(task.status).toBe(TaskStatus.RUNNING);
      expect(task.workerId).toBe('worker-1');
      expect(canCancel(task)).toBe(true);

      // Complete
      const completedAt = Date.now();
      task = updateTask(task, {
        status: TaskStatus.COMPLETED,
        exitCode: 0,
        completedAt,
        duration: completedAt - (task.startedAt || 0),
      });
      expect(task.status).toBe(TaskStatus.COMPLETED);
      expect(isTerminalState(task.status)).toBe(true);
      expect(canCancel(task)).toBe(false);
    });

    it('should handle priority queue scenario', () => {
      const tasks = [
        createTask({ prompt: 'low priority', priority: Priority.P2 }),
        createTask({ prompt: 'critical', priority: Priority.P0 }),
        createTask({ prompt: 'normal', priority: Priority.P2 }),
        createTask({ prompt: 'high', priority: Priority.P1 }),
        createTask({ prompt: 'another critical', priority: Priority.P0 }),
      ];

      // Sort by priority
      const sorted = [...tasks].sort((a, b) => comparePriority(a.priority, b.priority));

      // P0 tasks should be first
      expect(sorted[0].prompt).toBe('critical');
      expect(sorted[1].prompt).toBe('another critical');
      // Then P1
      expect(sorted[2].prompt).toBe('high');
      // Then P2
      expect(sorted[3].prompt).toContain('priority');
      expect(sorted[4].prompt).toBe('normal');
    });

    it('should handle task failure scenario', () => {
      let task = createTask({ prompt: 'failing command' });

      // Start task
      task = updateTask(task, {
        status: TaskStatus.RUNNING,
        workerId: WorkerId('worker-1'),
        startedAt: Date.now(),
      });

      // Task fails
      task = updateTask(task, {
        status: TaskStatus.FAILED,
        exitCode: 1,
        error: {
          message: 'Command not found',
          code: 'ENOENT',
        },
        completedAt: Date.now(),
      });

      expect(task.status).toBe(TaskStatus.FAILED);
      expect(task.exitCode).toBe(1);
      expect(task.error).toBeDefined();
      expect(isTerminalState(task.status)).toBe(true);
      expect(canCancel(task)).toBe(false);
    });

    it('should handle task cancellation', () => {
      let task = createTask({ prompt: 'long running task' });

      // Start task
      task = updateTask(task, {
        status: TaskStatus.RUNNING,
        workerId: WorkerId('worker-1'),
        startedAt: Date.now(),
      });

      // Check can cancel
      expect(canCancel(task)).toBe(true);

      // Cancel task
      task = updateTask(task, {
        status: TaskStatus.CANCELLED,
        completedAt: Date.now(),
      });

      expect(task.status).toBe(TaskStatus.CANCELLED);
      expect(isTerminalState(task.status)).toBe(true);
      expect(canCancel(task)).toBe(false);
    });

    it('should set continueFrom when provided in request', () => {
      const parentId = TaskId('task-parent-abc');
      const task = createTask({
        prompt: 'continue auth work',
        dependsOn: [parentId],
        continueFrom: parentId,
      });

      expect(task.continueFrom).toBe(parentId);
      expect(task.dependsOn).toEqual([parentId]);
      expect(task.dependencyState).toBe('blocked');
    });

    it('should leave continueFrom undefined when not provided', () => {
      const task = createTask({
        prompt: 'standalone task',
      });

      expect(task.continueFrom).toBeUndefined();
      expect(task.dependencyState).toBe('none');
    });

    it('should set agent when provided in request (v0.5.0)', () => {
      const task = createTask({
        prompt: 'analyze with codex',
        agent: 'codex',
      });

      expect(task.agent).toBe('codex');
    });

    it('should leave agent undefined when not provided (defaults to claude at runtime)', () => {
      const task = createTask({
        prompt: 'default agent task',
      });

      expect(task.agent).toBeUndefined();
    });

    it('should accept all valid agent providers (v0.5.0)', () => {
      const agents = ['claude', 'codex'] as const;

      for (const agent of agents) {
        const task = createTask({
          prompt: `task for ${agent}`,
          agent,
        });

        expect(task.agent).toBe(agent);
        expect(task.status).toBe(TaskStatus.QUEUED);
      }
    });

    it('should freeze task with agent field (v0.5.0)', () => {
      const task = createTask({
        prompt: 'frozen agent task',
        agent: 'codex',
      });

      expect(Object.isFrozen(task)).toBe(true);
      expect(task.agent).toBe('codex');
    });

    it('should propagate model field from request to task', () => {
      const task = createTask({
        prompt: 'use specific model',
        agent: 'claude',
        model: 'claude-opus-4-5',
      });

      expect(task.model).toBe('claude-opus-4-5');
    });

    it('should leave model undefined when not provided', () => {
      const task = createTask({
        prompt: 'default model task',
      });

      expect(task.model).toBeUndefined();
    });
  });
});
