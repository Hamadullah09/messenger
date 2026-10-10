# ADR-0005: Dependency baseline and version policy

Status: Accepted (2026-10-10)

## Decision
Pin to the newest patch of mature major lines with known migration paths:
Node.js 24 LTS, TypeScript 5.9, NestJS 11, Prisma 6.19, Next.js 15.5, React 19.2,
Tailwind CSS 4, Socket.IO 4.8, BullMQ 5, ioredis 5, Zod 4, Vitest 3.
Newer majors available at the time of writing (TypeScript 7, NestJS 12, Prisma 7/8,
Vitest 5) are deliberately deferred until they have been evaluated in a dedicated
upgrade branch; Prisma 8 was still a release candidate.
`package-lock.json` pins the full tree. `npm audit --audit-level=high` runs in CI.

## Local object storage
MinIO's community container images are no longer published to public registries, so
local development uses SeaweedFS (Apache-2.0) as the S3-compatible store. Production
targets AWS S3 or Cloudflare R2; code uses only the AWS SDK v3 S3 API.
