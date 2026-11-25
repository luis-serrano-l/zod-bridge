// `zod-bridge doctor [dir] [--json]`: walks a project and reports hand-rolled
// Prisma error handling. Read-only; runDoctor never rejects (the command always exits 0).
import type { Dirent } from "node:fs"
import { readdir, readFile, stat } from "node:fs/promises"
import { join, relative, resolve, sep } from "node:path"
import type { Finding } from "./scan.js"
import { scanSource } from "./scan.js"

export type DoctorReport = {
  /** Absolute path that was scanned. */
  readonly root: string
  readonly filesScanned: number
  /** `file` is relative to the working directory, with `/` separators. */
  readonly findings: readonly Finding[]
  /** What could not be read (paths relative to the working directory), or a usage mistake. */
  readonly errors: readonly string[]
}

export const DOCTOR_USAGE = `Usage: zod-bridge doctor [dir] [--json]

Finds hand-rolled Prisma error handling (the quoted codes "P2002" / "P2003" / "P2025" / "P2014",
meta.target, meta.field_name) under dir (default: the current directory) and prints the zod-bridge
replacement for each. Scans .ts, .tsx, .js, .jsx, .mts, .cts, .mjs and .cjs files; a file given
instead of a directory is scanned whatever its extension. Read-only; always exits 0.

  --json   print { root, filesScanned, findings, errors } as JSON
`

const SOURCE_FILE = /\.(?:[cm]?[jt]s|[jt]sx)$/
const DECLARATION_FILE = /\.d\.[cm]?ts$/
/** Never source, at any depth. */
const SKIPPED_DIRS: ReadonlySet<string> = new Set(["node_modules", "dist", "coverage"])
/** Build output next to a package.json; elsewhere (`src/build/`) it is a source directory. */
const PACKAGE_OUTPUT_DIRS: ReadonlySet<string> = new Set(["build", "out"])

function describe(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

/** `path` relative to `cwd`, with `/` separators. */
function display(path: string, cwd: string): string {
  return relative(cwd, path).split(sep).join("/") || "."
}

/** Source files under `dir`, sorted; symlinks, dot-directories and build output are skipped. */
async function listSourceFiles(dir: string, cwd: string, errors: string[]): Promise<string[]> {
  let entries: Dirent[]
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch (e) {
    errors.push(`Cannot read ${display(dir, cwd)}: ${describe(e)}`)
    return []
  }
  const isPackageRoot = entries.some((entry) => entry.name === "package.json")
  const files: string[] = []
  for (const entry of entries.sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (entry.name.startsWith(".") || SKIPPED_DIRS.has(entry.name)) continue
      if (isPackageRoot && PACKAGE_OUTPUT_DIRS.has(entry.name)) continue
      files.push(...(await listSourceFiles(path, cwd, errors)))
    } else if (
      entry.isFile() &&
      SOURCE_FILE.test(entry.name) &&
      !DECLARATION_FILE.test(entry.name)
    ) {
      files.push(path)
    }
  }
  return files
}

/**
 * Scans `root`: a directory, or a single file (scanned whatever its extension). Paths in the
 * findings and errors are relative to `cwd`.
 */
export async function scanProject(root: string, cwd: string): Promise<DoctorReport> {
  const errors: string[] = []
  let files: string[]
  try {
    files = (await stat(root)).isDirectory() ? await listSourceFiles(root, cwd, errors) : [root]
  } catch (e) {
    const error = `Cannot read ${display(root, cwd)}: ${describe(e)}`
    return { root, filesScanned: 0, findings: [], errors: [error] }
  }

  const findings: Finding[] = []
  let filesScanned = 0
  for (const path of files) {
    let source: string
    try {
      source = await readFile(path, "utf8")
    } catch (e) {
      errors.push(`Cannot read ${display(path, cwd)}: ${describe(e)}`)
      continue
    }
    filesScanned += 1
    findings.push(...scanSource(source, display(path, cwd)))
  }
  return { root, filesScanned, findings, errors }
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`
}

/** The human-readable report: `file:line:column  rule  source`, then the replacement. */
export function formatReport(report: DoctorReport): string {
  const lines: string[] = []
  for (const f of report.findings) {
    lines.push(
      `${f.file}:${f.line}:${f.column}  ${f.rule}  ${f.source}`,
      `  → ${f.replacement}`,
      "",
    )
  }
  for (const error of report.errors) lines.push(`error: ${error}`)
  if (report.errors.length > 0) lines.push("")

  if (report.findings.length === 0) {
    lines.push(
      `No hand-rolled Prisma error handling found in ${report.root} ` +
        `(${plural(report.filesScanned, "file")} scanned).`,
    )
  } else {
    const fileCount = new Set(report.findings.map((f) => f.file)).size
    lines.push(
      `${plural(report.findings.length, "finding")} in ${plural(fileCount, "file")} ` +
        `(${report.filesScanned} scanned). Every replacement is imported from "zod-bridge/prisma" ` +
        `(unique from "zod-bridge"): https://github.com/luis-serrano-l/zod-bridge#readme`,
    )
  }
  return `${lines.join("\n")}\n`
}

/**
 * Runs the `doctor` command and resolves to what it prints on stdout.
 *
 * @param args - the arguments after `doctor`
 * @param cwd - base of a relative `dir` and of the reported paths
 */
export async function runDoctor(
  args: readonly string[],
  cwd: string = process.cwd(),
): Promise<string> {
  const options = args.filter((a) => a.startsWith("-"))
  const dirs = args.filter((a) => !a.startsWith("-"))
  if (options.includes("--help") || options.includes("-h")) return DOCTOR_USAGE
  const json = options.includes("--json")
  const print = (report: DoctorReport): string =>
    json ? `${JSON.stringify(report, null, 2)}\n` : formatReport(report)

  // With --json, stdout is always one JSON report: a usage mistake goes into `errors`.
  const unknown = options.find((o) => o !== "--json")
  const mistake =
    unknown !== undefined
      ? `Unknown option ${unknown}`
      : dirs.length > 1
        ? `Expected one directory, got ${dirs.length}`
        : undefined
  if (mistake !== undefined) {
    return json
      ? print({ root: cwd, filesScanned: 0, findings: [], errors: [mistake] })
      : `${mistake}\n\n${DOCTOR_USAGE}`
  }

  try {
    return print(await scanProject(resolve(cwd, dirs[0] ?? "."), cwd))
  } catch (e) {
    return print({ root: cwd, filesScanned: 0, findings: [], errors: [describe(e)] })
  }
}
