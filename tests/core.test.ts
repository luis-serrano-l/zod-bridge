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
})
