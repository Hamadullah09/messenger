import { z } from 'zod';

const booleanFromString = z
  .enum(['true', 'false', '1', '0'])
  .transform((v) => v === 'true' || v === '1');

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(4000),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  CORS_ORIGINS: z
    .string()
    .default('http://localhost:3000')
    .transform((v) =>
      v
        .split(',')
        .map((o) => o.trim())
        .filter(Boolean),
    ),
  TRUST_PROXY_HOPS: z.coerce.number().int().min(0).max(10).default(0),
  DATABASE_URL: z.string().url(),
  REDIS_URL: z.string().url(),
  JWT_ACCESS_SECRET: z.string().min(32, 'JWT_ACCESS_SECRET must be at least 32 characters'),
  ACCESS_TOKEN_TTL_SECONDS: z.coerce.number().int().min(60).max(3600).default(900),
  REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().min(1).max(90).default(30),
  SESSION_ABSOLUTE_TTL_DAYS: z.coerce.number().int().min(1).max(365).default(90),
  COOKIE_SECURE: booleanFromString.default(true),
  DATA_ENCRYPTION_KEY: z
    .string()
    .refine(
      (v) => Buffer.from(v, 'base64').length === 32,
      'DATA_ENCRYPTION_KEY must be 32 bytes, base64-encoded',
    ),
  MFA_ISSUER: z.string().min(1).max(40).default('SMA'),
  MFA_REQUIRED_FOR_PRIVILEGED: booleanFromString.default(true),
  OPENAPI_ENABLED: booleanFromString.default(false),

  // ── Object storage (S3-compatible). Credentials stay server-side. ──
  /** Endpoint the API/worker use. Omit for AWS S3. */
  S3_ENDPOINT: z.string().url().optional(),
  /** Endpoint embedded in presigned URLs given to browsers (defaults to S3_ENDPOINT). */
  S3_PUBLIC_ENDPOINT: z.string().url().optional(),
  S3_REGION: z.string().min(1).default('us-east-1'),
  S3_BUCKET: z.string().min(3).max(63),
  S3_ACCESS_KEY_ID: z.string().min(1),
  S3_SECRET_ACCESS_KEY: z.string().min(1),
  S3_FORCE_PATH_STYLE: booleanFromString.default(false),
  /** Development only: create the bucket and its CORS rule at startup. */
  S3_AUTO_CREATE_BUCKET: booleanFromString.default(false),

  // ── Media policy ──
  /** Hard ceiling for any upload, regardless of business policy. */
  MEDIA_PLATFORM_MAX_MB: z.coerce.number().int().min(1).max(5120).default(1024),
  /** Uploads larger than this use multipart uploads. */
  MEDIA_MULTIPART_THRESHOLD_MB: z.coerce.number().int().min(5).max(512).default(16),
  MEDIA_PART_SIZE_MB: z.coerce.number().int().min(5).max(512).default(16),
  MEDIA_UPLOAD_URL_TTL_SECONDS: z.coerce.number().int().min(60).max(3600).default(900),
  MEDIA_DOWNLOAD_URL_TTL_SECONDS: z.coerce.number().int().min(30).max(900).default(300),
  /** Abandoned uploads are cleaned up after this many hours. */
  MEDIA_UPLOAD_EXPIRY_HOURS: z.coerce.number().int().min(1).max(168).default(24),

  // ── Malware scanning ──
  /** "clamav" (required in production) or "disabled" (local experiments only). */
  MALWARE_SCANNER: z.enum(['clamav', 'disabled']).default('clamav'),
  CLAMAV_HOST: z.string().min(1).default('127.0.0.1'),
  CLAMAV_PORT: z.coerce.number().int().min(1).max(65535).default(3310),
  CLAMAV_TIMEOUT_MS: z.coerce.number().int().min(1000).max(600_000).default(120_000),

  // ── Emergency ──
  /** How often the worker checks for unacknowledged alerts whose deadline passed. */
  EMERGENCY_SWEEP_INTERVAL_MS: z.coerce.number().int().min(1000).max(3_600_000).default(5000),

  // ── Metrics (Prometheus) ──
  METRICS_ENABLED: z
    .enum(['true', 'false'])
    .default('true')
    .transform((v) => v === 'true'),
  /** Interface for the internal metrics endpoint. Keep it private (loopback or cluster network). */
  METRICS_HOST: z.string().min(1).default('127.0.0.1'),
  METRICS_PORT: z.coerce.number().int().min(1).max(65535).default(9464),
  METRICS_WORKER_PORT: z.coerce.number().int().min(1).max(65535).default(9465),
  /** Optional bearer token required by /metrics. */
  METRICS_TOKEN: z.string().min(32).optional(),
  /** OpenTelemetry tracing is enabled when an OTLP endpoint is set (see infra/tracing). */
  OTEL_EXPORTER_OTLP_ENDPOINT: z.url().optional(),

  // ── Push notifications ──
  /** Web Push (VAPID). Generate once: npx web-push generate-vapid-keys. Disabled when unset. */
  VAPID_PUBLIC_KEY: z.string().min(80).optional(),
  VAPID_PRIVATE_KEY: z.string().min(40).optional(),
  /** Contact for push services, e.g. mailto:ops@example.com */
  VAPID_SUBJECT: z
    .string()
    .regex(/^(mailto:|https:\/\/)/, 'Use mailto: or https:')
    .default('mailto:ops@example.com'),
  /**
   * Push services the server may POST to (SSRF guard). Hostname suffixes; subscriptions with
   * other endpoints are rejected.
   */
  WEB_PUSH_ALLOWED_HOSTS: z
    .string()
    .default('fcm.googleapis.com,push.services.mozilla.com,notify.windows.com,web.push.apple.com')
    .transform((v) =>
      v
        .split(',')
        .map((h) => h.trim().toLowerCase())
        .filter(Boolean),
    ),

  // ── Bulk campaigns ──
  /** Dispatcher round interval; each round serves every tenant with a sending campaign once. */
  CAMPAIGN_DISPATCH_INTERVAL_MS: z.coerce.number().int().min(100).max(3_600_000).default(1000),
  /** Upper bound on recipients per batch transaction (the tenant quota may lower it). */
  CAMPAIGN_BATCH_SIZE: z.coerce.number().int().min(1).max(2000).default(200),
});

export type AppConfig = z.infer<typeof envSchema>;

export const APP_CONFIG = Symbol('APP_CONFIG');

/** Parse and validate the environment once at boot. Fails fast with readable errors. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join('.')}: ${i.message}`)
      .join('\n');
    throw new Error(`Invalid configuration:\n${issues}`);
  }
  const config = parsed.data;
  if (config.NODE_ENV === 'production' && !config.COOKIE_SECURE) {
    throw new Error('Invalid configuration: COOKIE_SECURE must be true in production');
  }
  if (config.NODE_ENV === 'production' && !config.MFA_REQUIRED_FOR_PRIVILEGED) {
    throw new Error(
      'Invalid configuration: MFA_REQUIRED_FOR_PRIVILEGED must be true in production',
    );
  }
  if (config.NODE_ENV === 'production' && config.MALWARE_SCANNER !== 'clamav') {
    throw new Error('Invalid configuration: MALWARE_SCANNER must be "clamav" in production');
  }
  if (config.NODE_ENV === 'production' && config.S3_AUTO_CREATE_BUCKET) {
    throw new Error('Invalid configuration: S3_AUTO_CREATE_BUCKET is for development only');
  }
  return config;
}
