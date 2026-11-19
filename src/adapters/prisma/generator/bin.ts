#!/usr/bin/env node
// Entry of the `zod-bridge` Prisma generator (`provider = "zod-bridge"`).
import { createInterface } from "node:readline"
import { handleLine } from "./rpc.js"

if (process.env["PRISMA_GENERATOR_INVOCATION"] === undefined && process.stdin.isTTY) {
  console.error(
    "zod-bridge is a Prisma generator, not a command. Fix: add\n\n" +
      '  generator zodBridge {\n    provider = "zod-bridge"\n  }\n\n' +
      "to schema.prisma and run `prisma generate`.",
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
