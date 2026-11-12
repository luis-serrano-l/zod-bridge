# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
