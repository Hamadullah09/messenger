/**
 * Optional OpenTelemetry tracing. Enabled only when OTEL_EXPORTER_OTLP_ENDPOINT is set; must
 * be imported before any other module so HTTP, Express and ioredis are instrumented.
 * Spans carry route templates and timings; request bodies, headers and query strings are not
 * recorded (no message content or tokens in traces).
 */
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { ExpressInstrumentation } from '@opentelemetry/instrumentation-express';
import { HttpInstrumentation } from '@opentelemetry/instrumentation-http';
import { IORedisInstrumentation } from '@opentelemetry/instrumentation-ioredis';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { NodeSDK } from '@opentelemetry/sdk-node';
import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } from '@opentelemetry/semantic-conventions';

const endpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;

export function startTracing(serviceName: string): void {
  if (!endpoint) return;
  const sdk = new NodeSDK({
    resource: resourceFromAttributes({
      [ATTR_SERVICE_NAME]: process.env.OTEL_SERVICE_NAME ?? serviceName,
      [ATTR_SERVICE_VERSION]: process.env.npm_package_version ?? '0.1.0',
    }),
    traceExporter: new OTLPTraceExporter({ url: `${endpoint.replace(/\/$/, '')}/v1/traces` }),
    instrumentations: [
      new HttpInstrumentation({
        // Health checks and metrics scrapes would drown real traffic.
        ignoreIncomingRequestHook: (req) => /^\/(api\/v1\/health|metrics)/.test(req.url ?? ''),
        // Drop query strings from span names/attributes (may contain search terms).
        requestHook: (span, req) => {
          if ('url' in req && typeof req.url === 'string')
            span.setAttribute('url.path', req.url.split('?')[0]!);
        },
      }),
      new ExpressInstrumentation(),
      new IORedisInstrumentation({ dbStatementSerializer: (command) => command }),
    ],
  });
  sdk.start();
  const stop = () => void sdk.shutdown().catch(() => undefined);
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
}
