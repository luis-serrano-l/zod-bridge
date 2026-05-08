import { Prisma } from "@prisma/client"
import type { UniqueOptions } from "../../core/index.js"
import {
  PrismaForeignKeyError,
  PrismaNotFoundError,
  PrismaRelationViolationError,
  PrismaUniqueConstraintError,
} from "./errors.js"

export function handlePrismaError(err: unknown): never {
  if (err instanceof Prisma.PrismaClientKnownRequestError) {
    switch (err.code) {
      case "P2002":
        throw new PrismaUniqueConstraintError(err)
      case "P2025":
        throw new PrismaNotFoundError(err)
      case "P2003":
        throw new PrismaForeignKeyError(err)
      case "P2014":
        throw new PrismaRelationViolationError(err)
    }
  }
  throw err
}

export async function findOrThrow<T>(query: () => Promise<T | null>): Promise<T> {
  const result = await query()
  if (result === null) {
    throw new PrismaNotFoundError(
      new Prisma.PrismaClientKnownRequestError("Record not found", {
        code: "P2025",
        clientVersion: "",
      }),
    )
  }
  return result
}

type FindFirstModel = {
  // Prisma generates model-specific types; `any` is required for structural compatibility.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  findFirst(args?: { where?: any }): Promise<unknown>
}

export function prismaUnique(
  model: FindFirstModel,
  field: string,
): (val: unknown, opts?: UniqueOptions) => Promise<boolean> {
  return async (val, opts) => {
    const where = opts?.excludeWhere
      ? { [field]: val, NOT: opts.excludeWhere }
      : { [field]: val }
    const existing = await model.findFirst({ where })
    return existing === null || existing === undefined
  }
}

export function prismaUniqueComposite(
  model: FindFirstModel,
  fields: string[],
): (val: Record<string, unknown>, opts?: UniqueOptions) => Promise<boolean> {
  return async (val, opts) => {
    const fieldWhere = Object.fromEntries(fields.map((f) => [f, val[f]]))
    const where = opts?.excludeWhere ? { ...fieldWhere, NOT: opts.excludeWhere } : fieldWhere
    const existing = await model.findFirst({ where })
    return existing === null || existing === undefined
  }
}
