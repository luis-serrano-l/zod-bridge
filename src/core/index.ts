import type { ZodTypeAny } from "zod"

/**
 * `TExclude` is the type of the `excludeWhere` fragment. Adapters narrow it
 * (e.g. `prismaUnique` sets it to the model's `WhereInput`); a hand-written
 * check fn that ignores `opts` leaves it as `unknown`.
 */
export type UniqueOptions<TExclude = unknown> = {
  readonly message?: string
  readonly excludeWhere?: TExclude
}

/**
 * A check fn may carry a `path` hint: where in the parsed value the issue
 * belongs. Adapters set it when they validate a field of an object (e.g.
 * `prismaUnique(prisma.user, "email")` reports at `["email"]`).
 */
export type UniqueFn<T, TExclude = unknown> = ((
  val: T,
  opts?: UniqueOptions<TExclude>,
) => Promise<boolean>) & { readonly path?: readonly PropertyKey[] }

export function unique<TSchema extends ZodTypeAny, TExclude = unknown>(
  schema: TSchema,
  check: UniqueFn<TSchema["_output"], TExclude>,
  options?: string | UniqueOptions<TExclude>,
): TSchema {
  const message =
    typeof options === "string" ? options : (options?.message ?? "Value already taken")
  const excludeWhere = typeof options === "object" ? options.excludeWhere : undefined

  return schema.superRefine(async (val: TSchema["_output"], ctx) => {
    const isUnique = await check(val, excludeWhere === undefined ? {} : { excludeWhere })
    if (!isUnique) ctx.addIssue({ code: "custom", message, path: [...(check.path ?? [])] })
  }) as TSchema
}

export const uniqueComposite = unique
