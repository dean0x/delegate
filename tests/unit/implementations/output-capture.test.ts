import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { EventBus } from '../../../src/core/interfaces';
import { BufferedOutputCapture } from '../../../src/implementations/output-capture';
import { BUFFER_SIZES, TEST_COUNTS, TIMEOUTS } from '../../constants';
import { TestEventBus } from '../../fixtures/test-doubles';

describe('BufferedOutputCapture - REAL Buffer Management', () => {
  let capture: BufferedOutputCapture;
  let mockEventBus: EventBus;

  beforeEach(() => {
    // Use TestEventBus for proper type safety
    mockEventBus = new TestEventBus();

    capture = new BufferedOutputCapture(BUFFER_SIZES.TINY, mockEventBus); // 1KB max buffer
  });

  describe('Basic capture operations', () => {
    it('should capture stdout data for a task', () => {
      const result = capture.capture('task-123', 'stdout', 'Hello World\n');
      expect(result.ok).toBe(true);

      const output = capture.getOutput('task-123');
      expect(output.ok).toBe(true);
      if (output.ok) {
        expect(output.value.stdout).toEqual(['Hello World\n']);
        expect(output.value.stderr).toEqual([]);
        expect(output.value.taskId).toBe('task-123');
      }
    });

    it('should capture both stdout and stderr separately', () => {
      capture.capture('task-123', 'stdout', 'Standard output\n');
      capture.capture('task-123', 'stderr', 'Error output\n');
      capture.capture('task-123', 'stdout', 'More stdout\n');

      const output = capture.getOutput('task-123');
      if (output.ok) {
        expect(output.value.stdout).toEqual(['Standard output\n', 'More stdout\n']);
        expect(output.value.stderr).toEqual(['Error output\n']);
      }
    });

    it('should handle output without trailing newlines', () => {
      capture.capture('task-123', 'stdout', 'No newline');
      capture.capture('task-123', 'stdout', 'Also no newline');

      const output = capture.getOutput('task-123');
      if (output.ok) {
        expect(output.value.stdout).toEqual(['No newline', 'Also no newline']);
      }
    });

    it('should handle multi-line output as single capture', () => {
      capture.capture('task-123', 'stdout', 'Line 1\nLine 2\nLine 3\n');

      const output = capture.getOutput('task-123');
      if (output.ok) {
        expect(output.value.stdout).toEqual(['Line 1\nLine 2\nLine 3\n']);
      }
    });

    it('should return empty output for non-existent task', () => {
      const output = capture.getOutput('non-existent');

      expect(output.ok).toBe(true);
      if (output.ok) {
        expect(output.value.stdout).toEqual([]);
        expect(output.value.stderr).toEqual([]);
        expect(output.value.totalSize).toBe(0);
      }
    });

    it('should emit OutputCaptured event', () => {
      const result = capture.capture('task-123', 'stdout', 'test data');

      expect(result.ok).toBe(true);
      // FIX: TestEventBus doesn't have spy, use hasEmitted() method
      const testEventBus = mockEventBus as TestEventBus; // Cast to access TestEventBus methods
      expect(
        testEventBus.hasEmitted('OutputCaptured', {
          taskId: 'task-123',
          outputType: 'stdout',
          data: 'test data',
        }),
      ).toBe(true);

      const output = capture.getOutput('task-123');
      expect(output.ok).toBe(true);
      if (output.ok) {
        expect(output.value.stdout).toContain('test data');
      }
    });
  });

  describe('Buffer size management', () => {
    it('should track total buffer size', () => {
      const result1 = capture.capture('task-123', 'stdout', 'Hello'); // 5 bytes
      const result2 = capture.capture('task-123', 'stderr', 'World'); // 5 bytes

      expect(result1.ok).toBe(true);
      expect(result2.ok).toBe(true);

      const output = capture.getOutput('task-123');
      expect(output.ok).toBe(true);
      if (output.ok) {
        expect(output.value.totalSize).toBe(10);
        // FIX: getOutput() returns arrays, not strings
        expect(output.value.stdout.join('')).toBe('Hello');
        expect(output.value.stderr.join('')).toBe('World');
      }
    });

    it('should reject output when buffer limit exceeded', () => {
      // Try to add more than 1KB
      const largeData = 'x'.repeat(1025);
      const result = capture.capture('task-overflow', 'stdout', largeData);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain('Output buffer limit exceeded');
      }
    });

    it('should allow output up to the limit', () => {
      // Exactly 1KB
      const data = 'x'.repeat(1024);
      const result = capture.capture('task-exact', 'stdout', data);

      expect(result.ok).toBe(true);

      const output = capture.getOutput('task-exact');
      expect(output.ok).toBe(true);
      if (output.ok) {
        expect(output.value.totalSize).toBe(1024);
        // FIX: stdout is array, check joined string length
        expect(output.value.stdout.join('').length).toBe(1024);
        expect(output.value.stderr.join('')).toBe('');
        expect(output.value.stdout.join('')).toBe(data);
      }
    });

    it('should accumulate size across multiple captures', () => {
      const chunk = 'x'.repeat(500);

      // First chunk should succeed
      const result1 = capture.capture('task-acc', 'stdout', chunk);
      expect(result1.ok).toBe(true);

      // Second chunk should succeed (total 1000 < 1024)
      const result2 = capture.capture('task-acc', 'stdout', chunk);
      expect(result2.ok).toBe(true);

      // Third chunk should fail (would be 1500 > 1024)
      const result3 = capture.capture('task-acc', 'stdout', chunk);
      expect(result3.ok).toBe(false);
    });

    it('should calculate byte length correctly for UTF-8', () => {
      // UTF-8 characters can be multiple bytes
      const emoji = '😀'; // 4 bytes
      const result = capture.capture('task-utf8', 'stdout', emoji);

      expect(result.ok).toBe(true);
      const output = capture.getOutput('task-utf8');
      expect(output.ok).toBe(true);
      if (output.ok) {
        expect(output.value.totalSize).toBe(4);
        // FIX: stdout is array, join to get string
        expect(output.value.stdout.join('')).toBe(emoji);
        expect(output.value.stderr.join('')).toBe('');
        expect(typeof output.value.stdout).toBe('object'); // It's an array
      }
    });
  });

  describe('Per-task configuration', () => {
    it('should use per-task buffer limit when configured', () => {
      // Configure task with smaller limit
      capture.configureTask('task-small', { maxOutputBuffer: 100 });

      const data = 'x'.repeat(101);
      const result = capture.capture('task-small', 'stdout', data);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain('Output buffer limit exceeded');
      }
    });

    it('should allow different limits for different tasks', () => {
      capture.configureTask('task-small', { maxOutputBuffer: 100 });
      capture.configureTask('task-large', { maxOutputBuffer: 2048 });

      const data150 = 'x'.repeat(150);
      expect(data150.length).toBe(150);

      // Should fail for small task
      const result1 = capture.capture('task-small', 'stdout', data150);
      expect(result1.ok).toBe(false);
      if (!result1.ok) {
        expect(result1.error.message).toContain('exceeded');
      }

      // Should succeed for large task
      const result2 = capture.capture('task-large', 'stdout', data150);
      expect(result2.ok).toBe(true);
      const output = capture.getOutput('task-large');
      if (output.ok) {
        expect(output.value.totalSize).toBe(150);
      }
    });

    it('should fall back to global limit if not configured', () => {
      // Global limit is 1024
      const data = 'x'.repeat(1025);
      const result = capture.capture('task-default', 'stdout', data);

      expect(result.ok).toBe(false);
    });
  });

  describe('Tail functionality', () => {
    it('should return last N entries with tail', () => {
      for (let i = 1; i <= 10; i++) {
        capture.capture('task-tail', 'stdout', `Line ${i}`);
      }

      const output = capture.getOutput('task-tail', 5);
      if (output.ok) {
        expect(output.value.stdout).toEqual(['Line 6', 'Line 7', 'Line 8', 'Line 9', 'Line 10']);
      }
    });

    it('should handle tail larger than output', () => {
      capture.capture('task-tail', 'stdout', 'Line 1');
      capture.capture('task-tail', 'stdout', 'Line 2');

      const output = capture.getOutput('task-tail', 10);
      if (output.ok) {
        expect(output.value.stdout).toEqual(['Line 1', 'Line 2']);
      }
    });

    it('should tail both stdout and stderr', () => {
      for (let i = 1; i <= 5; i++) {
        capture.capture('task-tail', 'stdout', `Out ${i}`);
        capture.capture('task-tail', 'stderr', `Err ${i}`);
      }

      const output = capture.getOutput('task-tail', 3);
      if (output.ok) {
        expect(output.value.stdout).toEqual(['Out 3', 'Out 4', 'Out 5']);
        expect(output.value.stderr).toEqual(['Err 3', 'Err 4', 'Err 5']);
      }
    });

    it('should recalculate totalSize after tail-slicing', () => {
      for (let i = 1; i <= 10; i++) {
        capture.capture('task-tail-size', 'stdout', `Line ${i}`);
      }

      const output = capture.getOutput('task-tail-size', 2);
      expect(output.ok).toBe(true);
      if (output.ok) {
        expect(output.value.stdout).toEqual(['Line 9', 'Line 10']);
        // totalSize should reflect only the 2 returned lines: 'Line 9'(6) + 'Line 10'(7) = 13
        expect(output.value.totalSize).toBe(13);
      }
    });

    it('should return all output when tail is 0 or undefined', () => {
      capture.capture('task-tail', 'stdout', 'Line 1');
      capture.capture('task-tail', 'stdout', 'Line 2');

      const output1 = capture.getOutput('task-tail', 0);
      const output2 = capture.getOutput('task-tail');

      if (output1.ok) {
        expect(output1.value.stdout).toEqual(['Line 1', 'Line 2']);
      }
      if (output2.ok) {
        expect(output2.value.stdout).toEqual(['Line 1', 'Line 2']);
      }
    });
  });

  describe('Multiple task management', () => {
    it('should handle multiple concurrent tasks', () => {
      const taskIds = ['task-1', 'task-2', 'task-3'];

      taskIds.forEach((id) => {
        capture.capture(id, 'stdout', `Output for ${id}`);
      });

      taskIds.forEach((id) => {
        const output = capture.getOutput(id);
        if (output.ok) {
          expect(output.value.stdout).toEqual([`Output for ${id}`]);
        }
      });
    });

    it('should isolate output between tasks', () => {
      capture.capture('task-a', 'stdout', 'A output');
      capture.capture('task-b', 'stdout', 'B output');
      capture.capture('task-a', 'stderr', 'A error');

      const outputA = capture.getOutput('task-a');
      const outputB = capture.getOutput('task-b');

      if (outputA.ok) {
        expect(outputA.value.stdout).toEqual(['A output']);
        expect(outputA.value.stderr).toEqual(['A error']);
      }

      if (outputB.ok) {
        expect(outputB.value.stdout).toEqual(['B output']);
        expect(outputB.value.stderr).toEqual([]);
      }
    });

    it('should track buffer size independently per task', () => {
      capture.capture('task-1', 'stdout', 'x'.repeat(500));
      capture.capture('task-2', 'stdout', 'y'.repeat(600));

      expect(capture.getBufferSize('task-1')).toBe(500);
      expect(capture.getBufferSize('task-2')).toBe(600);
    });
  });

  describe('Clear and cleanup', () => {
    it('should clear output for specific task', () => {
      capture.capture('task-clear', 'stdout', 'To be cleared');

      const beforeClear = capture.getOutput('task-clear');
      expect(beforeClear.ok && beforeClear.value.stdout).toHaveLength(1);

      const clearResult = capture.clear('task-clear');
      expect(clearResult.ok).toBe(true);

      const afterClear = capture.getOutput('task-clear');
      if (afterClear.ok) {
        expect(afterClear.value.stdout).toEqual([]);
        expect(afterClear.value.stderr).toEqual([]);
        expect(afterClear.value.totalSize).toBe(0);
      }
    });

    it('should clear task configuration on cleanup', () => {
      capture.configureTask('task-cleanup', { maxOutputBuffer: 100 });
      capture.capture('task-cleanup', 'stdout', 'test');

      const cleanupResult = capture.cleanup('task-cleanup');
      expect(cleanupResult.ok).toBe(true);

      // After cleanup, should use global limit again
      const data = 'x'.repeat(150);
      capture.capture('task-cleanup', 'stdout', data);

      // Should succeed with global limit (1024)
      const output = capture.getOutput('task-cleanup');
      if (output.ok) {
        expect(output.value.totalSize).toBe(150);
      }
    });

    it('should handle clear for non-existent task', () => {
      const result = capture.clear('non-existent');
      expect(result.ok).toBe(true);
    });

    it('should clear old buffers when limit exceeded', () => {
      // Create 15 tasks
      for (let i = 0; i < 15; i++) {
        capture.capture(`task-${i}`, 'stdout', `Data ${i}`);
      }

      // Clear old buffers, keeping only 10
      capture.clearOldBuffers(10);

      // First 5 should be cleared
      for (let i = 0; i < 5; i++) {
        expect(capture.getBufferSize(`task-${i}`)).toBe(0);
      }

      // Last 10 should still exist
      for (let i = 5; i < 15; i++) {
        expect(capture.getBufferSize(`task-${i}`)).toBeGreaterThan(0);
      }
    });

    it('should not clear buffers when under limit', () => {
      // Create only 5 tasks
      for (let i = 0; i < 5; i++) {
        capture.capture(`task-${i}`, 'stdout', `Data ${i}`);
      }

      // Try to clear with limit of 10 (no-op)
      capture.clearOldBuffers(10);

      // All should still exist
      for (let i = 0; i < 5; i++) {
        expect(capture.getBufferSize(`task-${i}`)).toBeGreaterThan(0);
      }
    });
  });

  describe('Output immutability', () => {
    it('should return frozen output arrays', () => {
      capture.capture('task-frozen', 'stdout', 'test');

      const output = capture.getOutput('task-frozen');
      if (output.ok) {
        expect(Object.isFrozen(output.value.stdout)).toBe(true);
        expect(Object.isFrozen(output.value.stderr)).toBe(true);

        // Should not be able to modify
        expect(() => {
          output.value.stdout.push('new');
        }).toThrow();
      }
    });

    it('should return copies, not references', () => {
      capture.capture('task-copy', 'stdout', 'original');

      const output1 = capture.getOutput('task-copy');
      const output2 = capture.getOutput('task-copy');

      if (output1.ok && output2.ok) {
        expect(output1.value.stdout).not.toBe(output2.value.stdout);
        expect(output1.value.stdout).toEqual(output2.value.stdout);
      }
    });
  });

  describe('Performance characteristics', () => {
    it('should handle rapid output efficiently', () => {
      // Use a larger buffer for performance test
      const perfCapture = new BufferedOutputCapture(100 * 1024); // 100KB buffer
      const iterations = TEST_COUNTS.STRESS_TEST;
      const start = performance.now();

      for (let i = 0; i < iterations; i++) {
        perfCapture.capture('task-perf', 'stdout', `Line ${i}`);
      }

      const duration = performance.now() - start;

      expect(duration).toBeLessThan(TIMEOUTS.SHORT); // Should handle stress test captures quickly

      const output = perfCapture.getOutput('task-perf');
      if (output.ok) {
        expect(output.value.stdout).toHaveLength(iterations);
      }
    });

    it('should track total size accurately', () => {
      const outputs = [
        'Short', // 5 bytes
        'Medium line', // 11 bytes
        'A longer line', // 13 bytes
      ];

      outputs.forEach((out) => {
        capture.capture('task-size', 'stdout', out);
      });

      const output = capture.getOutput('task-size');
      if (output.ok) {
        expect(output.value.totalSize).toBe(29); // 5 + 11 + 13
      }
    });

    it('should handle large number of tasks', () => {
      const taskCount = 100;

      for (let i = 0; i < taskCount; i++) {
        capture.capture(`task-${i}`, 'stdout', `Data for task ${i}`);
      }

      // Should be able to retrieve all
      for (let i = 0; i < taskCount; i++) {
        const output = capture.getOutput(`task-${i}`);
        expect(output.ok).toBe(true);
        if (output.ok) {
          expect(output.value.stdout[0]).toBe(`Data for task ${i}`);
        }
      }
    });
  });

  describe('Real-world patterns', () => {
    it('should handle ANSI escape codes', () => {
      // Common ANSI codes in terminal output
      capture.capture('task-ansi', 'stdout', '\x1b[32mGreen text\x1b[0m');
      capture.capture('task-ansi', 'stdout', '\x1b[1;31mBold red\x1b[0m');

      const output = capture.getOutput('task-ansi');
      if (output.ok) {
        // Should preserve ANSI codes
        expect(output.value.stdout[0]).toContain('\x1b[32m');
        expect(output.value.stdout[1]).toContain('\x1b[1;31m');
      }
    });

    it('should handle carriage returns and progress updates', () => {
      // Simulate progress bar updates
      capture.capture('task-progress', 'stdout', 'Progress: 0%\r');
      capture.capture('task-progress', 'stdout', 'Progress: 50%\r');
      capture.capture('task-progress', 'stdout', 'Progress: 100%\n');

      const output = capture.getOutput('task-progress');
      if (output.ok) {
        // Should capture all updates
        expect(output.value.stdout.join('')).toContain('100%');
      }
    });

    it('should handle binary-like output', () => {
      // Simulate binary data in output
      const binaryLike = Buffer.from([0x00, 0x01, 0x02, 0xff]).toString();
      capture.capture('task-binary', 'stdout', binaryLike);

      const output = capture.getOutput('task-binary');
      expect(output.ok).toBe(true);
      // Should handle without crashing
    });

    it('should handle streaming output pattern', () => {
      // Simulate streaming chunks
      const chunks = ['Starting', ' processing', '...', 'done!'];

      chunks.forEach((chunk) => {
        capture.capture('task-stream', 'stdout', chunk);
      });

      const output = capture.getOutput('task-stream');
      if (output.ok) {
        expect(output.value.stdout).toEqual(['Starting', ' processing', '...', 'done!']);
      }
    });

    it('should handle interleaved stdout/stderr', () => {
      // Simulate real process output pattern
      capture.capture('task-interleaved', 'stdout', 'Starting task');
      capture.capture('task-interleaved', 'stderr', 'Warning: deprecated option');
      capture.capture('task-interleaved', 'stdout', 'Processing...');
      capture.capture('task-interleaved', 'stderr', 'Error: minor issue');
      capture.capture('task-interleaved', 'stdout', 'Completed successfully');

      const output = capture.getOutput('task-interleaved');
      if (output.ok) {
        expect(output.value.stdout).toHaveLength(3);
        expect(output.value.stderr).toHaveLength(2);
        expect(output.value.stdout[2]).toBe('Completed successfully');
      }
    });

    it('should handle empty strings', () => {
      capture.capture('task-empty', 'stdout', '');
      capture.capture('task-empty', 'stdout', 'not empty');
      capture.capture('task-empty', 'stdout', '');

      const output = capture.getOutput('task-empty');
      if (output.ok) {
        expect(output.value.stdout).toEqual(['', 'not empty', '']);
      }
    });
  });

  describe('EventBus integration', () => {
    it('should handle EventBus errors gracefully', async () => {
      // Make EventBus emit reject
      const originalEmit = mockEventBus.emit;
      mockEventBus.emit = async () => {
        return { ok: false, error: new Error('EventBus error') };
      };

      // Should still capture successfully
      const result = capture.capture('task-eb-error', 'stdout', 'test');
      expect(result.ok).toBe(true);

      // Output should still be captured
      const output = capture.getOutput('task-eb-error');
      if (output.ok) {
        expect(output.value.stdout).toEqual(['test']);
      }
    });

    it('should work without EventBus', () => {
      // Create capture without EventBus
      const captureNoEB = new BufferedOutputCapture(1024);

      const result = captureNoEB.capture('task-no-eb', 'stdout', 'test');
      expect(result.ok).toBe(true);

      const output = captureNoEB.getOutput('task-no-eb');
      if (output.ok) {
        expect(output.value.stdout).toEqual(['test']);
      }
    });
  });
});
