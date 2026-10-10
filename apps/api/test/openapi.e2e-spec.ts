import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildOpenApiDocument } from '../src/bootstrap';
import { Harness } from './harness';

const SNAPSHOT = resolve(__dirname, '../../../docs/api/openapi.json');

/** Stable key order so the committed file diffs cleanly. */
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((k) => [k, canonical((value as Record<string, unknown>)[k])]),
    );
  return value;
}

type Paths = Record<string, Record<string, unknown>>;
const operations = (doc: { paths: Paths }) =>
  Object.entries(doc.paths).flatMap(([path, methods]) =>
    Object.keys(methods).map((m) => `${m.toUpperCase()} ${path}`),
  );

/**
 * API contract check for desktop/mobile clients (docs/architecture/clients.md). The v1 contract
 * is committed; removing an operation is a breaking change and fails with a clear message, and
 * any other change requires regenerating the snapshot deliberately:
 *   UPDATE_OPENAPI=1 npx vitest run --project integration test/openapi.e2e-spec.ts
 */
describe('OpenAPI v1 contract', () => {
  let h: Harness;
  beforeAll(async () => {
    h = await Harness.start();
  });
  afterAll(() => h.stop());

  it('matches the committed contract and never removes v1 operations', () => {
    const current = canonical(buildOpenApiDocument(h.app)) as { paths: Paths };
    const text = JSON.stringify(current, null, 2) + '\n';
    if (process.env.UPDATE_OPENAPI === '1' || !existsSync(SNAPSHOT)) {
      writeFileSync(SNAPSHOT, text);
      return;
    }
    const committed = JSON.parse(readFileSync(SNAPSHOT, 'utf8')) as { paths: Paths };
    const removed = operations(committed).filter((op) => !operations(current).includes(op));
    expect(removed, 'Breaking change: v1 operations were removed (add a v2 instead)').toEqual([]);
    expect(
      text === readFileSync(SNAPSHOT, 'utf8'),
      'The API contract changed: review it and run UPDATE_OPENAPI=1 for this test to update docs/api/openapi.json',
    ).toBe(true);
  });
});
