/**
 * ProxiedClaudeAdapter — Claude adapter that routes API calls through
 * the local translation proxy instead of directly to Anthropic.
 *
 * ARCHITECTURE: Extends ClaudeAdapter and overrides resolveBaseUrl() to
 * inject the translation proxy URL (http://127.0.0.1:<port>) as the
 * ANTHROPIC_BASE_URL for spawned Claude Code processes.
 *
 * This causes Claude Code to send Anthropic Messages API requests to the
 * local proxy, which translates them to OpenAI Chat Completions and
 * forwards to the configured backend.
 *
 * Integration points:
 * - ProxyManager.start() returns the port → pass to constructor
 * - Bootstrap creates ProxiedClaudeAdapter when ProxyManager is active
 * - Replaces ClaudeAdapter in AgentRegistry when proxy is configured
 *
 * DECISION: Constructor-injected port (not dynamic resolution).
 * Rationale: The proxy port is stable for the process lifetime once started.
 * No need for runtime resolution — simpler and more testable.
 */

import type { AgentConfig, Configuration } from '../../core/configuration.js';
import { ClaudeAdapter } from '../../implementations/claude-adapter.js';

/**
 * Claude adapter that routes through a local translation proxy.
 *
 * Identical to ClaudeAdapter in all respects EXCEPT that resolveBaseUrl()
 * always returns the proxy URL instead of reading from config/env.
 */
export class ProxiedClaudeAdapter extends ClaudeAdapter {
  private readonly proxyPort: number;

  constructor(config: Configuration, proxyPort: number, claudeCommand = 'claude') {
    super(config, claudeCommand);
    this.proxyPort = proxyPort;
  }

  /**
   * Override: always return proxy URL regardless of user env or config.
   *
   * DECISION: Proxy URL takes absolute precedence. If the user has
   * ANTHROPIC_BASE_URL in their environment, it would conflict with the
   * proxy — we must override it. The parent env has already been cleaned
   * (CLAUDE_CODE_* stripped) before this method is called, but
   * ANTHROPIC_BASE_URL passes through cleanEnv, so we must set it here
   * to override whatever came through.
   *
   * Also injects CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS=1 (same as parent)
   * to prevent proxy failures from experimental beta headers.
   */
  protected override resolveBaseUrl(_agentConfig: AgentConfig): Record<string, string> {
    return {
      ANTHROPIC_BASE_URL: `http://127.0.0.1:${this.proxyPort}`,
      CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS: '1',
    };
  }
}
