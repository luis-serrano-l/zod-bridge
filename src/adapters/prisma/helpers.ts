import { Prisma } from "@prisma/client"
import { $ZodError, type $ZodIssue } from "zod/v4/core"
import type { UniqueFn, UniqueOptions } from "../../core/index.js"
import { uniqueMessage } from "../../internal/messages.js"
import { isPlainObject } from "../../internal/plain-object.js"
import {
  type PrismaBridgeError,
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
  throw toTyped(err) ?? err
}

/**
 * The typed class for a raw Prisma known request error, `undefined` for
 * anything else. The one place that maps codes to classes: `handlePrismaError`
 * and `toZodIssues` both go through it.
 */
function toTyped(err: unknown): PrismaBridgeError | undefined {
  if (!(err instanceof Prisma.PrismaClientKnownRequestError)) return undefined
  switch (err.code) {
    case "P2002":
      return new PrismaUniqueConstraintError(err)
    case "P2025":
      return new PrismaNotFoundError(err)
    case "P2003":
      return new PrismaForeignKeyError(err)
    case "P2014":
      return new PrismaRelationViolationError(err)
    default:
      return undefined
  }
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

/**
 * Options of `toZodIssues`, mirroring `unique()`: pass the same message and
 * path the validator got. A bare string is shorthand for `{ message }`.
 */
export type ToZodIssuesOptions = {
  /** Issue message. Default: `"Value already taken"`, the default of `unique()`. */
  readonly message?: string
  /**
   * Where to report the issue. Default: `[field]` for a single-field
   * constraint, `[]` (the object root) for a composite one or when the fields
   * could not be read, the same places `unique()` / `uniqueComposite()` use.
   */
  readonly path?: readonly PropertyKey[]
  /**
   * Convert only a conflict on exactly these columns (any order); any other
   * unique constraint returns `undefined` and is rethrown. Without it every
   * unique conflict is converted with this message. Names are compared with
   * `PrismaUniqueConstraintError.fields`, which are database column names: for
   * a `@map`ped field pass the column name here and the Zod key as `path`.
   * Never matches when the error's fields could not be read, or when the list
   * is empty. Also sets the default `path` (`[field]` for one name, `[]` for
   * several). Ignored for a `ZodError`.
   */
  readonly fields?: readonly string[]
}

/**
 * One error shape for both layers. Returns Zod issues for the two ways a
 * uniqueness conflict surfaces, so a route needs a single error branch:
 *
 * - a `ZodError` (the `unique()` pre-check caught it) → its issues, untouched
 * - a `PrismaUniqueConstraintError` (a concurrent request won the race), or
 *   the raw Prisma P2002 if the write skipped `handlePrismaError` → the issue
 *   `unique()` would have produced: `{ code: "custom", message, path }`
 * - anything else → `undefined`: rethrow it
 *
 * Other typed errors (not found, foreign key, relation) are not validation
 * issues of the submitted values and return `undefined`.
 *
 * Every `ZodError` is returned, whichever schema threw it: keep only the
 * request parse and the write inside the `try`, so a failed parse of server
 * data is not sent to the client as a validation error.
 *
 * The default path is read from the database error, so it equals the path of
 * `unique()` when the validator is in a top-level `z.object` and the column is
 * not renamed. Pass `path` when the schema is nested (`["user", "email"]`),
 * when a bare value is parsed (`[]`), or when the column is `@map`ped. A
 * column containing `_` reports at the root on Prisma 7.10+ (fields are
 * derived from the index name) unless `fields` or `path` names it.
 *
 * @example
 * const Signup = z.object({ email: unique(z.email(), prismaUnique(prisma.user, "email"), "Email taken") })
 * try {
 *   const data = await Signup.parseAsync(req.body) // parseAsync, never parse
 *   await prisma.user.create({ data }).catch(handlePrismaError)
 * } catch (e) {
 *   const issues = toZodIssues(e, "Email taken") // same message as the validator
 *   if (issues) return res.status(400).json({ issues }) // [{ code: "custom", message: "Email taken", path: ["email"] }]
 *   throw e
 * }
 *
 * @example
 * // several unique constraints: name each one, the first match wins, others are rethrown
 * const issues =
 *   toZodIssues(e, { fields: ["email"], message: "Email taken" }) ??
 *   toZodIssues(e, { fields: ["username"], message: "Username taken" })
 *
 * @example
 * // composite constraint: same options object as uniqueComposite()
 * const options = { message: "Already liked", path: ["postId"] }
 * const Like = uniqueComposite(shape, prismaUniqueComposite(prisma.like, ["userId", "postId"]), options)
 * try {
 *   const data = await Like.parseAsync(req.body)
 *   await prisma.like.create({ data }).catch(handlePrismaError)
 * } catch (e) {
 *   const issues = toZodIssues(e, options)
 *   if (issues) return res.status(400).json({ issues })
 *   throw e
 * }
 */
export function toZodIssues(
  err: unknown,
  options?: string | ToZodIssuesOptions,
): $ZodIssue[] | undefined {
  // A new array (the issue objects are shared): adding or removing issues
  // leaves the thrown error as it was.
  if (err instanceof $ZodError) return [...err.issues]

  const conflict = err instanceof PrismaUniqueConstraintError ? err : toTyped(err)
  if (!(conflict instanceof PrismaUniqueConstraintError)) return undefined

  const opts = typeof options === "object" ? options : {}
  if (opts.fields !== undefined && !sameFields(conflict.fields, opts.fields)) return undefined

  // With a guard the caller's names are the reliable ones (the error's may be
  // split on `_`); without it, the error's are all there is.
  const [field, ...rest] = opts.fields ?? conflict.fields
  const path = opts.path ?? (field !== undefined && rest.length === 0 ? [field] : [])
  return [{ code: "custom", message: uniqueMessage(options), path: [...path] }]
}

/**
 * Same column names, in any order. Also true when they are equal once joined
 * with `_`: Prisma 7.10+ only ships the index name, so `user_name` arrives as
 * `["user", "name"]`. Never true for an unreadable (empty) constraint or an
 * empty expectation.
 */
function sameFields(actual: readonly string[], expected: readonly string[]): boolean {
  if (actual.length === 0 || expected.length === 0) return false
  if (actual.join("_") === expected.join("_")) return true
  const wanted = new Set(expected)
  return new Set(actual).size === wanted.size && actual.every((field) => wanted.has(field))
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

/**
 * Values that must not reach `where`:
 * - `undefined` drops out of the filter and would match unrelated rows
 * - `null` never conflicts (SQL unique constraints treat NULLs as distinct)
 * - a plain object would be read by Prisma as a filter (`{ startsWith: "a" }`),
 *   turning the check into an oracle if the schema lets one through
 */
function isUncheckable(value: unknown): boolean {
  return value === undefined || value === null || isPlainObject(value)
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
 * value in `field`. Accepts either the bare field value or a plain object that
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
    // Same test core uses to apply the path hint: a Date, array or Decimal is
    // the bare field value, not an object holding it.
    if (isPlainObject(val)) {
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
