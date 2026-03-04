import { describe, expect, it, vi } from 'vitest';
import {
  canCancel,
  comparePriority,
  createTask,
  isTerminalState,
  Priority,
  type SystemResources,
  type Task,
  TaskId,
  type TaskOutput,
  type TaskRequest,
  TaskStatus,
  type TaskUpdate,
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

      // Additional validations for complete task structure
      // FIX: timeout and maxOutputBuffer are undefined when not provided (no defaults in createTask)
      expect(task.timeout).toBeUndefined();
      expect(task.maxOutputBuffer).toBeUndefined();
      expect(task.workingDirectory).toBeUndefined();
      expect(task.assignedWorker).toBeUndefined();
      expect(task.startedAt).toBeUndefined();
      expect(task.completedAt).toBeUndefined();
      expect(task.output).toBeUndefined(); // FIX: output is also undefined when not provided
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
      expect(ids.size).toBe(100); // All unique
      expect(Array.isArray(tasks)).toBe(true);
      expect(tasks.length).toBe(100);

      // All IDs should match the expected pattern
      tasks.forEach((task) => {
        expect(task.id).toMatch(/^task-[a-f0-9-]+$/);
        expect(typeof task.id).toBe('string');
        expect(task.id.startsWith('task-')).toBe(true);
      });
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
      // Mock Date.now() to return different values
      // createTask calls Date.now() once, updateTask calls it once
      const originalTime = 1000;
      const updatedTime = 2000;
      const dateSpy = vi
        .spyOn(Date, 'now')
        .mockReturnValueOnce(originalTime) // createTask (for createdAt and updatedAt)
        .mockReturnValueOnce(updatedTime); // updateTask (for updatedAt)

      const task = createTask({ prompt: 'test' });
      const originalStatus = task.status;
      const originalUpdatedAt = task.updatedAt;

      const updated = updateTask(task, { status: TaskStatus.FAILED });

      dateSpy.mockRestore();

      expect(task.status).toBe(TaskStatus.QUEUED); // Original unchanged
      expect(task.status).toBe(originalStatus);
      expect(task.updatedAt).toBe(originalUpdatedAt);
      expect(updated.status).toBe(TaskStatus.FAILED);
      expect(task).not.toBe(updated); // Different objects
      expect(updated.updatedAt).toBeGreaterThan(originalUpdatedAt);
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
      // Verify these are the only terminal states
      expect([TaskStatus.COMPLETED, TaskStatus.FAILED, TaskStatus.CANCELLED].every((s) => isTerminalState(s))).toBe(
        true,
      );
    });

    it('should identify non-terminal states', () => {
      expect(isTerminalState(TaskStatus.QUEUED)).toBe(false);
      expect(isTerminalState(TaskStatus.RUNNING)).toBe(false);
      // Verify these states allow progression
      expect([TaskStatus.QUEUED, TaskStatus.RUNNING].every((s) => !isTerminalState(s))).toBe(true);
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

    it('should have correct SystemResources structure', () => {
      const resources: SystemResources = {
        cpuUsage: 45.5,
        availableMemory: 8000000000,
        totalMemory: 16000000000,
        loadAverage: [1.5, 1.2, 1.0],
        workerCount: 3,
      };

      expect(resources.cpuUsage).toBe(45.5);
      expect(resources.loadAverage).toHaveLength(3);
    });

    it('should have correct TaskOutput structure', () => {
      const output: TaskOutput = {
        taskId: TaskId('task-123'),
        stdout: ['Line 1', 'Line 2'],
        stderr: ['Error 1'],
        totalSize: 1024,
      };

      expect(output.taskId).toBe('task-123');
      expect(output.stdout).toHaveLength(2);
      expect(output.stderr).toHaveLength(1);
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
      const agents = ['claude', 'codex', 'gemini', 'aider'] as const;

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
        agent: 'gemini',
      });

      expect(Object.isFrozen(task)).toBe(true);
      expect(task.agent).toBe('gemini');
    });
  });
});
