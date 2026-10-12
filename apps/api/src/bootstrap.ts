import { VersioningType, type INestApplication } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { DocumentBuilder, SwaggerModule, type OpenAPIObject } from '@nestjs/swagger';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import { Logger } from 'nestjs-pino';
import { APP_CONFIG, type AppConfig } from './infra/config/config';
import { AllExceptionsFilter } from './infra/http/exception.filter';
import { RedisIoAdapter } from './modules/realtime/redis-io.adapter';
import type { NextFunction, Request, Response } from 'express';
import { metrics, statusClass } from './infra/metrics/metrics';
import { LOGO_CONTENT_TYPES, LOGO_MAX_BYTES } from './modules/tenancy/place-details';

/** Request rate/latency by route template (never raw paths with ids). */
function httpMetrics(req: Request, res: Response, next: NextFunction): void {
  const end = metrics.httpDuration.startTimer();
  res.on('finish', () => {
    const route = req.route ? `${req.baseUrl}${(req.route as { path: string }).path}` : 'unmatched';
    end({ method: req.method, route });
    metrics.httpRequests.inc({ method: req.method, route, status: statusClass(res.statusCode) });
  });
  next();
}

/** The public v1 contract (committed as docs/api/openapi.json and checked in CI). */
export function buildOpenApiDocument(app: INestApplication): OpenAPIObject {
  return SwaggerModule.createDocument(
    app,
    new DocumentBuilder()
      .setTitle('SMA API')
      .setDescription('Multi-tenant business messaging. See docs/api/outline.md for conventions.')
      .setVersion('1.0')
      .addBearerAuth()
      .build(),
  );
}

/** HTTP pipeline shared by main.ts and the integration tests. */
export function configureApp(app: NestExpressApplication): INestApplication {
  const config = app.get<AppConfig>(APP_CONFIG);
  app.useLogger(app.get(Logger));
  app.set('trust proxy', config.TRUST_PROXY_HOPS);
  app.disable('x-powered-by');
  app.useBodyParser('json', { limit: '256kb' });
  // Business/store logo uploads send the image bytes as the request body.
  app.useBodyParser('raw', { type: LOGO_CONTENT_TYPES, limit: LOGO_MAX_BYTES });
  app.use(cookieParser());
  app.use(httpMetrics);
  app.use(
    helmet({
      // The API serves JSON only; the strictest CSP applies (Swagger UI is served separately).
      contentSecurityPolicy: { directives: { defaultSrc: ["'none'"], frameAncestors: ["'none'"] } },
      crossOriginResourcePolicy: { policy: 'same-site' },
    }),
  );
  app.enableCors({
    origin: config.CORS_ORIGINS,
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
    allowedHeaders: ['Authorization', 'Content-Type', 'X-Request-Id', 'X-Storeline-CSRF'],
    exposedHeaders: ['X-Request-Id', 'Retry-After'],
    maxAge: 600,
  });
  app.setGlobalPrefix('api');
  app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });
  app.useGlobalFilters(new AllExceptionsFilter());
  app.useWebSocketAdapter(new RedisIoAdapter(app));
  app.enableShutdownHooks();

  if (config.OPENAPI_ENABLED) {
    SwaggerModule.setup('api/docs', app, buildOpenApiDocument(app), {
      jsonDocumentUrl: 'api/docs-json',
    });
  }
  return app;
}
