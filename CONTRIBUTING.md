# Contributing

## Requirements

Node >= 22.12. Docker, for the integration tests and the demo.

## Setup

```bash
npm ci
npx prisma generate   # run again after editing prisma/schema.prisma
```

## Commands

```bash
npm run build            # tsup -> dist/
npm run typecheck        # tsc --noEmit
npm test                 # unit + integration (needs Docker)
npm run test:unit        # no DB, fast
npm run test:integration # real Postgres via testcontainers
npx vitest run tests/prisma.test.ts   # single file
```

## Before committing

Run `npm run lint && npm run typecheck && npm run test:unit` (`npm run format` applies fixes). Also run `npm test` if you touched
`src/adapters/prisma/errors.ts`, `prisma/schema.prisma`, or anything under `tests/integration/`.

## Code style

ESM only. Use `import type` for types and `.js` extensions on relative imports. No semicolons,
double quotes, 2-space indent. Match the existing files.

Commits use conventional prefixes: `feat:`, `fix:`, `docs:`, `test:`, `chore:`.

## Prisma error shapes

Every new Prisma error `meta` shape needs a unit test in `tests/prisma.test.ts` that uses the raw
`meta` literal.
