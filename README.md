# zod-bridge

The missing async validation layer for Zod. Typed Prisma errors + DB-aware unique validators.

## The problem

Prisma throws untyped errors with magic string codes:

```ts
catch (e) {
  if (e?.code === "P2002") { /* hope you spelled it right */ }
}
```

And Zod has no built-in way to check uniqueness against the database:

```ts
// Zod has no equivalent of this. You hand-roll an async refine at every call site:
z.string().email().refine(
  async (val) => !(await db.user.findFirst({ where: { email: val } })),
  "Email already taken",
)
```

`zod-bridge` fills both gaps. The uniqueness check is a wrapper, not a method, because Zod v4 has no
plugin API and patching `ZodType.prototype` breaks with a second Zod copy:

```ts
unique(z.email(), prismaUnique(prisma.user, "email"), "Email already taken")
```

## Before and after

Schema: `User` (unique `email`), `Post` (`authorId` FK), `Like` (composite unique on `userId, postId`).

### Update a user's email

Without zod-bridge:

```ts
const EmailSchema = z.email().refine(
  async (email) => !(await prisma.user.findFirst({ where: { email, NOT: { id } } })),
  "Email already taken",
)

try {
  const email = await EmailSchema.parseAsync(input.email)
  await prisma.user.update({ where: { id }, data: { email } })
} catch (e: any) {
  if (e?.code === "P2002") {
    // Which field failed? Depends on the Prisma version:
    //   meta.driverAdapterError.cause.constraint.fields   (7 + adapter, ≤ 7.9)
    //   meta.driverAdapterError.cause.constraint.index    (7.10+, "User_email_key" — parse it)
    //   meta.target                                       (≤ 6, string | string[])
  }
  if (e?.code === "P2025") { /* not found */ }
}
```

With zod-bridge:

```ts
const EmailSchema = unique(z.email(), prismaUnique(prisma.user, "email"), {
  message: "Email already taken",
  excludeWhere: { id },
})

try {
  const email = await EmailSchema.parseAsync(input.email)
  await prisma.user.update({ where: { id }, data: { email } })
} catch (e) {
  handlePrismaError(e) // throws PrismaUniqueConstraintError { fields: ["email"] } or PrismaNotFoundError
}
```

### Like a post

Without zod-bridge:

```ts
const LikeSchema = z.object({ userId: z.number(), postId: z.number() }).refine(
  async ({ userId, postId }) => !(await prisma.like.findFirst({ where: { userId, postId } })),
  "Already liked this post",
)

try {
  await prisma.like.create({ data: await LikeSchema.parseAsync(input) })
} catch (e: any) {
  if (e?.code === "P2002") { /* already liked */ }
  if (e?.code === "P2003") {
    // Which FK? meta.field_name on Prisma ≤ 6; on 7.10+ only the index name ships
    // ("Post_authorId_fkey") — parse the field out of it.
  }
}
```

With zod-bridge:

```ts
const LikeSchema = uniqueComposite(
  z.object({ userId: z.number(), postId: z.number() }),
  prismaUniqueComposite(prisma.like, ["userId", "postId"]),
  "Already liked this post",
)

try {
  await prisma.like.create({ data: await LikeSchema.parseAsync(input) })
} catch (e) {
  handlePrismaError(e) // throws PrismaUniqueConstraintError or PrismaForeignKeyError { fieldName: "postId" }
}
```

The version-specific parsing in the comments is what `zod-bridge/prisma` maintains for you, unit-tested
against every Prisma 5–7 error shape. The Zod check is instant form feedback; `handlePrismaError` is the
safety net for the request that loses a race (see [Race conditions](#race-conditions)).

## Demo

A dockerized example that installs `zod-bridge` from a freshly packed tarball and runs every feature against a real Postgres. Requires Docker only:

```bash
cd examples/demo
docker compose up --build --abort-on-container-exit
```

![zod-bridge demo](docs/demo.gif)

Source: [`examples/demo/main.ts`](examples/demo/main.ts).

## Install

```bash
npm install zod-bridge
```

Peer dependencies: `zod ^4.0.0`, `@prisma/client ^5–7` (optional, only needed for the `/prisma` import). Requires Node ≥ 22.12.

### Two entry points

| Import | Contents | Depends on |
|--------|----------|------------|
| `zod-bridge` | `unique()`, `uniqueComposite()` — ORM-agnostic Zod validators | `zod` only |
| `zod-bridge/prisma` | Typed error classes, `handlePrismaError`, `findOrThrow`, `prismaUnique*` | `zod` + `@prisma/client` |

The root export is kept free of any database dependency on purpose. The Prisma adapter does a runtime `import { Prisma } from "@prisma/client"` (needed for the `instanceof` check in `handlePrismaError`), so re-exporting it from `zod-bridge` would make `@prisma/client` mandatory for everyone, including users who only want the Zod validators with a different ORM or a raw query.

Prisma is currently the only adapter implemented. The core is written so that other ORMs (e.g. Drizzle) can be added as `zod-bridge/<adapter>` without touching the root export or the Prisma adapter.

### Prisma 7 setup

Prisma 7 requires a [driver adapter](https://www.prisma.io/docs/orm/overview/databases/database-drivers) instead of a connection URL in the schema. Install the pg adapter and pass it to `PrismaClient`:

```bash
npm install @prisma/adapter-pg pg
```

```ts
import { PrismaPg } from "@prisma/adapter-pg"
import { PrismaClient } from "@prisma/client"

const prisma = new PrismaClient({
  adapter: new PrismaPg(process.env.DATABASE_URL),
})
```

Prisma 5/6 users: no changes needed — `new PrismaClient()` works as before.

## Typed Prisma errors

```ts
import {
  PrismaUniqueConstraintError,
  PrismaNotFoundError,
  PrismaForeignKeyError,
  PrismaRelationViolationError,
  handlePrismaError,
  findOrThrow,
} from "zod-bridge/prisma"
```

### `instanceof` checks instead of magic string codes

```ts
try {
  await prisma.user.create({ data: { email } })
} catch (e) {
  if (e instanceof PrismaUniqueConstraintError) {
    console.log(e.fields) // ["email"]
  }
  if (e instanceof PrismaNotFoundError) { ... }
  if (e instanceof PrismaForeignKeyError) {
    console.log(e.fieldName) // "authorId"
  }
  if (e instanceof PrismaRelationViolationError) {
    console.log(e.relationName) // "UserPost"
  }
}
```

Covered error codes: `P2002` (unique), `P2025` (not found), `P2003` (foreign key), `P2014` (relation violation).

### `handlePrismaError` — rethrow as typed error

```ts
try {
  await prisma.user.create({ data: { email } })
} catch (e) {
  handlePrismaError(e) // throws PrismaUniqueConstraintError, PrismaNotFoundError, etc.
                       // rethrows unknown errors as-is
}
```

### `findOrThrow` — null-safe fetch

```ts
// Throws PrismaNotFoundError instead of returning null
const user = await findOrThrow(() => prisma.user.findUnique({ where: { id } }))
```

## Async uniqueness validators for Zod

```ts
import { unique, uniqueComposite } from "zod-bridge"
import { prismaUnique, prismaUniqueComposite } from "zod-bridge/prisma"
```

> **Important:** `unique()` and `uniqueComposite()` use `.superRefine()` internally, which is async.
> You must use `parseAsync` / `safeParseAsync` — calling `.parse()` will throw at runtime.

### Single-field unique

```ts
const EmailSchema = unique(
  z.email(),
  prismaUnique(prisma.user, "email"),
  "Email already taken",
)

// Must use parseAsync
const result = await EmailSchema.safeParseAsync(input.email)
```

### Excluding the current record on update

```ts
const EmailSchema = unique(
  z.email(),
  prismaUnique(prisma.user, "email"),
  { message: "Email already taken", excludeWhere: { id: currentUser.id } },
)
```

`prismaUnique` adds `NOT: { id: currentUser.id }` to the Prisma query, so editing a user's own email doesn't report "already taken". `excludeWhere` accepts a full Prisma `where` fragment — handles composite PKs and non-`id` primary key names. It is typed as the model's `WhereInput`, inferred from the model you pass to `prismaUnique`, so unknown fields are a type error and your editor autocompletes it.

### Composite unique constraints

```ts
const LikeSchema = uniqueComposite(
  z.object({ userId: z.number(), postId: z.number() }),
  prismaUniqueComposite(prisma.like, ["userId", "postId"]),
  "Already liked this post",
)

const result = await LikeSchema.safeParseAsync({ userId, postId })
```

### Generic check function (without Prisma)

Both `unique` and `uniqueComposite` accept any async function that returns `true` (available) or `false` (taken):

```ts
const EmailSchema = unique(
  z.email(),
  async (val) => !(await redis.sismember("emails", val)),
  "Email already taken",
)
```

## Race conditions

The async check + DB insert is two operations with a gap between them. Two concurrent requests can both pass the Zod check, then one fails at the DB level.

This is by design. `handlePrismaError` is the safety net — it catches the P2002 that slips through. The Zod check is best-effort UX (instant field error in your form); `handlePrismaError` ensures correctness at the DB layer. Use both together:

```ts
const schema = unique(z.email(), prismaUnique(prisma.user, "email"), "Email taken")

try {
  const { email } = await schema.parseAsync(input) // best-effort UX check
  await prisma.user.create({ data: { email } })
} catch (e) {
  if (e instanceof ZodError) throw e
  handlePrismaError(e) // catches the race-condition slip-through
}
```

## AI agents

If an AI coding agent writes your Prisma + Zod code, `zod-bridge` pays off twice.

**Less code to generate.** Without it, every call site needs the same hand-written boilerplate: check `e.code === "P2002"`, parse `meta.target`, fall back to `meta.constraint.index` on Prisma 7.10+ (which no longer ships a field list), and hand-roll an async `.refine()` with a `findFirst` plus an exclusion clause for updates. With it, that collapses to `instanceof PrismaUniqueConstraintError` and one `unique()` call.

**Fewer wrong-first-try generations.** Agents burn most of their tokens on retry loops, not on the initial write. Prisma's error shape has gotchas an agent won't know about a given project — driver-adapter errors carrying only the index name, composite primary keys, non-`id` PK names on update. Each one is a failing test, a re-read, and a rewrite. `handlePrismaError`, `prismaUnique`, and `excludeWhere` encode that knowledge once, so the agent gets it right on the first pass.

Two things an agent should be told at the call site:

- `unique()` / `uniqueComposite()` require `parseAsync` — `.parse()` throws at runtime.
- The Zod check is best-effort; always pair it with `handlePrismaError` for the race-condition slip-through (see [Race conditions](#race-conditions)).

## License

MIT
