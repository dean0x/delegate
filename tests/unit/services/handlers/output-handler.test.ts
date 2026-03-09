import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { InMemoryEventBus } from '../../../../src/core/events/event-bus';
import { BufferedOutputCapture } from '../../../../src/implementations/output-capture';
import { OutputHandler } from '../../../../src/services/handlers/output-handler';
import { createTestConfiguration } from '../../../fixtures/factories';
import { TestLogger } from '../../../fixtures/test-doubles';
import { flushEventLoop } from '../../../utils/event-helpers.js';

describe('OutputHandler', () => {
  let handler: OutputHandler;
  let eventBus: InMemoryEventBus;
  let outputCapture: BufferedOutputCapture;
  let logger: TestLogger;

  beforeEach(async () => {
    logger = new TestLogger();
    const config = createTestConfiguration();
    eventBus = new InMemoryEventBus(config, logger);
    outputCapture = new BufferedOutputCapture();

    handler = new OutputHandler(outputCapture, logger);
    const setupResult = await handler.setup(eventBus);
    if (!setupResult.ok) {
      throw new Error(`Failed to setup OutputHandler: ${setupResult.error.message}`);
    }
  });

  afterEach(() => {
    eventBus.dispose();
  });

  describe('LogsRequested', () => {
    it('should retrieve stdout and stderr from OutputCapture', async () => {
      // Set up captured output
      outputCapture.capture('task-1', 'stdout', 'line 1\n');
      outputCapture.capture('task-1', 'stderr', 'error line\n');

      await eventBus.emit('LogsRequested', { taskId: 'task-1' });
      await flushEventLoop();

      // Handler retrieves logs and logs debug info — no crash
      expect(logger.hasLogContaining('Task logs retrieved')).toBe(true);
      const debugLogs = logger.getLogsByLevel('debug').filter((l) => l.message === 'Task logs retrieved');
      expect(debugLogs.length).toBe(1);
      expect(debugLogs[0].context!.taskId).toBe('task-1');
      expect(debugLogs[0].context!.stdoutLines).toBeGreaterThan(0);
      expect(debugLogs[0].context!.stderrLines).toBeGreaterThan(0);
    });

    it('should pass tail parameter to OutputCapture', async () => {
      // Capture multiple lines
      for (let i = 0; i < 10; i++) {
        outputCapture.capture('task-2', 'stdout', `line ${i}\n`);
      }

      await eventBus.emit('LogsRequested', { taskId: 'task-2', tail: 3 });
      await flushEventLoop();

      const debugLogs = logger.getLogsByLevel('debug').filter((l) => l.message === 'Task logs retrieved');
      expect(debugLogs.length).toBe(1);
      expect(debugLogs[0].context!.tail).toBe(3);
    });

    it('should handle missing task output gracefully', async () => {
      // Request logs for a task with no captured output
      await eventBus.emit('LogsRequested', { taskId: 'nonexistent-task' });
      await flushEventLoop();

      // getOutput returns empty arrays for unknown tasks — no error
      expect(logger.hasLogContaining('Task logs retrieved')).toBe(true);
    });
  });

  describe('OutputCaptured', () => {
    it('should log debug output without crashing', async () => {
      await eventBus.emit('OutputCaptured', {
        taskId: 'task-1',
        outputType: 'stdout',
        data: 'hello world',
      });
      await flushEventLoop();

      expect(logger.hasLogContaining('Output captured')).toBe(true);
      const debugLogs = logger.getLogsByLevel('debug').filter((l) => l.message === 'Output captured');
      expect(debugLogs.length).toBe(1);
      expect(debugLogs[0].context!.taskId).toBe('task-1');
      expect(debugLogs[0].context!.outputType).toBe('stdout');
      expect(debugLogs[0].context!.dataSize).toBe(Buffer.byteLength('hello world', 'utf8'));
    });
  });
});
