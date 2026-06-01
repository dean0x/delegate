/**
 * Integration tests for autobeat-stop-hook.sh
 *
 * ARCHITECTURE: Uses real filesystem operations and real bash execution.
 * No tmux required — the script falls back to AUTOBEAT_TASK_ID env var
 * when tmux is unavailable (tmux show-environment silently fails).
 *
 * Coverage:
 * - Bash syntax check
 * - Guard behavior (AUTOBEAT_WORKER not set / false)
 * - Codex path (last_assistant_message in stdin JSON)
 * - Claude path (transcript_path JSONL)
 * - isOutputMessage contract validation
 * - Special characters in response content
 * - Sequence numbering across multiple invocations
 * - stop_reason → sentinel mapping
 * - Security: path traversal in task ID and sessions dir
 * - Atomic write (no .tmp files persist)
 * - Fail-fast: empty response → .exit sentinel
 */

import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

// ============================================================================
// Test Infrastructure
// ============================================================================

// NOTE: Shared mutable tmpDir with afterEach cleanup — safe because vitest runs
// with maxWorkers: 1 (sequential execution, see vitest.config.ts). Tests must
// not run in parallel or afterEach cleanup could race a concurrent test's reads.
let tmpDir = '';
const HOOK_SCRIPT = path.resolve(process.cwd(), 'scripts/autobeat-stop-hook.sh');

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'beat-stop-hook-'));
});

afterAll(() => {
  if (tmpDir) {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
});

afterEach(() => {
  // Clean up per-test task dirs inside tmpDir between tests
  try {
    const entries = fs.readdirSync(tmpDir);
    for (const entry of entries) {
      const full = path.join(tmpDir, entry);
      const stat = fs.statSync(full);
      if (stat.isDirectory()) {
        fs.rmSync(full, { recursive: true, force: true });
      } else {
        fs.unlinkSync(full);
      }
    }
  } catch {
    /* ignore */
  }
});

/**
 * Run the stop hook with the given stdin payload and environment.
 * Returns { status, stdout, stderr, taskDir }.
 */
function runHook(
  stdinPayload: string,
  taskId: string,
  sessionsDir: string,
  extraEnv: Record<string, string> = {},
): { status: number; stdout: string; stderr: string; taskDir: string } {
  const env: Record<string, string> = {
    ...Object.fromEntries(Object.entries(process.env).filter(([, v]) => v !== undefined) as [string, string][]),
    AUTOBEAT_WORKER: 'true',
    AUTOBEAT_TASK_ID: taskId,
    AUTOBEAT_SESSIONS_DIR: sessionsDir,
    // Prevent tmux lookup from interfering — it will fail and fall back to env var
    ...extraEnv,
  };

  const result = spawnSync('bash', [HOOK_SCRIPT], {
    input: stdinPayload,
    encoding: 'utf8',
    env,
  });

  return {
    status: result.status ?? 1,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    taskDir: path.join(sessionsDir, taskId),
  };
}

/**
 * Build a Codex-style hook payload (last_assistant_message field).
 */
function codexPayload(response: string, stopReason = 'end_turn'): string {
  return JSON.stringify({
    last_assistant_message: response,
    stop_reason: stopReason,
  });
}

/**
 * Build a Claude Code hook payload with usage fields.
 * Models the Stop hook stdin format from Claude Code (includes usage + total_cost_usd).
 */
function claudeCodePayload(
  response: string,
  usage: {
    input_tokens: number;
    output_tokens: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
  },
  totalCostUsd: number,
  stopReason = 'end_turn',
): string {
  return JSON.stringify({
    last_assistant_message: response,
    stop_reason: stopReason,
    usage,
    total_cost_usd: totalCostUsd,
  });
}

/**
 * Build a Claude-style hook payload (transcript_path field).
 * Writes the JSONL transcript to disk and returns the payload JSON.
 */
function claudePayload(transcriptPath: string, assistantText: string, stopReason = 'end_turn'): string {
  // Write a minimal transcript JSONL with one assistant message
  const lines = [
    JSON.stringify({ role: 'user', message: { content: 'do something' } }),
    JSON.stringify({
      role: 'assistant',
      message: { content: [{ type: 'text', text: assistantText }] },
    }),
  ];
  fs.writeFileSync(transcriptPath, lines.join('\n') + '\n');

  return JSON.stringify({
    transcript_path: transcriptPath,
    stop_reason: stopReason,
  });
}

/**
 * Read and parse the first message file in messages/ directory.
 */
function readFirstMessage(taskDir: string): Record<string, unknown> {
  const messagesDir = path.join(taskDir, 'messages');
  const files = fs.readdirSync(messagesDir).sort();
  expect(files.length).toBeGreaterThan(0);
  const content = fs.readFileSync(path.join(messagesDir, files[0]!), 'utf8');
  return JSON.parse(content) as Record<string, unknown>;
}

/**
 * Read all message files, sorted by name.
 */
function readAllMessages(taskDir: string): Record<string, unknown>[] {
  const messagesDir = path.join(taskDir, 'messages');
  const files = fs.readdirSync(messagesDir).sort();
  return files.map((f) => {
    const content = fs.readFileSync(path.join(messagesDir, f), 'utf8');
    return JSON.parse(content) as Record<string, unknown>;
  });
}

// ============================================================================
// Bash Syntax Check
// ============================================================================

describe('stop-hook: syntax', () => {
  it('passes bash -n syntax check', () => {
    const result = spawnSync('bash', ['-n', HOOK_SCRIPT], { encoding: 'utf8' });
    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
  });
});

// ============================================================================
// Guard Behavior
// ============================================================================

describe('stop-hook: guard behavior', () => {
  it('exits 0 without AUTOBEAT_WORKER set — no files created', () => {
    const sessionsDir = path.join(tmpDir, 'guard-no-worker');
    fs.mkdirSync(sessionsDir, { recursive: true });

    const result = spawnSync('bash', [HOOK_SCRIPT], {
      input: codexPayload('hello'),
      encoding: 'utf8',
      env: {
        ...Object.fromEntries(Object.entries(process.env).filter(([, v]) => v !== undefined) as [string, string][]),
        AUTOBEAT_TASK_ID: 'task-abc',
        AUTOBEAT_SESSIONS_DIR: sessionsDir,
        // AUTOBEAT_WORKER intentionally absent
      },
    });

    expect(result.status).toBe(0);
    // No task directory should be created
    expect(fs.existsSync(path.join(sessionsDir, 'task-abc'))).toBe(false);
  });

  it('exits 0 when AUTOBEAT_WORKER=false — no files created', () => {
    const sessionsDir = path.join(tmpDir, 'guard-worker-false');
    fs.mkdirSync(sessionsDir, { recursive: true });

    const result = spawnSync('bash', [HOOK_SCRIPT], {
      input: codexPayload('hello'),
      encoding: 'utf8',
      env: {
        ...Object.fromEntries(Object.entries(process.env).filter(([, v]) => v !== undefined) as [string, string][]),
        AUTOBEAT_WORKER: 'false',
        AUTOBEAT_TASK_ID: 'task-abc',
        AUTOBEAT_SESSIONS_DIR: sessionsDir,
      },
    });

    expect(result.status).toBe(0);
    expect(fs.existsSync(path.join(sessionsDir, 'task-abc'))).toBe(false);
  });
});

// ============================================================================
// Codex Path (last_assistant_message)
// ============================================================================

describe('stop-hook: Codex path', () => {
  it('writes message file and .done sentinel for last_assistant_message', () => {
    const sessionsDir = path.join(tmpDir, 'codex-basic');
    const taskId = 'task-codex-1';

    const { status, taskDir } = runHook(codexPayload('Task done successfully.'), taskId, sessionsDir);

    expect(status).toBe(0);
    expect(fs.existsSync(path.join(taskDir, '.done'))).toBe(true);
    expect(fs.existsSync(path.join(taskDir, '.exit'))).toBe(false);

    const msg = readFirstMessage(taskDir);
    expect(msg.type).toBe('result');
    expect(msg.content).toBe('Task done successfully.');
    expect(typeof msg.sequence).toBe('number');
    expect(typeof msg.timestamp).toBe('string');
  });

  it('prefers last_assistant_message over transcript_path', () => {
    const sessionsDir = path.join(tmpDir, 'codex-priority');
    const taskId = 'task-priority';
    const transcriptPath = path.join(tmpDir, 'transcript-priority.jsonl');

    // Write a transcript with different content
    const lines = [
      JSON.stringify({
        role: 'assistant',
        message: { content: [{ type: 'text', text: 'from transcript' }] },
      }),
    ];
    fs.writeFileSync(transcriptPath, lines.join('\n') + '\n');

    const payload = JSON.stringify({
      last_assistant_message: 'from codex field',
      transcript_path: transcriptPath,
      stop_reason: 'end_turn',
    });

    const { taskDir } = runHook(payload, taskId, sessionsDir);

    const msg = readFirstMessage(taskDir);
    expect(msg.content).toBe('from codex field');
  });
});

// ============================================================================
// Claude Path (transcript_path)
// ============================================================================

describe('stop-hook: Claude path', () => {
  it('writes message file and .done sentinel from transcript_path', () => {
    const sessionsDir = path.join(tmpDir, 'claude-basic');
    const taskId = 'task-claude-1';
    const transcriptPath = path.join(tmpDir, 'transcript-claude-1.jsonl');

    const payload = claudePayload(transcriptPath, 'Claude response here.');
    const { status, taskDir } = runHook(payload, taskId, sessionsDir);

    expect(status).toBe(0);
    expect(fs.existsSync(path.join(taskDir, '.done'))).toBe(true);

    const msg = readFirstMessage(taskDir);
    expect(msg.type).toBe('result');
    expect(msg.content).toBe('Claude response here.');
  });

  it('uses last assistant message from multi-turn transcript', () => {
    const sessionsDir = path.join(tmpDir, 'claude-multiturn');
    const taskId = 'task-claude-multi';
    const transcriptPath = path.join(tmpDir, 'transcript-multi.jsonl');

    const lines = [
      JSON.stringify({ role: 'user', message: { content: 'step 1' } }),
      JSON.stringify({
        role: 'assistant',
        message: { content: [{ type: 'text', text: 'intermediate response' }] },
      }),
      JSON.stringify({ role: 'user', message: { content: 'step 2' } }),
      JSON.stringify({
        role: 'assistant',
        message: { content: [{ type: 'text', text: 'final response' }] },
      }),
    ];
    fs.writeFileSync(transcriptPath, lines.join('\n') + '\n');

    const payload = JSON.stringify({
      transcript_path: transcriptPath,
      stop_reason: 'end_turn',
    });

    const { taskDir } = runHook(payload, taskId, sessionsDir);

    const msg = readFirstMessage(taskDir);
    expect(msg.content).toBe('final response');
  });
});

// ============================================================================
// isOutputMessage Contract
// ============================================================================

describe('stop-hook: isOutputMessage contract', () => {
  it('output matches isOutputMessage type guard contract', () => {
    const sessionsDir = path.join(tmpDir, 'contract');
    const taskId = 'task-contract';

    runHook(codexPayload('contract check'), taskId, sessionsDir);

    const msg = readFirstMessage(path.join(sessionsDir, taskId));

    // These are the exact fields checked by isOutputMessage in tmux-connector.ts:
    // typeof v.sequence === 'number'
    // typeof v.timestamp === 'string'
    // typeof v.type === 'string'
    // VALID_OUTPUT_TYPES.has(v.type)  — 'stdout' | 'stderr' | 'result'
    // typeof v.content === 'string'
    expect(typeof msg.sequence).toBe('number');
    expect(typeof msg.timestamp).toBe('string');
    expect(typeof msg.type).toBe('string');
    expect(['stdout', 'stderr', 'result']).toContain(msg.type);
    expect(typeof msg.content).toBe('string');
  });

  it('timestamp is ISO 8601 format', () => {
    const sessionsDir = path.join(tmpDir, 'contract-ts');
    const taskId = 'task-ts';

    runHook(codexPayload('ts check'), taskId, sessionsDir);

    const msg = readFirstMessage(path.join(sessionsDir, taskId));
    // ISO 8601: YYYY-MM-DDTHH:MM:SSZ
    expect(msg.timestamp as string).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
  });
});

// ============================================================================
// Special Characters
// ============================================================================

describe('stop-hook: special characters', () => {
  it('handles double quotes in response', () => {
    const sessionsDir = path.join(tmpDir, 'special-quotes');
    const taskId = 'task-quotes';

    runHook(codexPayload('say "hello world"'), taskId, sessionsDir);

    const msg = readFirstMessage(path.join(sessionsDir, taskId));
    expect(msg.content).toBe('say "hello world"');
  });

  it('handles newlines in response', () => {
    const sessionsDir = path.join(tmpDir, 'special-newlines');
    const taskId = 'task-newlines';

    runHook(codexPayload('line one\nline two\nline three'), taskId, sessionsDir);

    const msg = readFirstMessage(path.join(sessionsDir, taskId));
    expect(msg.content).toBe('line one\nline two\nline three');
  });

  it('handles unicode in response', () => {
    const sessionsDir = path.join(tmpDir, 'special-unicode');
    const taskId = 'task-unicode';

    runHook(codexPayload('emoji: 🚀 and CJK: 你好'), taskId, sessionsDir);

    const msg = readFirstMessage(path.join(sessionsDir, taskId));
    expect(msg.content).toBe('emoji: 🚀 and CJK: 你好');
  });

  it('handles backticks in response', () => {
    const sessionsDir = path.join(tmpDir, 'special-backtick');
    const taskId = 'task-backtick';

    runHook(codexPayload('run `npm install` here'), taskId, sessionsDir);

    const msg = readFirstMessage(path.join(sessionsDir, taskId));
    expect(msg.content).toBe('run `npm install` here');
  });

  it('handles backslashes in response', () => {
    const sessionsDir = path.join(tmpDir, 'special-backslash');
    const taskId = 'task-backslash';

    runHook(codexPayload('path: C:\\Users\\test'), taskId, sessionsDir);

    const msg = readFirstMessage(path.join(sessionsDir, taskId));
    expect(msg.content).toBe('path: C:\\Users\\test');
  });
});

// ============================================================================
// Sequence Numbering
// ============================================================================

describe('stop-hook: sequence numbering', () => {
  it('increments sequence numbers across multiple calls', () => {
    const sessionsDir = path.join(tmpDir, 'sequence');
    const taskId = 'task-seq';

    // Three successive hook invocations for the same task
    for (const content of ['first', 'second', 'third']) {
      runHook(codexPayload(content), taskId, sessionsDir);
    }

    const messages = readAllMessages(path.join(sessionsDir, taskId));
    expect(messages).toHaveLength(3);
    expect(messages[0]?.sequence).toBe(1);
    expect(messages[1]?.sequence).toBe(2);
    expect(messages[2]?.sequence).toBe(3);
  });

  it('message filenames are zero-padded 5-digit sequences', () => {
    const sessionsDir = path.join(tmpDir, 'sequence-names');
    const taskId = 'task-seq-names';

    runHook(codexPayload('one'), taskId, sessionsDir);
    runHook(codexPayload('two'), taskId, sessionsDir);

    const messagesDir = path.join(sessionsDir, taskId, 'messages');
    const files = fs.readdirSync(messagesDir).sort();
    expect(files[0]).toBe('00001-result.json');
    expect(files[1]).toBe('00002-result.json');
  });
});

// ============================================================================
// Sentinel Mapping
// ============================================================================

describe('stop-hook: sentinel mapping', () => {
  it('writes .done for stop_reason=end_turn', () => {
    const sessionsDir = path.join(tmpDir, 'sentinel-end-turn');
    const taskId = 'task-sent-1';

    const { taskDir } = runHook(codexPayload('done', 'end_turn'), taskId, sessionsDir);

    expect(fs.existsSync(path.join(taskDir, '.done'))).toBe(true);
    expect(fs.existsSync(path.join(taskDir, '.exit'))).toBe(false);
  });

  it('writes .done for stop_reason=stop_sequence', () => {
    const sessionsDir = path.join(tmpDir, 'sentinel-stop-seq');
    const taskId = 'task-sent-2';

    const { taskDir } = runHook(codexPayload('done', 'stop_sequence'), taskId, sessionsDir);

    expect(fs.existsSync(path.join(taskDir, '.done'))).toBe(true);
    expect(fs.existsSync(path.join(taskDir, '.exit'))).toBe(false);
  });

  it('writes .done for stop_reason=max_tokens', () => {
    const sessionsDir = path.join(tmpDir, 'sentinel-max-tokens');
    const taskId = 'task-sent-3';

    const { taskDir } = runHook(codexPayload('done', 'max_tokens'), taskId, sessionsDir);

    expect(fs.existsSync(path.join(taskDir, '.done'))).toBe(true);
    expect(fs.existsSync(path.join(taskDir, '.exit'))).toBe(false);
  });

  it('writes .exit for stop_reason=tool_error', () => {
    const sessionsDir = path.join(tmpDir, 'sentinel-tool-error');
    const taskId = 'task-sent-4';

    const { taskDir } = runHook(codexPayload('error occurred', 'tool_error'), taskId, sessionsDir);

    expect(fs.existsSync(path.join(taskDir, '.exit'))).toBe(true);
    expect(fs.existsSync(path.join(taskDir, '.done'))).toBe(false);
  });

  it('writes .exit for stop_reason=user_interrupt', () => {
    const sessionsDir = path.join(tmpDir, 'sentinel-user-interrupt');
    const taskId = 'task-sent-5';

    const { taskDir } = runHook(codexPayload('interrupted', 'user_interrupt'), taskId, sessionsDir);

    expect(fs.existsSync(path.join(taskDir, '.exit'))).toBe(true);
    expect(fs.existsSync(path.join(taskDir, '.done'))).toBe(false);
  });

  it('writes .done when stop_reason is missing (defaults to end_turn)', () => {
    const sessionsDir = path.join(tmpDir, 'sentinel-no-reason');
    const taskId = 'task-sent-6';

    // Payload with no stop_reason field
    const payload = JSON.stringify({ last_assistant_message: 'complete' });
    const { taskDir } = runHook(payload, taskId, sessionsDir);

    expect(fs.existsSync(path.join(taskDir, '.done'))).toBe(true);
    expect(fs.existsSync(path.join(taskDir, '.exit'))).toBe(false);
  });
});

// ============================================================================
// Security: Path Traversal
// ============================================================================

describe('stop-hook: security', () => {
  it('rejects task ID with ../ — exits 0, no files created', () => {
    const sessionsDir = path.join(tmpDir, 'security-traversal');
    fs.mkdirSync(sessionsDir, { recursive: true });

    const result = spawnSync('bash', [HOOK_SCRIPT], {
      input: codexPayload('hello'),
      encoding: 'utf8',
      env: {
        ...Object.fromEntries(Object.entries(process.env).filter(([, v]) => v !== undefined) as [string, string][]),
        AUTOBEAT_WORKER: 'true',
        AUTOBEAT_TASK_ID: '../etc/passwd',
        AUTOBEAT_SESSIONS_DIR: sessionsDir,
      },
    });

    expect(result.status).toBe(0);
    // No files should exist in sessions dir
    expect(fs.readdirSync(sessionsDir)).toHaveLength(0);
  });

  it('rejects task ID with spaces — exits 0, no files created', () => {
    const sessionsDir = path.join(tmpDir, 'security-spaces');
    fs.mkdirSync(sessionsDir, { recursive: true });

    const result = spawnSync('bash', [HOOK_SCRIPT], {
      input: codexPayload('hello'),
      encoding: 'utf8',
      env: {
        ...Object.fromEntries(Object.entries(process.env).filter(([, v]) => v !== undefined) as [string, string][]),
        AUTOBEAT_WORKER: 'true',
        AUTOBEAT_TASK_ID: 'task with spaces',
        AUTOBEAT_SESSIONS_DIR: sessionsDir,
      },
    });

    expect(result.status).toBe(0);
    expect(fs.readdirSync(sessionsDir)).toHaveLength(0);
  });

  it('rejects sessions dir containing .. — exits 0, no files created', () => {
    // Construct a sessions dir path that contains ".." as a literal path component.
    // path.join() resolves ".." away, so we use string concatenation deliberately.
    const sessionsDir = tmpDir + '/../escaped-traversal';

    const result = spawnSync('bash', [HOOK_SCRIPT], {
      input: codexPayload('hello'),
      encoding: 'utf8',
      env: {
        ...Object.fromEntries(Object.entries(process.env).filter(([, v]) => v !== undefined) as [string, string][]),
        AUTOBEAT_WORKER: 'true',
        AUTOBEAT_TASK_ID: 'task-legit',
        AUTOBEAT_SESSIONS_DIR: sessionsDir,
      },
    });

    expect(result.status).toBe(0);
    // Verify the sessions dir path contains ".." (confirming the test is testing the right thing)
    expect(sessionsDir).toContain('..');
    // The escaped path should not have been created
    const resolvedEscapedDir = path.resolve(path.dirname(tmpDir), 'escaped-traversal');
    expect(fs.existsSync(resolvedEscapedDir)).toBe(false);
  });

  it('accepts valid lowercase alphanumeric task ID with hyphens and underscores', () => {
    const sessionsDir = path.join(tmpDir, 'security-valid-id');
    const taskId = 'task-2025-01_run-1';

    const { taskDir } = runHook(codexPayload('hello'), taskId, sessionsDir);

    expect(fs.existsSync(path.join(taskDir, '.done'))).toBe(true);
  });

  it('rejects transcript_path outside trusted prefixes — treats as missing, writes .exit', () => {
    // A transcript_path pointing at /etc/passwd (or any other path outside the
    // allowed prefix list) must be rejected without reading it.
    const sessionsDir = path.join(tmpDir, 'security-transcript-prefix');
    const taskId = 'task-transcript-prefix';

    // Write a real file at /tmp/ with trusted content — but specify an untrusted path
    // in the payload to confirm the hook ignores it based on prefix alone.
    const payload = JSON.stringify({
      transcript_path: '/etc/passwd',
      stop_reason: 'end_turn',
    });

    const { taskDir } = runHook(payload, taskId, sessionsDir);

    // No response extracted → fail-fast path → .exit sentinel
    expect(fs.existsSync(path.join(taskDir, '.exit'))).toBe(true);
    const messagesDir = path.join(taskDir, 'messages');
    const hasMessages = fs.existsSync(messagesDir) && fs.readdirSync(messagesDir).length > 0;
    expect(hasMessages).toBe(false);
  });

  it('rejects transcript_path containing .. even within an allowed prefix', () => {
    // A path like /tmp/claude-abc/../../etc/passwd starts with /tmp/ but
    // the traversal segment must still be rejected.
    const sessionsDir = path.join(tmpDir, 'security-transcript-traversal');
    const taskId = 'task-transcript-traversal';

    const payload = JSON.stringify({
      transcript_path: '/tmp/claude-abc/../../etc/passwd',
      stop_reason: 'end_turn',
    });

    const { taskDir } = runHook(payload, taskId, sessionsDir);

    expect(fs.existsSync(path.join(taskDir, '.exit'))).toBe(true);
    const messagesDir = path.join(taskDir, 'messages');
    const hasMessages = fs.existsSync(messagesDir) && fs.readdirSync(messagesDir).length > 0;
    expect(hasMessages).toBe(false);
  });

  it('reads transcript_path when it is within the trusted OS temp prefix', () => {
    // Confirm the allowlist correctly permits real transcript files written
    // by Claude Code / tests into the OS temp directory.
    const sessionsDir = path.join(tmpDir, 'security-transcript-allowed');
    const taskId = 'task-transcript-allowed';
    const transcriptPath = path.join(tmpDir, 'transcript-allowed.jsonl');

    const payload = claudePayload(transcriptPath, 'trusted transcript response');
    const { taskDir } = runHook(payload, taskId, sessionsDir);

    expect(fs.existsSync(path.join(taskDir, '.done'))).toBe(true);
    const msg = readFirstMessage(taskDir);
    expect(msg.content).toBe('trusted transcript response');
  });
});

// ============================================================================
// Atomic Writes
// ============================================================================

describe('stop-hook: atomic writes', () => {
  it('no .tmp files persist after completion', () => {
    const sessionsDir = path.join(tmpDir, 'atomic');
    const taskId = 'task-atomic';

    const { taskDir } = runHook(codexPayload('atomic test'), taskId, sessionsDir);

    // Walk the task dir and check no .tmp files remain
    function findTmpFiles(dir: string): string[] {
      const results: string[] = [];
      for (const entry of fs.readdirSync(dir)) {
        const full = path.join(dir, entry);
        const stat = fs.statSync(full);
        if (stat.isDirectory()) {
          results.push(...findTmpFiles(full));
        } else if (entry.endsWith('.tmp')) {
          results.push(full);
        }
      }
      return results;
    }

    const tmpFiles = findTmpFiles(taskDir);
    expect(tmpFiles).toHaveLength(0);
  });
});

// ============================================================================
// Fail-fast: Empty Response
// ============================================================================

describe('stop-hook: fail-fast on empty response', () => {
  it('writes .exit when response cannot be extracted from payload', () => {
    const sessionsDir = path.join(tmpDir, 'failfast');
    const taskId = 'task-failfast';

    // Payload with no response fields — simulates neither codex nor claude path
    const payload = JSON.stringify({ stop_reason: 'end_turn' });
    const { status, taskDir } = runHook(payload, taskId, sessionsDir);

    expect(status).toBe(0);
    expect(fs.existsSync(path.join(taskDir, '.exit'))).toBe(true);
    // No message file should be written on empty response
    const messagesDir = path.join(taskDir, 'messages');
    const hasMessages = fs.existsSync(messagesDir) && fs.readdirSync(messagesDir).length > 0;
    expect(hasMessages).toBe(false);
  });

  it('writes .exit when transcript_path file does not exist', () => {
    const sessionsDir = path.join(tmpDir, 'failfast-missing-transcript');
    const taskId = 'task-failfast-2';

    const payload = JSON.stringify({
      transcript_path: '/nonexistent/transcript.jsonl',
      stop_reason: 'end_turn',
    });
    const { taskDir } = runHook(payload, taskId, sessionsDir);

    expect(fs.existsSync(path.join(taskDir, '.exit'))).toBe(true);
  });
});

// ============================================================================
// Usage Capture
// ============================================================================

describe('stop-hook: usage capture', () => {
  it('writes a second stdout message with usage JSON when usage fields are present', () => {
    const sessionsDir = path.join(tmpDir, 'usage-present');
    const taskId = 'task-usage-1';

    const payload = claudeCodePayload('Task complete.', { input_tokens: 100, output_tokens: 50 }, 0.001234);
    const { taskDir } = runHook(payload, taskId, sessionsDir);

    const messages = readAllMessages(taskDir);
    // Should have 2 messages: result + stdout usage blob
    expect(messages).toHaveLength(2);

    const resultMsg = messages[0]!;
    expect(resultMsg.type).toBe('result');
    expect(resultMsg.content).toBe('Task complete.');

    const usageMsg = messages[1]!;
    expect(usageMsg.type).toBe('stdout');
    expect(typeof usageMsg.content).toBe('string');

    // Parse the usage content — must contain type:"result", usage, and total_cost_usd
    const usageContent = JSON.parse(usageMsg.content as string) as Record<string, unknown>;
    expect(usageContent.type).toBe('result');
    expect(typeof usageContent.usage).toBe('object');
    const usage = usageContent.usage as Record<string, unknown>;
    expect(usage.input_tokens).toBe(100);
    expect(usage.output_tokens).toBe(50);
    expect(usageContent.total_cost_usd).toBeCloseTo(0.001234);
  });

  it('includes cache token fields in usage JSON when present', () => {
    const sessionsDir = path.join(tmpDir, 'usage-cache');
    const taskId = 'task-usage-cache';

    const payload = claudeCodePayload(
      'Done.',
      { input_tokens: 200, output_tokens: 80, cache_creation_input_tokens: 20, cache_read_input_tokens: 10 },
      0.005,
    );
    const { taskDir } = runHook(payload, taskId, sessionsDir);

    const messages = readAllMessages(taskDir);
    expect(messages).toHaveLength(2);

    const usageContent = JSON.parse(messages[1]!.content as string) as Record<string, unknown>;
    const usage = usageContent.usage as Record<string, unknown>;
    expect(usage.cache_creation_input_tokens).toBe(20);
    expect(usage.cache_read_input_tokens).toBe(10);
  });

  it('does not write a usage message when usage fields are absent (Codex path)', () => {
    const sessionsDir = path.join(tmpDir, 'usage-absent');
    const taskId = 'task-usage-absent';

    // Codex path — no usage fields
    const payload = codexPayload('Codex done.');
    const { taskDir } = runHook(payload, taskId, sessionsDir);

    const messages = readAllMessages(taskDir);
    // Only the result message — no usage stdout message
    expect(messages).toHaveLength(1);
    expect(messages[0]!.type).toBe('result');
  });

  it('does not write a usage message when transcript path is used (no usage available)', () => {
    const sessionsDir = path.join(tmpDir, 'usage-transcript');
    const taskId = 'task-usage-transcript';
    const transcriptPath = path.join(tmpDir, 'transcript-usage.jsonl');

    const payload = claudePayload(transcriptPath, 'Transcript response.');
    const { taskDir } = runHook(payload, taskId, sessionsDir);

    const messages = readAllMessages(taskDir);
    expect(messages).toHaveLength(1);
    expect(messages[0]!.type).toBe('result');
  });

  it('sequence numbers are contiguous: result=1, usage=2', () => {
    const sessionsDir = path.join(tmpDir, 'usage-seq');
    const taskId = 'task-usage-seq';

    const payload = claudeCodePayload('Response.', { input_tokens: 10, output_tokens: 5 }, 0.0001);
    const { taskDir } = runHook(payload, taskId, sessionsDir);

    const messages = readAllMessages(taskDir);
    expect(messages).toHaveLength(2);
    expect(messages[0]!.sequence).toBe(1);
    expect(messages[1]!.sequence).toBe(2);
  });
});

// ============================================================================
// jq Unavailable Guard
// ============================================================================

describe('stop-hook: jq unavailable guard', () => {
  it('exits 0 silently and creates no files when jq is not on PATH', () => {
    const sessionsDir = path.join(tmpDir, 'no-jq');
    fs.mkdirSync(sessionsDir, { recursive: true });

    // Empty PATH so `command -v jq` fails. We invoke /bin/bash by absolute
    // path, and the script exits at line 6 before reaching any other command.
    const result = spawnSync('/bin/bash', [HOOK_SCRIPT], {
      input: codexPayload('hello'),
      encoding: 'utf8',
      env: {
        PATH: '',
        AUTOBEAT_WORKER: 'true',
        AUTOBEAT_TASK_ID: 'task-no-jq',
        AUTOBEAT_SESSIONS_DIR: sessionsDir,
      },
    });

    expect(result.status).toBe(0);
    expect(fs.readdirSync(sessionsDir)).toHaveLength(0);
  });
});

// ============================================================================
// Transcript: Plain-String Content Branch
// ============================================================================

describe('stop-hook: Claude path — plain-string content', () => {
  it('extracts response when assistant message content is a plain string', () => {
    const sessionsDir = path.join(tmpDir, 'claude-string-content');
    const taskId = 'task-claude-string';
    const transcriptPath = path.join(tmpDir, 'transcript-string.jsonl');

    // Write a transcript where content is a plain string, not an array of text objects.
    // This exercises the else branch of:
    //   if .message.content | type == "array" then ... else .message.content // "" end
    const lines = [
      JSON.stringify({ role: 'user', message: { content: 'do something' } }),
      JSON.stringify({
        role: 'assistant',
        message: { content: 'plain string response from assistant' },
      }),
    ];
    fs.writeFileSync(transcriptPath, lines.join('\n') + '\n');

    const payload = JSON.stringify({
      transcript_path: transcriptPath,
      stop_reason: 'end_turn',
    });

    const { status, taskDir } = runHook(payload, taskId, sessionsDir);

    expect(status).toBe(0);
    expect(fs.existsSync(path.join(taskDir, '.done'))).toBe(true);

    const msg = readFirstMessage(taskDir);
    expect(msg.type).toBe('result');
    expect(msg.content).toBe('plain string response from assistant');
  });

  it('uses last assistant message when transcript has multiple assistant turns with plain-string content', () => {
    const sessionsDir = path.join(tmpDir, 'claude-string-multiturn');
    const taskId = 'task-claude-string-multi';
    const transcriptPath = path.join(tmpDir, 'transcript-string-multi.jsonl');

    // Both assistant messages use plain string content (not array).
    // Verifies the else-branch respects the "last assistant message" semantics.
    const lines = [
      JSON.stringify({ role: 'user', message: { content: 'step 1' } }),
      JSON.stringify({ role: 'assistant', message: { content: 'intermediate answer' } }),
      JSON.stringify({ role: 'user', message: { content: 'step 2' } }),
      JSON.stringify({ role: 'assistant', message: { content: 'final answer' } }),
    ];
    fs.writeFileSync(transcriptPath, lines.join('\n') + '\n');

    const payload = JSON.stringify({
      transcript_path: transcriptPath,
      stop_reason: 'end_turn',
    });

    const { taskDir } = runHook(payload, taskId, sessionsDir);

    const msg = readFirstMessage(taskDir);
    expect(msg.content).toBe('final answer');
  });
});

// ============================================================================
// Transcript Path: Special Characters
// ============================================================================

describe('stop-hook: Claude path — special characters', () => {
  it('handles double quotes in transcript assistant response', () => {
    const sessionsDir = path.join(tmpDir, 'claude-special-quotes');
    const taskId = 'task-claude-quotes';
    const transcriptPath = path.join(tmpDir, 'transcript-quotes.jsonl');

    const payload = claudePayload(transcriptPath, 'say "hello world" and "goodbye"');
    runHook(payload, taskId, sessionsDir);

    const msg = readFirstMessage(path.join(sessionsDir, taskId));
    expect(msg.content).toBe('say "hello world" and "goodbye"');
  });

  it('handles newlines in transcript assistant response', () => {
    const sessionsDir = path.join(tmpDir, 'claude-special-newlines');
    const taskId = 'task-claude-newlines';
    const transcriptPath = path.join(tmpDir, 'transcript-newlines.jsonl');

    const payload = claudePayload(transcriptPath, 'line one\nline two\nline three');
    runHook(payload, taskId, sessionsDir);

    const msg = readFirstMessage(path.join(sessionsDir, taskId));
    expect(msg.content).toBe('line one\nline two\nline three');
  });

  it('handles backslashes in transcript assistant response', () => {
    const sessionsDir = path.join(tmpDir, 'claude-special-backslash');
    const taskId = 'task-claude-backslash';
    const transcriptPath = path.join(tmpDir, 'transcript-backslash.jsonl');

    const payload = claudePayload(transcriptPath, 'path: C:\\Users\\test');
    runHook(payload, taskId, sessionsDir);

    const msg = readFirstMessage(path.join(sessionsDir, taskId));
    expect(msg.content).toBe('path: C:\\Users\\test');
  });
});

// ============================================================================
// jq escape fallback
// ============================================================================

describe('stop-hook: jq escape fallback', () => {
  it('treats empty last_assistant_message as missing — writes .exit, no message file', () => {
    // An empty string from the Codex field is indistinguishable from "no response".
    // The hook exits the fail-fast path (writes .exit) rather than writing a
    // malformed or empty message file.
    const sessionsDir = path.join(tmpDir, 'escaped-guard');
    const taskId = 'task-escaped-guard';

    const payload = JSON.stringify({
      last_assistant_message: '',
      stop_reason: 'end_turn',
    });
    const { taskDir } = runHook(payload, taskId, sessionsDir);

    expect(fs.existsSync(path.join(taskDir, '.exit'))).toBe(true);
    const messagesDir = path.join(taskDir, 'messages');
    const hasMessages = fs.existsSync(messagesDir) && fs.readdirSync(messagesDir).length > 0;
    expect(hasMessages).toBe(false);
  });

  it('post-eval guard: malformed stdin (jq fails) does not crash — exits 0, writes .exit', () => {
    // Simulate jq eval failure by providing truncated / non-JSON input.
    // When jq fails, STOP_REASON is never set; the post-eval guard resets all
    // four variables to safe defaults so the hook continues cleanly to
    // the fail-fast .exit path rather than crashing with an unbound variable.
    const sessionsDir = path.join(tmpDir, 'post-eval-guard');
    const taskId = 'task-post-eval-guard';

    const { status, taskDir } = runHook('{not valid json', taskId, sessionsDir);

    expect(status).toBe(0);
    // No response extracted → fail-fast path → .exit sentinel
    expect(fs.existsSync(path.join(taskDir, '.exit'))).toBe(true);
    const messagesDir = path.join(taskDir, 'messages');
    const hasMessages = fs.existsSync(messagesDir) && fs.readdirSync(messagesDir).length > 0;
    expect(hasMessages).toBe(false);
  });
});
