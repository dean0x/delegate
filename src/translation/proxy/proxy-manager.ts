/**
 * ProxyManager — lifecycle management of TranslationProxy instances.
 *
 * ARCHITECTURE: ProxyManager creates, starts, and stops a TranslationProxy
 * for the claude agent provider. It is the integration point between Autobeat's
 * bootstrap/DI system and the translation proxy infrastructure.
 *
 * Usage:
 * 1. Create ProxyManager with ProxyConfig
 * 2. Call start() — returns the local port the proxy listens on
 * 3. Pass proxyUrl to ProxiedClaudeAdapter via ANTHROPIC_BASE_URL
 * 4. Call stop() on shutdown
 *
 * Configuration: When an agent has `proxy` set (e.g. 'openai'), the existing
 * `baseUrl`, `apiKey`, and `model` fields become the target backend config.
 * loadProxyConfig() returns null when proxy is not set.
 *
 * DECISION: One ProxyManager per agent provider. Currently only 'claude' is
 * supported (Anthropic Messages API ↔ OpenAI Chat Completions). Codex/Gemini
 * use their own API formats and do not need translation.
 */

import type { AgentProvider } from '../../core/agents.js';
import { type AgentConfig, loadAgentConfig } from '../../core/configuration.js';
import type { Logger } from '../../core/interfaces.js';
import { err, ok, type Result } from '../../core/result.js';
import { AnthropicCodec } from '../codecs/anthropic-codec.js';
import { OpenAICodec } from '../codecs/openai-codec.js';
import { LoggingMiddleware } from '../middleware/logging.js';
import { PromptCacheMiddleware, type PromptCacheState } from '../middleware/prompt-cache.js';
import { ToolNameMappingMiddleware } from '../middleware/tool-name-mapping.js';
import { TranslationProxy } from './translation-proxy.js';

/**
 * Target backend configuration for the translation proxy.
 * Derived from AgentConfig fields when `translate` is set.
 */
export interface ProxyConfig {
  /** Base URL of the OpenAI-compatible backend, e.g. "https://integrate.api.nvidia.com/v1" */
  readonly targetBaseUrl: string;
  /** API key for the target backend */
  readonly targetApiKey: string;
  /** Model to use on the target backend, e.g. "moonshotai/kimi-k2-thinking" */
  readonly targetModel: string;
}

/**
 * Load proxy configuration from AgentConfig when `translate` is set.
 *
 * ARCHITECTURE: When an agent has `proxy: 'openai'`, the existing `baseUrl`,
 * `apiKey`, and `model` fields become the target backend config. This means users
 * configure the translation proxy with the same commands they'd use for any agent:
 *   beat agents config set claude proxy openai
 *   beat agents config set claude baseUrl https://integrate.api.nvidia.com/v1
 *   beat agents config set claude apiKey nvapi-...
 *   beat agents config set claude model moonshotai/kimi-k2-thinking
 *
 * Returns null when: proxy is not set or required fields (baseUrl, apiKey, model) are missing.
 *
 * @param provider - Agent provider key (currently only 'claude' is supported)
 */
export function loadProxyConfig(provider: AgentProvider): ProxyConfig | null {
  // Only claude supports translation (Anthropic → OpenAI)
  if (provider !== 'claude') return null;

  const agentConfig: AgentConfig = loadAgentConfig(provider);
  if (!agentConfig.proxy) return null;

  // proxy requires baseUrl, apiKey, and model
  if (!agentConfig.baseUrl || !agentConfig.apiKey || !agentConfig.model) return null;

  return {
    targetBaseUrl: agentConfig.baseUrl,
    targetApiKey: agentConfig.apiKey,
    targetModel: agentConfig.model,
  };
}

/**
 * ProxyManager — owns the lifecycle of a TranslationProxy.
 *
 * ARCHITECTURE: Singleton-like per agent provider. Created once at bootstrap
 * (if proxy config exists), kept alive for the process lifetime, stopped on
 * graceful shutdown.
 *
 * Pattern: Lifecycle manager — stateful, start/stop interface.
 * Testing: Accepts Logger via DI; uses real TranslationProxy (loopback-only).
 */
export class ProxyManager {
  private proxy: TranslationProxy | null = null;
  private port: number | undefined;

  constructor(
    private readonly config: ProxyConfig,
    private readonly logger: Logger,
  ) {}

  /**
   * Return the proxy URL if the proxy is running, undefined otherwise.
   * Format: "http://127.0.0.1:<port>"
   */
  get proxyUrl(): string | undefined {
    if (this.port === undefined) return undefined;
    return `http://127.0.0.1:${this.port}`;
  }

  /**
   * Start the translation proxy.
   *
   * Idempotent: if already started, returns the existing port immediately.
   * Binds to 127.0.0.1:0 (OS-assigned port) for security.
   *
   * @returns Result with port and proxyUrl on success
   */
  async start(): Promise<Result<{ port: number; proxyUrl: string }>> {
    // Idempotent: already running
    if (this.proxy !== null && this.port !== undefined) {
      const url = `http://127.0.0.1:${this.port}`;
      return ok({ port: this.port, proxyUrl: url });
    }

    const proxyLogger = this.logger.child({ module: 'TranslationProxy' });

    const promptCacheState: PromptCacheState = { lastPrefixHash: null };

    const proxy = new TranslationProxy({
      targetBaseUrl: this.config.targetBaseUrl,
      targetApiKey: this.config.targetApiKey,
      targetModel: this.config.targetModel,
      sourceCodec: new AnthropicCodec(),
      targetCodec: new OpenAICodec(),
      // ARCHITECTURE: Factory produces fresh middleware instances per request so
      // concurrent requests do not share mutable per-request state (see middlewareFactory
      // DECISION comment in TranslationProxyConfig). PromptCacheMiddleware receives a
      // shared PromptCacheState for cross-request cache tracking.
      middlewareFactory: () => [
        new ToolNameMappingMiddleware(),
        new PromptCacheMiddleware(promptCacheState),
        new LoggingMiddleware(proxyLogger),
      ],
      logger: proxyLogger,
    });

    const startResult = await proxy.start();
    if (!startResult.ok) {
      return err(startResult.error);
    }

    this.proxy = proxy;
    this.port = startResult.value.port;
    const url = `http://127.0.0.1:${this.port}`;

    this.logger.info('Translation proxy started', {
      port: this.port,
      targetBaseUrl: this.config.targetBaseUrl,
      targetModel: this.config.targetModel,
    });

    return ok({ port: this.port, proxyUrl: url });
  }

  /**
   * Stop the translation proxy.
   * Idempotent: safe to call multiple times or if never started.
   */
  async stop(): Promise<void> {
    if (this.proxy === null) return;

    const proxy = this.proxy;
    this.proxy = null;
    this.port = undefined;

    await proxy.stop();
    this.logger.info('Translation proxy stopped');
  }
}
