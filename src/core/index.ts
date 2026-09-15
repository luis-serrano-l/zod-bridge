import type { ZodTypeAny } from "zod"

export type UniqueOptions = {
  readonly message?: string
  readonly excludeWhere?: unknown
}

type UniqueFn<T> = (val: T, opts?: UniqueOptions) => Promise<boolean>

export function unique<TSchema extends ZodTypeAny>(
  schema: TSchema,
  check: UniqueFn<TSchema["_output"]>,
  options?: string | UniqueOptions,
): TSchema {
  const message =
    typeof options === "string" ? options : (options?.message ?? "Value already taken")
  const excludeWhere = typeof options === "object" ? options.excludeWhere : undefined

  return schema.superRefine(async (val: TSchema["_output"], ctx) => {
    const isUnique = await check(val, { excludeWhere })
    if (!isUnique) ctx.addIssue(message)
  }) as TSchema
}

export const uniqueComposite = unique
