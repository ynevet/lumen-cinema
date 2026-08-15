import { pino } from 'pino';
import { config } from './config.js';

export const logger = pino({
  level: config.LOG_LEVEL,
  // Backstop for anything that logs a request or a header bag by hand. The HTTP logger
  // already allowlists headers before they get this far; this catches the call site that
  // forgets. Missing paths are simply ignored, so it costs nothing on ordinary log lines.
  redact: {
    paths: [
      'req.headers.authorization',
      'req.headers.cookie',
      'res.headers["set-cookie"]',
      'headers.authorization',
      'headers.cookie',
    ],
    censor: '[redacted]',
  },
  // Pretty output in development only; production emits newline-delimited JSON.
  ...(config.isProduction
    ? {}
    : {
        transport: {
          target: 'pino-pretty',
          options: { colorize: true, translateTime: 'HH:MM:ss.l', ignore: 'pid,hostname' },
        },
      }),
});
