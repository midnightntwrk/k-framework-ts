/**
 * The KAST inner-term algebra — a hand-transcription of `pyk/kast/inner.py`
 * (972 L) at K **v7.1.337**, speaking KAST **v4**.
 *
 * # What lives here
 *
 * The `KInner` ADT, its factory constructors, the structural accessors
 * (`terms` / `letTerms` / `mapInner`), the four traversals, syntactic
 * `match`, `Subst`, the `KRewrite` operations, and the small list builders
 * (`buildAssoc` / `buildCons` / `flattenLabel`).  Nothing here needs a
 * `KDefinition`, an attribute, or the prelude — `inner.py` is the bottom of
 * pyk's kast layering and this module keeps that property.
 *
 * # `KSort` and `KLabel` are not `KInner`
 *
 * `inner.py:29,57` extend `KAst` directly, not `KInner`.  So a sort parameter
 * and a label's sort parameters are **not subterms**: {@link terms} never
 * returns them, no traversal visits them, {@link collect} never sees them, and
 * a `KVariable` hiding inside a sort parameter is invisible to
 * {@link varOccurrences}.  Several `manip.py` functions depend on exactly
 * that, so it is a contract, not an omission.
 *
 * # `InjectedKLabel` is deliberately absent
 *
 * The Java writer emits an `InjectedKLabel` node and `@kframework-ts/kast-json`
 * models it, but pyk's `inner.py` at v7.1.337 does **not**: `KInner._NODES`
 * (`inner.py:139`) is exactly `{KVariable, KToken, KApply, KAs, KRewrite,
 * KSequence}`.  This package is a transcription of pyk, so it models those six
 * and no more; a document containing `InjectedKLabel` fails {@link fromDict}
 * the same way it fails `KInner.from_dict`.
 *
 * # Nothing recurses
 *
 * Every traversal here runs on an explicit work stack, so term depth is bounded
 * by heap, not by the JS call stack.  pyk hand-stacked all of these except
 * `build_cons` (`inner.py:935-951`); {@link buildCons} is stacked here too.
 *
 * # Transcription notes (deliberate deviations)
 *
 * - **Constructors take arrays, never varargs-or-iterable.**  pyk's
 *   `KApply.__init__` / `KLabel.__init__` / `KSequence.__init__`
 *   (`inner.py:70-93`, `364-390`, `587-611`) sniff their arguments with
 *   `isinstance(..., Iterable)` to support both spellings.  That machinery is
 *   a Python affordance, and the `TypeError` messages it raises are not part
 *   of the term algebra.
 * - **The `KRewrite` operations are free functions with a `rewrite` prefix**
 *   ({@link rewriteApplyTop}, {@link rewriteApply}, {@link rewriteReplaceTop},
 *   {@link rewriteReplace}) rather than pyk's `apply_top` / `apply` /
 *   `replace_top` / `replace` methods: unprefixed `apply` and `replace` at
 *   package scope would collide with the far more common meanings of those
 *   words.
 */

import { eq, eqSort } from "./eq.js";

//////////////////////
// Sorts and labels //
//////////////////////

/**
 * A K sort, optionally applied to sort parameters (`inner.py:27-52`).
 *
 * KAST v4 makes `params` a real recursive list; v3 inlined them into `name` as
 * a flat string (`"Map{Int,Int}"`).  See `version.ts`.
 */
export interface KSort {
  readonly name: string;
  readonly params: readonly KSort[];
}

/**
 * A symbol that can be applied in a K AST, with optional sort parameters
 * (`inner.py:55-129`).
 *
 * Structurally identical to {@link KSort}, and TypeScript will therefore let
 * one stand in for the other.  pyk distinguishes them by class; we cannot
 * without a brand, and a brand would make these non-plain data. The two
 * are never interchangeable in K, so pass them by name and not by inference.
 */
export interface KLabel {
  readonly name: string;
  readonly params: readonly KSort[];
}

//////////////////////
// The term ADT     //
//////////////////////

/** A domain value — `#token(token, sort)` (`inner.py:248-291`). */
export interface KToken {
  readonly node: "KToken";
  readonly token: string;
  readonly sort: KSort;
}

/**
 * A logical variable, with a name and optionally a sort (`inner.py:294-353`).
 *
 * `sort` is a required property that may hold `undefined`, rather than an
 * optional one.  Under `exactOptionalPropertyTypes` that is what makes
 * "unsorted" a value a caller can construct and compare, instead of a key that
 * is sometimes absent; the JSON codec still omits the key entirely when it is
 * `undefined` (`inner.py:327-332`).
 */
export interface KVariable {
  readonly node: "KVariable";
  readonly name: string;
  readonly sort: KSort | undefined;
}

/** The application of a {@link KLabel} to arguments (`inner.py:356-434`). */
export interface KApply {
  readonly node: "KApply";
  readonly label: KLabel;
  readonly args: readonly KInner[];
}

/**
 * `KApply.is_cell` (`inner.py:397-400`) as a type guard.
 *
 * pyk's is a property on `KApply`; this package models `KApply` as a plain
 * interface, so the property becomes a free predicate over any {@link KInner}
 * — which is how every call site already used it, since a caller holding a
 * `KInner` had to narrow before reading `.is_cell` anyway.  The heuristic is
 * upstream's verbatim: a label name longer than one character that starts with
 * `<` and ends with `>`.
 *
 * Exported because the display and rule-building layers across this monorepo
 * (`kast`'s own `manip`/`outer`/`pretty`, `kcfg`'s `KCFGExplore` and rule
 * builder, `proof`'s) all need exactly this test and had each re-derived it.
 */
export function isCell(term: KInner): term is KApply {
  if (term.node !== "KApply") return false;
  const name = term.label.name;
  return name.length > 1 && name.startsWith("<") && name.endsWith(">");
}

/** A K `#as` pattern: the original pattern plus its alias (`inner.py:437-474`). */
export interface KAs {
  readonly node: "KAs";
  readonly pattern: KInner;
  readonly alias: KInner;
}

/**
 * A rewrite **term** — not a rule (`inner.py:477-571`).
 *
 * It is an ordinary node that can appear anywhere in a term, and
 * {@link rewriteApply} applies it once per position in one bottom-up pass with
 * no fixpoint.
 */
export interface KRewrite {
  readonly node: "KRewrite";
  readonly lhs: KInner;
  readonly rhs: KInner;
}

/**
 * A `K` sequence (`inner.py:574-662`).
 *
 * **Always flat.**  {@link ksequence} splices nested sequences into the parent
 * (`inner.py:603-609`), and because every construction path in this package
 * goes through it — {@link letTerms}, every traversal rebuild, `fromDict`, the
 * tail binding in {@link match} — a `KSequence` whose `items` contain a
 * `KSequence` cannot be built.  Terms would silently diverge from pyk if any
 * path skipped it.
 */
export interface KSequence {
  readonly node: "KSequence";
  readonly items: readonly KInner[];
}

/** The AST of a K inner term (`inner.py:132-245`). */
export type KInner = KToken | KVariable | KApply | KAs | KRewrite | KSequence;

/** The six node names `KInner.from_dict` dispatches on (`inner.py:139`). */
export const K_INNER_NODES = ["KVariable", "KToken", "KApply", "KAs", "KRewrite", "KSequence"] as const;

/** The `node` tag of any `KInner`. */
export type KInnerNode = KInner["node"];

//////////////////////
// Constructors     //
//////////////////////

const NO_TERMS: readonly KInner[] = Object.freeze([]);
const NO_SORTS: readonly KSort[] = Object.freeze([]);

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

/** `KSort(name, params)` (`inner.py:35-37`). */
export function ksort(name: string, params: readonly KSort[] = NO_SORTS): KSort {
  return Object.freeze({ name, params: params.length === 0 ? NO_SORTS : Object.freeze([...params]) });
}

/**
 * `KLabel(name, params)` (`inner.py:70-93`).
 *
 * A `string` parameter is coerced to a bare `KSort`, exactly as
 * `inner.py:91` does.
 */
export function klabel(name: string, params: readonly (string | KSort)[] = NO_SORTS): KLabel {
  if (params.length === 0) return Object.freeze({ name, params: NO_SORTS });
  const coerced: KSort[] = [];
  for (const param of params) coerced.push(typeof param === "string" ? ksort(param) : param);
  return Object.freeze({ name, params: Object.freeze(coerced) });
}

/** `KToken(token, sort)` (`inner.py:256-262`); a `string` sort is coerced. */
export function ktoken(token: string, sort: string | KSort): KToken {
  return Object.freeze({
    node: "KToken" as const,
    token,
    sort: typeof sort === "string" ? ksort(sort) : sort,
  });
}

/** `KVariable(name, sort)` (`inner.py:302-308`); a `string` sort is coerced. */
export function kvariable(name: string, sort?: string | KSort): KVariable {
  return Object.freeze({
    node: "KVariable" as const,
    name,
    sort: typeof sort === "string" ? ksort(sort) : sort,
  });
}

/** `KApply(label, args)` (`inner.py:370-390`); a `string` label is coerced. */
export function kapply(label: string | KLabel, args: readonly KInner[] = NO_TERMS): KApply {
  return Object.freeze({
    node: "KApply" as const,
    label: typeof label === "string" ? klabel(label) : label,
    args: args.length === 0 ? NO_TERMS : Object.freeze([...args]),
  });
}

/** `KAs(pattern, alias)` (`inner.py:445-448`). */
export function kas(pattern: KInner, alias: KInner): KAs {
  return Object.freeze({ node: "KAs" as const, pattern, alias });
}

/** `KRewrite(lhs, rhs)` (`inner.py:485-488`). */
export function krewrite(lhs: KInner, rhs: KInner): KRewrite {
  return Object.freeze({ node: "KRewrite" as const, lhs, rhs });
}

/**
 * `KSequence(items)` (`inner.py:587-611`), **splicing nested sequences**.
 *
 * One level of splicing suffices because no `KSequence` reachable here can
 * itself contain one — that is the invariant this function establishes and
 * every other construction path preserves.
 */
export function ksequence(items: readonly KInner[] = NO_TERMS): KSequence {
  const flat: KInner[] = [];
  for (const item of items) {
    if (item.node === "KSequence") {
      // Spread would be `push(...item.items)`, which passes each item as an
      // argument and blows the argument limit on a large sequence.
      for (const nested of item.items) flat.push(nested);
    } else {
      flat.push(item);
    }
  }
  return Object.freeze({ node: "KSequence" as const, items: flat.length === 0 ? NO_TERMS : Object.freeze(flat) });
}

//////////////////////
// `let` copies     //
//////////////////////

/**
 * The `let` family (`inner.py:49,115,273,334,415,459,509,637`).
 *
 * pyk spells "leave this field alone" as `None`, which is why it needed a
 * separate `KVariable.let_sort` (`inner.py:340-342`) to be able to *clear* a
 * sort.  Here the changes object is inspected with `Object.hasOwn`, so passing
 * `{sort: undefined}` clears and omitting `sort` keeps — one function, no wart.
 */
export interface KSortChanges {
  readonly name?: string;
  readonly params?: readonly KSort[];
}

export function letKSort(sort: KSort, changes: KSortChanges): KSort {
  return ksort(changes.name ?? sort.name, changes.params ?? sort.params);
}

export interface KLabelChanges {
  readonly name?: string;
  readonly params?: readonly (string | KSort)[];
}

export function letKLabel(label: KLabel, changes: KLabelChanges): KLabel {
  return klabel(changes.name ?? label.name, changes.params ?? label.params);
}

export interface KTokenChanges {
  readonly token?: string;
  readonly sort?: string | KSort;
}

export function letKToken(term: KToken, changes: KTokenChanges): KToken {
  return ktoken(changes.token ?? term.token, changes.sort ?? term.sort);
}

export interface KVariableChanges {
  readonly name?: string;
  /** Present-and-`undefined` clears the sort; absent keeps it. */
  readonly sort?: string | KSort | undefined;
}

export function letKVariable(term: KVariable, changes: KVariableChanges): KVariable {
  return kvariable(changes.name ?? term.name, Object.hasOwn(changes, "sort") ? changes.sort : term.sort);
}

export interface KApplyChanges {
  readonly label?: string | KLabel;
  readonly args?: readonly KInner[];
}

export function letKApply(term: KApply, changes: KApplyChanges): KApply {
  return kapply(changes.label ?? term.label, changes.args ?? term.args);
}

export interface KAsChanges {
  readonly pattern?: KInner;
  readonly alias?: KInner;
}

export function letKAs(term: KAs, changes: KAsChanges): KAs {
  return kas(changes.pattern ?? term.pattern, changes.alias ?? term.alias);
}

export interface KRewriteChanges {
  readonly lhs?: KInner;
  readonly rhs?: KInner;
}

export function letKRewrite(term: KRewrite, changes: KRewriteChanges): KRewrite {
  return krewrite(changes.lhs ?? term.lhs, changes.rhs ?? term.rhs);
}

export interface KSequenceChanges {
  readonly items?: readonly KInner[];
}

export function letKSequence(term: KSequence, changes: KSequenceChanges): KSequence {
  return ksequence(changes.items ?? term.items);
}

//////////////////////
// Structure        //
//////////////////////

/**
 * The children of a term (`inner.py:187-191`).
 *
 * Sort parameters and a `KApply`'s label are not children; see the header.
 */
export function terms(term: KInner): readonly KInner[] {
  switch (term.node) {
    case "KToken":
    case "KVariable":
      return NO_TERMS;
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

/**
 * Rebuild a term with new children (`inner.py:193-196`).
 *
 * Arity is checked rather than assumed: pyk gets the check for free from tuple
 * unpacking (`() = terms`, `lhs, rhs = terms`), which raises on a mismatch.
 * A `KSequence` rebuild re-flattens.
 */
export function letTerms(term: KInner, children: readonly KInner[]): KInner {
  switch (term.node) {
    case "KToken":
    case "KVariable":
      if (children.length > 0) {
        throw new TypeError(`${term.node} takes no children, got ${children.length}`);
      }
      return term;
    case "KApply":
      return kapply(term.label, children);
    case "KAs":
      if (children.length !== 2) throw new TypeError(`KAs takes 2 children, got ${children.length}`);
      return kas(at(children, 0), at(children, 1));
    case "KRewrite":
      if (children.length !== 2) throw new TypeError(`KRewrite takes 2 children, got ${children.length}`);
      return krewrite(at(children, 0), at(children, 1));
    case "KSequence":
      return ksequence(children);
    default:
      return exhausted(term);
  }
}

/** Apply `f` to every direct child (`inner.py:198-201`). */
export function mapInner(term: KInner, f: (child: KInner) => KInner): KInner {
  return letTerms(
    term,
    terms(term).map((child) => f(child)),
  );
}

//////////////////////
// Traversals       //
//////////////////////

/** One node's pending work: its children, and the rebuilt children so far. */
interface Frame {
  readonly term: KInner;
  readonly children: readonly KInner[];
  readonly done: KInner[];
}

function frame(term: KInner): Frame {
  return { term, children: terms(term), done: [] };
}

/**
 * Transform a term bottom-up (`inner.py:804-828`).
 *
 * `f` sees each node *after* its children have been transformed and the node
 * rebuilt around them.
 */
export function bottomUp(f: (term: KInner) => KInner, root: KInner): KInner {
  const stack: Frame[] = [frame(root)];
  for (;;) {
    const top = stack.pop();
    if (top === undefined) throw new RangeError("bottomUp: empty work stack");
    const next = top.children[top.done.length];
    if (next !== undefined) {
      stack.push(top, frame(next));
      continue;
    }
    const built = f(letTerms(top.term, top.done));
    const parent = stack.pop();
    if (parent === undefined) return built;
    parent.done.push(built);
    stack.push(parent);
  }
}

/**
 * Transform a term top-down (`inner.py:832-856`).
 *
 * `f` is applied to the root and then to each *original* child before that
 * child is descended into, so a rewrite that introduces new structure has that
 * structure visited too.
 */
export function topDown(f: (term: KInner) => KInner, root: KInner): KInner {
  const stack: Frame[] = [frame(f(root))];
  for (;;) {
    const top = stack.pop();
    if (top === undefined) throw new RangeError("topDown: empty work stack");
    const next = top.children[top.done.length];
    if (next !== undefined) {
      stack.push(top, frame(f(next)));
      continue;
    }
    const built = letTerms(top.term, top.done);
    const parent = stack.pop();
    if (parent === undefined) return built;
    parent.done.push(built);
    stack.push(parent);
  }
}

/** One node's pending work, plus the summaries its children produced. */
interface SummaryFrame<A> {
  readonly term: KInner;
  readonly children: readonly KInner[];
  readonly done: KInner[];
  readonly summaries: A[];
}

/**
 * Transform a term bottom-up while collecting a summary per node
 * (`inner.py:772-800`).
 *
 * `f` receives the rebuilt node and the summaries of its children, in child
 * order, and returns the new node plus this node's summary.
 */
export function bottomUpWithSummary<A>(
  f: (term: KInner, childSummaries: readonly A[]) => readonly [KInner, A],
  root: KInner,
): readonly [KInner, A] {
  const stack: SummaryFrame<A>[] = [{ term: root, children: terms(root), done: [], summaries: [] }];
  for (;;) {
    const top = stack.pop();
    if (top === undefined) throw new RangeError("bottomUpWithSummary: empty work stack");
    const next = top.children[top.done.length];
    if (next !== undefined) {
      stack.push(top, { term: next, children: terms(next), done: [], summaries: [] });
      continue;
    }
    const [built, summary] = f(letTerms(top.term, top.done), top.summaries);
    const parent = stack.pop();
    if (parent === undefined) return [built, summary];
    parent.done.push(built);
    parent.summaries.push(summary);
    stack.push(parent);
  }
}

/**
 * Visit every node top-down, left to right, for side effects
 * (`inner.py:898-909`).
 *
 * The callback cannot change the term; that is the whole point of it being
 * separate from {@link topDown}.
 */
export function collect(callback: (term: KInner) => void, root: KInner): void {
  const stack: KInner[] = [root];
  for (;;) {
    const term = stack.pop();
    if (term === undefined) return;
    const children = terms(term);
    // Pushed in reverse so the leftmost child is popped first.
    for (let i = children.length - 1; i >= 0; i--) stack.push(at(children, i));
    callback(term);
  }
}

/**
 * Every occurrence of every variable, keyed by name (`inner.py:860-879`).
 *
 * Insertion order is first-occurrence order, matching Python's dict.  pyk's
 * own TODO applies: `#Exists` / `#Forall` are not treated specially, so a
 * bound variable is reported like a free one.
 */
export function varOccurrences(term: KInner): Map<string, readonly KVariable[]> {
  const occurrences = new Map<string, KVariable[]>();
  collect((subterm) => {
    if (subterm.node !== "KVariable") return;
    const seen = occurrences.get(subterm.name);
    if (seen === undefined) occurrences.set(subterm.name, [subterm]);
    else seen.push(subterm);
  }, term);
  return occurrences;
}

/**
 * Collapse each variable's occurrences to one, keeping the sort only when
 * every sorted occurrence agrees (`inner.py:882-895`).
 *
 * Occurrences with no sort are ignored; two *different* sorts drop the sort
 * entirely rather than picking one.
 */
export function keepVarsSorted(occurrences: ReadonlyMap<string, readonly KVariable[]>): Map<string, KVariable> {
  const out = new Map<string, KVariable>();
  for (const [name, vars] of occurrences) {
    let sort: KSort | undefined;
    for (const v of vars) {
      if (v.sort === undefined) continue;
      if (sort === undefined) {
        sort = v.sort;
      } else if (!eqSort(sort, v.sort)) {
        sort = undefined;
        break;
      }
    }
    out.set(name, kvariable(name, sort));
  }
  return out;
}

//////////////////////
// Substitutions    //
//////////////////////

/** What {@link Subst} accepts: an entry iterable (a `Map` included) or a record. */
export type SubstLike = Iterable<readonly [string, KInner]> | Readonly<Record<string, KInner>>;

function substEntries(subst: SubstLike): Iterable<readonly [string, KInner]> {
  return Symbol.iterator in subst ? subst : Object.entries(subst);
}

/**
 * A binding of variable names to terms (`inner.py:665-769`).
 *
 * # `apply` is naive, on purpose
 *
 * It replaces every `KVariable` whose name is bound, wherever it appears, with
 * no capture avoidance and no binder handling.  pyk carries its own TODO about
 * this (`inner.py:871`, on `var_occurrences`: "should treat `#Exists` and
 * `#Forall` specially"), and `Subst.apply` (`inner.py:723-731`) has the same
 * hole.  Fidelity to pyk beats a local fix that would make substitution
 * results differ between the two implementations.
 */
export class Subst {
  readonly #subst: ReadonlyMap<string, KInner>;

  constructor(subst: SubstLike = {}) {
    this.#subst = new Map(substEntries(subst));
  }

  /** Number of bindings (`inner.py:679-681`). */
  get size(): number {
    return this.#subst.size;
  }

  /** The term bound to `name`, or `undefined` (`inner.py:683-685`). */
  get(name: string): KInner | undefined {
    return this.#subst.get(name);
  }

  has(name: string): boolean {
    return this.#subst.has(name);
  }

  keys(): IterableIterator<string> {
    return this.#subst.keys();
  }

  entries(): IterableIterator<readonly [string, KInner]> {
    return this.#subst.entries();
  }

  [Symbol.iterator](): IterableIterator<readonly [string, KInner]> {
    return this.#subst.entries();
  }

  /** The bindings as a plain object, in insertion order. */
  toRecord(): Record<string, KInner> {
    return Object.fromEntries(this.#subst);
  }

  /** Drop identity bindings — `x |-> x` (`inner.py:704-706`). */
  minimize(): Subst {
    const out = new Map<string, KInner>();
    for (const [name, value] of this.#subst) {
      if (value.node === "KVariable" && value.name === name) continue;
      out.set(name, value);
    }
    return new Subst(out);
  }

  /** True when {@link minimize} is empty (`inner.py:767-769`). */
  get isIdentity(): boolean {
    return this.minimize().size === 0;
  }

  /**
   * `self ∘ other` (`inner.py:708-712`): `other`'s values are instantiated by
   * `self`, then `self`'s own bindings for names `other` does not mention are
   * appended.  Key order is `other`'s first, as in pyk.
   */
  compose(other: Subst): Subst {
    const out = new Map<string, KInner>();
    for (const [name, value] of other) out.set(name, this.apply(value));
    for (const [name, value] of this.#subst) {
      if (!other.has(name)) out.set(name, value);
    }
    return new Subst(out);
  }

  /** Merge, or `null` on a conflicting binding (`inner.py:714-721`). */
  union(other: Subst): Subst | null {
    const out = new Map(this.#subst);
    for (const [name, value] of other) {
      const existing = out.get(name);
      if (existing !== undefined && !eq(existing, value)) return null;
      out.set(name, value);
    }
    return new Subst(out);
  }

  /** Replace free variable occurrences with their valuations (`inner.py:723-731`). */
  apply(term: KInner): KInner {
    return bottomUp((subterm) => {
      if (subterm.node !== "KVariable") return subterm;
      return this.#subst.get(subterm.name) ?? subterm;
    }, term);
  }

  /**
   * Replace occurrences of this substitution's *values* with the variables they
   * are bound to (`inner.py:733-740`).
   *
   * One `KRewrite` replacement pass per binding, in insertion order; a later
   * binding therefore sees the result of the earlier ones.
   */
  unapply(term: KInner): KInner {
    let result = term;
    for (const [name, value] of this.#subst) {
      result = rewriteReplace(krewrite(value, kvariable(name)), result);
    }
    return result;
  }

  /**
   * Extract a substitution from a matching-logic predicate (`inner.py:742-752`).
   *
   * Written against the raw label strings `#And` and `#Equals` exactly as pyk
   * does, so this module stays prelude-free.  Throws on any conjunct that is
   * not `#Equals(var, term)` — pyk raises `ValueError` there.
   */
  static fromPred(pred: KInner): Subst {
    const out = new Map<string, KInner>();
    for (const conjunct of flattenLabel("#And", pred)) {
      const variable = conjunct.node === "KApply" ? conjunct.args[0] : undefined;
      if (
        conjunct.node !== "KApply" ||
        conjunct.label.name !== "#Equals" ||
        conjunct.args.length !== 2 ||
        variable === undefined ||
        variable.node !== "KVariable"
      ) {
        throw new TypeError(`Invalid substitution predicate: a ${conjunct.node} that is not #Equals(var, term)`);
      }
      out.set(variable.name, at(conjunct.args, 1));
    }
    return new Subst(out);
  }

  /**
   * This substitution as a boolean predicate over `_==K_` (`inner.py:754-765`).
   *
   * Identity bindings are dropped, an empty substitution becomes
   * `true:Bool`, and the conjuncts are joined by a **left**-nested
   * `_andBool_` — Python's `reduce` with no initializer.  Raw label strings
   * again, for the same prelude-free reason as {@link Subst.fromPred}.
   */
  get pred(): KInner {
    const conjuncts: KInner[] = [];
    for (const [name, value] of this.#subst) {
      if (value.node === "KVariable" && value.name === name) continue;
      conjuncts.push(kapply("_==K_", [kvariable(name), value]));
    }
    if (conjuncts.length === 0) return ktoken("true", "Bool");
    let result = at(conjuncts, 0);
    for (let i = 1; i < conjuncts.length; i++) result = kapply("_andBool_", [result, at(conjuncts, i)]);
    return result;
  }
}

//////////////////////
// Matching         //
//////////////////////

/** One pattern/term pair still to be matched. */
interface MatchTask {
  readonly pattern: KInner;
  readonly term: KInner;
}

/**
 * Syntactic pattern matching (`inner.py:204-213` and the per-class `match`
 * methods), returning the substitution that instantiates `pattern` to `term`.
 *
 * The four quirks that make this pyk's `match` and not a generic one:
 *
 * - **`KVariable` always succeeds and ignores sort** (`inner.py:352-353`): an
 *   `Int`-sorted pattern variable happily binds a `String` token.
 * - **`KToken` compares token text only, not sort** (`inner.py:287-291`).
 * - **`KApply` compares `label.name` and arity, but not `label.params`**
 *   (`inner.py:428-434`): `inj{A,B}(x)` matches `inj{C,D}(x)`.
 * - **`KSequence` binds a trailing pattern variable to the remaining tail**
 *   (`inner.py:649-662`), when the pattern is strictly shorter than the term
 *   and its last item is a variable.  The tail is wrapped in a `KSequence`,
 *   which then splices when substituted back into a sequence.
 *
 * A `KAs` in **pattern** position throws (`inner.py:473-474`); a `KAs` in term
 * position is matched like any other node.
 *
 * Failure does not short-circuit the way an implementation would naturally
 * write it, because pyk's does not either: `_combine_matches`
 * (`inner.py:215-224`) runs `reduce` over a generator, so every sibling
 * sub-match is evaluated even after one has failed.  That is observable
 * exactly once — a `KAs` in a sibling of a failed branch still throws — and it
 * is transcribed rather than optimised away.
 */
export function match(pattern: KInner, term: KInner): Subst | null {
  const bindings = new Map<string, KInner>();
  const stack: MatchTask[] = [{ pattern, term }];
  let failed = false;

  const push = (patterns: readonly KInner[], terms_: readonly KInner[]): void => {
    for (let i = patterns.length - 1; i >= 0; i--) {
      stack.push({ pattern: at(patterns, i), term: at(terms_, i) });
    }
  };

  for (;;) {
    const task = stack.pop();
    if (task === undefined) return failed ? null : new Subst(bindings);
    const p = task.pattern;
    const t = task.term;

    switch (p.node) {
      case "KAs":
        throw new TypeError("KAs does not support pattern matching");
      case "KVariable": {
        const bound = bindings.get(p.name);
        if (bound !== undefined && !eq(bound, t)) failed = true;
        else bindings.set(p.name, t);
        break;
      }
      case "KToken":
        if (t.node !== "KToken" || t.token !== p.token) failed = true;
        break;
      case "KApply":
        if (t.node === "KApply" && t.label.name === p.label.name && t.args.length === p.args.length) {
          push(p.args, t.args);
        } else {
          failed = true;
        }
        break;
      case "KRewrite":
        if (t.node === "KRewrite") push([p.lhs, p.rhs], [t.lhs, t.rhs]);
        else failed = true;
        break;
      case "KSequence": {
        if (t.node !== "KSequence") {
          failed = true;
          break;
        }
        if (p.items.length === t.items.length) {
          push(p.items, t.items);
          break;
        }
        const last = p.items.at(-1);
        if (
          p.items.length === 0 ||
          p.items.length >= t.items.length ||
          last === undefined ||
          last.node !== "KVariable"
        ) {
          failed = true;
          break;
        }
        const common = p.items.length - 1;
        // The tail binding is recorded before the prefix pairs so that key
        // order matches pyk, which seeds `_subst` with it (`inner.py:657`).
        const tail = ksequence(t.items.slice(common));
        const bound = bindings.get(last.name);
        if (bound !== undefined && !eq(bound, tail)) failed = true;
        else bindings.set(last.name, tail);
        push(p.items.slice(0, common), t.items.slice(0, common));
        break;
      }
    }
  }
}

//////////////////////
// Rewrite terms    //
//////////////////////

/**
 * Rewrite once at the top, if the LHS matches (`inner.py:538-550`).
 *
 * On no match the term is returned unchanged — a `KRewrite` is a term, so
 * "did not apply" is not an error.
 */
export function rewriteApplyTop(rewrite: KRewrite, term: KInner): KInner {
  const subst = match(rewrite.lhs, term);
  return subst === null ? term : subst.apply(rewrite.rhs);
}

/**
 * Rewrite at every position, **once each, in one bottom-up pass**
 * (`inner.py:552-561`).
 *
 * There is no fixpoint: a rewrite whose RHS matches its own LHS is not
 * re-applied to its own output, and a caller that wants saturation loops
 * itself.
 */
export function rewriteApply(rewrite: KRewrite, term: KInner): KInner {
  return bottomUp((subterm) => rewriteApplyTop(rewrite, subterm), term);
}

/** {@link rewriteApplyTop} with structural equality instead of matching (`inner.py:563-567`). */
export function rewriteReplaceTop(rewrite: KRewrite, term: KInner): KInner {
  return eq(rewrite.lhs, term) ? rewrite.rhs : term;
}

/** {@link rewriteApply} with structural equality instead of matching (`inner.py:569-571`). */
export function rewriteReplace(rewrite: KRewrite, term: KInner): KInner {
  return bottomUp((subterm) => rewriteReplaceTop(rewrite, subterm), term);
}

//////////////////////
// List builders    //
//////////////////////

/**
 * Join terms with an associative label, right-nested (`inner.py:912-932`).
 *
 * Terms structurally equal to `unit` are skipped wherever they appear, and an
 * all-unit (or empty) input yields `unit` itself.
 *
 * **Deliberate divergence: the accumulator is tested against `null`, not for
 * truthiness.**  pyk writes `if not res` and `return res or unit`, and
 * `KSequence` defines `__len__`, so `KSequence([])` — the empty K sequence,
 * `.K` — is **falsy** in Python.  pyk therefore discards an empty-sequence
 * operand wherever one appears, and returns the `unit` when it is the only
 * operand: `build_assoc(mlBottom(K), '#Or', [X, KSequence([])])` is `X`, and
 * `build_assoc(mlTop(S), '#And', [KSequence([])])` is `#Top{S}`.  `.K` is an
 * ordinary term, not an absence, so the truthiness test is a bug rather than a
 * decision; this tests `=== null`, which is what the code means, and keeps the
 * empty sequence.  `@kframework-ts/konvert`'s README documents the two places
 * the difference is observable in KAST ⇄ KORE conversion.
 */
export function buildAssoc(unit: KInner, label: string | KLabel, items: readonly KInner[]): KInner {
  const joiner = typeof label === "string" ? klabel(label) : label;
  let result: KInner | null = null;
  for (let i = items.length - 1; i >= 0; i--) {
    const item = at(items, i);
    if (eq(item, unit)) continue;
    result = result === null ? item : kapply(joiner, [item, result]);
  }
  return result ?? unit;
}

/**
 * Join terms into a cons list terminated by `unit` (`inner.py:935-951`).
 *
 * Unlike {@link buildAssoc} this keeps unit-valued items and always emits the
 * terminator, so `[]` yields `unit` and `[x]` yields `label(x, unit)`.
 *
 * pyk's version is the one recursive function in `inner.py`; this is the same
 * function written as a right fold, which is what the recursion computes.
 */
export function buildCons(unit: KInner, label: string | KLabel, items: readonly KInner[]): KInner {
  const joiner = typeof label === "string" ? klabel(label) : label;
  let result: KInner = unit;
  for (let i = items.length - 1; i >= 0; i--) result = kapply(joiner, [at(items, i), result]);
  return result;
}

/**
 * Flatten a cons list built from `label` into its elements (`inner.py:954-972`).
 *
 * Matching is on `label.name` alone, and flattening is recursive through every
 * `KApply` carrying that label at any arity — `f(x, f(y, z))` and `f(x, y, z)`
 * both flatten to `[x, y, z]`.  A term that is not such an application is
 * returned as the single element, *except* that an application of `label` with
 * no arguments flattens to the empty list.
 */
export function flattenLabel(label: string, term: KInner): readonly KInner[] {
  const flattened: KInner[] = [];
  const rest: KInner[] = [term];
  for (;;) {
    const current = rest.pop();
    if (current === undefined) return flattened;
    if (current.node === "KApply" && current.label.name === label) {
      for (let i = current.args.length - 1; i >= 0; i--) rest.push(at(current.args, i));
    } else {
      flattened.push(current);
    }
  }
}
