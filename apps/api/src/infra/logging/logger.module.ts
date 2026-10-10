import { randomUUID } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import { RequestMethod } from '@nestjs/common';
import { LoggerModule as PinoLoggerModule } from 'nestjs-pino';
import { APP_CONFIG, type AppConfig } from '../config/config';

const REQUEST_ID_PATTERN = /^[A-Za-z0-9-]{8,64}$/;

/**
 * Structured JSON logs. Credentials, cookies, tokens and request bodies are never logged;
 * the redact list is a second line of defence in case one is attached to a log object.
 */
export const LoggerModule = PinoLoggerModule.forRootAsync({
  inject: [APP_CONFIG],
  useFactory: (config: AppConfig) => ({
    // Express 5 / path-to-regexp v8 wildcard syntax.
    forRoutes: [{ path: '{*path}', method: RequestMethod.ALL }],
    pinoHttp: {
      level: config.LOG_LEVEL,
      genReqId: (req: IncomingMessage, res) => {
        const incoming = req.headers['x-request-id'];
        const id =
          typeof incoming === 'string' && REQUEST_ID_PATTERN.test(incoming)
            ? incoming
            : randomUUID();
        res.setHeader('X-Request-Id', id);
        return id;
      },
      redact: {
        paths: [
          'req.headers.authorization',
          'req.headers.cookie',
          'res.headers["set-cookie"]',
          '*.password',
          '*.initialPassword',
          '*.currentPassword',
          '*.newPassword',
          '*.accessToken',
          '*.refreshToken',
          '*.mfaToken',
          '*.code',
          '*.email',
          '*.phone',
        ],
        censor: '[redacted]',
      },
      serializers: {
        req: (req: { id: string; method: string; url: string }) => ({
          id: req.id,
          method: req.method,
          // Strip query strings: they may contain search terms.
          url: req.url.split('?')[0],
        }),
      },
      autoLogging: {
        ignore: (req: IncomingMessage) => req.url?.startsWith('/api/v1/health') ?? false,
      },
      customLogLevel: (_req: IncomingMessage, res: { statusCode: number }, err?: Error) =>
        err || res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info',
    },
  }),
});
