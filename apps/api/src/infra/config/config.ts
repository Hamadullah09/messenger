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
  /**
   * Development: also accept web origins on private network addresses (192.168.x.x, 10.x…),
   * so phones and other computers on the same Wi-Fi can use the app. Refused in production.
   */
  CORS_ALLOW_LAN: booleanFromString.default(false),
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

  // ── Email (password reset links) ──
  /** smtp(s)://user:pass@host:port. Unset: no email is sent and "forgot password" says so. */
  SMTP_URL: z.preprocess((v) => (v === '' ? undefined : v), z.string().url().optional()),
  MAIL_FROM: z.string().min(3).max(200).default('SMA Technology <no-reply@sma.local>'),
  /** Public address of the web app, used in links inside emails. */
  WEB_APP_URL: z.string().url().default('http://localhost:3000'),
  PASSWORD_RESET_TTL_MINUTES: z.coerce.number().int().min(5).max(1440).default(30),

  // ── Marketing to store customers (each channel is off until its keys are set) ──
  /** SMS through Twilio. */
  TWILIO_ACCOUNT_SID: z.preprocess((v) => (v === '' ? undefined : v), z.string().optional()),
  TWILIO_AUTH_TOKEN: z.preprocess((v) => (v === '' ? undefined : v), z.string().optional()),
  /** Sender number (E.164) or Messaging Service SID (MG…). */
  TWILIO_FROM: z.preprocess((v) => (v === '' ? undefined : v), z.string().optional()),
  /** WhatsApp Business through Meta's Cloud API. */
  WHATSAPP_PHONE_NUMBER_ID: z.preprocess((v) => (v === '' ? undefined : v), z.string().optional()),
  WHATSAPP_ACCESS_TOKEN: z.preprocess((v) => (v === '' ? undefined : v), z.string().optional()),
  /** An approved template with two body variables: {{1}} customer name, {{2}} message. */
  WHATSAPP_TEMPLATE_NAME: z.preprocess((v) => (v === '' ? undefined : v), z.string().optional()),
  WHATSAPP_TEMPLATE_LANGUAGE: z.string().default('en'),
  /** Messages sent per dispatch round (every CAMPAIGN_DISPATCH_INTERVAL_MS). */
  CUSTOMER_CAMPAIGN_BATCH_SIZE: z.coerce.number().int().min(1).max(500).default(30),

  // ── Voice and video calls (WebRTC) ──
  /**
   * ICE servers as JSON, e.g. [{"urls":"stun:stun.example.com:3478"},{"urls":"turn:turn.example.com:3478","username":"u","credential":"p"}].
   * Empty works on one local network; calls across the internet need STUN, and often TURN.
   */
  CALL_ICE_SERVERS: z
    .string()
    .default('[]')
    .transform((v, ctx) => {
      try {
        const parsed = JSON.parse(v) as unknown;
        if (!Array.isArray(parsed)) throw new Error('not an array');
        return parsed as Array<{ urls: string | string[]; username?: string; credential?: string }>;
      } catch {
        ctx.addIssue({ code: 'custom', message: 'CALL_ICE_SERVERS must be a JSON array' });
        return z.NEVER;
      }
    }),
  /** Map tiles for location previews (fetched by the server). {z}/{x}/{y} are filled in. */
  MAP_TILE_URL: z.string().default('https://tile.openstreetmap.org/{z}/{x}/{y}.png'),
  /** Seconds a call rings before it counts as missed. */
  CALL_RING_SECONDS: z.coerce.number().int().min(10).max(120).default(45),

  // ── CRM (deals, invoices, targets) ──
  /** Currency of deals, invoices and targets (ISO 4217). */
  CRM_CURRENCY: z.string().length(3).toUpperCase().default('USD'),
  /** Days until an invoice is due. */
  INVOICE_DUE_DAYS: z.coerce.number().int().min(0).max(365).default(14),
  /** Printed at the top of invoices. */
  INVOICE_COMPANY_NAME: z.string().max(160).default('SMA Technology'),
  INVOICE_COMPANY_ADDRESS: z.string().max(500).default(''),
  INVOICE_COMPANY_EMAIL: z.string().max(254).default(''),
  INVOICE_COMPANY_PHONE: z.string().max(40).default(''),
  /** Payment instructions printed at the bottom (bank account, etc.). */
  INVOICE_PAYMENT_DETAILS: z.string().max(1000).default(''),

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

const LAN_ORIGIN =
  /^https?:\/\/(localhost|127\.0\.0\.1|10(\.\d{1,3}){3}|192\.168(\.\d{1,3}){2}|172\.(1[6-9]|2\d|3[01])(\.\d{1,3}){2})(:\d{1,5})?$/;

/** A private-network or local host name (192.168.x.x, 10.x, 172.16–31.x, localhost). */
export function isLanHostname(hostname: string): boolean {
  return LAN_ORIGIN.test(`http://${hostname}`);
}

/** Whether a browser Origin may call the API (CORS, Socket.IO and the refresh CSRF check). */
export function isAllowedOrigin(config: AppConfig, origin: string): boolean {
  return config.CORS_ORIGINS.includes(origin) || (config.CORS_ALLOW_LAN && LAN_ORIGIN.test(origin));
}

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
  if (config.NODE_ENV === 'production' && config.CORS_ALLOW_LAN) {
    throw new Error('Invalid configuration: CORS_ALLOW_LAN is for development only');
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
