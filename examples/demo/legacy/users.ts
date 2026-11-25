// What a route looks like without zod-bridge. Never run: section 9 of main.ts points
// `npx zod-bridge doctor legacy` at it.
import type { PrismaClient } from "@prisma/client"

type Reply = { readonly status: number; readonly body: unknown }

export async function createUser(prisma: PrismaClient, email: string): Promise<Reply> {
  try {
    return { status: 201, body: await prisma.user.create({ data: { email } }) }
  } catch (e) {
    const err = e as { code?: string; meta?: { target?: string[] } }
    if (err.code === "P2002") {
      return { status: 409, body: { fields: err.meta?.target ?? [] } }
    }
    if (err.code === "P2025") return { status: 404, body: null }
    throw e
  }
}
