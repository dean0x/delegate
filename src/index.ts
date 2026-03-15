#!/usr/bin/env node
/**
 * Backbeat MCP Server - New Architecture
 * Main entry point with autoscaling
 */

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import pkg from '../package.json' with { type: 'json' };
import { MCPAdapter } from './adapters/mcp-adapter.js';
import { bootstrap } from './bootstrap.js';
import { Container } from './core/container.js';
import { Logger, WorkerPool } from './core/interfaces.js';

// Handle errors gracefully
process.on('uncaughtException', (error) => {
  console.error('Uncaught exception:', error);
  process.exit(1);
});

process.on('unhandledRejection', (error) => {
  console.error('Unhandled rejection:', error);
  process.exit(1);
});

async function main() {
  // Set process title for easy identification in ps/pgrep/pkill
  process.title = 'beat-mcp';

  let container: Container | null = null;

  try {
    // Bootstrap application
    const containerResult = await bootstrap();
    if (!containerResult.ok) {
      console.error('Bootstrap failed:', containerResult.error.message);
      process.exit(1);
    }
    container = containerResult.value;

    // Resolve services (async factories require resolve())
    const loggerResult = await container.resolve<Logger>('logger');
    const mcpAdapterResult = await container.resolve<MCPAdapter>('mcpAdapter');

    if (!loggerResult.ok || !mcpAdapterResult.ok) {
      console.error('Failed to resolve required services:');
      if (!loggerResult.ok) console.error('  logger:', loggerResult.error.message);
      if (!mcpAdapterResult.ok) console.error('  mcpAdapter:', mcpAdapterResult.error.message);
      process.exit(1);
    }

    const logger = loggerResult.value;
    const mcpAdapter = mcpAdapterResult.value;

    // All logs go to stderr to keep stdout clean for MCP protocol
    logger.info(`Starting Backbeat MCP Server v${pkg.version}`);

    // Create and start MCP server
    const transport = new StdioServerTransport();
    const server = mcpAdapter.getServer();

    await server.connect(transport);
    logger.info('MCP server connected');

    // Handle shutdown gracefully
    const shutdown = async (signal: string) => {
      logger.info(`Received ${signal}, shutting down gracefully`);

      // Stop schedule executor before killing workers
      const scheduleExecutorResult = container?.get('scheduleExecutor');
      if (scheduleExecutorResult?.ok) {
        const executor = scheduleExecutorResult.value as { stop(): unknown };
        executor.stop();
      }

      // Kill all workers
      const workerPoolResult = container?.get('workerPool');
      if (workerPoolResult?.ok) {
        await (workerPoolResult.value as WorkerPool).killAll();
      }

      // Close server
      await server.close();

      logger.info('Shutdown complete');
      process.exit(0);
    };

    process.on('SIGINT', () => shutdown('SIGINT'));
    process.on('SIGTERM', () => shutdown('SIGTERM'));

    // Log ready state
    logger.info('Backbeat is ready', {
      cpuThreshold: process.env.CPU_THRESHOLD || '80',
      memoryReserve: process.env.MEMORY_RESERVE || '1GB',
    });

    // Keep process alive
    process.stdin.resume();
  } catch (error) {
    console.error('Failed to start server:', error);
    process.exit(1);
  }
}

// Run if this is the main module
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error('Fatal error:', error);
    process.exit(1);
  });
}

export { main };
