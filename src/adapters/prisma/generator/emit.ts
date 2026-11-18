// Turns the DMMF Prisma hands a generator into the source of the descriptor
// module `createSchema` reads. Pure text in, text out: no `@prisma/client`, no
// `zod`, so the generator binary starts without either installed.

/** The slice of a DMMF field the emitter reads. */
export type DmmfField = {
  readonly name: string
  /** `scalar`, `enum`, `object` (relation) or `unsupported`. */
  readonly kind: string
  readonly type: string
  readonly isList?: boolean
  readonly isRequired?: boolean
  readonly isId?: boolean
  readonly isUnique?: boolean
  readonly hasDefaultValue?: boolean
  readonly isUpdatedAt?: boolean
  /** Column name when the field is `@map`ped. */
  readonly dbName?: string | null
}

/** The slice of a DMMF model the emitter reads. */
export type DmmfModel = {
  readonly name: string
  readonly fields: readonly DmmfField[]
  /** `@@id([...])`. A single-field `@id` is on the field instead. */
  readonly primaryKey?: { readonly fields: readonly string[] } | null
  /** `@@unique([...])` groups. A single-field `@unique` is on the field instead. */
  readonly uniqueFields?: readonly (readonly string[])[]
}

/** The slice of a DMMF enum the emitter reads. */
export type DmmfEnum = {
  readonly name: string
  readonly values: readonly { readonly name: string }[]
}

/** The slice of a DMMF datamodel the emitter reads. */
export type DmmfDatamodel = {
  readonly models: readonly DmmfModel[]
  readonly enums?: readonly DmmfEnum[]
}

export type EmitOptions = {
  /** Module the generated file imports `defineModel` from. Default: `"zod-bridge/prisma"`. */
  readonly importPath?: string
}

export const DEFAULT_IMPORT_PATH = "zod-bridge/prisma"

const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/

/**
 * `DateTime` accepts what Prisma accepts: a `Date`, or an ISO 8601 string with
 * `Z` or an offset (what JSON carries). The output is always a `Date`. Emitted
 * once per file, only when a model has a `DateTime` column.
 */
const DATE_TIME = [
  "// DateTime: a Date, or an ISO 8601 string with Z or an offset, as Prisma accepts. Output: Date.",
  "const dateTime = z.union([",
  "  z.date(),",
  "  z.iso.datetime({ offset: true }).transform((value) => new Date(value)),",
  "])",
].join("\n")

/** Zod source for each Prisma scalar: what `prisma.model.create` accepts from JSON-like input. */
const SCALARS: Readonly<Record<string, string>> = {
  String: "z.string()",
  Int: "z.int()",
  BigInt: "z.bigint()",
  Float: "z.number()",
  Decimal: "z.union([z.number(), z.string()])",
  Boolean: "z.boolean()",
  DateTime: "dateTime",
  Json: "z.json()",
  Bytes: "z.instanceof(Uint8Array)",
}

/** Zod source for one field, `undefined` when the field has no column to validate. */
function fieldSource(field: DmmfField, enums: ReadonlyMap<string, DmmfEnum>): string | undefined {
  let base: string | undefined
  if (field.kind === "scalar") {
    base = SCALARS[field.type]
  } else if (field.kind === "enum") {
    const values = enums.get(field.type)?.values.map((value) => JSON.stringify(value.name))
    if (values !== undefined && values.length > 0) base = `z.enum([${values.join(", ")}])`
  }
  // Relations, `Unsupported(...)` columns and scalars this version does not know.
  if (base === undefined) return undefined

  if (field.isList) return `z.array(${base}).optional()`
  if (field.isRequired === false) return `${base}.nullish()`
  if (field.hasDefaultValue || field.isUpdatedAt) return `${base}.optional()`
  return base
}

function key(name: string): string {
  return IDENTIFIER.test(name) ? name : JSON.stringify(name)
}

function list(names: readonly string[]): string {
  return `[${names.map((name) => JSON.stringify(name)).join(", ")}]`
}

function modelSource(model: DmmfModel, enums: ReadonlyMap<string, DmmfEnum>): string {
  if (!IDENTIFIER.test(model.name)) {
    throw new Error(`zod-bridge: model name ${JSON.stringify(model.name)} is not an identifier`)
  }
  const fields = model.fields.flatMap((field) => {
    const source = fieldSource(field, enums)
    return source === undefined ? [] : [{ field, source }]
  })
  const known = new Set(fields.map(({ field }) => field.name))
  const allKnown = (names: readonly string[]) => names.every((name) => known.has(name))

  const idField = fields.find(({ field }) => field.isId)?.field.name
  const primaryKey = model.primaryKey?.fields ?? (idField === undefined ? [] : [idField])
  const seen = new Set<string>()
  const unique = [
    ...fields.filter(({ field }) => field.isUnique).map(({ field }) => [field.name]),
    ...(model.uniqueFields ?? []),
  ].filter((group) => {
    // One check per constraint: the same fields in another order are the same pre-check.
    const id = JSON.stringify([...group].sort())
    if (group.length === 0 || !allKnown(group) || seen.has(id)) return false
    seen.add(id)
    return true
  })
  const columns = fields.filter(({ field }) => typeof field.dbName === "string")

  const lines = [
    `export const ${model.name}Model = defineModel({`,
    `  name: ${JSON.stringify(model.name)},`,
    "  shape: {",
    ...fields.map(({ field, source }) => `    ${key(field.name)}: ${source},`),
    "  },",
    `  primaryKey: ${list(allKnown(primaryKey) ? primaryKey : [])},`,
    `  unique: [${unique.map(list).join(", ")}],`,
  ]
  if (columns.length > 0) {
    lines.push(
      "  columns: {",
      ...columns.map(({ field }) => `    ${key(field.name)}: ${JSON.stringify(field.dbName)},`),
      "  },",
    )
  }
  lines.push("})")
  return lines.join("\n")
}

/**
 * Source of the generated module: one `<Model>Model` descriptor per model, in
 * schema order. The shape is the create input: fields with a default are
 * optional, nullable columns accept `null`, relations are left out.
 */
export function emitModels(datamodel: DmmfDatamodel, options: EmitOptions = {}): string {
  const enums = new Map((datamodel.enums ?? []).map((e) => [e.name, e]))
  const header = [
    "// Generated by zod-bridge from the Prisma schema. Do not edit: rerun `prisma generate`.",
    'import { z } from "zod"',
    `import { defineModel } from ${JSON.stringify(options.importPath ?? DEFAULT_IMPORT_PATH)}`,
  ].join("\n")
  const models = datamodel.models.map((model) => modelSource(model, enums))
  const usesDateTime = datamodel.models.some((model) =>
    model.fields.some((field) => field.kind === "scalar" && field.type === "DateTime"),
  )
  return `${[header, ...(usesDateTime ? [DATE_TIME] : []), ...models].join("\n\n")}\n`
}
