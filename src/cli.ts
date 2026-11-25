#!/usr/bin/env node
// The `zod-bridge` binary. Without arguments it is the Prisma generator
// (`provider = "zod-bridge"`): that is how Prisma spawns it. `zod-bridge doctor [dir]`
// scans a project. Must import neither `zod` nor `@prisma/client`.
import { runGenerator } from "./adapters/prisma/generator/run.js"
import { DOCTOR_USAGE, runDoctor } from "./doctor/run.js"

const command = process.argv[2]
if (command === undefined) {
  runGenerator()
} else if (command === "doctor") {
  // doctor always exits 0: it reports, it does not gate.
  process.stdout.write(await runDoctor(process.argv.slice(3)))
} else if (command === "--help" || command === "-h" || command === "help") {
  process.stdout.write(DOCTOR_USAGE)
} else {
  // a typo must not fall through to the generator, which would wait on stdin and print nothing
  console.error(`Unknown command ${command}\n\n${DOCTOR_USAGE}`)
  process.exitCode = 1
}
