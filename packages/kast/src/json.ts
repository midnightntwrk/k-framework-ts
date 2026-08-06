/**
 * The KAST v4 JSON codec — `KInner.to_dict` / `KInner.from_dict` and the
 * `{format: "KAST", version: 4, term}` envelope, transcribed from
 * `pyk/kast/inner.py:141-245` and `pyk/kast/kast.py:49-56` at K v7.1.337.
 *
 * # Strict, with a path
 *
 * This is the *definition*-flavour contract of `@kframework-ts/kast-json`, not
 * the term-flavour one: a malformed input throws a `SyntaxError` naming the
 * JSON path of the offending node (`term.args.2.label.params.0.name`).  An
 * algebra's terms must be well-formed — you are about to compute with them —
 * so degrading a bad node to something inert would only move the failure
 * somewhere less informative.  pyk agrees and is simply cruder about it: its
 * `from_dict` does `globals()[dct['node']]` (`inner.py:158`) and dies with an
 * uncontrolled `KeyError`.
 *
 * # Unknown keys are ignored, always
 *
 * pyk emits `arity` **and** `variable: false` on a `KApply`; the Java
 * `ToJson` emits `arity` only.  That is a permanent difference between two
 * producers of the same format, not version skew, so no reader may enumerate
 * the keys a node is allowed to have.  This codec reads only the keys it
 * needs, and {@link toDict} emits pyk's set so that a `to_dict` here is
 * byte-comparable with a `to_dict` there — which is what
 * `@kframework-ts/kast`'s hash parity depends on.
 *
 * # The five shape quirks, all transcribed
 *
 * | node        | quirk                                                      |
 * | ----------- | ---------------------------------------------------------- |
 * | `KApply`    | emits `arity` and `variable: false` (`inner.py:406-413`)    |
 * | `KSequence` | emits `arity` (`inner.py:634-635`)                          |
 * | `KVariable` | omits `sort` *entirely* when unsorted (`inner.py:327-332`)  |
 * | `KSort`     | tolerates a missing `params` on read (`inner.py:43`)        |
 * | `KSequence` | re-flattens on read, via `ksequence` (`inner.py:631-632`)   |
 *
 * # Nothing recurses
 *
 * Both directions run on explicit work stacks (`inner.py:145-181` and
 * `226-243` do the same), so a 100k-deep term round-trips without a
 * `RangeError`.
 */

import { KAST_FORMAT, KAST_VERSION } from "./version.js";
import {
  kapply,
  kas,
  klabel,
  krewrite,
  ksequence,
  ksort,
  ktoken,
  kvariable,
  type KInner,
  type KLabel,
  type KSort,
} from "./inner.js";

//////////////////////
// JSON values      //
//////////////////////

/** A JSON array, as an interface so the recursive alias below is legal. */
export interface JsonArray extends ReadonlyArray<JsonValue> {}

/** A JSON object. */
export interface JsonObject {
  readonly [key: string]: JsonValue;
}

/** Any value `JSON.parse` can produce and `JSON.stringify` can consume. */
export type JsonValue = null | boolean | number | string | JsonArray | JsonObject;

//////////////////////
// Errors           //
//////////////////////

/** The path an envelope-level error reports, above `format`/`version`/`term`. */
const DOCUMENT_ROOT = "<document>";

/** `message (at path)` — the `kast-json` `definition.ts:400-405` convention. */
function jsonError(message: string, path: string): SyntaxError {
  return new SyntaxError(`${message} (at ${path})`);
}

/**
 * How a bad value is named in a message: the *value* for scalars, the *shape*
 * for containers — a 4 MB term spliced into an exception is not a diagnostic.
 */
function describe(value: unknown): string {
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") return String(value);
  if (value === undefined) return "nothing";
  if (value === null) return "null";
  if (typeof value === "symbol") return value.toString();
  if (typeof value === "function") return "a function";
  return isArray(value) ? "an array" : "an object";
}

/** `Array.isArray` with a predicate that does not launder its argument into `any[]`. */
function isArray(value: unknown): value is readonly unknown[] {
  return Array.isArray(value);
}

/** A non-null, non-array JSON object. Written as a predicate so no cast is needed. */
function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !isArray(value);
}

function asObject(value: unknown, path: string): Readonly<Record<string, unknown>> {
  if (!isRecord(value)) throw jsonError(`Expected an object, got ${describe(value)}`, path);
  return value;
}

function asArray(value: unknown, path: string): readonly unknown[] {
  if (!isArray(value)) throw jsonError(`Expected an array, got ${describe(value)}`, path);
  return value;
}

function asString(value: unknown, path: string): string {
  if (typeof value !== "string") throw jsonError(`Expected a string, got ${describe(value)}`, path);
  return value;
}

/** Read a required field, reporting its absence rather than its type. */
function field(obj: Readonly<Record<string, unknown>>, name: string, path: string, node: string): unknown {
  if (!Object.hasOwn(obj, name)) {
    throw jsonError(`${node} is missing the field ${JSON.stringify(name)}`, path);
  }
  return obj[name];
}

/** Index into an array whose bounds the caller has already established. */
function at<T>(xs: readonly T[], i: number): T {
  const x = xs[i];
  if (x === undefined) throw new RangeError(`Index ${i} is out of range (length ${xs.length})`);
  return x;
}

/** Prove at compile time that a `switch` over `KInner` is exhaustive. */
function exhausted(value: never): never {
  throw new TypeError(`Unhandled KAST node: ${JSON.stringify(value)}`);
}

//////////////////////
// Sorts and labels //
//////////////////////

/** `KSort.to_dict` (`inner.py:46-47`). `params` is always emitted, even empty. */
export function sortToDict(sort: KSort): JsonObject {
  // Stack-based: a parametric sort's parameters are themselves sorts, and
  // nothing bounds how deep `Map{Map{Map{...}}}` goes.
  interface OutFrame {
    readonly sort: KSort;
    readonly done: JsonValue[];
  }
  const stack: OutFrame[] = [{ sort, done: [] }];
  for (;;) {
    const top = stack.pop();
    if (top === undefined) throw new RangeError("sortToDict: empty work stack");
    const next = top.sort.params[top.done.length];
    if (next !== undefined) {
      stack.push(top, { sort: next, done: [] });
      continue;
    }
    const built: JsonObject = { node: "KSort", name: top.sort.name, params: top.done };
    const parent = stack.pop();
    if (parent === undefined) return built;
    parent.done.push(built);
    stack.push(parent);
  }
}

/**
 * `KSort.from_dict` (`inner.py:39-44`).
 *
 * `params` is optional — pyk reads it with `d.get('params', ())` — which is
 * what lets a v4 reader accept the sort shape a v3 producer wrote.  `node` is
 * not checked, because pyk does not check it.
 */
export function sortFromDict(value: unknown, path = "sort"): KSort {
  interface InFrame {
    readonly name: string;
    readonly params: readonly unknown[];
    readonly path: string;
    readonly done: KSort[];
  }

  const enter = (raw: unknown, where: string): InFrame => {
    const obj = asObject(raw, where);
    const name = asString(field(obj, "name", where, "KSort"), `${where}.name`);
    const rawParams = obj["params"];
    return {
      name,
      params: rawParams === undefined ? [] : asArray(rawParams, `${where}.params`),
      path: where,
      done: [],
    };
  };

  const stack: InFrame[] = [enter(value, path)];
  for (;;) {
    const top = stack.pop();
    if (top === undefined) throw new RangeError("sortFromDict: empty work stack");
    const idx = top.done.length;
    if (idx < top.params.length) {
      stack.push(top, enter(at(top.params, idx), `${top.path}.params.${idx}`));
      continue;
    }
    const built = ksort(top.name, top.done);
    const parent = stack.pop();
    if (parent === undefined) return built;
    parent.done.push(built);
    stack.push(parent);
  }
}

/** `KLabel.to_dict` (`inner.py:112-113`). */
export function labelToDict(label: KLabel): JsonObject {
  return { node: "KLabel", name: label.name, params: label.params.map(sortToDict) };
}

/**
 * `KLabel.from_dict` (`inner.py:108-110`).
 *
 * `params` is **required** here where it is optional on a `KSort`: pyk reads
 * it with `d['params']` and raises `KeyError` when it is absent.  The
 * asymmetry is upstream's, transcribed rather than smoothed over.
 */
export function labelFromDict(value: unknown, path = "label"): KLabel {
  const obj = asObject(value, path);
  const name = asString(field(obj, "name", path, "KLabel"), `${path}.name`);
  const params = asArray(field(obj, "params", path, "KLabel"), `${path}.params`);
  return klabel(
    name,
    params.map((param, i) => sortFromDict(param, `${path}.params.${i}`)),
  );
}

//////////////////////
// Terms: write     //
//////////////////////

/** Build one node's dict from the node and its already-encoded children. */
function buildDict(term: KInner, children: readonly JsonValue[]): JsonObject {
  switch (term.node) {
    case "KToken":
      return { node: "KToken", token: term.token, sort: sortToDict(term.sort) };
    case "KVariable": {
      // The `sort` key is absent, not null, when the variable is unsorted.
      if (term.sort === undefined) return { node: "KVariable", name: term.name };
      return { node: "KVariable", name: term.name, sort: sortToDict(term.sort) };
    }
    case "KApply":
      return {
        node: "KApply",
        label: labelToDict(term.label),
        args: children,
        arity: children.length,
        variable: false,
      };
    case "KAs":
      return { node: "KAs", pattern: at(children, 0), alias: at(children, 1) };
    case "KRewrite":
      return { node: "KRewrite", lhs: at(children, 0), rhs: at(children, 1) };
    case "KSequence":
      return { node: "KSequence", items: children, arity: children.length };
    default:
      return exhausted(term);
  }
}

/** The subterms a node encodes, in emission order. Mirrors `inner.py:187-191`. */
function childrenOf(term: KInner): readonly KInner[] {
  switch (term.node) {
    case "KToken":
    case "KVariable":
      return [];
    case "KApply":
      return term.args;
    case "KAs":
      return [term.pattern, term.alias];
    case "KRewrite":
      return [term.lhs, term.rhs];
    case "KSequence":
      return term.items;
    default:
      return exhausted(term);
  }
}

/** `KInner.to_dict` (`inner.py:226-243`), on an explicit stack. */
export function toDict(term: KInner): JsonObject {
  interface OutFrame {
    readonly term: KInner;
    readonly children: readonly KInner[];
    readonly done: JsonValue[];
  }
  const stack: OutFrame[] = [{ term, children: childrenOf(term), done: [] }];
  for (;;) {
    const top = stack.pop();
    if (top === undefined) throw new RangeError("toDict: empty work stack");
    const next = top.children[top.done.length];
    if (next !== undefined) {
      stack.push(top, { term: next, children: childrenOf(next), done: [] });
      continue;
    }
    const built = buildDict(top.term, top.done);
    const parent = stack.pop();
    if (parent === undefined) return built;
    parent.done.push(built);
    stack.push(parent);
  }
}

//////////////////////
// Terms: read      //
//////////////////////

/** A node whose children are still being decoded. */
interface ReadFrame {
  readonly obj: Readonly<Record<string, unknown>>;
  readonly node: string;
  readonly path: string;
  /** The raw child values, in the order they will be rebuilt. */
  readonly kids: readonly unknown[];
  /** The JSON path of each raw child, parallel to {@link kids}. */
  readonly kidPaths: readonly string[];
  readonly done: KInner[];
}

/**
 * `KInner._extract_dicts` (`inner.py:169-181`), plus the path bookkeeping pyk
 * has no use for.
 */
function enterTerm(value: unknown, path: string): ReadFrame {
  const obj = asObject(value, path);
  const node = asString(field(obj, "node", path, "A KAST node"), `${path}.node`);

  const arrayChildren = (key: string): ReadFrame => {
    const kids = asArray(field(obj, key, path, node), `${path}.${key}`);
    return { obj, node, path, kids, kidPaths: kids.map((_, i) => `${path}.${key}.${i}`), done: [] };
  };
  const pairChildren = (first: string, second: string): ReadFrame => ({
    obj,
    node,
    path,
    kids: [field(obj, first, path, node), field(obj, second, path, node)],
    kidPaths: [`${path}.${first}`, `${path}.${second}`],
    done: [],
  });

  switch (node) {
    case "KToken":
    case "KVariable":
      return { obj, node, path, kids: [], kidPaths: [], done: [] };
    case "KApply":
      return arrayChildren("args");
    case "KSequence":
      return arrayChildren("items");
    case "KRewrite":
      return pairChildren("lhs", "rhs");
    case "KAs":
      return pairChildren("pattern", "alias");
    default:
      throw jsonError(`Unknown KAST node ${JSON.stringify(node)}`, `${path}.node`);
  }
}

/** Rebuild one node from its decoded children — the per-class `_from_dict`. */
function buildTerm(frame: ReadFrame): KInner {
  const { obj, path, done } = frame;
  switch (frame.node) {
    case "KToken":
      return ktoken(
        asString(field(obj, "token", path, "KToken"), `${path}.token`),
        sortFromDict(field(obj, "sort", path, "KToken"), `${path}.sort`),
      );
    case "KVariable": {
      const name = asString(field(obj, "name", path, "KVariable"), `${path}.name`);
      // `inner.py:322-324`: the key's *presence* decides, so a `sort` that is
      // there but malformed is an error, not an unsorted variable.
      if (!Object.hasOwn(obj, "sort")) return kvariable(name);
      return kvariable(name, sortFromDict(obj["sort"], `${path}.sort`));
    }
    case "KApply":
      // `arity` and `variable` are read past: they are redundant with `args`,
      // and where the two disagree the array is the data.
      return kapply(labelFromDict(field(obj, "label", path, "KApply"), `${path}.label`), done);
    case "KSequence":
      // Flattens, exactly as `KSequence(items=terms)` does upstream.
      return ksequence(done);
    case "KRewrite":
      return krewrite(at(done, 0), at(done, 1));
    case "KAs":
      return kas(at(done, 0), at(done, 1));
    default:
      throw jsonError(`Unknown KAST node ${JSON.stringify(frame.node)}`, `${path}.node`);
  }
}

/**
 * `KInner.from_dict` (`inner.py:145-167`), on an explicit stack.
 *
 * `path` names the root for error messages; it defaults to `"term"`, which is
 * where {@link kastTerm} puts a term, so a message reads the same whether the
 * term came out of an envelope or arrived on its own.
 */
export function fromDict(value: unknown, path = "term"): KInner {
  const stack: ReadFrame[] = [enterTerm(value, path)];
  for (;;) {
    const top = stack.pop();
    if (top === undefined) throw new RangeError("fromDict: empty work stack");
    const idx = top.done.length;
    if (idx < top.kids.length) {
      stack.push(top, enterTerm(at(top.kids, idx), at(top.kidPaths, idx)));
      continue;
    }
    const built = buildTerm(top);
    const parent = stack.pop();
    if (parent === undefined) return built;
    parent.done.push(built);
    stack.push(parent);
  }
}

/** Read a term from a JSON string. `KInner.from_json` (`inner.py:141-143`). */
export function fromJson(text: string): KInner {
  return fromDict(JSON.parse(text));
}

//////////////////////
// Envelope         //
//////////////////////

/**
 * Unwrap `{format: "KAST", version: 4, term}` (`kast.py:49-56`), returning the
 * **raw** term value.
 *
 * That is what pyk's `kast_term` returns — a mapping, not a `KInner` — and
 * keeping the two steps separate is deliberate: the envelope check and the
 * term decode fail for unrelated reasons, and a caller that has already
 * validated the envelope should not pay for it again.  Pipe the result into
 * {@link fromDict}.
 *
 * `version` is compared with `!==` against the number `4`, matching pyk's
 * `dct['version'] != KAst.version()` exactly: the *string* `"4"` is refused,
 * and so is `3` — a v3 document is not a v4 document that may be read
 * leniently (see `version.ts`).
 */
export function kastTerm(doc: unknown): unknown {
  const obj = asObject(doc, DOCUMENT_ROOT);

  const format = field(obj, "format", DOCUMENT_ROOT, "A KAST document");
  if (format !== KAST_FORMAT) {
    throw jsonError(`Invalid format: expected ${JSON.stringify(KAST_FORMAT)}, got ${describe(format)}`, "format");
  }

  const version = field(obj, "version", DOCUMENT_ROOT, "A KAST document");
  if (version !== KAST_VERSION) {
    throw jsonError(`Invalid version: expected ${KAST_VERSION}, got ${describe(version)}`, "version");
  }

  return field(obj, "term", DOCUMENT_ROOT, "A KAST document");
}

/** Wrap a term in the KAST v4 envelope. The direction pyk has no function for. */
export function kastTermToDict(term: KInner): JsonObject {
  return { format: KAST_FORMAT, version: KAST_VERSION, term: toDict(term) };
}
