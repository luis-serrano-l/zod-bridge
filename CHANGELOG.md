# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed

- Typed error messages now name the fix after the problem (`<problem>. Fix: <what to do>.`), and
  say to inspect `error.cause.meta` when the fields could not be read. The problem prefix is
  unchanged (`Unique constraint failed on: email`); code comparing `message` for equality must
  switch to `instanceof` / `code`.

### Added

- JSDoc with `@example` on every public export, shipped in the `.d.ts`.

### Fixed

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
