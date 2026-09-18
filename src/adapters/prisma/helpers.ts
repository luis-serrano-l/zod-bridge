import { Prisma } from "@prisma/client"
import type { UniqueFn, UniqueOptions } from "../../core/index.js"
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

/** The model's `WhereInput`, recovered from its `findFirst` signature. */
type WhereOf<M extends FindFirstModel> = NonNullable<
  NonNullable<Parameters<M["findFirst"]>[0]>["where"]
>

export type PrismaUniqueOptions<M extends FindFirstModel> = {
  /**
   * Field(s) identifying the record being edited. When the parsed value
   * carries all of them, that record is excluded from the check (`NOT`), so
   * updating a record to its own value is not a conflict. Default: `"id"`.
   */
  readonly primaryKey?: KeyOf<M> | readonly KeyOf<M>[]
}

type KeyOf<M extends FindFirstModel> = Extract<keyof WhereOf<M>, string>

function isObject(val: unknown): val is Record<string, unknown> {
  return typeof val === "object" && val !== null && !Array.isArray(val)
}

/** `{ id: val.id }` when every primary-key field is present, else undefined. */
function implicitExclude(
  val: Record<string, unknown>,
  primaryKey: string | readonly string[],
): Record<string, unknown> | undefined {
  const keys = typeof primaryKey === "string" ? [primaryKey] : primaryKey
  if (keys.length === 0 || keys.some((k) => val[k] === undefined)) return undefined
  return Object.fromEntries(keys.map((k) => [k, val[k]]))
}

/**
 * Check fn for `unique()`. Accepts either the bare field value
 * (`unique(z.email(), prismaUnique(prisma.user, "email"))`) or an object that
 * contains it (`unique(z.object({ id, email }), prismaUnique(prisma.user, "email"))`).
 * In object form the issue is reported at `[field]`, and if the object carries
 * the primary key the matching record is excluded automatically.
 */
export function prismaUnique<M extends FindFirstModel>(
  model: M,
  field: KeyOf<M>,
  options: PrismaUniqueOptions<M> = {},
): UniqueFn<unknown, WhereOf<M>> {
  const primaryKey = options.primaryKey ?? "id"
  const check = async (val: unknown, opts?: UniqueOptions<WhereOf<M>>) => {
    let value = val
    let exclude: unknown = opts?.excludeWhere
    if (isObject(val)) {
      value = val[field]
      if (value === undefined) return true
      exclude ??= implicitExclude(val, primaryKey)
    }
    const where = exclude ? { [field]: value, NOT: exclude } : { [field]: value }
    const existing = await model.findFirst({ where })
    return existing === null || existing === undefined
  }
  return Object.assign(check, { path: [field] })
}

/**
 * Check fn for `uniqueComposite()`. The value is the object holding `fields`;
 * if it also carries the primary key, that record is excluded automatically.
 */
export function prismaUniqueComposite<M extends FindFirstModel>(
  model: M,
  fields: readonly KeyOf<M>[],
  options: PrismaUniqueOptions<M> = {},
): UniqueFn<Record<string, unknown>, WhereOf<M>> {
  const primaryKey = options.primaryKey ?? "id"
  return async (val, opts) => {
    const fieldWhere = Object.fromEntries(fields.map((f) => [f, val[f]]))
    const exclude = opts?.excludeWhere ?? implicitExclude(val, primaryKey)
    const where = exclude ? { ...fieldWhere, NOT: exclude } : fieldWhere
    const existing = await model.findFirst({ where })
    return existing === null || existing === undefined
  }
}
