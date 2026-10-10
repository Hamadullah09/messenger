# Dependency Advisory Exceptions

`npm audit` runs in CI. Advisories are fixed by upgrading or by scoped `overrides` in the root
`package.json`. Remaining exceptions are recorded here with an owner decision and expiry.

## Fixed via overrides (2026-10-10)

| Package | Advisory | Fix |
| --- | --- | --- |
| `js-yaml` (via `@nestjs/swagger`) | CPU exhaustion via merge keys (≤ 5.4.0) | `overrides["@nestjs/swagger"]["js-yaml"] = ^5.4.3` |
| `postcss` (bundled by `next` 15.5) | Source-map file disclosure / stringify XSS (≤ 8.5.22) | `overrides.next.postcss = ^8.5.29` |
| `vitest`, `tinypool`, `@vitest/mocker` | Path traversal / prototype pollution in test runner | Upgraded to Vitest 4.1.11 |

## Accepted (time-boxed)

| Package | Advisory | Why accepted | Expires |
| --- | --- | --- | --- |
| `deepmerge-ts` 7.1.5 via `@prisma/config` / `prisma` CLI 6.19.3 | Stack exhaustion when merging recursive object graphs | Only reachable through the Prisma **CLI** loading our own configuration during `prisma generate` / `migrate deploy`; never processes untrusted input and is not loaded by the running API (`@prisma/client` is unaffected). Overriding it to 8.x makes npm drop `@prisma/config` and breaks the CLI. Resolved by the planned Prisma 7 upgrade (ADR-0005). | 2027-01-31 |
