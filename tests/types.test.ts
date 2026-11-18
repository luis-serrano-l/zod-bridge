import { describe, expect, it } from "vitest"
import { z } from "zod"
import { createSchema, prismaUnique, prismaUniqueComposite } from "../src/adapters/prisma/index.js"
import { unique } from "../src/index.js"
import { UserModel } from "./generated/zod-bridge.js"

// Compile-time checks: `npm run typecheck` fails if a `@ts-expect-error` line stops erroring.
type UserWhere = { id?: number; email?: string; tenantId?: number }
const user = {
  findFirst: async (_args?: { where?: UserWhere }): Promise<unknown> => null,
}

describe("types", () => {
  it("field, primaryKey and excludeWhere are checked against the model's where type", () => {
    prismaUnique(user, "email", { primaryKey: ["tenantId", "id"] })
    prismaUniqueComposite(user, ["tenantId", "email"])
    unique(z.email(), prismaUnique(user, "email"), { excludeWhere: { id: 1 } })

    // @ts-expect-error unknown field
    prismaUnique(user, "emial")
    // @ts-expect-error unknown primary key
    prismaUnique(user, "email", { primaryKey: "uuid" })
    // @ts-expect-error unknown field in a composite
    prismaUniqueComposite(user, ["tenantId", "nope"])
    // @ts-expect-error excludeWhere must match the model's where type
    unique(z.email(), prismaUnique(user, "email"), { excludeWhere: { id: "1" } })

    expect(true).toBe(true)
  })

  it("createSchema infers the output from the descriptor, fields, pick/omit and mode", () => {
    type Equal<A, B> =
      (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false
    const yes = <T extends true>(): T => true as T

    const Create = createSchema(user, UserModel)
    yes<Equal<z.output<typeof Create>, { id?: number | undefined; email: string }>>()

    const Overridden = createSchema(user, UserModel, {
      fields: { email: z.email(), age: z.number().optional() },
      omit: ["id"],
    })
    yes<Equal<z.output<typeof Overridden>, { email: string; age?: number | undefined }>>()

    const Picked = createSchema(user, UserModel, { pick: ["email"] })
    yes<Equal<z.output<typeof Picked>, { email: string }>>()

    const Patch = createSchema(user, UserModel, { mode: "update" })
    yes<Equal<z.output<typeof Patch>, { id: number; email?: string | undefined }>>()

    // @ts-expect-error unknown field in omit
    createSchema(user, UserModel, { omit: ["emial"] })
    // @ts-expect-error unknown field in pick
    createSchema(user, UserModel, { pick: ["nope"] })
    // @ts-expect-error overrides must be Zod schemas
    createSchema(user, UserModel, { fields: { email: "string" } })
    // @ts-expect-error unknown mode
    createSchema(user, UserModel, { mode: "patch" })

    expect(typeof Create.toZodIssues).toBe("function")
  })
})
