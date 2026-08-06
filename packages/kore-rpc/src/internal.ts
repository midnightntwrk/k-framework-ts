/**
 * Strict-JSON reading primitives shared by `logs.ts`, `errors.ts` and
 * `codec.ts`.
 *
 * **Not public API.** `index.ts` does not re-export this module, and nothing
 * here is part of the package's semver surface. It exists because the same
 * four modules would otherwise each carry their own copy of `asObject` /
 * `asString` / the error-path convention — `@kframework-ts/kore`'s `json.ts`
 * keeps its copies private precisely because it is a single module, and this
 * package is not.
 *
 * The conventions are that module's, deliberately: every failure is a
 * `SyntaxError` whose message ends `(at some.json.path)`, and a value is named
 * by its *content* when it is a scalar and by its *shape* when it is a
 * container, so a 4 MB configuration never lands in an exception string.
 *
 * # Absent, `null`, and `undefined`
 *
 * The wire types derive with `OmitNothingFields` (`Types.hs:56` and friends),
 * so the server never emits `null` for a `Maybe` field — it omits the key. On
 * the *reading* side aeson is looser: `.:?` maps an explicit `null` to
 * `Nothing` just as it maps an absent key. {@link optionalField} does the same,
 * which is why a response carrying `"rule": null` decodes to a result with no
 * `rule` rather than to an error.
 */

import type { JsonObject, JsonValue } from "@kframework-ts/kore";

/** `message (at path)` — the convention `@kframework-ts/kore` uses throughout. */
export function rpcError(message: string, path: string): SyntaxError {
  return new SyntaxError(`${message} (at ${path})`);
}

/** `Array.isArray` with a predicate that does not launder its argument into `any[]`. */
export function isArray(value: unknown): value is readonly unknown[] {
  return Array.isArray(value);
}

/** A non-null, non-array JSON object. Written as a predicate so no cast is needed. */
export function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !isArray(value);
}

/**
 * How a bad value is named in a message: the value for scalars, the shape for
 * containers.
 */
export function describe(value: unknown): string {
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") return String(value);
  if (value === undefined) return "nothing";
  if (value === null) return "null";
  if (typeof value === "symbol") return value.toString();
  if (typeof value === "function") return "a function";
  return isArray(value) ? "an array" : "an object";
}

export function asObject(value: unknown, path: string): Readonly<Record<string, unknown>> {
  if (!isRecord(value)) throw rpcError(`Expected an object, got ${describe(value)}`, path);
  return value;
}

export function asArray(value: unknown, path: string): readonly unknown[] {
  if (!isArray(value)) throw rpcError(`Expected an array, got ${describe(value)}`, path);
  return value;
}

export function asString(value: unknown, path: string): string {
  if (typeof value !== "string") throw rpcError(`Expected a string, got ${describe(value)}`, path);
  return value;
}

export function asBoolean(value: unknown, path: string): boolean {
  if (typeof value !== "boolean") throw rpcError(`Expected a boolean, got ${describe(value)}`, path);
  return value;
}

/** A JSON number — Haskell `Double`, the type `ProcessingTime.time` uses. */
export function asNumber(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw rpcError(`Expected a number, got ${describe(value)}`, path);
  }
  return value;
}

/** Haskell `Int` — `Simplification.original-term-index` is a list of these. */
export function asInt(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw rpcError(`Expected an integer, got ${describe(value)}`, path);
  }
  return value;
}

/**
 * Haskell `Natural` — `Depth` (`Types/Depth.hs:6`) and nothing else.
 *
 * `Natural`'s `FromJSON` rejects a negative and a fractional number, so a
 * `depth` of `-1` or `1.5` is a decode failure and not a clamp.
 */
export function asNat(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw rpcError(`Expected a non-negative integer, got ${describe(value)}`, path);
  }
  return value;
}

/**
 * Whether a value is JSON-shaped all the way down — shallow in practice, since
 * anything that came out of `JSON.parse` is by construction.
 *
 * A type predicate rather than a cast, so the narrowing is visible in one place
 * instead of at every call site that wants a `JsonValue`.
 */
function isJsonValue(value: unknown): value is JsonValue {
  if (value === null) return true;
  const kind = typeof value;
  if (kind === "string" || kind === "number" || kind === "boolean") return true;
  return isArray(value) || isRecord(value);
}

/** A raw JSON value, kept as-is — used where upstream's type is `Value`. */
export function asJson(value: unknown, path: string): JsonValue {
  if (!isJsonValue(value)) throw rpcError(`Expected a JSON value, got ${describe(value)}`, path);
  return value;
}

/** {@link asJson} restricted to an object, for a payload we keep whole but know is a record. */
export function asJsonObject(value: unknown, path: string): JsonObject {
  const json = asJson(value, path);
  if (json === null || typeof json !== "object" || isArray(json)) {
    throw rpcError(`Expected an object, got ${describe(value)}`, path);
  }
  return json;
}

/**
 * Compile-time exhaustiveness, as in `@kframework-ts/kore`'s `json.ts`.
 *
 * Reached only if a union gained a member without this file being updated,
 * which the type checker catches first.
 */
export function exhausted(value: never): never {
  throw new TypeError(`Unhandled case: ${JSON.stringify(value)}`);
}

/**
 * A required field. Missing is an error, and so is `null`: only `Maybe` fields
 * accept it (see the header).
 */
export function requiredField<T>(
  obj: Readonly<Record<string, unknown>>,
  key: string,
  path: string,
  what: string,
  read: (value: unknown, path: string) => T,
): T {
  if (!Object.hasOwn(obj, key) || obj[key] === undefined) {
    throw rpcError(`${what} is missing the field ${JSON.stringify(key)}`, path);
  }
  return read(obj[key], `${path}.${key}`);
}

/** A `Maybe` field: absent *or* `null` yields `undefined`. */
export function optionalField<T>(
  obj: Readonly<Record<string, unknown>>,
  key: string,
  path: string,
  read: (value: unknown, path: string) => T,
): T | undefined {
  const value = obj[key];
  if (value === undefined || value === null) return undefined;
  return read(value, `${path}.${key}`);
}

/** An array-valued field, each element read with `read`. */
export function readArray<T>(value: unknown, path: string, read: (value: unknown, path: string) => T): readonly T[] {
  return asArray(value, path).map((item, i) => read(item, `${path}.${i}`));
}

/** One of a fixed set of string values — every enum upstream derives. */
export function asEnum<T extends string>(value: unknown, path: string, allowed: readonly T[], what: string): T {
  const text = asString(value, path);
  for (const candidate of allowed) {
    if (text === candidate) return candidate;
  }
  throw rpcError(`Unknown ${what}: ${JSON.stringify(text)}`, path);
}

/**
 * A mutable object under construction, for the encode side.
 *
 * `putOptional` is the whole of `OmitNothingFields`: `undefined` writes
 * nothing at all. There is no path through this module that emits a `null` for
 * an absent optional, which is the one encoding mistake the Haskell server
 * would silently accept and the booster would not.
 */
export type MutableJsonObject = Record<string, JsonValue>;

export function putOptional(out: MutableJsonObject, key: string, value: JsonValue | undefined): void {
  if (value !== undefined) out[key] = value;
}

/** Freeze the built object back into the read-only alias the codec returns. */
export function sealObject(out: MutableJsonObject): JsonObject {
  return out;
}
