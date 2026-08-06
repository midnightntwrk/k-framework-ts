/**
 * The KORE-JSON codec — `{"format": "KORE", "version": 1, "term": …}`.
 *
 * Transcribed from the normative wire type,
 * `haskell-backend/kore-rpc-types/src/Kore/Syntax/Json/Types.hs` (380 L, the
 * whole file), cross-checked against pyk's reader
 * (`k/pyk/src/pyk/kore/syntax.py`: `Pattern._TAGS` 195-225,
 * `Pattern.from_dict` 226-249, `Pattern.dict` 274-296, `kore_term` 2266-2273)
 * and against the vendored machine schema `fixtures/kore-schema.json`.
 *
 * KORE-JSON encodes **patterns only**. There is no JSON form of a module, a
 * sentence or a definition, which is why nothing below mentions them.
 *
 * # The field names are the whole difficulty
 *
 * Every trap in this format is a name that disagrees with the AST, with the
 * textual grammar, or with a neighbouring tag. They are transcribed from the
 * `KJ*` constructors at `Types.hs:74-215` and from `Sort` at `Types.hs:360-368`:
 *
 * | node                        | JSON                              | AST (`syntax.ts`)           |
 * | --------------------------- | --------------------------------- | --------------------------- |
 * | `SortApp`                   | `name`, **`args`**                | `name`, `sorts`             |
 * | `App`                       | **`name`**, `sorts`, `args`       | `symbol`, `sorts`, `args`   |
 * | `LeftAssoc`/`RightAssoc`    | `symbol`, `sorts`, **`argss`**    | `symbol`, `sorts`, `args`   |
 * | `MultiOr`                   | `assoc`, `sort`, **`argss`**      | `assoc`, `sort`, `patterns` |
 * | `Exists`/`Forall`           | `sort`, **`var`**, **`varSort`**, `arg` | `sort`, `var: EVar`, `pattern` |
 * | `Mu`/`Nu`                   | `var`, `varSort`, `arg` (**no `sort`**) | `var: SVar`, `pattern` |
 * | `Ceil`/`Floor`              | **`argSort`**, `sort`, `arg`      | `opSort`, `sort`, `pattern` |
 * | `Equals`/`In`               | `argSort`, `sort`, `first`, `second` | `opSort`, `sort`, `left`, `right` |
 * | `Not`                       | `sort`, **`arg`**                 | `sort`, `pattern`           |
 * | `Implies`/`Iff`             | `sort`, `first`, `second`         | `sort`, `left`, `right`     |
 * | `Next`                      | `sort`, **`dest`**                | `sort`, `pattern`           |
 * | `Rewrites`                  | `sort`, `source`, `dest`          | `sort`, `left`, `right`     |
 * | `DV`                        | `sort`, `value` (**a raw string**) | `sort`, `value: KoreString` |
 * | `String`                    | `value` (a raw string)            | `value`                     |
 *
 * Two of those deserve to be read twice. A sort's children are `args` while an
 * application's *sorts* are `sorts` and its children are `args` — so the word
 * `args` means two different things one level apart. And `MultiOr` spells its
 * pattern list `argss`, exactly like `LeftAssoc`/`RightAssoc` and unlike
 * `And`/`Or`, which spell theirs `patterns` (`Types.hs:196-214`; the schema
 * agrees, `kore-schema.json:421-444`).
 *
 * # Strictness: unknown fields are errors
 *
 * `codecOptions` (`Types.hs:223-236`) sets `rejectUnknownFields = True`, so a
 * tagged object carrying a field that does not belong to its constructor is a
 * *decode failure*, not something to ignore. This module does the same, and it
 * is a deliberate difference from `@kframework-ts/kast-json`, whose term reader
 * ignores unknown keys because KAST-JSON is an open format that gains fields
 * between K releases. KORE-JSON is a closed RPC wire format with one version
 * that has never changed, and its reference decoder rejects; so do we.
 *
 * The **envelope** is the exception, and that too is transcribed rather than
 * chosen: `KoreJson` derives its instances with `deriving anyclass (ToJSON,
 * FromJSON)` (`Types.hs:27-33`), i.e. with aeson's `defaultOptions`, where
 * `rejectUnknownFields` is `False`. An extra key beside `format`/`version`/
 * `term` is therefore accepted upstream, and accepted here.
 *
 * # Lexical checks
 *
 * `lexicalCheck` (`Types.hs:265-298`) runs after decoding each node and is
 * explicitly *shallow*: it checks the identifier of the node itself, per tag.
 * {@link patternFromJson} performs the same eight checks, using `syntax.ts`'s
 * `isId`/`isSetVarId`/`isSymbolId`.
 *
 * Two divergences, both narrowing:
 *
 * - `checkIdChars` (`Types.hs:327-340`) tests the first character with
 *   `Data.Char.isAlpha`, which is **Unicode-aware** — upstream accepts `\xe9` as
 *   a variable name. Our `isId` is the ASCII `^[a-zA-Z][0-9a-zA-Z'-]*$` of the
 *   textual grammar, of pyk's `Id`, and of the schema's `KoreJSONId`
 *   (`kore-schema.json:152-155`). Three of the four upstream artifacts agree
 *   with us; the fourth would emit KORE text that its own parser rejects.
 * - Sort names are **not** checked, by us or by upstream: `lexicalCheck` has no
 *   `Sort` case and `Sort`'s `FromJSON` is a bare `genericParseJSON`
 *   (`Types.hs:373-374`). The schema *does* constrain them
 *   (`kore-schema.json:497-524`), so a decoded sort name can be one the schema
 *   would reject. This is upstream's inconsistency, transcribed rather than
 *   silently repaired; `sortVar`/`sortApp` in `syntax.ts` validate if you want
 *   validation.
 *
 * The latin-1 restriction on `String` and `DV` values (`checkLatin1Range`,
 * `Types.hs:315-320` — "to properly support byte arrays … we restrict text
 * values to latin-1") is upstream's *only* value-level check, and it is behind
 * {@link JsonOptions.latin1}, defaulting to **off**. pyk does not enforce it at
 * all, and a decoder that rejects a document the sender's own encoder produced
 * is worse than a lenient one; turn it on when you are the one producing
 * documents for the Haskell backend to read.
 *
 * # Legacy two-field `And`/`Or` form
 *
 * `modifyAndOr`/`flattenAndOr` (`Types.hs:245-263`) rewrite `{"tag": "And",
 * "sort": S, "first": P, "second": Q}` into the n-ary
 * `{"tag": "And", "sort": S, "patterns": [P, Q]}` *before* the generic decoder
 * runs. We do the same, on decode only; {@link patternToJson} emits `patterns`
 * unconditionally. Note the quirk this inherits: `flattenAndOr` **rebuilds**
 * the object from four keys, so an unknown extra key on a legacy two-field `And`
 * is dropped instead of rejected — `rejectUnknownFields` never sees it. That is
 * faithfully reproduced below.
 *
 * # Arity is preserved
 *
 * `KJAnd`/`KJOr` hold a plain list (`Types.hs:110-117`), so `{"patterns": []}`
 * and `{"patterns": [P]}` decode to 0-ary and 1-ary nodes and re-encode
 * unchanged. The collapse to `\top` / to the single operand lives one layer
 * further in, in `kore/src/Kore/Syntax/Json/Internal.hs:63-64`
 * (`KJAnd s [] -> KJTop s`, `KJAnd _ [p] -> p`), which is the JSON→internal-Kore
 * *conversion*, not the codec. Types.hs is what this module transcribes, and
 * pyk agrees with Types.hs.
 *
 * # Nothing here recurses
 *
 * Both directions run on explicit work stacks (pyk's `from_dict`/`dict`
 * technique), including the sort codec, so a 100_000-deep term is not a
 * `RangeError`. One host limitation survives: `JSON.parse` is iterative in
 * JavaScriptCore but `JSON.stringify` is **not** (it throws `RangeError` past
 * roughly 10k frames), which is why {@link encodeKoreJson} serializes with its
 * own stack-based writer instead of calling `JSON.stringify` on the term.
 *
 * # Errors
 *
 * Every decode failure throws `SyntaxError` — a KORE-JSON document is an
 * artifact that either reads or does not — with the offending JSON path
 * appended, `kast-json`-definition style: `… (at term.patterns.3.sort.args.0)`.
 * Encoding an AST that no constructor in `syntax.ts` can produce (an empty
 * `LeftAssoc`, a node missing a subpattern) throws `TypeError`, matching that
 * module.
 */

import {
  type And,
  type App,
  type Bottom,
  type Ceil,
  type DV,
  type EVar,
  type Equals,
  type Exists,
  type Floor,
  type Forall,
  type Iff,
  type Implies,
  type In,
  type KoreString,
  type LeftAssoc,
  type MultiOr,
  type Mu,
  type Next,
  type Not,
  type Nu,
  type Or,
  type Pattern,
  type Rewrites,
  type RightAssoc,
  type SVar,
  type Sort,
  type Top,
  isId,
  isSetVarId,
  isSymbolId,
  patterns,
} from "./syntax.js";

//////////////////////
// JSON values      //
//////////////////////

/** A JSON array, as an interface so that the recursive alias below is legal. */
export interface JsonArray extends ReadonlyArray<JsonValue> {}

/** A JSON object. */
export interface JsonObject {
  readonly [key: string]: JsonValue;
}

/** Any value `JSON.parse` can produce and `JSON.stringify` can consume. */
export type JsonValue = null | boolean | number | string | JsonArray | JsonObject;

/** `Array.isArray` as a guard that keeps the `readonly`. */
function isJsonArray(value: JsonValue): value is JsonArray {
  return Array.isArray(value);
}

//////////////////////
// Envelope         //
//////////////////////

/**
 * The only legal `format` — `Types.hs:35-43`, where `KORE` is a one-constructor
 * type whose `FromJSON` is `expect "KORE"`.
 */
export const KORE_JSON_FORMAT = "KORE";

/**
 * The only legal `version` — `Types.hs:45-61`. `Version` is an enum with the
 * single constructor `KJ1`; no other number has ever existed, and a document
 * claiming one is not a KORE-JSON document we may read part of.
 */
export const KORE_JSON_VERSION = 1;

/** A decoded KORE-JSON document — `KoreJson` (`Types.hs:27-33`). */
export interface KoreJson {
  readonly format: typeof KORE_JSON_FORMAT;
  readonly version: typeof KORE_JSON_VERSION;
  readonly term: Pattern;
}

/** Decoder knobs. Both default to the lenient/conventional choice. */
export interface JsonOptions {
  /**
   * Enforce `checkLatin1Range` (`Types.hs:315-320`) on `String` and `DV`
   * values: reject any code point above U+00FF.
   *
   * Off by default. The Haskell reference always enforces it; pyk never does.
   * Turn it on when the document is bound for the Haskell backend.
   */
  readonly latin1?: boolean;

  /**
   * The JSON path errors are reported under. Defaults to `"term"`, which is
   * where the envelope puts a pattern, so a message reads
   * `… (at term.patterns.3.sort.args.0)` whether the pattern was decoded
   * through {@link decodeKoreJson} or on its own.
   */
  readonly path?: string;
}

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
 * How a bad value is named in a message.
 *
 * Deliberately shows the *value* for scalars and only the *shape* for
 * containers: a 4 MB term spliced into an exception is not a diagnostic.
 */
function describe(value: unknown): string {
  // Scalars first, and each `String()` argument narrowed before it is passed:
  // `String(x)` on an unnarrowed `unknown` is how `[object Object]` ends up in
  // an error message.
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

//////////////////////
// Tag tables       //
//////////////////////

/** The 25 KORE-JSON pattern tags. Identical to the AST's `tag` values by design. */
type PatternTag = Pattern["tag"];

/**
 * Every field a tag owns, besides `tag` — the record fields of each `KJ*`
 * constructor, in `Types.hs` declaration order (`Types.hs:74-215`).
 *
 * This table is load-bearing three times over: it is the *required* set (a
 * missing field is an error), the *permitted* set (`rejectUnknownFields`,
 * `Types.hs:231`), and the key order {@link patternToJson} emits in.
 */
const PATTERN_FIELDS = {
  EVar: ["name", "sort"],
  SVar: ["name", "sort"],
  App: ["name", "sorts", "args"],
  String: ["value"],
  Top: ["sort"],
  Bottom: ["sort"],
  Not: ["sort", "arg"],
  And: ["sort", "patterns"],
  Or: ["sort", "patterns"],
  Implies: ["sort", "first", "second"],
  Iff: ["sort", "first", "second"],
  Forall: ["sort", "var", "varSort", "arg"],
  Exists: ["sort", "var", "varSort", "arg"],
  Mu: ["var", "varSort", "arg"],
  Nu: ["var", "varSort", "arg"],
  Ceil: ["argSort", "sort", "arg"],
  Floor: ["argSort", "sort", "arg"],
  Equals: ["argSort", "sort", "first", "second"],
  In: ["argSort", "sort", "first", "second"],
  Next: ["sort", "dest"],
  Rewrites: ["sort", "source", "dest"],
  DV: ["sort", "value"],
  MultiOr: ["assoc", "sort", "argss"],
  LeftAssoc: ["symbol", "sorts", "argss"],
  RightAssoc: ["symbol", "sorts", "argss"],
} as const satisfies Readonly<Record<PatternTag, readonly string[]>>;

/**
 * Which fields hold subpatterns — pyk `Pattern._TAGS` (`syntax.py:195-225`),
 * with pyk's own encoding of the two cases: a **string** names one field
 * holding a *list* of patterns, an **array** names the fields each holding
 * *one* pattern.
 *
 * The three `argss` entries are ours: pyk has `LeftAssoc`/`RightAssoc` and no
 * `MultiOr` at all, so a KORE-JSON document containing `MultiOr` is one pyk
 * cannot read (`syntax.py:195-225` has no such key, and `from_dict` would
 * `KeyError`).
 *
 * A quantifier's bound variable is *not* here, matching pyk (`'Exists':
 * ['arg']`): `var`/`varSort` are a name and a sort, not a pattern node, and the
 * `EVar`/`SVar` the AST holds is synthesized from them.
 */
const PATTERN_KIDS = {
  EVar: [],
  SVar: [],
  App: "args",
  String: [],
  Top: [],
  Bottom: [],
  Not: ["arg"],
  And: "patterns",
  Or: "patterns",
  Implies: ["first", "second"],
  Iff: ["first", "second"],
  Forall: ["arg"],
  Exists: ["arg"],
  Mu: ["arg"],
  Nu: ["arg"],
  Ceil: ["arg"],
  Floor: ["arg"],
  Equals: ["first", "second"],
  In: ["first", "second"],
  Next: ["dest"],
  Rewrites: ["source", "dest"],
  DV: [],
  MultiOr: "argss",
  LeftAssoc: "argss",
  RightAssoc: "argss",
} as const satisfies Readonly<Record<PatternTag, string | readonly string[]>>;

/**
 * The three tags whose pattern list is a `NE.NonEmpty` upstream
 * (`Types.hs:199`, `207`, `213`) — aeson's `FromJSON` for `NonEmpty` rejects
 * `[]`, and `kore-schema.json` says `minItems: 1` in the same three places.
 */
const NON_EMPTY_TAGS: ReadonlySet<string> = new Set(["MultiOr", "LeftAssoc", "RightAssoc"]);

/**
 * Whether an untrusted string from a document names a pattern tag.
 *
 * `PATTERN_FIELDS` is the authority: a tag exists exactly when it has a field
 * list, so the two can never drift apart.
 */
function isPatternTag(tag: string): tag is PatternTag {
  return Object.hasOwn(PATTERN_FIELDS, tag);
}

//////////////////////
// Lexical checks   //
//////////////////////

/**
 * `reportErrors` (`Types.hs:300-314`) — one message per node, naming the kind
 * of identifier and quoting it.
 *
 * We report "a lexical error happened" where Haskell enumerates *which*
 * characters offended; the enumeration is a message-text detail and the
 * position (the JSON path) is the part a caller can act on.
 */
function checkLexical(name: string, kind: string, ok: (s: string) => boolean, path: string): string {
  if (!ok(name)) throw jsonError(`Lexical error in ${kind}: ${JSON.stringify(name)}`, path);
  return name;
}

/**
 * `checkLatin1Range` (`Types.hs:315-320`), gated on {@link JsonOptions.latin1}.
 *
 * Iterates code points (`for…of`), like Haskell's `Text` filter over `Char` and
 * unlike a `charCodeAt` loop, so an astral character is reported once as itself
 * rather than twice as its surrogates.
 */
function checkLatin1(text: string, kind: string, path: string, latin1: boolean): string {
  if (!latin1) return text;
  for (const c of text) {
    const code = c.codePointAt(0);
    if (code !== undefined && code > 0xff) {
      const hex = code.toString(16).toUpperCase().padStart(4, "0");
      throw jsonError(`Found non-latin1 character U+${hex} in ${kind}: ${JSON.stringify(text)}`, path);
    }
  }
  return text;
}

//////////////////////
// Sort codec       //
//////////////////////

/** One `Sort` node whose `args` are being decoded. */
interface SortFrame {
  readonly tag: "SortVar" | "SortApp";
  readonly name: string;
  readonly path: string;
  readonly kids: readonly unknown[];
  readonly done: Sort[];
}

/** Validate one sort object and open a frame for it. `Types.hs:360-374`. */
function enterSort(value: unknown, path: string): SortFrame {
  const obj = asObject(value, path);
  const tag = obj["tag"];
  if (tag === "SortVar") {
    checkFields(obj, ["name"], path, "SortVar");
    return { tag, name: asString(obj["name"], `${path}.name`), path, kids: [], done: [] };
  }
  if (tag === "SortApp") {
    checkFields(obj, ["name", "args"], path, "SortApp");
    return {
      tag,
      name: asString(obj["name"], `${path}.name`),
      path,
      // Field-name trap: a *sort's* children are `args`, not `sorts`.
      kids: asArray(obj["args"], `${path}.args`),
      done: [],
    };
  }
  throw jsonError(`Unknown Sort tag: ${describe(tag)}`, `${path}.tag`);
}

/**
 * Decode a sort — pyk `Sort.from_dict` (`syntax.py:115-124`), on a stack.
 *
 * pyk recurses here; we do not, for the same reason nothing else in this
 * package does. Sort nesting is shallow in practice and unbounded in principle.
 */
export function sortFromJson(value: unknown, options: JsonOptions = {}): Sort {
  return sortFromValue(value, options.path ?? "sort");
}

function sortFromValue(value: unknown, root: string): Sort {
  const stack: SortFrame[] = [enterSort(value, root)];
  for (;;) {
    const cur = stack.at(-1);
    if (cur === undefined) throw new SyntaxError("Unreachable: empty sort stack");
    const i = cur.done.length;
    if (i < cur.kids.length) {
      stack.push(enterSort(cur.kids[i], `${cur.path}.args.${i}`));
      continue;
    }
    stack.pop();
    const built: Sort =
      cur.tag === "SortVar" ? { tag: "SortVar", name: cur.name } : { tag: "SortApp", name: cur.name, sorts: cur.done };
    const parent = stack.at(-1);
    if (parent === undefined) return built;
    parent.done.push(built);
  }
}

/** Encode a sort — pyk `SortVar.dict` / `SortApp.dict` (`syntax.py:157-158`, `183-184`), on a stack. */
export function sortToJson(sort: Sort): JsonObject {
  interface Frame {
    readonly node: Sort;
    readonly done: JsonValue[];
  }
  const stack: Frame[] = [{ node: sort, done: [] }];
  for (;;) {
    const cur = stack.at(-1);
    if (cur === undefined) throw new TypeError("Unreachable: empty sort stack");
    const kids = cur.node.tag === "SortApp" ? cur.node.sorts : [];
    const i = cur.done.length;
    const kid = kids[i];
    if (kid !== undefined) {
      stack.push({ node: kid, done: [] });
      continue;
    }
    stack.pop();
    const built: JsonObject =
      cur.node.tag === "SortVar"
        ? { tag: "SortVar", name: cur.node.name }
        : { tag: "SortApp", name: cur.node.name, args: cur.done };
    const parent = stack.at(-1);
    if (parent === undefined) return built;
    parent.done.push(built);
  }
}

//////////////////////
// Field checking   //
//////////////////////

/**
 * `rejectUnknownFields = True` (`Types.hs:231`) plus aeson's ordinary
 * missing-key failure, in one pass.
 *
 * Missing is reported before unknown, and both name the field: a decoder that
 * says only "malformed" costs its caller the debugging session that this line
 * saves.
 */
function checkFields(
  obj: Readonly<Record<string, unknown>>,
  fields: readonly string[],
  path: string,
  tag: string,
): void {
  for (const field of fields) {
    if (!Object.hasOwn(obj, field)) throw jsonError(`${tag} is missing the field ${JSON.stringify(field)}`, path);
  }
  for (const key of Object.keys(obj)) {
    if (key === "tag" || fields.includes(key)) continue;
    throw jsonError(`${tag} has no field ${JSON.stringify(key)}`, path);
  }
}

//////////////////////
// Pattern decoding //
//////////////////////

/** One pattern node whose subpatterns are being decoded. */
interface DecodeFrame {
  /** The object *after* any `flattenAndOr` rewrite. */
  readonly obj: Readonly<Record<string, unknown>>;
  readonly tag: PatternTag;
  readonly path: string;
  readonly kids: readonly unknown[];
  readonly kidPaths: readonly string[];
  readonly done: Pattern[];
}

/**
 * `flattenAndOr` (`Types.hs:254-263`).
 *
 * If `patterns` is present the object passes through untouched; otherwise
 * `first` and `second` are read and a fresh object with exactly
 * `tag`/`sort`/`patterns` is returned. The rebuild is why an extra key on a
 * legacy two-field `And` disappears rather than being rejected — see the header.
 */
function flattenAndOr(
  obj: Readonly<Record<string, unknown>>,
  path: string,
  tag: string,
): Readonly<Record<string, unknown>> {
  if (Object.hasOwn(obj, "patterns")) return obj;
  for (const field of ["first", "second", "sort"]) {
    if (!Object.hasOwn(obj, field)) {
      throw jsonError(
        `${tag} is missing the field "patterns" and cannot be read as the legacy two-field shape: no ${JSON.stringify(field)}`,
        path,
      );
    }
  }
  return { tag, sort: obj["sort"], patterns: [obj["first"], obj["second"]] };
}

/** Validate one pattern object — tag, `And`/`Or` rewrite, fields, kid list. */
function enterPattern(value: unknown, path: string): DecodeFrame {
  const raw = asObject(value, path);
  const rawTag = raw["tag"];
  if (typeof rawTag !== "string") throw jsonError(`Expected a string tag, got ${describe(rawTag)}`, `${path}.tag`);
  if (!isPatternTag(rawTag)) throw jsonError(`Unknown KorePattern tag: ${JSON.stringify(rawTag)}`, `${path}.tag`);
  const tag: PatternTag = rawTag;
  const fields: readonly string[] = PATTERN_FIELDS[tag];

  // `modifyAndOr` (`Types.hs:245-252`) dispatches on the tag *before* the
  // generic decoder sees the value, and only for these two.
  const obj = tag === "And" || tag === "Or" ? flattenAndOr(raw, path, tag) : raw;
  checkFields(obj, fields, path, tag);

  const spec: string | readonly string[] = PATTERN_KIDS[tag];
  if (typeof spec === "string") {
    const items = asArray(obj[spec], `${path}.${spec}`);
    if (items.length === 0 && NON_EMPTY_TAGS.has(tag)) {
      throw jsonError(`${tag} requires at least one pattern in ${JSON.stringify(spec)}`, `${path}.${spec}`);
    }
    return {
      obj,
      tag,
      path,
      kids: items,
      kidPaths: items.map((_, i) => `${path}.${spec}.${i}`),
      done: [],
    };
  }
  return {
    obj,
    tag,
    path,
    kids: spec.map((name) => obj[name]),
    kidPaths: spec.map((name) => `${path}.${name}`),
    done: [],
  };
}

/** The subpattern at `i`, which {@link enterPattern} has already guaranteed. */
function sub(frame: DecodeFrame, i: number): Pattern {
  const p = frame.done[i];
  if (p === undefined) throw jsonError(`${frame.tag} is missing subpattern ${i}`, frame.path);
  return p;
}

/** Read a sort-valued field. */
function sortField(frame: DecodeFrame, name: string): Sort {
  return sortFromValue(frame.obj[name], `${frame.path}.${name}`);
}

/** Read a field holding an array of sorts (`App`, `LeftAssoc`, `RightAssoc`). */
function sortsField(frame: DecodeFrame, name: string): readonly Sort[] {
  const path = `${frame.path}.${name}`;
  return asArray(frame.obj[name], path).map((item, i) => sortFromValue(item, `${path}.${i}`));
}

/** Read a string-valued field. */
function stringField(frame: DecodeFrame, name: string): string {
  return asString(frame.obj[name], `${frame.path}.${name}`);
}

/**
 * Build one node from its decoded children — the per-constructor half of
 * `genericParseJSON codecOptions`, plus the matching arm of `lexicalCheck`
 * (`Types.hs:269-298`).
 *
 * Each arm below is annotated with the identifier check upstream applies to it,
 * or with the fact that upstream applies none.
 */
function buildPattern(frame: DecodeFrame, latin1: boolean): Pattern {
  const { tag, path } = frame;
  switch (tag) {
    case "EVar": {
      // Types.hs:272-273 — "element variable", `checkIdChars`.
      const name = checkLexical(stringField(frame, "name"), "element variable", isId, `${path}.name`);
      const node: EVar = { tag, name, sort: sortField(frame, "sort") };
      return node;
    }
    case "SVar": {
      // Types.hs:274-275 — "set variable", `checkSVarName`: must start with `@`.
      const name = checkLexical(stringField(frame, "name"), "set variable", isSetVarId, `${path}.name`);
      const node: SVar = { tag, name, sort: sortField(frame, "sort") };
      return node;
    }
    case "App": {
      // Types.hs:276-277 — "app symbol", `checkSymbolName`: an optional leading `\`.
      // JSON `name` becomes AST `symbol`.
      const symbol = checkLexical(stringField(frame, "name"), "app symbol", isSymbolId, `${path}.name`);
      const node: App = { tag, symbol, sorts: sortsField(frame, "sorts"), args: frame.done };
      return node;
    }
    case "String": {
      // Types.hs:290-291 — "string literal", latin-1 range only.
      const value = checkLatin1(stringField(frame, "value"), "string literal", `${path}.value`, latin1);
      const node: KoreString = { tag, value };
      return node;
    }
    case "Top": {
      const node: Top = { tag, sort: sortField(frame, "sort") };
      return node;
    }
    case "Bottom": {
      const node: Bottom = { tag, sort: sortField(frame, "sort") };
      return node;
    }
    case "Not": {
      const node: Not = { tag, sort: sortField(frame, "sort"), pattern: sub(frame, 0) };
      return node;
    }
    case "And": {
      const node: And = { tag, sort: sortField(frame, "sort"), patterns: frame.done };
      return node;
    }
    case "Or": {
      const node: Or = { tag, sort: sortField(frame, "sort"), patterns: frame.done };
      return node;
    }
    case "Implies": {
      const node: Implies = { tag, sort: sortField(frame, "sort"), left: sub(frame, 0), right: sub(frame, 1) };
      return node;
    }
    case "Iff": {
      const node: Iff = { tag, sort: sortField(frame, "sort"), left: sub(frame, 0), right: sub(frame, 1) };
      return node;
    }
    case "Forall": {
      // Types.hs:278-279 — "quantifier variable", `checkIdChars`.
      const name = checkLexical(stringField(frame, "var"), "quantifier variable", isId, `${path}.var`);
      const bound: EVar = { tag: "EVar", name, sort: sortField(frame, "varSort") };
      const node: Forall = { tag, sort: sortField(frame, "sort"), var: bound, pattern: sub(frame, 0) };
      return node;
    }
    case "Exists": {
      // Types.hs:280-281 — same check as `Forall`.
      const name = checkLexical(stringField(frame, "var"), "quantifier variable", isId, `${path}.var`);
      const bound: EVar = { tag: "EVar", name, sort: sortField(frame, "varSort") };
      const node: Exists = { tag, sort: sortField(frame, "sort"), var: bound, pattern: sub(frame, 0) };
      return node;
    }
    case "Mu": {
      // Types.hs:282-283 — "fixpoint expression variable", `checkSVarName`.
      // No `sort` field: the fixpoint's sort is the bound variable's.
      const name = checkLexical(stringField(frame, "var"), "fixpoint expression variable", isSetVarId, `${path}.var`);
      const bound: SVar = { tag: "SVar", name, sort: sortField(frame, "varSort") };
      const node: Mu = { tag, var: bound, pattern: sub(frame, 0) };
      return node;
    }
    case "Nu": {
      // Types.hs:284-285 — same check as `Mu`.
      const name = checkLexical(stringField(frame, "var"), "fixpoint expression variable", isSetVarId, `${path}.var`);
      const bound: SVar = { tag: "SVar", name, sort: sortField(frame, "varSort") };
      const node: Nu = { tag, var: bound, pattern: sub(frame, 0) };
      return node;
    }
    case "Ceil": {
      // JSON `argSort` is AST `opSort`.
      const node: Ceil = {
        tag,
        opSort: sortField(frame, "argSort"),
        sort: sortField(frame, "sort"),
        pattern: sub(frame, 0),
      };
      return node;
    }
    case "Floor": {
      const node: Floor = {
        tag,
        opSort: sortField(frame, "argSort"),
        sort: sortField(frame, "sort"),
        pattern: sub(frame, 0),
      };
      return node;
    }
    case "Equals": {
      const node: Equals = {
        tag,
        opSort: sortField(frame, "argSort"),
        sort: sortField(frame, "sort"),
        left: sub(frame, 0),
        right: sub(frame, 1),
      };
      return node;
    }
    case "In": {
      const node: In = {
        tag,
        opSort: sortField(frame, "argSort"),
        sort: sortField(frame, "sort"),
        left: sub(frame, 0),
        right: sub(frame, 1),
      };
      return node;
    }
    case "Next": {
      const node: Next = { tag, sort: sortField(frame, "sort"), pattern: sub(frame, 0) };
      return node;
    }
    case "Rewrites": {
      const node: Rewrites = { tag, sort: sortField(frame, "sort"), left: sub(frame, 0), right: sub(frame, 1) };
      return node;
    }
    case "DV": {
      // Types.hs:288-289 — "domain value string", latin-1 range only.  The JSON
      // `value` is a *raw* string; the AST wraps it in a `String` node.
      const value = checkLatin1(stringField(frame, "value"), "domain value string", `${path}.value`, latin1);
      const node: DV = { tag, sort: sortField(frame, "sort"), value: { tag: "String", value } };
      return node;
    }
    case "MultiOr": {
      // No identifier to check. `assoc` is an enum (`Types.hs:376-380`), and
      // JSON `argss` is AST `patterns`.
      const assoc = stringField(frame, "assoc");
      if (assoc !== "Left" && assoc !== "Right") {
        throw jsonError(`Expected "Left" or "Right", got ${JSON.stringify(assoc)}`, `${path}.assoc`);
      }
      const node: MultiOr = { tag, assoc, sort: sortField(frame, "sort"), patterns: frame.done };
      return node;
    }
    case "LeftAssoc": {
      // Types.hs:294-295 — "left-assoc symbol", `checkSymbolName`.
      const symbol = checkLexical(stringField(frame, "symbol"), "left-assoc symbol", isSymbolId, `${path}.symbol`);
      const node: LeftAssoc = { tag, symbol, sorts: sortsField(frame, "sorts"), args: frame.done };
      return node;
    }
    case "RightAssoc": {
      // Types.hs:296-297 — same check.  Upstream's message says "left-assoc
      // symbol" here too, which is a copy-paste slip in the *message text*, not
      // in the check; we name the tag correctly.
      const symbol = checkLexical(stringField(frame, "symbol"), "right-assoc symbol", isSymbolId, `${path}.symbol`);
      const node: RightAssoc = { tag, symbol, sorts: sortsField(frame, "sorts"), args: frame.done };
      return node;
    }
    default:
      return exhausted(tag);
  }
}

/** Compile-time exhaustiveness over {@link PatternTag}. Unreachable. */
function exhausted(value: never): never {
  throw new TypeError(`Unhandled tag: ${JSON.stringify(value)}`);
}

/**
 * Decode a pattern from parsed JSON — pyk `Pattern.from_dict`
 * (`syntax.py:226-249`), whose explicit-stack shape this transcribes.
 *
 * `value` is what `JSON.parse` produced, not text; see {@link decodeKoreJson}
 * for the envelope. Throws `SyntaxError` with a JSON path on any deviation.
 */
export function patternFromJson(value: unknown, options: JsonOptions = {}): Pattern {
  const root = options.path ?? "term";
  const latin1 = options.latin1 ?? false;
  const stack: DecodeFrame[] = [enterPattern(value, root)];
  for (;;) {
    const cur = stack.at(-1);
    if (cur === undefined) throw new SyntaxError("Unreachable: empty decode stack");
    const i = cur.done.length;
    if (i < cur.kids.length) {
      stack.push(enterPattern(cur.kids[i], cur.kidPaths[i] ?? cur.path));
      continue;
    }
    stack.pop();
    const built = buildPattern(cur, latin1);
    const parent = stack.at(-1);
    if (parent === undefined) return built;
    parent.done.push(built);
  }
}

//////////////////////
// Pattern encoding //
//////////////////////

/** The subpattern JSON at `i`; absent means the AST node was malformed by hand. */
function kidAt(kids: readonly JsonValue[], i: number, tag: string): JsonValue {
  const k = kids[i];
  if (k === undefined) throw new TypeError(`Malformed ${tag} node: missing subpattern ${i}`);
  return k;
}

/** `NE.NonEmpty` on the encode side — the guard `syntax.ts`'s constructors already apply. */
function nonEmpty(kids: readonly JsonValue[], tag: string): readonly JsonValue[] {
  if (kids.length === 0) throw new TypeError(`Malformed ${tag} node: expected a non-empty pattern list`);
  return kids;
}

/**
 * Build one JSON object from an AST node and its already-encoded children —
 * the per-class `_dict` methods (`syntax.py`, e.g. `DV._dict` at 1789-1791).
 *
 * Key order is `tag` then {@link PATTERN_FIELDS}, i.e. `Types.hs` declaration
 * order. Byte-identity with the Haskell goldens is a non-goal (they use a
 * bespoke key order and 2-space pretty-printing); what matters is that the
 * order is *fixed*, so our own output is stable and diffable.
 */
function buildJson(node: Pattern, kids: readonly JsonValue[]): JsonObject {
  switch (node.tag) {
    case "EVar":
    case "SVar":
      return { tag: node.tag, name: node.name, sort: sortToJson(node.sort) };
    case "App":
      // AST `symbol` becomes JSON `name`.
      return { tag: node.tag, name: node.symbol, sorts: node.sorts.map(sortToJson), args: kids };
    case "String":
      return { tag: node.tag, value: node.value };
    case "Top":
    case "Bottom":
      return { tag: node.tag, sort: sortToJson(node.sort) };
    case "Not":
      return { tag: node.tag, sort: sortToJson(node.sort), arg: kidAt(kids, 0, node.tag) };
    case "And":
    case "Or":
      // Always the n-ary shape; the legacy two-field `first`/`second` form is decode-only.
      return { tag: node.tag, sort: sortToJson(node.sort), patterns: kids };
    case "Implies":
    case "Iff":
      return {
        tag: node.tag,
        sort: sortToJson(node.sort),
        first: kidAt(kids, 0, node.tag),
        second: kidAt(kids, 1, node.tag),
      };
    case "Forall":
    case "Exists":
      return {
        tag: node.tag,
        sort: sortToJson(node.sort),
        var: node.var.name,
        varSort: sortToJson(node.var.sort),
        arg: kidAt(kids, 0, node.tag),
      };
    case "Mu":
    case "Nu":
      // No `sort` field at all — `Types.hs:142-151`.
      return {
        tag: node.tag,
        var: node.var.name,
        varSort: sortToJson(node.var.sort),
        arg: kidAt(kids, 0, node.tag),
      };
    case "Ceil":
    case "Floor":
      return {
        tag: node.tag,
        argSort: sortToJson(node.opSort),
        sort: sortToJson(node.sort),
        arg: kidAt(kids, 0, node.tag),
      };
    case "Equals":
    case "In":
      return {
        tag: node.tag,
        argSort: sortToJson(node.opSort),
        sort: sortToJson(node.sort),
        first: kidAt(kids, 0, node.tag),
        second: kidAt(kids, 1, node.tag),
      };
    case "Next":
      return { tag: node.tag, sort: sortToJson(node.sort), dest: kidAt(kids, 0, node.tag) };
    case "Rewrites":
      return {
        tag: node.tag,
        sort: sortToJson(node.sort),
        source: kidAt(kids, 0, node.tag),
        dest: kidAt(kids, 1, node.tag),
      };
    case "DV":
      // The AST's nested `String` node flattens to a raw string here.
      return { tag: node.tag, sort: sortToJson(node.sort), value: node.value.value };
    case "MultiOr":
      return {
        tag: node.tag,
        assoc: node.assoc,
        sort: sortToJson(node.sort),
        argss: nonEmpty(kids, node.tag),
      };
    case "LeftAssoc":
    case "RightAssoc":
      return {
        tag: node.tag,
        symbol: node.symbol,
        sorts: node.sorts.map(sortToJson),
        argss: nonEmpty(kids, node.tag),
      };
    default:
      return exhausted(node);
  }
}

/**
 * Encode a pattern to a JSON value — pyk `Pattern.dict` (`syntax.py:274-296`),
 * whose explicit-stack shape this transcribes.
 *
 * The child list comes from `syntax.ts`'s `patterns()`, which is exactly pyk's
 * `pattern.patterns`, and which is exactly {@link PATTERN_KIDS} read the other
 * way: a quantifier yields its body and not its bound variable, a `\dv` yields
 * nothing.
 */
export function patternToJson(term: Pattern): JsonObject {
  interface Frame {
    readonly node: Pattern;
    readonly kids: readonly Pattern[];
    readonly done: JsonValue[];
  }
  const stack: Frame[] = [{ node: term, kids: patterns(term), done: [] }];
  for (;;) {
    const cur = stack.at(-1);
    if (cur === undefined) throw new TypeError("Unreachable: empty encode stack");
    const kid = cur.kids[cur.done.length];
    if (kid !== undefined) {
      stack.push({ node: kid, kids: patterns(kid), done: [] });
      continue;
    }
    stack.pop();
    const built = buildJson(cur.node, cur.done);
    const parent = stack.at(-1);
    if (parent === undefined) return built;
    parent.done.push(built);
  }
}

//////////////////////
// Serialization    //
//////////////////////

/** A stack item for {@link stringifyJson}: literal text, or a value to render. */
type Emit = { readonly lit: string } | { readonly val: JsonValue };

/**
 * `JSON.stringify` on an explicit stack.
 *
 * Necessary, not stylistic: JavaScriptCore's `JSON.stringify` recurses and
 * throws `RangeError: Maximum call stack size exceeded` on a term a few
 * thousand nodes deep, which real KORE terms exceed by two orders of magnitude.
 * (`JSON.parse` is iterative there and needs no counterpart.) Scalars are still
 * handed to `JSON.stringify` one at a time — that call cannot recurse, and it
 * is the correct string escaper, which is not a wheel to reinvent.
 *
 * Output is compact, exactly `JSON.stringify(value)` byte-for-byte.
 */
function stringifyJson(value: JsonValue): string {
  const out: string[] = [];
  const stack: Emit[] = [{ val: value }];
  for (;;) {
    const item = stack.pop();
    if (item === undefined) return out.join("");
    if ("lit" in item) {
      out.push(item.lit);
      continue;
    }
    const v = item.val;
    if (v === null || typeof v !== "object") {
      out.push(JSON.stringify(v));
      continue;
    }
    if (isJsonArray(v)) {
      out.push("[");
      stack.push({ lit: "]" });
      for (let i = v.length - 1; i >= 0; i--) {
        const el = v[i];
        stack.push({ val: el === undefined ? null : el });
        if (i > 0) stack.push({ lit: "," });
      }
      continue;
    }
    out.push("{");
    stack.push({ lit: "}" });
    const entries = Object.entries(v);
    for (let i = entries.length - 1; i >= 0; i--) {
      const entry = entries[i];
      if (entry === undefined) continue;
      stack.push({ val: entry[1] }, { lit: `${JSON.stringify(entry[0])}:` });
      if (i > 0) stack.push({ lit: "," });
    }
  }
}

//////////////////////
// Envelope codec   //
//////////////////////

/**
 * Read a KORE-JSON document — pyk `kore_term` (`syntax.py:2266-2273`) plus the
 * `KoreJson` instance (`Types.hs:27-33`).
 *
 * `input` is either the document *text* (parsed with `JSON.parse`) or a value
 * already parsed. The two are told apart by `typeof input === "string"`, which
 * is unambiguous: an envelope is always an object.
 *
 * `format` must be exactly `"KORE"` and `version` exactly `1`; anything else
 * throws. There is no partial read and no "best effort" — a document that
 * claims a version we do not implement is one whose `term` we have no grounds
 * to interpret.
 */
export function decodeKoreJson(input: unknown, options: JsonOptions = {}): KoreJson {
  const value: unknown = typeof input === "string" ? JSON.parse(input) : input;
  const obj = asObject(value, DOCUMENT_ROOT);

  // Envelope keys are checked but not exhausted: `KoreJson` derives with
  // aeson's `defaultOptions`, so upstream tolerates extra keys here even though
  // it rejects them inside a pattern.  See the header.
  if (!Object.hasOwn(obj, "format")) throw jsonError('Document is missing the field "format"', DOCUMENT_ROOT);
  const format = obj["format"];
  if (format !== KORE_JSON_FORMAT) {
    throw jsonError(`Expected format ${JSON.stringify(KORE_JSON_FORMAT)}, got ${describe(format)}`, "format");
  }

  if (!Object.hasOwn(obj, "version")) throw jsonError('Document is missing the field "version"', DOCUMENT_ROOT);
  const version = obj["version"];
  if (version !== KORE_JSON_VERSION) {
    throw jsonError(`Expected version ${KORE_JSON_VERSION}, got ${describe(version)}`, "version");
  }

  if (!Object.hasOwn(obj, "term")) throw jsonError('Document is missing the field "term"', DOCUMENT_ROOT);
  const term = patternFromJson(obj["term"], {
    latin1: options.latin1 ?? false,
    path: options.path ?? "term",
  });

  return { format: KORE_JSON_FORMAT, version: KORE_JSON_VERSION, term };
}

/**
 * Build a KORE-JSON document as a JSON value — the to-object half of
 * {@link encodeKoreJson}, for callers who are about to embed it in a larger
 * payload (a kore-rpc request, say) rather than write it out.
 *
 * Upstream has no counterpart to name: pyk only reads KORE-JSON, so this
 * direction is transcribed from the `ToJSON` instances (`Types.hs:217-218`,
 * `370-371`) alone.
 */
export function encodeKoreJsonValue(term: Pattern): JsonObject {
  return { format: KORE_JSON_FORMAT, version: KORE_JSON_VERSION, term: patternToJson(term) };
}

/**
 * Write a KORE-JSON document.
 *
 * Compact — no indentation — and stack-safe at any term depth; see
 * {@link stringifyJson}.
 */
export function encodeKoreJson(term: Pattern): string {
  return stringifyJson(encodeKoreJsonValue(term));
}

/** Write a pattern as a bare KORE-JSON value, without the envelope. */
export function encodePatternJson(term: Pattern): string {
  return stringifyJson(patternToJson(term));
}
