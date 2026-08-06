/**
 * The **pure tier** of KAST ⇄ KORE conversion: post-order folds that need no
 * `KDefinition`, touch no filesystem, and can be handed a kore-rpc response
 * directly.
 *
 * Transcribed from pyk `konvert/_kast_to_kore.py:362-450` (`_kast_to_kore`) and
 * `konvert/_kore_to_kast.py:47-166` (`_kore_to_kast`) at K v7.1.337, and
 * adjudicated against the Java/Scala originals pyk itself re-implements:
 * `ModuleToKORE.java:2214-2352` forward and
 * `parser/kore/parser/KoreToK.scala` back.  Where the two disagree, the
 * verdict and its reason are stated at the site — see the list under
 * "Deliberate deviations from pyk" below.
 *
 * # What "pure" costs, and what it does not
 *
 * `kastToKorePure` assumes its input is **already sorted and injected**: every
 * `KVariable` carries a sort, every subterm sits at the sort its parent's
 * production declares, and `KSequence`s have already become `kseq`/`append`/
 * `dotk` applications.  `convert.ts`'s `kastToKore` is the pipeline that
 * arranges all of that.  Handed raw KAST, this function will still produce
 * *a* pattern; it will simply be the wrong one, exactly as pyk's is.
 *
 * `koreToKastPure` has no such precondition — the KORE side is fully
 * self-describing — so it is the whole of the reverse direction bar
 * `removeCellMapItems`.
 *
 * # Recursion
 *
 * Both folds are explicit stack machines.  pyk wrote them that way to survive
 * CPython's recursion limit (`_kast_to_kore.py:362-378`) and the reason
 * transfers unchanged: a real configuration nests deeper than a JS engine's
 * default stack, and a `RangeError` is not an acceptable outcome of converting
 * a term.
 *
 * # Deliberate deviations from pyk
 *
 * Each is documented again at the code that does it.
 *
 * 1. **Mangling goes through `@kframework-ts/kore`.**  `mangleName` implements
 *    the full Java encoder — the `%04x` fallback for unmapped characters and
 *    the `'Kywd'` keyword suffix — where pyk's `munge` (`_utils.py:53-66`)
 *    passes unmapped characters through raw, producing invalid KORE, and
 *    applies `'Kywd'` in the module path but not the term path.  Java applies
 *    both, uniformly, from one static method used for labels, variables *and*
 *    sorts (`ModuleToKORE.java:2170-2188`).
 * 2. **Sort names are mangled on the way out and not unmangled on the way
 *    back.**  Both references are asymmetric here and this one follows them;
 *    the asymmetry is written down rather than "fixed".
 * 3. **Set variables.**  `@X` becomes the KORE set variable `@Var<munged>`, and
 *    back.  pyk has no set-variable handling at all and turns `@X` into the
 *    *element* variable `Var'-AT-'X`.
 * 4. **`Var` is checked before it is stripped.**  pyk slices `name[3:]` blind
 *    (`_kore_to_kast.py:79`), which corrupts every variable not spelled
 *    `Var…` — including the `R` sort parameter in every function-equation
 *    axiom.
 * 5. **`Lbl` is stripped once, not recursively.**  Here pyk is right and Java
 *    is not: `extractKLabel` (`KoreToK.scala:79-83`) recurses, so a K label
 *    literally spelled `Lblah` is over-stripped to `ah`.
 * 6. **Parametric labels are general.**  pyk hardcodes the single symbol
 *    `Lblite` and raises `Unsupported polymorphic operator` on every other
 *    parameterized symbol (`_kore_to_kast.py:104-111`); `KoreToK.scala:77-78`
 *    just keeps the parameters on any label, which is less code and no failure
 *    mode.  `ite` was only ever the sole `{Sort}`-parametric production in K's
 *    builtins.
 * 7. **`\forall`, `\floor` and `\rewrites` are decoded**, and `StringLiteral`
 *    becomes a `KString` token.  pyk raises on all four; `KoreToK.scala`
 *    supports all four, and it is what `kore-print` runs — i.e. what pyk's own
 *    CLI fallback shells out to.  `\iff` and `\in` keep raising (both
 *    references agree), and so do `\mu`/`\nu`/`\next` (scala-kore's AST cannot
 *    even express them).
 * 7a. **The two folds are therefore not inverses on `\rewrites`.**  Decoding
 *    it (7) hands back a `KRewrite`, and `kastToKorePure` rejects a `KRewrite`
 *    with `Unsupported KInner` — so `kastToKorePure(koreToKastPure(p))` throws
 *    for a `p` containing one.  Neither reference has this shape: pyk raises
 *    in *both* directions, and Java is symmetric because its `KRewrite`
 *    carries the missing input.  `ModuleToKORE.apply(KRewrite)`
 *    (`ModuleToKORE.java:2325-2333`) reads the result sort out of the node's
 *    own `Att.SORT()` attribute — `k.att().get(Att.SORT(), Sort.class)` — and
 *    `\rewrites{S}` cannot be written without it.  `@kframework-ts/kast`'s
 *    `KRewrite` is `{node, lhs, rhs}` and has nowhere to put that sort
 *    (`inner.ts:132-136`), which is why the decode drops it in the first
 *    place, following `KoreToK.scala:159-160`.  Recovering it needs a
 *    `KDefinition` — `sortOf` on the two sides — so it is a *definition*-tier
 *    concern by construction, and it is where it belongs: `kruleToKore`
 *    (`rule.ts`) decomposes a rule's `KRewrite` into an explicit lhs/rhs pair
 *    before either side reaches this fold.  Losing the sort is the price of
 *    decoding at all; the alternative is pyk's, which is to refuse.
 * 8. **`\and`/`\or` operands are assoc-flattened** (`KoreToK.scala:137-142`).
 * 9. **String/Bytes detection is by hook attribute**, with the sort-name pair
 *    pyk hardcodes as the default.  See {@link SortHooks}.
 * 10. **An empty `KSequence` is a term, not a falsy value.**  `mlAnd`/`mlOr`
 *    are `buildAssoc` (`@kframework-ts/kast`, `inner.ts:895-904`), and pyk's
 *    `build_assoc` (`kast/inner.py:912-932`) writes `if not res` and
 *    `return res or unit` where `KSequence.__len__` makes `KSequence([])`
 *    **falsy**.  So pyk drops an empty-sequence operand and, if it is the only
 *    one, returns the unit instead.  `@kframework-ts/kast` tests `=== null`,
 *    which is what the code means.  This is visible from `konvert`:
 *    `koreToKastPure(\or{SortK{}}(VarV1, dotk{}()))` is `#Or{K}(V1, .K)` here
 *    and `V1` under pyk.  See "the empty-`KSequence` unit" in `README.md` for
 *    the second consequence, in `kruleToKore`.
 *
 * And one deviation from *Java*, taken from pyk deliberately: **token escaping
 * is a strip/re-add, not a verbatim reuse** — see {@link ktokenToKore}.
 */

import {
  type KInner,
  type KLabel,
  type KSort,
  type KToken,
  type KVariable,
  kapply,
  klabel,
  krewrite,
  ksequence,
  ksort,
  ktoken,
  kvariable,
  sortKey,
  terms,
  dequoteBytes,
  dequoteString,
  enquoteBytes,
  enquoteString,
} from "@kframework-ts/kast";
import { BYTES } from "@kframework-ts/kast/prelude/bytes";
import {
  mlAnd,
  mlBottom,
  mlCeil,
  mlEquals,
  mlExists,
  mlImplies,
  mlNot,
  mlOr,
  mlTop,
} from "@kframework-ts/kast/prelude/ml";
import { STRING } from "@kframework-ts/kast/prelude/string";
import {
  type App,
  type EVar,
  type Pattern,
  type Sort,
  type SVar,
  app,
  demangleName,
  dv,
  evar,
  koreString,
  koreText,
  mangleName,
  mlPattern,
  patterns,
  sortApp,
  svar,
} from "@kframework-ts/kore";
import { SORT_K } from "@kframework-ts/kore/prelude";

import { frozenMap } from "./frozen.js";

//////////////////////////////
// Label tables             //
//////////////////////////////

/** `ML_CONN_LABELS` — pyk `_kast_to_kore.py:50-58`. */
export const ML_CONN_LABELS: ReadonlyMap<string, string> = frozenMap([
  ["#Top", "\\top"],
  ["#Bottom", "\\bottom"],
  ["#Not", "\\not"],
  ["#And", "\\and"],
  ["#Or", "\\or"],
  ["#Implies", "\\implies"],
  ["#Iff", "\\iff"],
]);

/** `ML_QUANT_LABELS` — pyk `_kast_to_kore.py:60-63`. */
export const ML_QUANT_LABELS: ReadonlyMap<string, string> = frozenMap([
  ["#Exists", "\\exists"],
  ["#Forall", "\\forall"],
]);

/** `ML_PRED_LABELS` — pyk `_kast_to_kore.py:65-70`. */
export const ML_PRED_LABELS: ReadonlyMap<string, string> = frozenMap([
  ["#Ceil", "\\ceil"],
  ["#Floor", "\\floor"],
  ["#Equals", "\\equals"],
  ["#In", "\\in"],
]);

/** The union of the three tables — pyk `_kast_to_kore.py:72-76`. */
export const ML_PATTERN_LABELS: ReadonlyMap<string, string> = frozenMap([
  ...ML_CONN_LABELS,
  ...ML_QUANT_LABELS,
  ...ML_PRED_LABELS,
]);

/**
 * The four symbols the conversion invents rather than reads off a production —
 * pyk `_kast_to_kore.py:444`.  They are declared by `prelude.kore`, carry no
 * `Lbl` prefix, and must not be mangled in either direction.
 */
const PSEUDO_LABELS: ReadonlySet<string> = new Set(["inj", "kseq", "dotk", "append"]);

/** Index into an array whose bounds the caller has already established. */
function at<T>(xs: readonly T[], i: number): T {
  const x = xs[i];
  if (x === undefined) throw new RangeError(`Index ${i} is out of range (length ${xs.length})`);
  return x;
}

/** The top frame of a work stack the caller has already established is non-empty. */
function top<T>(stack: readonly T[]): T {
  return at(stack, stack.length - 1);
}

//////////////////////////////
// Sort hooks               //
//////////////////////////////

/**
 * Which sorts are the `String` and `Bytes` sorts, by hook attribute.
 *
 * Java dispatches token escaping on the sort's `hook` attribute — `STRING.String`
 * and `BYTES.Bytes` (`ModuleToKORE.java:2258-2272` forward,
 * `KoreToK.scala:170` back).  pyk compares against the literal sort *names*
 * `String` and `Bytes` (`_kast_to_kore.py:396-399`, `_kore_to_kast.py:71-74`),
 * so a definition that hooks `STRING.String` onto a differently-named sort
 * converts correctly under Java and silently wrongly under pyk.
 *
 * Java is right, and the fix costs one map lookup — but it also needs a
 * definition, and this module has none.  So the map is a **parameter**, and its
 * default is exactly pyk's hardcoded pair: unqualified `String` is the
 * `STRING.String` sort and unqualified `Bytes` is the `BYTES.Bytes` sort.  Pass
 * a real one (`sortHooks(definition)` in `convert.ts`) and the Java behaviour
 * is recovered; pass nothing and this module stays definition-free and behaves
 * as pyk does.
 *
 * Keys are **unmangled** K sort names (`String`, not `SortString`).
 */
export type SortHooks = ReadonlyMap<string, string>;

/** The `hook` attribute value Java tests for the `String` sort. */
export const HOOK_STRING = "STRING.String";

/** The `hook` attribute value Java tests for the `Bytes` sort. */
export const HOOK_BYTES = "BYTES.Bytes";

/**
 * pyk's hardcoded pair, as a hook map — the default for both pure converters.
 *
 * It goes through {@link frozenMap} rather than `Object.freeze`: freezing a
 * `Map` object does not freeze its contents, so the naive spelling let one
 * `.set` behind a cast change how *every* subsequent conversion in the process
 * escapes tokens.
 */
export const DEFAULT_SORT_HOOKS: SortHooks = frozenMap([
  [STRING.name, HOOK_STRING],
  [BYTES.name, HOOK_BYTES],
]);

/** Options both pure converters accept. */
export interface PureConvertOptions {
  /** Sort name → `hook` attribute. Defaults to {@link DEFAULT_SORT_HOOKS}. */
  readonly hooks?: SortHooks;
}

//////////////////////////////
// KAST → KORE              //
//////////////////////////////

/**
 * `KSort` → `SortApp` — pyk `_ksort_to_kore` (`_kast_to_kore.py:358-359`).
 *
 * **Deviation 2, first half: the name is mangled.**  pyk does not munge here,
 * although its own `_module_to_kore._sort_name` (`:240`) does; Java munges in
 * both places, because `ModuleToKORE.convert(String, StringBuilder)` is one
 * static method used for labels, variables *and* sorts
 * (`ModuleToKORE.java:2048-2049` calls it for a sort). Real sort names are
 * alphanumeric, so the two agree on everything `kompile` actually emits.
 *
 * `KSort.params` are dropped, as in pyk: a parametric sort cannot appear in the
 * term positions this converter reaches, and inventing a `SortApp` argument
 * list Java never writes would be worse than dropping something that is never
 * there.
 */
export function ksortToKore(sort: KSort): Sort {
  return sortApp("Sort" + mangleName(sort.name));
}

/**
 * `SortApp` → `KSort` — pyk `_sort_to_kast` (`_kore_to_kast.py:163-166`).
 *
 * **Deviation 2, second half: the name is *not* unmangled.**  Both references
 * agree — pyk slices `[4:]`, `KoreToK.scala:72` does `ctr.substring(4)` — so
 * Java is itself asymmetric here, and this package reproduces the asymmetry
 * rather than quietly improving on it.  It is harmless in practice because real
 * sort names are alphanumeric and mangle to themselves; it is *not* harmless to
 * have the two directions disagree about which one is doing the odd thing, so
 * it is written down.
 *
 * Sort *parameters* are kept — `KoreToK.scala:73` maps them recursively — which
 * is what the general parametric-label mechanism needs.  pyk drops them
 * (`_sort_to_kast` builds a bare `KSort`), but pyk also cannot produce a
 * parametric sort in the first place: the only parameterized symbol it decodes
 * is `Lblite`, whose parameter is always a ground sort.
 *
 * @throws {TypeError} for a `SortVar`, or a `SortApp` without the `Sort`
 *   prefix. pyk raises `ValueError` for both. Java (`KoreToK.scala:68-69`)
 *   silently maps a `SortVariable` to `SortK`, which is lossy; this package
 *   deliberately does not copy that.
 */
export function sortToKast(sort: Sort): KSort {
  if (sort.tag !== "SortApp" || !sort.name.startsWith("Sort")) {
    throw new TypeError(`Unsupported Sort: ${koreText(sort)}`);
  }
  return ksort(sort.name.slice(4), sort.sorts.map(sortToKast));
}

/**
 * `KLabel` name → KORE symbol — pyk `_label_to_kore`
 * (`_kast_to_kore.py:443-450`).
 *
 * **Deviation 1**: the mangling is `mangleName`, not pyk's `munge`. The two
 * differ on exactly the inputs pyk gets wrong — a character with no mnemonic
 * (pyk emits it raw, producing invalid KORE; Java and this emit `%04x`) and a
 * label that *is* a KORE keyword (pyk's term path omits the `'Kywd'` suffix its
 * own module path applies; Java applies it everywhere).
 *
 * The ML table is a `Map` (see {@link frozenMap}) precisely so that a K label
 * spelled like an `Object.prototype` member — `toString`, `constructor`,
 * `valueOf`, `hasOwnProperty`, `__proto__` — is an ordinary label here and
 * mangles to `Lbl…`, as it does under pyk, whose tables are `dict`s and so
 * have no such inheritance either.
 */
export function labelToKore(label: string): string {
  if (PSEUDO_LABELS.has(label)) return label;
  const ml = ML_PATTERN_LABELS.get(label);
  if (ml !== undefined) return ml;
  return "Lbl" + mangleName(label);
}

/**
 * KORE symbol → `KLabel` name — the inverse of {@link labelToKore} for the
 * `Lbl`-prefixed case.
 *
 * **Deviation 5**: `Lbl` is stripped **once**.  pyk slices `symbol[3:]`
 * (`_kore_to_kast.py:101`); `KoreToK.extractKLabel` (`KoreToK.scala:79-83`)
 * *recurses*, so a K label literally spelled `Lblah` — mangled `LblLblah` —
 * comes back as `ah`.  That is a Java bug and pyk is right; this follows pyk.
 *
 * A symbol without the prefix is decoded as-is rather than rejected, matching
 * `extractKLabel`'s else branch.
 */
export function labelToKast(symbol: string): string {
  return demangleName(symbol.startsWith("Lbl") ? symbol.slice(3) : symbol);
}

/**
 * `KToken` → `\dv` — pyk `_ktoken_to_kore` (`_kast_to_kore.py:394-405`).
 *
 * **Token escaping is a two-layer strip/re-add**, and this is the one place
 * where pyk is followed *against* Java on purpose.
 *
 * A KAST token carries *K-level* quoting: a `String` token's text is
 * `"…"` with K escapes inside, a `Bytes` token's is `b"…"`.  A KORE `\dv`
 * carries *KORE-level* quoting.  pyk strips the K layer here (`prettyString`
 * / `prettyBytesStr`) and lets the KORE writer add the KORE layer.  Java
 * (`ModuleToKORE.java:2253-2278`) instead reuses the K layer verbatim as the
 * KORE layer, applying only `escapeNonASCII` on top.
 *
 * The two escape vocabularies coincide, so both results are valid KORE — but
 * they are **not byte-equal**: a K token `"\x41"` becomes `\dv{SortString{}}("\x41")`
 * under Java and `\dv{SortString{}}("A")` here.  The normalizing behaviour is
 * the one that round-trips, so it is the one taken; expect this to be where any
 * diff against a `kast --output kore` golden shows up.
 *
 * The hook lookup (**deviation 9**) is Java's, not pyk's: see {@link SortHooks}.
 */
export function ktokenToKore(token: KToken, hooks: SortHooks = DEFAULT_SORT_HOOKS): Pattern {
  const hook = hooks.get(token.sort.name);
  const value =
    hook === HOOK_STRING
      ? stripKQuoting(token.token, '"', "String")
      : hook === HOOK_BYTES
        ? stripKQuoting(token.token, 'b"', "Bytes")
        : token.token;
  return dv(ksortToKore(token.sort), koreString(value));
}

/**
 * Strip one K quoting layer: `"…"` for a `String`, `b"…"` for a `Bytes`.
 *
 * This is `prettyString` / `prettyBytesStr` (`kast/prelude/{string,bytes}.py`)
 * with the **sort check removed**, which is the whole point of the hook map: a
 * sort hooked to `STRING.String` under another name has K-string quoting and
 * pyk's constructors would reject it for not being called `String`.
 */
function stripKQuoting(text: string, open: string, what: string): string {
  if (text.length < open.length + 1 || !text.startsWith(open) || !text.endsWith('"')) {
    throw new TypeError(`Expected a quoted ${what} token, got: ${text}`);
  }
  const body = text.slice(open.length, -1);
  return what === "String" ? dequoteString(body) : dequoteBytes(body);
}

/**
 * Add the K quoting layer back — the inverse of {@link stripKQuoting}, and
 * `stringToken` / `bytesTokenFromStr` with the sort left free.
 *
 * pyk's constructors hardcode the sorts `String` and `Bytes`
 * (`_kore_to_kast.py:72-74`); `KoreToK.scala:169-176` keeps the `\dv`'s own
 * sort and changes only the quoting. Java is right for the same reason it is
 * right about detection, and for a sort actually named `String` the two agree
 * exactly.
 */
function addKQuoting(value: string, sort: KSort, hook: string | undefined): KToken {
  if (hook === HOOK_STRING) return ktoken(`"${enquoteString(value)}"`, sort);
  if (hook === HOOK_BYTES) return ktoken(`b"${enquoteBytes(value)}"`, sort);
  return ktoken(value, sort);
}

/**
 * `KVariable` → `EVar`, or an `SVar` for a set variable — pyk
 * `_kvariable_to_kore` (`_kast_to_kore.py:408-414`) plus **deviation 3**.
 *
 * A K variable whose name begins `@` is a *set* variable.  Java emits
 * `@Var<munged>:<Sort>` for it — the `@` **precedes** the `Var` prefix, and the
 * name that is mangled is the one with the `@` already removed
 * (`ModuleToKORE.java:2313-2318`).  pyk has no handling at all: `@X` goes
 * through the ordinary path and comes out as the *element* variable
 * `Var'-AT-'X`, which is a different kind of variable, not a differently-spelled
 * one.  Java is right.
 *
 * A variable with no sort is `SortK{}` — pyk `:413`, Java `:2318`'s
 * `orElse(Sorts.K())`.
 */
export function kvariableToKore(variable: KVariable): EVar | SVar {
  const sort = variable.sort === undefined ? SORT_K : ksortToKore(variable.sort);
  if (variable.name.startsWith("@")) {
    return svar("@Var" + mangleName(variable.name.slice(1)), sort);
  }
  return evar("Var" + mangleName(variable.name), sort);
}

/** `KApply` → `Pattern` — pyk `_kapply_to_kore` (`_kast_to_kore.py:417-440`). */
function kapplyToKore(label: KLabel, args: readonly Pattern[]): Pattern {
  const quant = ML_QUANT_LABELS.get(label.name);
  if (quant !== undefined) {
    // pyk `_kapply_to_ml_quant` (`:424-429`): `#Exists{S1, S2}` carries the
    // bound variable's sort first and the pattern's sort second, but
    // `\exists{S}` takes only the latter.  pyk destructures — `sort1, sort2 =
    // label.params` — so a count other than exactly two is a `ValueError`
    // there and a `TypeError` here, rather than a silently-ignored extra.
    if (label.params.length !== 2) {
      throw new TypeError(`Expected two sort parameters on ${label.name}, got ${label.params.length}`);
    }
    return mlPattern(quant, [ksortToKore(at(label.params, 1))], args);
  }

  const symbol = labelToKore(label.name);
  const sorts = label.params.map(ksortToKore);
  if (ML_PATTERN_LABELS.has(label.name)) return mlPattern(symbol, sorts, args);
  return app(symbol, sorts, args);
}

/** One node's worth of KAST → KORE, its children already converted. */
function kinnerToKore(term: KInner, args: readonly Pattern[], hooks: SortHooks): Pattern {
  switch (term.node) {
    case "KToken":
      return ktokenToKore(term, hooks);
    case "KVariable":
      return kvariableToKore(term);
    case "KApply":
      return kapplyToKore(term.label, args);
    default:
      // pyk `_kinner_to_kore:390-391`. `KSequence` is gone by now
      // (`replaceKsequenceByKapply`), and `KAs`/`KRewrite` are rule syntax that
      // `rule.ts` decomposes before it gets here.
      //
      // Java encodes all three (`ModuleToKORE.java:2280-2344`), but only
      // because its nodes carry an `Att.SORT()` this term algebra has no room
      // for: `\rewrites{S}`/`\and{S}` need an `S` that a `KRewrite`/`KAs`
      // alone does not supply. `KRewrite` is the reachable case — this fold's
      // inverse *emits* one — and **deviation 7a** in the header says why the
      // asymmetry stays.
      throw new TypeError(`Unsupported KInner: ${term.node}`);
  }
}

/**
 * KAST → KORE, with no definition — pyk `_kast_to_kore`
 * (`_kast_to_kore.py:362-378`).
 *
 * The term must already be sorted and injected; see the module header.  The
 * traversal is pyk's explicit stack, two slots per frame (the term, and the
 * list of converted children so far).
 */
export function kastToKorePure(term: KInner, options: PureConvertOptions = {}): Pattern {
  const hooks = options.hooks ?? DEFAULT_SORT_HOOKS;

  const stack: { readonly term: KInner; readonly children: readonly KInner[]; readonly done: Pattern[] }[] = [
    { term, children: terms(term), done: [] },
  ];

  for (;;) {
    // The stack is never empty here: the loop only pops a frame after checking
    // whether popping would empty it, in which case it returns instead.
    const frame = top(stack);
    if (frame.done.length === frame.children.length) {
      stack.pop();
      const pattern = kinnerToKore(frame.term, frame.done, hooks);
      if (stack.length === 0) return pattern;
      top(stack).done.push(pattern);
    } else {
      const child = at(frame.children, frame.done.length);
      stack.push({ term: child, children: terms(child), done: [] });
    }
  }
}

//////////////////////////////
// KORE → KAST              //
//////////////////////////////

/**
 * `\left-assoc`/`\right-assoc` expanded one level into an application cascade —
 * pyk `Assoc.pattern` (`kore/syntax.py:637-641`, `:695-699`).
 *
 * `@kframework-ts/kore` keeps the sugar as a node (expansion is lossy and
 * cannot be undone), so the expansion lives here, at the one consumer that
 * wants it.  Non-assoc patterns are returned untouched, which is how
 * `_kore_to_kast` uses it: at the root and at every child push (`:48`, `:63`).
 *
 * `args` is non-empty by construction, so the fold always has a seed.
 *
 * **Deviation: `RightAssoc` keeps its sort parameters.**  pyk's `LeftAssoc.pattern`
 * (`kore/syntax.py:639`) passes `self.sorts` to each generated `App`, but
 * `RightAssoc.pattern` (`kore/syntax.py:697`) passes an **empty tuple** — the
 * two are otherwise identical, so the asymmetry is plainly a slip and not a
 * decision: an expanded `\right-assoc{}(Lblf{SortInt{}}(…))` loses the
 * `{SortInt{}}` on every cascade node under pyk and keeps it here.  Java has no
 * counterpart to compare against — `\left-assoc`/`\right-assoc` are surface
 * sugar the KORE *parser* expands — and a parametric assoc symbol does not
 * occur in a `kompile`d `definition.kore`, so nothing observable turns on it.
 * Kept as written because dropping a symbol's sort parameters silently is the
 * strictly worse failure mode.
 */
export function expandAssoc(pattern: Pattern): Pattern {
  if (pattern.tag === "LeftAssoc") {
    const [, ...rest] = pattern.args;
    return rest.reduce<Pattern>((acc, arg) => app(pattern.symbol, pattern.sorts, [acc, arg]), at(pattern.args, 0));
  }
  if (pattern.tag === "RightAssoc") {
    const init = pattern.args.slice(0, -1);
    const last = at(pattern.args, pattern.args.length - 1);
    return init.reduceRight<Pattern>((acc, arg) => app(pattern.symbol, pattern.sorts, [arg, acc]), last);
  }
  return pattern;
}

/**
 * `EVar`/`SVar` name → K variable name — `KoreToK.extractVarName`
 * (`KoreToK.scala:102-107`), **deviation 4**.
 *
 * pyk does `unmunge(name[3:])` unconditionally (`_kore_to_kast.py:79`), which
 * corrupts any variable not spelled `Var…` — including the `R` sort-parameter
 * variable that appears in every function-equation axiom, which pyk turns into
 * the empty name.  Java tests the prefix first, and so does this.
 *
 * The `@` of a set variable is peeled before the test and restored after, so
 * both `@X` (what `kompile` writes for a set variable in a `.kast` file, and
 * what the only committed fixture in the K repo contains) and `@VarX` (what
 * `ModuleToKORE.java:2313-2318` emits, and what {@link kvariableToKore}
 * emits) decode to `@X`.  `KoreToK.scala` deliberately does not strip the `@`
 * either; it simply never sees the `@Var…` spelling in its own fixtures.
 */
export function varNameToKast(name: string): string {
  if (name.startsWith("@")) return "@" + varNameToKast(name.slice(1));
  return demangleName(name.startsWith("Var") ? name.slice(3) : name);
}

/**
 * `\dv` → `KToken`, the reverse of {@link ktokenToKore} — pyk
 * `_pattern_to_kast:69-75`.
 *
 * `stringToken`/`bytesTokenFromStr` re-add the K quoting layer that
 * {@link ktokenToKore} stripped.  Detection is by hook (**deviation 9**), with
 * pyk's hardcoded sort-name pair as the default.
 */
function dvToKast(sort: Sort, value: string, hooks: SortHooks): KToken {
  const kastSort = sortToKast(sort);
  return addKQuoting(value, kastSort, hooks.get(kastSort.name));
}

/**
 * `Assoc.flatten` over the operands of an `\and`/`\or` — `KoreToK.scala:137-142`,
 * **deviation 8**.
 *
 * An operand that is itself a `#And`/`#Or` at the *same* sort is spliced in.
 * pyk does not do this; it hands the operands straight to `mlAnd`/`mlOr`, which
 * re-nest them to the right.  For the right-nested chains a `definition.kore`
 * actually contains the two agree exactly — flattening and re-nesting is the
 * identity there — so the only observable difference is that a **left**-nested
 * conjunction is normalized to the right-nested spelling K's pretty-printer
 * downstream expects.
 *
 * The sort check is this package's, not Java's: `Assoc.flatten` matches on the
 * `KLabel` including its parameters, which for `#And` *is* the sort, so the
 * check is what makes the two agree rather than an addition.
 *
 * **The flattening is total, not one level deep.**  `Assoc.flatten`
 * (`Assoc.scala:38-47`) recurses into every same-label child, so a three-deep
 * left-nested `\and` flattens to four operands and not to three-with-a-nested-
 * pair.  This is `flattenLabel`'s work list (`@kframework-ts/kast`,
 * `inner.ts:931-947`) with one extra guard: that function matches on
 * `label.name` **alone**, which would splice a `#And{Bool}` into a `#And{Foo}`,
 * so it cannot be called directly and the guard has to travel with the
 * recursion.  A child at a different sort is a leaf and its own children are
 * left alone — the same rule as before, applied at every depth rather than only
 * at the top.
 *
 * Sorts are compared by {@link sortKey}, i.e. structurally including
 * parameters, so `#And{Map{Int, K}}` and `#And{Map{K, Int}}` do not merge.
 */
function flattenMl(label: string, sort: KSort, operands: readonly KInner[]): readonly KInner[] {
  const key = sortKey(sort);
  const flat: KInner[] = [];
  const rest: KInner[] = [];
  for (let i = operands.length - 1; i >= 0; i--) rest.push(at(operands, i));

  for (;;) {
    const current = rest.pop();
    if (current === undefined) return flat;
    if (
      current.node === "KApply" &&
      current.label.name === label &&
      current.label.params.length === 1 &&
      sortKey(at(current.label.params, 0)) === key
    ) {
      for (let i = current.args.length - 1; i >= 0; i--) rest.push(at(current.args, i));
    } else {
      flat.push(current);
    }
  }
}

/** One node's worth of KORE → KAST, its children already converted. */
function patternToKast(pattern: Pattern, children: readonly KInner[], hooks: SortHooks): KInner {
  switch (pattern.tag) {
    case "DV":
      return dvToKast(pattern.sort, pattern.value.value, hooks);

    case "EVar":
    case "SVar":
      return kvariable(varNameToKast(pattern.name), sortToKast(pattern.sort));

    // **Deviation 7, part 2**: pyk has no `String` case and falls through to
    // `Unsupported Pattern`. `KoreToK.scala:177-178` maps it to a `KString`
    // token, and a bare string literal is only ever an attribute argument, so
    // there is nothing to lose by accepting it.
    case "String":
      return ktoken(pattern.value, ksort("KString"));

    case "App":
      return appToKast(pattern, children);

    case "Top":
      return mlTop(sortToKast(pattern.sort));

    case "Bottom":
      return mlBottom(sortToKast(pattern.sort));

    case "And": {
      const sort = sortToKast(pattern.sort);
      return mlAnd(flattenMl("#And", sort, children), sort);
    }

    // `MultiOr` has no pyk class — it is KORE-JSON's `KJMultiOr`, a `\or`
    // cascade in every respect but its spelling — so pyk cannot reach this
    // case. It is the same conversion as `Or`.
    case "Or":
    case "MultiOr": {
      const sort = sortToKast(pattern.sort);
      return mlOr(flattenMl("#Or", sort, children), sort);
    }

    case "Implies":
      return mlImplies(childAt(children, 0), childAt(children, 1), sortToKast(pattern.sort));

    case "Not":
      return mlNot(childAt(children, 0), sortToKast(pattern.sort));

    case "Exists":
      return mlExists(
        kvariable(varNameToKast(pattern.var.name), sortToKast(pattern.var.sort)),
        childAt(children, 0),
        sortToKast(pattern.var.sort),
        sortToKast(pattern.sort),
      );

    // **Deviation 7, part 1**: pyk raises here; `KoreToK.scala:157-158` decodes
    // it, symmetrically with `\exists`, and `kapply` is used directly because
    // `@kframework-ts/kast`'s prelude has an `mlExists` but no `mlForall`
    // (pyk's `prelude/ml.py` has neither the constructor nor the decoder).
    case "Forall":
      return kapply(klabel("#Forall", [sortToKast(pattern.var.sort), sortToKast(pattern.sort)]), [
        kvariable(varNameToKast(pattern.var.name), sortToKast(pattern.var.sort)),
        childAt(children, 0),
      ]);

    case "Equals":
      return mlEquals(childAt(children, 0), childAt(children, 1), sortToKast(pattern.opSort), sortToKast(pattern.sort));

    case "Ceil":
      return mlCeil(childAt(children, 0), sortToKast(pattern.opSort), sortToKast(pattern.sort));

    // **Deviation 7, part 1** again — `KoreToK.scala:163-164`, the dual of
    // `\ceil`. `#Floor` has no prelude constructor upstream either.
    case "Floor":
      return kapply(klabel("#Floor", [sortToKast(pattern.opSort), sortToKast(pattern.sort)]), [childAt(children, 0)]);

    // **Deviation 7, part 1** again — `KoreToK.scala:159-160`. The sort is
    // dropped, as it is there: a `KRewrite` carries no sort of its own, and
    // `KDefinition.sortOf` recovers it from the two sides. Dropping it is what
    // makes this the one node the two folds disagree on: `kastToKorePure`
    // rejects the `KRewrite` this produces. See **deviation 7a** in the header
    // for why that is not fixable in a definition-free tier.
    case "Rewrites":
      return krewrite(childAt(children, 0), childAt(children, 1));

    default:
      // `\iff` and `\in` — `KoreToK.scala:153-154` and `:167-168` throw on
      // exactly these two, and so does pyk (`_kore_to_kast.py:159-160`).
      // `\mu`, `\nu` and `\next` cannot arise from a `kompile`d definition at
      // all: scala-kore's `Pattern` ADT has no such node, so `kore-print`
      // — the fallback pyk shells out to — could not decode one either.
      // `LeftAssoc`/`RightAssoc` are unreachable: `expandAssoc` runs on every
      // pattern before it is pushed.
      throw new TypeError(`Unsupported Pattern: ${pattern.tag}`);
  }
}

function childAt(children: readonly KInner[], index: number): KInner {
  const child = children[index];
  if (child === undefined) throw new TypeError(`Missing subpattern at index ${index}`);
  return child;
}

/** `App` → `KInner` — pyk `_pattern_to_kast:81-111`. */
function appToKast(pattern: App, children: readonly KInner[]): KInner {
  const { symbol, sorts } = pattern;

  // The four pseudo-symbols have fixed signatures in `prelude.kore` — `inj`
  // takes two sort parameters, the three sequence symbols take none — and pyk
  // destructures to read them (`sort1, sort2 = pattern.sorts` at
  // `_kore_to_kast.py:88`, `() = pattern.sorts` at `:92`, `:95`), so a
  // mismatched count raises there rather than being ignored. It raises here too:
  // a `\dv`-free `inj{SortInt{}}(…)` is not a term any KORE producer emits, and
  // silently erasing it would hide whatever produced it.
  const expectSorts = (count: number): void => {
    if (sorts.length !== count) {
      throw new TypeError(`Expected ${count} sort parameters on ${symbol}, got ${sorts.length}`);
    }
  };

  // `inj` is erased: the injection is a KORE artefact with no KAST spelling.
  // `KoreToK.scala:118-123` additionally tags an injected *variable* with
  // `PRETTY_PRINT_WITH_SORT_ANNOTATION`, which is a pretty-printer hint on an
  // attribute this package's `KVariable` does not carry; pyk drops it too.
  if (symbol === "inj") {
    expectSorts(2);
    return childAt(children, 0);
  }

  if (symbol === "dotk") {
    expectSorts(0);
    return ksequence([]);
  }
  // `kseq` and `append` both become a `KSequence`; the KAST constructor
  // flattens a nested one, which is what collapses the cons chain in one pass
  // (`kast/inner.py:602-609`, and `@kframework-ts/kast`'s `ksequence` does the
  // same).
  if (symbol === "kseq" || symbol === "append") {
    expectSorts(0);
    return ksequence(children);
  }

  // **Deviation 6**: the sort parameters are simply kept on the label, for any
  // symbol. pyk hardcodes `Lblite` (`_kore_to_kast.py:104-111`) and raises
  // `Unsupported polymorphic operator` on everything else;
  // `KoreToK.scala:77-78` is this line, with no branch and no failure mode.
  return kapply(klabel(labelToKast(symbol), sorts.map(sortToKast)), children);
}

/**
 * KORE → KAST, with no definition — pyk `_kore_to_kast`
 * (`_kore_to_kast.py:47-64`).
 *
 * `koreToKast` in `convert.ts` is this plus `removeCellMapItems`; nothing else
 * in the reverse direction needs a `KDefinition`.
 *
 * The traversal is pyk's explicit stack, and `expandAssoc` runs at every push —
 * root included — so `\left-assoc`/`\right-assoc` never reach the fold.
 */
export function koreToKastPure(pattern: Pattern, options: PureConvertOptions = {}): KInner {
  const hooks = options.hooks ?? DEFAULT_SORT_HOOKS;

  const stack: { readonly pattern: Pattern; readonly children: readonly Pattern[]; readonly done: KInner[] }[] = [];
  const push = (p: Pattern): void => {
    const expanded = expandAssoc(p);
    stack.push({ pattern: expanded, children: patterns(expanded), done: [] });
  };
  push(pattern);

  for (;;) {
    const frame = top(stack);
    if (frame.done.length === frame.children.length) {
      stack.pop();
      const term = patternToKast(frame.pattern, frame.done, hooks);
      if (stack.length === 0) return term;
      top(stack).done.push(term);
    } else {
      push(at(frame.children, frame.done.length));
    }
  }
}
