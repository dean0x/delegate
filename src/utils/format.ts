/**
 * Shared formatting utilities
 * ARCHITECTURE: Centralized string formatting and enum mapping to eliminate inline duplication
 */

import { MissedRunPolicy, OptimizeDirection } from '../core/domain.js';

/**
 * Truncate a string to maxLen characters, appending '...' if truncated
 * @param text The string to truncate
 * @param maxLen Maximum length before truncation (default: 50)
 * @returns The original string if within limit, or truncated with '...' suffix
 */
export function truncatePrompt(text: string, maxLen = 50): string {
  if (text.length <= maxLen) return text;
  return text.substring(0, maxLen) + '...';
}

/**
 * Map evalDirection string to OptimizeDirection enum
 * Returns undefined for unrecognized values
 */
export function toOptimizeDirection(value: string | undefined): OptimizeDirection | undefined {
  switch (value) {
    case 'minimize':
      return OptimizeDirection.MINIMIZE;
    case 'maximize':
      return OptimizeDirection.MAXIMIZE;
    default:
      return undefined;
  }
}

/**
 * Map missedRunPolicy string to MissedRunPolicy enum
 * Defaults to SKIP for unrecognized values
 */
export function toMissedRunPolicy(value: string | undefined): MissedRunPolicy {
  switch (value) {
    case 'catchup':
      return MissedRunPolicy.CATCHUP;
    case 'fail':
      return MissedRunPolicy.FAIL;
    default:
      return MissedRunPolicy.SKIP;
  }
}
