import type { Prisma } from "@prisma/client"

export class PrismaUniqueConstraintError extends Error {
  readonly code = "P2002"
  readonly fields: string[]

  constructor(original: Prisma.PrismaClientKnownRequestError) {
    const target = original.meta?.["target"]
    const fields = Array.isArray(target)
      ? (target as string[])
      : typeof target === "string"
        ? [target]
        : []
    super(`Unique constraint failed on: ${fields.join(", ")}`)
    this.name = "PrismaUniqueConstraintError"
    this.fields = fields
  }
}

export class PrismaNotFoundError extends Error {
  readonly code = "P2025"

  constructor(original: Prisma.PrismaClientKnownRequestError) {
    const cause = original.meta?.["cause"]
    super(typeof cause === "string" ? cause : "Record not found")
    this.name = "PrismaNotFoundError"
  }
}

export class PrismaForeignKeyError extends Error {
  readonly code = "P2003"
  readonly fieldName: string

  constructor(original: Prisma.PrismaClientKnownRequestError) {
    const fieldName = original.meta?.["field_name"]
    const name = typeof fieldName === "string" ? fieldName : ""
    super(`Foreign key constraint failed on: ${name}`)
    this.name = "PrismaForeignKeyError"
    this.fieldName = name
  }
}

export class PrismaRelationViolationError extends Error {
  readonly code = "P2014"
  readonly relationName: string

  constructor(original: Prisma.PrismaClientKnownRequestError) {
    const rel = original.meta?.["relation_name"]
    const name = typeof rel === "string" ? rel : ""
    super(`Relation violation: ${name}`)
    this.name = "PrismaRelationViolationError"
    this.relationName = name
  }
}
