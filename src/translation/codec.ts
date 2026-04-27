/**
 * FormatCodec interface — the translation contract for each API format.
 *
 * ARCHITECTURE: Each codec is a stateless translator between one API format
 * and the canonical IR. The proxy orchestrates codecs; codecs never know
 * about each other.
 */
import type { Result } from '../core/result.js';
import type { CanonicalRequest, CanonicalResponse, CanonicalStreamEvent } from './ir.js';

/**
 * Parses a raw SSE stream from a target API into canonical stream events.
 * One instance per request — state (partial tool args, etc.) lives here.
 */
export interface StreamParser {
  /** Feed a parsed SSE data payload, yield canonical events */
  processChunk(data: unknown): CanonicalStreamEvent[];
  /** Flush remaining state at end of stream */
  flush(): CanonicalStreamEvent[];
}

/**
 * Serializes canonical stream events back to source API SSE format.
 * One instance per response — may track block indices, etc.
 */
export interface StreamSerializer {
  /** Convert a canonical event to SSE string(s) to write to the client */
  serialize(event: CanonicalStreamEvent): string[];
}

/**
 * Full codec for a single API format (Anthropic or OpenAI).
 *
 * DECISION: Separate parse/serialize methods for requests and responses
 * rather than a single "translate" method. Rationale: enables testing each
 * direction independently, and supports the proxy pattern where parsing
 * source and serializing target are distinct concerns.
 */
export interface FormatCodec {
  /** Human-readable codec name for logging */
  readonly name: string;

  /** Parse a raw request body (from source API) into canonical form */
  parseRequest(raw: unknown): Result<CanonicalRequest>;

  /** Serialize a canonical request into the target API wire format */
  serializeRequest(canonical: CanonicalRequest): Result<unknown>;

  /** Parse a raw response body (from target API) into canonical form */
  parseResponse(raw: unknown): Result<CanonicalResponse>;

  /** Serialize a canonical response into the source API wire format */
  serializeResponse(canonical: CanonicalResponse): Result<unknown>;

  /** Create a fresh stream parser for a new request */
  createStreamParser(): StreamParser;

  /** Create a fresh stream serializer for a new response */
  createStreamSerializer(): StreamSerializer;
}
