/**
 * Default issue message of `unique()`, reused by `toZodIssues` so the refine
 * issue and the converted database error are equal. Must stay DB-free.
 */
export const DEFAULT_UNIQUE_MESSAGE = "Value already taken"

/**
 * Message of a uniqueness issue from the options `unique()` and `toZodIssues`
 * both accept (a bare string is the message). One rule for both, so the two
 * issues cannot drift apart.
 */
export function uniqueMessage(options: string | { readonly message?: string } | undefined): string {
  return typeof options === "string" ? options : (options?.message ?? DEFAULT_UNIQUE_MESSAGE)
}
