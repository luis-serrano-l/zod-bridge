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

type UniqueFn<T, TExclude> = (val: T, opts?: UniqueOptions<TExclude>) => Promise<boolean>

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
    if (!isUnique) ctx.addIssue(message)
  }) as TSchema
}

export const uniqueComposite = unique
