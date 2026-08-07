/**
 * The KORE prelude — the sorts, symbol names and pattern shapes every `kompile`
 * output shares and that nothing in the grammar names.
 *
 * Transcribed from pyk `kore/prelude.py` (BSD-3-Clause, K v7.1.337), and
 * cross-checked against the normative source: `prelude.kore`, the 61-line file
 * at `haskell-backend/src/main/native/haskell-backend/src/main/kore/prelude.kore`
 * that `KoreBackend.java:95` prepends to every `definition.kore`.  Two of its
 * declarations are what the constructors below are written against, and they
 * appear in no Java or Python source — only there:
 *
 * ```kore
 * symbol kseq{}(SortKItem{}, SortK{}) : SortK{} [constructor, functional, injective]
 * symbol dotk{}()                     : SortK{} [constructor, functional, injective]
 * symbol append{}(SortK{}, SortK{})   : SortK{} [function, functional]
 * symbol inj{From, To}(From) : To                [sortInjection]
 * ```
 *
 * `kseq`'s argument sorts are `(SortKItem{}, SortK{})` while `append`'s are
 * `(SortK{}, SortK{})` — the head of a K sequence is an item and its tail is a
 * sequence — and `inj{From, To}` fixes the parameter order that
 * `AddSortInjections.java:199` spells `KLabel("inj", actualSort, expectedSort)`.
 *
 * # What is *not* here
 *
 * The ML signatures (`\and`, `\ceil`, …) are not in `prelude.kore` either: they
 * are grammar-level, and `syntax.ts` already models them as first-class pattern
 * nodes.  The three reachability aliases (`weakExistsFinally`,
 * `weakAlwaysFinally`, `allPathGlobally`) are reachable only from reachability
 * claims and are not modelled.
 *
 * The one part of `prelude.py` still not here is its **JSON↔KORE bridge**
 * (`prelude.py:269-388`: `SORT_JSON`, `LblJSONs`, `json_to_kore`,
 * `kore_to_json`).  Two reasons, both deliberate:
 *
 * - It is not prelude vocabulary.  `SortJSON`, `LblJSONList` and friends are
 *   declared by the K standard library's `JSON` module, which a semantics opts
 *   into; nothing in `prelude.kore` mentions them, and nothing `kompile` emits
 *   for a semantics without that import will contain them.  Every other name in
 *   this file is universal.
 * - pyk's read direction is broken against pyk's own write direction.
 *   `json_to_kore` emits `jsons(...)` as a single `\right-assoc{}(LblJSONs{}(…))`
 *   (`prelude.py:304-305`), while `_iter_json_list` walks a right-nested chain of
 *   *binary* `LblJSONs` applications (`prelude.py:366-374`) — so
 *   `kore_to_json(json_to_kore([1]))` raises `ValueError: Expected object of type
 *   App, got: RightAssoc(...)`.  Only terms that came back from a backend (which
 *   expands the assoc sugar) can be read.  Transcribing that as-is would import a
 *   defect; fixing it would mean inventing semantics.  Reproduce it beside the
 *   consumer that needs it, against that consumer's real terms.
 *
 * # Deviations from pyk, all deliberate
 *
 * - `SymbolId`, pyk's newtype for a validated identifier, is not reproduced:
 *   `App.symbol` is a `string` in this package and {@link isSymbolId} already
 *   validates on demand.  The `LBL_*` constants are therefore plain strings.
 * - pyk's constants are instances of frozen dataclasses; JavaScript has no such
 *   thing, so every singleton below is passed through {@link deepFrozen} before
 *   it is exported.  Without that, `BOOL.name = "SortHacked"` would rewrite the
 *   sort of `TRUE`, of `FALSE`, of `boolDv(true)` and of every `\dv{SortBool{}}`
 *   any consumer of this module ever builds — process-wide, because a module's
 *   exports are one object graph shared by every importer.  Freezing is not a
 *   security boundary (a determined caller can still `Object.defineProperty` a
 *   fresh object into a term of its own); it is what makes "these are constants"
 *   true rather than merely intended.
 * - pyk's polymorphic `dv(val)` (`prelude.py:31-40`) is not reproduced: it
 *   dispatches on Python's `type(val)`, and `bool`/`int`/`bytes`/`str` do not
 *   survive into JavaScript as four distinct runtime types (`true` and `1n` are
 *   distinguishable, but `bytes` and `str` are `Uint8Array` and `string` and the
 *   distinction is better made at the call site).  Use the four typed
 *   constructors.
 *
 * **This module is not part of the package barrel.**  `BOOL`, `STRING`, `TRUE`
 * and `inj` collide by name with `@kframework-ts/kast`'s prelude, and a
 * converter imports both; it is published as the `@kframework-ts/kore/prelude`
 * subpath instead, mirroring `@kframework-ts/kast/prelude/*`.
 */

import { bytesDecode } from "./escape.js";
import {
  app,
  type App,
  dv,
  type DV,
  type EVar,
  koreString,
  koreText,
  leftAssoc,
  type Pattern,
  rightAssoc,
  type Sort,
  type SortApp,
  sortApp,
} from "./syntax.js";

//////////////////////////
// Freezing             //
//////////////////////////

/**
 * Freeze `value` and everything reachable from it, and hand it back at its own
 * type.
 *
 * Every constant this module exports goes through here.  A shallow
 * `Object.freeze` would not be enough: a `SortApp` owns a `sorts` array, a `DV`
 * owns its `sort` and its `String` literal, an `App` owns `sorts` and `args`, and
 * leaving any of them writable leaves the constant writable through one more
 * `.`.  `definition.ts:797` freezes its answers for the same reason, one level
 * being all it needs there.
 *
 * The recursion terminates on any acyclic graph, and the AST is one — every node
 * is built here, top-down, from literals.  The `isFrozen` guard makes it
 * terminate on a cyclic one too, and keeps a shared subterm (`BOOL` inside both
 * `TRUE` and `FALSE`) from being walked twice.
 */
function deepFrozen<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFrozen(child);
  return value;
}

//////////////////////////
// Base sorts           //
//////////////////////////

/** `SortBool{}` — `prelude.py:21`. */
export const BOOL: SortApp = deepFrozen(sortApp("SortBool"));

/** `SortInt{}` — `prelude.py:22`. */
export const INT: SortApp = deepFrozen(sortApp("SortInt"));

/** `SortBytes{}` — `prelude.py:23`. */
export const BYTES: SortApp = deepFrozen(sortApp("SortBytes"));

/** `SortString{}` — `prelude.py:24`. */
export const STRING: SortApp = deepFrozen(sortApp("SortString"));

/** `SortId{}` — `prelude.py:25`. */
export const ID: SortApp = deepFrozen(sortApp("SortId"));

/** `\dv{SortBool{}}("true")` — `prelude.py:27`.  The right-hand side of every side condition. */
export const TRUE: DV = deepFrozen(dv(BOOL, koreString("true")));

/** `\dv{SortBool{}}("false")` — `prelude.py:28`. */
export const FALSE: DV = deepFrozen(dv(BOOL, koreString("false")));

//////////////////////////
// K constructs         //
//////////////////////////

/** `SortK{}` — `prelude.py:142`.  The sort everything injects into. */
export const SORT_K: SortApp = deepFrozen(sortApp("SortK"));

/** `SortKItem{}` — `prelude.py:143`.  The sort of one element of a K sequence. */
export const SORT_K_ITEM: SortApp = deepFrozen(sortApp("SortKItem"));

/** `SortKConfigVar{}` — `prelude.py:144`.  The sort of a `$PGM`-style configuration variable. */
export const SORT_K_CONFIG_VAR: SortApp = deepFrozen(sortApp("SortKConfigVar"));

/** `SortGeneratedTopCell{}` — `prelude.py:145`.  The sort every semantic rewrite rule is at. */
export const SORT_GENERATED_TOP_CELL: SortApp = deepFrozen(sortApp("SortGeneratedTopCell"));

/** `SortGeneratedCounterCell{}` — `prelude.py:146`. */
export const SORT_GENERATED_COUNTER_CELL: SortApp = deepFrozen(sortApp("SortGeneratedCounterCell"));

/**
 * `inj` — the sort-injection symbol, `prelude.py:153`.
 *
 * Declared by the `INJ` module of `prelude.kore`, so it is an ordinary declared
 * symbol and not a grammar keyword — but it is the one symbol every consumer
 * needs to name.
 */
export const INJ = "inj";

/**
 * `amb` — the K label of an ambiguity node declared by `K-AMBIGUITIES`.
 *
 * This is a K frontend extension, not a KORE grammar construct and not a pyk
 * transcription.  A bison GLR parser emits its KORE spelling, {@link LBL_AMB},
 * when more than one parse survives.  See `findAmbiguities` for the total
 * projection that consumes those ordinary applications.
 */
export const AMB = "amb";

/** `Lblamb` — the KORE spelling of {@link AMB}, emitted by GLR parsers. */
export const LBL_AMB = "Lblamb";

/** `kseq` — the K-sequence cons symbol, `prelude.py:154`. */
export const KSEQ = "kseq";

/** `Lblite` — the one polymorphic operator a converter special-cases (`prelude.py:152`). */
export const LBL_ITE = "Lblite";

/** `LblinitGeneratedTopCell` — `prelude.py:148`.  The head of every `krun` entry term. */
export const LBL_INIT_GENERATED_TOP_CELL = "LblinitGeneratedTopCell";

/** `Lbl'-LT-'generatedTop'-GT-'` — the `<generatedTop>` cell, `prelude.py:149`. */
export const LBL_GENERATED_TOP = "Lbl'-LT-'generatedTop'-GT-'";

/** `Lbl'-LT-'generatedCounter'-GT-'` — the `<generatedCounter>` cell, `prelude.py:150`. */
export const LBL_GENERATED_COUNTER = "Lbl'-LT-'generatedCounter'-GT-'";

/** `Lbl'-LT-'k'-GT-'` — the `<k>` cell, `prelude.py:151`. */
export const LBL_K = "Lbl'-LT-'k'-GT-'";

/** `dotk{}()` — the empty K sequence (`prelude.py:156`). */
export const DOTK: App = deepFrozen(app("dotk"));

/** `inj{From, To}(pattern)` — `prelude.py:175-176`.  `from` is the actual sort, `to` the expected. */
export function inj(from: Sort, to: Sort, pattern: Pattern): App {
  return app(INJ, [from, to], [pattern]);
}

/**
 * A K sequence — `prelude.py:179-192`, arities and all.
 *
 * The tail is `dotvar` if given and {@link DOTK} otherwise, and the result is
 * shaped by how many patterns there are in total (items plus tail):
 *
 * - one — no items at all — is the tail alone, *not* a `kseq` application,
 * - two is a plain `App`,
 * - three or more is a `\right-assoc{}(kseq{}(…))`.
 *
 * @throws {TypeError} if `dotvar` is not of sort `SortK{}`.  pyk raises
 *   `ValueError` here (`prelude.py:180-181`); this package has no equivalent, and
 *   a wrongly-sorted tail is malformed input rather than a question with no
 *   answer.
 */
export function kseq(items: Iterable<Pattern>, dotvar?: EVar): Pattern {
  if (dotvar !== undefined && koreText(dotvar.sort) !== koreText(SORT_K)) {
    throw new TypeError(`Expected ${koreText(SORT_K)} as dotvar sort, got: ${koreText(dotvar.sort)}`);
  }

  const tail: Pattern = dotvar ?? DOTK;
  const args: Pattern[] = [...items, tail];

  if (args.length === 1) return tail;
  if (args.length === 2) return app(KSEQ, [], args);
  return rightAssoc(KSEQ, [], args);
}

//////////////////////////
// Domain values        //
//////////////////////////

/** `\dv{SortBool{}}("true"|"false")` — `prelude.py:43-44`. */
export function boolDv(value: boolean): DV {
  return value ? TRUE : FALSE;
}

/**
 * `\dv{SortInt{}}("…")` — `prelude.py:47-48`.
 *
 * `bigint` as well as `number`, because K integers are unbounded and a `number`
 * large enough to matter would render in exponent notation: `String(1e21)` is
 * `"1e+21"`, which is not a KORE integer literal.  Every value therefore goes
 * through `BigInt` first.
 *
 * @throws {TypeError} if `value` is a `number` that is not an integer — a
 *   fractional `\dv{SortInt{}}` is malformed, not a value with an unlucky
 *   spelling.
 */
export function intDv(value: bigint | number): DV {
  if (typeof value === "number" && !Number.isInteger(value)) {
    throw new TypeError(`Expected an integer, got: ${value}`);
  }
  return dv(INT, koreString(BigInt(value).toString()));
}

/**
 * `\dv{SortBytes{}}("…")` — `prelude.py:51-52`.
 *
 * The literal's characters are the bytes, latin-1 decoded, which is what
 * `bytesDecode` (`escape.ts`, pyk `dequote.py:30-31`) does; `koreText` then
 * escapes the string, and `enquoteBytes` is what a writer of a `\dv{SortBytes}`
 * needs if it wants the byte-exact spelling.
 */
export function bytesDv(value: Uint8Array): DV {
  return dv(BYTES, koreString(bytesDecode(value)));
}

/** `\dv{SortString{}}("…")` — `prelude.py:55-56`. */
export function strDv(value: string): DV {
  return dv(STRING, koreString(value));
}

/**
 * `\dv{SortKConfigVar{}}("$PGM")` — `prelude.py:195-196`.
 *
 * The `$`-prefixed name is the caller's: pyk does not add or check one, and
 * neither does this.  {@link topCellInitializer} is what these are for.
 */
export function kConfigVar(name: string): DV {
  return dv(SORT_K_CONFIG_VAR, koreString(name));
}

//////////////////////////
// Bool operators       //
//////////////////////////

// The mangled spellings are `ModuleToKORE.java`'s encoding of the `BOOL` module's
// K labels — `demangle.ts` is the codec, `demangleName("Lbl'Unds'andBool'Unds'")`
// is `"Lbl_andBool_"`.  They are transcribed from `prelude.py:63-69` and
// cross-checked against a real `definition.kore`.

/** `notBool _` — `prelude.py:63`. */
export const LBL_NOT_BOOL = "LblnotBool'Unds'";
/** `_ andBool _` — `prelude.py:64`. */
export const LBL_AND_BOOL = "Lbl'Unds'andBool'Unds'";
/** `_ orBool _` — `prelude.py:65`. */
export const LBL_OR_BOOL = "Lbl'Unds'orBool'Unds'";
/** `_ impliesBool _` — `prelude.py:66`. */
export const LBL_IMPLIES_BOOL = "Lbl'Unds'impliesBool'Unds'";
/** `_ xorBool _` — `prelude.py:67`. */
export const LBL_XOR_BOOL = "Lbl'Unds'xorBool'Unds'";
/** `_ ==Bool _` — `prelude.py:68`. */
export const LBL_EQ_BOOL = "Lbl'UndsEqlsEqls'Bool'Unds'";
/** `_ =/=Bool _` — `prelude.py:69`. */
export const LBL_NE_BOOL = "Lbl'UndsEqlsSlshEqls'Bool'Unds'";

/**
 * `notBool` — `prelude.py:72-73`.
 *
 * These are the **`SortBool` functions of the semantics**, not the ML
 * connectives: `notBool{}(P)` is a term of sort `SortBool{}` that the backend
 * evaluates, whereas `\not{S}(P)` is a matching-logic predicate that
 * `syntax.ts` models as its own node.  A path condition is built from the
 * former and asserted with the latter (`\equals{SortBool{}, R}(cond, TRUE)`).
 *
 * Nothing here checks that its arguments are `SortBool` terms — pyk does not
 * either, and the sorts are not knowable without a definition.  Run
 * `addInjections` (`inject.ts`) over the result if you need them inserted.
 */
export function notBool(pattern: Pattern): App {
  return app(LBL_NOT_BOOL, [], [pattern]);
}

/** `_ andBool _` — `prelude.py:76-77`. */
export function andBool(left: Pattern, right: Pattern): App {
  return app(LBL_AND_BOOL, [], [left, right]);
}

/** `_ orBool _` — `prelude.py:80-81`. */
export function orBool(left: Pattern, right: Pattern): App {
  return app(LBL_OR_BOOL, [], [left, right]);
}

/** `_ impliesBool _` — `prelude.py:84-85`. */
export function impliesBool(left: Pattern, right: Pattern): App {
  return app(LBL_IMPLIES_BOOL, [], [left, right]);
}

/** `_ xorBool _` — `prelude.py:88-89`. */
export function xorBool(left: Pattern, right: Pattern): App {
  return app(LBL_XOR_BOOL, [], [left, right]);
}

/** `_ ==Bool _` — `prelude.py:92-93`. */
export function eqBool(left: Pattern, right: Pattern): App {
  return app(LBL_EQ_BOOL, [], [left, right]);
}

/** `_ =/=Bool _` — `prelude.py:96-97`. */
export function neBool(left: Pattern, right: Pattern): App {
  return app(LBL_NE_BOOL, [], [left, right]);
}

//////////////////////////
// Int operators        //
//////////////////////////

/** `_ ==Int _` — `prelude.py:104`. */
export const LBL_EQ_INT = "Lbl'UndsEqlsEqls'Int'Unds'";
/** `_ =/=Int _` — `prelude.py:105`. */
export const LBL_NE_INT = "Lbl'UndsEqlsSlshEqls'Int'Unds'";
/** `_ >Int _` — `prelude.py:106`. */
export const LBL_GT_INT = "Lbl'Unds-GT-'Int'Unds'";
/** `_ >=Int _` — `prelude.py:107`. */
export const LBL_GE_INT = "Lbl'Unds-GT-Eqls'Int'Unds'";
/** `_ <Int _` — `prelude.py:108`. */
export const LBL_LT_INT = "Lbl'Unds-LT-'Int'Unds'";
/** `_ <=Int _` — `prelude.py:109`. */
export const LBL_LE_INT = "Lbl'Unds-LT-Eqls'Int'Unds'";

/**
 * `_ ==Int _` — `prelude.py:112-113`.
 *
 * pyk carries exactly these six comparisons and no arithmetic (`+Int`, `*Int`,
 * …); this transcription carries the same six, so a consumer that needs
 * arithmetic is reminded that it is reaching past what pyk itself vouches for.
 */
export function eqInt(left: Pattern, right: Pattern): App {
  return app(LBL_EQ_INT, [], [left, right]);
}

/** `_ =/=Int _` — `prelude.py:116-117`. */
export function neInt(left: Pattern, right: Pattern): App {
  return app(LBL_NE_INT, [], [left, right]);
}

/** `_ >Int _` — `prelude.py:120-121`. */
export function gtInt(left: Pattern, right: Pattern): App {
  return app(LBL_GT_INT, [], [left, right]);
}

/** `_ >=Int _` — `prelude.py:124-125`. */
export function geInt(left: Pattern, right: Pattern): App {
  return app(LBL_GE_INT, [], [left, right]);
}

/** `_ <Int _` — `prelude.py:128-129`. */
export function ltInt(left: Pattern, right: Pattern): App {
  return app(LBL_LT_INT, [], [left, right]);
}

/** `_ <=Int _` — `prelude.py:132-133`. */
export function leInt(left: Pattern, right: Pattern): App {
  return app(LBL_LE_INT, [], [left, right]);
}

//////////////////////////
// Collections          //
//////////////////////////

/** `Lbl'Stop'List{}()` — the empty `List` (`prelude.py:217`). */
export const STOP_LIST: App = deepFrozen(app("Lbl'Stop'List"));
/** `_List_`, the `List` concatenation symbol — `prelude.py:218`. */
export const LBL_LIST = "Lbl'Unds'List'Unds'";
/** `ListItem`, the `List` element wrapper — `prelude.py:219`. */
export const LBL_LIST_ITEM = "LblListItem";

/**
 * A `List` term — `prelude.py:222-225`.
 *
 * The empty list is the unit symbol {@link STOP_LIST}; anything else is
 * `\left-assoc{}(Lbl'Unds'List'Unds'{}(LblListItem{}(e₁), …))`, and note that
 * **one** element still gets the `\left-assoc` wrapper (pyk's branch is on
 * emptiness alone, not on arity — unlike {@link kseq}, whose two-element case is
 * a bare `App`).  `match.ts`'s `matchList` is the exact inverse.
 *
 * `\left-assoc` is *sugar for a fold*, not a node the backend has to expand:
 * this package preserves it through both formats (see `README.md`), and so does
 * pyk.
 */
export function listPattern(...items: readonly Pattern[]): Pattern {
  if (items.length === 0) return STOP_LIST;
  return leftAssoc(
    LBL_LIST,
    [],
    items.map((item) => app(LBL_LIST_ITEM, [], [item])),
  );
}

/** `Lbl'Stop'Set{}()` — the empty `Set` (`prelude.py:228`). */
export const STOP_SET: App = deepFrozen(app("Lbl'Stop'Set"));
/** `_Set_`, the `Set` union symbol — `prelude.py:229`. */
export const LBL_SET = "Lbl'Unds'Set'Unds'";
/** `SetItem`, the `Set` element wrapper — `prelude.py:230`. */
export const LBL_SET_ITEM = "LblSetItem";

/**
 * A `Set` term — `prelude.py:233-236`.  Shaped exactly like {@link listPattern}.
 *
 * Duplicate elements are not detected: `Lbl'Unds'Set'Unds'` is idempotent in the
 * semantics, so `setPattern(a, a)` is a well-formed term denoting `{a}`, and
 * deciding that two *symbolic* elements are equal is the backend's job.
 */
export function setPattern(...items: readonly Pattern[]): Pattern {
  if (items.length === 0) return STOP_SET;
  return leftAssoc(
    LBL_SET,
    [],
    items.map((item) => app(LBL_SET_ITEM, [], [item])),
  );
}

/** `Lbl'Stop'Map{}()` — the empty `Map` (`prelude.py:239`). */
export const STOP_MAP: App = deepFrozen(app("Lbl'Stop'Map"));
/** `_Map_`, the `Map` union symbol — `prelude.py:240`. */
export const LBL_MAP = "Lbl'Unds'Map'Unds'";
/** `_|->_`, the `Map` entry symbol — `prelude.py:241`. */
export const LBL_MAP_ITEM = "Lbl'UndsPipe'-'-GT-Unds'";

/** The three symbol names a map encoding is built from — see {@link mapSymbols}. */
export interface MapSymbols {
  /** The unit symbol of the empty map. */
  readonly stop: string;
  /** The n-ary concatenation symbol under the `\left-assoc`. */
  readonly cons: string;
  /** The binary key↦value entry symbol. */
  readonly item: string;
}

/**
 * The symbol names of the plain `Map` sort, or of a **cell collection**.
 *
 * `syntax Foo ::= ... [cell]` inside a `<foos>` cell makes `kompile` emit a
 * *sort-specific* map with its own three symbols; `cell: "Acct"` names it and
 * gives `Lbl'Stop'AcctMap` / `Lbl'Unds'AcctMap'Unds'` / `LblAcctMapItem`.  Note
 * the item symbol is the only one that is not a suffix substitution — the plain
 * map's is the mangled `_|->_`, the cell map's is `Lbl<Cell>MapItem`.
 *
 * pyk spells these three f-strings out twice, once in the writer
 * (`prelude.py:246-249`) and once in the reader (`match.py:75-77`).  Naming them
 * once here is the one place this package refuses to copy pyk's duplication:
 * the two halves of an encoding must not be able to drift apart.
 */
export function mapSymbols(cell?: string): MapSymbols {
  if (cell === undefined || cell === "") {
    return { stop: STOP_MAP.symbol, cons: LBL_MAP, item: LBL_MAP_ITEM };
  }
  return { stop: `Lbl'Stop'${cell}Map`, cons: `Lbl'Unds'${cell}Map'Unds'`, item: `Lbl${cell}MapItem` };
}

/**
 * A `Map` term from `(key, value)` entries — `prelude.py:244-250`.
 *
 * Empty is the unit symbol; anything else is
 * `\left-assoc{}(cons{}(item{}(k₁, v₁), …))`.  `cell` selects a cell-collection
 * encoding — see {@link mapSymbols}.
 *
 * Duplicate keys are not detected, for the reason {@link setPattern} gives:
 * `_Map_` is partial on overlapping keys and the backend decides.
 */
export function mapPattern(
  entries: Iterable<readonly [Pattern, Pattern]>,
  options: { readonly cell?: string } = {},
): Pattern {
  const { stop, cons, item } = mapSymbols(options.cell);
  const args = [...entries].map(([key, value]) => app(item, [], [key, value]));
  if (args.length === 0) return stop === STOP_MAP.symbol ? STOP_MAP : app(stop);
  return leftAssoc(cons, [], args);
}

/** `Lbl'Stop'RangeMap{}()` — the empty `RangeMap` (`prelude.py:253`). */
export const STOP_RANGEMAP: App = deepFrozen(app("Lbl'Stop'RangeMap"));
/** `_RangeMap_`, the `RangeMap` union symbol — `prelude.py:254`. */
export const LBL_RANGEMAP = "Lbl'Unds'RangeMap'Unds'";
/** `_r|->_`, the `RangeMap` entry symbol — `prelude.py:255`. */
export const LBL_RANGEMAP_ITEM = "Lbl'Unds'r'Pipe'-'-GT-Unds'";
/** `RangeMap:Range`, the half-open `[start, end)` constructor — `prelude.py:256`. */
export const LBL_RANGEMAP_RANGE = "LblRangeMap'Coln'Range";

/**
 * A `RangeMap` term from `([start, end], value)` entries — `prelude.py:259-266`.
 *
 * One level deeper than {@link mapPattern}: the key of each entry is itself a
 * `LblRangeMap'Coln'Range{}(start, end)` application.  There is no cell-collection
 * variant, as there is none in pyk.
 */
export function rangemapPattern(entries: Iterable<readonly [readonly [Pattern, Pattern], Pattern]>): Pattern {
  const args = [...entries].map(([[start, end], value]) =>
    app(LBL_RANGEMAP_ITEM, [], [app(LBL_RANGEMAP_RANGE, [], [start, end]), value]),
  );
  if (args.length === 0) return STOP_RANGEMAP;
  return leftAssoc(LBL_RANGEMAP, [], args);
}

//////////////////////////
// Configurations       //
//////////////////////////

/** `LblinitGeneratedTopCell{}(P)` — `prelude.py:159-160`. */
export function initGeneratedTopCell(pattern: Pattern): App {
  return app(LBL_INIT_GENERATED_TOP_CELL, [], [pattern]);
}

/** `Lbl'-LT-'generatedTop'-GT-'{}(…)` — `prelude.py:163-164`.  Arity is the caller's. */
export function generatedTop(cells: Iterable<Pattern>): App {
  return app(LBL_GENERATED_TOP, [], [...cells]);
}

/** `Lbl'-LT-'generatedCounter'-GT-'{}(P)` — `prelude.py:167-168`. */
export function generatedCounter(pattern: Pattern): App {
  return app(LBL_GENERATED_COUNTER, [], [pattern]);
}

/** `Lbl'-LT-'k'-GT-'{}(P)` — the `<k>` cell, `prelude.py:171-172`. */
export function k(pattern: Pattern): App {
  return app(LBL_K, [], [pattern]);
}

/**
 * The term `krun` starts from: `LblinitGeneratedTopCell{}(Map{$X ↦ v, …})` —
 * `prelude.py:199-210`.
 *
 * Each key becomes `inj{SortKConfigVar{}, SortKItem{}}(\dv{SortKConfigVar{}}("$X"))`
 * and each value is used verbatim, so the caller owns getting the values to
 * `SortKItem` (`inject.ts`'s `addInjections` will do it against a definition).
 * The `$` on `$PGM` is part of the name and is not added here.
 *
 * Takes entries rather than a plain object because **key order is preserved and
 * observable** — it is the argument order of the `\left-assoc` — and a
 * `Record<string, Pattern>` cannot hold a key like `"__proto__"` safely.  A
 * `Map<string, Pattern>` passes straight in; so does an array of pairs, and so
 * does `Object.entries(config)` for a caller that has an object.
 */
export function topCellInitializer(config: Iterable<readonly [string, Pattern]>): App {
  const entries: (readonly [Pattern, Pattern])[] = [];
  for (const [name, value] of config) {
    entries.push([inj(SORT_K_CONFIG_VAR, SORT_K_ITEM, kConfigVar(name)), value]);
  }
  return initGeneratedTopCell(mapPattern(entries));
}
