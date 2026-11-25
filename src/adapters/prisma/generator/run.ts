// The `zod-bridge` Prisma generator (`provider = "zod-bridge"`), started by src/cli.ts.
import { createInterface } from "node:readline"
import { handleLine } from "./rpc.js"

/** Serves Prisma's generator protocol on stdin / stderr until stdin closes. */
export function runGenerator(): void {
  if (process.env["PRISMA_GENERATOR_INVOCATION"] === undefined && process.stdin.isTTY) {
    console.error(
      "zod-bridge without a command is a Prisma generator. Fix: add\n\n" +
        '  generator zodBridge {\n    provider = "zod-bridge"\n  }\n\n' +
        "to schema.prisma and run `prisma generate`, or run `zod-bridge doctor [dir]` to find\n" +
        "hand-rolled Prisma error handling.",
    )
    process.exit(1)
  }

  // Requests are answered in order; Prisma reads the responses from stderr.
  let queue = Promise.resolve()
  createInterface({ input: process.stdin, crlfDelay: Number.POSITIVE_INFINITY }).on(
    "line",
    (line) => {
      queue = queue.then(async () => {
        const response = await handleLine(line)
        if (response !== undefined) process.stderr.write(`${response}\n`)
      })
    },
  )
}
