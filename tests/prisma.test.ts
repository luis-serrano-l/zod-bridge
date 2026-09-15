import { Prisma } from "@prisma/client"
import { describe, expect, it } from "vitest"
import {
  PrismaForeignKeyError,
  PrismaNotFoundError,
  PrismaRelationViolationError,
  PrismaUniqueConstraintError,
  findOrThrow,
  handlePrismaError,
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
