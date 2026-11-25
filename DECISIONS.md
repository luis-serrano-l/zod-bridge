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

## One error shape for both paths: `toZodIssues`

A route that uses `unique()` and `handlePrismaError` had two error branches for the same user-facing
problem: a `ZodError` when the pre-check catches the conflict, a `PrismaUniqueConstraintError` when
a concurrent request wins the race. `toZodIssues` (in `zod-bridge/prisma`) folds them into one:

```ts
toZodIssues(
  err: unknown,
  options?: string | { message?: string; path?: readonly PropertyKey[]; fields?: readonly string[] },
):
  z.core.$ZodIssue[] | undefined
```

```ts
try {
  const data = await UserSchema.parseAsync(input)
  await prisma.user.create({ data }).catch(handlePrismaError)
} catch (e) {
  const issues = toZodIssues(e, "Email already taken")
  if (issues) return res.status(400).json({ issues })
  throw e
}
```

- **Input is `unknown`, output is `issues | undefined`.** A `ZodError` returns a copy of its
  issues, a `PrismaUniqueConstraintError` (or a raw P2002 whose write skipped `handlePrismaError`) is converted, anything else returns `undefined` so the
  caller rethrows. Accepting the `ZodError` too is what makes it one branch; a function that only
  took the Prisma error would still need the `instanceof ZodError` branch next to it.
- **Same issue as `unique()`**: `{ code: "custom", message, path }` and nothing else, so the two
  compare equal with `toEqual`. The default message is the same constant `unique()` uses
  (`uniqueMessage()` in `src/internal/messages.ts` resolves it for both).
- **Path mirrors the validators.** One field → `[field]`, as `prismaUnique` reports. Several fields
  (composite) or none readable → `[]`, as `uniqueComposite` reports. `options.path` overrides, as
  in `unique()`; it is also how a nested schema (`["user", "email"]`) is addressed.
- **Options mirror `unique()`**: a bare string is the message. The caller passes the same message
  and path it gave the validator. This is not the per-constraint message map rejected above: it is
  one message at one call site, `handlePrismaError` still takes no options, and nothing is matched
  by field name. A route guarding several constraints with different messages branches on
  `e.fields` itself, or waits for Phase 4's `createSchema`, which knows both sides.
- **Returns issues, not a `ZodError`.** Issues are what gets serialised; a caller that wants the
  class does `new z.ZodError(issues)`.
- **Only the unique-constraint error is converted.** It is the only typed error with a refinement
  counterpart. `PrismaForeignKeyError` was considered: on create it is a field-level problem
  ("author does not exist"), but the same error on delete means "other records still reference this
  one", where `fieldName` is a column of another table. The error does not say which, so any default
  message or path would be wrong half the time. `PrismaNotFoundError` and
  `PrismaRelationViolationError` are not about the submitted values (404 / 409).
- **The default path is a guess from the database error, and says so.** It equals the refine's
  path only when the validator is in a top-level `z.object` on an unmapped column. A nested schema,
  a bare parsed value (`unique()` reports at `[]`) or a `@map`ped column needs `path`. Alternatives
  rejected: a required `path` (always exact, but every call site repeats what the common case gets
  for free) and reading the path from the check fn (`check.path` does not know about nesting or the
  bare-value form either, so it fixes nothing the explicit `path` does not).
- **`fields` is an opt-in guard, not a message map.** Without it, any unique conflict is reported
  under the caller's one message, including a constraint the form never mentioned (a server-set
  `slug`). With `fields: ["email"]` only that constraint converts; others return `undefined` and
  are rethrown. Several constraints chain with `??`. Unreadable fields never match: a conflict that
  cannot be identified is rethrown rather than mislabelled, and so is everything when the list is
  empty. Matching uses database column names (a `@map`ped field needs the column name in `fields`
  and the Zod key in `path`). On 7.10+ a column containing `_` arrives split, so names are also
  matched once joined with `_`, and a matched guard supplies the default path in place of the
  error's fields.
- **Every `ZodError` is passed through**, whichever schema threw it; `fields` does not filter it.
  The `try` block should hold only the request parse and the write.
- **Best effort on Prisma 7.10+**, where fields are derived from the index name: a column containing
  `_` splits into several names and the issue lands at the root. Pass `path` when that matters.

## Schema bridge: `createSchema` and the generator

`createSchema(prisma.user, UserModel, options)` returns the Zod object of a model with both layers
wired. The facts it needs (column types, primary key, unique constraints, `@map` names) are not
available at runtime, so a Prisma generator writes them at `prisma generate` time.

- **A Prisma generator, not `Prisma.dmmf` and not a schema parser.** `Prisma.dmmf.datamodel` in
  Prisma 7 carries only `name` / `kind` / `type`. The DMMF a generator receives is complete
  (`isId`, `isUnique`, `uniqueFields`, `primaryKey`, `hasDefaultValue`, `dbName`) and comes from
  Prisma itself, so nothing here parses `.prisma` files. The generator speaks the line-delimited
  JSON-RPC protocol directly (requests on stdin, responses on stderr) instead of depending on
  `@prisma/generator-helper`: two methods, no new dependency, and the binary imports neither `zod`
  nor `@prisma/client`.
- **The descriptor is an explicit argument.** The roadmap sketched `createSchema(prisma.user,
  overrides)`. That needs a registry mapping a delegate to its descriptor, and a type-level mapping
  from the delegate type to the model, which Prisma's types do not offer in a stable way. Passing
  `UserModel` keeps the types plain inference from a literal, works with any client output path,
  and a mismatch (`prisma.post` with `UserModel`) throws when the schema is built (`$name`).
- **The generated file contains Zod code, not data.** `shape: { id: z.int().optional(), ... }` is
  typed by inference, readable, and diffable in review. A JSON description would need a second,
  hand-maintained type mapping.
- **The shape is the create input**, so one descriptor serves create as is and update through
  `mode: "update"` (primary key required and unwrapped from `.optional()`, the rest optional).
- **`DateTime` accepts exactly what Prisma accepts.** Measured on Prisma 7.10 + Postgres with
  `prisma.event.create`: a `Date`, and ISO 8601 strings with `Z` or an offset are stored; a string
  without a zone, a date-only string, a number and `null` are refused. The generated schema is
  `z.union([z.date(), z.iso.datetime({ offset: true }).transform((v) => new Date(v))])`, defined
  once per file as `dateTime`: same acceptance, and the output is always a `Date`. Rejected:
  `z.date()` (refuses every string, so each date column of a JSON API needed an override),
  `z.coerce.date()` (accepts the four inputs Prisma refuses, `null` as 1970) and a plain
  `z.iso.datetime()` (refuses offsets Prisma stores). The integration suite pins both sides.
- **`pick` or `omit` is required; there is no "every column" default.** A first version included
  every column unless told otherwise, which made a later `isAdmin` column client-settable in every
  schema. Ecto solves the same problem by making the allow-list a required argument of `cast/3`,
  with no deny-list at all. Here either option satisfies the requirement: `pick` is the allow-list
  and the documented default for request bodies; `omit` stays because a deny-list is still a
  stated choice and suits admin forms that mirror the model (`omit: []` is "all, on purpose"), at
  the known cost that a new column is exposed until listed. Enforced in the types and, for
  JavaScript callers, with a throw at build time. Selection is an option and not a method because
  Zod throws on `.pick()` / `.omit()` of an object with refinements.
- **Unique checks are object-level** (`unique(z.object(...), prismaUnique(model, field, {
  primaryKey }))`), the only form in which a check can see the primary key. The key comes from the
  schema, so the `"id"` convention of `prismaUnique` is not involved. The primary key itself is not
  pre-checked: the record would exclude itself.
- **`unique: [{ fields, message?, path? }]` is the message map that `handlePrismaError` was
  denied.** Here the schema owns both the validator and the conversion, so one entry configures
  both and they cannot drift. Fields are arrays. A rule that matches no constraint held by the
  schema throws at build time (typo, or a column that was omitted).
- **`toZodIssues` is a method on the returned schema.** It chains the standalone `toZodIssues` with
  a `fields` guard per constraint (database column names from `@map`, issue path at the Zod key).
  A conflict on a constraint the schema does not validate returns `undefined`. The alternative, a
  `{ schema, toZodIssues }` pair, makes every call site destructure; the cost of the method is
  that a derived schema (`.optional()`, `.describe()`) no longer has it, which is documented.
- **Limits.** `Unsupported(...)` columns and relations are skipped, and a key or constraint that
  includes one is dropped. `@@unique(map: "custom")` on Prisma 7.10+ cannot be matched from the
  index name, so its lost-race error is rethrown rather than mislabelled.

## `zod-bridge doctor`

`npx zod-bridge doctor [dir] [--json]` lists the hand-rolled Prisma error handling a project
still has, with the zod-bridge replacement for each hit. It gives a person or an agent a concrete
reason to adopt the library, and a list of call sites to start from.

- **Always exits 0, no `--strict`.** It is a report, not a gate. A textual match is a place to
  look at, not a proven bug, and a non-zero exit would push people to silence it instead of
  reading it. A missing directory or an unknown flag is reported in the output, exit code 0 too.
- **A textual scan, not an AST.** The targets are literals (`"P2002"`, `meta.target`) that a
  regular expression finds reliably, and a parser would be the package's first runtime dependency.
  The cost is accepted: a code inside a string or a trailing comment is reported, and a
  destructured `const { target } = e.meta` is missed. Whole-line comments are skipped; block
  comments are not tracked across lines (a `/*` inside a glob string would hide the rest of a file).
- **One binary, dispatched on the first argument.** `zod-bridge` was already the Prisma generator,
  and `npx zod-bridge doctor` needs the binary to carry the package name. Prisma spawns a
  generator without arguments, so only a bare `zod-bridge` is the generator: `doctor` runs the
  scan, and any other command prints the usage and exits 1 instead of waiting on stdin. Rejected: a
  second binary (`zod-bridge-doctor`), which `npx zod-bridge doctor` would not reach.
- **Paths are relative to the working directory**, so `file:line:column` is clickable in a
  terminal and usable as-is by an agent, whichever directory was scanned.
