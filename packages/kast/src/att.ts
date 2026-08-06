/**
 * K attributes — a transcription of `pyk/kast/att.py` (467 L) at K **v7.1.337**.
 *
 * # What lives here
 *
 * The {@link AttType} codec hierarchy (one codec per attribute *value* shape),
 * the {@link Atts} registry of ~80 well-known attribute keys, and {@link KAtt}
 * — the immutable `AttKey → value` mapping that every sentence, module and
 * definition of the outer layer carries.  No `KInner` carries a `KAtt`.
 *
 * # Typed keys — the one place TS beats Python
 *
 * pyk spells the key/value dependency with `AttKey(Generic[T])` and then loses
 * it at the mapping boundary: `KAtt` is a `Mapping[AttKey, Any]`, so
 * `att[Atts.LOCATION]` is `Any` at rest and only the `@overload`s on `get`
 * recover anything.  Here {@link KAtt.get} is generic in the key, so
 * `att.get(Atts.SYMBOL)` is `string | undefined`, `att.get(Atts.LOCATION)` is
 * `readonly [number, number, number, number] | undefined`, and
 * `att.get(Atts.FUNCTION)` is `null | undefined` — a nullary attribute is
 * present-with-no-value, which is why `null`, not `undefined`, models pyk's
 * `None` throughout this module.
 *
 * # Keys compare by name, and the *first* key object wins
 *
 * `AttKey` is a frozen dataclass whose `type` field is `compare=False`
 * (`att.py:275`), so two keys with the same name are the same key however they
 * are typed.  {@link KAtt} therefore keys its map on `key.name`.  The
 * consequence pyk inherits from `dict` and this module reproduces: when an
 * entry overwrites an existing one, the stored **key object** is the one
 * already there and only the value is replaced (`att.py:389`,
 * `att.py:445-447`).  So re-adding `label` with a differently-typed key does
 * not change how `toDict`/`pretty` encode it.
 *
 * # Unknown keys survive a round-trip
 *
 * `KAtt.fromDict` falls back to an `ANY`-typed key for any name the registry
 * does not know (`att.py:412`).  That is load-bearing: `compiled.json` from a
 * real `kompile` carries attributes this table has never heard of, and reading
 * one must not drop them.
 *
 * # Transcription notes (deliberate deviations)
 *
 * - **`fromDict` takes a JSON path.**  `att.py`'s codecs `assert isinstance(...)`
 *   and die anonymously; this module follows the house contract of `json.ts`
 *   instead — a malformed document throws a `SyntaxError` naming the offending
 *   path (`att.org.kframework.attributes.Location`).  `parse` (the *textual*
 *   attribute syntax, which has no document position) throws `TypeError`.
 * - **`FormatType.unparse` is fixed, not transcribed.**  `att.py:212` reads
 *   `f'"{value.unparse}"'` — the method object, not the call — so pyk renders a
 *   `format(...)` attribute as `"<bound method Format.unparse of Format(...)>"`.
 *   Reproducing a Python `repr` of a bound method is neither possible nor
 *   useful; {@link FORMAT_TYPE} emits `"%1 + %2"`.  This is the only place where
 *   `pretty` deliberately disagrees with pyk.
 * - **`Path` becomes `string`.**  {@link PATH_TYPE} normalizes the way
 *   `PurePosixPath` does (`a//b` → `a/b`, `./a` → `a`, `a/` → `a`, `''` → `.`)
 *   so `toDict` round-trips byte-identically with pyk on the paths a `source`
 *   attribute can hold; it does not model Windows paths, which `Path` would.
 * - **`int` becomes `number`.**  Python's ints are unbounded; {@link INT_TYPE}
 *   rejects anything outside the safe-integer range rather than silently
 *   losing precision, and does not copy `int()`'s tolerance for surrounding
 *   whitespace and `1_000`-style underscores.
 * - **`Color` is a string union**, not an enum — see `color.ts`.
 */

import { isColor, parseColor, type Color } from "./color.js";
import { canonicalJson } from "./eq.js";
import type { JsonObject, JsonValue } from "./json.js";
import { reprString } from "./pyrepr.js";

//////////////////////////////
// Errors and JSON guards   //
//////////////////////////////

function attError(message: string, path: string, options?: ErrorOptions): SyntaxError {
  return new SyntaxError(`${message} (at ${path})`, options);
}

/** Read a regex group whose existence the pattern has already established. */
function group(match: RegExpExecArray, i: number): string {
  const value = match[i];
  if (value === undefined) throw new RangeError(`No group ${i} in match`);
  return value;
}

function isArray(value: unknown): value is readonly unknown[] {
  return Array.isArray(value);
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !isArray(value);
}

function describe(value: unknown): string {
  if (value === null) return "null";
  if (value === undefined) return "undefined";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (typeof value === "function") return "a function";
  if (typeof value === "symbol") return value.toString();
  return isArray(value) ? "an array" : "an object";
}

function asString(value: unknown, path: string): string {
  if (typeof value !== "string") throw attError(`Expected a string, got ${describe(value)}`, path);
  return value;
}

//////////////////////////////
// CPython's `repr`         //
//////////////////////////////

/**
 * `repr(value)` for a frozen JSON value — a Python tuple for a list, a
 * `FrozenDict` for an object (`utils.py:79-83`), `True`/`False`/`None` for the
 * scalars.
 *
 * Recursion here is bounded by the nesting of a single attribute *value*, not
 * by term depth: in practice a string, or the four-element location list.
 */
function pythonRepr(value: JsonValue): string {
  if (value === null) return "None";
  if (value === true) return "True";
  if (value === false) return "False";
  if (typeof value === "number") return String(value);
  if (typeof value === "string") return reprString(value);
  if (isArray(value)) {
    const items = value.map((item) => pythonRepr(item));
    if (items.length === 1) return `(${items[0]},)`;
    return `(${items.join(", ")})`;
  }
  const items = Object.entries(value).map(([k, v]) => `${reprString(k)}: ${pythonRepr(v)}`);
  return `FrozenDict({${items.join(", ")}})`;
}

/** `str(value)`: a string is itself, everything else is its {@link pythonRepr}. */
function pythonStr(value: JsonValue): string {
  return typeof value === "string" ? value : pythonRepr(value);
}

//////////////////////////////
// Attribute value codecs   //
//////////////////////////////

/**
 * The four-way codec of an attribute value (`att.py:30-40`): JSON in both
 * directions, and K's textual attribute syntax in both directions.
 *
 * `unparse` returning `null` means *this attribute has no value* — it is
 * printed as a bare `[function]`, not `[function()]` (`att.py:52-53`).
 *
 * Declared with method syntax on purpose: TypeScript's method parameters are
 * bivariant, which is what makes a heterogeneous `AttKey`/`AttEntry` list
 * (`AttKey<unknown>`) typeable at all without an `any`.
 */
export interface AttType<T> {
  /** `path` names the position in the enclosing document, for error messages. */
  fromDict(obj: unknown, path?: string): T;
  toDict(value: T): JsonValue;
  unparse(value: T): string | null;
  parse(text: string): T;
}

/** `NoneType` (`att.py:43-56`) — a nullary attribute; `''` on the wire. */
export const NONE_TYPE: AttType<null> = Object.freeze({
  fromDict(obj: unknown, path = "att"): null {
    if (obj !== "") throw attError(`Expected "" for a nullary attribute, got ${describe(obj)}`, path);
    return null;
  },
  toDict(): JsonValue {
    return "";
  },
  unparse(): string | null {
    return null;
  },
  parse(text: string): null {
    if (text !== "") throw new TypeError(`Expected no value for a nullary attribute, got: ${text}`);
    return null;
  },
});

/** `OptionalType` (`att.py:59-81`) — `''` reads as absent, everything else delegates. */
export function optionalType<T>(valueType: AttType<T>): AttType<T | null> {
  return Object.freeze({
    fromDict(obj: unknown, path = "att"): T | null {
      if (obj === "") return null;
      return valueType.fromDict(obj, path);
    },
    toDict(value: T | null): JsonValue {
      if (value === null) return "";
      return valueType.toDict(value);
    },
    unparse(value: T | null): string | null {
      if (value === null) return null;
      return valueType.unparse(value);
    },
    parse(text: string): T | null {
      if (text === "") return null;
      return valueType.parse(text);
    },
  });
}

/**
 * Deep-copy a JSON value and freeze the copy — `AnyType._freeze`
 * (`att.py:99-106`), whose `tuple`/`FrozenDict` exist only because Python's
 * lists and dicts are mutable.
 *
 * Frozen arrays and objects *are* JSON, so unlike `AnyType._unfreeze`
 * (`att.py:108-114`) there is nothing to undo on the way out and
 * {@link ANY_TYPE}'s `toDict` is the identity.  The copy is what keeps
 * freezing from reaching back into the caller's parsed document.
 */
function freezeJson(value: unknown, path: string): JsonValue {
  if (value === null || typeof value === "boolean" || typeof value === "string") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw attError(`Not a JSON number: ${describe(value)}`, path);
    return value;
  }
  if (isArray(value)) return Object.freeze(value.map((item, i) => freezeJson(item, `${path}.${i}`)));
  if (isRecord(value)) {
    const out: Record<string, JsonValue> = {};
    for (const [k, v] of Object.entries(value)) out[k] = freezeJson(v, `${path}.${k}`);
    return Object.freeze(out);
  }
  throw attError(`Expected a JSON value, got ${describe(value)}`, path);
}

/**
 * `AnyType` (`att.py:84-114`) — the fallback for every unregistered key, and
 * for the ~30 registered keys whose value shape K never settled.
 *
 * `parse` throws (`att.py:95-96`), which makes {@link KAtt.parse} throw for
 * *any* `ANY`-typed attribute — `label`, `hook`, `strict`, an unknown key.
 * That is upstream behaviour, not an omission.
 */
export const ANY_TYPE: AttType<JsonValue> = Object.freeze({
  fromDict(obj: unknown, path = "att"): JsonValue {
    return freezeJson(obj, path);
  },
  toDict(value: JsonValue): JsonValue {
    return value;
  },
  unparse(value: JsonValue): string {
    return pythonStr(value);
  },
  parse(text: string): JsonValue {
    throw new TypeError(
      `Parsing a string into an Any attribute type is not supported. Attempted to parse: ${reprString(text)}`,
    );
  },
});

/** `IntType` (`att.py:117-129`) — decimal digits in a JSON *string*. */
export const INT_TYPE: AttType<number> = Object.freeze({
  fromDict(obj: unknown, path = "att"): number {
    const text = asString(obj, path);
    const value = parseInteger(text);
    if (value === null) throw attError(`Expected an integer, got ${describe(text)}`, path);
    return value;
  },
  toDict(value: number): JsonValue {
    return String(value);
  },
  unparse(value: number): string {
    return String(value);
  },
  parse(text: string): number {
    const value = parseInteger(text);
    if (value === null) throw new TypeError(`Expected an integer, got: ${text}`);
    return value;
  },
});

function parseInteger(text: string): number | null {
  if (!/^[+-]?\d+$/u.test(text)) return null;
  const value = Number(text);
  return Number.isSafeInteger(value) ? value : null;
}

/** `StrType` (`att.py:132-144`) — note `unparse` quotes but does not escape. */
export const STR_TYPE: AttType<string> = Object.freeze({
  fromDict(obj: unknown, path = "att"): string {
    return asString(obj, path);
  },
  toDict(value: string): JsonValue {
    return value;
  },
  unparse(value: string): string {
    return `"${value}"`;
  },
  parse(text: string): string {
    return text;
  },
});

/** A source span: start line, start column, end line, end column. */
export type Location = readonly [number, number, number, number];

/** `LocationType` (`att.py:147-168`) — a JSON *array* of four ints, unquoted when printed. */
export const LOCATION_TYPE: AttType<Location> = Object.freeze({
  fromDict(obj: unknown, path = "att"): Location {
    if (!isArray(obj)) throw attError(`Expected an array of four integers, got ${describe(obj)}`, path);
    if (obj.length !== 4) throw attError(`Expected an array of four integers, got ${obj.length}`, path);
    const [a, b, c, d] = obj;
    return [
      asLocationInt(a, `${path}.0`),
      asLocationInt(b, `${path}.1`),
      asLocationInt(c, `${path}.2`),
      asLocationInt(d, `${path}.3`),
    ];
  },
  toDict(value: Location): JsonValue {
    return [...value];
  },
  unparse(value: Location): string {
    return value.join(",");
  },
  parse(text: string): Location {
    const m = /^(\d+),(\d+),(\d+),(\d+)$/u.exec(text);
    if (m === null) throw new TypeError(`Expected a location, got: ${text}`);
    return [Number(group(m, 1)), Number(group(m, 2)), Number(group(m, 3)), Number(group(m, 4))];
  },
});

function asLocationInt(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw attError(`Expected an integer, got ${describe(value)}`, path);
  }
  return value;
}

/**
 * `str(PurePosixPath(text))` — `PathType`'s normalization (`att.py:171-185`),
 * which is what makes a `source` attribute round-trip through pyk unchanged.
 *
 * Empty segments and `.` segments drop, `..` is kept (a path is not resolved),
 * an empty path is `.`, and exactly two leading slashes are preserved (POSIX
 * gives `//` an implementation-defined meaning; three or more collapse).
 */
function posixPath(text: string): string {
  const leading = /^\/*/u.exec(text)?.[0].length ?? 0;
  const root = leading === 0 ? "" : leading === 2 ? "//" : "/";
  const parts = text.split("/").filter((part) => part !== "" && part !== ".");
  if (parts.length === 0) return root === "" ? "." : root;
  return root + parts.join("/");
}

/** `PathType` (`att.py:171-185`) — a `Path` upstream, a normalized string here. */
export const PATH_TYPE: AttType<string> = Object.freeze({
  fromDict(obj: unknown, path = "att"): string {
    return posixPath(asString(obj, path));
  },
  toDict(value: string): JsonValue {
    return posixPath(value);
  },
  unparse(value: string): string {
    return `"${posixPath(value)}"`;
  },
  parse(text: string): string {
    return posixPath(text);
  },
});

//////////////////////////////
// Format strings           //
//////////////////////////////

/**
 * A `format` attribute, tokenized (`att.py:188-215`).
 *
 * A token is an escape (`%1`, `%12`, `%c`, `%%`) or a run of literal text; the
 * tokens concatenate back to the original string exactly.
 */
export interface Format {
  readonly tokens: readonly string[];
}

/** `Format(tokens)` (`att.py:194-195`). */
export function format(tokens: Iterable<string> = []): Format {
  return Object.freeze({ tokens: Object.freeze([...tokens]) });
}

/**
 * `Format._pattern` (`att.py:192`): `%\D|%\d+|[^%]+`.
 *
 * Spelled with `\p{Nd}` under the `u` flag because Python's `\d` on a `str`
 * means *any* Unicode decimal digit while JavaScript's means `[0-9]`, and
 * because Python iterates code points, not UTF-16 units — `%😀` is one token
 * in both languages this way.
 */
const FORMAT_PATTERN = /%\P{Nd}|%\p{Nd}+|[^%]+/gu;

/**
 * `Format.parse` (`att.py:197-210`).
 *
 * The pattern covers every position except a `%` at the very end of the
 * string, so pyk's "did the last match reach the end?" check is exactly a test
 * for a dangling escape.
 */
export function parseFormat(text: string): Format {
  FORMAT_PATTERN.lastIndex = 0;
  const tokens: string[] = [];
  let matchedLength = 0;
  for (let m = FORMAT_PATTERN.exec(text); m !== null; m = FORMAT_PATTERN.exec(text)) {
    tokens.push(group(m, 0));
    matchedLength = FORMAT_PATTERN.lastIndex;
  }
  if (matchedLength !== text.length) {
    throw new TypeError(`Incomplete escape sequence at the end of format string: ${text}`);
  }
  return format(tokens);
}

/** `Format.unparse` (`att.py:212-213`). */
export function unparseFormat(value: Format): string {
  return value.tokens.join("");
}

/**
 * `FormatType` (`att.py:218-229`).
 *
 * `unparse` is the one deliberate disagreement with pyk in this module: see the
 * module header.
 */
export const FORMAT_TYPE: AttType<Format> = Object.freeze({
  fromDict(obj: unknown, path = "att"): Format {
    const text = asString(obj, path);
    try {
      return parseFormat(text);
    } catch (error) {
      throw attError(`Invalid format string: ${describe(text)}`, path, { cause: error });
    }
  },
  toDict(value: Format): JsonValue {
    return unparseFormat(value);
  },
  unparse(value: Format): string {
    return `"${unparseFormat(value)}"`;
  },
  parse(text: string): Format {
    return parseFormat(text);
  },
});

//////////////////////////////
// Colors                   //
//////////////////////////////

/** `ColorType` (`att.py:232-243`). */
export const COLOR_TYPE: AttType<Color> = Object.freeze({
  fromDict(obj: unknown, path = "att"): Color {
    const text = asString(obj, path);
    if (!isColor(text)) throw attError(`Not a K color: ${describe(text)}`, path);
    return text;
  },
  toDict(value: Color): JsonValue {
    return value;
  },
  unparse(value: Color): string {
    return value;
  },
  parse(text: string): Color {
    return parseColor(text);
  },
});

/**
 * `ColorsType` (`att.py:246-257`) — a comma-separated list in a single string.
 *
 * Spaces are stripped *everywhere*, not just around the commas: Python's
 * `str.replace` replaces every occurrence, so `replaceAll` is the faithful
 * spelling (JavaScript's `String.replace` with a string pattern would only
 * take the first one).
 */
export const COLORS_TYPE: AttType<readonly Color[]> = Object.freeze({
  fromDict(obj: unknown, path = "att"): readonly Color[] {
    const text = asString(obj, path);
    try {
      return parseColors(text);
    } catch (error) {
      throw attError(`Not a list of K colors: ${describe(text)}`, path, { cause: error });
    }
  },
  toDict(value: readonly Color[]): JsonValue {
    return value.join(",");
  },
  unparse(value: readonly Color[]): string {
    return value.join(",");
  },
  parse(text: string): readonly Color[] {
    return parseColors(text);
  },
});

function parseColors(text: string): readonly Color[] {
  return Object.freeze(
    text
      .replaceAll(" ", "")
      .split(",")
      .map((color) => parseColor(color)),
  );
}

//////////////////////////////
// Keys and entries         //
//////////////////////////////

/**
 * A typed attribute key (`att.py:270-277`).
 *
 * Two keys are the same key when their `name`s match — `type` is
 * `compare=False` upstream — so {@link KAtt} maps names, and this object is
 * only ever a carrier for the codec.  Build one with {@link attKey}; the
 * registry of the keys K itself defines is {@link Atts}.
 */
export interface AttKey<T = unknown> {
  readonly name: string;
  readonly type: AttType<T>;
}

/** `AttKey(name, type=...)` (`att.py:270-277`). */
export function attKey<T>(name: string, type: AttType<T>): AttKey<T> {
  return Object.freeze({ name, type });
}

/** A key with a value of the type that key declares (`att.py:280-284`). */
export interface AttEntry<T = unknown> {
  readonly key: AttKey<T>;
  readonly value: T;
}

/** `key(value)` (`att.py:276-277`) — Python calls the key; TypeScript cannot. */
export function attEntry<T>(key: AttKey<T>, value: T): AttEntry<T> {
  return Object.freeze({ key, value });
}

/** The value type a key carries: `AttValue<typeof Atts.SYMBOL>` is `string`. */
export type AttValue<K> = K extends AttKey<infer T> ? T : never;

//////////////////////////////
// The registry             //
//////////////////////////////

const OPTIONAL_STR_TYPE = optionalType(STR_TYPE);

/**
 * The attributes K itself defines (`att.py:288-375`), transcribed in upstream
 * order — including the comments upstream keeps about where a key really comes
 * from.
 *
 * Only the *name* is semantic; a key not listed here still reads and writes,
 * as an {@link ANY_TYPE} key (`att.py:412`).
 */
export const Atts = {
  ALIAS: attKey("alias", NONE_TYPE),
  ALIAS_REC: attKey("alias-rec", NONE_TYPE),
  ANYWHERE: attKey("anywhere", NONE_TYPE),
  ASSOC: attKey("assoc", NONE_TYPE),
  AVOID: attKey("avoid", NONE_TYPE),
  BRACKET: attKey("bracket", NONE_TYPE),
  BRACKET_LABEL: attKey("bracketLabel", ANY_TYPE),
  CIRCULARITY: attKey("circularity", NONE_TYPE),
  CELL: attKey("cell", NONE_TYPE),
  CELL_COLLECTION: attKey("cellCollection", NONE_TYPE),
  CELL_FRAGMENT: attKey("cellFragment", ANY_TYPE),
  CELL_NAME: attKey("cellName", STR_TYPE),
  CELL_OPT_ABSENT: attKey("cellOptAbsent", ANY_TYPE),
  COLOR: attKey("color", COLOR_TYPE),
  COLORS: attKey("colors", COLORS_TYPE),
  COMM: attKey("comm", NONE_TYPE),
  CONCAT: attKey("concat", ANY_TYPE),
  CONCRETE: attKey("concrete", OPTIONAL_STR_TYPE),
  CONSTRUCTOR: attKey("constructor", NONE_TYPE),
  DEPENDS: attKey("depends", ANY_TYPE),
  DIGEST: attKey("digest", ANY_TYPE),
  ELEMENT: attKey("element", ANY_TYPE),
  EXIT: attKey("exit", ANY_TYPE),
  FORMAT: attKey("format", FORMAT_TYPE),
  FRESH_GENERATOR: attKey("freshGenerator", NONE_TYPE),
  FUNCTION: attKey("function", NONE_TYPE),
  FUNCTIONAL: attKey("functional", NONE_TYPE),
  GROUP: attKey("group", STR_TYPE),
  HAS_DOMAIN_VALUES: attKey("hasDomainValues", NONE_TYPE),
  HOOK: attKey("hook", ANY_TYPE),
  HYBRID: attKey("hybrid", OPTIONAL_STR_TYPE),
  IDEM: attKey("idem", NONE_TYPE),
  IMPURE: attKey("impure", NONE_TYPE),
  INDEX: attKey("index", INT_TYPE),
  INITIALIZER: attKey("initializer", NONE_TYPE),
  INJECTIVE: attKey("injective", NONE_TYPE),
  LABEL: attKey("label", ANY_TYPE),
  LEFT: attKey("left", ANY_TYPE), // LEFT and LEFT_INTERNAL on the Frontend
  LOCATION: attKey("org.kframework.attributes.Location", LOCATION_TYPE),
  MACRO: attKey("macro", NONE_TYPE),
  MACRO_REC: attKey("macro-rec", NONE_TYPE),
  MAINCELL: attKey("maincell", NONE_TYPE),
  MULTIPLICITY: attKey("multiplicity", ANY_TYPE),
  NO_EVALUATORS: attKey("no-evaluators", NONE_TYPE),
  OVERLOAD: attKey("overload", STR_TYPE),
  OWISE: attKey("owise", NONE_TYPE),
  PREDICATE: attKey("predicate", ANY_TYPE),
  PREFER: attKey("prefer", NONE_TYPE),
  PRIORITY: attKey("priority", ANY_TYPE),
  PRIORITIES: attKey("priorities", ANY_TYPE), // only in KORE output
  PRIVATE: attKey("private", NONE_TYPE),
  PRODUCTION: attKey("org.kframework.definition.Production", ANY_TYPE),
  PROJECTION: attKey("projection", NONE_TYPE),
  PUBLIC: attKey("public", NONE_TYPE),
  RIGHT: attKey("right", ANY_TYPE), // RIGHT and RIGHT_INTERNAL on the Frontend
  RETURNS_UNIT: attKey("returnsUnit", NONE_TYPE),
  SIMPLIFICATION: attKey("simplification", ANY_TYPE),
  SEQSTRICT: attKey("seqstrict", ANY_TYPE),
  SORT: attKey("org.kframework.kore.Sort", ANY_TYPE),
  SOURCE: attKey("org.kframework.attributes.Source", PATH_TYPE),
  STREAM: attKey("stream", OPTIONAL_STR_TYPE),
  SMTLEMMA: attKey("smt-lemma", NONE_TYPE),
  STRICT: attKey("strict", ANY_TYPE),
  SYMBOL: attKey("symbol", STR_TYPE),
  SYNTAX_MODULE: attKey("syntaxModule", STR_TYPE),
  SYMBOLIC: attKey("symbolic", OPTIONAL_STR_TYPE),
  TERMINALS: attKey("terminals", STR_TYPE),
  TERMINATOR_SYMBOL: attKey("terminator-symbol", ANY_TYPE),
  TOKEN: attKey("token", NONE_TYPE),
  TOTAL: attKey("total", NONE_TYPE),
  TRUSTED: attKey("trusted", NONE_TYPE),
  TYPE: attKey("type", ANY_TYPE),
  UNIT: attKey("unit", STR_TYPE),
  UNIQUE_ID: attKey("UNIQUE_ID", ANY_TYPE),
  UNPARSE_AVOID: attKey("unparseAvoid", NONE_TYPE),
  UNUSED: attKey("unused", NONE_TYPE),
  UPDATE: attKey("update", ANY_TYPE),
  USER_LIST: attKey("userList", ANY_TYPE),
  WRAP_ELEMENT: attKey("wrapElement", ANY_TYPE),
} as const;

let keysCache: ReadonlyMap<string, AttKey> | undefined;

/**
 * `Atts.keys()` (`att.py:369-375`) — name → key, built once.
 *
 * The upstream assertion that no two registry entries share a name is kept: a
 * duplicate would make one of the two typings unreachable, silently.
 */
export function attKeys(): ReadonlyMap<string, AttKey> {
  if (keysCache === undefined) {
    const keys: readonly AttKey[] = Object.values(Atts);
    const map = new Map<string, AttKey>();
    for (const key of keys) map.set(key.name, key);
    if (map.size !== keys.length) throw new TypeError("Atts contains two keys with the same name");
    keysCache = map;
  }
  return keysCache;
}

//////////////////////////////
// KAtt                     //
//////////////////////////////

/** What {@link KAtt.parse} accepts: pairs, or a plain record. */
export type AttTextLike = Iterable<readonly [string, string]> | Readonly<Record<string, string>>;

/**
 * An immutable attribute mapping (`att.py:380-452`).
 *
 * Insertion-ordered like the Python dict it transcribes, keyed by
 * {@link AttKey.name}, and never mutated: {@link KAtt.update},
 * {@link KAtt.discard} and {@link KAtt.dropSource} all return a new `KAtt`.
 */
export class KAtt implements Iterable<AttEntry> {
  readonly #atts: ReadonlyMap<string, AttEntry>;

  /**
   * `KAtt(entries=...)` (`att.py:386-389`).
   *
   * A repeated name keeps the **first** key object and the **last** value —
   * `dict` semantics, which decide which codec `toDict` and `pretty` use.
   */
  constructor(entries: Iterable<AttEntry> = []) {
    const atts = new Map<string, AttEntry>();
    for (const entry of entries) {
      const existing = atts.get(entry.key.name);
      atts.set(entry.key.name, existing === undefined ? entry : attEntry(existing.key, entry.value));
    }
    this.#atts = atts;
  }

  /** `len(att)` (`att.py:394-395`). */
  get size(): number {
    return this.#atts.size;
  }

  /** Whether the key is present — including a nullary one, whose value is `null`. */
  has(key: AttKey): boolean {
    return this.#atts.has(key.name);
  }

  /**
   * `att.get(key)` (`att.py:400-408`), typed by the key.
   *
   * The map is heterogeneous, so its values are erased to `unknown` and the
   * key's type parameter is what restores them — the same trade pyk makes by
   * declaring `KAtt` a `Mapping[AttKey, Any]` and putting the real typing in
   * `get`'s overloads.  Whether the erasure is sound is decided where the
   * entry is built: {@link attEntry} pairs a key with a value of *its* type,
   * and both this class and {@link KAtt.fromDict} only ever build entries that
   * way.
   */
  get<T>(key: AttKey<T>): T | undefined {
    const found = this.#atts.get(key.name);
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion
    return found === undefined ? undefined : (found.value as T);
  }

  /** `att[key]` (`att.py:397-398`) — throws when absent. */
  require<T>(key: AttKey<T>): T {
    const found = this.#atts.get(key.name);
    if (found === undefined) throw new TypeError(`Attribute not found: ${key.name}`);
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion
    return found.value as T;
  }

  /** The keys, in insertion order (`att.py:391-392`). */
  *keys(): IterableIterator<AttKey> {
    for (const entry of this.#atts.values()) yield entry.key;
  }

  /** `att.entries()` (`att.py:410`). */
  entries(): IterableIterator<AttEntry> {
    return this.#atts.values();
  }

  /**
   * Iterating yields entries.
   *
   * pyk iterates *keys* (`KAtt` is a `Mapping`); a JavaScript `Map` iterates
   * entries, and matching the language beats matching the port here — the keys
   * are one {@link KAtt.keys} call away.
   */
  [Symbol.iterator](): IterableIterator<AttEntry> {
    return this.#atts.values();
  }

  /**
   * `KAtt.from_dict` (`att.py:412-419`) — reads `{node: 'KAtt', att: {...}}`.
   *
   * An unregistered name becomes an {@link ANY_TYPE} key, so nothing in a
   * `compiled.json` is lost on the way in.  Extra keys on the envelope are
   * ignored, as everywhere in this package.
   */
  static fromDict(value: unknown, path = "att"): KAtt {
    if (!isRecord(value)) throw attError(`Expected an object, got ${describe(value)}`, path);
    if (!Object.hasOwn(value, "att")) throw attError('KAtt is missing the field "att"', path);
    const atts = value["att"];
    if (!isRecord(atts)) throw attError(`Expected an object, got ${describe(atts)}`, `${path}.att`);
    const entries: AttEntry[] = [];
    for (const [name, raw] of Object.entries(atts)) {
      const key = attKeys().get(name) ?? attKey(name, ANY_TYPE);
      entries.push(attEntry(key, key.type.fromDict(raw, `${path}.att.${name}`)));
    }
    return new KAtt(entries);
  }

  /** `KAtt.to_dict` (`att.py:421-422`). */
  toDict(): JsonObject {
    const att: Record<string, JsonValue> = {};
    for (const entry of this.#atts.values()) att[entry.key.name] = entry.key.type.toDict(entry.value);
    return { node: "KAtt", att };
  }

  /**
   * `KAtt.parse` (`att.py:425-427`) — the *textual* attribute syntax, one
   * already-split `name → text` pair per attribute.
   *
   * Throws for any {@link ANY_TYPE} key, registered or not, because
   * `AnyType.parse` throws (`att.py:95-96`).
   */
  static parse(d: AttTextLike): KAtt {
    const pairs = Symbol.iterator in d ? d : Object.entries(d);
    const entries: AttEntry[] = [];
    for (const [name, text] of pairs) {
      const key = attKeys().get(name) ?? attKey(name, ANY_TYPE);
      entries.push(attEntry(key, key.type.parse(text)));
    }
    return new KAtt(entries);
  }

  /**
   * `KAtt.pretty` (`att.py:429-440`): `[symbol("foo"), function, total]`, and
   * the empty string — not `[]` — when there is nothing to print.
   */
  get pretty(): string {
    if (this.#atts.size === 0) return "";
    const parts: string[] = [];
    for (const entry of this.#atts.values()) {
      const text = entry.key.type.unparse(entry.value);
      parts.push(text === null ? entry.key.name : `${entry.key.name}(${text})`);
    }
    return `[${parts.join(", ")}]`;
  }

  /** `KAtt.update` (`att.py:442-444`) — later entries win, key order is kept. */
  update(entries: Iterable<AttEntry>): KAtt {
    return new KAtt([...this.#atts.values(), ...entries]);
  }

  /** `KAtt.discard` (`att.py:446-448`) — by key *name*, missing keys are fine. */
  discard(keys: Iterable<AttKey>): KAtt {
    const names = new Set<string>();
    for (const key of keys) names.add(key.name);
    return new KAtt([...this.#atts.values()].filter((entry) => !names.has(entry.key.name)));
  }

  /** `KAtt.drop_source` (`att.py:450-451`) — drops `Source` *and* `Location`. */
  dropSource(): KAtt {
    return this.discard([Atts.SOURCE, Atts.LOCATION]);
  }

  /**
   * Structural equality, over the JSON encoding.
   *
   * Python gets this from `FrozenDict.__eq__`; here the canonical JSON of
   * {@link KAtt.toDict} is the same decision procedure — key order does not
   * matter in either language — and reuses the encoder the term hashes
   * already agree with pyk on.
   */
  equals(other: KAtt): boolean {
    if (this === other) return true;
    if (this.#atts.size !== other.#atts.size) return false;
    return canonicalJson(this.toDict()) === canonicalJson(other.toDict());
  }
}

/** `EMPTY_ATT` (`att.py:454`). */
export const EMPTY_ATT: KAtt = new KAtt();

//////////////////////////////
// WithKAtt                  //
//////////////////////////////

/**
 * Anything carrying attributes — every outer sentence, module and definition
 * (`att.py:457-467`).
 */
export interface WithKAtt {
  readonly att: KAtt;
}

/**
 * `let_att` (`att.py:461`) as a parameter rather than an abstract method:
 * outer nodes are plain frozen objects, so "the same node with these
 * attributes" is a function the caller supplies (usually its `letX` copier).
 */
export type LetAtt<T extends WithKAtt> = (node: T, att: KAtt) => T;

/** `map_att` (`att.py:463-464`). */
export function mapAtt<T extends WithKAtt>(node: T, f: (att: KAtt) => KAtt, letAtt: LetAtt<T>): T {
  return letAtt(node, f(node.att));
}

/** `update_atts` (`att.py:466-467`). */
export function updateAtts<T extends WithKAtt>(node: T, entries: Iterable<AttEntry>, letAtt: LetAtt<T>): T {
  return letAtt(node, node.att.update(entries));
}
