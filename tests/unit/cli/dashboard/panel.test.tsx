/**
 * Tests for Panel and sub-components
 * Tests behavior (visual output) not implementation details
 */

import { Text } from 'ink';
import { render } from 'ink-testing-library';
import React from 'react';
import { describe, expect, it } from 'vitest';
import { EmptyState } from '../../../../src/cli/dashboard/components/empty-state.js';
import { Footer } from '../../../../src/cli/dashboard/components/footer.js';
import { Panel } from '../../../../src/cli/dashboard/components/panel.js';
import { StatusBadge } from '../../../../src/cli/dashboard/components/status-badge.js';

// ============================================================================
// Panel
// ============================================================================

describe('Panel', () => {
  it('renders title and status summary', () => {
    const { lastFrame } = render(
      <Panel title="[1] Loops" statusSummary="2 running" focused={false} filterStatus={null}>
        <React.Fragment />
      </Panel>,
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain('[1] Loops');
    expect(frame).toContain('2 running');
  });

  it('shows filter badge when filter is set', () => {
    const { lastFrame } = render(
      <Panel title="[1] Loops" statusSummary="" focused={false} filterStatus="running">
        <React.Fragment />
      </Panel>,
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain('filter: running');
  });

  it('does not show filter badge when no filter', () => {
    const { lastFrame } = render(
      <Panel title="[1] Loops" statusSummary="" focused={false} filterStatus={null}>
        <React.Fragment />
      </Panel>,
    );
    const frame = lastFrame() ?? '';
    expect(frame).not.toContain('filter:');
  });

  it('renders children', () => {
    const { lastFrame } = render(
      <Panel title="[2] Tasks" statusSummary="" focused={false} filterStatus={null}>
        <Text>child content</Text>
      </Panel>,
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain('child content');
  });
});

// ============================================================================
// EmptyState
// ============================================================================

describe('EmptyState', () => {
  it('shows "No X found" when no filter', () => {
    const { lastFrame } = render(<EmptyState entityName="loops" filterStatus={null} />);
    expect(lastFrame()).toContain('No loops found');
  });

  it('shows "No STATUS X found" when filter is set', () => {
    const { lastFrame } = render(<EmptyState entityName="tasks" filterStatus="running" />);
    expect(lastFrame()).toContain('No running tasks found');
  });

  it('handles different entity names', () => {
    const { lastFrame } = render(<EmptyState entityName="orchestrations" filterStatus={null} />);
    expect(lastFrame()).toContain('No orchestrations found');
  });
});

// ============================================================================
// StatusBadge
// ============================================================================

describe('StatusBadge', () => {
  it('renders status text', () => {
    const { lastFrame } = render(<StatusBadge status="running" />);
    expect(lastFrame()).toContain('running');
  });

  it('renders icon for running status', () => {
    const { lastFrame } = render(<StatusBadge status="running" />);
    expect(lastFrame()).toContain('●');
  });

  it('renders icon for completed status', () => {
    const { lastFrame } = render(<StatusBadge status="completed" />);
    expect(lastFrame()).toContain('✓');
  });

  it('renders icon for failed status', () => {
    const { lastFrame } = render(<StatusBadge status="failed" />);
    expect(lastFrame()).toContain('✗');
  });

  it('renders icon for paused status', () => {
    const { lastFrame } = render(<StatusBadge status="paused" />);
    expect(lastFrame()).toContain('⏸');
  });

  it('handles unknown status gracefully', () => {
    const { lastFrame } = render(<StatusBadge status="unknown_status" />);
    expect(lastFrame()).toContain('unknown_status');
  });
});

// ============================================================================
// Footer
// ============================================================================

describe('Footer', () => {
  it('shows main view help for main viewKind', () => {
    const { lastFrame } = render(<Footer viewKind="main" />);
    const frame = lastFrame() ?? '';
    expect(frame).toContain('Tab');
    expect(frame).toContain('Enter');
    expect(frame).toContain('filter');
  });

  it('shows detail view help for detail viewKind', () => {
    const { lastFrame } = render(<Footer viewKind="detail" />);
    const frame = lastFrame() ?? '';
    expect(frame).toContain('Esc');
    expect(frame).toContain('scroll');
  });

  it('detail view does not show Tab/filter hints', () => {
    const { lastFrame } = render(<Footer viewKind="detail" />);
    const frame = lastFrame() ?? '';
    expect(frame).not.toContain('Tab cycle');
    expect(frame).not.toContain('f filter');
  });
});
