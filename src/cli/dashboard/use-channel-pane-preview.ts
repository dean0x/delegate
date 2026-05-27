/**
 * useChannelPanePreview — polls capturePaneContent for a channel member's session
 * ARCHITECTURE: Pure hook, no side effects beyond interval
 * Pattern: fetching ref + closing ref prevents overlapping polls and post-unmount setState
 *          (same pattern as useResourceMetrics in use-resource-metrics.ts)
 *
 * - Polls every 3000ms when enabled && sessionName !== null && capturePaneFn !== undefined
 * - Resets preview when sessionName changes
 * - On capturePaneFn error: returns { preview: null, error: '(session not responding)' }
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { Result } from '../../core/result.js';

const POLL_INTERVAL_MS = 3_000;

export interface UseChannelPanePreviewResult {
  readonly preview: string | null;
  readonly error: string | null;
}

/**
 * Poll a tmux capture-pane function for a channel member's session.
 *
 * @param capturePaneFn - The capturePaneContent function from TmuxSessionManagerCorePort.
 *                        Undefined when tmux is unavailable (e.g. test environments).
 * @param sessionName   - The tmux session name to capture from. Null disables polling.
 * @param enabled       - When false, polling is paused and returns null/null.
 * @param lines         - Optional line count to capture (defaults to tmux default).
 */
export function useChannelPanePreview(
  capturePaneFn: ((name: string, lines?: number) => Result<string, Error>) | undefined,
  sessionName: string | null,
  enabled: boolean,
  lines?: number,
): UseChannelPanePreviewResult {
  const [preview, setPreview] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Guard against overlapping polls
  const fetching = useRef(false);
  // Prevent setState after unmount
  const closing = useRef(false);

  // Track previous sessionName to reset preview on change
  const prevSessionName = useRef<string | null>(null);

  const doCapture = useCallback((): void => {
    if (!enabled || sessionName === null || capturePaneFn === undefined) return;
    if (fetching.current) return;

    fetching.current = true;
    try {
      const result = capturePaneFn(sessionName, lines);
      if (closing.current) return;

      if (result.ok) {
        setPreview(result.value);
        setError(null);
      } else {
        setPreview(null);
        setError('(session not responding)');
      }
    } catch {
      if (!closing.current) {
        setPreview(null);
        setError('(session not responding)');
      }
    } finally {
      fetching.current = false;
    }
  }, [capturePaneFn, sessionName, enabled, lines]);

  // Reset preview when sessionName changes
  useEffect(() => {
    if (prevSessionName.current !== sessionName) {
      prevSessionName.current = sessionName;
      setPreview(null);
      setError(null);
    }
  }, [sessionName]);

  useEffect(() => {
    closing.current = false;

    if (!enabled || sessionName === null || capturePaneFn === undefined) {
      return () => {
        closing.current = true;
      };
    }

    // Initial capture immediately on mount or when deps change
    doCapture();

    const intervalId = setInterval(() => {
      doCapture();
    }, POLL_INTERVAL_MS);

    return () => {
      closing.current = true;
      clearInterval(intervalId);
    };
  }, [doCapture, enabled, sessionName, capturePaneFn]);

  return { preview, error };
}
