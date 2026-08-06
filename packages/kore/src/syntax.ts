/**
 * The KORE abstract syntax tree, its textual writer, and its traversals.
 *
 * Transcribed from pyk `kore/syntax.py` (2273 L), which is the closest thing
 * upstream to what this package is; cross-checked against the normative grammar
 * `haskell-backend/docs/kore-syntax.md` and the KORE-JSON schema type
 * `kore-rpc-types/src/Kore/Syntax/Json/Types.hs`.
 *
 * # Tags are the KORE-JSON tags
 *
 * Every node discriminates on `tag`, and each `tag` value is *exactly* the
 * string KORE-JSON uses (`Types.hs:96-215`, which pyk's class names already
 * coincide with).  This is a design constraint, not a coincidence: the JSON
 * codec (a later module) must not need a translation table, and a reader
 * debugging a wire payload must see the same word in both places.  Three tags
 * — `Symbol`, `Module`, `Definition` — plus the five sentence tags have no
 * KORE-JSON counterpart at all, because KORE-JSON encodes *patterns only*;
 * they exist here so that the writer's dispatch is total over one union.
 *
 * TypeScript renames, tags untouched: the interface for tag `"String"` is
 * {@link KoreString} and the interface for the symbol head of a
 * `SymbolDecl`/`AliasDecl` is {@link KoreSymbol}, because `String` and `Symbol`
 * are global values in JavaScript and shadowing them inside a module that also
 * *uses* them is a defect waiting to happen.
 *
 * # Arity is preserved
 *
 * `And`/`Or`/`MultiOr` hold a pattern list of any length, including 0 and 1,
 * and nothing here normalizes `\and{S}()` to `\top{S}()` or `\and{S}(P)` to
 * `P`.  pyk behaves the same way; the Haskell *decoder* and scala-kore both
 * collapse these, so a term that round-trips through this package and one that
 * round-trips through them are not guaranteed to be the same term.  That is a
 * documented divergence, and it is the right one: collapsing is a semantic
 * judgement and this layer is syntax.
 *
 * Likewise `LeftAssoc`/`RightAssoc` are preserved as nodes (pyk
 * `syntax.py:565-714`) rather than eagerly expanded into an application
 * cascade the way scala-kore does — expansion is lossy and cannot be undone.
 *
 * # Nothing in this package recurses
 *
 * Real `definition.kore` terms are tens of thousands of nodes deep; pyk
 * rewrote `from_dict`/`dict`/`bottom_up`/`top_down` onto explicit stacks for
 * exactly this reason (`syntax.py:226-372`).  {@link koreText} and every
 * traversal below run on an explicit work stack.  A `RangeError` from stack
 * exhaustion is not a possible outcome of anything exported here.
 *
 * # Errors
 *
 * Invalid identifiers, wrong subpattern arity and wrong subpattern *type* all
 * throw `TypeError` (pyk raises `ValueError`; JavaScript has no equivalent, and
 * these are all "this value is not of the shape this position demands").
 * String-escape failures throw `SyntaxError` — see `escape.ts`.
 */

import { enquoteString } from "./escape.js";

//////////////////////
// Identifiers      //
//////////////////////

/**
 * `<id>` — pyk `Id` (`syntax.py:28-43`), grammar `kore-syntax.md` `<id>`.
 *
 * Anchored rather than `fullmatch`ed: in JavaScript `$` without the `m` flag
 * matches only at the very end of the string, so `^…$` *is* a full match — it
 * does not admit a trailing newline the way Python's `$` would.
 */
const ID_PATTERN = /^[a-zA-Z][0-9a-zA-Z'-]*$/u;

/** `<symbol-id>` — pyk `SymbolId` (`syntax.py:46-60`): an `<id>` with an optional leading `\`. */
const SYMBOL_ID_PATTERN = /^\\?[a-zA-Z][0-9a-zA-Z'-]*$/u;

/** `<set-variable-id>` — pyk `SetVarId` (`syntax.py:63-77`): an `<id>` with a mandatory leading `@`. */
const SET_VAR_ID_PATTERN = /^@[a-zA-Z][0-9a-zA-Z'-]*$/u;

/** Whether `s` is a valid KORE identifier — sort names, module names, variable names. */
export function isId(s: string): boolean {
  return ID_PATTERN.test(s);
}

/**
 * Whether `s` is a valid KORE symbol identifier.
 *
 * The optional leading backslash is what lets the ML connectives (`\top`,
 * `\and`, …) inhabit the same namespace as user symbols; `\sort` is a legal
 * symbol id even though `sort` is a keyword (pyk asserts exactly this,
 * `test_identifiers.py:31`).
 */
export function isSymbolId(s: string): boolean {
  return SYMBOL_ID_PATTERN.test(s);
}

/** Whether `s` is a valid KORE set-variable identifier (`@`-prefixed). */
export function isSetVarId(s: string): boolean {
  return SET_VAR_ID_PATTERN.test(s);
}

function checkId(s: string): string {
  if (!isId(s)) throw new TypeError(`Expected identifier, got: ${s}`);
  return s;
}

function checkSymbolId(s: string): string {
  if (!isSymbolId(s)) throw new TypeError(`Expected symbol identifier, got: ${s}`);
  return s;
}

function checkSetVarId(s: string): string {
  if (!isSetVarId(s)) throw new TypeError(`Expected set variable identifier, got: ${s}`);
  return s;
}

//////////////////////
// Sorts            //
//////////////////////

/** A sort variable — pyk `SortVar` (`syntax.py:142-162`). Writes as its bare name. */
export interface SortVar {
  readonly tag: "SortVar";
  readonly name: string;
}

/**
 * A sort application — pyk `SortApp` (`syntax.py:165-191`).
 *
 * The field is `sorts` here, following pyk's AST; KORE-JSON spells the same
 * thing `args` (`Types.hs`), and only the JSON codec should ever see that name.
 */
export interface SortApp {
  readonly tag: "SortApp";
  readonly name: string;
  readonly sorts: readonly Sort[];
}

export type Sort = SortVar | SortApp;

//////////////////////
// Patterns         //
//////////////////////

/** An element variable — pyk `EVar` (`syntax.py:395-427`). `name` is an `<id>`. */
export interface EVar {
  readonly tag: "EVar";
  readonly name: string;
  readonly sort: Sort;
}

/** A set variable — pyk `SVar` (`syntax.py:430-462`). `name` is a `<set-variable-id>`. */
export interface SVar {
  readonly tag: "SVar";
  readonly name: string;
  readonly sort: Sort;
}

/**
 * A string literal — pyk `String` (`syntax.py:465-499`), tag `"String"`.
 *
 * `value` is the *decoded* text.  Escaping happens once, in {@link koreText}.
 */
export interface KoreString {
  readonly tag: "String";
  readonly value: string;
}

/**
 * A symbol application — pyk `App` (`syntax.py:502-562`).
 *
 * Field-name trap: `sorts` are the symbol's sort parameters and `args` its
 * subpatterns.  KORE-JSON calls the symbol `name`, not `symbol`.
 */
export interface App {
  readonly tag: "App";
  readonly symbol: string;
  readonly sorts: readonly Sort[];
  readonly args: readonly Pattern[];
}

/**
 * `\left-assoc{}(sym{sorts}(args))` — pyk `LeftAssoc` (`syntax.py:601-656`).
 *
 * Sugar for a left-nested cascade of `sym`, kept as a node.  `args` must be
 * non-empty (`syntax.py:613-614`).  KORE-JSON spells `args` as `argss`.
 */
export interface LeftAssoc {
  readonly tag: "LeftAssoc";
  readonly symbol: string;
  readonly sorts: readonly Sort[];
  readonly args: readonly Pattern[];
}

/** `\right-assoc{}(sym{sorts}(args))` — pyk `RightAssoc` (`syntax.py:659-714`). `args` non-empty. */
export interface RightAssoc {
  readonly tag: "RightAssoc";
  readonly symbol: string;
  readonly sorts: readonly Sort[];
  readonly args: readonly Pattern[];
}

/** `\top{S}()` — pyk `Top` (`syntax.py:776-810`). */
export interface Top {
  readonly tag: "Top";
  readonly sort: Sort;
}

/** `\bottom{S}()` — pyk `Bottom` (`syntax.py:813-847`). */
export interface Bottom {
  readonly tag: "Bottom";
  readonly sort: Sort;
}

/** `\not{S}(P)` — pyk `Not` (`syntax.py:862-898`). */
export interface Not {
  readonly tag: "Not";
  readonly sort: Sort;
  readonly pattern: Pattern;
}

/**
 * `\and{S}(P…)` — pyk `And` (`syntax.py:1026-1068`), whose field is `ops`.
 *
 * Any arity, 0 included; see the header note on arity preservation.
 */
export interface And {
  readonly tag: "And";
  readonly sort: Sort;
  readonly patterns: readonly Pattern[];
}

/** `\or{S}(P…)` — pyk `Or` (`syntax.py:1071-1113`). Any arity. */
export interface Or {
  readonly tag: "Or";
  readonly sort: Sort;
  readonly patterns: readonly Pattern[];
}

/**
 * A left- or right-associated or-cascade — `Types.hs:193-200` `KJMultiOr`.
 *
 * **Absent from pyk**, which cannot read a KORE-JSON document containing it.
 * It exists in the Haskell wire type as syntactic sugar, alongside
 * `KJLeftAssoc`/`KJRightAssoc`, for a nest of `\or`.
 *
 * `assoc` is JSON-only and **is lost in the textual form**: KORE's text grammar
 * has no `\left-assoc`-style spelling for `\or` cascades, so this node writes
 * as the n-ary `\or{S}(P…)` — identical to what an {@link Or} of the same
 * `sort` and `patterns` writes.  Text is therefore not a faithful round trip
 * for `MultiOr`; JSON is.  Reading that text back yields an `Or`.
 */
export interface MultiOr {
  readonly tag: "MultiOr";
  readonly assoc: "Left" | "Right";
  readonly sort: Sort;
  readonly patterns: readonly Pattern[];
}

/** `\implies{S}(L, R)` — pyk `Implies` (`syntax.py:918-962`). */
export interface Implies {
  readonly tag: "Implies";
  readonly sort: Sort;
  readonly left: Pattern;
  readonly right: Pattern;
}

/** `\iff{S}(L, R)` — pyk `Iff` (`syntax.py:965-1009`). */
export interface Iff {
  readonly tag: "Iff";
  readonly sort: Sort;
  readonly left: Pattern;
  readonly right: Pattern;
}

/**
 * `\exists{S}(x : T, P)` — pyk `Exists` (`syntax.py:1144-1193`).
 *
 * The bound variable is a nested {@link EVar} node, not a name/sort pair, so
 * that `\exists`'s first textual argument is written by the ordinary variable
 * writer.  It is deliberately **not** a child for traversal purposes — see
 * {@link patterns}.
 */
export interface Exists {
  readonly tag: "Exists";
  readonly sort: Sort;
  readonly var: EVar;
  readonly pattern: Pattern;
}

/** `\forall{S}(x : T, P)` — pyk `Forall` (`syntax.py:1196-1245`). */
export interface Forall {
  readonly tag: "Forall";
  readonly sort: Sort;
  readonly var: EVar;
  readonly pattern: Pattern;
}

/**
 * `\mu{}(@X : T, P)` — pyk `Mu` (`syntax.py:1274-1311`).
 *
 * Takes **no** sort parameters (`syntax.py:1252-1254`): the fixpoint's sort is
 * the bound set variable's.
 */
export interface Mu {
  readonly tag: "Mu";
  readonly var: SVar;
  readonly pattern: Pattern;
}

/** `\nu{}(@X : T, P)` — pyk `Nu` (`syntax.py:1314-1351`). No sort parameters. */
export interface Nu {
  readonly tag: "Nu";
  readonly var: SVar;
  readonly pattern: Pattern;
}

/**
 * `\ceil{S, T}(P)` — pyk `Ceil` (`syntax.py:1379-1427`).
 *
 * Two sort parameters: `opSort` is the sort of the argument, `sort` the sort of
 * the resulting predicate.  pyk names the first `op_sort`; KORE-JSON names it
 * `argSort`.
 */
export interface Ceil {
  readonly tag: "Ceil";
  readonly opSort: Sort;
  readonly sort: Sort;
  readonly pattern: Pattern;
}

/** `\floor{S, T}(P)` — pyk `Floor` (`syntax.py:1430-1478`). */
export interface Floor {
  readonly tag: "Floor";
  readonly opSort: Sort;
  readonly sort: Sort;
  readonly pattern: Pattern;
}

/** `\equals{S, T}(L, R)` — pyk `Equals` (`syntax.py:1504-1556`). */
export interface Equals {
  readonly tag: "Equals";
  readonly opSort: Sort;
  readonly sort: Sort;
  readonly left: Pattern;
  readonly right: Pattern;
}

/** `\in{S, T}(L, R)` — pyk `In` (`syntax.py:1559-1611`). */
export interface In {
  readonly tag: "In";
  readonly opSort: Sort;
  readonly sort: Sort;
  readonly left: Pattern;
  readonly right: Pattern;
}

/** `\next{S}(P)` — pyk `Next` (`syntax.py:1620-1667`). KORE-JSON names the child `dest`. */
export interface Next {
  readonly tag: "Next";
  readonly sort: Sort;
  readonly pattern: Pattern;
}

/** `\rewrites{S}(L, R)` — pyk `Rewrites` (`syntax.py:1670-1731`). KORE-JSON: `source`/`dest`. */
export interface Rewrites {
  readonly tag: "Rewrites";
  readonly sort: Sort;
  readonly left: Pattern;
  readonly right: Pattern;
}

/**
 * `\dv{S}("…")` — pyk `DV` (`syntax.py:1734-1790`).
 *
 * `value` is a nested {@link KoreString} node, following pyk; KORE-JSON flattens
 * it to a bare string field.  Like `\exists`'s variable it is written but not
 * traversed.
 */
export interface DV {
  readonly tag: "DV";
  readonly sort: Sort;
  readonly value: KoreString;
}

/**
 * The 18 matching-logic patterns — every node with a `\`-prefixed head that is
 * not sugar.  Excludes {@link MultiOr}, which has no pyk class and no ML symbol
 * of its own.
 */
export type MLPattern =
  | Top
  | Bottom
  | Not
  | And
  | Or
  | Implies
  | Iff
  | Exists
  | Forall
  | Mu
  | Nu
  | Ceil
  | Floor
  | Equals
  | In
  | Next
  | Rewrites
  | DV;

/** Every pattern node. 25 arms: the 24 pyk classes plus {@link MultiOr}. */
export type Pattern = EVar | SVar | KoreString | App | LeftAssoc | RightAssoc | MultiOr | MLPattern;

//////////////////////
// Sentences        //
//////////////////////

/** `import M [attrs]` — pyk `Import` (`syntax.py:1832-1858`). */
export interface Import {
  readonly tag: "Import";
  readonly moduleName: string;
  readonly attrs: readonly App[];
}

/**
 * `sort N{V…} [attrs]`, or `hooked-sort …` — pyk `SortDecl`
 * (`syntax.py:1861-1910`).
 */
export interface SortDecl {
  readonly tag: "SortDecl";
  readonly name: string;
  readonly vars: readonly SortVar[];
  readonly attrs: readonly App[];
  readonly hooked: boolean;
}

/**
 * The head of a symbol or alias declaration: `name{vars}` — pyk `Symbol`
 * (`syntax.py:1913-1935`).
 *
 * Not a sentence and not a pattern; it carries a `tag` only so that
 * {@link koreText} dispatches over one union.  `"Symbol"` is not a KORE-JSON
 * tag — KORE-JSON has no encoding for declarations at all.
 */
export interface KoreSymbol {
  readonly tag: "Symbol";
  readonly name: string;
  readonly vars: readonly SortVar[];
}

/**
 * `symbol s{V…}(P…) : S [attrs]`, or `hooked-symbol …` — pyk `SymbolDecl`
 * (`syntax.py:1938-1991`).
 */
export interface SymbolDecl {
  readonly tag: "SymbolDecl";
  readonly symbol: KoreSymbol;
  readonly paramSorts: readonly Sort[];
  readonly sort: Sort;
  readonly attrs: readonly App[];
  readonly hooked: boolean;
}

/**
 * `alias a{V…}(P…) : S where L := R [attrs]` — pyk `AliasDecl`
 * (`syntax.py:2015-2075`).
 *
 * The head field is named `alias`, matching pyk; its type is {@link KoreSymbol}
 * all the same.  `left` is constrained to an {@link App} by the grammar.
 */
export interface AliasDecl {
  readonly tag: "AliasDecl";
  readonly alias: KoreSymbol;
  readonly paramSorts: readonly Sort[];
  readonly sort: Sort;
  readonly left: App;
  readonly right: Pattern;
  readonly attrs: readonly App[];
}

/** `axiom{V…} P [attrs]` — pyk `Axiom` (`syntax.py:2095-2122`, writer at `2084-2092`). */
export interface Axiom {
  readonly tag: "Axiom";
  readonly vars: readonly SortVar[];
  readonly pattern: Pattern;
  readonly attrs: readonly App[];
}

/** `claim{V…} P [attrs]` — pyk `Claim` (`syntax.py:2125-2152`). Same shape as {@link Axiom}. */
export interface Claim {
  readonly tag: "Claim";
  readonly vars: readonly SortVar[];
  readonly pattern: Pattern;
  readonly attrs: readonly App[];
}

export type Sentence = Import | SortDecl | SymbolDecl | AliasDecl | Axiom | Claim;

/** `module N …sentences… endmodule [attrs]` — pyk `Module` (`syntax.py:2155-2204`). */
export interface Module {
  readonly tag: "Module";
  readonly name: string;
  readonly sentences: readonly Sentence[];
  readonly attrs: readonly App[];
}

/** `[attrs]` followed by the modules — pyk `Definition` (`syntax.py:2207-2263`). */
export interface Definition {
  readonly tag: "Definition";
  readonly modules: readonly Module[];
  readonly attrs: readonly App[];
}

/**
 * Everything {@link koreText} can write — pyk's `Kore` base class
 * (`syntax.py:83-91`).
 *
 * Attributes are plain `App`s: the grammar says an attribute *is* an
 * application pattern, so there is no separate attribute type anywhere in this
 * package.
 */
export type Kore = Sort | Pattern | KoreSymbol | Sentence | Module | Definition;

//////////////////////
// ML symbols       //
//////////////////////

/** The `tag` of each of the 18 {@link MLPattern} arms. */
export type MLPatternTag = MLPattern["tag"];

/**
 * `\`-prefixed head to node tag — pyk `ML_SYMBOLS` (`syntax.py:1793-1812`).
 *
 * Exactly 18 entries.  `\left-assoc` and `\right-assoc` are absent on purpose:
 * they are sugar for an application, not matching-logic connectives, and pyk
 * keeps them out of this table too.
 */
export const ML_SYMBOLS = {
  "\\top": "Top",
  "\\bottom": "Bottom",
  "\\not": "Not",
  "\\and": "And",
  "\\or": "Or",
  "\\implies": "Implies",
  "\\iff": "Iff",
  "\\exists": "Exists",
  "\\forall": "Forall",
  "\\mu": "Mu",
  "\\nu": "Nu",
  "\\ceil": "Ceil",
  "\\floor": "Floor",
  "\\equals": "Equals",
  "\\in": "In",
  "\\next": "Next",
  "\\rewrites": "Rewrites",
  "\\dv": "DV",
} as const satisfies Readonly<Record<string, MLPatternTag>>;

/** The head of an ML pattern, i.e. a key of {@link ML_SYMBOLS}. */
export type MLSymbol = keyof typeof ML_SYMBOLS;

/** Node tag to `\`-prefixed head — the inverse of {@link ML_SYMBOLS}. */
export const ML_SYMBOL_OF = {
  Top: "\\top",
  Bottom: "\\bottom",
  Not: "\\not",
  And: "\\and",
  Or: "\\or",
  Implies: "\\implies",
  Iff: "\\iff",
  Exists: "\\exists",
  Forall: "\\forall",
  Mu: "\\mu",
  Nu: "\\nu",
  Ceil: "\\ceil",
  Floor: "\\floor",
  Equals: "\\equals",
  In: "\\in",
  Next: "\\next",
  Rewrites: "\\rewrites",
  DV: "\\dv",
} as const satisfies Readonly<Record<MLPatternTag, MLSymbol>>;

/** The head `p` writes with — pyk's `symbol()` classmethod on each ML class. */
export function mlSymbol(p: MLPattern): MLSymbol {
  return ML_SYMBOL_OF[p.tag];
}

/**
 * The sort parameters `p` writes between `{}` — pyk's `sorts` property
 * (`MLConn` 760-763, `MLQuant` 1121-1123, `MLFixpoint` 1252-1254, `MLPred`
 * 1361-1363 / 1485-1487, `MLRewrite` 1614-1617, `DV` 1776-1778).
 *
 * Three shapes: none (`\mu`, `\nu`), one (most), two (`\ceil`, `\floor`,
 * `\equals`, `\in` — argument sort first, then result sort).
 */
export function mlSorts(p: MLPattern): readonly Sort[] {
  switch (p.tag) {
    case "Mu":
    case "Nu":
      return [];
    case "Ceil":
    case "Floor":
    case "Equals":
    case "In":
      return [p.opSort, p.sort];
    default:
      return [p.sort];
  }
}

/**
 * The subpatterns `p` writes between `()` — pyk's `ctor_patterns`
 * (`syntax.py:743-749`).
 *
 * Differs from {@link patterns} for exactly the three cases pyk names: a
 * quantifier and a fixpoint write their bound variable first, and a `\dv`
 * writes its string literal — none of which is a child for traversal.
 */
export function ctorPatterns(p: MLPattern): readonly Pattern[] {
  switch (p.tag) {
    case "Exists":
    case "Forall":
    case "Mu":
    case "Nu":
      return [p.var, p.pattern];
    case "DV":
      return [p.value];
    default:
      return patterns(p);
  }
}

//////////////////////
// Arity helpers    //
//////////////////////

function takeNone(items: readonly unknown[], what: string, where: string): void {
  if (items.length > 0) throw new TypeError(`${where} takes no ${what}, got: ${items.length}`);
}

function takeOne<T>(items: readonly T[], what: string, where: string): T {
  const [a] = items;
  if (items.length !== 1 || a === undefined) {
    throw new TypeError(`${where} takes exactly one ${what}, got: ${items.length}`);
  }
  return a;
}

function takeTwo<T>(items: readonly T[], what: string, where: string): readonly [T, T] {
  const [a, b] = items;
  if (items.length !== 2 || a === undefined || b === undefined) {
    throw new TypeError(`${where} takes exactly two ${what}, got: ${items.length}`);
  }
  return [a, b];
}

/**
 * pyk `check_type` (`syntax.py:1183`, `1235`, `1302`, `1342`, `1765`) — the
 * five call sites, over three constrained classes, where an ML head demands a
 * particular *kind* of subpattern rather than merely one in that position.
 */
function checkEVar(p: Pattern, where: string): EVar {
  if (p.tag !== "EVar") throw new TypeError(`${where} expects an EVar, got: ${p.tag}`);
  return p;
}

function checkSVar(p: Pattern, where: string): SVar {
  if (p.tag !== "SVar") throw new TypeError(`${where} expects an SVar, got: ${p.tag}`);
  return p;
}

function checkKoreString(p: Pattern, where: string): KoreString {
  if (p.tag !== "String") throw new TypeError(`${where} expects a String, got: ${p.tag}`);
  return p;
}

//////////////////////
// Constructors     //
//////////////////////

/**
 * Every constructor below validates what pyk's `__init__` validates — and only
 * that.  Identifiers are checked against the grammar; `\left-assoc`/
 * `\right-assoc` reject an empty argument list; nothing else is checked,
 * because nothing else is checkable without a definition to check against (sort
 * arity, symbol arity and well-sortedness are §Validity rules, not syntax).
 *
 * The node interfaces are exported, so an object literal is an equally valid
 * way to build a term; these exist for the validation and for the defaults.
 */

export function sortVar(name: string): SortVar {
  return { tag: "SortVar", name: checkId(name) };
}

export function sortApp(name: string, sorts: readonly Sort[] = []): SortApp {
  return { tag: "SortApp", name: checkId(name), sorts };
}

export function evar(name: string, sort: Sort): EVar {
  return { tag: "EVar", name: checkId(name), sort };
}

export function svar(name: string, sort: Sort): SVar {
  return { tag: "SVar", name: checkSetVarId(name), sort };
}

export function koreString(value: string): KoreString {
  return { tag: "String", value };
}

export function app(symbol: string, sorts: readonly Sort[] = [], args: readonly Pattern[] = []): App {
  return { tag: "App", symbol: checkSymbolId(symbol), sorts, args };
}

export function leftAssoc(symbol: string, sorts: readonly Sort[] = [], args: readonly Pattern[] = []): LeftAssoc {
  if (args.length === 0) throw new TypeError("Expected non-empty iterable for 'args'");
  return { tag: "LeftAssoc", symbol: checkSymbolId(symbol), sorts, args };
}

export function rightAssoc(symbol: string, sorts: readonly Sort[] = [], args: readonly Pattern[] = []): RightAssoc {
  if (args.length === 0) throw new TypeError("Expected non-empty iterable for 'args'");
  return { tag: "RightAssoc", symbol: checkSymbolId(symbol), sorts, args };
}

export function top(sort: Sort): Top {
  return { tag: "Top", sort };
}

export function bottom(sort: Sort): Bottom {
  return { tag: "Bottom", sort };
}

export function not(sort: Sort, pattern: Pattern): Not {
  return { tag: "Not", sort, pattern };
}

export function and(sort: Sort, ps: readonly Pattern[] = []): And {
  return { tag: "And", sort, patterns: ps };
}

export function or(sort: Sort, ps: readonly Pattern[] = []): Or {
  return { tag: "Or", sort, patterns: ps };
}

/** See {@link MultiOr}: `assoc` survives JSON but not text. */
export function multiOr(assoc: "Left" | "Right", sort: Sort, ps: readonly Pattern[]): MultiOr {
  if (ps.length === 0) throw new TypeError("Expected non-empty iterable for 'patterns'");
  return { tag: "MultiOr", assoc, sort, patterns: ps };
}

export function implies(sort: Sort, left: Pattern, right: Pattern): Implies {
  return { tag: "Implies", sort, left, right };
}

export function iff(sort: Sort, left: Pattern, right: Pattern): Iff {
  return { tag: "Iff", sort, left, right };
}

export function exists(sort: Sort, boundVar: EVar, pattern: Pattern): Exists {
  return { tag: "Exists", sort, var: boundVar, pattern };
}

export function forall(sort: Sort, boundVar: EVar, pattern: Pattern): Forall {
  return { tag: "Forall", sort, var: boundVar, pattern };
}

export function mu(boundVar: SVar, pattern: Pattern): Mu {
  return { tag: "Mu", var: boundVar, pattern };
}

export function nu(boundVar: SVar, pattern: Pattern): Nu {
  return { tag: "Nu", var: boundVar, pattern };
}

export function ceil(opSort: Sort, sort: Sort, pattern: Pattern): Ceil {
  return { tag: "Ceil", opSort, sort, pattern };
}

export function floor(opSort: Sort, sort: Sort, pattern: Pattern): Floor {
  return { tag: "Floor", opSort, sort, pattern };
}

export function equals(opSort: Sort, sort: Sort, left: Pattern, right: Pattern): Equals {
  return { tag: "Equals", opSort, sort, left, right };
}

/** `\in`. Named `inPred` because `in` is a reserved word; the tag is still `"In"`. */
export function inPred(opSort: Sort, sort: Sort, left: Pattern, right: Pattern): In {
  return { tag: "In", opSort, sort, left, right };
}

export function next(sort: Sort, pattern: Pattern): Next {
  return { tag: "Next", sort, pattern };
}

export function rewrites(sort: Sort, left: Pattern, right: Pattern): Rewrites {
  return { tag: "Rewrites", sort, left, right };
}

export function dv(sort: Sort, value: KoreString): DV {
  return { tag: "DV", sort, value };
}

/** Named `koreImport` because `import` is a reserved word; the tag is `"Import"`. */
export function koreImport(moduleName: string, attrs: readonly App[] = []): Import {
  return { tag: "Import", moduleName: checkId(moduleName), attrs };
}

export function sortDecl(
  name: string,
  vars: readonly SortVar[] = [],
  attrs: readonly App[] = [],
  hooked = false,
): SortDecl {
  return { tag: "SortDecl", name: checkId(name), vars, attrs, hooked };
}

/** The `name{vars}` head of a symbol or alias declaration. `name` may lead with `\`. */
export function koreSymbol(name: string, vars: readonly SortVar[] = []): KoreSymbol {
  return { tag: "Symbol", name: checkSymbolId(name), vars };
}

export function symbolDecl(
  symbol: KoreSymbol,
  paramSorts: readonly Sort[],
  sort: Sort,
  attrs: readonly App[] = [],
  hooked = false,
): SymbolDecl {
  return { tag: "SymbolDecl", symbol, paramSorts, sort, attrs, hooked };
}

export function aliasDecl(
  alias: KoreSymbol,
  paramSorts: readonly Sort[],
  sort: Sort,
  left: App,
  right: Pattern,
  attrs: readonly App[] = [],
): AliasDecl {
  return { tag: "AliasDecl", alias, paramSorts, sort, left, right, attrs };
}

export function axiom(vars: readonly SortVar[], pattern: Pattern, attrs: readonly App[] = []): Axiom {
  return { tag: "Axiom", vars, pattern, attrs };
}

export function claim(vars: readonly SortVar[], pattern: Pattern, attrs: readonly App[] = []): Claim {
  return { tag: "Claim", vars, pattern, attrs };
}

/** Named `koreModule` to keep `module` — a contextual keyword in TypeScript — free. */
export function koreModule(name: string, sentences: readonly Sentence[] = [], attrs: readonly App[] = []): Module {
  return { tag: "Module", name: checkId(name), sentences, attrs };
}

export function definition(modules: readonly Module[] = [], attrs: readonly App[] = []): Definition {
  return { tag: "Definition", modules, attrs };
}

/**
 * Build an ML pattern from its textual head — pyk `MLPattern.of`
 * (`syntax.py:722-732`) dispatching to each class's own `of`.
 *
 * This is what a parser calls once it has read `\head{sorts}(patterns)` and
 * nothing else: it is the single place the per-connective sort/argument arities
 * live.  It enforces every rule those 18 `of` methods enforce — arity of
 * `sorts`, arity of `patterns`, and the three *type* constraints (`\exists` and
 * `\forall` bind an `EVar`, `\mu` and `\nu` bind an `SVar`, `\dv` carries a
 * `String`).
 *
 * `\and` and `\or` accept any number of patterns; every other head is fixed.
 */
export function mlPattern(symbol: string, sorts: readonly Sort[] = [], ps: readonly Pattern[] = []): MLPattern {
  // Widened to a string-keyed lookup: the argument is untrusted text (a parser
  // hands over whatever followed the backslash), so the miss must be a value,
  // not a type error.
  const table: Readonly<Record<string, MLPatternTag | undefined>> = ML_SYMBOLS;
  const tag = table[symbol];
  if (tag === undefined) throw new TypeError(`Invalid MLPattern symbol: ${symbol}`);

  switch (tag) {
    case "Top":
      takeNone(ps, "patterns", symbol);
      return top(takeOne(sorts, "sorts", symbol));
    case "Bottom":
      takeNone(ps, "patterns", symbol);
      return bottom(takeOne(sorts, "sorts", symbol));
    case "Not":
      return not(takeOne(sorts, "sorts", symbol), takeOne(ps, "patterns", symbol));
    case "And":
      return and(takeOne(sorts, "sorts", symbol), ps);
    case "Or":
      return or(takeOne(sorts, "sorts", symbol), ps);
    case "Implies": {
      const [l, r] = takeTwo(ps, "patterns", symbol);
      return implies(takeOne(sorts, "sorts", symbol), l, r);
    }
    case "Iff": {
      const [l, r] = takeTwo(ps, "patterns", symbol);
      return iff(takeOne(sorts, "sorts", symbol), l, r);
    }
    case "Exists": {
      const [v, p] = takeTwo(ps, "patterns", symbol);
      return exists(takeOne(sorts, "sorts", symbol), checkEVar(v, symbol), p);
    }
    case "Forall": {
      const [v, p] = takeTwo(ps, "patterns", symbol);
      return forall(takeOne(sorts, "sorts", symbol), checkEVar(v, symbol), p);
    }
    case "Mu": {
      takeNone(sorts, "sorts", symbol);
      const [v, p] = takeTwo(ps, "patterns", symbol);
      return mu(checkSVar(v, symbol), p);
    }
    case "Nu": {
      takeNone(sorts, "sorts", symbol);
      const [v, p] = takeTwo(ps, "patterns", symbol);
      return nu(checkSVar(v, symbol), p);
    }
    case "Ceil": {
      const [opSort, sort] = takeTwo(sorts, "sorts", symbol);
      return ceil(opSort, sort, takeOne(ps, "patterns", symbol));
    }
    case "Floor": {
      const [opSort, sort] = takeTwo(sorts, "sorts", symbol);
      return floor(opSort, sort, takeOne(ps, "patterns", symbol));
    }
    case "Equals": {
      const [opSort, sort] = takeTwo(sorts, "sorts", symbol);
      const [l, r] = takeTwo(ps, "patterns", symbol);
      return equals(opSort, sort, l, r);
    }
    case "In": {
      const [opSort, sort] = takeTwo(sorts, "sorts", symbol);
      const [l, r] = takeTwo(ps, "patterns", symbol);
      return inPred(opSort, sort, l, r);
    }
    case "Next":
      return next(takeOne(sorts, "sorts", symbol), takeOne(ps, "patterns", symbol));
    case "Rewrites": {
      const [l, r] = takeTwo(ps, "patterns", symbol);
      return rewrites(takeOne(sorts, "sorts", symbol), l, r);
    }
    case "DV": {
      const value = takeOne(ps, "patterns", symbol);
      return dv(takeOne(sorts, "sorts", symbol), checkKoreString(value, symbol));
    }
    default:
      return exhausted(tag);
  }
}

/** Compile-time exhaustiveness. Unreachable; throws so no caller sees a bogus node. */
function exhausted(value: never): never {
  throw new TypeError(`Unhandled tag: ${JSON.stringify(value)}`);
}

//////////////////////
// Child access     //
//////////////////////

/**
 * The direct subpatterns of `p`, in order — pyk's `patterns` property.
 *
 * This is the *traversal* notion of "child", and it is narrower than the
 * *textual* notion ({@link ctorPatterns}) in exactly three places, all of them
 * pyk's:
 *
 * - `\exists`/`\forall` do **not** yield their bound `EVar`
 *   (`syntax.py:1125-1127`),
 * - `\mu`/`\nu` do not yield their bound `SVar` (`syntax.py:1256-1258`),
 * - `\dv` yields nothing at all (`syntax.py:1780-1782`).
 *
 * A binder's variable is a binding occurrence, not a subterm, and rewriting it
 * with a `bottomUp` that does not know it is a binder would capture; `\dv`'s
 * literal is a domain value, not a pattern position.  A traversal that visited
 * them would be a different traversal than pyk's, and every pyk-derived
 * expectation would be off.
 */
export function patterns(p: Pattern): readonly Pattern[] {
  switch (p.tag) {
    case "EVar":
    case "SVar":
    case "String":
    case "Top":
    case "Bottom":
    case "DV":
      return [];
    case "App":
    case "LeftAssoc":
    case "RightAssoc":
      return p.args;
    case "And":
    case "Or":
    case "MultiOr":
      return p.patterns;
    case "Not":
    case "Exists":
    case "Forall":
    case "Mu":
    case "Nu":
    case "Ceil":
    case "Floor":
    case "Next":
      return [p.pattern];
    case "Implies":
    case "Iff":
    case "Equals":
    case "In":
    case "Rewrites":
      return [p.left, p.right];
    default:
      return exhausted(p);
  }
}

/**
 * `p` with its direct subpatterns replaced — pyk's `let_patterns`.
 *
 * The inverse of {@link patterns}: `withPatterns(p, patterns(p))` is `p` in
 * value.  Arity is enforced, mirroring the tuple unpacking pyk relies on;
 * a `LeftAssoc`/`RightAssoc` still may not go empty.  Everything not a
 * subpattern — sorts, bound variables, `\dv` values, the `MultiOr` assoc — is
 * carried through untouched.
 */
export function withPatterns(p: Pattern, ps: readonly Pattern[]): Pattern {
  switch (p.tag) {
    case "EVar":
    case "SVar":
    case "String":
    case "Top":
    case "Bottom":
    case "DV":
      takeNone(ps, "patterns", p.tag);
      return p;
    case "App":
      return { ...p, args: ps };
    case "LeftAssoc":
    case "RightAssoc":
      if (ps.length === 0) throw new TypeError("Expected non-empty iterable for 'args'");
      return { ...p, args: ps };
    case "And":
    case "Or":
      return { ...p, patterns: ps };
    case "MultiOr":
      if (ps.length === 0) throw new TypeError("Expected non-empty iterable for 'patterns'");
      return { ...p, patterns: ps };
    case "Not":
    case "Exists":
    case "Forall":
    case "Mu":
    case "Nu":
    case "Ceil":
    case "Floor":
    case "Next":
      return { ...p, pattern: takeOne(ps, "patterns", p.tag) };
    case "Implies":
    case "Iff":
    case "Equals":
    case "In":
    case "Rewrites": {
      const [left, right] = takeTwo(ps, "patterns", p.tag);
      return { ...p, left, right };
    }
    default:
      return exhausted(p);
  }
}

//////////////////////
// Traversals       //
//////////////////////

/** One node whose rebuilt children are accumulating in `done`. */
interface Frame {
  readonly node: Pattern;
  readonly kids: readonly Pattern[];
  readonly done: Pattern[];
}

function frame(node: Pattern): Frame {
  return { node, kids: patterns(node), done: [] };
}

/**
 * Rewrite bottom-up — pyk `bottom_up` (`syntax.py:312-327`).
 *
 * `f` sees each node *after* its children have been rewritten and spliced back
 * in, so a rewrite of a child is visible to the rewrite of its parent.  Order
 * is post-order, children left to right.
 *
 * Explicit stack: depth is bounded by heap, not by the call stack.
 */
export function bottomUp(p: Pattern, f: (p: Pattern) => Pattern): Pattern {
  const stack: Frame[] = [frame(p)];
  for (;;) {
    const cur = stack.at(-1);
    if (cur === undefined) throw new TypeError("Unreachable: empty traversal stack");
    const nextKid = cur.kids[cur.done.length];
    if (nextKid !== undefined) {
      stack.push(frame(nextKid));
      continue;
    }
    stack.pop();
    const rebuilt = f(withPatterns(cur.node, cur.done));
    const parent = stack.at(-1);
    if (parent === undefined) return rebuilt;
    parent.done.push(rebuilt);
  }
}

/**
 * Rewrite top-down — pyk `top_down` (`syntax.py:350-365`).
 *
 * `f` is applied to a node *before* its children are visited, and it is the
 * children of `f`'s **result** that get visited — so an `f` that replaces a
 * node changes what is traversed underneath it.  The rebuild step does not
 * re-apply `f`.
 */
export function topDown(p: Pattern, f: (p: Pattern) => Pattern): Pattern {
  const stack: Frame[] = [frame(f(p))];
  for (;;) {
    const cur = stack.at(-1);
    if (cur === undefined) throw new TypeError("Unreachable: empty traversal stack");
    const nextKid = cur.kids[cur.done.length];
    if (nextKid !== undefined) {
      stack.push(frame(f(nextKid)));
      continue;
    }
    stack.pop();
    const rebuilt = withPatterns(cur.node, cur.done);
    const parent = stack.at(-1);
    if (parent === undefined) return rebuilt;
    parent.done.push(rebuilt);
  }
}

/**
 * Visit every subpattern — pyk `collect` (`syntax.py:367-372`).
 *
 * Depth-first, node before children, children left to right.  pyk gets that
 * order by pushing `reversed(pattern.patterns)` onto a pop-from-the-end stack;
 * the reverse loop below is the same thing.  `f` cannot rewrite — this is the
 * read-only traversal.
 */
export function collect(p: Pattern, f: (p: Pattern) => void): void {
  const stack: Pattern[] = [p];
  for (;;) {
    const node = stack.pop();
    if (node === undefined) return;
    const kids = patterns(node);
    for (let i = kids.length - 1; i >= 0; i--) {
      const kid = kids[i];
      if (kid !== undefined) stack.push(kid);
    }
    f(node);
  }
}

//////////////////////
// Text writer      //
//////////////////////

/**
 * A stack item: either a node still to write, or a literal already decided on.
 *
 * The two are told apart by `typeof`, which is sound because no `Kore` node is
 * a string.
 */
type WriteItem = string | Kore;

/**
 * Queue `nodes` separated by `", "` — pyk `_write_sep_by_comma`
 * (`syntax.py:94-102`).
 *
 * Pushes in reverse, because the stack is popped from the end.  The separator
 * is `", "` everywhere in the writer, with no exceptions and no trailing
 * separator.
 */
function pushSepByComma(stack: WriteItem[], nodes: readonly Kore[]): void {
  for (let i = nodes.length - 1; i >= 0; i--) {
    const node = nodes[i];
    if (node === undefined) continue;
    stack.push(node);
    if (i > 0) stack.push(", ");
  }
}

/**
 * Queue `head{sorts}(args)` — the shape shared by `App` (`syntax.py:556-562`)
 * and every ML pattern (`syntax.py:751-757`).
 */
function pushApplication(
  out: string[],
  stack: WriteItem[],
  head: string,
  sorts: readonly Sort[],
  args: readonly Pattern[],
): void {
  out.push(head, "{");
  stack.push(")");
  pushSepByComma(stack, args);
  stack.push("}(");
  pushSepByComma(stack, sorts);
}

/** Queue `attrs` inside the trailing ` [ … ]` that every sentence ends with. */
function pushAttrs(stack: WriteItem[], attrs: readonly App[]): void {
  stack.push("]");
  pushSepByComma(stack, attrs);
}

/**
 * Render any KORE node as text — pyk's `Kore.text` / `write`
 * (`syntax.py:83-91` and every `write` method below it).
 *
 * Byte-for-byte what pyk writes, including the details that look incidental and
 * are not: the separator is always `", "`; a sentence's attribute list is
 * always emitted, empty or not, as ` []`; `\left-assoc{}(…)` writes an *empty*
 * sort list on the sugar head and the real sorts on the wrapped application;
 * module sentences are indented by exactly four spaces after a newline; and a
 * definition separates modules by a blank line.  KORE writers disagree about
 * whitespace — `prelude.kore` uses a different indent and puts a space in
 * `axiom {R}` — so readers must be whitespace-insensitive, but a *writer* has
 * to pick one spelling, and this one is pyk's.
 *
 * Iterative, per this package's no-recursion rule: an axiom whose pattern is
 * 100_000 nodes deep renders without touching the call stack.
 */
export function koreText(node: Kore): string {
  // Reading the arms below: `out.push(…)` emits immediately, `stack.push(…)`
  // defers — and the stack is popped from the end, so every deferred list is
  // written in **reverse** emission order.  `stack.push(" [", sort, ") : ")`
  // means the output will read `") : " sort " ["`.
  const out: string[] = [];
  const stack: WriteItem[] = [node];

  for (;;) {
    const item = stack.pop();
    if (item === undefined) return out.join("");
    if (typeof item === "string") {
      out.push(item);
      continue;
    }

    switch (item.tag) {
      // --- sorts -------------------------------------------------------
      case "SortVar":
        // syntax.py:161-162
        out.push(item.name);
        break;
      case "SortApp":
        // syntax.py:187-191
        out.push(item.name, "{");
        stack.push("}");
        pushSepByComma(stack, item.sorts);
        break;

      // --- patterns ----------------------------------------------------
      case "EVar":
      case "SVar":
        // syntax.py:389-392 `VarPattern.write`
        out.push(item.name, " : ");
        stack.push(item.sort);
        break;
      case "String":
        // syntax.py:495-499 — the quotes belong to the writer, the escaping to
        // `enquoteString`, and `value` is stored decoded.
        out.push('"', enquoteString(item.value), '"');
        break;
      case "App":
        pushApplication(out, stack, item.symbol, item.sorts, item.args);
        break;
      case "LeftAssoc":
      case "RightAssoc": {
        // syntax.py:594-598 `Assoc.write` — the sugar head takes no sorts of
        // its own; they go on the wrapped application (`syntax.py:582-584`).
        out.push(item.tag === "LeftAssoc" ? "\\left-assoc{}(" : "\\right-assoc{}(");
        stack.push(")", { tag: "App", symbol: item.symbol, sorts: item.sorts, args: item.args });
        break;
      }
      case "MultiOr":
        // No textual spelling of its own: written as the n-ary `\or`, which
        // loses `assoc`. See the note on the `MultiOr` interface.
        pushApplication(out, stack, "\\or", [item.sort], item.patterns);
        break;
      case "Top":
      case "Bottom":
      case "Not":
      case "And":
      case "Or":
      case "Implies":
      case "Iff":
      case "Exists":
      case "Forall":
      case "Mu":
      case "Nu":
      case "Ceil":
      case "Floor":
      case "Equals":
      case "In":
      case "Next":
      case "Rewrites":
      case "DV":
        // syntax.py:751-757 `MLPattern.write`, uniform over all 18.
        pushApplication(out, stack, mlSymbol(item), mlSorts(item), ctorPatterns(item));
        break;

      // --- declarations ------------------------------------------------
      case "Symbol":
        // syntax.py:1931-1935
        out.push(item.name, "{");
        stack.push("}");
        pushSepByComma(stack, item.vars);
        break;
      case "Import":
        // syntax.py:1853-1858
        out.push("import ", item.moduleName, " [");
        pushAttrs(stack, item.attrs);
        break;
      case "SortDecl":
        // syntax.py:1902-1910
        out.push(item.hooked ? "hooked-sort " : "sort ", item.name, "{");
        pushAttrs(stack, item.attrs);
        stack.push("} [");
        pushSepByComma(stack, item.vars);
        break;
      case "SymbolDecl":
        // syntax.py:1981-1991
        out.push(item.hooked ? "hooked-symbol " : "symbol ");
        pushAttrs(stack, item.attrs);
        stack.push(" [", item.sort, ") : ");
        pushSepByComma(stack, item.paramSorts);
        stack.push("(", item.symbol);
        break;
      case "AliasDecl":
        // syntax.py:2062-2075
        out.push("alias ");
        pushAttrs(stack, item.attrs);
        stack.push(" [", item.right, " := ", item.left, " where ", item.sort, ") : ");
        pushSepByComma(stack, item.paramSorts);
        stack.push("(", item.alias);
        break;
      case "Axiom":
      case "Claim":
        // syntax.py:2084-2092 `AxiomLike.write`; the only difference between
        // the two is the keyword (`syntax.py:2098`, `2128`).
        out.push(item.tag === "Axiom" ? "axiom" : "claim", "{");
        pushAttrs(stack, item.attrs);
        stack.push(" [", item.pattern, "} ");
        pushSepByComma(stack, item.vars);
        break;

      // --- containers --------------------------------------------------
      case "Module":
        // syntax.py:2188-2196
        out.push("module ", item.name);
        pushAttrs(stack, item.attrs);
        stack.push("\nendmodule [");
        for (let i = item.sentences.length - 1; i >= 0; i--) {
          const sentence = item.sentences[i];
          if (sentence === undefined) continue;
          stack.push(sentence, "\n    ");
        }
        break;
      case "Definition":
        // syntax.py:2228-2234 — attributes first, then the modules, each
        // preceded by a blank line.
        out.push("[");
        for (let i = item.modules.length - 1; i >= 0; i--) {
          const mod = item.modules[i];
          if (mod === undefined) continue;
          stack.push(mod, "\n\n");
        }
        stack.push("]");
        pushSepByComma(stack, item.attrs);
        break;

      default:
        return exhausted(item);
    }
  }
}
