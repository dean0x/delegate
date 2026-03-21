import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createReadOnlyContext } from '../../src/cli/read-only-context.js';
import { createTask, TaskStatus } from '../../src/core/domain.js';

describe('ReadOnlyContext', () => {
  let tempDir: string;
  let originalDbPath: string | undefined;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'backbeat-ro-test-'));
    originalDbPath = process.env.BACKBEAT_DATABASE_PATH;
    process.env.BACKBEAT_DATABASE_PATH = join(tempDir, 'test.db');
  });

  afterEach(async () => {
    if (originalDbPath !== undefined) {
      process.env.BACKBEAT_DATABASE_PATH = originalDbPath;
    } else {
      delete process.env.BACKBEAT_DATABASE_PATH;
    }
    await rm(tempDir, { recursive: true, force: true });
  });

  it('creates context with repositories and close()', () => {
    const result = createReadOnlyContext();
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const ctx = result.value;
    expect(ctx.taskRepository).toBeDefined();
    expect(ctx.outputRepository).toBeDefined();
    expect(ctx.scheduleRepository).toBeDefined();
    expect(ctx.loopRepository).toBeDefined();
    expect(ctx.close).toBeInstanceOf(Function);

    ctx.close();
  });

  it('round-trips task data through repository', async () => {
    const result = createReadOnlyContext();
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const ctx = result.value;

    const task = createTask({ prompt: 'test read-only context' });
    const saveResult = await ctx.taskRepository.save(task);
    expect(saveResult.ok).toBe(true);

    const findResult = await ctx.taskRepository.findById(task.id);
    expect(findResult.ok).toBe(true);
    if (!findResult.ok) return;
    expect(findResult.value).not.toBeNull();
    const foundTask = findResult.value;
    if (!foundTask) return;
    expect(foundTask.prompt).toBe('test read-only context');
    expect(foundTask.status).toBe(TaskStatus.QUEUED);

    ctx.close();
  });

  it('close() releases database resources', () => {
    const result = createReadOnlyContext();
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const ctx = result.value;
    // close() should not throw
    ctx.close();
  });

  it('returns error for invalid database path', () => {
    process.env.BACKBEAT_DATABASE_PATH = '/nonexistent/deeply/nested/path/test.db';
    const result = createReadOnlyContext();
    expect(result.ok).toBe(false);
  });

  it('queries multiple repositories from single context', async () => {
    const result = createReadOnlyContext();
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const ctx = result.value;

    // Save two tasks
    const task1 = createTask({ prompt: 'task one' });
    const task2 = createTask({ prompt: 'task two' });
    await ctx.taskRepository.save(task1);
    await ctx.taskRepository.save(task2);

    // Query all tasks
    const allResult = await ctx.taskRepository.findAllUnbounded();
    expect(allResult.ok).toBe(true);
    if (!allResult.ok) return;
    expect(allResult.value.length).toBe(2);

    // Query output (none stored yet)
    const outputResult = await ctx.outputRepository.get(task1.id);
    expect(outputResult.ok).toBe(true);
    if (!outputResult.ok) return;
    expect(outputResult.value).toBeNull();

    // Query schedules (none stored yet)
    const schedResult = await ctx.scheduleRepository.findAll();
    expect(schedResult.ok).toBe(true);
    if (!schedResult.ok) return;
    expect(schedResult.value.length).toBe(0);

    // Query loops (none stored yet)
    const loopResult = await ctx.loopRepository.findAll();
    expect(loopResult.ok).toBe(true);
    if (!loopResult.ok) return;
    expect(loopResult.value.length).toBe(0);

    ctx.close();
  });

  it('output repository round-trips data', async () => {
    const result = createReadOnlyContext();
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const ctx = result.value;

    const task = createTask({ prompt: 'test output' });
    await ctx.taskRepository.save(task);

    await ctx.outputRepository.save(task.id, {
      taskId: task.id,
      stdout: ['line 1', 'line 2'],
      stderr: ['err 1'],
      totalSize: 20,
    });

    const outputResult = await ctx.outputRepository.get(task.id);
    expect(outputResult.ok).toBe(true);
    if (!outputResult.ok) return;
    expect(outputResult.value).not.toBeNull();
    const output = outputResult.value;
    if (!output) return;
    expect(output.stdout).toEqual(['line 1', 'line 2']);
    expect(output.stderr).toEqual(['err 1']);

    ctx.close();
  });
});
