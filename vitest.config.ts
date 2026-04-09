import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    setupFiles: ['./tests/setup.ts'], // Global test setup for cleanup
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      exclude: [
        'node_modules/',
        'dist/',
        '**/*.test.ts',
        '**/*.spec.ts',
        '**/index.ts',
        'vitest.config.ts',
        'tests/**/*'
      ]
    },
    testTimeout: 30000, // Increased for integration tests
    hookTimeout: 30000,
    include: [
      'src/**/*.test.{ts,tsx}',
      'tests/**/*.test.{ts,tsx}'
    ],
    exclude: [
      'node_modules',
      'dist',
      '.git'
    ],
    pool: 'threads', // Explicit: v4 defaults to 'forks'
    maxWorkers: 1, // CRITICAL: Single worker to prevent resource exhaustion
    // CRITICAL: Restart workers when they exceed 1GB to prevent memory accumulation
    // This fixes "Channel closed" errors from worker crashes
    vmMemoryLimit: '1024MB',
    // CRITICAL: Run ALL tests sequentially to prevent crashes
    sequence: {
      concurrent: false,
      shuffle: false
    },
    // CRITICAL: Disable parallel test execution within files
    fileParallelism: false,
    // Disable isolation for better performance with singleThread
    // Safe because we're running sequentially in single thread
    isolate: false
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src')
    }
  }
});