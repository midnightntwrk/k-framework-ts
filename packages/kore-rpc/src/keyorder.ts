/**
 * Byte-exact emission — the serializer that reproduces what a kore-rpc server
 * actually puts on the socket, key for key and byte for byte.
 *
 * Transcribed from `rpcJsonConfig`
 * (`haskell-backend/kore-rpc-types/src/Kore/JsonRpc/Types.hs:298-342`) and the
 * two overrides the server applies to it
 * (`kore-rpc-types/src/Kore/JsonRpc/Server.hs:91-98`: `confIndent = Spaces 0`,
 * `confTrailingNewline = True`).
 *
 * # Why this exists
 *
 * `JSON.stringify` emits keys in insertion order and aeson-pretty emits them
 * in `confCompare` order, so a response this package builds and a response the
 * server built are equal as *values* and different as *bytes*. That difference
 * costs two things worth having: golden tests that compare bytes (the
 * strongest oracle a vendored fixture can give), and bug reports whose
 * recorded traffic is diffable against a real session. {@link emitOrdered}
 * closes it.
 *
 * # The ordering rule
 *
 * aeson-pretty's `keyOrder ks` compares keys by their index in `ks`, with
 * every unlisted key sorting after every listed one; ties are broken by the
 * order the keys already had, and aeson's `KeyMap` is ordered (the
 * `ordered-keymap` flag, on by default since 2.0.3), so that order is
 * ascending. Net effect, and confirmed against the vendored goldens:
 *
 * 1. keys named in {@link RPC_KEY_ORDER}, in list order;
 * 2. then every other key, ascending lexicographically;
 * 3. recursively, in every object at every depth.
 *
 * Step 2 uses JavaScript's string comparison, which orders UTF-16 code units
 * where Haskell's `Ord Text` orders code points. The two disagree only for
 * astral characters against U+E000–U+FFFF, and every key in this protocol is
 * ASCII, so the distinction is theoretical.
 *
 * # `"valid"` is dead and stays
 *
 * `RPC_KEY_ORDER` contains `"valid"` (`Types.hs:330`) — a field of the
 * `implies` result that was renamed to `status` before v0.1.155 and that no
 * current server emits. It is transcribed anyway: the list is a *position*
 * table, and dropping an entry would silently shift `implication`,
 * `condition`, `module` and everything after it one place earlier, changing
 * the bytes of every response that carries two of them.
 *
 * # Compactness
 *
 * `Spaces 0` means aeson-pretty emits no whitespace: `{"k":v,"k2":v2}` and
 * `[a,b]`. That happens to be exactly `JSON.stringify`'s compact form, so the
 * only thing this module changes is the key order — and, as in
 * `@kframework-ts/kore`'s `json.ts`, the fact that it walks an explicit stack
 * and therefore does not blow the call stack on a real EVM configuration.
 *
 * The trailing newline is **not** added here: it belongs to the transport,
 * which frames responses with it, and a caller embedding one response inside
 * another document must not inherit it.
 */

import type { JsonArray, JsonObject, JsonValue } from "@kframework-ts/kore";
import { describe, isArray, rpcError } from "./internal.js";

/**
 * `PrettyJson.keyOrder`'s argument, verbatim from `Types.hs:303-341`.
 *
 * Reading it top to bottom is reading the protocol's own idea of what matters
 * first: the KORE-JSON envelope, then pattern structure, then the JSON-RPC
 * envelope, then execute results, then implies, then the error object, then
 * the context log.
 */
export const RPC_KEY_ORDER: readonly string[] = [
  "format",
  "version",
  "term",
  "tag",
  "assoc",
  "name",
  "symbol",
  "argSort",
  "sort",
  "sorts",
  "var",
  "varSort",
  "arg",
  "args",
  "argss",
  "source",
  "dest",
  "value",
  "jsonrpc",
  "id",
  "reason",
  "depth",
  "rule",
  "state",
  "next-states",
  "substitution",
  "predicate",
  // Dead since `ImpliesResult.valid` became `status`; kept because the list is
  // positional.  See the header.
  "valid",
  "implication",
  "condition",
  "module",
  "step-timeout",
  "moving-average-step-timeout",
  "code",
  "data",
  "timestamp",
  "context",
  "message",
];

/** `key → index`, built once. `RPC_KEY_ORDER` has no duplicates, so this is total. */
const KEY_INDEX: ReadonlyMap<string, number> = new Map(RPC_KEY_ORDER.map((key, i) => [key, i]));

/**
 * The comparator `rpcJsonConfig` installs: listed keys by position, then
 * unlisted keys ascending.
 *
 * Exported because a caller may want to sort keys without serializing — a
 * structural golden comparison, say, or a diff of two recorded payloads.
 */
export function compareRpcKeys(a: string, b: string): number {
  const ia = KEY_INDEX.get(a);
  const ib = KEY_INDEX.get(b);
  if (ia !== undefined && ib !== undefined) return ia - ib;
  if (ia !== undefined) return -1;
  if (ib !== undefined) return 1;
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

/** One `[key, value]` pair of an object being emitted, pre-sorted. */
type Entry = readonly [string, JsonValue];

/** A stack item: literal text to append, or a value still to render at `path`. */
type Emit = { readonly lit: string } | { readonly val: JsonValue; readonly path: string };

/**
 * One scalar's text, or this package's error if it has none.
 *
 * `JSON.stringify` has three failure modes worth distinguishing from a valid
 * `null`: it returns `undefined` for a function or a `symbol`, it throws a
 * `TypeError` for a `bigint`, and it returns whatever a `toJSON` method
 * produced — which is why the caller checks for `toJSON` before it gets here.
 */
function scalar(value: unknown, path: string): string {
  let text: string | undefined;
  try {
    text = JSON.stringify(value);
  } catch (error) {
    throw rpcError(
      `Cannot emit ${describe(value)} as JSON: ${error instanceof Error ? error.message : String(error)}`,
      path,
    );
  }
  if (text === undefined) throw rpcError(`Cannot emit ${describe(value)} as JSON`, path);
  return text;
}

/**
 * Serialize a JSON value the way a kore-rpc server would.
 *
 * No indentation, no spaces, keys ordered by {@link compareRpcKeys} at every
 * depth, and no trailing newline. Scalars are handed to `JSON.stringify` one
 * at a time — that call cannot recurse, and it is the correct string escaper.
 *
 * An `undefined` inside an array becomes `null`, as `JSON.stringify` does; an
 * `undefined` *property* is skipped, also as `JSON.stringify` does, which is
 * the last line of defence behind `OmitNothingFields`.
 *
 * A value that is **not JSON** — a function, a `symbol`, an object carrying a
 * `toJSON`, a `bigint` — is a {@link SyntaxError} naming the path and the kind,
 * not a silent corruption. `JSON.stringify` returns `undefined` for the first
 * two and throws a raw `TypeError` for the last, and a walker that appended
 * either would emit `{"a":}` or `` — output that is not a JSON document at all,
 * from a module whose entire purpose is byte-exactness. The type says
 * {@link JsonValue}; this is what happens when the type was a promise the
 * caller did not keep.
 */
export function emitOrdered(value: JsonValue): string {
  const out: string[] = [];
  const stack: Emit[] = [{ val: value, path: "$" }];
  for (;;) {
    const item = stack.pop();
    if (item === undefined) return out.join("");

    if ("lit" in item) {
      out.push(item.lit);
      continue;
    }

    const v = item.val;
    if (v === null || typeof v !== "object") {
      out.push(scalar(v, item.path));
      continue;
    }

    if (isArray(v)) {
      const array: JsonArray = v;
      out.push("[");
      stack.push({ lit: "]" });
      for (let i = array.length - 1; i >= 0; i--) {
        const element = array[i];
        stack.push({ val: element === undefined ? null : element, path: `${item.path}[${i}]` });
        if (i > 0) stack.push({ lit: "," });
      }
      continue;
    }

    // An object with a `toJSON` is not the object it claims to be: the
    // stringifier would replace it wholesale, so walking its keys would emit
    // something the same call would never have produced. `Date` is the common
    // case, and a `Date` in a kore-rpc payload is a bug in the caller.
    if (typeof (v as { toJSON?: unknown }).toJSON === "function") {
      throw rpcError("Cannot emit an object with a toJSON method as JSON", item.path);
    }

    const entries = orderedEntries(v);
    out.push("{");
    stack.push({ lit: "}" });
    for (let i = entries.length - 1; i >= 0; i--) {
      const entry = entries[i];
      if (entry === undefined) continue;
      stack.push({ val: entry[1], path: `${item.path}.${entry[0]}` }, { lit: `${JSON.stringify(entry[0])}:` });
      if (i > 0) stack.push({ lit: "," });
    }
  }
}

/** An object's own enumerable pairs, sorted, with `undefined` values dropped. */
function orderedEntries(obj: JsonObject): readonly Entry[] {
  const entries: Entry[] = [];
  for (const key of Object.keys(obj)) {
    const value = obj[key];
    if (value === undefined) continue;
    entries.push([key, value]);
  }
  entries.sort((a, b) => compareRpcKeys(a[0], b[0]));
  return entries;
}
