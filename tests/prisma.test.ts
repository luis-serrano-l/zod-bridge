import { Prisma } from "@prisma/client"
import { describe, expect, it, vi } from "vitest"
import { z } from "zod"
import {
  findOrThrow,
  handlePrismaError,
  PrismaBridgeError,
  PrismaForeignKeyError,
  PrismaNotFoundError,
  PrismaRelationViolationError,
  PrismaUniqueConstraintError,
  prismaUnique,
  prismaUniqueComposite,
  toZodIssues,
} from "../src/adapters/prisma/index.js"
import { unique, uniqueComposite } from "../src/core/index.js"

function knownError(code: string, meta?: Record<string, unknown>) {
  return new Prisma.PrismaClientKnownRequestError("mock", {
    code,
    clientVersion: "0.0.0",
    ...(meta === undefined ? {} : { meta }),
  })
}

describe("prisma adapter", () => {
  it("PrismaUniqueConstraintError instanceof check", () => {
    const err = new PrismaUniqueConstraintError(knownError("P2002", { target: ["email"] }))
    expect(err).toBeInstanceOf(PrismaUniqueConstraintError)
    expect(err).toBeInstanceOf(Error)
    expect(err.code).toBe("P2002")
    expect(err.fields).toEqual(["email"])
  })

  it("every typed error is a PrismaBridgeError; other errors are not", () => {
    for (const code of ["P2002", "P2025", "P2003", "P2014"]) {
      expect(() => handlePrismaError(knownError(code))).toThrow(PrismaBridgeError)
    }
    expect(() => handlePrismaError(knownError("P1001"))).not.toThrow(PrismaBridgeError)
  })

  it("typed errors keep the original Prisma error as cause", () => {
    const original = knownError("P2002", { target: ["email"] })
    try {
      handlePrismaError(original)
    } catch (err) {
      expect(err).toBeInstanceOf(PrismaUniqueConstraintError)
      expect((err as Error).cause).toBe(original)
    }
    expect(new PrismaNotFoundError(knownError("P2025")).cause).toBeInstanceOf(Error)
    expect(new PrismaForeignKeyError(knownError("P2003")).cause).toBeInstanceOf(Error)
    expect(new PrismaRelationViolationError(knownError("P2014")).cause).toBeInstanceOf(Error)
  })

  it("PrismaUniqueConstraintError reads driver-adapter constraint.fields (Prisma 7 ≤7.9)", () => {
    const err = new PrismaUniqueConstraintError(
      knownError("P2002", {
        driverAdapterError: { cause: { constraint: { fields: ['"userId"', '"postId"'] } } },
      }),
    )
    expect(err.fields).toEqual(["userId", "postId"])
  })

  it("PrismaUniqueConstraintError derives fields from constraint.index (Prisma 7.10+)", () => {
    const single = new PrismaUniqueConstraintError(
      knownError("P2002", {
        driverAdapterError: { cause: { constraint: { index: "User_email_key" }, table: "User" } },
      }),
    )
    expect(single.fields).toEqual(["email"])

    const composite = new PrismaUniqueConstraintError(
      knownError("P2002", {
        driverAdapterError: {
          cause: { constraint: { index: "Like_userId_postId_key" }, table: "Like" },
        },
      }),
    )
    expect(composite.fields).toEqual(["userId", "postId"])
  })

  it("PrismaNotFoundError instanceof check", () => {
    const err = new PrismaNotFoundError(knownError("P2025", { cause: "No User found" }))
    expect(err).toBeInstanceOf(PrismaNotFoundError)
    expect(err).toBeInstanceOf(Error)
    expect(err.code).toBe("P2025")
    expect(err.message).toMatch(/^No User found\. Fix: /)
  })

  it("every typed error message names the fix, even when meta is unreadable", () => {
    const errors = [
      new PrismaUniqueConstraintError(knownError("P2002", { target: ["email"] })),
      new PrismaUniqueConstraintError(knownError("P2002", {})),
      new PrismaNotFoundError(knownError("P2025", { cause: "Record to update not found." })),
      new PrismaNotFoundError(knownError("P2025", {})),
      new PrismaForeignKeyError(knownError("P2003", { field_name: "authorId" })),
      new PrismaForeignKeyError(knownError("P2003", {})),
      new PrismaRelationViolationError(knownError("P2014", { relation_name: "PostToUser" })),
      new PrismaRelationViolationError(knownError("P2014", {})),
    ]
    for (const err of errors) expect(err.message).toMatch(/\. Fix: \S/)
    expect(errors[0]?.message).toMatch(/^Unique constraint failed on: email\. Fix: /)
    expect(errors[1]?.message).toContain("inspect error.cause.meta")
    expect(errors[2]?.message).toMatch(/^Record to update not found\. Fix: /)
    expect(errors[5]?.message).toContain("inspect error.cause.meta")
  })

  it("PrismaForeignKeyError instanceof check", () => {
    const err = new PrismaForeignKeyError(knownError("P2003", { field_name: "authorId" }))
    expect(err).toBeInstanceOf(PrismaForeignKeyError)
    expect(err).toBeInstanceOf(Error)
    expect(err.code).toBe("P2003")
    expect(err.fieldName).toBe("authorId")
  })

  it("PrismaForeignKeyError derives fieldName from constraint.index (Prisma 7.10+)", () => {
    const err = new PrismaForeignKeyError(
      knownError("P2003", {
        driverAdapterError: { cause: { constraint: { index: "Post_authorId_fkey" } } },
      }),
    )
    expect(err.fieldName).toBe("authorId")
  })

  it("PrismaForeignKeyError strips the table prefix using cause.table", () => {
    const err = new PrismaForeignKeyError(
      knownError("P2003", {
        driverAdapterError: {
          cause: { table: "User_Profile", constraint: { index: "User_Profile_authorId_fkey" } },
        },
      }),
    )
    expect(err.fieldName).toBe("authorId")
  })

  it("PrismaRelationViolationError instanceof check", () => {
    const err = new PrismaRelationViolationError(knownError("P2014", { relation_name: "UserPost" }))
    expect(err).toBeInstanceOf(PrismaRelationViolationError)
    expect(err).toBeInstanceOf(Error)
    expect(err.code).toBe("P2014")
    expect(err.relationName).toBe("UserPost")
  })

  it("handlePrismaError maps single-field unique violation", () => {
    const raw = knownError("P2002", { target: "email" })
    expect(() => handlePrismaError(raw)).toThrow(PrismaUniqueConstraintError)
    try {
      handlePrismaError(raw)
    } catch (e) {
      expect(e).toBeInstanceOf(PrismaUniqueConstraintError)
      expect((e as PrismaUniqueConstraintError).fields).toEqual(["email"])
    }
  })

  it("handlePrismaError maps composite unique violation", () => {
    const raw = knownError("P2002", { target: ["userId", "postId"] })
    try {
      handlePrismaError(raw)
    } catch (e) {
      expect(e).toBeInstanceOf(PrismaUniqueConstraintError)
      expect((e as PrismaUniqueConstraintError).fields).toEqual(["userId", "postId"])
    }
  })

  it("findOrThrow throws on null result", async () => {
    await expect(findOrThrow(() => Promise.resolve(null))).rejects.toThrow(PrismaNotFoundError)
  })
})

function mockModel(existing: unknown = null) {
  return { findFirst: vi.fn(async (_args?: { where?: Record<string, unknown> }) => existing) }
}

describe("prismaUnique", () => {
  it("scalar mode: queries the field, reports at the root", async () => {
    const user = mockModel()
    const check = prismaUnique(user, "email")
    await expect(check("a@b.c")).resolves.toBe(true)
    expect(user.findFirst).toHaveBeenCalledWith({ where: { email: "a@b.c" } })
    expect(check.path).toEqual(["email"])
  })

  it("scalar mode: returns false when a row exists", async () => {
    const check = prismaUnique(mockModel({ id: 1 }), "email")
    await expect(check("a@b.c")).resolves.toBe(false)
  })

  it("scalar mode: a Date or array is the field value, not an object holding it", async () => {
    const event = mockModel()
    const at = new Date(2030, 0, 1)
    await prismaUnique(event, "startsAt")(at)
    expect(event.findFirst).toHaveBeenCalledWith({ where: { startsAt: at } })

    const post = mockModel()
    await prismaUnique(post, "tags")(["a", "b"])
    expect(post.findFirst).toHaveBeenCalledWith({ where: { tags: ["a", "b"] } })
  })

  it("object mode without primary key: plain check", async () => {
    const user = mockModel()
    await prismaUnique(user, "email")({ email: "a@b.c" })
    expect(user.findFirst).toHaveBeenCalledWith({ where: { email: "a@b.c" } })
  })

  it("object mode with id: excludes that record", async () => {
    const user = mockModel()
    await prismaUnique(user, "email")({ id: 7, email: "a@b.c" })
    expect(user.findFirst).toHaveBeenCalledWith({
      where: { email: "a@b.c", NOT: { id: 7 } },
    })
  })

  it("object mode: custom primaryKey", async () => {
    const user = mockModel()
    await prismaUnique(user, "email", { primaryKey: "uuid" })({ uuid: "x", id: 1, email: "a@b.c" })
    expect(user.findFirst).toHaveBeenCalledWith({
      where: { email: "a@b.c", NOT: { uuid: "x" } },
    })
  })

  it("object mode: composite primaryKey needs every field", async () => {
    const user = mockModel()
    const check = prismaUnique(user, "email", { primaryKey: ["tenantId", "slug"] })

    await check({ tenantId: 1, slug: "s", email: "a@b.c" })
    expect(user.findFirst).toHaveBeenLastCalledWith({
      where: { email: "a@b.c", NOT: { tenantId: 1, slug: "s" } },
    })

    await check({ tenantId: 1, email: "a@b.c" })
    expect(user.findFirst).toHaveBeenLastCalledWith({ where: { email: "a@b.c" } })
  })

  it("object mode: explicit excludeWhere wins over the implicit one", async () => {
    const user = mockModel()
    await prismaUnique(user, "email")({ id: 7, email: "a@b.c" }, { excludeWhere: { id: 9 } })
    expect(user.findFirst).toHaveBeenCalledWith({
      where: { email: "a@b.c", NOT: { id: 9 } },
    })
  })

  it("object mode: skips the query when the field is absent", async () => {
    const user = mockModel({ id: 1 })
    await expect(prismaUnique(user, "email")({ id: 7 })).resolves.toBe(true)
    expect(user.findFirst).not.toHaveBeenCalled()
  })

  it("skips null and filter-shaped values instead of querying with them", async () => {
    const user = mockModel({ id: 1 })
    const check = prismaUnique(user, "email")

    await expect(check({ email: null })).resolves.toBe(true)
    await expect(check({ email: { startsWith: "a" } })).resolves.toBe(true)
    expect(user.findFirst).not.toHaveBeenCalled()

    // non-plain objects are real values
    const at = new Date(0)
    await check({ email: at })
    expect(user.findFirst).toHaveBeenCalledWith({ where: { email: at } })
  })
})

describe("prismaUniqueComposite", () => {
  it("queries all fields, excludes by primary key when present", async () => {
    const like = mockModel()
    const check = prismaUniqueComposite(like, ["userId", "postId"])

    await check({ userId: 1, postId: 2 })
    expect(like.findFirst).toHaveBeenLastCalledWith({ where: { userId: 1, postId: 2 } })

    await check({ id: 5, userId: 1, postId: 2 })
    expect(like.findFirst).toHaveBeenLastCalledWith({
      where: { userId: 1, postId: 2, NOT: { id: 5 } },
    })
    expect(check.path).toBeUndefined()
  })

  it("skips the query when a field is absent, null or filter-shaped", async () => {
    const like = mockModel({ id: 9 })
    const check = prismaUniqueComposite(like, ["userId", "postId"])

    await expect(check({ userId: 1 })).resolves.toBe(true)
    await expect(check({ userId: 1, postId: null })).resolves.toBe(true)
    await expect(check({ userId: 1, postId: { gt: 0 } })).resolves.toBe(true)
    expect(like.findFirst).not.toHaveBeenCalled()
  })
})

describe("toZodIssues", () => {
  const p2002 = (meta: Record<string, unknown>) =>
    new PrismaUniqueConstraintError(knownError("P2002", meta))

  it("single field: same issue as unique() + prismaUnique, object and field form", async () => {
    const check = prismaUnique(mockModel({ id: 1 }), "email")
    const objectForm = unique(z.object({ email: z.email() }), check, "Email taken")
    const fieldForm = z.object({ email: unique(z.email(), check, "Email taken") })
    const fromDb = toZodIssues(p2002({ target: ["email"] }), "Email taken")

    expect(fromDb).toEqual([{ code: "custom", message: "Email taken", path: ["email"] }])
    expect((await objectForm.safeParseAsync({ email: "a@b.co" })).error?.issues).toEqual(fromDb)
    expect((await fieldForm.safeParseAsync({ email: "a@b.co" })).error?.issues).toEqual(fromDb)
  })

  it("default message matches unique()'s default", async () => {
    const schema = unique(z.object({ email: z.email() }), prismaUnique(mockModel({}), "email"))
    const refine = (await schema.safeParseAsync({ email: "a@b.co" })).error?.issues
    expect(toZodIssues(p2002({ target: "email" }))).toEqual(refine)
    expect(refine?.[0]?.message).toBe("Value already taken")
  })

  it("composite: reports at the root like uniqueComposite(), path overrides", async () => {
    const shape = z.object({ userId: z.number(), postId: z.number() })
    const check = prismaUniqueComposite(mockModel({}), ["userId", "postId"])
    const err = p2002({ target: ["userId", "postId"] })
    const input = { userId: 1, postId: 2 }

    const atRoot = await uniqueComposite(shape, check, "Already liked").safeParseAsync(input)
    expect(toZodIssues(err, "Already liked")).toEqual(atRoot.error?.issues)
    expect(toZodIssues(err, "Already liked")?.[0]?.path).toEqual([])

    const options = { message: "Already liked", path: ["postId"] }
    const atField = await uniqueComposite(shape, check, options).safeParseAsync(input)
    expect(toZodIssues(err, options)).toEqual(atField.error?.issues)
    expect(toZodIssues(err, options)?.[0]?.path).toEqual(["postId"])
  })

  it("unreadable fields: one issue at the root", () => {
    expect(toZodIssues(p2002({}))).toEqual([
      { code: "custom", message: "Value already taken", path: [] },
    ])
  })

  it("does not alias the caller's path array", () => {
    const path = ["user", "email"]
    const issues = toZodIssues(p2002({ target: ["email"] }), { path })
    expect(issues?.[0]?.path).toEqual(path)
    expect(issues?.[0]?.path).not.toBe(path)
  })

  it("ZodError: returns a copy of its issues", async () => {
    const result = await z.object({ email: z.email() }).safeParseAsync({ email: "bad" })
    const issues = toZodIssues(result.error, "ignored")
    expect(issues).toEqual(result.error?.issues)
    expect(issues).not.toBe(result.error?.issues)
  })

  it("raw P2002 (write skipped handlePrismaError): converted like the typed error", () => {
    const raw = knownError("P2002", { target: ["email"] })
    expect(toZodIssues(raw, "Email taken")).toEqual(
      toZodIssues(new PrismaUniqueConstraintError(raw), "Email taken"),
    )
    expect(toZodIssues(knownError("P2025"))).toBeUndefined()
  })

  it("fields guard: converts only the named constraint, in any order", () => {
    const email = p2002({ target: ["email"] })
    const like = p2002({ target: ["userId", "postId"] })

    expect(toZodIssues(email, { fields: ["email"], message: "Email taken" })).toEqual([
      { code: "custom", message: "Email taken", path: ["email"] },
    ])
    expect(toZodIssues(email, { fields: ["username"] })).toBeUndefined()
    expect(toZodIssues(email, { fields: ["email", "tenantId"] })).toBeUndefined()
    expect(toZodIssues(like, { fields: ["postId", "userId"] })).toHaveLength(1)
    expect(toZodIssues(like, { fields: ["postId"] })).toBeUndefined()
    // Unreadable meta cannot be matched: not converted, the caller rethrows.
    expect(toZodIssues(p2002({}), { fields: ["email"] })).toBeUndefined()
  })

  it("fields guard: chained calls give each constraint its own message", () => {
    const convert = (e: unknown) =>
      toZodIssues(e, { fields: ["email"], message: "Email taken" }) ??
      toZodIssues(e, { fields: ["username"], message: "Username taken" })

    expect(convert(p2002({ target: ["username"] }))).toEqual([
      { code: "custom", message: "Username taken", path: ["username"] },
    ])
    expect(convert(p2002({ target: ["slug"] }))).toBeUndefined()
  })

  it("fields guard: matches a column whose name was split on _ (Prisma 7.10+)", () => {
    const err = p2002({
      driverAdapterError: { cause: { constraint: { index: "User_user_name_key" }, table: "User" } },
    })
    expect(err.fields).toEqual(["user", "name"])
    // Unguarded, the split name looks composite: root path. The guard knows the real name.
    expect(toZodIssues(err, "Taken")?.[0]?.path).toEqual([])
    expect(toZodIssues(err, { fields: ["user_name"], message: "Taken" })).toEqual([
      { code: "custom", message: "Taken", path: ["user_name"] },
    ])
    expect(toZodIssues(err, { fields: ["user"] })).toBeUndefined()
  })

  it("fields guard: default path comes from the caller's fields, path still overrides", () => {
    const like = p2002({ target: ["userId", "postId"] })
    expect(toZodIssues(like, { fields: ["postId", "userId"] })?.[0]?.path).toEqual([])
    expect(
      toZodIssues(like, { fields: ["postId", "userId"], path: ["postId"] })?.[0]?.path,
    ).toEqual(["postId"])
    // @map: match on the column name, report at the Zod key
    const mapped = p2002({ target: ["email_address"] })
    expect(toZodIssues(mapped, { fields: ["email_address"], path: ["email"] })?.[0]?.path).toEqual([
      "email",
    ])
  })

  it("fields guard: an empty list matches nothing", () => {
    expect(toZodIssues(p2002({ target: ["email"] }), { fields: [] })).toBeUndefined()
  })

  it("handlePrismaError and toZodIssues agree on what a raw error is", () => {
    for (const code of ["P2002", "P2025", "P2003", "P2014", "P1001"]) {
      const raw = knownError(code, { target: ["email"] })
      let typed: unknown
      try {
        handlePrismaError(raw)
      } catch (e) {
        typed = e
      }
      expect(toZodIssues(raw)).toEqual(toZodIssues(typed))
    }
  })

  it("fields guard does not filter a ZodError", async () => {
    const result = await z.object({ name: z.string() }).safeParseAsync({})
    expect(toZodIssues(result.error, { fields: ["email"] })).toEqual(result.error?.issues)
  })

  it("anything else: undefined, so the caller rethrows", () => {
    expect(toZodIssues(new PrismaNotFoundError(knownError("P2025")))).toBeUndefined()
    expect(toZodIssues(new PrismaForeignKeyError(knownError("P2003")))).toBeUndefined()
    expect(toZodIssues(new PrismaRelationViolationError(knownError("P2014")))).toBeUndefined()
    expect(toZodIssues(new Error("boom"))).toBeUndefined()
    expect(toZodIssues(undefined)).toBeUndefined()
  })
})
