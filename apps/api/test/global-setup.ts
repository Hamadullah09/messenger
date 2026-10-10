import { execSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

/** Applies migrations to the test database once before the integration suites run. */
export default function setup(): void {
  const file = resolve(__dirname, '../.env.test');
  if (existsSync(file)) process.loadEnvFile(file);
  if (!process.env.DATABASE_URL?.includes('test')) {
    throw new Error(
      'Refusing to run integration tests: DATABASE_URL must point at a test database',
    );
  }
  execSync('npx prisma migrate deploy', {
    cwd: resolve(__dirname, '..'),
    env: process.env,
    stdio: 'pipe',
  });
}
