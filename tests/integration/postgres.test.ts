import { PrismaPg } from "@prisma/adapter-pg"
import { PrismaClient } from "@prisma/client"
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"
import { ZodError, z } from "zod"
import {
  findOrThrow,
  handlePrismaError,
  PrismaForeignKeyError,
  PrismaNotFoundError,
  PrismaUniqueConstraintError,
  prismaUnique,
  prismaUniqueComposite,
  toZodIssues,
} from "../../src/adapters/prisma/index.js"
import { unique, uniqueComposite } from "../../src/core/index.js"

let prisma: PrismaClient

beforeAll(async () => {
  const url = process.env["DATABASE_URL"]!
  prisma = new PrismaClient({ adapter: new PrismaPg(url) })
  await prisma.$connect()
})

afterAll(async () => {
  await prisma.$disconnect()
})

beforeEach(async () => {
  await prisma.$executeRawUnsafe(`TRUNCATE "User", "Post", "Like" RESTART IDENTITY CASCADE`)
})

describe("P2002 — single field unique (real Postgres meta shape)", () => {
  it('fields is ["email"] on Postgres', async () => {
    await prisma.user.create({ data: { email: "a@b.com" } })

    let caught: unknown
    try {
      await prisma.user.create({ data: { email: "a@b.com" } })
    } catch (e) {
      caught = e
    }

    expect(() => handlePrismaError(caught)).toThrow(PrismaUniqueConstraintError)

    try {
      handlePrismaError(caught)
    } catch (e) {
      expect(e).toBeInstanceOf(PrismaUniqueConstraintError)
      expect((e as PrismaUniqueConstraintError).fields).toEqual(["email"])
    }
  })
})

describe("race condition — unique() + handlePrismaError safety net", () => {
  it("both pass pre-check, one fails at insert, handlePrismaError catches it", async () => {
    const email = "race@test.com"

    async function parseAndCreate(e: string) {
      const schema = unique(
        z.string().email(),
        async (val) => {
          const existing = await prisma.user.findFirst({ where: { email: val } })
          return existing === null
        },
        "Email already taken",
      )
      const validated = await schema.parseAsync(e)
      try {
        return await prisma.user.create({ data: { email: validated } })
      } catch (err) {
        handlePrismaError(err)
      }
    }

    const results = await Promise.allSettled([parseAndCreate(email), parseAndCreate(email)])

    const fulfilled = results.filter((r) => r.status === "fulfilled")
    const rejected = results.filter((r) => r.status === "rejected")

    // At least one must succeed
    expect(fulfilled.length).toBeGreaterThanOrEqual(1)

    // Rejections are either ZodError (unique() caught it early — best-effort UX)
    // or PrismaUniqueConstraintError (slip-through caught by handlePrismaError)
    for (const r of rejected) {
      const reason = (r as PromiseRejectedResult).reason
      const isExpected = reason instanceof ZodError || reason instanceof PrismaUniqueConstraintError
      expect(isExpected).toBe(true)
    }

    // Exactly one user row in the DB regardless of which path "won"
    const count = await prisma.user.count({ where: { email } })
    expect(count).toBe(1)
  })
})

describe("toZodIssues — one error shape for the refine and the race window", () => {
  it("single field: lost race and pre-check produce equal issues", async () => {
    const Signup = z.object({
      email: unique(z.email(), prismaUnique(prisma.user, "email"), "Email taken"),
    })

    async function signup(input: unknown, raceWinner?: () => Promise<unknown>) {
      try {
        const data = await Signup.parseAsync(input)
        await raceWinner?.() // a concurrent request commits between the check and the write
        await prisma.user.create({ data }).catch(handlePrismaError)
        return undefined
      } catch (e) {
        const issues = toZodIssues(e, "Email taken") // the one error branch
        if (issues) return { issues, layer: e instanceof ZodError ? "zod" : "prisma" }
        throw e
      }
    }

    const input = { email: "race@test.com" }
    const lostRace = await signup(input, () => prisma.user.create({ data: input }))
    const preCheck = await signup(input)

    expect(lostRace?.layer).toBe("prisma")
    expect(preCheck?.layer).toBe("zod")
    expect(lostRace?.issues).toEqual(preCheck?.issues)
    expect(preCheck?.issues).toEqual([{ code: "custom", message: "Email taken", path: ["email"] }])
    expect(await prisma.user.count()).toBe(1)
  })

  it("composite: equal issues at the root and at an explicit path", async () => {
    const data = { userId: 1, postId: 2 }
    await prisma.like.create({ data })

    const shape = z.object({ userId: z.number(), postId: z.number() })
    const check = prismaUniqueComposite(prisma.like, ["userId", "postId"])
    let caught: unknown
    await prisma.like
      .create({ data })
      .catch(handlePrismaError)
      .catch((e: unknown) => {
        caught = e
      })
    expect(caught).toBeInstanceOf(PrismaUniqueConstraintError)

    for (const options of ["Already liked", { message: "Already liked", path: ["postId"] }]) {
      const refine = await uniqueComposite(shape, check, options).safeParseAsync(data)
      expect(refine.success).toBe(false)
      expect(toZodIssues(caught, options)).toEqual(refine.error?.issues)
    }
  })
})

describe("prismaUnique — implicit self-exclusion on update", () => {
  it("own record passes, another user's email fails, no id fails", async () => {
    const alice = await prisma.user.create({ data: { email: "alice@test.com" } })
    const bob = await prisma.user.create({ data: { email: "bob@test.com" } })

    const UserSchema = unique(
      z.object({ id: z.number().optional(), email: z.email() }),
      prismaUnique(prisma.user, "email"),
      "Email already taken",
    )

    await expect(UserSchema.parseAsync({ id: alice.id, email: alice.email })).resolves.toEqual({
      id: alice.id,
      email: alice.email,
    })
    await expect(UserSchema.parseAsync({ email: alice.email })).rejects.toMatchObject({
      issues: [{ message: "Email already taken", path: ["email"] }],
    })
    await expect(UserSchema.parseAsync({ id: bob.id, email: alice.email })).rejects.toMatchObject({
      issues: [{ path: ["email"] }],
    })
  })
})

describe("prismaUnique — field-level use inside z.object", () => {
  it("reports at [field] and skips the query for an invalid value", async () => {
    await prisma.user.create({ data: { email: "a@b.com" } })
    const schema = z.object({
      email: unique(z.email(), prismaUnique(prisma.user, "email"), "Email taken"),
    })

    const taken = await schema.safeParseAsync({ email: "a@b.com" })
    expect(taken.error?.issues).toEqual([
      { code: "custom", message: "Email taken", path: ["email"] },
    ])

    const invalid = await schema.safeParseAsync({ email: "not-an-email" })
    expect(invalid.error?.issues.map((i) => i.code)).toEqual(["invalid_format"])

    await expect(schema.parseAsync({ email: "free@b.com" })).resolves.toEqual({
      email: "free@b.com",
    })
  })
})

describe("P2002 — composite unique (uniqueComposite)", () => {
  it("fields holds both columns", async () => {
    await prisma.like.create({ data: { userId: 1, postId: 2 } })

    let caught: unknown
    try {
      await prisma.like.create({ data: { userId: 1, postId: 2 } })
    } catch (e) {
      caught = e
    }

    expect(() => handlePrismaError(caught)).toThrow(PrismaUniqueConstraintError)

    try {
      handlePrismaError(caught)
    } catch (e) {
      expect(e).toBeInstanceOf(PrismaUniqueConstraintError)
      expect((e as PrismaUniqueConstraintError).fields).toEqual(["userId", "postId"])
    }
  })

  it("uniqueComposite() pre-check works end-to-end", async () => {
    await prisma.like.create({ data: { userId: 1, postId: 2 } })

    const schema = uniqueComposite(
      z.object({ userId: z.number(), postId: z.number() }),
      async (val) => {
        const existing = await prisma.like.findFirst({
          where: { userId: val.userId, postId: val.postId },
        })
        return existing === null
      },
      "Already liked this post",
    )

    await expect(schema.parseAsync({ userId: 1, postId: 3 })).resolves.toEqual({
      userId: 1,
      postId: 3,
    })
    await expect(schema.parseAsync({ userId: 1, postId: 2 })).rejects.toMatchObject({
      issues: [{ message: "Already liked this post" }],
    })
  })
})

describe("P2003 — foreign key", () => {
  it("handlePrismaError → PrismaForeignKeyError", async () => {
    let caught: unknown
    try {
      await prisma.post.create({ data: { authorId: 9999 } })
    } catch (e) {
      caught = e
    }

    expect(() => handlePrismaError(caught)).toThrow(PrismaForeignKeyError)

    try {
      handlePrismaError(caught)
    } catch (e) {
      expect(e).toBeInstanceOf(PrismaForeignKeyError)
      expect(e).toBeInstanceOf(Error)
    }
  })
})

describe("P2025 — not found", () => {
  it("handlePrismaError → PrismaNotFoundError on update", async () => {
    let caught: unknown
    try {
      await prisma.user.update({ where: { id: 9999 }, data: { email: "x@x.com" } })
    } catch (e) {
      caught = e
    }

    expect(() => handlePrismaError(caught)).toThrow(PrismaNotFoundError)
  })

  it("findOrThrow → PrismaNotFoundError on missing record", async () => {
    await expect(
      findOrThrow(() => prisma.user.findUnique({ where: { id: 9999 } })),
    ).rejects.toBeInstanceOf(PrismaNotFoundError)
  })
})
