import { z } from "zod"
import { describe, expect, it, vi } from "vitest"
import { unique, uniqueComposite } from "../src/core/index.js"

describe("core", () => {
  it("unique() validates via async lookup", async () => {
    const check = vi.fn(async (val: string) => val !== "taken")
    const schema = unique(z.string(), check, "Already taken")

    await expect(schema.parseAsync("available")).resolves.toBe("available")
    await expect(schema.parseAsync("taken")).rejects.toMatchObject({
      issues: [{ message: "Already taken" }],
    })
    expect(check).toHaveBeenCalledTimes(2)
  })

  it("unique() passes excludeWhere to check fn", async () => {
    const check = vi.fn(async (_val: string, opts?: { excludeWhere?: unknown }) => {
      // simulate: "taken" is only taken if we're NOT excluding { id: 1 }
      return opts?.excludeWhere !== undefined
    })
    const schema = unique(z.string(), check, {
      message: "Already taken",
      excludeWhere: { id: 1 },
    })

    await expect(schema.parseAsync("taken")).resolves.toBe("taken")
    expect(check).toHaveBeenCalledWith("taken", { excludeWhere: { id: 1 } })
  })

  it("uniqueComposite() validates composite keys", async () => {
    const check = vi.fn(async (val: { userId: number; postId: number }) => {
      return !(val.userId === 1 && val.postId === 2)
    })
    const schema = uniqueComposite(
      z.object({ userId: z.number(), postId: z.number() }),
      check,
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

  it("unique() reports the issue at the check fn's path hint", async () => {
    const check = Object.assign(
      vi.fn(async (_val: { id?: number; email: string }) => false),
      { path: ["email"] },
    )
    const schema = unique(z.object({ id: z.number().optional(), email: z.string() }), check, "Taken")

    const result = await schema.safeParseAsync({ email: "a@b.c" })
    expect(result.success).toBe(false)
    expect(result.error?.issues).toEqual([
      expect.objectContaining({ code: "custom", message: "Taken", path: ["email"] }),
    ])
  })

  it("unique() skips the check when the value already failed validation", async () => {
    const check = vi.fn(async () => true)

    const result = await unique(z.email(), check).safeParseAsync("not-an-email")
    expect(result.success).toBe(false)
    expect(check).not.toHaveBeenCalled()
  })

  it("unique() with a path hint skips only when that field is invalid", async () => {
    const check = Object.assign(
      vi.fn(async (_val: { name: string; email: string }) => false),
      { path: ["email"] },
    )
    const schema = unique(z.object({ name: z.string().min(3), email: z.email() }), check, "Taken")

    await schema.safeParseAsync({ name: "abc", email: "bad" })
    expect(check).not.toHaveBeenCalled()

    // An unrelated field failing still reports the conflict in the same pass.
    const result = await schema.safeParseAsync({ name: "a", email: "a@b.co" })
    expect(check).toHaveBeenCalledTimes(1)
    expect(result.error?.issues.map((i) => i.path)).toEqual([["name"], ["email"]])
  })
})
