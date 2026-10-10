# SMA — Business Messaging (SMA Technology)

Multi-tenant business messaging and store-operations platform: WhatsApp-style chat for
businesses with many stores, with strict tenant isolation, role-based administration,
privacy-protected contact details and a durable delivery pipeline.

> **Status:** all eight phases are implemented and tested — foundation, identity & access control,
> core messaging, media, emergency help, bulk campaigns, operations (metrics, alerting, backups,
> load and resilience tests, deployment automation) and multi-client readiness (devices, push,
> native auth, frozen API contract). It is a **release candidate**, not production-certified:
> see [docs/roadmap.md](docs/roadmap.md) for what remains (production-hardware load tests,
> external security review, mobile push credentials, native apps).

## Repository

```
apps/api          NestJS API (REST /api/v1 + Socket.IO) and background worker (outbox → BullMQ → sockets)
apps/web          Next.js web client
packages/shared   Zod schemas, DTOs, permission catalog and authorization evaluator shared by all clients
infrastructure    Dockerfiles and local infrastructure config
docs              Architecture, ADRs, security, API outline, operations
```

Start with [docs/architecture/README.md](docs/architecture/README.md).

## Local development

Requirements: Node.js 24, Docker.

```bash
npm install
docker compose up -d                      # PostgreSQL 17, Redis 7.4, SeaweedFS (S3), ClamAV (first start downloads signatures)
cp apps/api/.env.example apps/api/.env    # then fill JWT_ACCESS_SECRET, DATA_ENCRYPTION_KEY, SEED_PASSWORD
cp apps/web/.env.example apps/web/.env.local
npx prisma generate --schema apps/api/prisma/schema.prisma
npm run build:shared
npm run db:migrate
npm run db:seed
npm run db:demo -w @storeline/api     # optional: more people, chat history, emergencies, campaigns
```

Run the three processes (separate terminals):

```bash
npm run dev:api      # http://localhost:4000  (Swagger: /api/docs when OPENAPI_ENABLED=true)
npm run dev:worker   # outbox relay + delivery workers
npm run dev:web      # http://localhost:3000
```

Seeded demo accounts (password = `SEED_PASSWORD` from `apps/api/.env`):

| Username | Role |
| --- | --- |
| `superadmin` | Super Admin (sets up two-step verification at first sign-in) |
| `bizadmin` | Business Admin, ABC Retail Group |
| `manager.a`, `manager.b` | Store Managers (stores A, B) |
| `security.a` | Security, store A |
| `alice`, `bob`, `carol`, `dave` | Employees (A, A, B, C) |
| `nw.admin`, `nw.staff` | Second tenant (Northwind Pharmacy) for isolation checks |

All demo people, emails and phone numbers are fictitious.

## Tests

```bash
npm run test:unit          # authorization evaluator (packages/shared)
npm run test:integration   # API against real PostgreSQL + Redis + Socket.IO + worker (uses storeline_test)
npm run lint && npm run typecheck && npm run format:check
```

Integration tests need `apps/api/.env.test` (same keys as `.env`, pointing at the
`storeline_test` database and Redis DB 1) or the equivalent environment variables (see CI).

## Database migrations

Migrations live in `apps/api/prisma/migrations`. The initial migration contains hand-written
SQL (partial unique indexes, check constraints, a GIN full-text index) that the Prisma schema
cannot express. When creating a new migration use `prisma migrate dev --create-only` and remove
any generated statements that would drop those objects before applying it.
