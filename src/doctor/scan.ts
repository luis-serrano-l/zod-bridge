// The scanner behind `zod-bridge doctor`: finds hand-rolled Prisma error
// handling in source text. Pure (no fs, no zod, no @prisma/client).

/** What a finding matched: a Prisma error code literal or a raw `meta` read. */
export type Rule = "P2002" | "P2003" | "P2025" | "P2014" | "meta.target" | "meta.field_name"

export type Finding = {
  readonly file: string
  /** 1-based. */
  readonly line: number
  /** 1-based, of the first matched character. */
  readonly column: number
  readonly rule: Rule
  /** The matched line, trimmed. */
  readonly source: string
  /** What to write with zod-bridge instead. */
  readonly replacement: string
}

const REPLACEMENTS: Readonly<Record<Rule, string>> = {
  P2002:
    "handlePrismaError(e) rethrows it as PrismaUniqueConstraintError (fields: string[]); " +
    "toZodIssues(e) turns it into a Zod issue; unique(schema, prismaUnique(model, field)) " +
    "reports the conflict before the write.",
  P2003: "handlePrismaError(e) rethrows it as PrismaForeignKeyError (fieldName: string).",
  P2025:
    "handlePrismaError(e) rethrows it as PrismaNotFoundError; " +
    "findOrThrow(() => prisma.model.findUnique(...)) throws it instead of returning null.",
  P2014: "handlePrismaError(e) rethrows it as PrismaRelationViolationError (relationName: string).",
  "meta.target":
    "read PrismaUniqueConstraintError.fields after handlePrismaError(e): " +
    "meta.target is missing on Prisma 7 with a driver adapter.",
  "meta.field_name":
    "read PrismaForeignKeyError.fieldName after handlePrismaError(e): " +
    "meta.field_name is missing on Prisma 7 with a driver adapter.",
}

// A quoted code: `"P2002"`, in any quote style.
const CODE = /(["'`])(P2002|P2003|P2025|P2014)\1/g

// A `target` / `field_name` read off something named `meta`: `meta.target`, `meta?.target`,
// `meta!.target`, `(meta as T).target`, and the same with `["target"]`.
const META =
  /\bmeta(?:\s*!|\s+as\s+[^()]+\))?\s*(?:(?:\?\.|\.)\s*(target|field_name)\b|(?:\?\.)?\s*\[\s*(["'`])(target|field_name)\2\s*\])/g

/** A comment that opens the line and closes on it: the code after it is still scanned. */
const LEADING_BLOCK_COMMENT = /^\s*\/\*.*?\*\//

/**
 * Whole-line comments only: `//`, an unclosed `/*`, and the `*` lines of a block comment.
 * A trailing `// ...` is scanned (it cannot be told from a URL in a string), and so is a
 * block-comment line that does not start with `*`.
 */
const COMMENT_LINE = /^\s*(?:\/\/|\/\*|\*)/

/**
 * Findings of one file's text, in source order. `file` is copied into each finding as given.
 */
export function scanSource(source: string, file: string): Finding[] {
  const findings: Finding[] = []
  const lines = source.split(/\r?\n/)
  for (const [index, line] of lines.entries()) {
    // blanked, not removed: columns stay those of the original line
    const text = line.replace(LEADING_BLOCK_COMMENT, (comment) => " ".repeat(comment.length))
    if (COMMENT_LINE.test(text)) continue
    const matches: { readonly column: number; readonly rule: Rule }[] = []
    for (const match of text.matchAll(CODE)) {
      matches.push({ column: match.index + 1, rule: match[2] as Rule })
    }
    for (const match of text.matchAll(META)) {
      matches.push({ column: match.index + 1, rule: `meta.${match[1] ?? match[3]}` as Rule })
    }
    for (const { column, rule } of matches.sort((a, b) => a.column - b.column)) {
      findings.push({
        file,
        line: index + 1,
        column,
        rule,
        source: line.trim(),
        replacement: REPLACEMENTS[rule],
      })
    }
  }
  return findings
}
