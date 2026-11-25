import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { runDoctor } from "../src/doctor/run.js"
import { scanSource } from "../src/doctor/scan.js"

const rules = (source: string): string[] => scanSource(source, "a.ts").map((f) => f.rule)

describe("scanSource", () => {
  it("finds a comparison against each handled Prisma code", () => {
    const source = [
      `try {`,
      `  await prisma.user.create({ data })`,
      `} catch (e) {`,
      `  if (e.code === "P2002") throw new Conflict()`,
      `  if (e.code == 'P2003') throw new BadRequest()`,
      "  if (`P2025` === e.code) throw new NotFound()",
      `  if (e.code === "P2014") throw new BadRequest()`,
      `}`,
    ].join("\n")
    expect(scanSource(source, "src/users.ts")).toMatchObject([
      { file: "src/users.ts", line: 4, column: 18, rule: "P2002" },
      { file: "src/users.ts", line: 5, column: 17, rule: "P2003" },
      { file: "src/users.ts", line: 6, column: 7, rule: "P2025" },
      { file: "src/users.ts", line: 7, column: 18, rule: "P2014" },
    ])
  })

  it("finds codes in switch cases and lookup tables", () => {
    expect(rules(`switch (e.code) {\n  case "P2002":\n    break\n}`)).toEqual(["P2002"])
    expect(
      rules(`const STATUS = { P2002: 409 }\nif (["P2025", "P2003"].includes(code)) {}`),
    ).toEqual(["P2025", "P2003"])
  })

  it("finds meta.target and meta.field_name in every access form", () => {
    expect(rules(`const fields = e.meta.target`)).toEqual(["meta.target"])
    expect(rules(`const fields = e.meta?.target as string[]`)).toEqual(["meta.target"])
    expect(rules(`const fields = e.meta["target"]`)).toEqual(["meta.target"])
    expect(rules(`const fields = e.meta?.['target']`)).toEqual(["meta.target"])
    expect(rules(`const field = err.meta?.field_name`)).toEqual(["meta.field_name"])
    expect(rules(`const field = err.meta["field_name"]`)).toEqual(["meta.field_name"])
    expect(rules(`const fields = err.meta!.target as string[]`)).toEqual(["meta.target"])
    expect(rules(`const fields = err.meta!["target"]`)).toEqual(["meta.target"])
    expect(rules(`const fields = (err.meta as any).target`)).toEqual(["meta.target"])
    expect(rules(`const field = (err.meta as Meta)?.field_name`)).toEqual(["meta.field_name"])
  })

  it("reports every match of a line, in column order, with the trimmed source", () => {
    const findings = scanSource(`  if (e.code === "P2002" && e.meta?.target) {}`, "a.ts")
    expect(findings.map((f) => [f.rule, f.column])).toEqual([
      ["P2002", 18],
      ["meta.target", 31],
    ])
    expect(findings[0]?.source).toBe(`if (e.code === "P2002" && e.meta?.target) {}`)
  })

  it("names the zod-bridge replacement for each rule", () => {
    const replacement = (source: string): string => scanSource(source, "a.ts")[0]?.replacement ?? ""
    expect(replacement(`"P2002"`)).toContain("PrismaUniqueConstraintError")
    expect(replacement(`"P2002"`)).toContain("toZodIssues")
    expect(replacement(`"P2003"`)).toContain("PrismaForeignKeyError")
    expect(replacement(`"P2025"`)).toContain("findOrThrow")
    expect(replacement(`"P2014"`)).toContain("PrismaRelationViolationError")
    expect(replacement(`e.meta.target`)).toContain(".fields")
    expect(replacement(`e.meta.field_name`)).toContain(".fieldName")
  })

  it("ignores comments, other codes and unrelated properties", () => {
    const source = [
      `// if (e.code === "P2002") old code`,
      `/* e.meta.target */`,
      ` * e.code === "P2025"`,
      `if (e.code === "P2001") {}`,
      `if (e.code === "P20025") {}`,
      `const t = event.target`,
      `const m = metadata.target`,
      `const n = meta.targets`,
      `const id = P2002`,
      `const u = (meta as Options).name.target`,
    ].join("\n")
    expect(scanSource(source, "a.ts")).toEqual([])
  })

  it("scans the code after a comment that opens and closes the line", () => {
    expect(scanSource(`/* legacy */ if (e.code === "P2002") {}`, "a.ts")).toMatchObject([
      { rule: "P2002", column: 29, source: `/* legacy */ if (e.code === "P2002") {}` },
    ])
    expect(rules(`/* "P2002" */ const a = 1`)).toEqual([])
  })

  it("handles CRLF line endings", () => {
    expect(scanSource(`a\r\nif (e.code === "P2002") {}\r\n`, "a.ts")).toMatchObject([
      { line: 2, source: `if (e.code === "P2002") {}` },
    ])
  })
})

describe("runDoctor", () => {
  let dir: string

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "zod-bridge-doctor-"))
    await mkdir(join(dir, "src", "routes"), { recursive: true })
    await mkdir(join(dir, "node_modules", "pkg"), { recursive: true })
    await mkdir(join(dir, "dist"), { recursive: true })
    await mkdir(join(dir, ".next"), { recursive: true })
    await writeFile(join(dir, "src", "routes", "users.ts"), `if (e.code === "P2002") {}\n`)
    await writeFile(join(dir, "src", "form.tsx"), `\nconst f = e.meta?.target\n`)
    await writeFile(join(dir, "src", "legacy.js"), `if (e.code === "P2025") {}\n`)
    await writeFile(join(dir, "src", "clean.ts"), `export const a = 1\n`)
    await writeFile(join(dir, "src", "types.d.ts"), `type A = "P2002"\n`)
    await writeFile(join(dir, "src", "notes.md"), `e.code === "P2002"\n`)
    await writeFile(join(dir, "node_modules", "pkg", "index.js"), `e.code === "P2002"\n`)
    await writeFile(join(dir, "dist", "index.js"), `e.code === "P2002"\n`)
    await writeFile(join(dir, ".next", "chunk.js"), `e.code === "P2002"\n`)
    // build/ and out/ are output next to a package.json, source anywhere else
    await mkdir(join(dir, "build"), { recursive: true })
    await mkdir(join(dir, "src", "build"), { recursive: true })
    await writeFile(join(dir, "package.json"), "{}\n")
    await writeFile(join(dir, "build", "index.js"), `e.code === "P2002"\n`)
    await writeFile(join(dir, "src", "build", "pipeline.ts"), `if (e.code === "P2014") {}\n`)
  })

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it("scans .ts/.tsx/.js under the directory, skipping dependencies and build output", async () => {
    const report = JSON.parse(await runDoctor(["--json"], dir))
    expect(report.filesScanned).toBe(5)
    expect(report.errors).toEqual([])
    expect(
      report.findings.map((f: { file: string; line: number; rule: string }) => [
        f.file,
        f.line,
        f.rule,
      ]),
    ).toEqual([
      ["src/build/pipeline.ts", 1, "P2014"],
      ["src/form.tsx", 2, "meta.target"],
      ["src/legacy.js", 1, "P2025"],
      ["src/routes/users.ts", 1, "P2002"],
    ])
  })

  it("takes the directory as an argument and reports paths relative to the working directory", async () => {
    const report = JSON.parse(await runDoctor(["src/routes", "--json"], dir))
    expect(report.root).toBe(join(dir, "src", "routes"))
    expect(report.findings.map((f: { file: string }) => f.file)).toEqual(["src/routes/users.ts"])
  })

  it("prints file:line:column, the source and the replacement for each finding", async () => {
    const output = await runDoctor(["src/routes"], dir)
    expect(output).toContain(`src/routes/users.ts:1:16  P2002  if (e.code === "P2002") {}`)
    expect(output).toContain("PrismaUniqueConstraintError")
    expect(output).toContain("1 finding in 1 file (1 scanned)")
  })

  it("says so when nothing is found", async () => {
    await mkdir(join(dir, "empty"), { recursive: true })
    expect(await runDoctor(["empty"], dir)).toContain("No hand-rolled Prisma error handling found")
  })

  it("reports a missing directory as an error, in both formats, without throwing", async () => {
    expect(await runDoctor(["nope"], dir)).toContain("Cannot read")
    const report = JSON.parse(await runDoctor(["nope", "--json"], dir))
    expect(report.findings).toEqual([])
    expect(report.errors).toHaveLength(1)
    expect(report.errors[0]).toMatch(/^Cannot read nope: /)
  })

  it("scans a file given instead of a directory, whatever its extension", async () => {
    const report = JSON.parse(await runDoctor(["src/types.d.ts", "--json"], dir))
    expect(report.findings).toMatchObject([{ file: "src/types.d.ts", rule: "P2002" }])
  })

  it("keeps stdout JSON when --json comes with a usage mistake", async () => {
    expect(JSON.parse(await runDoctor(["--json", "--strict"], dir))).toMatchObject({
      findings: [],
      errors: ["Unknown option --strict"],
    })
    expect(JSON.parse(await runDoctor(["src", "empty", "--json"], dir)).errors).toEqual([
      "Expected one directory, got 2",
    ])
  })

  it("prints usage for --help and for an unknown flag", async () => {
    expect(await runDoctor(["--help"], dir)).toContain("Usage: zod-bridge doctor [dir] [--json]")
    expect(await runDoctor(["--strict"], dir)).toContain("Unknown option --strict")
  })
})
