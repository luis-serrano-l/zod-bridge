import type { Prisma } from "@prisma/client"

/**
 * Base of every typed error in this module: `e instanceof PrismaBridgeError`
 * matches any of them. `cause` is the original `PrismaClientKnownRequestError`.
 * Thrown by `handlePrismaError` and `findOrThrow`; anything else is not ours.
 *
 * @example
 * try {
 *   await prisma.user.create({ data }).catch(handlePrismaError)
 * } catch (e) {
 *   if (e instanceof PrismaBridgeError) return res.status(400).json({ code: e.code, error: e.message })
 *   throw e // not a known Prisma request error: let it bubble
 * }
 */
export abstract class PrismaBridgeError extends Error {
  abstract readonly code: string

  constructor(message: string, original: Prisma.PrismaClientKnownRequestError) {
    super(message, { cause: original })
  }
}

/**
 * P2002: a write hit a unique constraint. `fields` lists the columns
 * (`["email"]`, or `["userId", "postId"]` for a composite). It is empty when
 * the Prisma version ships a `meta` shape this library cannot read; the raw
 * error is still at `cause`.
 *
 * A `unique()` pre-check does not make this impossible: two concurrent requests
 * can both pass validation, and one then fails here. Always handle both.
 *
 * @example
 * const Signup = z.object({ email: unique(z.email(), prismaUnique(prisma.user, "email")) })
 * const data = await Signup.parseAsync(req.body) // parseAsync, never parse
 * try {
 *   await prisma.user.create({ data }).catch(handlePrismaError)
 * } catch (e) {
 *   if (e instanceof PrismaUniqueConstraintError) return res.status(409).json({ fields: e.fields })
 *   throw e
 * }
 */
export class PrismaUniqueConstraintError extends PrismaBridgeError {
  readonly code = "P2002"
  /** Columns of the violated constraint; `[]` if they could not be read from `cause.meta`. */
  readonly fields: string[]

  constructor(original: Prisma.PrismaClientKnownRequestError) {
    const fields = extractUniqueFields(original.meta)
    const where =
      fields.length > 0 ? fields.join(", ") : "(fields not readable; inspect error.cause.meta)"
    super(
      `Unique constraint failed on: ${where}. Fix: use a value that is not already stored, or catch PrismaUniqueConstraintError and report a conflict (e.g. HTTP 409) using error.fields.`,
      original,
    )
    this.name = "PrismaUniqueConstraintError"
    this.fields = fields
  }
}

type DriverAdapterCause = {
  readonly constraint?: { readonly fields?: unknown; readonly index?: unknown }
  readonly table?: unknown
}

// Prisma 7 with driver adapter (≤7.9): meta.driverAdapterError.cause.constraint.fields
// Prisma 7 with driver adapter (7.10+): meta.driverAdapterError.cause.constraint.index + cause.table
// Prisma ≤6 and Prisma 7 without adapter: meta.target (string | string[])
function extractUniqueFields(meta: Record<string, unknown> | undefined): string[] {
  const cause = (meta?.["driverAdapterError"] as { cause?: DriverAdapterCause } | undefined)?.cause
  const driverFields = cause?.constraint?.fields
  if (Array.isArray(driverFields)) return (driverFields as string[]).map(unquote)

  const fromIndex = fieldsFromIndexName(cause?.constraint?.index, cause?.table)
  if (fromIndex.length > 0) return fromIndex

  const target = meta?.["target"]
  if (Array.isArray(target)) return (target as string[]).map(unquote)
  if (typeof target === "string") return [unquote(target)]

  return []
}

// Prisma names unique indexes `<Table>_<field>[_<field>...]_key`. Best effort:
// a field name containing an underscore is split into several fields.
function fieldsFromIndexName(index: unknown, table: unknown): string[] {
  if (typeof index !== "string" || !index.endsWith("_key")) return []
  const prefix = typeof table === "string" ? `${unquote(table)}_` : ""
  if (!index.startsWith(prefix)) return []
  return index
    .slice(prefix.length, -"_key".length)
    .split("_")
    .filter((f) => f.length > 0)
}

// Postgres quotes camelCase identifiers: `"userId"` → `userId`
function unquote(s: string): string {
  return s.startsWith('"') && s.endsWith('"') ? s.slice(1, -1) : s
}

/**
 * P2025: the record an `update`, `delete` or `findUniqueOrThrow` needed does
 * not exist. Also thrown by `findOrThrow` when its query resolves to `null`.
 *
 * @example
 * try {
 *   await prisma.user.update({ where: { id }, data }).catch(handlePrismaError)
 * } catch (e) {
 *   if (e instanceof PrismaNotFoundError) return res.status(404).end()
 *   throw e
 * }
 */
export class PrismaNotFoundError extends PrismaBridgeError {
  readonly code = "P2025"

  constructor(original: Prisma.PrismaClientKnownRequestError) {
    const cause = original.meta?.["cause"]
    const problem = (typeof cause === "string" ? cause : "Record not found").replace(/\.$/, "")
    super(
      `${problem}. Fix: check that the id / where clause matches an existing record, or catch PrismaNotFoundError and report not found (e.g. HTTP 404).`,
      original,
    )
    this.name = "PrismaNotFoundError"
  }
}

/**
 * P2003: a foreign key constraint failed. On create/update the referenced
 * record does not exist; on delete other records still reference this one.
 * `fieldName` is the foreign key column (`"authorId"`), or `""` when the
 * Prisma version ships a `meta` shape this library cannot read.
 *
 * @example
 * try {
 *   await prisma.post.create({ data: { title, authorId } }).catch(handlePrismaError)
 * } catch (e) {
 *   if (e instanceof PrismaForeignKeyError) return res.status(400).json({ field: e.fieldName })
 *   throw e
 * }
 */
export class PrismaForeignKeyError extends PrismaBridgeError {
  readonly code = "P2003"
  /** Foreign key column; `""` if it could not be read from `cause.meta`. */
  readonly fieldName: string

  constructor(original: Prisma.PrismaClientKnownRequestError) {
    const name = extractForeignKeyField(original.meta)
    const where = name === "" ? "(field not readable; inspect error.cause.meta)" : name
    super(
      `Foreign key constraint failed on: ${where}. Fix: on create/update, make sure the referenced record exists first; on delete, remove or reassign the records that still reference this one.`,
      original,
    )
    this.name = "PrismaForeignKeyError"
    this.fieldName = name
  }
}

// Prisma ≤6 and Prisma 7 without adapter: meta.field_name
// Prisma 7 with driver adapter (7.10+): meta.driverAdapterError.cause.constraint.index,
// named `<Table>_<field>_fkey` by Prisma. The table prefix is stripped using cause.table
// when it ships; otherwise up to the first underscore (wrong for a table containing `_`).
function extractForeignKeyField(meta: Record<string, unknown> | undefined): string {
  const fieldName = meta?.["field_name"]
  if (typeof fieldName === "string") return fieldName

  const cause = (meta?.["driverAdapterError"] as { cause?: DriverAdapterCause } | undefined)?.cause
  const index = cause?.constraint?.index
  if (typeof index !== "string" || !index.endsWith("_fkey")) return ""
  const withoutSuffix = index.slice(0, -"_fkey".length)
  const table = typeof cause?.table === "string" ? unquote(cause.table) : undefined
  if (table !== undefined && withoutSuffix.startsWith(`${table}_`)) {
    return withoutSuffix.slice(table.length + 1)
  }
  const firstUnderscore = withoutSuffix.indexOf("_")
  return firstUnderscore === -1 ? withoutSuffix : withoutSuffix.slice(firstUnderscore + 1)
}

/**
 * P2014: the change would break a required relation between two models
 * (typically deleting or disconnecting a record that another one requires).
 * `relationName` is Prisma's relation name, or `""` if absent from `cause.meta`.
 *
 * @example
 * try {
 *   await prisma.user.delete({ where: { id } }).catch(handlePrismaError)
 * } catch (e) {
 *   if (e instanceof PrismaRelationViolationError) return res.status(409).json({ relation: e.relationName })
 *   throw e
 * }
 */
export class PrismaRelationViolationError extends PrismaBridgeError {
  readonly code = "P2014"
  /** Prisma relation name; `""` if absent from `cause.meta`. */
  readonly relationName: string

  constructor(original: Prisma.PrismaClientKnownRequestError) {
    const rel = original.meta?.["relation_name"]
    const name = typeof rel === "string" ? rel : ""
    const which = name === "" ? "(relation not named; inspect error.cause.meta)" : name
    super(
      `Relation violation: ${which}. Fix: update or delete the related records first (or in the same transaction) so the required relation stays intact.`,
      original,
    )
    this.name = "PrismaRelationViolationError"
    this.relationName = name
  }
}
