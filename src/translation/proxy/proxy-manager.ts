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
 * Configuration: Reads from agents.<provider>.proxy section in config.json.
 * If not present, loadProxyConfig() returns null and no proxy is created.
 *
 * DECISION: One ProxyManager per agent provider. Currently only 'claude' is
 * supported (Anthropic Messages API ↔ OpenAI Chat Completions). Codex/Gemini
 * use their own API formats and do not need translation.
 */

import { loadConfigFile } from '../../core/configuration.js';
import type { Logger } from '../../core/interfaces.js';
import { err, ok, type Result } from '../../core/result.js';
import { AnthropicCodec } from '../codecs/anthropic-codec.js';
import { OpenAICodec } from '../codecs/openai-codec.js';
import { LoggingMiddleware } from '../middleware/logging.js';
import { PromptCacheMiddleware } from '../middleware/prompt-cache.js';
import { ToolNameMappingMiddleware } from '../middleware/tool-name-mapping.js';
import { TranslationProxy } from './translation-proxy.js';

/**
 * Target backend configuration for the translation proxy.
 * Loaded from agents.<provider>.proxy section in config.json.
 */
export interface ProxyConfig {
  /** Base URL of the OpenAI-compatible backend, e.g. "https://api.openai.com" */
  readonly targetBaseUrl: string;
  /** API key for the target backend */
  readonly targetApiKey: string;
  /** Model to use on the target backend, e.g. "gpt-4o" */
  readonly targetModel: string;
}

/**
 * Load proxy configuration from agents.<provider>.proxy in config.json.
 *
 * ARCHITECTURE: Delegates to loadConfigFile() (same loader used by AgentConfig)
 * to avoid a separate config read. Returns null if no proxy section exists —
 * callers use this as the gate to decide whether to create a ProxyManager.
 *
 * @param provider - Agent provider key (currently only 'claude' is used)
 */
export function loadProxyConfig(provider: string): ProxyConfig | null {
  const file = loadConfigFile();
  const agents = file.agents;
  if (!agents || typeof agents !== 'object' || Array.isArray(agents)) return null;
  const section = (agents as Record<string, unknown>)[provider];
  if (!section || typeof section !== 'object' || Array.isArray(section)) return null;
  const record = section as Record<string, unknown>;
  const proxy = record.proxy;
  if (!proxy || typeof proxy !== 'object' || Array.isArray(proxy)) return null;
  const p = proxy as Record<string, unknown>;
  const targetBaseUrl = typeof p.targetBaseUrl === 'string' ? p.targetBaseUrl : undefined;
  const targetApiKey = typeof p.targetApiKey === 'string' ? p.targetApiKey : undefined;
  const targetModel = typeof p.targetModel === 'string' ? p.targetModel : undefined;
  if (!targetBaseUrl || !targetApiKey || !targetModel) return null;
  return { targetBaseUrl, targetApiKey, targetModel };
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

    // Build middleware stack: tool name mapping, prompt cache metrics, logging
    const middlewares = [
      new ToolNameMappingMiddleware(),
      new PromptCacheMiddleware(),
      new LoggingMiddleware(proxyLogger),
    ];

    const proxy = new TranslationProxy({
      targetBaseUrl: this.config.targetBaseUrl,
      targetApiKey: this.config.targetApiKey,
      targetModel: this.config.targetModel,
      sourceCodec: new AnthropicCodec(),
      targetCodec: new OpenAICodec(),
      middlewares,
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
