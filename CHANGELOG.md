# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.2.0] - 2026-11-25

### Changed

- Typed error messages now name the fix after the problem (`<problem>. Fix: <what to do>.`), and
  say to inspect `error.cause.meta` when the fields could not be read. The problem prefix is
  unchanged (`Unique constraint failed on: email`); code comparing `message` for equality must
  switch to `instanceof` / `code`.

### Added

- `npx zod-bridge doctor [dir] [--json]`: lists hand-rolled Prisma error handling in a project
  (the quoted codes `"P2002"`, `"P2003"`, `"P2025"`, `"P2014"`, and reads of `meta.target` /
  `meta.field_name`) as `file:line:column` with the zod-bridge replacement for each. Read-only,
  always exits 0; `--json` for scripts and AI agents.
- `createSchema(model, descriptor, options)` in `zod-bridge/prisma`: the Zod schema of a Prisma
  model with a uniqueness check for every `@unique` / `@@unique`, update exclusion through the
  model's real primary key, and `schema.toZodIssues(err)` to report a lost race as the issue the
  pre-check produces. `pick` or `omit` is required: the columns the client may send are always
  stated. Other options: `fields` (overrides), `mode: "update"` (primary key required, the rest
  optional) and `unique` (message / path per constraint). `DateTime` columns accept a `Date` or
  an ISO 8601 string with `Z` or an offset, and parse to a `Date`.
- A Prisma generator (`provider = "zod-bridge"`, shipped as the package binary) that writes the
  model descriptors `createSchema` reads, and `defineModel` to type them.
- JSDoc with `@example` on every public export, shipped in the `.d.ts`.
- `toZodIssues(err, options?)` in `zod-bridge/prisma`: one error shape for both layers. Returns the
  issues of a `ZodError`, or for a `PrismaUniqueConstraintError` the same issue `unique()` produces
  (`{ code: "custom", message, path }`), and `undefined` for anything else, so a route needs a
  single error branch. `fields` restricts the conversion to one constraint; `path` overrides the
  path read from the database error.

### Fixed

- `unique()` with `options.path` on an object-level check (`unique(z.object(...),
  prismaUnique(prisma.user, "email"), { path: ["form"] })`) queried the database for an email that
  had already failed validation: only issues under `path` were considered. Issues on the field the
  check reads now skip the lookup too.

- `unique()` used inside `z.object` with a check fn that carries a path hint
  (`z.object({ email: unique(z.email(), prismaUnique(prisma.user, "email")) })`) reported the issue
  at `["email", "email"]` and queried the database even when the field had already failed
  validation. The hint now applies only when the parsed value is a plain object; a field-level
  check of any type (string, number, Date, array, Decimal) reports at `["email"]`.
- `prismaUnique` treated a bare `Date`, `Buffer` or `Decimal` value as the object form and
  skipped the check. Only plain objects are read as "an object holding the field" now.

## [0.1.0] - 2026-11-12

First release.

### Added

- `unique()` and `uniqueComposite()`: async uniqueness validators for Zod v4. The check function
  is skipped when the value already has an issue. `options.path` sets where the issue is reported.
- `prismaUnique` and `prismaUniqueComposite`: Prisma check functions for the validators above.
  On update, the record is excluded from the check automatically through `primaryKey` (default
  `"id"`). An `excludeWhere` option overrides this. Absent, `null` and filter-shaped (plain object)
  values are never sent to the database.
- Typed Prisma errors, each extending `PrismaBridgeError` and keeping the original error as `cause`:
  - `PrismaUniqueConstraintError` (P2002) with `fields`
  - `PrismaNotFoundError` (P2025)
  - `PrismaForeignKeyError` (P2003) with `fieldName`
  - `PrismaRelationViolationError` (P2014) with `relationName`
- `handlePrismaError` and `findOrThrow`.
- Support for Prisma 5 to 7 error shapes, including the Prisma 7.10+ driver-adapter shape that
  reports only the index name.
