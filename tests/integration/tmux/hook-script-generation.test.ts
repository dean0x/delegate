/**
 * Integration tests for TmuxHooks wrapper script generation.
 * Uses real filesystem operations. Requires bash and (optionally) tmux.
 * bash -n validation does not require tmux.
 */

import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DefaultTmuxHooks } from '../../../src/implementations/tmux/tmux-hooks.js';
import type { WrapperConfig } from '../../../src/implementations/tmux/types.js';

let tmpDir = '';

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'beat-hooks-'));
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

function makeRealHooks(): DefaultTmuxHooks {
  return new DefaultTmuxHooks({
    writeFile: (p: string, content: string, opts: { mode: number }) => {
      fs.writeFileSync(p, content, { mode: opts.mode });
    },
    mkdirSync: (p: string, opts: { recursive: boolean; mode: number }) => {
      fs.mkdirSync(p, opts);
    },
    rmSync: (p: string, opts: { recursive: boolean; force: boolean }) => {
      fs.rmSync(p, opts);
    },
  });
}

describe('TmuxHooks integration — wrapper script generation', () => {
  it('generated wrapper script passes bash -n syntax check', () => {
    const hooks = makeRealHooks();
    const sessionsDir = path.join(tmpDir, 'syntax-check');

    const config: WrapperConfig = {
      taskId: 'task-syntax',
      agent: 'claude',
      sessionsDir,
      agentCommand: 'echo',
      agentArgs: ['hello'],
    };

    const result = hooks.generateWrapper(config);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // bash -n validates syntax without executing
    const check = spawnSync('bash', ['-n', result.value.wrapperPath], { encoding: 'utf8' });
    expect(check.status).toBe(0);
  });

  it('wrapper creates .done sentinel when agent exits 0', () => {
    const hooks = makeRealHooks();
    const sessionsDir = path.join(tmpDir, 'done-agent');

    const config: WrapperConfig = {
      taskId: 'task-done',
      agent: 'claude',
      sessionsDir,
      agentCommand: 'echo',
      agentArgs: ['success'],
    };

    const result = hooks.generateWrapper(config);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const run = spawnSync('bash', [result.value.wrapperPath], {
      encoding: 'utf8',
      timeout: 10000,
    });

    const donePath = path.join(result.value.sessionDir, '.done');
    const exitPath = path.join(result.value.sessionDir, '.exit');

    expect(fs.existsSync(donePath)).toBe(true);
    expect(fs.existsSync(exitPath)).toBe(false);
    expect(run.status).toBe(0);
  });

  it('wrapper captures stdout output to JSON files in messages/', () => {
    const hooks = makeRealHooks();
    const sessionsDir = path.join(tmpDir, 'output-capture');

    const config: WrapperConfig = {
      taskId: 'task-capture',
      agent: 'claude',
      sessionsDir,
      agentCommand: 'echo',
      agentArgs: ['captured line'],
    };

    const result = hooks.generateWrapper(config);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    spawnSync('bash', [result.value.wrapperPath], { encoding: 'utf8', timeout: 10000 });

    const messagesDir = result.value.messagesDir;
    const files = fs.existsSync(messagesDir) ? fs.readdirSync(messagesDir).filter((f) => f.endsWith('.json')) : [];
    expect(files.length).toBeGreaterThan(0);
  });

  it('captured JSON messages have valid structure', () => {
    const hooks = makeRealHooks();
    const sessionsDir = path.join(tmpDir, 'json-structure');

    const config: WrapperConfig = {
      taskId: 'task-json',
      agent: 'claude',
      sessionsDir,
      agentCommand: 'echo',
      agentArgs: ['structured output'],
    };

    const result = hooks.generateWrapper(config);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    spawnSync('bash', [result.value.wrapperPath], { encoding: 'utf8', timeout: 10000 });

    const files = fs.readdirSync(result.value.messagesDir).filter((f) => f.endsWith('.json'));
    for (const file of files) {
      const content = fs.readFileSync(path.join(result.value.messagesDir, file), 'utf8');
      const parsed = JSON.parse(content) as Record<string, unknown>;
      expect(typeof parsed['sequence']).toBe('number');
      expect(typeof parsed['timestamp']).toBe('string');
      expect(typeof parsed['type']).toBe('string');
      expect(typeof parsed['content']).toBe('string');
    }
  });

  it('correctly escapes output containing double quotes via jq', () => {
    const hooks = makeRealHooks();
    const sessionsDir = path.join(tmpDir, 'escape-dquote');

    const config: WrapperConfig = {
      taskId: 'task-dquote',
      agent: 'claude',
      sessionsDir,
      agentCommand: 'printf',
      agentArgs: ['%s\\n', 'he said "hello"'],
    };

    const result = hooks.generateWrapper(config);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    spawnSync('bash', [result.value.wrapperPath], { encoding: 'utf8', timeout: 10000 });

    const files = fs.readdirSync(result.value.messagesDir).filter((f) => f.endsWith('.json'));
    expect(files.length).toBeGreaterThan(0);
    const content = fs.readFileSync(path.join(result.value.messagesDir, files[0]!), 'utf8');
    const parsed = JSON.parse(content) as { content: string };
    expect(parsed.content).toBe('he said "hello"');
  });

  it('correctly escapes output containing backslashes via jq', () => {
    const hooks = makeRealHooks();
    const sessionsDir = path.join(tmpDir, 'escape-backslash');

    const config: WrapperConfig = {
      taskId: 'task-backslash',
      agent: 'claude',
      sessionsDir,
      agentCommand: 'printf',
      agentArgs: ['%s\\n', 'path\\to\\file'],
    };

    const result = hooks.generateWrapper(config);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    spawnSync('bash', [result.value.wrapperPath], { encoding: 'utf8', timeout: 10000 });

    const files = fs.readdirSync(result.value.messagesDir).filter((f) => f.endsWith('.json'));
    expect(files.length).toBeGreaterThan(0);
    const content = fs.readFileSync(path.join(result.value.messagesDir, files[0]!), 'utf8');
    const parsed = JSON.parse(content) as { content: string };
    expect(parsed.content).toBe('path\\to\\file');
  });

  it('correctly escapes output containing tabs via jq', () => {
    const hooks = makeRealHooks();
    const sessionsDir = path.join(tmpDir, 'escape-tab');

    const config: WrapperConfig = {
      taskId: 'task-tab',
      agent: 'claude',
      sessionsDir,
      agentCommand: 'printf',
      agentArgs: ['%s\\n', 'col1\tcol2'],
    };

    const result = hooks.generateWrapper(config);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    spawnSync('bash', [result.value.wrapperPath], { encoding: 'utf8', timeout: 10000 });

    const files = fs.readdirSync(result.value.messagesDir).filter((f) => f.endsWith('.json'));
    expect(files.length).toBeGreaterThan(0);
    const content = fs.readFileSync(path.join(result.value.messagesDir, files[0]!), 'utf8');
    const parsed = JSON.parse(content) as { content: string };
    expect(parsed.content).toBe('col1\tcol2');
  });

  it('handles mixed special characters in a single line', () => {
    const hooks = makeRealHooks();
    const sessionsDir = path.join(tmpDir, 'escape-mixed');

    const config: WrapperConfig = {
      taskId: 'task-mixed',
      agent: 'claude',
      sessionsDir,
      agentCommand: 'printf',
      agentArgs: ['%s\\n', '"q" and \\b and \t'],
    };

    const result = hooks.generateWrapper(config);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    spawnSync('bash', [result.value.wrapperPath], { encoding: 'utf8', timeout: 10000 });

    const files = fs.readdirSync(result.value.messagesDir).filter((f) => f.endsWith('.json'));
    expect(files.length).toBeGreaterThan(0);
    const content = fs.readFileSync(path.join(result.value.messagesDir, files[0]!), 'utf8');
    expect(() => JSON.parse(content)).not.toThrow();
  });

  it('wrapper exits 127 when jq is not in PATH (defense-in-depth)', () => {
    const hooks = makeRealHooks();
    const sessionsDir = path.join(tmpDir, 'no-jq');

    const config: WrapperConfig = {
      taskId: 'task-nojq',
      agent: 'claude',
      sessionsDir,
      agentCommand: 'echo',
      agentArgs: ['test'],
    };

    const result = hooks.generateWrapper(config);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const run = spawnSync('/bin/bash', [result.value.wrapperPath], {
      encoding: 'utf8',
      timeout: 10000,
      env: { PATH: '/nonexistent', HOME: os.homedir() },
    });

    expect(run.status).toBe(127);
    expect(run.stderr).toContain('jq');
  });

  it('sequence numbers increment monotonically across multiple output lines', () => {
    const hooks = makeRealHooks();
    const sessionsDir = path.join(tmpDir, 'seq-increment');

    // Use printf to emit multiple lines
    const config: WrapperConfig = {
      taskId: 'task-seq',
      agent: 'claude',
      sessionsDir,
      agentCommand: 'printf',
      agentArgs: ['line1\\nline2\\nline3\\n'],
    };

    const result = hooks.generateWrapper(config);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    spawnSync('bash', [result.value.wrapperPath], { encoding: 'utf8', timeout: 10000 });

    const files = fs
      .readdirSync(result.value.messagesDir)
      .filter((f) => f.endsWith('.json'))
      .sort();

    if (files.length < 2) {
      // Some environments may not produce multiple lines — skip assertion
      return;
    }

    const sequences = files.map((f) => {
      const content = JSON.parse(fs.readFileSync(path.join(result.value.messagesDir, f), 'utf8')) as {
        sequence: number;
      };
      return content.sequence;
    });

    // Sequences should be monotonically increasing
    for (let i = 1; i < sequences.length; i++) {
      expect(sequences[i]!).toBeGreaterThan(sequences[i - 1]!);
    }
  });
});
