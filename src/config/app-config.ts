import { z } from 'zod';

const LOG_LEVELS = [
  'fatal',
  'error',
  'warn',
  'info',
  'debug',
  'trace',
  'silent',
] as const;

const envSchema = z.object({
  NODE_ENV: z
    .enum(['development', 'test', 'production'])
    .default('development'),
  LOG_LEVEL: z.enum(LOG_LEVELS).default('info'),
  LOG_PRETTY: z.stringbool().default(false),

  HTTP_HOST: z.string().min(1).default('0.0.0.0'),
  HTTP_PORT: z.coerce.number().int().min(1).max(65535).default(3000),

  DATABASE_URL: z
    .string()
    .regex(/^postgres(ql)?:\/\/.+/, 'must be a postgres:// connection string'),
  DB_POOL_MAX: z.coerce.number().int().min(1).max(200).default(10),
  DB_SSL: z.stringbool().default(false),
  DB_SSL_REJECT_UNAUTHORIZED: z.stringbool().default(true),

  TASK_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(20).default(5),
  TASK_HEARTBEAT_SECONDS: z.coerce.number().int().min(10).max(600).default(30),
  TASK_EXPIRY_GRACE_SECONDS: z.coerce
    .number()
    .int()
    .min(5)
    .max(600)
    .default(30),
  TASK_RETENTION_DAYS: z.coerce.number().int().min(1).max(3650).default(7),

  PGBOSS_SCHEMA: z
    .string()
    .regex(/^[a-z_][a-z0-9_]{0,62}$/, 'must be a lowercase SQL identifier')
    .default('pgboss'),
  PGBOSS_POOL_MAX: z.coerce.number().int().min(1).max(100).default(5),

  WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(100000).default(1000),
  WORKER_POLL_INTERVAL_MS: z.coerce
    .number()
    .int()
    .min(50)
    .max(60000)
    .default(500),
  WORKER_FETCH_BATCH: z.coerce.number().int().min(1).max(1000).default(50),
  WORKER_SHUTDOWN_TIMEOUT_MS: z.coerce
    .number()
    .int()
    .min(1000)
    .max(300000)
    .default(20000),
  PROGRESS_FLUSH_INTERVAL_MS: z.coerce
    .number()
    .int()
    .min(50)
    .max(10000)
    .default(250),
  SIMULATED_FAILURE_RATE: z.coerce.number().min(0).max(1).default(0),
});

export interface AppConfig {
  env: 'development' | 'test' | 'production';
  log: { level: (typeof LOG_LEVELS)[number]; pretty: boolean };
  http: { host: string; port: number };
  db: {
    url: string;
    poolMax: number;
    ssl: false | { rejectUnauthorized: boolean };
  };
  tasks: {
    maxAttempts: number;
    heartbeatSeconds: number;
    expiryGraceSeconds: number;
    retentionDays: number;
  };
  queue: { schema: string; poolMax: number };
  worker: {
    concurrency: number;
    pollIntervalMs: number;
    fetchBatch: number;
    shutdownTimeoutMs: number;
    progressFlushIntervalMs: number;
    simulatedFailureRate: number;
  };
}

export class ConfigError extends Error {
  constructor(readonly issues: string[]) {
    super(
      `Invalid configuration:\n${issues.map((issue) => `  - ${issue}`).join('\n')}`,
    );
    this.name = 'ConfigError';
  }
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  if (env === process.env) {
    loadDotEnvIfPresent();
  }
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    throw new ConfigError(
      parsed.error.issues.map(
        (issue) => `${issue.path.join('.') || 'env'}: ${issue.message}`,
      ),
    );
  }
  const e = parsed.data;
  return {
    env: e.NODE_ENV,
    log: { level: e.LOG_LEVEL, pretty: e.LOG_PRETTY },
    http: { host: e.HTTP_HOST, port: e.HTTP_PORT },
    db: {
      url: e.DATABASE_URL,
      poolMax: e.DB_POOL_MAX,
      ssl: e.DB_SSL
        ? { rejectUnauthorized: e.DB_SSL_REJECT_UNAUTHORIZED }
        : false,
    },
    tasks: {
      maxAttempts: e.TASK_MAX_ATTEMPTS,
      heartbeatSeconds: e.TASK_HEARTBEAT_SECONDS,
      expiryGraceSeconds: e.TASK_EXPIRY_GRACE_SECONDS,
      retentionDays: e.TASK_RETENTION_DAYS,
    },
    queue: {
      schema: e.PGBOSS_SCHEMA,
      poolMax: e.PGBOSS_POOL_MAX,
    },
    worker: {
      concurrency: e.WORKER_CONCURRENCY,
      pollIntervalMs: e.WORKER_POLL_INTERVAL_MS,
      fetchBatch: e.WORKER_FETCH_BATCH,
      shutdownTimeoutMs: e.WORKER_SHUTDOWN_TIMEOUT_MS,
      progressFlushIntervalMs: e.PROGRESS_FLUSH_INTERVAL_MS,
      simulatedFailureRate: e.SIMULATED_FAILURE_RATE,
    },
  };
}

export function loadDotEnvIfPresent(path = '.env'): void {
  if (process.env.NODE_ENV === 'production') {
    return;
  }
  try {
    process.loadEnvFile(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error;
    }
  }
}
