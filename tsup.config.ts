import { defineConfig } from "tsup"

export default defineConfig({
  entry: {
    index: "src/index.ts",
    "adapters/prisma/index": "src/adapters/prisma/index.ts",
    // package.json "bin": `doctor` and the Prisma generator; imports neither zod nor @prisma/client
    cli: "src/cli.ts",
  },
  format: ["esm"],
  dts: true,
  sourcemap: true,
  clean: true,
})
