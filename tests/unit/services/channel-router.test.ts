/**
 * Unit tests for ChannelRouter
 * Pure stateless routing logic — no mocks needed for these.
 */

import { describe, expect, it } from 'vitest';
import { ChannelMemberStatus, ChannelStatus } from '../../../src/core/domain.js';
import type { Channel, ChannelMember } from '../../../src/core/domain.js';
import { ChannelRouter } from '../../../src/services/channel-router.js';

// ─── Test helpers ─────────────────────────────────────────────────────────────

function makeMember(name: string, status: ChannelMemberStatus = ChannelMemberStatus.ACTIVE): ChannelMember {
  return {
    name,
    agent: 'claude',
    tmuxSession: `beat-channel-test-${name}`,
    status,
    joinedAt: Date.now(),
  };
}

function makeChannel(
  members: ChannelMember[],
  communicationMode?: 'broadcast' | 'directed' | 'round-robin',
): Channel {
  return {
    id: 'ch-test-id' as Channel['id'],
    name: 'test-channel',
    members,
    communicationMode,
    status: ChannelStatus.ACTIVE,
    currentRound: 0,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
}

// ─── ChannelRouter.route() ────────────────────────────────────────────────────

describe('ChannelRouter.route()', () => {
  describe('broadcast mode', () => {
    it('routes to all active members except sender', () => {
      const members = [makeMember('a'), makeMember('b'), makeMember('c')];
      const channel = makeChannel(members, 'broadcast');

      const result = ChannelRouter.route(channel, 'a');
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const targetNames = result.value.targets.map((t) => t.memberName);
      expect(targetNames).toContain('b');
      expect(targetNames).toContain('c');
      expect(targetNames).not.toContain('a');
    });

    it('skips destroyed members', () => {
      const members = [makeMember('a'), makeMember('b'), makeMember('c', ChannelMemberStatus.DESTROYED)];
      const channel = makeChannel(members, 'broadcast');

      const result = ChannelRouter.route(channel, 'a');
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const targetNames = result.value.targets.map((t) => t.memberName);
      expect(targetNames).toEqual(['b']);
    });

    it('returns a single active target when only one other member is active', () => {
      const members = [makeMember('a'), makeMember('b')];
      const channel = makeChannel(members, 'broadcast');

      const result = ChannelRouter.route(channel, 'a');
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.targets).toHaveLength(1);
      expect(result.value.targets[0]!.memberName).toBe('b');
    });

    it('returns err() when no active targets remain after excluding sender', () => {
      const members = [makeMember('a'), makeMember('b', ChannelMemberStatus.DESTROYED)];
      const channel = makeChannel(members, 'broadcast');

      const result = ChannelRouter.route(channel, 'a');
      expect(result.ok).toBe(false);
    });

    it('target session names match channel member tmuxSession', () => {
      const members = [makeMember('a'), makeMember('b')];
      const channel = makeChannel(members, 'broadcast');

      const result = ChannelRouter.route(channel, 'a');
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.targets[0]!.tmuxSession).toBe('beat-channel-test-b');
    });
  });

  describe('directed mode', () => {
    it('routes to specified active target member only', () => {
      const members = [makeMember('a'), makeMember('b'), makeMember('c')];
      const channel = makeChannel(members, 'directed');

      const result = ChannelRouter.route(channel, 'a', 'b');
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.targets).toHaveLength(1);
      expect(result.value.targets[0]!.memberName).toBe('b');
    });

    it('falls back to broadcast when directed target is unknown', () => {
      const members = [makeMember('a'), makeMember('b'), makeMember('c')];
      const channel = makeChannel(members, 'directed');

      const result = ChannelRouter.route(channel, 'a', 'unknown');
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const targetNames = result.value.targets.map((t) => t.memberName);
      expect(targetNames).toContain('b');
      expect(targetNames).toContain('c');
      expect(targetNames).not.toContain('a');
    });

    it('falls back to broadcast when directed target is destroyed', () => {
      const members = [makeMember('a'), makeMember('b'), makeMember('c', ChannelMemberStatus.DESTROYED)];
      const channel = makeChannel(members, 'directed');

      const result = ChannelRouter.route(channel, 'a', 'c');
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const targetNames = result.value.targets.map((t) => t.memberName);
      expect(targetNames).toContain('b');
      expect(targetNames).not.toContain('c');
    });

    it('acts as broadcast when no directedTo is provided (directed mode without @mention)', () => {
      const members = [makeMember('a'), makeMember('b'), makeMember('c')];
      const channel = makeChannel(members, 'directed');

      const result = ChannelRouter.route(channel, 'a');
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const targetNames = result.value.targets.map((t) => t.memberName);
      expect(targetNames).toContain('b');
      expect(targetNames).toContain('c');
      expect(targetNames).not.toContain('a');
    });
  });

  describe('round-robin mode', () => {
    it('routes to next member in joinedAt order', () => {
      const members = [
        { ...makeMember('a'), joinedAt: 1 },
        { ...makeMember('b'), joinedAt: 2 },
        { ...makeMember('c'), joinedAt: 3 },
      ];
      const channel = makeChannel(members, 'round-robin');

      const result = ChannelRouter.route(channel, 'a');
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.targets).toHaveLength(1);
      expect(result.value.targets[0]!.memberName).toBe('b');
      expect(result.value.nextTurnMember).toBe('b');
    });

    it('wraps around to first member after last', () => {
      const members = [
        { ...makeMember('a'), joinedAt: 1 },
        { ...makeMember('b'), joinedAt: 2 },
        { ...makeMember('c'), joinedAt: 3 },
      ];
      const channel = makeChannel(members, 'round-robin');

      const result = ChannelRouter.route(channel, 'c');
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.targets[0]!.memberName).toBe('a');
      expect(result.value.nextTurnMember).toBe('a');
    });

    it('skips destroyed members in round-robin rotation', () => {
      const members = [
        { ...makeMember('a'), joinedAt: 1 },
        { ...makeMember('b', ChannelMemberStatus.DESTROYED), joinedAt: 2 },
        { ...makeMember('c'), joinedAt: 3 },
      ];
      const channel = makeChannel(members, 'round-robin');

      const result = ChannelRouter.route(channel, 'a');
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.targets[0]!.memberName).toBe('c');
    });

    it('returns err() when no active targets remain in round-robin', () => {
      const members = [
        { ...makeMember('a'), joinedAt: 1 },
        { ...makeMember('b', ChannelMemberStatus.DESTROYED), joinedAt: 2 },
      ];
      const channel = makeChannel(members, 'round-robin');

      const result = ChannelRouter.route(channel, 'a');
      expect(result.ok).toBe(false);
    });
  });

  describe('single-agent mode (no communicationMode)', () => {
    it('returns empty targets for external messages on single-agent channel', () => {
      const members = [makeMember('a')];
      const channel = makeChannel(members, undefined);

      const result = ChannelRouter.route(channel, 'external');
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.targets).toHaveLength(0);
    });
  });

  describe('unknown sender', () => {
    it('returns err() when sender is not in channel members', () => {
      const members = [makeMember('a'), makeMember('b')];
      const channel = makeChannel(members, 'broadcast');

      // Single-agent channels with no mode don't check sender — test broadcast mode
      const result = ChannelRouter.route(channel, 'unknown-sender');
      expect(result.ok).toBe(false);
    });
  });
});

// ─── ChannelRouter.parseDirectedTarget() ─────────────────────────────────────

describe('ChannelRouter.parseDirectedTarget()', () => {
  it('parses @name: prefix at start of message', () => {
    const result = ChannelRouter.parseDirectedTarget('@security: check this');
    expect(result).toEqual({ targetName: 'security', cleanMessage: 'check this' });
  });

  it('returns null when @name is not at start', () => {
    const result = ChannelRouter.parseDirectedTarget('hello @security: check');
    expect(result).toBeNull();
  });

  it('returns null when no @mention present', () => {
    const result = ChannelRouter.parseDirectedTarget('just a message');
    expect(result).toBeNull();
  });

  it('returns null for empty message', () => {
    const result = ChannelRouter.parseDirectedTarget('');
    expect(result).toBeNull();
  });

  it('parses @name with hyphens', () => {
    const result = ChannelRouter.parseDirectedTarget('@my-agent: do it');
    expect(result).toEqual({ targetName: 'my-agent', cleanMessage: 'do it' });
  });

  it('trims whitespace from cleanMessage', () => {
    const result = ChannelRouter.parseDirectedTarget('@agent:   leading spaces');
    expect(result?.cleanMessage).toBe('leading spaces');
  });

  it('handles message with content that contains colons', () => {
    const result = ChannelRouter.parseDirectedTarget('@agent: run: test:suite');
    expect(result).toEqual({ targetName: 'agent', cleanMessage: 'run: test:suite' });
  });
});

// ─── ChannelRouter.nextRoundRobinMember() ────────────────────────────────────

describe('ChannelRouter.nextRoundRobinMember()', () => {
  it('returns the next active member after current speaker', () => {
    const members = [
      { ...makeMember('a'), joinedAt: 1 },
      { ...makeMember('b'), joinedAt: 2 },
      { ...makeMember('c'), joinedAt: 3 },
    ];
    const next = ChannelRouter.nextRoundRobinMember(members, 'a');
    expect(next).toBe('b');
  });

  it('wraps around to first active member from last', () => {
    const members = [
      { ...makeMember('a'), joinedAt: 1 },
      { ...makeMember('b'), joinedAt: 2 },
      { ...makeMember('c'), joinedAt: 3 },
    ];
    const next = ChannelRouter.nextRoundRobinMember(members, 'c');
    expect(next).toBe('a');
  });

  it('skips destroyed members', () => {
    const members = [
      { ...makeMember('a'), joinedAt: 1 },
      { ...makeMember('b', ChannelMemberStatus.DESTROYED), joinedAt: 2 },
      { ...makeMember('c'), joinedAt: 3 },
    ];
    const next = ChannelRouter.nextRoundRobinMember(members, 'a');
    expect(next).toBe('c');
  });

  it('returns undefined when all other members are destroyed', () => {
    const members = [
      { ...makeMember('a'), joinedAt: 1 },
      { ...makeMember('b', ChannelMemberStatus.DESTROYED), joinedAt: 2 },
    ];
    const next = ChannelRouter.nextRoundRobinMember(members, 'a');
    expect(next).toBeUndefined();
  });
});
