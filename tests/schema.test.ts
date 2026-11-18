import { Prisma } from "@prisma/client"
import { describe, expect, it, vi } from "vitest"
import { z } from "zod"
import {
  createSchema,
  defineModel,
  handlePrismaError,
  prismaUnique,
} from "../src/adapters/prisma/index.js"
import { unique } from "../src/core/index.js"
import { LikeModel, UserModel } from "./generated/zod-bridge.js"

function p2002(target: string[]) {
  return new Prisma.PrismaClientKnownRequestError("mock", {
    code: "P2002",
    clientVersion: "0.0.0",
    meta: { target },
  })
}

type Row = Record<string, unknown>

/** A delegate whose `findFirst` answers from `rows` (equality on every `where` key, `NOT` excluded). */
function delegate(name: string, rows: Row[] = []) {
  const findFirst = vi.fn(async (args?: { where?: Row }) => {
    const { NOT, ...where } = args?.where ?? {}
    const matches = (row: Row, filter: Row) =>
      Object.entries(filter).every(([k, v]) => row[k] === v)
    return rows.find((row) => matches(row, where) && !(NOT && matches(row, NOT as Row))) ?? null
  })
  return { $name: name, findFirst }
}

const AccountModel = defineModel({
  name: "Account",
  shape: {
    uuid: z.string(),
    email: z.string(),
    handle: z.string(),
    role: z.string().optional(),
    tenantId: z.int(),
    slug: z.string(),
  },
  primaryKey: ["uuid"],
  unique: [["email"], ["handle"], ["tenantId", "slug"]],
  columns: { email: "email_address" },
})

describe("createSchema", () => {
  it("parses the generated create shape and strips unknown keys", async () => {
    const User = createSchema(delegate("User"), UserModel)
    await expect(User.parseAsync({ email: "a@b.com", admin: true })).resolves.toEqual({
      email: "a@b.com",
    })
    await expect(User.parseAsync({ id: "1", email: "a@b.com" })).rejects.toMatchObject({
      issues: [{ path: ["id"] }],
    })
  })

  it("requires parseAsync", () => {
    const User = createSchema(delegate("User"), UserModel)
    expect(() => User.parse({ email: "a@b.com" })).toThrow()
  })

  it("fields override and add to the generated shape", async () => {
    const User = createSchema(delegate("User"), UserModel, {
      fields: { email: z.email(), password: z.string().min(8) },
    })
    const result = await User.safeParseAsync({ email: "nope", password: "short" })
    expect(result.error?.issues.map((issue) => issue.path)).toEqual([["email"], ["password"]])
  })

  it("pick and omit select columns", async () => {
    const model = delegate("Account")
    const Picked = createSchema(model, AccountModel, { pick: ["email", "handle"] })
    expect(Object.keys(Picked.shape)).toEqual(["email", "handle"])
    const Omitted = createSchema(model, AccountModel, { omit: ["role", "tenantId", "slug"] })
    expect(Object.keys(Omitted.shape)).toEqual(["uuid", "email", "handle"])
  })

  it("wires a uniqueness check for every unique constraint, with defaults equal to unique()", async () => {
    const model = delegate("User", [{ id: 1, email: "taken@b.com" }])
    const User = createSchema(model, UserModel)
    const byHand = unique(z.object({ email: z.string() }), prismaUnique(model, "email"))

    const result = await User.safeParseAsync({ email: "taken@b.com" })
    expect(result.error?.issues).toEqual([
      { code: "custom", message: "Value already taken", path: ["email"] },
    ])
    expect(result.error?.issues).toEqual(
      (await byHand.safeParseAsync({ email: "taken@b.com" })).error?.issues,
    )
    await expect(User.parseAsync({ email: "free@b.com" })).resolves.toEqual({ email: "free@b.com" })
  })

  it("does not query for a value that already failed validation", async () => {
    const model = delegate("User")
    const User = createSchema(model, UserModel, { fields: { email: z.email() } })
    await User.safeParseAsync({ email: "not-an-email" })
    expect(model.findFirst).not.toHaveBeenCalled()
  })

  it("unique rules set message and path per constraint, single and composite", async () => {
    const model = delegate("Account", [
      { uuid: "u1", email: "a@b.com", handle: "ada", tenantId: 1, slug: "home" },
    ])
    const Account = createSchema(model, AccountModel, {
      unique: [
        { fields: ["email"], message: "Email taken" },
        { fields: ["slug", "tenantId"], message: "Slug taken", path: ["slug"] },
      ],
    })
    const result = await Account.safeParseAsync({
      uuid: "u2",
      email: "a@b.com",
      handle: "ada",
      tenantId: 1,
      slug: "home",
    })
    expect(result.error?.issues).toEqual([
      { code: "custom", message: "Email taken", path: ["email"] },
      { code: "custom", message: "Value already taken", path: ["handle"] },
      { code: "custom", message: "Slug taken", path: ["slug"] },
    ])
  })

  it("excludes the record being edited through the model's real primary key", async () => {
    const model = delegate("Account", [
      { uuid: "u1", email: "a@b.com", handle: "ada", tenantId: 1, slug: "home" },
    ])
    const Account = createSchema(model, AccountModel)
    const own = { uuid: "u1", email: "a@b.com", handle: "ada", tenantId: 1, slug: "home" }
    await expect(Account.parseAsync(own)).resolves.toEqual(own)
    expect(model.findFirst).toHaveBeenCalledWith({
      where: { email: "a@b.com", NOT: { uuid: "u1" } },
    })
    await expect(Account.parseAsync({ ...own, uuid: "u2" })).rejects.toMatchObject({
      issues: [{ path: ["email"] }, { path: ["handle"] }, { path: [] }],
    })
  })

  it('mode "update": primary key required, the rest optional, absent fields not checked', async () => {
    const model = delegate("User", [
      { id: 1, email: "one@b.com" },
      { id: 2, email: "two@b.com" },
    ])
    const Patch = createSchema(model, UserModel, { mode: "update" })

    await expect(Patch.parseAsync({ id: 1 })).resolves.toEqual({ id: 1 })
    expect(model.findFirst).not.toHaveBeenCalled()
    await expect(Patch.parseAsync({ id: 1, email: "one@b.com" })).resolves.toEqual({
      id: 1,
      email: "one@b.com",
    })
    await expect(Patch.parseAsync({ id: 1, email: "two@b.com" })).rejects.toMatchObject({
      issues: [{ message: "Value already taken", path: ["email"] }],
    })
    await expect(Patch.parseAsync({ email: "new@b.com" })).rejects.toMatchObject({
      issues: [{ path: ["id"] }],
    })
  })

  it("leaves out the check of a constraint whose fields the schema does not hold", async () => {
    const model = delegate("Account", [{ uuid: "u1", email: "a@b.com", handle: "ada" }])
    const Account = createSchema(model, AccountModel, { pick: ["email"] })
    await expect(Account.parseAsync({ email: "new@b.com" })).resolves.toEqual({
      email: "new@b.com",
    })
    expect(model.findFirst).toHaveBeenCalledTimes(1)
  })

  it("throws at build time on a delegate / descriptor mismatch, naming the fix", () => {
    expect(() => createSchema(delegate("Post"), UserModel)).toThrow(
      /"Post" delegate with the "User" descriptor\. Fix:/,
    )
  })

  it("throws at build time on a unique rule that matches no constraint of the schema", () => {
    const model = delegate("Account")
    expect(() =>
      createSchema(model, AccountModel, { unique: [{ fields: ["emial"], message: "x" }] }),
    ).toThrow(/no unique constraint on \[emial\].*Fix:/)
    expect(() =>
      createSchema(model, AccountModel, { omit: ["email"], unique: [{ fields: ["email"] }] }),
    ).toThrow(/no unique constraint on \[email\]/)
  })
})

describe("createSchema().toZodIssues — the race window reports what the pre-check reports", () => {
  const taken = { uuid: "u1", email: "a@b.com", handle: "ada", tenantId: 1, slug: "home" }
  const options = {
    unique: [
      { fields: ["email"], message: "Email taken" },
      { fields: ["tenantId", "slug"], message: "Slug taken", path: ["slug"] },
    ],
  } as const

  it("returns the issues of a ZodError", async () => {
    const Account = createSchema(delegate("Account", [taken]), AccountModel, options)
    const error = await Account.parseAsync({ ...taken, uuid: "u2" }).catch((e: unknown) => e)
    expect(Account.toZodIssues(error)).toEqual((error as z.ZodError).issues)
  })

  it("converts a typed or raw unique conflict to the pre-check issue of that constraint", async () => {
    const Account = createSchema(delegate("Account", [taken]), AccountModel, options)
    const refine = await Account.safeParseAsync({ ...taken, uuid: "u2" })
    const [email, handle, slug] = refine.error?.issues ?? []

    // `email` is @map("email_address"): the database names the column, the issue names the field
    const raw = p2002(["email_address"])
    expect(Account.toZodIssues(raw)).toEqual([email])
    let typed: unknown
    try {
      handlePrismaError(raw)
    } catch (e) {
      typed = e
    }
    expect(Account.toZodIssues(typed)).toEqual([email])
    expect(Account.toZodIssues(p2002(["handle"]))).toEqual([handle])
    expect(Account.toZodIssues(p2002(["slug", "tenantId"]))).toEqual([slug])
  })

  it("returns undefined for a constraint the schema does not validate, and for other errors", () => {
    const Account = createSchema(delegate("Account"), AccountModel, { omit: ["handle"] })
    expect(Account.toZodIssues(p2002(["handle"]))).toBeUndefined()
    expect(Account.toZodIssues(p2002([]))).toBeUndefined()
    expect(Account.toZodIssues(new Error("boom"))).toBeUndefined()
    expect(
      Account.toZodIssues(
        new Prisma.PrismaClientKnownRequestError("mock", { code: "P2025", clientVersion: "0" }),
      ),
    ).toBeUndefined()
  })

  it("a schema without unique constraints still passes a ZodError through", async () => {
    const NoUnique = createSchema(delegate("Account"), AccountModel, { pick: ["role"] })
    const error = await NoUnique.parseAsync({ role: 1 }).catch((e: unknown) => e)
    expect(NoUnique.toZodIssues(error)).toEqual((error as z.ZodError).issues)
    expect(NoUnique.toZodIssues(p2002(["email_address"]))).toBeUndefined()
  })

  it("composite constraint of a model without primary key reports at the root", async () => {
    const model = delegate("Like", [{ userId: 1, postId: 2 }])
    const Like = createSchema(model, LikeModel)
    const refine = await Like.safeParseAsync({ userId: 1, postId: 2 })
    expect(refine.error?.issues).toEqual([
      { code: "custom", message: "Value already taken", path: [] },
    ])
    expect(Like.toZodIssues(p2002(["userId", "postId"]))).toEqual(refine.error?.issues)
  })
})
