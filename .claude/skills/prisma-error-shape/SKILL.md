---
name: prisma-error-shape
description: Use when a Prisma version changes the `meta` shape of P2002, P2003, P2025 or P2014 errors, or when a user reports empty `fields` or `fieldName` on a typed error. Walks through capturing the raw meta, test-first fix in errors.ts, and doc updates.
---

# prisma-error-shape

Field extraction lives in `src/adapters/prisma/errors.ts` and depends on the Prisma version.
Follow the steps in order. Do not skip the failing-test step.

## Steps

1. **Capture the raw `meta`.** Install the Prisma version in question, run `npx prisma generate`,
   then temporarily add `console.log(JSON.stringify(err.meta, null, 2))` in the relevant case in
   `tests/integration/postgres.test.ts`. Run `npm run test:integration` (needs Docker) and copy
   the printed `meta` for each affected code (P2002, P2003, P2025, P2014). Mark the logging with
   a `TEMP` comment so it is easy to find.
2. **Write the unit test first.** In `tests/prisma.test.ts`, build a
   `Prisma.PrismaClientKnownRequestError` with the captured `meta` as a literal, and assert the
   expected `fields` or `fieldName`. Run `npx vitest run tests/prisma.test.ts` and confirm it
   fails for the right reason (empty or wrong field).
3. **Add the branch in `errors.ts`.** Keep the documented fallback order:
   1. `meta.driverAdapterError.cause.constraint.fields` (Prisma 7 + adapter, up to 7.9)
   2. `meta.driverAdapterError.cause.constraint.index` + `cause.table` (7.10+)
   3. `meta.target` / `meta.field_name` (Prisma 6 and below, or 7 without adapter)
   Insert the new shape so newer driver-adapter shapes come first and `meta.target` /
   `meta.field_name` stay last. Pass every identifier through `unquote`, because Postgres quotes
   camelCase names. Use `?.["key"]` indexing and `import type` per the repo conventions.
4. **Run everything.** `npm run typecheck && npm test`. The new unit test must pass and no old
   shape test may regress.
5. **Update docs.** Edit the "Error field extraction is version-dependent" rule in `CLAUDE.md`
   (numbered fallback list and version ranges) and the README comment that lists the shapes.
6. **Remove the temporary logging** from `tests/integration/postgres.test.ts`.
   Run `grep -rn "TEMP" tests/` and confirm nothing is left, then `git diff --stat` to check
   only the intended files changed.

## Notes

- Fields derived by splitting an index name on `_` are best effort; a field containing `_`
  splits wrongly. Note any such limitation in the test name.
- Every typed error must keep the original error as `cause`.
- Commit with a `fix:` prefix, one commit for code + test + docs.
