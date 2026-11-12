import { Prisma } from "@prisma/client"
import type { UniqueFn, UniqueOptions } from "../../core/index.js"
import {
  PrismaForeignKeyError,
  PrismaNotFoundError,
  PrismaRelationViolationError,
  PrismaUniqueConstraintError,
} from "./errors.js"

/**
 * Rethrows a Prisma known request error as a typed class: P2002 →
 * `PrismaUniqueConstraintError`, P2025 → `PrismaNotFoundError`, P2003 →
 * `PrismaForeignKeyError`, P2014 → `PrismaRelationViolationError`. Anything
 * else (other codes, non-Prisma errors) is rethrown untouched. Never returns
 * and takes no options.
 *
 * This is the safety net behind `unique()`: the Zod check is best-effort, so
 * two concurrent requests can both pass it and one fails at the write.
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

/**
 * Runs a query that may resolve to `null` (`findUnique`, `findFirst`) and
 * throws `PrismaNotFoundError` instead of returning `null`. Pass a function,
 * not a promise.
 *
 * @example
 * const user = await findOrThrow(() => prisma.user.findUnique({ where: { id } }))
 * // user is non-null here; catch PrismaNotFoundError to answer 404
 */
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
  // biome-ignore lint/suspicious/noExplicitAny: see above
  findFirst(args?: { where?: any }): Promise<unknown>
}

/** The model's `WhereInput`, recovered from its `findFirst` signature. */
type WhereOf<M extends FindFirstModel> = NonNullable<
  NonNullable<Parameters<M["findFirst"]>[0]>["where"]
>

/**
 * Options of `prismaUnique` and `prismaUniqueComposite`.
 *
 * @example
 * // model whose primary key is not `id`
 * prismaUnique(prisma.account, "email", { primaryKey: "uuid" })
 * // composite primary key
 * prismaUnique(prisma.membership, "slug", { primaryKey: ["orgId", "userId"] })
 */
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

/**
 * Values that must not reach `where`:
 * - `undefined` drops out of the filter and would match unrelated rows
 * - `null` never conflicts (SQL unique constraints treat NULLs as distinct)
 * - a plain object would be read by Prisma as a filter (`{ startsWith: "a" }`),
 *   turning the check into an oracle if the schema lets one through
 */
function isUncheckable(value: unknown): boolean {
  if (value === undefined || value === null) return true
  if (typeof value !== "object" || Array.isArray(value)) return false
  const proto: unknown = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
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
 * Check fn for `unique()`: resolves `true` when no row of `model` has this
 * value in `field`. Accepts either the bare field value or an object that
 * contains it. In object form the issue is reported at `[field]`, and if the
 * object carries the primary key (default `"id"`) that record is excluded, so
 * saving a record with its own value is not a conflict.
 *
 * Returns `true` without querying when the value is absent, `null` or a plain
 * object. Best-effort: pair the write with `handlePrismaError`.
 *
 * @example
 * // create: validate the field
 * const Signup = z.object({ email: unique(z.email(), prismaUnique(prisma.user, "email")) })
 * const data = await Signup.parseAsync(req.body) // parseAsync, never parse
 * await prisma.user.create({ data }).catch(handlePrismaError)
 *
 * @example
 * // update: validate the object and merge the route id in, so the record excludes itself
 * const Update = unique(
 *   z.object({ id: z.number(), email: z.email() }),
 *   prismaUnique(prisma.user, "email"),
 * )
 * const { id, ...data } = await Update.parseAsync({ ...req.body, id: Number(req.params.id) })
 * await prisma.user.update({ where: { id }, data }).catch(handlePrismaError)
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
      exclude ??= implicitExclude(val, primaryKey)
    }
    if (isUncheckable(value)) return true
    const where = exclude ? { [field]: value, NOT: exclude } : { [field]: value }
    const existing = await model.findFirst({ where })
    return existing === null || existing === undefined
  }
  return Object.assign(check, { path: [field] })
}

/**
 * Check fn for `uniqueComposite()`: resolves `true` when no row of `model`
 * has this combination of `fields`. `fields` is an array, never a
 * comma-joined string. The value is the object holding them; if it also
 * carries the primary key (default `"id"`), that record is excluded.
 *
 * The issue is reported at the object root; pass `{ path: ["postId"] }` to
 * `uniqueComposite` to attach it to a field. Best-effort: pair the write with
 * `handlePrismaError`.
 *
 * @example
 * const Like = uniqueComposite(
 *   z.object({ userId: z.number(), postId: z.number() }),
 *   prismaUniqueComposite(prisma.like, ["userId", "postId"]),
 *   { message: "Already liked", path: ["postId"] },
 * )
 * const data = await Like.parseAsync(req.body) // parseAsync, never parse
 * await prisma.like.create({ data }).catch(handlePrismaError)
 */
export function prismaUniqueComposite<M extends FindFirstModel>(
  model: M,
  fields: readonly KeyOf<M>[],
  options: PrismaUniqueOptions<M> = {},
): UniqueFn<Record<string, unknown>, WhereOf<M>> {
  const primaryKey = options.primaryKey ?? "id"
  return async (val, opts) => {
    if (fields.some((f) => isUncheckable(val[f]))) return true
    const fieldWhere = Object.fromEntries(fields.map((f) => [f, val[f]]))
    const exclude = opts?.excludeWhere ?? implicitExclude(val, primaryKey)
    const where = exclude ? { ...fieldWhere, NOT: exclude } : fieldWhere
    const existing = await model.findFirst({ where })
    return existing === null || existing === undefined
  }
}
