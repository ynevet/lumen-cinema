import { pinoHttp } from 'pino-http';
import type { SerializedRequest, SerializedResponse } from 'pino-std-serializers';
import { logger } from '../logger.js';

/**
 * The request headers worth keeping. Everything else is dropped before it reaches a log line.
 *
 * An allowlist rather than a denylist, deliberately: `authorization` carries a bearer token
 * that is as good as a password, and pino-http's default serializer logs every header at
 * info level - so a plain `GET /api/screenings` used to write a usable credential into the
 * log stream. A denylist would also have to be updated the day a proxy or client starts
 * sending `cookie`, `x-api-key`, or `proxy-authorization`; an allowlist is safe by default.
 */
const LOGGED_REQUEST_HEADERS = new Set([
  'accept',
  'content-length',
  'content-type',
  'host',
  'referer',
  'user-agent',
  'x-forwarded-for',
  'x-request-id',
]);

type Headers = SerializedRequest['headers'];

function pickLoggedHeaders(headers: Headers): Headers {
  const kept: Headers = {};
  for (const [name, value] of Object.entries(headers ?? {})) {
    if (LOGGED_REQUEST_HEADERS.has(name.toLowerCase())) kept[name] = value;
  }
  return kept;
}

/** Exported for the tests; `wrapSerializers` hands us pino's own serialized shape. */
export function serializeRequest(req: SerializedRequest): SerializedRequest {
  return { ...req, headers: pickLoggedHeaders(req.headers) };
}

/** The API is stateless and never sets a cookie, but a stray `set-cookie` must not leak either. */
export function serializeResponse(res: SerializedResponse): SerializedResponse {
  const { 'set-cookie': _setCookie, ...headers } = res.headers ?? {};
  return { ...res, headers };
}

export const httpLogger = pinoHttp({
  logger,
  // Health checks would otherwise drown out real traffic.
  autoLogging: { ignore: (req) => req.url === '/api/health' },
  customLogLevel: (_req, res, err) => {
    if (err || res.statusCode >= 500) return 'error';
    if (res.statusCode >= 400) return 'warn';
    return 'info';
  },
  serializers: {
    req: serializeRequest,
    res: serializeResponse,
  },
});
