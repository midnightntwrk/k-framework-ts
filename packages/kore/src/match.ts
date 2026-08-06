/**
 * Reading values *out* of a KORE term — pyk `kore/match.py` (302 lines, K
 * v7.1.337), the exact destructor counterpart of `prelude.ts`.
 *
 * This is what turns a kore-rpc `execute`/`get-model`/`simplify` response into
 * domain objects without a KORE→KAST conversion: `matchApp` peels a cell,
 * `koreInt` reads a `\dv`, and the collection decoders undo the
 * `\left-assoc{}(cons{}(item{}(…), …))` encoding that `prelude.ts` writes.
 * Every decoder here is the inverse of a builder there, and the encoding's
 * symbol names are *imported* from there rather than re-spelled: pyk writes the
 * cell-map table twice, at `prelude.py:246-249` and again at `match.py:75-77`,
 * and two copies of an encoding are two things that can drift.
 *
 * # Failure is an exception, deliberately
 *
 * `symbols.ts` returns `undefined` where pyk raises, because a question about a
 * definition ("what sort is this?") can honestly have no answer.  This module
 * does the opposite and throws {@link KoreMatchError}, because pyk's point-free
 * composition depends on it: `koreMapOf(koreInt, koreStr)` is
 * `matchMap` followed by two decoders per entry, and a decoder that could
 * return `undefined` would make every composite return
 * `(readonly [bigint | undefined, string | undefined])[]`.  A term that does
 * not have the shape you asserted is a bug in the caller or a change in the
 * semantics, not a value.
 *
 * The error carries the offending {@link Pattern} — pyk's message inlines a
 * `repr()` of the whole term, which for a real configuration is unreadable.
 * The message names the mismatch; `error.pattern` is the term.
 *
 * # Deviations from pyk, all deliberate
 *
 * - **`koreInt` returns `bigint`.**  K's `Int` is unbounded and a real
 *   `\dv{SortInt{}}` out of a semantics routinely exceeds 2^53 (a 256-bit EVM
 *   word does).  `Number` would silently round; `intDv` already accepts `bigint`
 *   on the way back in, so the round trip is exact.
 * - **pyk's overloaded `arg(int | str)` is two functions**, {@link argAt} and
 *   {@link argNamed}, and its `args(*ints | *strs)` is {@link argsAt} and
 *   {@link argsNamed}.  TypeScript can express the overload, but the two
 *   behaviours are genuinely different — positional indexing versus a
 *   search by head symbol — and pyk's own signature needs eleven `@overload`
 *   declarations (`match.py:152-218`) to say so.
 * - **The names `app`, `arg`, `args`, `inj` are not reused.**  `match.py` is a
 *   module you `import ... as km` and read as `km.app(...)`; this package's
 *   barrel exports `app` (the `App` constructor, `syntax.ts`) and
 *   `@kframework-ts/kore/prelude` exports `inj`.  The higher-order matchers are
 *   {@link appOf}, {@link argAt}/{@link argNamed}, {@link argsAt}/{@link
 *   argsNamed} and {@link injArg}.
 * - **No `>>` chaining operator.**  pyk's `Chainable` (`utils.py`) exists to
 *   give Python a composition operator; `(p) => argAt(0)(appOf("Lblfoo")(p))`
 *   needs nothing.
 * - **`matchMap`/`koreMapOf` take an options object** where pyk takes a
 *   keyword-only `cell=` argument, since TypeScript has no keyword arguments and
 *   a bare trailing `string` next to a decoder would be easy to misread.
 *
 * Unlike `prelude.ts`, this module **is** part of the package barrel: none of
 * its exported names collide with `@kframework-ts/kast`'s.
 */

import { bytesEncode } from "./escape.js";
import {
  BOOL,
  BYTES,
  ID,
  INJ,
  INT,
  LBL_LIST,
  LBL_LIST_ITEM,
  LBL_RANGEMAP,
  LBL_RANGEMAP_ITEM,
  LBL_RANGEMAP_RANGE,
  LBL_SET,
  LBL_SET_ITEM,
  mapSymbols,
  STOP_LIST,
  STOP_RANGEMAP,
  STOP_SET,
  STRING,
} from "./prelude.js";
import { type App, type DV, koreText, type LeftAssoc, type Pattern, type Sort } from "./syntax.js";

//////////////////////////
// Failure              //
//////////////////////////

/**
 * A term did not have the shape a matcher asserted — pyk's `ValueError`
 * (`utils.py:117-120` `check_type`, and `match.py`'s own raises).
 *
 * `TypeError` rather than `Error`: every failure reachable here is "this node is
 * not of the kind/shape I require", which is what `syntax.ts` and `json.ts`
 * already throw `TypeError` for.  `pattern` is the subterm that failed, so a
 * decoder six levels into a configuration can be diagnosed without re-running
 * it; it is `undefined` only for {@link matchSymbol}, which compares two names
 * and never sees a node.
 */
export class KoreMatchError extends TypeError {
  readonly pattern: Pattern | undefined;

  constructor(message: string, pattern?: Pattern) {
    super(message);
    this.name = "KoreMatchError";
    this.pattern = pattern;
  }
}

/** How a `Pattern` is named in an error message: its tag, plus its text if short. */
function describe(pattern: Pattern): string {
  const text = koreText(pattern);
  return text.length <= 80 ? text : `${pattern.tag} (${text.length} chars)`;
}

//////////////////////////
// Node matchers        //
//////////////////////////

/**
 * Assert a pattern is a `\dv`, optionally of a given sort — pyk `match_dv`
 * (`match.py:21-25`).
 *
 * The sort is compared **structurally** (by KORE text), as pyk's frozen
 * dataclass equality does, so a freshly built `sortApp("SortInt")` matches the
 * `INT` singleton.
 */
export function matchDv(pattern: Pattern, sort?: Sort): DV {
  if (pattern.tag !== "DV") {
    throw new KoreMatchError(`Expected a \\dv, got: ${describe(pattern)}`, pattern);
  }
  if (sort !== undefined && koreText(pattern.sort) !== koreText(sort)) {
    throw new KoreMatchError(`Expected sort ${koreText(sort)}, found: ${koreText(pattern.sort)}`, pattern);
  }
  return pattern;
}

/** Assert two symbol names are equal — pyk `match_symbol` (`match.py:28-30`). */
export function matchSymbol(actual: string, expected: string): void {
  if (actual !== expected) {
    throw new KoreMatchError(`Expected symbol ${expected}, found: ${actual}`);
  }
}

/**
 * Assert a pattern is an application, optionally of a given symbol — pyk
 * `match_app` (`match.py:33-37`).
 *
 * Strictly `App`: a `\left-assoc{}(f{}(…))` is **not** an application of `f`
 * here, exactly as pyk's `type(pattern) is App` check makes it not one.  Use
 * {@link matchLeftAssoc} for those.
 */
export function matchApp(pattern: Pattern, symbol?: string): App {
  if (pattern.tag !== "App") {
    throw new KoreMatchError(`Expected an application, got: ${describe(pattern)}`, pattern);
  }
  if (symbol !== undefined && pattern.symbol !== symbol) {
    throw new KoreMatchError(`Expected symbol ${symbol}, found: ${pattern.symbol}`, pattern);
  }
  return pattern;
}

/** Assert a pattern is a sort injection — pyk `match_inj` (`match.py:40-41`). */
export function matchInj(pattern: Pattern): App {
  return matchApp(pattern, INJ);
}

/**
 * Assert a pattern is a `\left-assoc`, optionally of a given symbol — pyk
 * `match_left_assoc` (`match.py:44-48`).
 *
 * Every collection this module decodes is written that way by `prelude.ts`; a
 * collection that came back from a backend may instead be a right-nested chain
 * of binary applications, which is a different shape and is not accepted here
 * (pyk does not accept it either).
 */
export function matchLeftAssoc(pattern: Pattern, symbol?: string): LeftAssoc {
  if (pattern.tag !== "LeftAssoc") {
    throw new KoreMatchError(`Expected a \\left-assoc, got: ${describe(pattern)}`, pattern);
  }
  if (symbol !== undefined && pattern.symbol !== symbol) {
    throw new KoreMatchError(`Expected symbol ${symbol}, found: ${pattern.symbol}`, pattern);
  }
  return pattern;
}

//////////////////////////
// Collections          //
//////////////////////////

/** The one argument of an item application, or a {@link KoreMatchError}. */
function itemArg(item: App, index: number): Pattern {
  const arg = item.args[index];
  if (arg === undefined) {
    throw new KoreMatchError(`Expected at least ${index + 1} argument(s) of ${item.symbol}`, item);
  }
  return arg;
}

/**
 * The elements of a `List` term — pyk `match_list` (`match.py:51-59`), the
 * inverse of `prelude.ts`'s `listPattern`.
 *
 * An `App` must be the unit symbol `Lbl'Stop'List` and decodes to no elements;
 * anything else must be `\left-assoc{}(Lbl'Unds'List'Unds'{}(LblListItem{}(e), …))`.
 */
export function matchList(pattern: Pattern): readonly Pattern[] {
  if (pattern.tag === "App") {
    matchApp(pattern, STOP_LIST.symbol);
    return [];
  }
  const assoc = matchLeftAssoc(pattern, LBL_LIST);
  return assoc.args.map((arg) => itemArg(matchApp(arg, LBL_LIST_ITEM), 0));
}

/**
 * The elements of a `Set` term — pyk `match_set` (`match.py:62-70`), the inverse
 * of `prelude.ts`'s `setPattern`.
 *
 * The result is an array, not a `Set`: the elements are arbitrary patterns with
 * no useful JS identity, order in the term is information a caller may want, and
 * duplicates are a term property this must not silently erase.
 */
export function matchSet(pattern: Pattern): readonly Pattern[] {
  if (pattern.tag === "App") {
    matchApp(pattern, STOP_SET.symbol);
    return [];
  }
  const assoc = matchLeftAssoc(pattern, LBL_SET);
  return assoc.args.map((arg) => itemArg(matchApp(arg, LBL_SET_ITEM), 0));
}

/**
 * The entries of a `Map` term — pyk `match_map` (`match.py:73-86`), the inverse
 * of `prelude.ts`'s `mapPattern`, `cell` and all.
 *
 * Entries, not a `Map`: keys are patterns, so a JS `Map` would key them by
 * identity and lose every duplicate-key term the backend can legally produce.
 */
export function matchMap(
  pattern: Pattern,
  options: { readonly cell?: string } = {},
): readonly (readonly [Pattern, Pattern])[] {
  const { stop, cons, item } = mapSymbols(options.cell);
  if (pattern.tag === "App") {
    matchApp(pattern, stop);
    return [];
  }
  const assoc = matchLeftAssoc(pattern, cons);
  return assoc.args.map((arg) => {
    const entry = matchApp(arg, item);
    return [itemArg(entry, 0), itemArg(entry, 1)] as const;
  });
}

/**
 * The entries of a `RangeMap` term — pyk `match_rangemap` (`match.py:89-108`),
 * the inverse of `prelude.ts`'s `rangemapPattern`.
 *
 * Each key is the `[start, end)` pair inside a `LblRangeMap'Coln'Range`
 * application.
 */
export function matchRangeMap(pattern: Pattern): readonly (readonly [readonly [Pattern, Pattern], Pattern])[] {
  if (pattern.tag === "App") {
    matchApp(pattern, STOP_RANGEMAP.symbol);
    return [];
  }
  const assoc = matchLeftAssoc(pattern, LBL_RANGEMAP);
  return assoc.args.map((arg) => {
    const entry = matchApp(arg, LBL_RANGEMAP_ITEM);
    const range = matchApp(itemArg(entry, 0), LBL_RANGEMAP_RANGE);
    return [[itemArg(range, 0), itemArg(range, 1)] as const, itemArg(entry, 1)] as const;
  });
}

//////////////////////////
// Domain values        //
//////////////////////////

/**
 * A `\dv{SortBool{}}` as a boolean — pyk `kore_bool` (`match.py:111-119`).
 *
 * Only the two literals the semantics writes are accepted; anything else is a
 * malformed term rather than a truthiness question.
 */
export function koreBool(pattern: Pattern): boolean {
  const node = matchDv(pattern, BOOL);
  switch (node.value.value) {
    case "true":
      return true;
    case "false":
      return false;
    default:
      throw new KoreMatchError(`Invalid Boolean domain value: ${koreText(node)}`, pattern);
  }
}

/**
 * The spelling of a `\dv{SortInt{}}` literal: an optional sign and decimal
 * digits, and nothing else.
 *
 * Both `BigInt()` and Python's `int()` are *looser* than this, in different
 * directions, and neither looseness can be reached from a well-formed KORE
 * term: `BigInt("")` is `0n` where `int("")` raises; `BigInt("0x10")` is `16n`
 * where `int("0x10")` raises; `int(" 12 ")` and `int("1_000")` are `12` and
 * `1000` where `BigInt` rejects the underscore.  Rather than pick one
 * implementation's accidents, {@link koreInt} accepts exactly what
 * `ModuleToKORE.java` writes and `intDv` produces.
 */
const INT_LITERAL = /^[+-]?[0-9]+$/u;

/**
 * A `\dv{SortInt{}}` as a `bigint` — pyk `kore_int` (`match.py:122-124`).
 *
 * `bigint`, not `number`: see the module header.  The literal is validated
 * against {@link INT_LITERAL} before conversion, which is where this differs
 * from pyk's bare `int(...)` — see that constant for why neither language's
 * built-in parse is the right contract.
 */
export function koreInt(pattern: Pattern): bigint {
  const node = matchDv(pattern, INT);
  if (!INT_LITERAL.test(node.value.value)) {
    throw new KoreMatchError(`Invalid Int domain value: ${koreText(node)}`, pattern);
  }
  return BigInt(node.value.value);
}

/**
 * A `\dv{SortBytes{}}` as bytes — pyk `kore_bytes` (`match.py:127-129`).
 *
 * The literal's characters *are* the bytes, latin-1 encoded — `bytesEncode`
 * (`escape.ts`, pyk `dequote.py:26-27`), the exact inverse of `prelude.ts`'s
 * `bytesDv`.  A character above U+00FF cannot be a byte and is rejected there.
 */
export function koreBytes(pattern: Pattern): Uint8Array {
  return bytesEncode(matchDv(pattern, BYTES).value.value);
}

/**
 * A `\dv{SortString{}}` as a string — pyk `kore_str` (`match.py:132-134`).
 *
 * The value is already unescaped: escaping is a property of KORE *text*, and
 * both the parser and the JSON decoder hand back the decoded characters.
 */
export function koreStr(pattern: Pattern): string {
  return matchDv(pattern, STRING).value.value;
}

/** A `\dv{SortId{}}` as a string — pyk `kore_id` (`match.py:137-139`). */
export function koreId(pattern: Pattern): string {
  return matchDv(pattern, ID).value.value;
}

//////////////////////////
// Combinators          //
//////////////////////////

/** A decoder: something that reads a `T` out of a pattern, or throws. */
export type PatternDecoder<T> = (pattern: Pattern) => T;

/**
 * {@link matchApp} as a decoder — pyk `app` (`match.py:145-149`).
 *
 * The point of the higher-order layer is naming a projection once and applying
 * it to every response: `const readK = (p: Pattern) => argAt(0)(appOf(LBL_K)(p))`.
 */
export function appOf(symbol?: string): PatternDecoder<App> {
  return (pattern) => matchApp(pattern, symbol);
}

/**
 * The `n`th argument of an application, by **position** — pyk `arg(int)`
 * (`match.py:160-166`).
 *
 * pyk's bounds check is `len(app.args) <= id`, which lets a negative index
 * through to Python's from-the-end indexing; a negative index here is out of
 * range, because JS `args[-1]` is `undefined` and silently decoding the wrong
 * argument is worse than a message.
 */
export function argAt(n: number): (app: App) => Pattern {
  return (app) => {
    const arg = app.args[n];
    if (arg === undefined || n < 0) {
      throw new KoreMatchError(`Argument index is out of range: ${n} of ${app.args.length}`, app);
    }
    return arg;
  };
}

/**
 * The first argument that is an application of `symbol` — pyk `arg(str)`
 * (`match.py:168-172`).
 *
 * This is how a cell is read out of a configuration without depending on the
 * order `kompile` chose to emit the cells in.
 */
export function argNamed(symbol: string): (app: App) => App {
  return (app) => {
    for (const arg of app.args) {
      if (arg.tag === "App" && arg.symbol === symbol) return arg;
    }
    throw new KoreMatchError(`No matching argument found for symbol: ${symbol}`, app);
  };
}

/**
 * Several arguments by **position**, in the order asked for — pyk `args(*ints)`
 * (`match.py:221-228`).
 *
 * `argsAt(2, 0)` is `[args[2], args[0]]`; repeats are allowed and repeat the
 * argument.
 */
export function argsAt(...ns: readonly number[]): (app: App) => readonly Pattern[] {
  const projections = ns.map((n) => argAt(n));
  return (app) => projections.map((project) => project(app));
}

/**
 * Several arguments by **head symbol**, in the order asked for — pyk
 * `args(*strs)` (`match.py:230-243`).
 *
 * The scan is single-pass and first-occurrence-wins per symbol, as pyk's is, so
 * a configuration with two `<account>` cells yields the first for both a
 * `argsNamed("Lblaccount")` and a repeated one.  A repeated symbol in the
 * request yields the same argument twice (pyk's `set(ids)` collapses the
 * lookup, its output comprehension does not).
 *
 * If any symbol is missing, the error names **every** missing one, so a caller
 * fixing a projection against a changed semantics learns all of it at once.
 */
export function argsNamed(...symbols: readonly string[]): (app: App) => readonly App[] {
  return (app) => {
    const found = new Map<string, App>();
    const wanted = new Set(symbols);
    for (const arg of app.args) {
      if (arg.tag !== "App" || !wanted.has(arg.symbol) || found.has(arg.symbol)) continue;
      found.set(arg.symbol, arg);
      if (found.size === wanted.size) break;
    }
    const matched: App[] = [];
    const missing = new Set<string>();
    for (const symbol of symbols) {
      const arg = found.get(symbol);
      if (arg === undefined) missing.add(symbol);
      else matched.push(arg);
    }
    if (missing.size > 0) {
      throw new KoreMatchError(`No matching arguments found for symbols: ${[...missing].join(", ")}`, app);
    }
    return matched;
  };
}

/**
 * Strip one sort injection — pyk `inj` (`match.py:248-249`).
 *
 * Exactly one: `inj{A, C}(inj{B, C}(p))` gives back the inner injection, because
 * that is a distinct term from `inj{A, C}(p)` and collapsing it would be a
 * simplification, not a projection.
 */
export function injArg(pattern: Pattern): Pattern {
  return argAt(0)(matchInj(pattern));
}

/**
 * Decode every element of a `List` — pyk `kore_list_of` (`match.py:252-256`).
 */
export function koreListOf<T>(item: PatternDecoder<T>): PatternDecoder<readonly T[]> {
  return (pattern) => matchList(pattern).map((element) => item(element));
}

/** Decode every element of a `Set` — pyk `kore_set_of` (`match.py:259-263`). */
export function koreSetOf<T>(item: PatternDecoder<T>): PatternDecoder<readonly T[]> {
  return (pattern) => matchSet(pattern).map((element) => item(element));
}

/**
 * Decode every entry of a `Map` — pyk `kore_map_of` (`match.py:266-275`).
 *
 * `koreMapOf(koreInt, koreStr)` reads `Map{1 ↦ "x"}` as `[[1n, "x"]]`.  Entries
 * rather than a JS `Map`, for {@link matchMap}'s reason — though a caller whose
 * key decoder produces something with value identity (a `string`, a `bigint`)
 * can say `new Map(koreMapOf(koreStr, koreInt)(p))`.
 */
export function koreMapOf<K, V>(
  key: PatternDecoder<K>,
  value: PatternDecoder<V>,
  options: { readonly cell?: string } = {},
): PatternDecoder<readonly (readonly [K, V])[]> {
  return (pattern) => matchMap(pattern, options).map(([k, v]) => [key(k), value(v)] as const);
}

/**
 * Decode every entry of a `RangeMap` — pyk `kore_rangemap_of`
 * (`match.py:278-285`).  Both ends of a range go through `key`, as pyk's do.
 */
export function koreRangeMapOf<K, V>(
  key: PatternDecoder<K>,
  value: PatternDecoder<V>,
): PatternDecoder<readonly (readonly [readonly [K, K], V])[]> {
  return (pattern) =>
    matchRangeMap(pattern).map(([[start, end], v]) => [[key(start), key(end)] as const, value(v)] as const);
}

/**
 * Dispatch on an application's head symbol — pyk `case_symbol`
 * (`match.py:288-302`), built on its `case` combinator (`utils.py:228-242`).
 *
 * First match wins, cases are tried in order, and with no `fallback` an
 * unmatched symbol throws.  This is how a sum type comes back out of a term:
 * one case per constructor, `fallback` for "the semantics grew a constructor
 * since this was written", or no `fallback` to be told about it.
 */
export function caseSymbol<T>(
  cases: Iterable<readonly [string, (app: App) => T]>,
  fallback?: (app: App) => T,
): PatternDecoder<T> {
  const arms = [...cases];
  return (pattern) => {
    const app = matchApp(pattern);
    for (const [symbol, then] of arms) {
      if (app.symbol === symbol) return then(app);
    }
    if (fallback !== undefined) return fallback(app);
    throw new KoreMatchError(`No match found for symbol: ${app.symbol}`, app);
  };
}
