/**
 * Google Gemini CLI agent adapter implementation
 *
 * ARCHITECTURE: Gemini-specific CLI flags on top of BaseAgentAdapter.
 * Uses --prompt for non-interactive (headless) mode and --yolo for auto-accept.
 */

import { existsSync, mkdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'fs';
import os from 'os';
import path from 'path';
import { AgentProvider } from '../core/agents.js';
import { Configuration } from '../core/configuration.js';
import { BaseAgentAdapter } from './base-agent-adapter.js';

const MAX_COMBINED_PROMPT_BYTES = 64 * 1024; // 64 KB — guard against OOM from corrupt/large cache
const STALENESS_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

/**
 * DECISION: Extracted from GeminiAdapter so getSystemPromptConfig remains a thin
 * declarative method like Claude/Codex adapters. This class owns all filesystem
 * I/O for the Gemini base prompt cache — reading, staleness checks, combining,
 * writing combined files, and cleanup.
 */
export class GeminiBasePromptCache {
  #cached: string | null = null;
  readonly #cacheDir: string;

  constructor(cacheDir = path.join(os.homedir(), '.autobeat', 'system-prompts')) {
    this.#cacheDir = cacheDir;
    mkdirSync(this.#cacheDir, { recursive: true, mode: 0o700 });
  }

  /**
   * Build a combined system prompt file from the cached base + user system prompt.
   * Returns the path to write into GEMINI_SYSTEM_MD, or null if fallback-to-prepend
   * should be used instead.
   */
  buildCombinedFile(systemPrompt: string, outputPath: string): string | null {
    this.#ensureCacheLoaded();

    if (this.#cached === null) {
      this.#warn(
        'no gemini-base.md cache found, falling back to prompt prepend. Run `beat agents refresh-base-prompt gemini` to enable GEMINI_SYSTEM_MD injection.',
      );
      return null;
    }

    const combined = `${this.#cached}\n\n${systemPrompt}`;
    const combinedBytes = Buffer.byteLength(combined, 'utf8');

    if (combinedBytes > MAX_COMBINED_PROMPT_BYTES) {
      this.#warn(`combined prompt exceeds ${MAX_COMBINED_PROMPT_BYTES} bytes, falling back to prompt prepend`, {
        combinedBytes,
      });
      return null;
    }

    writeFileSync(outputPath, combined, { encoding: 'utf8', mode: 0o600 });
    return outputPath;
  }

  /** Remove a task-scoped temp file. Non-fatal if the file doesn't exist. */
  cleanupTaskFile(taskId: string): void {
    // Path-traversal guard: resolve before deleting
    // (pattern reused from orchestration-manager.ts:isWithinStateDir)
    const resolvedCacheDir = path.resolve(this.#cacheDir);
    const filePath = path.resolve(path.join(this.#cacheDir, `${taskId}.md`));
    if (!filePath.startsWith(resolvedCacheDir + path.sep)) return;
    try {
      unlinkSync(filePath);
    } catch {
      // File may not exist (task had no system prompt, or prependToPrompt fallback was used)
    }
  }

  /** Invalidate the in-memory cache so the next buildCombinedFile re-reads from disk. */
  invalidate(): void {
    this.#cached = null;
  }

  #ensureCacheLoaded(): void {
    if (this.#cached !== null) return;

    const baseCachePath = path.join(this.#cacheDir, 'gemini-base.md');
    if (!existsSync(baseCachePath)) return;

    try {
      const stat = statSync(baseCachePath);
      const ageMs = Date.now() - stat.mtimeMs;
      if (ageMs > STALENESS_MS) {
        this.#warn(
          'gemini-base.md cache is older than 30 days — run `beat agents refresh-base-prompt gemini` to refresh',
          { ageMs },
        );
        // Do not cache stale content — force re-read after user refreshes
        return;
      }
      this.#cached = readFileSync(baseCachePath, 'utf8');
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      this.#warn('failed to read gemini-base.md cache, falling back to prompt prepend', { error: msg });
    }
  }

  #warn(message: string, extra?: Record<string, unknown>): void {
    console.error(JSON.stringify({ level: 'warn', message: `gemini-adapter: ${message}`, ...extra }));
  }
}

export class GeminiAdapter extends BaseAgentAdapter {
  readonly provider: AgentProvider = 'gemini';
  readonly #cache: GeminiBasePromptCache;

  constructor(config: Configuration, geminiCommand = 'gemini', cache?: GeminiBasePromptCache) {
    super(config, geminiCommand);
    this.#cache = cache ?? new GeminiBasePromptCache();
  }

  // jsonSchema parameter accepted but ignored — Gemini CLI does not support structured output
  protected buildArgs(prompt: string, model?: string, _jsonSchema?: string): readonly string[] {
    const modelArgs: string[] = model ? ['--model', model] : [];
    return ['--yolo', ...modelArgs, '--prompt', prompt];
  }

  protected get additionalEnv(): Record<string, string> {
    // --yolo enables Docker sandbox by default; disable it so Docker/Podman isn't required.
    // Users who want sandbox can set GEMINI_SANDBOX=true in their environment.
    return { GEMINI_SANDBOX: 'false' };
  }

  protected get envPrefixesToStrip(): readonly string[] {
    // ARCHITECTURE: No known Gemini CLI nesting indicators.
    // IMPORTANT: Must NOT strip GEMINI_API_KEY — required for authentication.
    return [];
  }

  /**
   * DECISION: GEMINI_SYSTEM_MD replaces the entire built-in system prompt.
   * To simulate "append": read the cached base prompt, combine with user's system prompt,
   * write the combined content to systemPromptPath, then set GEMINI_SYSTEM_MD.
   * Fallback: prepend to user prompt if cache unavailable.
   */
  protected getSystemPromptConfig(
    systemPrompt: string,
    systemPromptPath: string,
  ): { args: readonly string[]; env: Record<string, string>; prependToPrompt: boolean } {
    const result = this.#cache.buildCombinedFile(systemPrompt, systemPromptPath);
    if (result !== null) {
      return { args: [], env: { GEMINI_SYSTEM_MD: result }, prependToPrompt: false };
    }
    return { args: [], env: {}, prependToPrompt: true };
  }

  /**
   * Remove the task-scoped temp file written by getSystemPromptConfig.
   * Called by the worker pool after the worker process exits.
   */
  override cleanup(taskId: string): void {
    this.#cache.cleanupTaskFile(taskId);
  }
}
