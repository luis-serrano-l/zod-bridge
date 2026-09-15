# zod-bridge — Project Roadmap

## What this is

The missing async validation layer for Zod. Starts with Prisma support,
designed to extend to any DB client. Fills the gap between Zod's pure
validation and the DB-level constraints Prisma exposes only as raw error codes.

---

## Phase 0 — Project Setup with Claude Code

Start the project before writing any library code. Get the structure right first.

### Commands to run with Claude Code

```bash
# Scaffold the package
mkdir zod-bridge && cd zod-bridge
npm init -y
npm install -D zod @prisma/client prisma typescript @types/node vitest tsup

# Init TypeScript
npx tsc --init
```

### Folder structure to create

```
zod-bridge/
├── src/
│   ├── core/
│   │   └── index.ts          # pure Zod helpers, no DB dependency
│   ├── adapters/
│   │   └── prisma/
│   │       ├── errors.ts     # typed error classes
│   │       ├── helpers.ts    # handlePrismaError, findOrThrow
│   │       └── index.ts      # prisma adapter entry point
│   ├── internal/
│   │   └── error-adapter.ts  # detects if Prisma ships native errors
│   └── index.ts              # main entry, re-exports core
├── tests/
│   ├── core.test.ts
│   └── prisma.test.ts
├── .github/
│   └── workflows/
│       ├── test.yml          # run tests on every PR
│       └── publish.yml       # publish to npm on tag push
├── DECISIONS.md
├── LICENSE                   # MIT
├── package.json
├── tsconfig.json
└── README.md
```

### package.json exports configuration

```json
{
  "exports": {
    ".": "./dist/index.js",
    "./prisma": "./dist/adapters/prisma/index.js"
  },
  "peerDependencies": {
    "zod": "^4.0.0",
    "@prisma/client": "^5.0.0 || ^6.0.0"
  },
  "peerDependenciesMeta": {
    "@prisma/client": { "optional": true }
  }
}
```

This keeps core and Prisma separate from day one. Adding Drizzle later
is just a new folder under `adapters/` with no changes to core.

### Checklist

- [x] `npm init` + dev deps installed (zod, @prisma/client, prisma, typescript, vitest, tsup)
- [x] `tsconfig.json` initialized
- [x] Folder structure created (src/core, src/adapters/prisma, src/internal, tests, .github/workflows)
- [x] `package.json` exports + peerDependencies configured
- [x] LICENSE (MIT) added
- [x] `.github/workflows/test.yml` scaffolded
- [x] `.github/workflows/publish.yml` scaffolded

---

## Phase 0.5 — Critical Design Decisions

**Lock these in before writing implementation code. Each one affects the
entire API surface and refactoring later is painful.**

Create `DECISIONS.md` in the repo root and record each decision below with
its rationale as you make it. The milestone table requires this file before
Phase 0.5 is considered complete.

### Zod v3 vs v4

Decision: **Zod v4 only** (`"zod": "^4.0.0"`).

v4 changed error customisation (`message` → `error`), deprecated
`z.string().email()` in favour of `z.email()`, and reorganised internals
(`_def`, prototype shape). Shipping a single codebase that works across both
is not practical without significant abstraction overhead. v3 users should
pin an older version if a backport ever ships.

The test matrix covers only v4.

### Peer dependencies, not regular dependencies

`zod` and `@prisma/client` must be `peerDependencies`. Reasons:

- Two copies of Zod in the bundle breaks `instanceof` checks
- Type compatibility requires the user's Zod version, not yours
- Smaller install size for the user

`devDependencies` for local testing, `peerDependencies` for runtime.

### License

MIT. Standard for this category of library. File goes in repo root in Phase 0.

### Testing strategy

Two layers:

Two test layers:

- **Unit tests** (`tests/*.test.ts`) — mock `PrismaClientKnownRequestError`
  directly. No DB, no Docker. Fast. Covers error class shapes and helpers.

- **Postgres integration tests** (`tests/integration/`) — real Postgres via
  `@testcontainers/postgresql`. Required: Prisma 7 changed the P2002 meta
  structure when using a driver adapter (`meta.driverAdapterError.cause
  .constraint.fields` instead of `meta.target`). Also catches Postgres
  quoting of camelCase identifiers. CI runs both as parallel jobs.

Prisma 7 note: `PrismaClient` requires a driver adapter (e.g.
`@prisma/adapter-pg`). Connection URL moves to `prisma.config.ts`, not
`schema.prisma`.

### CI/CD baseline

GitHub Actions, two workflows from day one:

- `test.yml` — runs on every PR, matrix on Node 20 + 22 (Node 18 EOL April 2025)
- `publish.yml` — runs on git tag push, publishes to npm with provenance.
  Requires `permissions: { id-token: write, contents: read }` in the workflow
  file or provenance attestation is silently skipped.

Set this up in Phase 0 before any feature code. Retrofitting CI is harder
than starting with it.

### Update operation API

The biggest day-one bug if not designed in: `.unique()` on update operations
finds the record being edited and reports "already taken".

Decision: the `unique()` wrapper accepts `excludeWhere` — a Prisma `where`
fragment for the record to skip. Using a full `where` fragment (not a bare
`excludeId`) handles composite PKs and non-`id` PK names:

```ts
import { unique } from "zod-bridge"
import { prismaUnique } from "zod-bridge/prisma"

const schema = unique(
  z.email(),
  prismaUnique(prisma.user, "email"),
  { message: "Email taken", excludeWhere: { id: user.id } }
)
```

`prismaUnique` merges `excludeWhere` as `NOT`:

```ts
{ email: val, NOT: excludeWhere }
```

### Composite unique constraints

`@@unique([userId, postId])` is common for likes, follows, memberships.
P2002 returns multiple fields in `meta.target` for these.

Decision: support composite from Phase 1, both in the error classes
(`PrismaUniqueConstraintError.fields: string[]`) and the validator. Fields are
always arrays, which avoids the brittle comma-separated string keys
(`"userId,postId"`) that are order-sensitive and easy to typo:

```ts
import { uniqueComposite } from "zod-bridge"
import { prismaUniqueComposite } from "zod-bridge/prisma"

const LikeSchema = uniqueComposite(
  z.object({ userId: z.number(), postId: z.number() }),
  prismaUniqueComposite(prisma.like, ["userId", "postId"]),
  "Already liked this post"
)
```

A `handlePrismaError(e, { unique: [...] })` message map was considered and
dropped; see DECISIONS.md. Phase 4's `createSchema` covers that need.

### Race condition handling

Document explicitly: async refine + DB insert is two queries with a race
window between them. Two concurrent requests can both pass the refine and
then one fails at insert.

Design decision: this is **why** `handlePrismaError` exists. The Zod check
is best-effort UX (instant field-level error) and `handlePrismaError` is
the safety net (catches the slip-through). Document this in README as a
feature, not a bug.

### Checklist

- [x] DECISIONS.md created in repo root
- [x] Zod v4-only decision recorded
- [x] Peer-deps rationale recorded
- [x] License decision recorded
- [x] Testing strategy (unit mocks + Postgres testcontainers, Prisma 7 adapter) recorded
- [x] CI/CD baseline recorded
- [x] Update-op API (`excludeWhere`) recorded
- [x] Composite unique API recorded
- [x] Race-condition design note recorded

---

## Phase 1 — Build: Typed Prisma Errors + Helpers

Build before any GitHub activity. Ship working code first.

### What to build

**`src/adapters/prisma/errors.ts`** — typed error classes:

```ts
// Users write:
if (e instanceof PrismaUniqueConstraintError) { ... }
// Instead of:
if (e.code === "P2002") { ... }
```

Cover the four errors that matter for web apps:
- `PrismaUniqueConstraintError` — P2002
- `PrismaNotFoundError` — P2025
- `PrismaForeignKeyError` — P2003
- `PrismaRelationViolationError` — P2014

**`src/adapters/prisma/helpers.ts`** — ergonomics layer:

```ts
// Map errors to readable messages per field, including composite
handlePrismaError(e, {
  unique: [
    { fields: ["email"],            message: "Email already taken" },
    { fields: ["username"],         message: "Username taken" },
    { fields: ["userId", "postId"], message: "Already liked" },
    { fields: [],                   message: "Value already exists" },  // default
  ],
  notFound: "Record not found",
  foreignKey: "Related record not found"
})

// Null-safe fetch — throws if not found
findOrThrow(
  prisma.user.findUnique({ where: { id } }),
  "User not found"
)
```

**`src/internal/error-adapter.ts`** — compatibility layer:

```ts
// Detects if Prisma ships native typed errors and uses those.
// Falls back to our own implementation if not.
// This is the single file you update when Prisma merges the PR.
```

### Pre-publish: test in a real project

Before publishing to npm, install the package locally in a real project via `npm install ../zod-bridge` (or `npm link`) and verify the API feels right end-to-end. Publishing before real-world validation risks locking in a bad API.

### When to publish Phase 1

Publish to npm as `0.1.0` when:
- Tested locally in a real project
- Tests pass for `handlePrismaError` and `findOrThrow`
- `instanceof` works correctly for all four error classes
- Composite unique error mapping works
- README has a working example
- CI is green
- LICENSE and at least one usage example in README or `examples/` exist

### Checklist

- [x] `src/adapters/prisma/errors.ts` — 4 error classes (P2002, P2025, P2003, P2014)
- [x] `src/adapters/prisma/helpers.ts` — `handlePrismaError`, `findOrThrow`
- [x] `src/internal/error-adapter.ts` — native-vs-fallback detection
- [x] Tests: `instanceof` works for all 4 classes
- [x] Tests: composite unique mapping works (unit + Postgres integration)
- [x] README example
- [x] CI green
- [ ] Published to npm as `0.1.0`

---

## Phase 2 — GitHub Activity: Comment + PR

Do this after Phase 1 is published on npm, not before.

### Step 1 — Comment on the Prisma issue

Link: `https://github.com/prisma/prisma/issues/18871`

Comment should:
- Mention you built a package solving this today
- Link to the npm package and README
- Keep it short, let the package speak for itself
- Not ask for permission or validation

### Step 2 — Open the Prisma PR

After the comment gets some response:
- PR implements the typed error enum natively in Prisma
- PR description links your package as proof the API works
- Frame: "here is the implementation, the package proves the API is useful"

### Step 3 — Comment on related issues

Search Prisma and Zod issues for:
- `meta.target` not being typed
- `P2002` magic string complaints
- Async uniqueness validation in Zod

Same approach — working package first, comment second.

### Step 4 — Distribution beyond GitHub

GitHub alone is too narrow. Also:
- Blog post explaining the gap and the solution
- r/typescript and r/nextjs posts
- Stack Overflow answers on relevant questions
- Mention in the Prisma Discord
- Twitter/X thread tagging Prisma and Theo (covered this exact pain point)
- Submit to JavaScript Weekly and Node Weekly newsletters

### PR rejection contingency

If Prisma closes the PR with "won't fix": that's fine, your package is the
answer. Update the README to note Prisma rejected the native solution and
this is the canonical workaround. A rejection is not a failure — it
strengthens the package's reason to exist.

### Checklist

- [ ] Comment on prisma/prisma#18871
- [ ] Open Prisma typed-errors PR
- [ ] Comment on related Prisma/Zod issues
- [ ] Blog post
- [ ] r/typescript + r/nextjs posts
- [ ] Prisma Discord mention
- [ ] Twitter/X thread
- [ ] Submit to JS Weekly + Node Weekly

---

## Phase 3 — Build: Zod Extension

Build after Phase 1 has real users. Adoption validates the audience.

### What to build

**`src/core/index.ts`** — `unique()` wrapper helper:

```ts
import { unique } from "zod-bridge"

// Generic — works with any async lookup
const EmailSchema = unique(
  z.email(),
  async (val) => !(await checkExists(val)),
  "Already taken"
)
```

`unique()` calls `.superRefine()` on the passed schema and returns the same
schema type. No prototype mutation. Requires `parseAsync` / `safeParseAsync`
at call sites — document this prominently in the README, as callers using
`.parse()` will get a runtime error.

**`src/adapters/prisma/index.ts`** — Prisma lookup factory:

```ts
import { unique } from "zod-bridge"
import { prismaUnique } from "zod-bridge/prisma"

const EmailSchema = unique(
  z.email(),
  prismaUnique(prisma.user, "email"),
  { message: "Email already taken", excludeWhere: { id: currentUser.id } }
)
```

`prismaUnique` builds the lookup function:

```ts
const prismaUnique = (model, field) => async (val, opts) => {
  const where = opts?.excludeWhere
    ? { [field]: val, NOT: opts.excludeWhere }
    : { [field]: val }
  const existing = await model.findFirst({ where })
  return !existing
}
```

### Why core stays pure

The core `unique()` only needs `Promise<boolean>`. No Prisma dependency.
Adding Drizzle later is just a new `prismaUnique`-equivalent in
`adapters/drizzle/`. Zero changes to core.

### Composite uniqueness API

```ts
import { uniqueComposite } from "zod-bridge"
import { prismaUniqueComposite } from "zod-bridge/prisma"

const LikeSchema = uniqueComposite(
  z.object({ userId: z.number(), postId: z.number() }),
  prismaUniqueComposite(prisma.like, ["userId", "postId"]),
  "Already liked this post"
)
```

### Checklist

- [x] `src/core/index.ts` — `unique()` wrapper
- [x] `src/core/index.ts` — `uniqueComposite()` wrapper
- [x] `src/adapters/prisma/index.ts` — `prismaUnique`
- [x] `src/adapters/prisma/index.ts` — `prismaUniqueComposite`
- [x] Tests: parseAsync path, excludeWhere, composite
- [x] README documents `parseAsync` requirement

---

## Phase 4 — Build: Schema Bridge

Build after Phase 3 is stable. Highest value feature, needs Phases 1 and 3
working correctly first.

### What to build

```ts
import { createSchema } from "zod-bridge/prisma"

const UserSchema = createSchema(prisma.user, {
  email: unique(z.email(), prismaUnique(prisma.user, "email"), "Email already taken"),
  username: unique(z.string().min(3), prismaUnique(prisma.user, "username"), "Username taken"),
  name: z.string().optional()
})
```

`createSchema` wires up:
- The Prisma model shape as the base, derived from `Prisma.dmmf.datamodel`
  at runtime (or a codegen step for build-time types).
- Your Zod overrides merged on top.
- `handlePrismaError` as a catch layer for race conditions.
- Update mode wires `excludeWhere` automatically when an ID is supplied.

**Implementation note:** the Prisma client does not expose model field types
at runtime. `createSchema` must read `Prisma.dmmf.datamodel` to derive the
base shape. This is the non-trivial part of Phase 4 — budget time for it.
A codegen alternative (emit a `.ts` file at `prisma generate` time) is the
safer path if DMMF coverage proves incomplete.

### Checklist

- [ ] `createSchema(prisma.user, overrides)` reads `Prisma.dmmf.datamodel`
- [ ] Override merging
- [ ] `handlePrismaError` catch layer wired
- [ ] Update mode auto-wires `excludeWhere`
- [ ] Tests against real Prisma schema
- [ ] Codegen path evaluated if DMMF coverage gaps

---

## Handling the Prisma PR outcome

### If Prisma merges the typed errors PR

Update `src/internal/error-adapter.ts` to prefer Prisma's native types:

```ts
// Before merge
export { OurUniqueConstraintError as PrismaUniqueConstraintError }

// After merge — one file change, zero breaking changes for users
export { Prisma.PrismaUniqueConstraintError }
```

Release as a minor version, not breaking. Update README to note Phase 1
now delegates to Prisma core. The package continues as the Zod bridge,
which Prisma will never own.

### If Prisma never merges the PR

Nothing changes. Your package is the de facto solution. The issue comment
continues driving installs. The PR stays open as a reference.

Either outcome, the Zod bridge (Phases 3 and 4) is the permanent value of
the package. Prisma will never own that.

---

## Adding a new DB adapter later (Drizzle, Kysely, etc)

Because core is pure and adapters are isolated, adding Drizzle is:

1. Create `src/adapters/drizzle/`
2. Implement `drizzleUnique(db, table, column)`, same shape as `prismaUnique`
3. Export from `zod-bridge/drizzle`
4. Zero changes to core, zero changes to the Prisma adapter

```ts
// Future Drizzle user
import { unique } from "zod-bridge"
import { drizzleUnique } from "zod-bridge/drizzle"

const EmailSchema = unique(
  z.email(),
  drizzleUnique(db, users, users.email),
  "Email already taken"
)
```

---

## Milestone summary

| Milestone | Status | Trigger to move forward |
|---|---|---|
| Phase 0 complete | ✅ | Folder structure, exports, peer deps, CI configured |
| Phase 0.5 complete | ✅ | All design decisions documented in DECISIONS.md |
| Real-project test | ⬜ | Install via `npm link` in a real project, validate API feel |
| Phase 1 complete | ⬜ | Real-project test done, published as `0.1.0` on npm |
| GitHub comment | ⬜ | Phase 1 published, README is solid, examples exist |
| Prisma PR | ⬜ | Comment gets engagement |
| Distribution push | ⬜ | Blog, Reddit, Twitter, Discord, Stack Overflow |
| Phase 3 complete | ⬜ | Phase 1 has real installs, Zod extension stable |
| Phase 4 complete | ⬜ | Schema bridge tested with real apps |

---

## Future: additional DB providers in integration tests

Integration tests are Postgres-only today. To add MySQL, MariaDB, MSSQL, etc.:

1. **Separate Prisma schema** — Prisma 7 cannot switch `provider` via env var. Create `prisma/schema.{driver}.prisma` with the target provider. Set `output = "../node_modules/.prisma/client-{driver}"` on its `generator` block to avoid clobbering the default client.
2. **Install testcontainers module** — e.g. `@testcontainers/mysql` for MySQL.
3. **Update `prisma.config.ts`** — add the shadow DB URL if needed, or create a second config file per provider.
4. **Add a globalSetup entry** — spin up the new container, run `prisma db push --schema=prisma/schema.{driver}.prisma`.
5. **Add test file** — `tests/integration/{driver}.test.ts`, import from the provider-specific generated client path. Each driver's `meta.target` shape may differ — that's what the tests pin down.
6. **CI matrix** — add a job per driver in `.github/workflows/test.yml`.

Estimated effort: ~1-2 hours per added DB.

---

## Working with Claude Code

Claude Code works best on this project when you:

- Ask it to implement one file at a time: `"implement src/adapters/prisma/errors.ts"`
- Ask it to write tests before implementation: `"write tests for handlePrismaError"`
- Ask it to check the Prisma error reference before implementing error classes
- Use it to draft the GitHub comment, PR description, and blog post
- Ask it to update `error-adapter.ts` if Prisma merges the typed errors PR
- Ask it to scaffold the GitHub Actions workflows in Phase 0
- Ask it to generate the example apps after Phase 1 is feature complete
