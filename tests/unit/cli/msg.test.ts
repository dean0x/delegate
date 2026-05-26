/**
 * Tests for msg CLI command parsing.
 * ARCHITECTURE: Tests pure parseMsgArgs — no side effects, no process.exit().
 */

import { describe, expect, it } from 'vitest';
import { parseMsgArgs } from '../../../src/cli/commands/msg';

describe('parseMsgArgs', () => {
  // ─── Basic target parsing ────────────────────────────────────────────────────

  describe('basic target parsing', () => {
    it('parses channel-only target', () => {
      const result = parseMsgArgs(['my-channel', 'hello world']);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.channelName).toBe('my-channel');
      expect(result.value.memberName).toBeUndefined();
      expect(result.value.message).toBe('hello world');
    });

    it('parses channel/member target', () => {
      const result = parseMsgArgs(['my-channel/alice', 'hello alice']);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.channelName).toBe('my-channel');
      expect(result.value.memberName).toBe('alice');
      expect(result.value.message).toBe('hello alice');
    });

    it('joins multi-word message with spaces', () => {
      const result = parseMsgArgs(['ch', 'this', 'is', 'a', 'multi-word', 'message']);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.message).toBe('this is a multi-word message');
    });
  });

  // ─── Slash delimiter ─────────────────────────────────────────────────────────

  describe('/ delimiter behavior', () => {
    it('splits on first slash only (member name may contain slashes in theory)', () => {
      // member name is everything after the first slash
      const result = parseMsgArgs(['ch/member', 'msg']);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.channelName).toBe('ch');
      expect(result.value.memberName).toBe('member');
    });

    it('rejects empty member name after slash', () => {
      const result = parseMsgArgs(['my-channel/', 'hello']);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error).toContain('Empty member name');
    });

    it('handles no slash correctly', () => {
      const result = parseMsgArgs(['my-channel', 'hello']);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.memberName).toBeUndefined();
    });
  });

  // ─── Message extraction ──────────────────────────────────────────────────────

  describe('message extraction', () => {
    it('rejects missing message', () => {
      const result = parseMsgArgs(['my-channel']);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error).toContain('Message text is required');
    });

    it('rejects empty args', () => {
      const result = parseMsgArgs([]);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error).toContain('Usage');
    });
  });

  // ─── Message length validation ───────────────────────────────────────────────

  describe('message length validation', () => {
    it('accepts message at exactly the limit', () => {
      const message = 'a'.repeat(262144);
      const result = parseMsgArgs(['ch', message]);
      expect(result.ok).toBe(true);
    });

    it('rejects message exceeding 262144 chars', () => {
      const message = 'a'.repeat(262145);
      const result = parseMsgArgs(['ch', message]);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error).toContain('Message too long');
      expect(result.error).toContain('262145');
    });
  });

  // ─── Channel name validation ─────────────────────────────────────────────────

  describe('channel name validation', () => {
    it('accepts valid channel names', () => {
      for (const name of ['abc', 'my-channel', 'a1b2c3']) {
        const result = parseMsgArgs([name, 'message']);
        expect(result.ok).toBe(true);
      }
    });

    it('rejects channel names with uppercase letters', () => {
      const result = parseMsgArgs(['MyChannel', 'message']);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error).toContain('Invalid channel name');
    });

    it('rejects channel names with spaces', () => {
      // 'my channel' split by shell would be 'my' as target and 'channel message' as message
      // But if passed as a single string: the split would produce an invalid channel name
      const result = parseMsgArgs(['my channel/member', 'message']);
      expect(result.ok).toBe(false);
    });
  });
});
