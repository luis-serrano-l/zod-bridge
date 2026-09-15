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
// This doesn't exist in Zod
z.string().email().unique(async (val) => !await db.user.findFirst({ where: { email: val } }))
```

`zod-bridge` fills both gaps.

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

`prismaUnique` adds `NOT: { id: currentUser.id }` to the Prisma query, so editing a user's own email doesn't report "already taken". `excludeWhere` accepts a full Prisma `where` fragment — handles composite PKs and non-`id` primary key names.

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

## License

MIT
