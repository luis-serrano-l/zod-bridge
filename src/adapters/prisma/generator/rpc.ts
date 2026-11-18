// The Prisma generator protocol, without `@prisma/generator-helper`: Prisma
// spawns the generator, writes one JSON-RPC request per line to its stdin and
// reads one JSON-RPC response per line from its stderr.
import { mkdir, writeFile } from "node:fs/promises"
import { dirname } from "node:path"
import { DEFAULT_IMPORT_PATH, type DmmfDatamodel, emitModels } from "./emit.js"

/** Default `output`, resolved by Prisma against the schema's directory. */
export const DEFAULT_OUTPUT = "./generated/zod-bridge.ts"

type Request = {
  readonly jsonrpc: "2.0"
  readonly id: number
  readonly method: string
  readonly params?: unknown
}

type GenerateParams = {
  readonly generator: {
    readonly output?: { readonly value?: string | null } | null
    readonly config?: Readonly<Record<string, unknown>>
  }
  readonly dmmf: { readonly datamodel: DmmfDatamodel }
}

async function generate(params: GenerateParams): Promise<void> {
  const output = params.generator.output?.value
  if (typeof output !== "string" || !/\.[cm]?ts$/.test(output)) {
    throw new Error(
      `zod-bridge: output must be a .ts file path, got ${JSON.stringify(output)}. ` +
        `Fix: set output = "${DEFAULT_OUTPUT}" in the generator block.`,
    )
  }
  const importPath = params.generator.config?.["importPath"]
  const source = emitModels(params.dmmf.datamodel, {
    importPath: typeof importPath === "string" ? importPath : DEFAULT_IMPORT_PATH,
  })
  await mkdir(dirname(output), { recursive: true })
  await writeFile(output, source)
}

/** Answers one request line. Resolves to the response line, `undefined` for a notification. */
export async function handleLine(line: string): Promise<string | undefined> {
  let request: Request
  try {
    request = JSON.parse(line) as Request
  } catch {
    return undefined
  }
  if (typeof request?.id !== "number") return undefined

  const respond = (body: object) => JSON.stringify({ jsonrpc: "2.0", id: request.id, ...body })
  try {
    if (request.method === "getManifest") {
      return respond({
        result: { manifest: { prettyName: "zod-bridge models", defaultOutput: DEFAULT_OUTPUT } },
      })
    }
    if (request.method === "generate") {
      await generate(request.params as GenerateParams)
      return respond({ result: null })
    }
    return respond({ error: { code: -32601, message: `Unknown method ${request.method}` } })
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    return respond({ error: { code: -32000, message, data: null } })
  }
}
