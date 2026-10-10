import { existsSync } from 'node:fs';

/**
 * Development convenience: load apps/api/.env when present. Production configuration comes
 * from the real environment (container/orchestrator secrets) and never from files.
 */
if (process.env.NODE_ENV !== 'production' && existsSync('.env')) {
  process.loadEnvFile('.env');
}
