import { ZodOptional, type ZodType, z } from "zod"
import type { $ZodIssue } from "zod/v4/core"
import { type UniqueFn, type UniqueOptions, unique } from "../../core/index.js"
import {
  type FindFirstModel,
  prismaUnique,
  prismaUniqueComposite,
  type ToZodIssuesOptions,
  toZodIssues,
} from "./helpers.js"

type Shape = Readonly<Record<string, ZodType>>

/**
 * What the `zod-bridge` Prisma generator knows about one model: the facts
 * Prisma does not expose at runtime. Generated, not written by hand; see
 * `defineModel`.
 */
export type ModelDescriptor<TShape extends Shape = Shape, TKey extends string = string> = {
  /** Model name as written in `schema.prisma` (`"User"`). */
  readonly name: string
  /** One Zod schema per column, shaped as the create input. Relations are left out. */
  readonly shape: TShape
  /** Primary-key field(s): `["id"]`, several for `@@id`, `[]` when the model has none. */
  readonly primaryKey: readonly TKey[]
  /** Unique constraints other than the primary key, each as an array of fields. */
  readonly unique: readonly (readonly string[])[]
  /** Database column of each `@map`ped field. */
  readonly columns?: Readonly<Record<string, string>>
}

/**
 * Types a model descriptor. Called by the file the `zod-bridge` Prisma
 * generator writes; you only import its results.
 *
 * @example
 * // schema.prisma
 * // generator zodBridge {
 * //   provider = "zod-bridge"
 * //   output   = "./generated/zod-bridge.ts"
 * // }
 * //
 * // prisma/generated/zod-bridge.ts, after `prisma generate`:
 * export const UserModel = defineModel({
 *   name: "User",
 *   shape: { id: z.int().optional(), email: z.string() },
 *   primaryKey: ["id"],
 *   unique: [["email"]],
 * })
 */
export function defineModel<TShape extends Shape, TKey extends keyof TShape & string = never>(
  descriptor: ModelDescriptor<TShape, TKey>,
): ModelDescriptor<TShape, TKey> {
  return descriptor
}

/** Message and path of one unique constraint of a `createSchema` schema. */
export type UniqueRule = {
  /** Fields of the constraint, as an array in any order: `["email"]`, `["userId", "postId"]`. */
  readonly fields: readonly string[]
  /** Issue message. Default: `"Value already taken"`. */
  readonly message?: string
  /** Where to report the issue. Default: `[field]` for one field, `[]` for a composite. */
  readonly path?: readonly PropertyKey[]
}

/** Options of `createSchema`. */
export type CreateSchemaOptions<
  TFields extends Shape,
  TPick extends string,
  TOmit extends string,
  TMode extends "create" | "update",
> = Selection<TPick, TOmit> & {
  /** Zod schemas that replace (or add to) the generated ones, by field. */
  readonly fields?: TFields
  /**
   * `"create"` (default): the generated shape. `"update"`: the primary key is
   * required and every other field optional, for partial updates.
   */
  readonly mode?: TMode
  /** Message / path per unique constraint. Constraints not listed use the defaults. */
  readonly unique?: readonly UniqueRule[]
}

/**
 * Which columns the client may send. One of the two is required, so that no
 * schema accepts every column by accident: `pick` is an allow-list (a column
 * added to the model later stays out), `omit` a deny-list (`omit: []` states
 * "every column" on purpose).
 */
export type Selection<TPick extends string, TOmit extends string> =
  | {
      /** Keep only these fields. Prefer it for request bodies. */
      readonly pick: readonly TPick[]
      /** Drop these fields. */
      readonly omit?: readonly TOmit[]
    }
  | {
      /** Keep only these fields. Prefer it for request bodies. */
      readonly pick?: readonly TPick[]
      /** Drop these fields (server-set columns such as `role` or `createdAt`). */
      readonly omit: readonly TOmit[]
    }

type Unwrapped<T> = T extends ZodOptional<infer Inner extends ZodType> ? Inner : T

type Merged<TShape, TFields> = Omit<TShape, keyof TFields> & TFields

type Field<T, K, TKey, TMode> = TMode extends "update"
  ? K extends TKey
    ? Unwrapped<T>
    : ZodOptional<T & ZodType>
  : T

type FinalShape<TShape, TKey, TFields, TPick, TOmit, TMode> = {
  [K in Exclude<Extract<keyof Merged<TShape, TFields>, TPick>, TOmit>]: Field<
    Merged<TShape, TFields>[K],
    K,
    TKey,
    TMode
  >
}

type AsShape<T> = T extends Shape ? T : never

/** What `createSchema` adds to the Zod object it returns. */
export type SchemaBridge = {
  /**
   * `toZodIssues` with this schema's constraints, messages and paths filled
   * in: a `ZodError` → its issues; a unique conflict on one of the schema's
   * constraints (typed or raw P2002) → the issue the pre-check would have
   * added; anything else, including a conflict on a constraint the schema does
   * not validate → `undefined`: rethrow it.
   */
  toZodIssues(err: unknown): $ZodIssue[] | undefined
}

const sameSet = (a: readonly string[], b: readonly string[]) =>
  new Set(a).size === new Set(b).size && a.every((name) => b.includes(name))

/**
 * Builds the Zod schema of a Prisma model from its generated descriptor, with
 * both layers wired: an async uniqueness check for every unique constraint,
 * and `schema.toZodIssues(err)` to turn the database error of a lost race into
 * the same issue.
 *
 * - Requires `parseAsync` / `safeParseAsync`, like `unique()`.
 * - The base shape is the create input; `fields` overrides it. `pick` or
 *   `omit` is required and selects the columns the client may send (`pick` is
 *   the allow-list; `omit: []` accepts every column). Select here: Zod refuses
 *   `.pick()` / `.omit()` on the result, and `toZodIssues` is lost on any
 *   derived schema.
 * - Update exclusion uses the model's real primary key: when the parsed value
 *   carries it, that record is not a conflict. Merge the route id in before
 *   parsing. `mode: "update"` makes the key required and the rest optional.
 * - Best-effort, like every pre-check: keep `.catch(handlePrismaError)` on the
 *   write.
 *
 * @example
 * import { createSchema, handlePrismaError } from "zod-bridge/prisma"
 * import { UserModel } from "./prisma/generated/zod-bridge" // written by `prisma generate`
 *
 * const UserSchema = createSchema(prisma.user, UserModel, {
 *   pick: ["email", "name"], // only what the client may send
 *   fields: { email: z.email() },
 *   unique: [{ fields: ["email"], message: "Email already taken" }],
 * })
 *
 * try {
 *   const data = await UserSchema.parseAsync(req.body) // parseAsync, never parse
 *   await prisma.user.create({ data }).catch(handlePrismaError)
 * } catch (e) {
 *   const issues = UserSchema.toZodIssues(e) // pre-check or lost race: same issue
 *   if (issues) return res.status(400).json({ issues })
 *   throw e
 * }
 *
 * @example
 * // partial update: the record excludes itself through its primary key
 * const UserPatch = createSchema(prisma.user, UserModel, { mode: "update", omit: ["role"] })
 * const { id, ...data } = await UserPatch.parseAsync({ ...req.body, id: Number(req.params.id) })
 * await prisma.user.update({ where: { id }, data }).catch(handlePrismaError)
 */
export function createSchema<
  TShape extends Shape,
  TKey extends string,
  TFields extends Shape = Record<never, ZodType>,
  TPick extends (keyof TShape | keyof TFields) & string = (keyof TShape | keyof TFields) & string,
  TOmit extends (keyof TShape | keyof TFields) & string = never,
  TMode extends "create" | "update" = "create",
>(
  model: FindFirstModel,
  descriptor: ModelDescriptor<TShape, TKey>,
  options: CreateSchemaOptions<TFields, TPick, TOmit, TMode>,
): z.ZodObject<AsShape<FinalShape<TShape, TKey, TFields, TPick, TOmit, TMode>>> & SchemaBridge {
  const delegateName = (model as { readonly $name?: unknown }).$name
  if (typeof delegateName === "string" && delegateName !== descriptor.name) {
    throw new Error(
      `createSchema: got the "${delegateName}" delegate with the "${descriptor.name}" descriptor. ` +
        `Fix: pass the delegate and the descriptor of the same model, e.g. createSchema(prisma.user, UserModel).`,
    )
  }

  // Typed as required; this is for JavaScript callers and `as any`.
  if (options?.pick === undefined && options?.omit === undefined) {
    throw new Error(
      `createSchema: neither pick nor omit was given for the ${descriptor.name} schema. ` +
        `Fix: list the fields the client may send with pick: [...], or the ones it may not with omit: [...] (omit: [] accepts every column).`,
    )
  }

  const primaryKey: readonly string[] = descriptor.primaryKey
  const merged = new Map<string, ZodType>([
    ...Object.entries(descriptor.shape),
    ...Object.entries(options.fields ?? {}),
  ])
  const keys = [...merged.keys()].filter(
    (name) =>
      (options.pick === undefined || options.pick.includes(name as never)) &&
      !options.omit?.includes(name as never),
  )
  const shape: Record<string, ZodType> = {}
  for (const name of keys) {
    const field = merged.get(name)
    if (field === undefined) continue
    if (options.mode !== "update") shape[name] = field
    else if (!primaryKey.includes(name)) shape[name] = field.optional()
    else shape[name] = field instanceof ZodOptional ? (field.unwrap() as ZodType) : field
  }

  // Own keys only: `"toString" in shape` is true for every object.
  const holds = (group: readonly string[]) => group.every((name) => Object.hasOwn(shape, name))
  const rules = options.unique ?? []
  for (const rule of rules) {
    const constraint = descriptor.unique.find((group) => sameSet(group, rule.fields))
    if (constraint === undefined || !holds(constraint)) {
      throw new Error(
        `createSchema: no unique constraint on [${rule.fields.join(", ")}] in this ${descriptor.name} schema. ` +
          `Fix: list the fields of a @unique / @@unique of the model that the schema keeps ` +
          `(known: ${descriptor.unique.map((group) => `[${group.join(", ")}]`).join(", ") || "none"}), then rerun prisma generate if the Prisma schema changed.`,
      )
    }
  }

  let schema: ZodType = z.object(shape)
  const conversions: ToZodIssuesOptions[] = []
  for (const group of descriptor.unique) {
    const [first, ...rest] = group
    // A constraint the schema does not fully hold cannot be pre-checked, and
    // its database error is not about the submitted values: left to rethrow.
    if (first === undefined || !holds(group)) continue
    const rule = rules.find((candidate) => sameSet(candidate.fields, group))
    const check =
      rest.length === 0
        ? prismaUnique(model, first as never, { primaryKey: primaryKey as never })
        : prismaUniqueComposite(model, group as never, { primaryKey: primaryKey as never })
    const reported: { message?: string; path?: readonly PropertyKey[] } = {}
    if (rule?.message !== undefined) reported.message = rule.message
    if (rule?.path !== undefined) reported.path = rule.path

    schema = unique(schema, check as UniqueFn<unknown>, reported as UniqueOptions)
    conversions.push({
      ...reported,
      // The database reports column names; the issue is reported at the field.
      fields: group.map((name) => descriptor.columns?.[name] ?? name),
      path: rule?.path ?? (rest.length === 0 ? [first] : []),
    })
  }

  const bridge: SchemaBridge = {
    toZodIssues(err) {
      for (const conversion of conversions) {
        const issues = toZodIssues(err, conversion)
        if (issues !== undefined) return issues
      }
      // No constraint matched: only a ZodError is still ours.
      return conversions.length === 0 ? toZodIssues(err, { fields: [] }) : undefined
    },
  }
  return Object.assign(schema, bridge) as never
}
