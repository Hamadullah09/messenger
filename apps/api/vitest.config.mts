import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// SWC materialises its native binding into a cache directory. Keep it inside node_modules so
// it does not depend on user-profile directory permissions (which differ on locked-down machines).
process.env.SWC_NATIVE_BINDING_CACHE ??= fileURLToPath(
  new URL('../../node_modules/.cache/swc', import.meta.url),
);

// SWC is required because NestJS relies on emitDecoratorMetadata, which esbuild does not support.
const { default: swc } = await import('unplugin-swc');
const plugins = [swc.vite({ module: { type: 'es6' } })];

export default defineConfig({
  test: {
    // Integration suites share one database, so test files run one at a time.
    fileParallelism: false,
    projects: [
      {
        plugins,
        test: {
          name: 'unit',
          include: ['src/**/*.spec.ts'],
          environment: 'node',
        },
      },
      {
        plugins,
        test: {
          name: 'integration',
          include: ['test/**/*.e2e-spec.ts'],
          environment: 'node',
          setupFiles: ['test/setup-env.ts'],
          globalSetup: ['test/global-setup.ts'],
          // One file at a time: suites share a database and reset it in beforeAll.
          fileParallelism: false,
          testTimeout: 30_000,
          hookTimeout: 60_000,
        },
      },
    ],
  },
});
