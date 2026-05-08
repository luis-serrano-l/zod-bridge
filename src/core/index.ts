import type { ZodTypeAny } from "zod"

export type UniqueOptions = {
  message?: string
  excludeWhere?: unknown
}

type UniqueFn<T> = (val: T, opts?: UniqueOptions) => Promise<boolean>

export function unique<S extends ZodTypeAny>(
  schema: S,
  check: UniqueFn<S["_output"]>,
  options?: string | UniqueOptions,
): S {
  const message =
    typeof options === "string" ? options : (options?.message ?? "Value already taken")
  const excludeWhere = typeof options === "object" ? options.excludeWhere : undefined

  return schema.superRefine(async (val: S["_output"], ctx) => {
    const isUnique = await check(val, { excludeWhere })
    if (!isUnique) ctx.addIssue(message)
  }) as S
}

export const uniqueComposite = unique
