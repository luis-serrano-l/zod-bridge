// Regenerates tests/generated/zod-bridge.ts by running the built generator
// through a real `prisma generate` (npm run generate:models). The generator
// block is not in prisma/schema.prisma itself: CI runs `prisma generate`
// before the build, when dist/ does not exist yet.
import { execFileSync } from "node:child_process"
import { readFileSync, rmSync, writeFileSync } from "node:fs"

const schema = "prisma/.zod-bridge.tmp.prisma"
const block = `
generator zodBridge {
  provider   = "node ./dist/adapters/prisma/generator.js"
  output     = "../tests/generated/zod-bridge.ts"
  importPath = "../../src/adapters/prisma/index.js"
}
`
writeFileSync(schema, readFileSync("prisma/schema.prisma", "utf8") + block)
try {
  execFileSync("npx", ["prisma", "generate", "--schema", schema, "--generator", "zodBridge"], {
    stdio: "inherit",
  })
} finally {
  rmSync(schema)
}
