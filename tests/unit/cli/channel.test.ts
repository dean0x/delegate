/**
 * Tests for channel CLI command parsing.
 * ARCHITECTURE: Tests pure parsing functions — no side effects, no process.exit().
 * Pattern follows parse-loop-create-args test style.
 */

import { describe, expect, it } from 'vitest';
import { type ParsedChannelCreate, parseChannelCreateArgs } from '../../../src/cli/commands/channel';

const cwd = process.cwd();

describe('parseChannelCreateArgs', () => {
  // ─── Single-agent mode ──────────────────────────────────────────────────────

  describe('single-agent mode (--agent flag)', () => {
    it('returns valid single-agent parsed args with minimal flags', () => {
      const result = parseChannelCreateArgs(['my-channel', '--agent', 'claude']);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.mode).toBe('single');
      expect(result.value.name).toBe('my-channel');
      if (result.value.mode !== 'single') return;
      expect(result.value.agent).toBe('claude');
    });

    it('accepts all single-agent optional flags', () => {
      const result = parseChannelCreateArgs([
        'my-channel',
        '--agent',
        'claude',
        '--topic',
        'analyze this codebase',
        '--working-directory',
        cwd,
        '--system-prompt',
        'You are a helpful assistant',
      ]);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.mode).toBe('single');
      if (result.value.mode !== 'single') return;
      expect(result.value.topic).toBe('analyze this codebase');
      expect(result.value.workingDirectory).toBe(cwd);
      expect(result.value.systemPrompt).toBe('You are a helpful assistant');
    });

    it('accepts codex as agent', () => {
      const result = parseChannelCreateArgs(['my-channel', '--agent', 'codex']);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      if (result.value.mode !== 'single') return;
      expect(result.value.agent).toBe('codex');
    });

    it('rejects unknown agent provider', () => {
      const result = parseChannelCreateArgs(['my-channel', '--agent', 'gpt4']);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error).toContain('gpt4');
      expect(result.error).toContain('Unknown agent');
    });

    it('rejects --max-rounds with single-agent mode', () => {
      const result = parseChannelCreateArgs(['my-channel', '--agent', 'claude', '--max-rounds', '10']);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error).toContain('--max-rounds');
      expect(result.error).toContain('single-agent');
    });

    it('rejects --mode with single-agent mode', () => {
      const result = parseChannelCreateArgs(['my-channel', '--agent', 'claude', '--mode', 'broadcast']);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error).toContain('--mode');
    });
  });

  // ─── Multi-agent mode ───────────────────────────────────────────────────────

  describe('multi-agent mode (--member flags)', () => {
    it('returns valid multi-agent parsed args with required flags', () => {
      const result = parseChannelCreateArgs([
        'code-review',
        '--member',
        'author:claude',
        '--member',
        'reviewer:codex',
        '--max-rounds',
        '10',
      ]);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.mode).toBe('multi');
      if (result.value.mode !== 'multi') return;
      expect(result.value.members).toHaveLength(2);
      expect(result.value.members[0]).toMatchObject({ name: 'author', agent: 'claude' });
      expect(result.value.members[1]).toMatchObject({ name: 'reviewer', agent: 'codex' });
    });

    it('parses member with prompt containing colons', () => {
      const result = parseChannelCreateArgs([
        'debug-channel',
        '--member',
        'debugger:claude:You are a debugger: be precise.',
        '--max-rounds',
        '5',
      ]);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      if (result.value.mode !== 'multi') return;
      expect(result.value.members[0]?.systemPrompt).toBe('You are a debugger: be precise.');
    });

    it('accepts valid communication mode', () => {
      const result = parseChannelCreateArgs([
        'my-channel',
        '--member',
        'agent1:claude',
        '--mode',
        'round-robin',
        '--max-rounds',
        '20',
      ]);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      if (result.value.mode !== 'multi') return;
      expect(result.value.communicationMode).toBe('round-robin');
    });

    it('accepts broadcast and directed modes', () => {
      for (const mode of ['broadcast', 'directed'] as const) {
        const result = parseChannelCreateArgs([
          'my-channel',
          '--member',
          'agent1:claude',
          '--mode',
          mode,
          '--max-rounds',
          '5',
        ]);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        if (result.value.mode !== 'multi') return;
        expect(result.value.communicationMode).toBe(mode);
      }
    });

    it('rejects invalid communication mode', () => {
      const result = parseChannelCreateArgs([
        'my-channel',
        '--member',
        'agent1:claude',
        '--mode',
        'gossip',
        '--max-rounds',
        '5',
      ]);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error).toContain('broadcast, directed, or round-robin');
    });

    it('rejects --max-rounds missing for multi-agent', () => {
      const result = parseChannelCreateArgs(['my-channel', '--member', 'agent1:claude', '--member', 'agent2:codex']);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error).toContain('--max-rounds');
    });

    it('rejects --system-prompt with multi-agent mode', () => {
      const result = parseChannelCreateArgs([
        'my-channel',
        '--member',
        'agent1:claude',
        '--max-rounds',
        '5',
        '--system-prompt',
        'global prompt',
      ]);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error).toContain('--system-prompt');
    });
  });

  // ─── Mutual exclusion ───────────────────────────────────────────────────────

  describe('mutual exclusion: --agent + --member', () => {
    it('rejects combining --agent with --member', () => {
      const result = parseChannelCreateArgs(['my-channel', '--agent', 'claude', '--member', 'other:codex']);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error).toContain('mutually exclusive');
    });
  });

  // ─── Member format edge cases ───────────────────────────────────────────────

  describe('--member format edge cases', () => {
    it('rejects member missing colon separator', () => {
      const result = parseChannelCreateArgs(['my-channel', '--member', 'nameonly', '--max-rounds', '5']);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error).toContain('name:agent');
    });

    it('rejects empty member name', () => {
      const result = parseChannelCreateArgs(['my-channel', '--member', ':claude', '--max-rounds', '5']);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error).toContain('empty');
    });

    it('rejects empty agent in member', () => {
      const result = parseChannelCreateArgs(['my-channel', '--member', 'name:', '--max-rounds', '5']);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error).toContain('empty');
    });

    it('rejects unknown agent in member', () => {
      const result = parseChannelCreateArgs(['my-channel', '--member', 'agent1:unknownprovider', '--max-rounds', '5']);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error).toContain('unknownprovider');
    });

    it('member without prompt has undefined systemPrompt', () => {
      const result = parseChannelCreateArgs(['my-channel', '--member', 'agent1:claude', '--max-rounds', '5']);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      if (result.value.mode !== 'multi') return;
      expect(result.value.members[0]?.systemPrompt).toBeUndefined();
    });
  });

  // ─── Channel name validation ─────────────────────────────────────────────────

  describe('channel name validation', () => {
    it('accepts valid lowercase alphanumeric names', () => {
      for (const name of ['abc', 'my-channel', 'a1b2c3', 'code-review-2024']) {
        const result = parseChannelCreateArgs([name, '--agent', 'claude']);
        expect(result.ok).toBe(true);
      }
    });

    it('rejects names with uppercase letters', () => {
      const result = parseChannelCreateArgs(['MyChannel', '--agent', 'claude']);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error).toContain('Invalid channel name');
    });

    it('rejects names starting with hyphen', () => {
      const result = parseChannelCreateArgs(['-my-channel', '--agent', 'claude']);
      // Note: -my-channel will be treated as a flag, not a positional arg
      // The parsing will either see it as an unknown flag or as no channel name
      expect(result.ok).toBe(false);
    });

    it('rejects names with spaces', () => {
      const result = parseChannelCreateArgs(['my channel', '--agent', 'claude']);
      // 'my channel' as one string is passed; only the first word is the channel name
      // The second word becomes an unknown flag → error, or name doesn't match regex
      expect(result.ok).toBe(false);
    });

    it('rejects empty channel name', () => {
      const result = parseChannelCreateArgs(['--agent', 'claude']);
      expect(result.ok).toBe(false);
    });
  });

  // ─── maxRounds range validation ──────────────────────────────────────────────

  describe('maxRounds range validation', () => {
    it('accepts valid maxRounds values', () => {
      for (const n of ['1', '100', '10000']) {
        const result = parseChannelCreateArgs(['my-channel', '--member', 'agent1:claude', '--max-rounds', n]);
        expect(result.ok).toBe(true);
      }
    });

    it('rejects maxRounds of 0', () => {
      const result = parseChannelCreateArgs(['my-channel', '--member', 'agent1:claude', '--max-rounds', '0']);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error).toContain('1 and 10000');
    });

    it('rejects negative maxRounds', () => {
      const result = parseChannelCreateArgs(['my-channel', '--member', 'agent1:claude', '--max-rounds', '-1']);
      expect(result.ok).toBe(false);
    });

    it('rejects maxRounds above 10000', () => {
      const result = parseChannelCreateArgs(['my-channel', '--member', 'agent1:claude', '--max-rounds', '10001']);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error).toContain('10000');
    });

    it('rejects non-integer maxRounds', () => {
      const result = parseChannelCreateArgs(['my-channel', '--member', 'agent1:claude', '--max-rounds', '5.5']);
      expect(result.ok).toBe(false);
    });
  });

  // ─── system-prompt length validation ─────────────────────────────────────────

  describe('--system-prompt length validation', () => {
    it('accepts system-prompt at the 100,000 character limit', () => {
      const result = parseChannelCreateArgs([
        'my-channel',
        '--agent',
        'claude',
        '--system-prompt',
        'a'.repeat(100_000),
      ]);
      expect(result.ok).toBe(true);
    });

    it('rejects system-prompt exceeding 100,000 characters', () => {
      const result = parseChannelCreateArgs([
        'my-channel',
        '--agent',
        'claude',
        '--system-prompt',
        'a'.repeat(100_001),
      ]);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error).toContain('100,000');
    });
  });

  // ─── working-directory validation ─────────────────────────────────────────────

  describe('--working-directory validation', () => {
    it('rejects a path that traverses outside the working directory', () => {
      const result = parseChannelCreateArgs([
        'my-channel',
        '--agent',
        'claude',
        '--working-directory',
        '../../etc/passwd',
      ]);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error).toContain('Invalid working directory');
    });
  });

  // ─── Shorthand flags ──────────────────────────────────────────────────────────

  describe('shorthand flags', () => {
    it('accepts -a as shorthand for --agent', () => {
      const result = parseChannelCreateArgs(['my-channel', '-a', 'claude']);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.mode).toBe('single');
      if (result.value.mode !== 'single') return;
      expect(result.value.agent).toBe('claude');
    });

    it('accepts -w as shorthand for --working-directory', () => {
      const result = parseChannelCreateArgs(['my-channel', '--agent', 'claude', '-w', cwd]);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      if (result.value.mode !== 'single') return;
      expect(result.value.workingDirectory).toBe(cwd);
    });
  });

  // ─── Unknown flags ───────────────────────────────────────────────────────────

  describe('unknown flags', () => {
    it('rejects unknown flags', () => {
      const result = parseChannelCreateArgs(['my-channel', '--agent', 'claude', '--unknown-flag', 'value']);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error).toContain('Unknown flag');
    });
  });

  // ─── Topic length validation ──────────────────────────────────────────────────

  describe('--topic length validation', () => {
    it('accepts topic within the 262,144 character limit', () => {
      const result = parseChannelCreateArgs(['my-channel', '--agent', 'claude', '--topic', 'a'.repeat(262_144)]);
      expect(result.ok).toBe(true);
    });

    it('rejects topic exceeding 262,144 characters', () => {
      const result = parseChannelCreateArgs(['my-channel', '--agent', 'claude', '--topic', 'a'.repeat(262_145)]);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error).toContain('262,144');
    });
  });

  // ─── Combined flags (integration) ────────────────────────────────────────────

  describe('combined flags', () => {
    it('parses all valid multi-agent flags together', () => {
      const result = parseChannelCreateArgs([
        'full-channel',
        '--member',
        'writer:claude:You write code.',
        '--member',
        'reviewer:codex',
        '--mode',
        'directed',
        '--max-rounds',
        '50',
        '--topic',
        'Build a REST API',
        '--working-directory',
        cwd,
      ]);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.mode).toBe('multi');
      if (result.value.mode !== 'multi') return;
      expect(result.value.name).toBe('full-channel');
      expect(result.value.members).toHaveLength(2);
      expect(result.value.members[0]?.systemPrompt).toBe('You write code.');
      expect(result.value.members[1]?.systemPrompt).toBeUndefined();
      expect(result.value.communicationMode).toBe('directed');
      expect(result.value.maxRounds).toBe(50);
      expect(result.value.topic).toBe('Build a REST API');
      expect(result.value.workingDirectory).toBe(cwd);
    });
  });
});
