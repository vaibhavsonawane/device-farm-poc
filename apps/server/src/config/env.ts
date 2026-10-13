import { z } from 'zod';

const bool = z.enum(['true', 'false', '1', '0']).transform((v) => v === 'true' || v === '1');

const csv = z
  .string()
  .default('')
  .transform((v) =>
    v
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  );

const secret = z.string().min(32, 'must be at least 32 characters');

export const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().default(3000),
  /** Public origin used to build absolute URLs for agents, e.g. https://devicelab.bank.local */
  PUBLIC_URL: z.string().url().default('http://localhost:3000'),
  CORS_ORIGINS: csv,
  TRUST_PROXY: z.string().default('loopback,uniquelocal'),

  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().default('redis://localhost:6379'),

  JWT_ACCESS_SECRET: secret,
  JWT_STREAM_SECRET: secret,
  JWT_ACCESS_TTL_SEC: z.coerce.number().int().min(60).default(900),
  REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().min(1).default(7),

  STORAGE_DRIVER: z.enum(['s3', 'fs']).default('s3'),
  STORAGE_DIR: z.string().default('./storage'),
  S3_ENDPOINT: z.string().default('http://localhost:9000'),
  S3_REGION: z.string().default('us-east-1'),
  S3_BUCKET: z.string().default('devicelab'),
  S3_ACCESS_KEY: z.string().default(''),
  S3_SECRET_KEY: z.string().default(''),
  UPLOAD_MAX_MB: z.coerce.number().int().min(1).default(500),

  RESERVATION_DEFAULT_MIN: z.coerce.number().int().min(5).default(30),
  RESERVATION_MAX_MIN: z.coerce.number().int().min(5).default(120),
  IDLE_WARN_MIN: z.coerce.number().min(0.1).default(5),
  IDLE_RELEASE_MIN: z.coerce.number().min(0.2).default(10),
  DEVICE_OFFLINE_GRACE_MIN: z.coerce.number().min(0).default(3),
  /** Max concurrent ACTIVE reservations per user, by role. */
  RESERVATION_LIMIT_TESTER: z.coerce.number().int().min(0).default(2),
  RESERVATION_LIMIT_LEAD: z.coerce.number().int().min(0).default(4),
  RESERVATION_LIMIT_ADMIN: z.coerce.number().int().min(0).default(10),
  SWEEP_INTERVAL_SEC: z.coerce.number().min(1).default(15),
  /** Packages never uninstalled by cleanup (e.g. lab tooling). */
  CLEANUP_KEEP_PACKAGES: csv,
  CLEANUP_REBOOT: bool.default(false),

  HOST_HEARTBEAT_TIMEOUT_SEC: z.coerce.number().int().min(5).default(20),

  SEED_ADMIN_EMAIL: z.string().email().default('admin@devicelab.local'),
  SEED_ADMIN_PASSWORD: z.string().optional(),
});

export type Env = z.infer<typeof envSchema>;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const parsed = envSchema.safeParse(source);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  const env = parsed.data;
  if (env.IDLE_RELEASE_MIN <= env.IDLE_WARN_MIN) {
    throw new Error('IDLE_RELEASE_MIN must be greater than IDLE_WARN_MIN');
  }
  return env;
}
