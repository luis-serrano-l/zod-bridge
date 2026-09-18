# CLAUDE.md

Guidance for Claude Code when working in this repository. Keep it accurate: when you change
scripts, CI, exports, or a design decision, update the matching section here.

## What this is

**zod-bridge** — the async validation layer Zod lacks. Two things:

1. Typed Prisma error classes (`P2002` → `PrismaUniqueConstraintError`, etc.) plus `handlePrismaError`
   and `findOrThrow`.
2. DB-aware async uniqueness validators for Zod v4 (`unique()`, `uniqueComposite()`), with Prisma
   check functions (`prismaUnique`, `prismaUniqueComposite`).

Long-form docs live elsewhere; do not duplicate them here:

- `README.md` — user-facing API and examples
- `DECISIONS.md` — design decisions with rationale
- `ROADMAP.md` — phases, milestone table, how to add adapters and DB providers

## Commands

```bash
npm run build            # tsup → dist/ (ESM only, .d.ts bundled)
npm run typecheck        # tsc --noEmit, strict
npm test                 # vitest run — unit + integration (integration needs Docker)
npm run test:unit        # tests/*.test.ts — no DB, no Docker, fast
npm run test:integration # tests/integration/ — real Postgres via testcontainers
npm run test:watch
npx vitest run tests/prisma.test.ts   # single file
npx prisma generate      # regenerate client after editing prisma/schema.prisma
cd examples/demo && docker compose up --build --abort-on-container-exit && docker compose down -v
```

Requirements: Node ≥ 22.12 (`engines`), Docker for integration tests and the demo.

Before committing: `npm run typecheck && npm run test:unit`. Run `npm test` if you touched
`src/adapters/prisma/errors.ts`, `prisma/schema.prisma`, or anything under `tests/integration/`.

## Layout

```
src/
  index.ts                    # root entry: re-exports core only (must stay DB-free)
  core/index.ts               # unique(), uniqueComposite(), UniqueOptions — no DB imports
  adapters/prisma/
    index.ts                  # zod-bridge/prisma entry
    errors.ts                 # error classes + meta-shape parsing (the fragile part)
    helpers.ts                # handlePrismaError, findOrThrow, prismaUnique, prismaUniqueComposite
  internal/error-adapter.ts   # single place to swap in Prisma-native typed errors if they ever ship
tests/
  core.test.ts, prisma.test.ts        # unit (mocked PrismaClientKnownRequestError)
  integration/postgres.test.ts        # real Postgres
  integration/setup.ts                # vitest globalSetup: starts container, runs db push
prisma/schema.prisma, prisma.config.ts  # test schema: User (unique email), Post (FK), Like (composite unique)
examples/demo/                # dockerized consumer app; installs the lib from a packed tarball
.github/workflows/            # test.yml, publish.yml
```

Package exports (tsup entries must match `package.json` `exports`):

| Import | Source | Rule |
|---|---|---|
| `zod-bridge` | `src/index.ts` | Never import `@prisma/client` here. Core must work with any future adapter. |
| `zod-bridge/prisma` | `src/adapters/prisma/index.ts` | Only place that touches Prisma. |

Adding an adapter (Drizzle, Kysely): new folder `src/adapters/<name>/`, new tsup entry, new
`exports` key. Core and the Prisma adapter stay untouched. See ROADMAP.md.

## Public API (current)

```ts
// zod-bridge
unique(schema, check, options?: string | { message?, excludeWhere? })   // returns schema.superRefine(async ...)
uniqueComposite === unique   // alias; the check fn receives the whole object
type UniqueOptions<TExclude = unknown>   // TExclude = type of excludeWhere, inferred from the check fn

// zod-bridge/prisma
class PrismaUniqueConstraintError   { code: "P2002"; fields: string[] }
class PrismaNotFoundError           { code: "P2025" }
class PrismaForeignKeyError         { code: "P2003"; fieldName: string }
class PrismaRelationViolationError  { code: "P2014"; relationName: string }
handlePrismaError(err): never       // rethrows typed, or rethrows the original untouched
findOrThrow(() => Promise<T | null>): Promise<T>
prismaUnique(model, field, { primaryKey? })            // check fn for unique(); scalar or object value
prismaUniqueComposite(model, fields, { primaryKey? })   // check fn for uniqueComposite()
// Object value + primaryKey fields present (default "id") → that record is excluded (NOT) automatically.
// prismaUnique reports at path [field] in object form. excludeWhere (typed as WhereInput) overrides.
```

`handlePrismaError` takes **no options object**. A per-constraint message map was considered and
dropped (see DECISIONS.md); Phase 4's `createSchema` is where that translation belongs.

## Rules that are easy to get wrong

- **`unique()` requires `parseAsync`.** It uses an async `superRefine`; `.parse()` throws at
  runtime. Every example and test must use `parseAsync` / `safeParseAsync`.
- **The Zod check is best-effort; `handlePrismaError` is the safety net.** Two concurrent requests
  can both pass the refine and one fails at insert. Always show them together in examples. This is
  a documented feature, not a gap to "fix".
- **Update exclusion is implicit and comes from the parsed value.** Validate the object
  (`unique(z.object({ id, email }), prismaUnique(prisma.user, "email"))`) and merge the route id
  in before parsing. A `unique()` on the field inside `z.object` cannot see `id`: Zod refinements
  only see their own value, and Zod v4 has no parse-time context. `excludeWhere` (a Prisma `where`
  fragment merged as `NOT`) is the explicit override, never an `excludeId`.
- **Prisma exposes no primary-key info at runtime.** `Prisma.dmmf.datamodel` fields carry only
  `name`/`kind`/`type` in Prisma 7; the `.d.ts` declares `isId`/`primaryKey` but they are
  `undefined`. That is why `primaryKey` is a convention (`"id"`) with an option, not derived.
- **Composite fields are arrays** (`["userId", "postId"]`), never comma-joined strings.
- **Error field extraction is version-dependent** (`errors.ts`). Order of fallbacks, keep it:
  1. `meta.driverAdapterError.cause.constraint.fields` — Prisma 7 + driver adapter, ≤ 7.9
  2. `meta.driverAdapterError.cause.constraint.index` + `cause.table` — Prisma 7.10+, only the
     index name ships (`User_email_key`, `Post_authorId_fkey`); fields are derived by splitting on `_`
     (best effort: a field containing `_` will split wrongly)
  3. `meta.target` (`string | string[]`) / `meta.field_name` — Prisma ≤ 6 and Prisma 7 without adapter
  Postgres quotes camelCase identifiers; always pass through `unquote`.
  When adding a new shape, add a unit test in `tests/prisma.test.ts` with the raw `meta` literal.
- **Zod v4 only.** No v3 compatibility code. `instanceof`, the issue API, and internals differ.
- **`zod` and `@prisma/client` are peerDependencies** (Prisma optional). Never move them to
  `dependencies` — a second Zod copy breaks `instanceof`.
- **`src/index.ts` stays DB-free.** Typecheck won't catch a stray Prisma import; review for it.

## Pinned versions and why

| Package | Pin | Reason |
|---|---|---|
| `typescript` | 6.x | tsup's `.d.ts` bundler crashes on TS 7.0 (compiler API returns in 7.1). `ignoreDeprecations: "6.0"` in tsconfig silences the `baseUrl` deprecation tsup's dts step triggers. |
| `testcontainers` / `@testcontainers/postgresql` | 11.x | v12 needs Node ≥ 22.22. |
| `@prisma/client` peer | `^5 \|\| ^6 \|\| ^7` | Tested against 7.10+; older shapes handled by the fallbacks above. |

Do not bump these without checking the reason still holds.

## Testing

- **Unit** (`tests/*.test.ts`): construct `Prisma.PrismaClientKnownRequestError` with a literal
  `meta` and assert the typed class. No DB. Add one here for every error-shape change.
- **Integration** (`tests/integration/postgres.test.ts`): `postgres:16-alpine` via testcontainers.
  `setup.ts` sets `DATABASE_URL` and runs `prisma db push`. Pins real `meta` shapes, the race
  window (`unique()` + `handlePrismaError`), composite unique, FK, and not-found. 60s timeout.
- **Demo** (`examples/demo`): builds and `npm pack`s the library, installs the tarball in a plain
  consumer app, runs every feature against Postgres. Use it to verify the published artifact
  (exports map, `.d.ts`, ESM resolution), not just the source.

Prisma 7 specifics used here:
- No `url` in `schema.prisma`; connection comes from `prisma.config.ts` reading `DATABASE_URL`.
- `new PrismaClient({ adapter: new PrismaPg(connectionString) })` — driver adapter is required.
- Prisma 7 cannot switch `provider` via env; another DB means a second schema file (ROADMAP.md).

## CI and release

- `test.yml` — on push to `main` and every PR. `unit` job: typecheck + unit tests on Node 22 and 24.
  `integration` job: Node 22, Docker available on the runner.
- `publish.yml` — on `v*` tag push: typecheck, full tests, build, `npm publish --provenance`.
  Needs `id-token: write` (present) and `NPM_TOKEN` secret.
- **Every job runs `npx prisma generate` right after `npm ci`.** Prisma 7 dropped the postinstall
  auto-generate, so a fresh runner has no `node_modules/.prisma/client`: without it typecheck fails
  with `Module '"@prisma/client"' has no exported member 'Prisma'` (a missing client, not a real
  type error) and the integration suite fails to import. It passes locally only because your
  `node_modules` already holds a generated client. Any new job needs the same step.
- **Before any publish**: test the package in a real project first (`npm link` or install the
  tarball from `npm pack`), or at minimum run the demo. Never tag a release without this.

## Conventions

- ESM only, `verbatimModuleSyntax`: use `import type` for types and `.js` extensions on relative imports.
- `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes` are on; index with `?.["key"]` and
  don't assign `undefined` to optional props.
- No semicolons, double quotes, 2-space indent (match existing files; there is no linter configured).
- Commit messages: conventional prefixes (`feat:`, `fix:`, `docs:`, `test:`, `chore:`).

## Status

Phase 0 ✅ · 0.5 ✅ · 1 (typed errors) ✅ · 3 (Zod extension) ✅ · **Phase 4 (schema bridge) next**.
Phase 2 (Prisma issue/PR outreach) is deferred until 0.1.0 is published. `ROADMAP.md`'s milestone
table lags reality; trust this line and the code.

Phase 4 plan: `createSchema(prisma.user, overrides)` in `zod-bridge/prisma`, deriving the base
shape from the Prisma schema, merging Zod overrides, wiring `primaryKey` for update exclusion.
Prisma exposes neither field types nor primary keys at runtime (see the rule above), so this needs
a codegen step; `Prisma.dmmf` is not a viable source.
