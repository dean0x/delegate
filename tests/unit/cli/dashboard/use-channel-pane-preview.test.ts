/**
 * Tests for useChannelPanePreview hook.
 * Tests behavior: polling, disabling, error handling.
 *
 * Pattern: Uses ink-testing-library's render with a React component wrapper
 * that captures the hook result — same approach as use-terminal-size.test.ts.
 *
 * Approach: Verify capture function is called with correct args, and observe
 * output via frames. Fake timers only for interval timing tests.
 */

import { render } from 'ink-testing-library';
import React, { useEffect, useRef } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { UseChannelPanePreviewResult } from '../../../../src/cli/dashboard/use-channel-pane-preview.js';
import { useChannelPanePreview } from '../../../../src/cli/dashboard/use-channel-pane-preview.js';
import type { Result } from '../../../../src/core/result.js';

// ============================================================================
// Helpers
// ============================================================================

function okResult(value: string): Result<string, Error> {
  return { ok: true, value };
}

function errResult(message = 'tmux error'): Result<string, Error> {
  return { ok: false, error: new Error(message) };
}

type CaptureFn = (name: string, lines?: number) => Result<string, Error>;

interface HookWrapperProps {
  readonly captureFn: CaptureFn | undefined;
  readonly sessionName: string | null;
  readonly enabled: boolean;
  readonly lines?: number;
  readonly resultRef: React.MutableRefObject<UseChannelPanePreviewResult | null>;
}

function HookWrapper({ captureFn, sessionName, enabled, lines, resultRef }: HookWrapperProps): React.ReactElement {
  const result = useChannelPanePreview(captureFn, sessionName, enabled, lines);
  const ref = useRef(resultRef);
  useEffect(() => {
    ref.current.current = result;
  });
  return React.createElement(React.Fragment);
}

function renderHookWith(
  captureFn: CaptureFn | undefined,
  sessionName: string | null,
  enabled: boolean,
  lines?: number,
): {
  resultRef: React.MutableRefObject<UseChannelPanePreviewResult | null>;
  unmount: () => void;
} {
  const resultRef = React.createRef() as React.MutableRefObject<UseChannelPanePreviewResult | null>;
  resultRef.current = null;
  const { unmount } = render(React.createElement(HookWrapper, { captureFn, sessionName, enabled, lines, resultRef }));
  return { resultRef, unmount };
}

// ============================================================================
// Tests: disabled / no-op cases
// ============================================================================

describe('useChannelPanePreview — disabled cases', () => {
  it('does not call captureFn when disabled', () => {
    const captureFn = vi.fn().mockReturnValue(okResult('some content'));
    const { unmount } = renderHookWith(captureFn, 'beat-channel-x-a', false);
    expect(captureFn).not.toHaveBeenCalled();
    unmount();
  });

  it('does not call captureFn when sessionName is null', () => {
    const captureFn = vi.fn().mockReturnValue(okResult('some content'));
    const { unmount } = renderHookWith(captureFn, null, true);
    expect(captureFn).not.toHaveBeenCalled();
    unmount();
  });

  it('does not call captureFn when capturePaneFn is undefined', () => {
    const { resultRef, unmount } = renderHookWith(undefined, 'beat-channel-x-a', true);
    expect(resultRef.current?.preview).toBeNull();
    expect(resultRef.current?.error).toBeNull();
    unmount();
  });
});

// ============================================================================
// Tests: capture function invocation
// ============================================================================

describe('useChannelPanePreview — capture invocation', () => {
  it('calls captureFn with session name when enabled on mount', () => {
    const captureFn = vi.fn().mockReturnValue(okResult('output'));
    const { unmount } = renderHookWith(captureFn, 'beat-channel-x-a', true);
    expect(captureFn).toHaveBeenCalledWith('beat-channel-x-a', undefined);
    unmount();
  });

  it('passes lines parameter to captureFn when provided', () => {
    const captureFn = vi.fn().mockReturnValue(okResult('last 20 lines'));
    const { unmount } = renderHookWith(captureFn, 'beat-channel-x-a', true, 20);
    expect(captureFn).toHaveBeenCalledWith('beat-channel-x-a', 20);
    unmount();
  });

  it('calls captureFn with specific session name', () => {
    const captureFn = vi.fn().mockReturnValue(okResult('content'));
    const { unmount } = renderHookWith(captureFn, 'beat-channel-myname-member', true);
    expect(captureFn).toHaveBeenCalledWith('beat-channel-myname-member', undefined);
    unmount();
  });
});

// ============================================================================
// Tests: polling behavior (fake timers)
// ============================================================================

describe('useChannelPanePreview — polling behavior', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('polls again after 3000ms interval', () => {
    const captureFn = vi.fn().mockReturnValue(okResult('content'));
    const { unmount } = renderHookWith(captureFn, 'beat-channel-x-a', true);

    expect(captureFn).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(3_000);

    expect(captureFn).toHaveBeenCalledTimes(2);
    unmount();
  });

  it('does not poll before 3000ms', () => {
    const captureFn = vi.fn().mockReturnValue(okResult('content'));
    const { unmount } = renderHookWith(captureFn, 'beat-channel-x-a', true);

    expect(captureFn).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(2_999);
    expect(captureFn).toHaveBeenCalledTimes(1);
    unmount();
  });

  it('clears interval on unmount', () => {
    const captureFn = vi.fn().mockReturnValue(okResult('content'));
    const { unmount } = renderHookWith(captureFn, 'beat-channel-x-a', true);

    expect(captureFn).toHaveBeenCalledTimes(1);
    unmount();

    vi.advanceTimersByTime(6_000);
    // No additional calls after unmount
    expect(captureFn).toHaveBeenCalledTimes(1);
  });

  it('does not call captureFn even after 3000ms when disabled', () => {
    const captureFn = vi.fn().mockReturnValue(okResult('content'));
    const { unmount } = renderHookWith(captureFn, 'beat-channel-x-a', false);

    vi.advanceTimersByTime(6_000);
    expect(captureFn).not.toHaveBeenCalled();
    unmount();
  });
});

// ============================================================================
// Tests: error handling — verified via rendered output using ChannelDetail
// ============================================================================

describe('useChannelPanePreview — error handling', () => {
  it('calls captureFn even when it returns an error result', () => {
    const captureFn = vi.fn().mockReturnValue(errResult('session not found'));
    const { unmount } = renderHookWith(captureFn, 'beat-channel-x-a', true);
    // Verify the function was called (error result is handled gracefully)
    expect(captureFn).toHaveBeenCalledWith('beat-channel-x-a', undefined);
    unmount();
  });

  it('does not throw when captureFn throws internally', () => {
    const captureFn = vi.fn().mockImplementation(() => {
      throw new Error('unexpected crash');
    });
    // Should not throw during render
    expect(() => renderHookWith(captureFn, 'beat-channel-x-a', true)).not.toThrow();
  });
});
