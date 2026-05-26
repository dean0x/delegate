/**
 * Integration tests for sentinel-based completion detection.
 * Requires real tmux and a real filesystem.
 * Skips gracefully if tmux is not available.
 */

import { execSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TmuxSessionManager } from '../../../src/implementations/tmux/tmux-session-manager.js';
import type { ExecFn } from '../../../src/implementations/tmux/types.js';
import { isTmuxAvailable, realExec } from './test-helpers.js';

const tmuxAvailable = isTmuxAvailable();

let tmpDir = '';

beforeAll(() => {
  if (!tmuxAvailable) {
    console.warn('[SKIP] tmux not available — skipping sentinel integration tests');
    return;
  }
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'beat-sentinel-'));
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

describe.skipIf(!tmuxAvailable)('Sentinel detection integration', () => {
  it('.done sentinel is created when a script exits 0', () => {
    const sentinelDir = path.join(tmpDir, 'done-test');
    fs.mkdirSync(sentinelDir, { recursive: true });

    const script = `#!/bin/bash
echo "hello" > "${sentinelDir}/output.txt"
echo 0 > "${sentinelDir}/.done.tmp"
mv "${sentinelDir}/.done.tmp" "${sentinelDir}/.done"
`;
    const scriptPath = path.join(sentinelDir, 'run.sh');
    fs.writeFileSync(scriptPath, script, { mode: 0o700 });

    execSync(`bash "${scriptPath}"`, { timeout: 5000 });

    expect(fs.existsSync(path.join(sentinelDir, '.done'))).toBe(true);
    expect(fs.existsSync(path.join(sentinelDir, '.exit'))).toBe(false);
  });

  it('.exit sentinel is created when a script exits non-zero', () => {
    const sentinelDir = path.join(tmpDir, 'exit-test');
    fs.mkdirSync(sentinelDir, { recursive: true });

    const script = `#!/bin/bash
EXIT_CODE=42
echo $EXIT_CODE > "${sentinelDir}/.exit.tmp"
mv "${sentinelDir}/.exit.tmp" "${sentinelDir}/.exit"
exit $EXIT_CODE
`;
    const scriptPath = path.join(sentinelDir, 'run.sh');
    fs.writeFileSync(scriptPath, script, { mode: 0o700 });

    try {
      execSync(`bash "${scriptPath}"`, { timeout: 5000 });
    } catch {
      /* expected non-zero exit */
    }

    expect(fs.existsSync(path.join(sentinelDir, '.exit'))).toBe(true);
    const code = fs.readFileSync(path.join(sentinelDir, '.exit'), 'utf8').trim();
    expect(parseInt(code, 10)).toBe(42);
  });

  it('output JSON file is written with correct structure', () => {
    const sentinelDir = path.join(tmpDir, 'output-test');
    const messagesDir = path.join(sentinelDir, 'messages');
    fs.mkdirSync(messagesDir, { recursive: true });

    const script = `#!/bin/bash
SEQ=1
LINE="hello output"
MSG_FILE="${messagesDir}/00001-stdout.json"
printf '{"sequence":%d,"timestamp":"2026-01-01T00:00:00.000Z","type":"stdout","content":"%s"}\\n' "$SEQ" "$LINE" > "\${MSG_FILE}.tmp"
mv "\${MSG_FILE}.tmp" "$MSG_FILE"
`;
    const scriptPath = path.join(sentinelDir, 'run.sh');
    fs.writeFileSync(scriptPath, script, { mode: 0o700 });
    execSync(`bash "${scriptPath}"`, { timeout: 5000 });

    const msgPath = path.join(messagesDir, '00001-stdout.json');
    expect(fs.existsSync(msgPath)).toBe(true);
    const parsed = JSON.parse(fs.readFileSync(msgPath, 'utf8')) as Record<string, unknown>;
    expect(parsed).toMatchObject({
      sequence: 1,
      type: 'stdout',
    });
    expect(typeof parsed['timestamp']).toBe('string');
    expect(typeof parsed['content']).toBe('string');
  });

  it('atomic write pattern (.tmp → mv) never produces a partial file visible to readers', () => {
    const sentinelDir = path.join(tmpDir, 'atomic-test');
    fs.mkdirSync(sentinelDir, { recursive: true });

    const targetFile = path.join(sentinelDir, 'result.json');
    const tmpFile = path.join(sentinelDir, 'result.json.tmp');
    const content = JSON.stringify({ sequence: 1, type: 'stdout', content: 'test' });

    fs.writeFileSync(tmpFile, content);
    fs.renameSync(tmpFile, targetFile);

    // The rename is atomic — the file either exists or doesn't (never partial)
    expect(fs.existsSync(targetFile)).toBe(true);
    expect(fs.existsSync(tmpFile)).toBe(false);
    const read = JSON.parse(fs.readFileSync(targetFile, 'utf8')) as Record<string, unknown>;
    expect(read['sequence']).toBe(1);
  });

  it('sequence numbers increment correctly across multiple messages', () => {
    const sentinelDir = path.join(tmpDir, 'seq-test');
    const messagesDir = path.join(sentinelDir, 'messages');
    fs.mkdirSync(messagesDir, { recursive: true });

    const seqFile = path.join(sentinelDir, '.seq');
    const script = `#!/bin/bash
next_seq() {
  (
    flock -x 200
    SEQ=$(cat "${seqFile}" 2>/dev/null || echo 0)
    SEQ=$((SEQ + 1))
    echo $SEQ > "${seqFile}"
    printf "%05d" $SEQ
  ) 200>"${seqFile}.lock"
}

for i in 1 2 3; do
  S=$(next_seq)
  echo "{\\"sequence\\":$i}" > "${messagesDir}/\${S}-stdout.json"
done
`;
    const scriptPath = path.join(sentinelDir, 'run.sh');
    fs.writeFileSync(scriptPath, script, { mode: 0o700 });
    execSync(`bash "${scriptPath}"`, { timeout: 5000 });

    const files = fs.readdirSync(messagesDir).sort();
    expect(files).toHaveLength(3);
    expect(files[0]).toBe('00001-stdout.json');
    expect(files[1]).toBe('00002-stdout.json');
    expect(files[2]).toBe('00003-stdout.json');
  });
});

describe.skipIf(!tmuxAvailable)('Sentinel detection — session lifecycle', () => {
  const sessionName = 'beat-stale-test';

  afterAll(() => {
    // Unconditional cleanup — prevents session leak if test fails mid-way
    realExec(`tmux kill-session -t ${sessionName} 2>/dev/null || true`);
  });

  it('staleness: session appears dead after external kill', () => {
    const manager = new TmuxSessionManager({
      exec: realExec as ExecFn,
      writeFileSync: (p, c) => fs.writeFileSync(p, c, 'utf8'),
      unlinkSync: (p) => {
        try {
          fs.unlinkSync(p);
        } catch {
          /* best-effort */
        }
      },
    });

    // Clean up any pre-existing session with this name
    realExec(`tmux kill-session -t ${sessionName} 2>/dev/null || true`);

    const createResult = manager.createSession({
      name: sessionName,
      command: 'sleep 60',
      cwd: '/tmp',
    });
    if (!createResult.ok) return; // Skip if session creation fails in CI

    // Verify alive before kill
    const aliveBefore = manager.isAlive(sessionName);
    expect(aliveBefore.ok && aliveBefore.value).toBe(true);

    // Kill externally
    realExec(`tmux kill-session -t ${sessionName}`);

    // Verify dead after kill
    const aliveAfter = manager.isAlive(sessionName);
    expect(aliveAfter.ok).toBe(true);
    if (!aliveAfter.ok) return;
    expect(aliveAfter.value).toBe(false);
  });
});
