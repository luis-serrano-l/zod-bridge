/**
 * True for `{}`-style objects (prototype `Object.prototype` or `null`), which
 * is what `z.object` outputs. Dates, arrays, Buffers, Decimals and other class
 * instances are field values, not containers of fields.
 *
 * Shared by core and the adapters so both agree on when a value is "the
 * object form". Must stay free of DB imports: core depends on it.
 */
export function isPlainObject(val: unknown): val is Record<string, unknown> {
  if (typeof val !== "object" || val === null) return false
  const proto: unknown = Object.getPrototypeOf(val)
  return proto === Object.prototype || proto === null
}
