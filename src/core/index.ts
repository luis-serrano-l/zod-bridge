import type { ZodType } from "zod"
import { uniqueMessage } from "../internal/messages.js"
import { isPlainObject } from "../internal/plain-object.js"

/**
 * Options of `unique()` / `uniqueComposite()`. A bare string is shorthand for
 * `{ message }`.
 *
 * `TExclude` is the type of the `excludeWhere` fragment. Adapters narrow it
 * (e.g. `prismaUnique` sets it to the model's `WhereInput`); a hand-written
 * check fn that ignores `opts` leaves it as `unknown`.
 *
 * @example
 * unique(z.email(), prismaUnique(prisma.user, "email"), {
 *   message: "Email already registered",
 *   excludeWhere: { id: currentUserId }, // rows to ignore, merged as NOT
 * })
 */
export type UniqueOptions<TExclude = unknown> = {
  /** Issue message. Default: `"Value already taken"`. */
  readonly message?: string
  /**
   * Rows to ignore, passed to the check fn (the Prisma checks merge it as
   * `NOT`). Explicit override of the implicit primary-key exclusion.
   */
  readonly excludeWhere?: TExclude
  /**
   * Where to report the issue. Overrides the check fn's own path hint; useful
   * for composite checks, which otherwise report at the root of the object.
   */
  readonly path?: readonly PropertyKey[]
}

/**
 * Check fn of `unique()`: resolves `true` when the value is free, `false`
 * when it is taken. Use an adapter (`prismaUnique` from `zod-bridge/prisma`)
 * or write one for any data source.
 *
 * A check fn may carry a `path` hint: where in the parsed value the issue
 * belongs. Adapters set it when they validate a field of an object (e.g.
 * `prismaUnique(prisma.user, "email")` reports at `["email"]`). The hint is
 * ignored unless the parsed value is a plain object (not a Date, array or
 * class instance).
 *
 * @example
 * const usernameFree: UniqueFn<string> = async (name) => !(await redis.exists(`user:${name}`))
 * const Username = unique(z.string().min(3), usernameFree, "Username taken")
 * await Username.parseAsync("ada") // parseAsync, never parse
 */
export type UniqueFn<T, TExclude = unknown> = ((
  val: T,
  opts?: UniqueOptions<TExclude>,
) => Promise<boolean>) & { readonly path?: readonly PropertyKey[] }

/**
 * Adds an async uniqueness check to a Zod v4 schema and returns the same
 * schema type. `check` resolves `true` when the value is free; otherwise an
 * issue (`code: "custom"`) is added with `options.message`.
 *
 * - Requires `parseAsync` / `safeParseAsync`. `.parse()` throws Zod's
 *   "Encountered Promise during synchronous parse".
 * - `check` is skipped when the value already has an issue at or under the
 *   check's path (any issue, when there is no path), so invalid input never
 *   reaches the database.
 * - Best-effort: two concurrent requests can both pass. Keep the database
 *   constraint and translate its error with `handlePrismaError`.
 * - To exclude the record being edited, wrap the object (not the field) so
 *   the check can see its `id`; see `prismaUnique`.
 *
 * @example
 * import { z } from "zod"
 * import { unique } from "zod-bridge"
 * import { handlePrismaError, prismaUnique, PrismaUniqueConstraintError } from "zod-bridge/prisma"
 *
 * const Signup = z.object({ email: unique(z.email(), prismaUnique(prisma.user, "email"), "Email taken") })
 *
 * const parsed = await Signup.safeParseAsync(req.body) // never .parse() / .safeParse()
 * if (!parsed.success) return res.status(400).json(parsed.error.issues)
 * try {
 *   await prisma.user.create({ data: parsed.data }).catch(handlePrismaError)
 * } catch (e) {
 *   if (e instanceof PrismaUniqueConstraintError) return res.status(409).json({ fields: e.fields }) // lost the race
 *   throw e
 * }
 */
export function unique<TSchema extends ZodType, TExclude = unknown>(
  schema: TSchema,
  check: UniqueFn<TSchema["_output"], TExclude>,
  options?: string | UniqueOptions<TExclude>,
): TSchema {
  const message = uniqueMessage(options)
  const excludeWhere = typeof options === "object" ? options.excludeWhere : undefined

  return schema.superRefine(async (val: TSchema["_output"], ctx) => {
    // The check fn's path hint names a key of the parsed object, so it only
    // applies when the value is a plain object. Field-level use (`z.object({
    // email: unique(...) })`, any field type) reports at the root of the field;
    // Zod adds the parent key.
    const hint = isPlainObject(val) ? check.path : undefined
    // Don't hit the DB for a value that already failed validation. With a path
    // only issues at or under it count; without one, any issue does.
    const path = (typeof options === "object" ? options.path : undefined) ?? hint ?? []
    const alreadyInvalid = ctx.issues.some((issue) =>
      path.every((key, i) => issue.path?.[i] === key),
    )
    if (alreadyInvalid) return

    const isUnique = await check(val, excludeWhere === undefined ? {} : { excludeWhere })
    if (!isUnique) ctx.addIssue({ code: "custom", message, path: [...path] })
  }) as TSchema
}

/**
 * Alias of `unique()` for multi-column constraints: wrap the object so the
 * check fn receives every field. Reports at the object root unless
 * `options.path` is set. Requires `parseAsync`; pair the write with
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
export const uniqueComposite = unique
