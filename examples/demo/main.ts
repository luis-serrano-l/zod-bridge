import { PrismaPg } from "@prisma/adapter-pg"
import { PrismaClient } from "@prisma/client"
import { z } from "zod"
import { unique, uniqueComposite } from "zod-bridge"
import {
  findOrThrow,
  handlePrismaError,
  PrismaForeignKeyError,
  PrismaNotFoundError,
  PrismaUniqueConstraintError,
  prismaUnique,
  prismaUniqueComposite,
} from "zod-bridge/prisma"

// --- tiny ANSI helpers (no deps) ---------------------------------------------
const bold = (s: string): string => `\x1b[1m${s}\x1b[0m`
const dim = (s: string): string => `\x1b[2m${s}\x1b[0m`
const green = (s: string): string => `\x1b[32m${s}\x1b[0m`
const red = (s: string): string => `\x1b[31m${s}\x1b[0m`
const cyan = (s: string): string => `\x1b[36m${s}\x1b[0m`
const yellow = (s: string): string => `\x1b[33m${s}\x1b[0m`

let step = 0
function section(title: string): void {
  step += 1
  console.log(`\n${bold(cyan(`${step}. ${title}`))}`)
}
function ok(msg: string): void {
  console.log(`   ${green("✔")} ${msg}`)
}
function caught(msg: string): void {
  console.log(`   ${red("✖")} ${msg}`)
}
function code(msg: string): void {
  console.log(`   ${dim(msg)}`)
}

// --- setup ---------------------------------------------------------------------
const prisma = new PrismaClient({ adapter: new PrismaPg(process.env["DATABASE_URL"]!) })

async function main(): Promise<void> {
  await prisma.$executeRawUnsafe(`TRUNCATE "User", "Post", "Like" RESTART IDENTITY CASCADE`)

  console.log(bold("\nzod-bridge demo") + dim("  — typed Prisma errors + DB-aware Zod validators"))

  // 1 ---------------------------------------------------------------------------
  section("handlePrismaError: P2002 becomes a typed error")
  const alice = await prisma.user.create({ data: { email: "alice@example.com" } })
  ok(`created user #${alice.id} alice@example.com`)
  code(`await prisma.user.create({ data: { email: "alice@example.com" } })`)
  try {
    await prisma.user.create({ data: { email: "alice@example.com" } })
  } catch (e) {
    try {
      handlePrismaError(e)
    } catch (typed) {
      if (typed instanceof PrismaUniqueConstraintError) {
        caught(`PrismaUniqueConstraintError  fields=${JSON.stringify(typed.fields)}`)
      }
    }
  }

  // 2 ---------------------------------------------------------------------------
  section("unique(): Zod checks the database before you insert")
  const EmailSchema = unique(z.email(), prismaUnique(prisma.user, "email"), "Email already taken")
  code(`unique(z.email(), prismaUnique(prisma.user, "email"), "Email already taken")`)

  const taken = await EmailSchema.safeParseAsync("alice@example.com")
  caught(`"alice@example.com" → ${yellow(taken.error?.issues[0]?.message ?? "")}`)

  const free = await EmailSchema.safeParseAsync("bob@example.com")
  ok(`"bob@example.com" → ${free.success ? "valid" : "invalid"}`)

  // 3 ---------------------------------------------------------------------------
  section("Update: editing your own record is not a conflict")
  const UserSchema = unique(
    z.object({ id: z.number().optional(), email: z.email() }),
    prismaUnique(prisma.user, "email"),
    "Email already taken",
  )
  code(`unique(z.object({ id, email }), prismaUnique(prisma.user, "email"))`)
  const own = await UserSchema.safeParseAsync({ id: alice.id, email: "alice@example.com" })
  ok(
    `{ id: ${alice.id}, email: "alice@example.com" } → ${own.success ? "valid (own row excluded)" : "invalid"}`,
  )
  const other = await UserSchema.safeParseAsync({ id: alice.id + 1, email: "alice@example.com" })
  caught(
    `{ id: ${alice.id + 1}, email: "alice@example.com" } → ${yellow(other.error?.issues[0]?.message ?? "")} at ${JSON.stringify(other.error?.issues[0]?.path)}`,
  )

  // 4 ---------------------------------------------------------------------------
  section("uniqueComposite(): multi-column unique constraints")
  const post = await prisma.post.create({ data: { authorId: alice.id } })
  await prisma.like.create({ data: { userId: alice.id, postId: post.id } })
  ok(`alice liked post #${post.id}`)

  const LikeSchema = uniqueComposite(
    z.object({ userId: z.number(), postId: z.number() }),
    prismaUniqueComposite(prisma.like, ["userId", "postId"]),
    "Already liked this post",
  )
  code(
    `uniqueComposite(z.object({ userId, postId }), prismaUniqueComposite(prisma.like, ["userId", "postId"]))`,
  )
  const again = await LikeSchema.safeParseAsync({ userId: alice.id, postId: post.id })
  caught(
    `{ userId: ${alice.id}, postId: ${post.id} } → ${yellow(again.error?.issues[0]?.message ?? "")}`,
  )

  // 5 ---------------------------------------------------------------------------
  section("PrismaForeignKeyError: P2003")
  code(`await prisma.post.create({ data: { authorId: 9999 } })`)
  try {
    await prisma.post.create({ data: { authorId: 9999 } })
  } catch (e) {
    try {
      handlePrismaError(e)
    } catch (typed) {
      if (typed instanceof PrismaForeignKeyError) {
        caught(`PrismaForeignKeyError  fieldName=${JSON.stringify(typed.fieldName)}`)
      }
    }
  }

  // 6 ---------------------------------------------------------------------------
  section("findOrThrow: no more null checks")
  code(`await findOrThrow(() => prisma.user.findUnique({ where: { id: 9999 } }))`)
  try {
    await findOrThrow(() => prisma.user.findUnique({ where: { id: 9999 } }))
  } catch (e) {
    if (e instanceof PrismaNotFoundError) caught(`PrismaNotFoundError  "${e.message}"`)
  }

  // 7 ---------------------------------------------------------------------------
  section("Race condition: Zod check is UX, handlePrismaError is the safety net")
  const RaceSchema = unique(z.email(), prismaUnique(prisma.user, "email"), "Email already taken")
  code(
    `// two requests validate the same email at the same instant — both pass, nothing inserted yet`,
  )
  const [a, b] = await Promise.all([
    RaceSchema.safeParseAsync("race@example.com"),
    RaceSchema.safeParseAsync("race@example.com"),
  ])
  ok(`request A passed Zod: ${a.success}   request B passed Zod: ${b.success}`)

  code(`// both insert — Postgres lets exactly one through, handlePrismaError types the other`)
  const insert = async (label: string): Promise<string> => {
    try {
      await prisma.user.create({ data: { email: "race@example.com" } })
      return `${green("✔")} ${label}: inserted`
    } catch (e) {
      try {
        handlePrismaError(e)
      } catch (typed) {
        if (typed instanceof PrismaUniqueConstraintError) {
          return `${red("✖")} ${label}: PrismaUniqueConstraintError  fields=${JSON.stringify(typed.fields)}`
        }
      }
      throw e
    }
  }
  const results = await Promise.all([insert("request A"), insert("request B")])
  for (const r of results) console.log(`   ${r}`)

  console.log(
    `\n${green(bold("Done."))} ${dim("All errors above were typed — no magic string codes.")}\n`,
  )
}

main()
  .catch((e: unknown) => {
    console.error(red("Demo failed:"), e)
    process.exitCode = 1
  })
  .finally(() => prisma.$disconnect())
