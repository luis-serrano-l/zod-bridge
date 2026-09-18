# Design Decisions

## Zod v4 only

Supports `"zod": "^4.0.0"`. v4 changed error customisation (`message` → `error`), deprecated `z.string().email()` for `z.email()`, and reorganised internals. A single codebase across v3 and v4 requires significant abstraction overhead — not worth it. v3 users should pin an older version if a backport ever ships. Test matrix covers v4 only.

## Peer dependencies, not regular dependencies

`zod` and `@prisma/client` are `peerDependencies` because:
- Two copies of Zod in the bundle breaks `instanceof` checks.
- Type compatibility requires the user's version, not ours.
- Smaller install size.

`devDependencies` for local testing; `peerDependencies` for runtime.

## License

MIT. Standard for this category of library.

## Testing strategy

Two layers:
- **SQLite in-memory** — fast unit tests, runs in CI in seconds. Covers `handlePrismaError`, `findOrThrow`, and error class `instanceof` checks. Setup: `prisma/schema.prisma` pointing at `file::memory:?cache=shared`.
- **Postgres via testcontainers** — error-shape-sensitive tests only. `meta.target` is `string[]` on Postgres/MySQL but `string` on SQLite; composite-unique behaviour also differs. These run in the CI matrix alongside SQLite, not as a replacement.

## CI/CD baseline

GitHub Actions, two workflows from day one:
- `test.yml` — runs on every PR, matrix on Node 20 + 22 (Node 18 EOL April 2025).
- `publish.yml` — runs on git tag push, publishes to npm with provenance. Requires `permissions: { id-token: write, contents: read }` or provenance attestation is silently skipped.

## Update operation API

`.unique()` on update operations would find the record being edited and report "already taken" without this design.

Decision: the exclusion is implicit. `prismaUnique` accepts the parsed object as well as the bare value; when the object carries the primary key (`id` by default, `{ primaryKey }` to override, arrays for composite keys), the check adds `NOT: { id }`. One schema serves create and update; the caller merges the route id into the body:

```ts
const UserSchema = unique(
  z.object({ id: z.number().optional(), email: z.email() }),
  prismaUnique(prisma.user, "email"),
  "Email taken",
)
await UserSchema.parseAsync({ ...body, id: Number(params.id) })
```

Why it has to be in the parsed value: a Zod refinement only sees its own value, and Zod v4's `ParseContext` is closed (`error`, `reportInput`, `jitless`), so there is no parse-time channel for "the current record". A field-level `unique()` inside `z.object` therefore cannot see `id`; the object is wrapped instead, and the issue is reported at `path: [field]`.

Why the key is a convention: Prisma 7 exposes no primary-key info at runtime. `Prisma.dmmf.datamodel` (and `client._runtimeDataModel`) carry only `name`/`kind`/`type` per field; the `.d.ts` declares `isId`/`primaryKey` but they are `undefined`. Phase 4's `createSchema` must read the schema at codegen time for this.

`excludeWhere` stays as the explicit override: a full Prisma `where` fragment (not a bare `excludeId`) merged as `NOT`, typed as the model's `WhereInput`. Rejected alternatives: a `forUpdate(schema, excludeWhere)` helper that rebuilds the schema per request (works, but the user wanted no per-request ceremony), and an `AsyncLocalStorage` request context (invisible coupling between framework and schema).

## Composite unique constraints

`@@unique([userId, postId])` is common. P2002 returns multiple fields in `meta.target`. Composite is supported from Phase 1 in both the error classes (`PrismaUniqueConstraintError.fields` is a `string[]`) and the validator. Fields are always passed as arrays, never comma-separated strings, so they are order-independent and typo-safe:

```ts
uniqueComposite(
  z.object({ userId: z.number(), postId: z.number() }),
  prismaUniqueComposite(prisma.like, ["userId", "postId"]),
  "Already liked this post",
)
```

A per-constraint message map on `handlePrismaError` (`{ unique: [{ fields, message }] }`) was considered and dropped. It would duplicate the messages already given to `unique()`, and field matching is unreliable on Prisma 7.10+ where fields are derived from the index name. Phase 4's `createSchema` owns both the validators and their messages, so it is the right place to translate race-condition slip-throughs into the same field-level error the pre-check produces.

## Race condition handling

Async refine + DB insert is two queries with a race window. Two concurrent requests can both pass the refine and one fails at insert.

Design: `handlePrismaError` is the safety net. The Zod check is best-effort UX (instant field-level error) and `handlePrismaError` catches slip-throughs. Documented in README as a feature.
