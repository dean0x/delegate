/**
 * ChannelDetail — full-screen channel detail view
 * ARCHITECTURE: Pure view component — all data passed as props
 * Pattern: Functional core, no side effects
 *
 * Sections:
 *  1. Header fields — ID, name, status badge, mode, created, updated
 *  2. Round progress — currentRound / maxRounds (hidden for single-agent mode)
 *  3. Member list — scrollable, selected member highlighted by name
 *  4. Recent Activity — message summaries as [R{round}] {from} → {to}: "{summary}"
 *  5. Live Preview — capture-pane output for the selected member's tmux session
 */

import { Box, Text } from 'ink';
import React from 'react';
import type { Channel, ChannelMember, ChannelMessage } from '../../../core/domain.js';
import { ChannelMemberStatus } from '../../../core/domain.js';
import { Field, StatusField } from '../components/field.js';
import { StatusBadge } from '../components/status-badge.js';
import { formatRunProgress, relativeTime, truncateCell } from '../format.js';

export interface ChannelDetailProps {
  readonly channel: Channel;
  readonly messages?: readonly ChannelMessage[];
  readonly scrollOffset: number;
  readonly animFrame: number;
  readonly selectedMemberName: string | null;
  readonly panePreview: string | null;
}

/** Member status icon — filled dot for active/idle, hollow for destroyed */
function memberStatusIcon(status: ChannelMemberStatus): string {
  return status === ChannelMemberStatus.DESTROYED ? '○' : '●';
}

/** Member status color */
function memberStatusColor(status: ChannelMemberStatus): string {
  switch (status) {
    case ChannelMemberStatus.ACTIVE:
      return 'green';
    case ChannelMemberStatus.IDLE:
      return 'yellow';
    case ChannelMemberStatus.DESTROYED:
      return 'gray';
  }
}

/** Render a single member row */
function renderMemberRow(member: ChannelMember, isSelected: boolean): React.ReactNode {
  const icon = memberStatusIcon(member.status);
  const color = memberStatusColor(member.status);
  const bg = isSelected ? 'blue' : undefined;
  const statusLabel = member.status === ChannelMemberStatus.DESTROYED ? 'destroyed' : member.status;

  return (
    <Box key={member.name} flexDirection="row" backgroundColor={bg}>
      <Text bold={isSelected} color={isSelected ? 'white' : color}>
        {icon}
      </Text>
      <Text> </Text>
      <Text bold={isSelected} color={isSelected ? 'white' : undefined}>
        {member.name}
      </Text>
      <Text dimColor>{` (${member.agent})`}</Text>
      <Text dimColor>{` — ${statusLabel}`}</Text>
    </Box>
  );
}

/** Format a message row: [R{round}] {from} → {to}: "{summary}" */
function formatMessageRow(msg: ChannelMessage): string {
  const to = msg.toMember !== null ? msg.toMember : '(broadcast)';
  const summary = truncateCell(msg.summary, 60);
  return `[R${msg.round}] ${msg.fromMember} → ${to}: "${summary}"`;
}

export const ChannelDetail: React.FC<ChannelDetailProps> = React.memo(
  ({ channel, messages, scrollOffset: _scrollOffset, animFrame, selectedMemberName, panePreview }) => {
    // Selected member object (for live preview label)
    const selectedMember = React.useMemo(
      () =>
        selectedMemberName !== null
          ? (channel.members.find((m) => m.name === selectedMemberName) ?? channel.members[0] ?? null)
          : (channel.members[0] ?? null),
      [channel.members, selectedMemberName],
    );

    // Effective selected name (falls back to first member)
    const effectiveSelectedName = selectedMember?.name ?? null;

    // Round progress — only shown when maxRounds is set
    const showRoundProgress = channel.maxRounds !== undefined && channel.maxRounds > 0;
    const roundProgress = showRoundProgress ? formatRunProgress(channel.currentRound, channel.maxRounds) : null;

    // Live preview section label
    const previewLabel =
      effectiveSelectedName !== null ? `─── Live Preview (${effectiveSelectedName}) ───` : '─── Live Preview ───';

    return (
      <Box flexDirection="column" paddingLeft={1} paddingRight={1}>
        {/* Header section */}
        <Box marginBottom={1}>
          <Text bold>Channel Detail</Text>
        </Box>

        <Field label="ID">{truncateCell(channel.id, 60)}</Field>
        <Field label="Name">{channel.name}</Field>
        <StatusField>
          <StatusBadge status={channel.status} animFrame={animFrame} />
        </StatusField>
        {channel.communicationMode !== undefined ? <Field label="Mode">{channel.communicationMode}</Field> : null}
        {channel.topic !== undefined ? <Field label="Topic">{truncateCell(channel.topic, 50)}</Field> : null}
        {showRoundProgress && roundProgress !== null ? <Field label="Round Progress">{roundProgress}</Field> : null}
        <Field label="Members">{String(channel.members.length)}</Field>
        <Field label="Created">{relativeTime(channel.createdAt)}</Field>
        <Field label="Updated">{relativeTime(channel.updatedAt)}</Field>

        {/* Member list */}
        <Box marginTop={1} marginBottom={0}>
          <Text bold>Members</Text>
          <Text dimColor>{` (${channel.members.length} total)`}</Text>
        </Box>

        {channel.members.length === 0 ? (
          <Text dimColor>No members</Text>
        ) : (
          <Box flexDirection="column">
            {channel.members.map((member) => renderMemberRow(member, member.name === (effectiveSelectedName ?? '')))}
          </Box>
        )}

        {/* Recent Activity */}
        <Box marginTop={1} marginBottom={0}>
          <Text bold>Recent Activity</Text>
          {messages !== undefined && messages.length > 0 ? (
            <Text dimColor>{` (${messages.length} messages)`}</Text>
          ) : null}
        </Box>

        {messages === undefined || messages.length === 0 ? (
          <Text dimColor>No messages yet</Text>
        ) : (
          <Box flexDirection="column">
            {messages.map((msg) => (
              <Box key={msg.id} flexDirection="row">
                <Text dimColor>{formatMessageRow(msg)}</Text>
              </Box>
            ))}
          </Box>
        )}

        {/* Live Preview */}
        <Box marginTop={1} marginBottom={0}>
          <Text bold dimColor>
            {previewLabel}
          </Text>
        </Box>

        {effectiveSelectedName === null ? (
          <Text dimColor>(no member selected)</Text>
        ) : panePreview !== null ? (
          <Box flexDirection="column">
            <Text dimColor>{panePreview}</Text>
          </Box>
        ) : (
          <Text dimColor>(session not responding)</Text>
        )}
      </Box>
    );
  },
);

ChannelDetail.displayName = 'ChannelDetail';
