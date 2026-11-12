import { describe, expect, it } from "vitest"
import { z } from "zod"
import { prismaUnique, prismaUniqueComposite } from "../src/adapters/prisma/index.js"
import { unique } from "../src/index.js"

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
})
