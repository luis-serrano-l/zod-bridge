import { defineConfig } from "tsup"

export default defineConfig({
  entry: {
    index: "src/index.ts",
    "adapters/prisma/index": "src/adapters/prisma/index.ts",
  },
  format: ["esm"],
  dts: true,
  sourcemap: true,
  clean: true,
})
