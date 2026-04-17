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

export class GeminiAdapter extends BaseAgentAdapter {
  readonly provider: AgentProvider = 'gemini';

  /**
   * In-memory cache for the Gemini base prompt.
   * Populated on first successful read, cleared only when the cache file is found stale or missing.
   * This avoids synchronous disk I/O on every spawn (perf-1).
   */
  #basePromptCache: string | null = null;

  constructor(config: Configuration, geminiCommand = 'gemini') {
    super(config, geminiCommand);
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
   *
   * Cache strategy: ~/.autobeat/system-prompts/gemini-base.md populated on first use
   * via GEMINI_WRITE_SYSTEM_MD env var. Staleness advisory after 30 days.
   *
   * Fallback: If the base cache cannot be read or populated, prependToPrompt=true
   * is returned so the base class prepends the system prompt to the user prompt.
   * This avoids losing the user's system prompt at the cost of reduced effectiveness.
   */
  protected getSystemPromptConfig(
    systemPrompt: string,
    systemPromptPath: string,
  ): { args: readonly string[]; env: Record<string, string>; prependToPrompt: boolean } {
    const cacheDir = path.join(os.homedir(), '.autobeat', 'system-prompts');
    const baseCachePath = path.join(cacheDir, 'gemini-base.md');
    const STALENESS_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

    // Attempt to populate in-memory cache from disk (only if not already loaded)
    if (this.#basePromptCache === null && existsSync(baseCachePath)) {
      try {
        const stat = statSync(baseCachePath);
        const ageMs = Date.now() - stat.mtimeMs;
        if (ageMs > STALENESS_MS) {
          console.error(
            JSON.stringify({
              level: 'warn',
              message:
                'gemini-adapter: gemini-base.md cache is older than 30 days — run `beat agents refresh-base-prompt gemini` to refresh',
              ageMs,
            }),
          );
          // Do not cache stale content — force re-read on next spawn after user refreshes
        } else {
          this.#basePromptCache = readFileSync(baseCachePath, 'utf8');
        }
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        console.error(
          JSON.stringify({
            level: 'warn',
            message: 'gemini-adapter: failed to read gemini-base.md cache, falling back to prompt prepend',
            error: msg,
          }),
        );
        return { args: [], env: {}, prependToPrompt: true };
      }
    }

    if (this.#basePromptCache !== null) {
      const combined = `${this.#basePromptCache}\n\n${systemPrompt}`;

      // Guard against OOM: fall back to prompt prepend if combined content exceeds limit
      if (Buffer.byteLength(combined, 'utf8') > MAX_COMBINED_PROMPT_BYTES) {
        console.error(
          JSON.stringify({
            level: 'warn',
            message: `gemini-adapter: combined prompt exceeds ${MAX_COMBINED_PROMPT_BYTES} bytes, falling back to prompt prepend`,
            combinedBytes: Buffer.byteLength(combined, 'utf8'),
          }),
        );
        return { args: [], env: {}, prependToPrompt: true };
      }

      // Write combined prompt file with secure permissions and inject via GEMINI_SYSTEM_MD
      mkdirSync(cacheDir, { recursive: true, mode: 0o700 });
      writeFileSync(systemPromptPath, combined, { encoding: 'utf8', mode: 0o600 });

      return {
        args: [],
        env: { GEMINI_SYSTEM_MD: systemPromptPath },
        prependToPrompt: false,
      };
    }

    // No cache — fallback to prompt prepend with warning
    console.error(
      JSON.stringify({
        level: 'warn',
        message:
          'gemini-adapter: no gemini-base.md cache found, falling back to prompt prepend. Run `beat agents refresh-base-prompt gemini` to enable GEMINI_SYSTEM_MD injection.',
      }),
    );
    return { args: [], env: {}, prependToPrompt: true };
  }

  /**
   * Remove the task-scoped temp file written by getSystemPromptConfig.
   * Called by the worker pool after the worker process exits.
   * Non-fatal: file may not exist if Gemini fell back to prependToPrompt.
   */
  override cleanup(taskId: string): void {
    const systemPromptPath = path.join(os.homedir(), '.autobeat', 'system-prompts', `${taskId}.md`);
    try {
      unlinkSync(systemPromptPath);
    } catch {
      // File may not exist (task had no system prompt, or prependToPrompt fallback was used)
    }
  }
}
