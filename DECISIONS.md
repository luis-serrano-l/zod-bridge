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

Decision: `unique()` wrapper accepts `excludeWhere` — a Prisma `where` fragment for the record to skip. Using a full `where` fragment (not a bare `excludeId`) handles composite PKs and non-`id` PK names:

```ts
unique(z.email(), prismaUnique(prisma.user, "email"), {
  message: "Email taken",
  excludeWhere: { id: user.id }
})
```

`prismaUnique` merges `excludeWhere` as `NOT`: `{ email: val, NOT: excludeWhere }`.

## Composite unique constraints

`@@unique([userId, postId])` is common. P2002 returns multiple fields in `meta.target`. Support composite from Phase 1, both for the error handler and the validator. Array format avoids brittle comma-separated string keys:

```ts
handlePrismaError(e, {
  unique: [
    { fields: ["userId", "postId"], message: "Already liked this post" },
    { fields: ["email"],            message: "Email taken" },
  ],
})
```

## Race condition handling

Async refine + DB insert is two queries with a race window. Two concurrent requests can both pass the refine and one fails at insert.

Design: `handlePrismaError` is the safety net. The Zod check is best-effort UX (instant field-level error) and `handlePrismaError` catches slip-throughs. Documented in README as a feature.
