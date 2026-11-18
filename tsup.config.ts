import { defineConfig } from "tsup"

export default defineConfig({
  entry: {
    index: "src/index.ts",
    "adapters/prisma/index": "src/adapters/prisma/index.ts",
    // Prisma generator binary (package.json "bin"); imports neither zod nor @prisma/client
    "adapters/prisma/generator": "src/adapters/prisma/generator/bin.ts",
  },
  format: ["esm"],
  dts: true,
  sourcemap: true,
  clean: true,
})
