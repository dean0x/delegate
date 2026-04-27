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
import type { Result } from '../../core/result.js';
import { ok } from '../../core/result.js';
import { ClaudeAdapter } from '../../implementations/claude-adapter.js';

/**
 * Claude adapter that routes through a local translation proxy.
 *
 * Overrides three resolution methods to isolate Claude Code from backend config:
 * - resolveBaseUrl() → proxy URL (not the real backend)
 * - resolveModel() → suppresses backend model (proxy handles mapping)
 * - resolveAuth() → suppresses backend API key (proxy handles auth)
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

  /**
   * Override: suppress config model — the proxy handles model mapping.
   *
   * DECISION: agentConfig.model holds the target backend model (e.g.
   * "deepseek-ai/deepseek-r1") which Claude Code would reject client-side.
   * The translation proxy already overrides the model at the protocol level
   * (TranslationProxy.handleMessages), so Claude Code should use its default
   * model. Per-task model overrides are still honored.
   */
  protected override resolveModel(_agentConfig: AgentConfig, taskModel?: string): string | undefined {
    return taskModel;
  }

  /**
   * Override: suppress backend API key injection — the proxy handles auth.
   *
   * DECISION: agentConfig.apiKey holds the backend key (e.g. "nvapi-...")
   * which would be injected as ANTHROPIC_API_KEY and confuse Claude Code.
   * The proxy already strips inbound x-api-key and injects the backend key
   * as Authorization: Bearer. Claude Code should use its own login-based
   * auth (or the parent env's ANTHROPIC_API_KEY if set).
   */
  protected override resolveAuth(_agentConfig: AgentConfig): Result<{ injectedEnv: Record<string, string> }> {
    return ok({ injectedEnv: {} });
  }
}
