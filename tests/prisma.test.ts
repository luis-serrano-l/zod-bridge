import { Prisma } from "@prisma/client"
import { describe, expect, it, vi } from "vitest"
import {
  PrismaForeignKeyError,
  PrismaNotFoundError,
  PrismaRelationViolationError,
  PrismaUniqueConstraintError,
  findOrThrow,
  handlePrismaError,
  prismaUnique,
  prismaUniqueComposite,
} from "../src/adapters/prisma/index.js"

function knownError(code: string, meta?: Record<string, unknown>) {
  return new Prisma.PrismaClientKnownRequestError("mock", {
    code,
    clientVersion: "0.0.0",
    meta,
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
    expect(err.message).toBe("No User found")
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
  return { findFirst: vi.fn(async (_args?: { where?: unknown }) => existing) }
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

  it("skips the query when a field is absent", async () => {
    const like = mockModel({ id: 9 })
    const check = prismaUniqueComposite(like, ["userId", "postId"])

    await expect(check({ userId: 1 })).resolves.toBe(true)
    expect(like.findFirst).not.toHaveBeenCalled()
  })
})
