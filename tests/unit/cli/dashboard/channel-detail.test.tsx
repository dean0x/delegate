/**
 * Tests for ChannelDetail view component.
 * Tests behavior (visible content), not rendering internals.
 */

import { render } from 'ink-testing-library';
import React from 'react';
import { describe, expect, it } from 'vitest';
import type { DetailOutputConfig } from '../../../../src/cli/dashboard/components/detail-output-panel.js';
import type { DashboardData } from '../../../../src/cli/dashboard/types.js';
import { ChannelDetail } from '../../../../src/cli/dashboard/views/channel-detail.js';
import { DetailView } from '../../../../src/cli/dashboard/views/detail-view.js';
import type { Channel, ChannelMember, ChannelMessage } from '../../../../src/core/domain.js';
import { ChannelId, ChannelMemberStatus, ChannelStatus } from '../../../../src/core/domain.js';

// ============================================================================
// Test fixtures
// ============================================================================

function makeMember(overrides: Partial<ChannelMember> = {}): ChannelMember {
  return {
    name: 'agent-a',
    agent: 'claude' as ChannelMember['agent'],
    tmuxSession: 'beat-channel-research-agent-a',
    status: ChannelMemberStatus.ACTIVE,
    joinedAt: Date.now() - 10_000,
    ...overrides,
  };
}

function makeChannel(overrides: Partial<Channel> = {}): Channel {
  return {
    id: ChannelId('ch-test-001'),
    name: 'research',
    members: [makeMember()],
    communicationMode: 'broadcast',
    topic: 'Quarterly research collaboration',
    status: ChannelStatus.ACTIVE,
    maxRounds: 10,
    currentRound: 3,
    createdAt: Date.now() - 120_000,
    updatedAt: Date.now() - 30_000,
    ...overrides,
  } as Channel;
}

function makeMessage(overrides: Partial<ChannelMessage> = {}): ChannelMessage {
  return {
    id: 'msg-001',
    channelId: ChannelId('ch-test-001'),
    fromMember: 'agent-a',
    toMember: 'agent-b',
    round: 1,
    summary: 'Initial findings summary here',
    createdAt: Date.now() - 5_000,
    ...overrides,
  };
}

// ============================================================================
// Channel header fields
// ============================================================================

describe('ChannelDetail — header fields', () => {
  it('shows Channel Detail header', () => {
    const channel = makeChannel();
    const { lastFrame } = render(
      <ChannelDetail channel={channel} scrollOffset={0} animFrame={0} selectedMemberName={null} panePreview={null} />,
    );
    expect(lastFrame()).toContain('Channel Detail');
  });

  it('shows channel ID', () => {
    const channel = makeChannel();
    const { lastFrame } = render(
      <ChannelDetail channel={channel} scrollOffset={0} animFrame={0} selectedMemberName={null} panePreview={null} />,
    );
    expect(lastFrame()).toContain('ch-test-001');
  });

  it('shows channel name', () => {
    const channel = makeChannel({ name: 'research' });
    const { lastFrame } = render(
      <ChannelDetail channel={channel} scrollOffset={0} animFrame={0} selectedMemberName={null} panePreview={null} />,
    );
    expect(lastFrame()).toContain('research');
  });

  it('shows channel status', () => {
    const channel = makeChannel({ status: ChannelStatus.ACTIVE });
    const { lastFrame } = render(
      <ChannelDetail channel={channel} scrollOffset={0} animFrame={0} selectedMemberName={null} panePreview={null} />,
    );
    expect(lastFrame()).toContain('active');
  });

  it('shows communication mode when present', () => {
    const channel = makeChannel({ communicationMode: 'broadcast' });
    const { lastFrame } = render(
      <ChannelDetail channel={channel} scrollOffset={0} animFrame={0} selectedMemberName={null} panePreview={null} />,
    );
    expect(lastFrame()).toContain('broadcast');
  });

  it('hides mode field when communicationMode is undefined', () => {
    const channel = makeChannel({ communicationMode: undefined });
    const { lastFrame } = render(
      <ChannelDetail channel={channel} scrollOffset={0} animFrame={0} selectedMemberName={null} panePreview={null} />,
    );
    expect(lastFrame()).not.toContain('Mode');
  });

  it('shows topic when present', () => {
    const channel = makeChannel({ topic: 'Quarterly research collaboration' });
    const { lastFrame } = render(
      <ChannelDetail channel={channel} scrollOffset={0} animFrame={0} selectedMemberName={null} panePreview={null} />,
    );
    expect(lastFrame()).toContain('Quarterly research collaboration');
  });

  it('hides topic field when topic is undefined', () => {
    const channel = makeChannel({ topic: undefined });
    const { lastFrame } = render(
      <ChannelDetail channel={channel} scrollOffset={0} animFrame={0} selectedMemberName={null} panePreview={null} />,
    );
    expect(lastFrame()).not.toContain('Topic');
  });
});

// ============================================================================
// Round progress
// ============================================================================

describe('ChannelDetail — round progress', () => {
  it('shows round progress when maxRounds is set', () => {
    const channel = makeChannel({ currentRound: 3, maxRounds: 10 });
    const { lastFrame } = render(
      <ChannelDetail channel={channel} scrollOffset={0} animFrame={0} selectedMemberName={null} panePreview={null} />,
    );
    expect(lastFrame()).toContain('3/10');
  });

  it('hides round progress when maxRounds is undefined', () => {
    const channel = makeChannel({ maxRounds: undefined, currentRound: 3 });
    const { lastFrame } = render(
      <ChannelDetail channel={channel} scrollOffset={0} animFrame={0} selectedMemberName={null} panePreview={null} />,
    );
    expect(lastFrame()).not.toContain('Round Progress');
  });

  it('hides round progress when maxRounds is 0', () => {
    const channel = makeChannel({ maxRounds: 0, currentRound: 3 });
    const { lastFrame } = render(
      <ChannelDetail channel={channel} scrollOffset={0} animFrame={0} selectedMemberName={null} panePreview={null} />,
    );
    expect(lastFrame()).not.toContain('Round Progress');
  });
});

// ============================================================================
// Member list
// ============================================================================

describe('ChannelDetail — member list', () => {
  it('shows member section header', () => {
    const channel = makeChannel();
    const { lastFrame } = render(
      <ChannelDetail channel={channel} scrollOffset={0} animFrame={0} selectedMemberName={null} panePreview={null} />,
    );
    expect(lastFrame()).toContain('Members');
  });

  it('shows member names', () => {
    const channel = makeChannel({
      members: [makeMember({ name: 'agent-a' }), makeMember({ name: 'agent-b' })],
    });
    const { lastFrame } = render(
      <ChannelDetail channel={channel} scrollOffset={0} animFrame={0} selectedMemberName={null} panePreview={null} />,
    );
    expect(lastFrame()).toContain('agent-a');
    expect(lastFrame()).toContain('agent-b');
  });

  it('shows member count in section header', () => {
    const channel = makeChannel({
      members: [makeMember({ name: 'agent-a' }), makeMember({ name: 'agent-b' })],
    });
    const { lastFrame } = render(
      <ChannelDetail channel={channel} scrollOffset={0} animFrame={0} selectedMemberName={null} panePreview={null} />,
    );
    expect(lastFrame()).toContain('(2 total)');
  });

  it('shows member agent type', () => {
    const channel = makeChannel({
      members: [makeMember({ name: 'agent-a', agent: 'claude' as ChannelMember['agent'] })],
    });
    const { lastFrame } = render(
      <ChannelDetail channel={channel} scrollOffset={0} animFrame={0} selectedMemberName={null} panePreview={null} />,
    );
    expect(lastFrame()).toContain('claude');
  });

  it('shows "No members" when members array is empty', () => {
    const channel = makeChannel({ members: [] });
    const { lastFrame } = render(
      <ChannelDetail channel={channel} scrollOffset={0} animFrame={0} selectedMemberName={null} panePreview={null} />,
    );
    expect(lastFrame()).toContain('No members');
  });

  it('shows ● icon for active members', () => {
    const channel = makeChannel({
      members: [makeMember({ status: ChannelMemberStatus.ACTIVE })],
    });
    const { lastFrame } = render(
      <ChannelDetail channel={channel} scrollOffset={0} animFrame={0} selectedMemberName={null} panePreview={null} />,
    );
    expect(lastFrame()).toContain('●');
  });

  it('shows ○ icon for destroyed members', () => {
    const channel = makeChannel({
      members: [makeMember({ status: ChannelMemberStatus.DESTROYED })],
    });
    const { lastFrame } = render(
      <ChannelDetail channel={channel} scrollOffset={0} animFrame={0} selectedMemberName={null} panePreview={null} />,
    );
    expect(lastFrame()).toContain('○');
  });

  it('shows "destroyed" label for destroyed member status', () => {
    const channel = makeChannel({
      members: [makeMember({ name: 'agent-a', status: ChannelMemberStatus.DESTROYED })],
    });
    const { lastFrame } = render(
      <ChannelDetail channel={channel} scrollOffset={0} animFrame={0} selectedMemberName={null} panePreview={null} />,
    );
    expect(lastFrame()).toContain('destroyed');
  });
});

// ============================================================================
// Recent Activity / Messages
// ============================================================================

describe('ChannelDetail — recent activity', () => {
  it('shows Recent Activity section header', () => {
    const channel = makeChannel();
    const { lastFrame } = render(
      <ChannelDetail channel={channel} scrollOffset={0} animFrame={0} selectedMemberName={null} panePreview={null} />,
    );
    expect(lastFrame()).toContain('Recent Activity');
  });

  it('shows "No messages yet" when messages is empty', () => {
    const channel = makeChannel();
    const { lastFrame } = render(
      <ChannelDetail
        channel={channel}
        messages={[]}
        scrollOffset={0}
        animFrame={0}
        selectedMemberName={null}
        panePreview={null}
      />,
    );
    expect(lastFrame()).toContain('No messages yet');
  });

  it('shows "No messages yet" when messages is undefined', () => {
    const channel = makeChannel();
    const { lastFrame } = render(
      <ChannelDetail
        channel={channel}
        messages={undefined}
        scrollOffset={0}
        animFrame={0}
        selectedMemberName={null}
        panePreview={null}
      />,
    );
    expect(lastFrame()).toContain('No messages yet');
  });

  it('shows message with from → to format', () => {
    const channel = makeChannel();
    const msg = makeMessage({ fromMember: 'agent-a', toMember: 'agent-b' });
    const { lastFrame } = render(
      <ChannelDetail
        channel={channel}
        messages={[msg]}
        scrollOffset={0}
        animFrame={0}
        selectedMemberName={null}
        panePreview={null}
      />,
    );
    expect(lastFrame()).toContain('agent-a');
    expect(lastFrame()).toContain('agent-b');
  });

  it('shows round number in message row', () => {
    const channel = makeChannel();
    const msg = makeMessage({ round: 3 });
    const { lastFrame } = render(
      <ChannelDetail
        channel={channel}
        messages={[msg]}
        scrollOffset={0}
        animFrame={0}
        selectedMemberName={null}
        panePreview={null}
      />,
    );
    expect(lastFrame()).toContain('[R3]');
  });

  it('shows "(broadcast)" when toMember is null', () => {
    const channel = makeChannel();
    const msg = makeMessage({ toMember: null });
    const { lastFrame } = render(
      <ChannelDetail
        channel={channel}
        messages={[msg]}
        scrollOffset={0}
        animFrame={0}
        selectedMemberName={null}
        panePreview={null}
      />,
    );
    expect(lastFrame()).toContain('(broadcast)');
  });

  it('shows message summary text', () => {
    const channel = makeChannel();
    const msg = makeMessage({ summary: 'Initial findings summary here' });
    const { lastFrame } = render(
      <ChannelDetail
        channel={channel}
        messages={[msg]}
        scrollOffset={0}
        animFrame={0}
        selectedMemberName={null}
        panePreview={null}
      />,
    );
    expect(lastFrame()).toContain('Initial findings summary here');
  });

  it('shows message count in section header when messages present', () => {
    const channel = makeChannel();
    const msgs = [makeMessage({ id: 'msg-1' }), makeMessage({ id: 'msg-2' })];
    const { lastFrame } = render(
      <ChannelDetail
        channel={channel}
        messages={msgs}
        scrollOffset={0}
        animFrame={0}
        selectedMemberName={null}
        panePreview={null}
      />,
    );
    expect(lastFrame()).toContain('(2 messages)');
  });
});

// ============================================================================
// Live Preview
// ============================================================================

describe('ChannelDetail — live preview', () => {
  it('shows live preview section label', () => {
    const channel = makeChannel({
      members: [makeMember({ name: 'agent-a' })],
    });
    const { lastFrame } = render(
      <ChannelDetail
        channel={channel}
        scrollOffset={0}
        animFrame={0}
        selectedMemberName="agent-a"
        panePreview={null}
      />,
    );
    expect(lastFrame()).toContain('Live Preview');
  });

  it('shows selected member name in preview label', () => {
    const channel = makeChannel({
      members: [makeMember({ name: 'agent-a' })],
    });
    const { lastFrame } = render(
      <ChannelDetail
        channel={channel}
        scrollOffset={0}
        animFrame={0}
        selectedMemberName="agent-a"
        panePreview={null}
      />,
    );
    expect(lastFrame()).toContain('(agent-a)');
  });

  it('shows pane preview content when provided', () => {
    const channel = makeChannel({
      members: [makeMember({ name: 'agent-a' })],
    });
    const { lastFrame } = render(
      <ChannelDetail
        channel={channel}
        scrollOffset={0}
        animFrame={0}
        selectedMemberName="agent-a"
        panePreview="$ running analysis..."
      />,
    );
    expect(lastFrame()).toContain('$ running analysis...');
  });

  it('shows "(session not responding)" when panePreview is null with a selected member', () => {
    const channel = makeChannel({
      members: [makeMember({ name: 'agent-a' })],
    });
    const { lastFrame } = render(
      <ChannelDetail
        channel={channel}
        scrollOffset={0}
        animFrame={0}
        selectedMemberName="agent-a"
        panePreview={null}
      />,
    );
    expect(lastFrame()).toContain('(session not responding)');
  });

  it('shows "(no member selected)" when channel has no members', () => {
    const channel = makeChannel({ members: [] });
    const { lastFrame } = render(
      <ChannelDetail channel={channel} scrollOffset={0} animFrame={0} selectedMemberName={null} panePreview={null} />,
    );
    expect(lastFrame()).toContain('(no member selected)');
  });

  it('defaults to first member preview label when selectedMemberName is null but members exist', () => {
    const channel = makeChannel({
      members: [makeMember({ name: 'first-member' })],
    });
    const { lastFrame } = render(
      <ChannelDetail channel={channel} scrollOffset={0} animFrame={0} selectedMemberName={null} panePreview={null} />,
    );
    // Should fall back to first member "first-member"
    expect(lastFrame()).toContain('first-member');
  });
});

// ============================================================================
// DetailView dispatcher — channel route
// ============================================================================

const NO_OUTPUT_CONFIG: DetailOutputConfig = {
  visible: false,
  autoTail: true,
  scrollOffset: 0,
  terminalRows: 24,
};

function makeDashboardData(overrides: Partial<DashboardData> = {}): DashboardData {
  return {
    tasks: [],
    loops: [],
    schedules: [],
    orchestrations: [],
    pipelines: [],
    channels: [],
    taskCounts: { total: 0, byStatus: {} },
    loopCounts: { total: 0, byStatus: {} },
    scheduleCounts: { total: 0, byStatus: {} },
    orchestrationCounts: { total: 0, byStatus: {} },
    pipelineCounts: { total: 0, byStatus: {} },
    channelCounts: { total: 0, byStatus: {} },
    ...overrides,
  };
}

describe('DetailView — channel dispatch', () => {
  it('shows NotFound when channel entity is not in data', () => {
    const data = makeDashboardData({ channels: [] });
    const { lastFrame } = render(
      <DetailView
        entityType="channels"
        entityId="ch-missing"
        data={data}
        scrollOffset={0}
        animFrame={0}
        detailOutputConfig={NO_OUTPUT_CONFIG}
      />,
    );
    expect(lastFrame()).toContain('Entity not found');
  });

  it('dispatches to ChannelDetail for channels entityType', () => {
    const channel = makeChannel();
    const data = makeDashboardData({ channels: [channel] });
    const { lastFrame } = render(
      <DetailView
        entityType="channels"
        entityId={channel.id}
        data={data}
        scrollOffset={0}
        animFrame={0}
        detailOutputConfig={NO_OUTPUT_CONFIG}
      />,
    );
    expect(lastFrame()).toContain('Channel Detail');
    expect(lastFrame()).toContain(channel.id);
  });

  it('passes messages from data.channelMessages to ChannelDetail', () => {
    const channel = makeChannel();
    const msg = makeMessage({ summary: 'Test message summary' });
    const data = makeDashboardData({
      channels: [channel],
      channelMessages: [msg],
    });
    const { lastFrame } = render(
      <DetailView
        entityType="channels"
        entityId={channel.id}
        data={data}
        scrollOffset={0}
        animFrame={0}
        detailOutputConfig={NO_OUTPUT_CONFIG}
      />,
    );
    expect(lastFrame()).toContain('Test message summary');
  });

  it('passes channelMemberSelectedName to ChannelDetail', () => {
    const channel = makeChannel({
      members: [makeMember({ name: 'agent-a' }), makeMember({ name: 'agent-b' })],
    });
    const data = makeDashboardData({ channels: [channel] });
    const { lastFrame } = render(
      <DetailView
        entityType="channels"
        entityId={channel.id}
        data={data}
        scrollOffset={0}
        animFrame={0}
        detailOutputConfig={NO_OUTPUT_CONFIG}
        channelMemberSelectedName="agent-a"
        panePreview={null}
      />,
    );
    // Selected member "agent-a" should appear in the live preview label
    expect(lastFrame()).toContain('(agent-a)');
  });

  it('passes panePreview to ChannelDetail', () => {
    const channel = makeChannel({
      members: [makeMember({ name: 'agent-a' })],
    });
    const data = makeDashboardData({ channels: [channel] });
    const { lastFrame } = render(
      <DetailView
        entityType="channels"
        entityId={channel.id}
        data={data}
        scrollOffset={0}
        animFrame={0}
        detailOutputConfig={NO_OUTPUT_CONFIG}
        channelMemberSelectedName="agent-a"
        panePreview="pane output here"
      />,
    );
    expect(lastFrame()).toContain('pane output here');
  });
});
