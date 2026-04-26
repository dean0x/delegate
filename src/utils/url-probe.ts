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
      const error = rawError as NodeJS.ErrnoException;
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
  if (
    code === 'CERT_HAS_EXPIRED' ||
    code === 'CERT_INVALID' ||
    code === 'UNABLE_TO_VERIFY_LEAF_SIGNATURE' ||
    code === 'SELF_SIGNED_CERT_IN_CHAIN' ||
    code === 'DEPTH_ZERO_SELF_SIGNED_CERT' ||
    code?.startsWith('ERR_TLS') ||
    code?.startsWith('ERR_SSL')
  ) {
    return `TLS/SSL error connecting to ${urlStr}: ${error.message}. For self-signed certs, set NODE_TLS_REJECT_UNAUTHORIZED=0.`;
  }

  // Non-ErrnoException or unrecognised code — include the raw message
  return error.message;
}

function messageForStatus(
  statusCode: number,
  headers: http.IncomingHttpHeaders,
  url: URL,
  isDeepProbe: boolean,
): string {
  if (statusCode >= 200 && statusCode < 300) {
    return isDeepProbe ? 'API endpoint is reachable and authenticated' : 'URL is reachable';
  }
  if (statusCode === 301 || statusCode === 302) {
    const location = headers['location'] ?? '(unknown)';
    return `URL is reachable but redirects to ${location}. Consider using the redirect target directly.`;
  }
  if (statusCode === 401) {
    if (isDeepProbe) {
      return `API key was rejected by ${url.hostname}. Verify your API key is correct.`;
    }
    return 'URL is reachable but requires authentication';
  }
  if (statusCode === 403) {
    return `API key lacks required permissions for ${url.hostname}.`;
  }
  if (statusCode === 404) {
    return `URL returned 404. Verify the path — expected format: https://host/v1`;
  }
  if (statusCode === 405) {
    return 'URL is reachable';
  }
  if (statusCode === 429) {
    return 'URL is reachable but rate-limited. The server is working but throttled.';
  }
  if (statusCode >= 500 && statusCode < 600) {
    return `URL is reachable but server returned error (${statusCode}). The server may be starting up.`;
  }
  return `URL responded with status ${statusCode}`;
}

function severityForStatus(statusCode: number, isDeepProbe: boolean): 'ok' | 'warning' | 'error' {
  if (statusCode >= 200 && statusCode < 300) return 'ok';
  if (statusCode === 301 || statusCode === 302) return 'warning';
  if (statusCode === 401) return isDeepProbe ? 'error' : 'warning';
  if (statusCode === 403) return 'error';
  if (statusCode === 404) return 'warning';
  if (statusCode === 405) return 'ok';
  if (statusCode === 429) return 'warning';
  if (statusCode >= 500 && statusCode < 600) return 'warning';
  return 'warning';
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

  // 2. HEAD request — DNS + TCP + TLS + server existence
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

  // 3. Deep probe — GET <baseUrl>/models with Authorization header
  if (apiKey) {
    const modelsUrl = new URL(parsedUrl.href);
    // Append /models to pathname (preserves hostname, port, protocol)
    modelsUrl.pathname = modelsUrl.pathname.replace(/\/?$/, '') + '/models';

    const deepResult = await httpRequest('GET', modelsUrl, { Authorization: `Bearer ${apiKey}` }, timeoutMs, requestFn);

    if ('error' in deepResult) {
      // Deep probe failure — fall through to base probe result
      // (base probe succeeded, deep probe network error is unusual; report base)
    } else {
      const deepCode = deepResult.statusCode;
      const deepSeverity = severityForStatus(deepCode, true);
      const deepMessage = messageForStatus(deepCode, deepResult.headers, parsedUrl, true);
      return ok({
        reachable: deepSeverity !== 'error',
        statusCode: deepCode,
        message: deepMessage,
        severity: deepSeverity,
        durationMs: deepResult.durationMs,
      });
    }
  }

  // 4. Return base probe result
  const severity = severityForStatus(statusCode, false);
  const message = messageForStatus(statusCode, headers, parsedUrl, false);

  return ok({
    reachable: severity !== 'error',
    statusCode,
    message,
    severity,
    durationMs,
  });
}
