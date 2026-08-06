/**
 * Narrowing helpers the suites share — transport/client/substitution, and the
 * three fixture-driven conformance suites through `fixtures.ts`.
 *
 * They exist for one reason: `JSON.parse` returns `any`, and a test that says
 * `as Something` about it has asserted the very thing it meant to check. Every
 * function here is a *guard* — it looks, and throws with a readable message
 * when the shape is not what the test assumed — so the assertions in the suites
 * are about behaviour rather than about types. The single exception, and the
 * only `as` in any of this, is {@link parseJson}, which documents why there is
 * nothing there to look at.
 */

import type { JsonValue } from "@kframework-ts/kore";

/** A JSON object: not `null`, not an array. */
export function isJsonRecord(value: unknown): value is Record<string, JsonValue> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** {@link isJsonRecord}, as a checked conversion. */
export function jsonRecord(value: unknown, what: string): Record<string, JsonValue> {
  if (!isJsonRecord(value)) throw new TypeError(`Expected ${what} to be a JSON object, got: ${JSON.stringify(value)}`);
  return value;
}

/**
 * `JSON.parse`, typed as the `JsonValue` its result is by construction.
 *
 * The only assertion in this file, and the reason it is here rather than at a
 * call site: a parser that produced anything but `null`, a boolean, a number, a
 * string, an array or a plain object would not be `JSON.parse`. There is
 * nothing to check at run time — the `any` is a gap in the standard library's
 * types, not an assumption about the document — so every suite that needs a
 * `JsonValue` out of text comes through this one function instead of writing
 * its own `as`. Callers that need more than "it is JSON" narrow further with
 * {@link jsonRecord}, {@link jsonMember} and friends, which *do* look.
 */
export function parseJson(text: string): JsonValue {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see above.
  return JSON.parse(text) as JsonValue;
}

/** Parse text known to be a JSON object. */
export function parseJsonRecord(text: string, what: string): Record<string, JsonValue> {
  return jsonRecord(parseJson(text), what);
}

/** A member of a JSON object, checked to be present. */
export function jsonMember(value: unknown, key: string, what: string): JsonValue {
  const member = jsonRecord(value, what)[key];
  if (member === undefined) throw new TypeError(`Expected ${what} to have a "${key}" member`);
  return member;
}

/**
 * A member of a JSON object that the document is allowed to omit.
 *
 * `undefined` means *absent*: JSON has no way to write it, so the two cannot be
 * confused, and a test comparing against a decoder's optional field wants
 * exactly this distinction.
 */
export function jsonMemberOrAbsent(value: unknown, key: string, what: string): JsonValue | undefined {
  return jsonRecord(value, what)[key];
}

/** A JSON array whose every element is checked to be a JSON object. */
export function jsonRecords(value: unknown, what: string): readonly Record<string, JsonValue>[] {
  if (!Array.isArray(value)) throw new TypeError(`Expected ${what} to be a JSON array, got: ${JSON.stringify(value)}`);
  return value.map((element: unknown, index) => jsonRecord(element, `${what}[${index}]`));
}

/** A field of a JSON object, checked to be present and a string. */
export function jsonString(record: Record<string, JsonValue>, key: string): string {
  const value = record[key];
  if (typeof value !== "string") throw new TypeError(`Expected ${key} to be a string, got: ${JSON.stringify(value)}`);
  return value;
}

/** A value the test's setup guarantees is there. */
export function defined<T>(value: T | undefined | null, what: string): T {
  if (value === undefined || value === null) throw new TypeError(`Expected ${what} to be present`);
  return value;
}

/**
 * Run a function that must throw, and hand back the `Error` it threw.
 *
 * The synchronous {@link rejection}: `expect(fn).toThrow(…)` can only match a
 * message, and several suites need the class, the path *and* a bound on the
 * message's length from the same throw.
 */
export function caught(fn: () => unknown): Error {
  let settled: "returned" | Error;
  try {
    fn();
    settled = "returned";
  } catch (error) {
    if (error instanceof Error) return error;
    throw new TypeError(`Expected the call to throw an Error, got: ${JSON.stringify(error)}`, { cause: error });
  }
  throw new Error(`Expected the call to throw, but it ${settled}`);
}

/**
 * Await a promise that must reject, and hand back the `Error` it rejected with.
 *
 * Preferred over `expect(p).rejects.toThrow(…)` because the error becomes an
 * ordinary value: a test can then assert on its class, its `code` and its
 * message separately, and the assertions read the same as the synchronous ones.
 */
export async function rejection(promise: Promise<unknown>): Promise<Error> {
  let settled: "resolved" | Error;
  try {
    await promise;
    settled = "resolved";
  } catch (error) {
    if (error instanceof Error) return error;
    throw new TypeError(`Expected the promise to reject with an Error, got: ${JSON.stringify(error)}`, {
      cause: error,
    });
  }
  throw new Error(`Expected the promise to reject, but it ${settled}`);
}
