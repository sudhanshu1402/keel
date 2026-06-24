/**
 * Throw if `value` cannot round-trip through the JSON persistence layer. keel
 * stores step results, inputs, and outputs as JSON. Values like `Date`, `Map`,
 * `Set`, `bigint`, functions, and class instances either make `JSON.stringify`
 * throw or are silently mangled by it (a `Date` becomes a string, a `Map`
 * becomes `{}`). Rejecting them at the write boundary turns silent durable-state
 * corruption into a clear, immediate error, and keeps behavior identical across
 * MemoryStore, FileStore, and SqliteStore so a workflow that passes in tests
 * behaves the same in production.
 *
 * Allowed: string, number, boolean, null, undefined (treated as absent), plain
 * objects, and arrays thereof.
 */
export function assertJsonSafe(value: unknown, what: string, path = ''): void {
  const where = path ? `${what} at ${path}` : what;
  const t = typeof value;
  if (
    value === null ||
    t === 'string' ||
    t === 'number' ||
    t === 'boolean' ||
    t === 'undefined'
  ) {
    return;
  }
  if (t === 'bigint') {
    throw new TypeError(
      `${where}: bigint is not JSON-serializable; convert it to a string or number`,
    );
  }
  if (t === 'function' || t === 'symbol') {
    throw new TypeError(`${where}: ${t}s are not JSON-serializable`);
  }
  if (Array.isArray(value)) {
    value.forEach((v, i) => assertJsonSafe(v, what, `${path}[${i}]`));
    return;
  }
  // Only plain objects survive a JSON round-trip. A non-Object prototype means
  // a Date, Map, Set, or other class instance that would be silently mangled.
  const proto = Object.getPrototypeOf(value as object);
  if (proto !== Object.prototype && proto !== null) {
    const name = (value as { constructor?: { name?: string } }).constructor
      ?.name;
    throw new TypeError(
      `${where}: values of type ${name ?? 'object'} are not JSON-serializable; ` +
        `store a plain object instead`,
    );
  }
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    assertJsonSafe(v, what, path ? `${path}.${k}` : k);
  }
}
