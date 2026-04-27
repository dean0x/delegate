/**
 * URL probe utility — checks reachability of a base URL at config time.
 *
 * ARCHITECTURE: Stateless utility; all side effects are HTTP requests.
 * Probes in two steps:
 *   1. HEAD <baseUrl>  — verifies DNS, TCP, TLS, and server existence
 *   2. GET <baseUrl>/models (when apiKey provided) — verifies API key validity
 *
 * Returns Result<UrlProbeResult> rather than throwing, in line with project
 * conventions. The only failure mode that returns err() is a malformed URL —
 * all network errors are represented as UrlProbeResult with severity='error'.
 */

import * as http from 'node:http';
import * as https from 'node:https';
import type { Result } from '../core/result.js';
import { err, ok } from '../core/result.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface UrlProbeResult {
  readonly reachable: boolean;
  readonly statusCode?: number;
  readonly message: string;
  readonly severity: 'ok' | 'warning' | 'error';
  readonly durationMs: number;
  /**
   * Non-fatal diagnostic produced when the deep probe (GET /models) fails with
   * a network error after the base HEAD probe succeeded. The base probe result
   * is still returned; this field surfaces the otherwise-silent failure so
   * callers can log or display it.
   */
  readonly deepProbeWarning?: string;
}

export interface UrlProbeOptions {
  /** Request timeout in ms. Default: 5000 */
  readonly timeoutMs?: number;
  /** When provided, enables deep probe: GET <baseUrl>/models with auth header */
  readonly apiKey?: string;
  /**
   * Dependency-injected HTTP request function. Accepts the same overloaded
   * signature as `http.request` / `https.request` so real and DI callers are
   * interchangeable.
   *
   * DESIGN: Threading this through both HEAD and GET requests enables full
   * network-error simulation in tests without spawning real servers.
   */
  readonly requestFn?: typeof http.request;
}

// ---------------------------------------------------------------------------
// Internal helper: single HTTP request returning status code + headers
// ---------------------------------------------------------------------------

interface HttpResult {
  statusCode: number;
  headers: http.IncomingHttpHeaders;
  durationMs: number;
}

function httpRequest(
  method: string,
  url: URL,
  reqHeaders: Record<string, string>,
  timeoutMs: number,
  requestFn?: typeof http.request,
): Promise<HttpResult | { error: NodeJS.ErrnoException; durationMs: number }> {
  const startMs = Date.now();

  return new Promise((resolve) => {
    const controller = new AbortController();
    const timeoutHandle = setTimeout(() => {
      controller.abort();
    }, timeoutMs);

    const options: http.RequestOptions = {
      hostname: url.hostname,
      port: url.port || (url.protocol === 'https:' ? 443 : 80),
      path: url.pathname + url.search,
      method,
      headers: reqHeaders,
      signal: controller.signal,
    };

    const actualRequestFn = requestFn ?? (url.protocol === 'https:' ? https.request : http.request);

    const req = actualRequestFn(options, (res) => {
      clearTimeout(timeoutHandle);
      const durationMs = Date.now() - startMs;
      // Drain response body to free the socket
      res.resume();
      resolve({
        statusCode: res.statusCode ?? 0,
        headers: res.headers,
        durationMs,
      });
    });

    req.on('error', (rawError: unknown) => {
      clearTimeout(timeoutHandle);
      const durationMs = Date.now() - startMs;

      // AbortController fires 'abort' but also emits an error on the req
      // with name='AbortError'. We treat it as a timeout.
      //
      // Narrow to Error before accessing name/code — ErrnoException extends
      // Error so instanceof guards both the AbortError check and the code
      // field access in the fallback path.
      const error: NodeJS.ErrnoException =
        rawError instanceof Error
          ? (rawError as NodeJS.ErrnoException)
          : Object.assign(new Error(String(rawError)), { code: undefined });

      if (error.name === 'AbortError' || controller.signal.aborted) {
        const timeoutErr = Object.assign(new Error(`No response from ${url.href} after ${timeoutMs}ms`), {
          code: '__PROBE_TIMEOUT__',
        }) as NodeJS.ErrnoException;
        resolve({ error: timeoutErr, durationMs });
        return;
      }

      resolve({ error, durationMs });
    });

    req.end();
  });
}

// ---------------------------------------------------------------------------
// Message builders
// ---------------------------------------------------------------------------

/**
 * Exact TLS error codes emitted by Node.js TLS/SSL machinery.
 * Checked alongside the ERR_TLS / ERR_SSL prefix guards in isTlsError.
 */
const TLS_ERROR_CODES = new Set([
  'CERT_HAS_EXPIRED',
  'CERT_INVALID',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
]);

function isTlsError(code: string): boolean {
  return TLS_ERROR_CODES.has(code) || code.startsWith('ERR_TLS') || code.startsWith('ERR_SSL');
}

function messageForError(error: NodeJS.ErrnoException, url: URL, timeoutMs: number): string {
  const code = error.code ?? '';
  const urlStr = url.href;

  if (code === 'ENOTFOUND') {
    return `Could not resolve hostname "${url.hostname}". Check the URL for typos.`;
  }
  if (code === 'ECONNREFUSED') {
    return `Connection refused at ${urlStr}. Is the server running?`;
  }
  if (code === 'ETIMEDOUT' || code === 'ECONNRESET') {
    return `Connection timed out reaching ${urlStr}. The server may be unreachable.`;
  }
  if (code === '__PROBE_TIMEOUT__') {
    return `No response from ${urlStr} after ${timeoutMs}ms. The server may be slow or unreachable.`;
  }
  if (isTlsError(code)) {
    // NODE_TLS_REJECT_UNAUTHORIZED=0 disables ALL certificate verification globally —
    // recommend NODE_EXTRA_CA_CERTS to trust a specific CA bundle instead.
    return (
      `TLS/SSL error connecting to ${urlStr}: ${error.message}. ` +
      `For self-signed or private-CA certificates, set NODE_EXTRA_CA_CERTS=<path-to-ca.pem>.`
    );
  }

  // Non-ErrnoException or unrecognised code — include the raw message
  return error.message;
}

interface StatusResult {
  readonly message: string;
  readonly severity: 'ok' | 'warning' | 'error';
}

/**
 * Map an HTTP status code to a human-readable message and severity level.
 *
 * DESIGN: Consolidating message and severity dispatch into a single function
 * eliminates the duplicated switch-like chains that previously existed in
 * `messageForStatus` and `severityForStatus`, keeping the two values in sync
 * by construction.
 */
function statusResult(
  statusCode: number,
  headers: http.IncomingHttpHeaders,
  url: URL,
  isDeepProbe: boolean,
): StatusResult {
  if (statusCode >= 200 && statusCode < 300) {
    return {
      message: isDeepProbe ? 'API endpoint is reachable and authenticated' : 'URL is reachable',
      severity: 'ok',
    };
  }
  if (statusCode === 301 || statusCode === 302) {
    const location = headers['location'] ?? '(unknown)';
    return {
      message: `URL is reachable but redirects to ${location}. Consider using the redirect target directly.`,
      severity: 'warning',
    };
  }
  if (statusCode === 401) {
    return isDeepProbe
      ? { message: `API key was rejected by ${url.hostname}. Verify your API key is correct.`, severity: 'error' }
      : { message: 'URL is reachable but requires authentication', severity: 'warning' };
  }
  if (statusCode === 403) {
    return { message: `API key lacks required permissions for ${url.hostname}.`, severity: 'error' };
  }
  if (statusCode === 404) {
    return { message: `URL returned 404. Verify the path — expected format: https://host/v1`, severity: 'warning' };
  }
  if (statusCode === 405) {
    return { message: 'URL is reachable', severity: 'ok' };
  }
  if (statusCode === 429) {
    return { message: 'URL is reachable but rate-limited. The server is working but throttled.', severity: 'warning' };
  }
  if (statusCode >= 500 && statusCode < 600) {
    return {
      message: `URL is reachable but server returned error (${statusCode}). The server may be starting up.`,
      severity: 'warning',
    };
  }
  return { message: `URL responded with status ${statusCode}`, severity: 'warning' };
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

/**
 * Probe a base URL for reachability and optionally authenticate against it.
 *
 * Returns err() only when `baseUrl` cannot be parsed as a URL.
 * All network-level failures are represented as UrlProbeResult with severity='error'.
 */
export async function probeUrl(baseUrl: string, options: UrlProbeOptions = {}): Promise<Result<UrlProbeResult>> {
  const { timeoutMs = 5000, apiKey, requestFn } = options;

  // 1. Parse — fail fast for malformed URLs
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(baseUrl);
  } catch {
    return err(new Error(`Invalid URL: "${baseUrl}"`));
  }

  // 2. Scheme restriction — only http: and https: are valid probe targets.
  // file://, ftp://, and other schemes cannot be probed via http.request /
  // https.request and would silently misbehave or expose local filesystem paths.
  if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
    return err(new Error(`Unsupported URL scheme "${parsedUrl.protocol}" — only http: and https: are allowed.`));
  }

  // 3. HEAD request — DNS + TCP + TLS + server existence
  const baseResult = await httpRequest('HEAD', parsedUrl, {}, timeoutMs, requestFn);

  if ('error' in baseResult) {
    return ok({
      reachable: false,
      message: messageForError(baseResult.error, parsedUrl, timeoutMs),
      severity: 'error',
      durationMs: baseResult.durationMs,
    });
  }

  const { statusCode, headers, durationMs } = baseResult;

  // 4. Deep probe — GET <baseUrl>/models with Authorization header
  if (apiKey) {
    const modelsUrl = new URL(parsedUrl.href);
    // Append /models to pathname (preserves hostname, port, protocol)
    modelsUrl.pathname = modelsUrl.pathname.replace(/\/?$/, '') + '/models';

    const deepResult = await httpRequest('GET', modelsUrl, { Authorization: `Bearer ${apiKey}` }, timeoutMs, requestFn);

    if ('error' in deepResult) {
      // Deep probe failed with a network error after HEAD succeeded.
      // This is unusual (HEAD worked, but GET /models did not even connect).
      // Fall through to the base probe result, but surface a warning so
      // callers can log or display it rather than silently discarding it.
      const deepProbeWarning = `Deep probe (GET /models) failed: ${messageForError(deepResult.error, modelsUrl, timeoutMs)}`;
      const { message, severity } = statusResult(statusCode, headers, parsedUrl, false);
      return ok({
        reachable: severity !== 'error',
        statusCode,
        message,
        severity,
        durationMs,
        deepProbeWarning,
      });
    }

    const { message: deepMessage, severity: deepSeverity } = statusResult(
      deepResult.statusCode,
      deepResult.headers,
      parsedUrl,
      true,
    );
    return ok({
      reachable: deepSeverity !== 'error',
      statusCode: deepResult.statusCode,
      message: deepMessage,
      severity: deepSeverity,
      durationMs: deepResult.durationMs,
    });
  }

  // 5. Return base probe result
  const { message, severity } = statusResult(statusCode, headers, parsedUrl, false);

  return ok({
    reachable: severity !== 'error',
    statusCode,
    message,
    severity,
    durationMs,
  });
}
