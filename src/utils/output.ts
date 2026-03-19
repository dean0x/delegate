/**
 * Output measurement utilities
 * ARCHITECTURE: Shared helper for consistent byte-size measurement across output paths
 */

/** Sum the byte lengths (UTF-8) of all lines in an array */
export function linesByteSize(lines: readonly string[]): number {
  return lines.reduce((sum, line) => sum + Buffer.byteLength(line, 'utf8'), 0);
}
