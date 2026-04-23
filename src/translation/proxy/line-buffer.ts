/**
 * SSE chunk boundary assembler.
 *
 * ARCHITECTURE: HTTP streaming delivers data in arbitrary chunks. SSE events
 * span multiple lines (`event:\ndata:\n\n`). This buffer reassembles chunk
 * boundaries into complete lines for the stream translator.
 *
 * Handles both LF (\n) and CRLF (\r\n) line endings.
 */
export class LineBuffer {
  private buffer = '';

  /**
   * Feed a chunk of raw text. Returns complete lines (without trailing newline).
   * Partial lines are held in the buffer until the next call.
   */
  feed(chunk: string): string[] {
    this.buffer += chunk;
    const lines: string[] = [];

    let start = 0;
    let i = 0;

    while (i < this.buffer.length) {
      if (this.buffer[i] === '\n') {
        const line = this.buffer.slice(start, i);
        // Strip trailing CR for CRLF support
        lines.push(line.endsWith('\r') ? line.slice(0, -1) : line);
        i++;
        start = i;
      } else {
        i++;
      }
    }

    // Keep the remaining partial line in the buffer
    this.buffer = this.buffer.slice(start);

    return lines;
  }

  /**
   * Flush remaining content. Returns the partial line, or null if empty.
   * Call at end of stream.
   */
  flush(): string | null {
    if (this.buffer.length === 0) return null;
    const remaining = this.buffer;
    this.buffer = '';
    return remaining;
  }
}
