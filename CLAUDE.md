# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm run build       # tsup — compiles src/ to dist/
npm run typecheck   # tsc --noEmit (strict, no build output)
npm test            # vitest run (single pass)
npm run test:watch  # vitest (watch mode)
```

Run a single test file:
```bash
npx vitest run tests/prisma.test.ts
```

## Architecture

**zod-bridge** bridges Prisma's untyped errors (`P2002`, `P2025`, etc.) into typed classes and provides DB-aware async uniqueness validators for Zod v4.

Two package entry points built by tsup:

| Export | Source | Purpose |
|--------|--------|---------|
| `zod-bridge` | `src/index.ts` → `src/core/index.ts` | Pure Zod helpers, no DB dep (Phase 3: `unique()`, `uniqueComposite()`) |
| `zod-bridge/prisma` | `src/adapters/prisma/index.ts` | Prisma error classes + helpers |

**Phases 1 and 3 implemented.** Phase 4 (schema bridge) still pending.

**Adapter isolation:** `src/core/` has zero DB dependency. Adding a Drizzle adapter means only `src/adapters/drizzle/` — core and Prisma adapter stay untouched.

## Key design decisions

- **Zod v4 only** — v3 broke `instanceof`, error API, and internals. No cross-version support.
- **`zod` and `@prisma/client` are peerDependencies** — two Zod copies break `instanceof`; type compat requires the user's version.
- **`unique()` requires `parseAsync`** — uses `.superRefine()` which is async. Document this at call sites; `.parse()` will throw.
- **`excludeWhere` not `excludeId`** — handles composite PKs and non-`id` PK names on update operations.
- **`handlePrismaError` is the safety net** — the Zod async check is best-effort UX; `handlePrismaError` catches race-condition slip-throughs. This is a feature, document it.
- **Composite unique fields as arrays** — `fields: ["userId", "postId"]`, not comma-separated strings. Order-independent and typo-safe.

## Testing strategy

- **SQLite in-memory** — fast, covers most cases. `meta.target` is a `string` on SQLite.
- **Postgres via testcontainers** — `meta.target` is `string[]` on Postgres/MySQL; composite-unique shape differs. Required for shape-sensitive tests.

## CI

- `test.yml` — runs `typecheck` + `test` on Node 20 and 22 for every PR.
- `publish.yml` — publishes to npm on git tag push with provenance (`id-token: write` permission required).

## Roadmap status

Phase 0 (project setup) ✅ · Phase 0.5 (design decisions) ✅ · Phase 1 (typed Prisma errors) ✅ · Phase 3 (Zod extension) ✅ · **Phase 4 (schema bridge) next**
