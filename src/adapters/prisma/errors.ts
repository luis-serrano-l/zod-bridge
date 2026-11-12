import type { Prisma } from "@prisma/client"

/**
 * Base of every typed error in this module: `e instanceof PrismaBridgeError`
 * matches any of them. `cause` is the original Prisma error.
 */
export abstract class PrismaBridgeError extends Error {
  abstract readonly code: string

  constructor(message: string, original: Prisma.PrismaClientKnownRequestError) {
    super(message, { cause: original })
  }
}

export class PrismaUniqueConstraintError extends PrismaBridgeError {
  readonly code = "P2002"
  readonly fields: string[]

  constructor(original: Prisma.PrismaClientKnownRequestError) {
    const fields = extractUniqueFields(original.meta)
    super(`Unique constraint failed on: ${fields.join(", ")}`, original)
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

export class PrismaNotFoundError extends PrismaBridgeError {
  readonly code = "P2025"

  constructor(original: Prisma.PrismaClientKnownRequestError) {
    const cause = original.meta?.["cause"]
    super(typeof cause === "string" ? cause : "Record not found", original)
    this.name = "PrismaNotFoundError"
  }
}

export class PrismaForeignKeyError extends PrismaBridgeError {
  readonly code = "P2003"
  readonly fieldName: string

  constructor(original: Prisma.PrismaClientKnownRequestError) {
    const name = extractForeignKeyField(original.meta)
    super(`Foreign key constraint failed on: ${name}`, original)
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

export class PrismaRelationViolationError extends PrismaBridgeError {
  readonly code = "P2014"
  readonly relationName: string

  constructor(original: Prisma.PrismaClientKnownRequestError) {
    const rel = original.meta?.["relation_name"]
    const name = typeof rel === "string" ? rel : ""
    super(`Relation violation: ${name}`, original)
    this.name = "PrismaRelationViolationError"
    this.relationName = name
  }
}
