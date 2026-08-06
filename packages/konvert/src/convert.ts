/**
 * The **definition tier**: `kastToKore` and `koreToKast`, the two functions a
 * kore-rpc client actually calls.
 *
 * Transcribed from pyk `konvert/_kast_to_kore.py:79-220` and
 * `konvert/_kore_to_kast.py:42-44` at K v7.1.337.
 *
 * # The asymmetry is the design
 *
 * `koreToKast` is `koreToKastPure` plus one definition-driven pass
 * (`removeCellMapItems`), because KORE is self-describing.  `kastToKore` is a
 * six-stage pipeline, because KAST is not: a KAST term carries no sorts on its
 * variables, no injections between subsorts, and spells a K sequence as a
 * first-class node rather than as the `kseq`/`append`/`dotk` cons chain
 * `prelude.kore` declares.  Everything `kastToKore` does before the pure fold
 * is filling those three gaps in.
 *
 * **None of it reads a `*-kompiled/` directory or a `definition.kore`.**  A
 * `KDefinition` — in practice parsed from `compiled.json` — is the whole input.
 *
 * # Injections are inserted on the KAST side
 *
 * That is worth stating because there is a second, parallel implementation of
 * the same idea over KORE patterns in pyk (`kore/kompiled.py:add_injections`),
 * and **nothing in pyk calls it**.  `AddSortInjections.java` likewise runs
 * before `ModuleToKORE.convert` (`KPrint.java:159-171`), on K terms.
 */

import {
  Atts,
  type KDefinition,
  type KInner,
  type KSort,
  kapply,
  klabel,
  letTerms,
  sortKey,
  terms,
  topDown,
} from "@kframework-ts/kast";
import { inj, K, K_ITEM } from "@kframework-ts/kast/prelude/k";
import type { Pattern } from "@kframework-ts/kore";

import { frozenMap } from "./frozen.js";
import { kastToKorePure, koreToKastPure, type SortHooks } from "./pure.js";

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

/**
 * The definition's sort → `hook` map, for {@link SortHooks}.
 *
 * Java reads exactly this to decide whether a token is a `String` or a `Bytes`
 * (`ModuleToKORE.java:2258-2272`, `module.sortAttributesFor()`); pyk instead
 * compares sort *names* against the literals `String`/`Bytes`, which is wrong
 * for any definition that hooks `STRING.String` onto a sort of another name.
 * See `pure.ts`'s {@link SortHooks}.
 *
 * Built from `syntax sort` sentences across the whole definition, last one
 * winning, which is how `sortAttributesFor` resolves a sort declared in more
 * than one module.
 *
 * **Memoised per `KDefinition`.**  Computing it is a full module × sentence
 * walk — on a 700 KB `compiled.json` it costs more than the conversion it
 * serves, and both {@link kastToKore} and {@link koreToKast} want it on *every*
 * call, which `kruleToKore` then multiplies by the number of constraints in a
 * rule and `kflatmoduleToKore` by the number of rules in a module.  A
 * `KDefinition` is deeply frozen, so the cached map can never go stale; the
 * cache is a `WeakMap` so that holding it does not keep a definition alive.
 *
 * Because the result is now *shared* rather than freshly built per call, it is
 * frozen on the way out — a caller that mutated the returned map would
 * otherwise be rewriting every later conversion against that definition.
 */
const SORT_HOOKS_CACHE = new WeakMap<KDefinition, SortHooks>();

export function sortHooks(definition: KDefinition): SortHooks {
  const cached = SORT_HOOKS_CACHE.get(definition);
  if (cached !== undefined) return cached;

  const hooks = new Map<string, string>();
  for (const module of definition.modules) {
    for (const sentence of module.sentences) {
      if (sentence.node !== "KSyntaxSort") continue;
      const hook = sentence.att.get(Atts.HOOK);
      if (typeof hook === "string") hooks.set(sentence.sort.name, hook);
    }
  }

  const frozen = frozenMap(hooks);
  SORT_HOOKS_CACHE.set(definition, frozen);
  return frozen;
}

/**
 * `KSequence` → the `kseq`/`append`/`dotk` cons chain — pyk
 * `_replace_ksequence_by_kapply` (`_kast_to_kore.py:91-121`).
 *
 * Each cons step picks `append(x, y)` when `x` is already a whole sequence
 * (`sortStrict(x) === K`) and `kseq(x, y)` otherwise.  The trap the two symbols
 * set is written down normatively in `prelude.kore` and nowhere else:
 *
 * ```kore
 * symbol kseq{}(SortKItem{}, SortK{}) : SortK{}
 * symbol append{}(SortK{}, SortK{})   : SortK{}
 * ```
 *
 * — `kseq` takes an **item** and a sequence, `append` takes two sequences, and
 * `_argumentSorts` below has to answer differently for the two.
 *
 * An empty sequence is `dotk`; a sequence whose **last** item already has sort
 * `K` uses that item as the tail unit instead of `dotk`, which is what makes
 * `KSequence(X:K)` convert to the bare `VarX:SortK{}` rather than to a
 * one-element chain.
 *
 * Java reaches the identical result in two stages rather than one — the
 * `K`-vs-`KItem` decision in `AddSortInjections.java:255-266` and the cons
 * chain in `ModuleToKORE.java:2280-2309` — i.e. it stages the encoding *after*
 * injection where pyk stages it before.  The output is the same either way.
 */
/**
 * Is this the sort `K`?
 *
 * Compared by `sortKey` — structurally, parameters included — as pyk's frozen
 * `KSort` dataclass comparison is. `K` is parameterless, so nothing a
 * `kompile`d definition contains distinguishes this from a `.name` test; the
 * `.name` test would also accept a hypothetical `K{Int}`, which is not `K`.
 */
const K_SORT_KEY = sortKey(K);

function isKSort(sort: KSort): boolean {
  return sortKey(sort) === K_SORT_KEY;
}

export function replaceKsequenceByKapply(definition: KDefinition, term: KInner): KInner {
  const dotk = kapply("dotk");
  const kseq = klabel("kseq");
  const append = klabel("append");

  const cons = (x: KInner, y: KInner): KInner => kapply(isKSort(definition.sortStrict(x)) ? append : kseq, [x, y]);

  return topDown((current) => {
    if (current.node !== "KSequence") return current;
    const { items } = current;
    if (items.length === 0) return dotk;

    const last = at(items, items.length - 1);
    const takesLastAsUnit = isKSort(definition.sortStrict(last));
    const unit: KInner = takesLastAsUnit ? last : dotk;
    const args = takesLastAsUnit ? items.slice(0, -1) : items;

    return args.reduceRight<KInner>((acc, item) => cons(item, acc), unit);
  }, term);
}

/**
 * The direct subterms sort inference should descend into — pyk
 * `_argument_terms` (`_kast_to_kore.py:163-169`).
 *
 * **Quantifier special case, 1 of 3.**  `#Exists`/`#Forall` bind their first
 * argument, which is a binding occurrence and not a subterm to be injected;
 * only the body is descended into.  {@link letArguments} puts the variable
 * back.
 */
function argumentTerms(term: KInner): readonly KInner[] {
  if (term.node === "KApply" && (term.label.name === "#Exists" || term.label.name === "#Forall")) {
    return [at(term.args, 1)];
  }
  return terms(term);
}

/**
 * The sorts those subterms must be injected to — pyk `_argument_sorts`
 * (`_kast_to_kore.py:172-194`).
 *
 * **Quantifier special case, 2 of 3.**  `#Exists{S1, S2}` resolves to two
 * argument sorts (the bound variable's and the body's); only the second one is
 * wanted, because only the body is in {@link argumentTerms}.
 *
 * The three pseudo-labels answer from `prelude.kore`'s signatures rather than
 * from a production, since they have none: `kseq` is `(KItem, K)`, `append` is
 * `(K, K)`, `dotk` is nullary.
 */
function argumentSorts(definition: KDefinition, term: KInner): readonly KSort[] {
  switch (term.node) {
    case "KToken":
    case "KVariable":
      return [];
    case "KSequence":
      return term.items.map(() => K_ITEM);
    case "KApply":
      switch (term.label.name) {
        case "kseq":
          return [K_ITEM, K];
        case "dotk":
          return [];
        case "append":
          return [K, K];
        case "#Forall":
        case "#Exists": {
          const [, sorts] = definition.resolveSorts(term.label);
          return [at(sorts, 1)];
        }
        default: {
          const [, sorts] = definition.resolveSorts(term.label);
          return sorts;
        }
      }
    default:
      throw new TypeError(`Unsupported term: ${term.node}`);
  }
}

/**
 * Rebuild a term from its injected subterms — pyk `_let_arguments`
 * (`_kast_to_kore.py:197-203`).
 *
 * **Quantifier special case, 3 of 3**: the bound variable, dropped by
 * {@link argumentTerms}, is prepended again.
 */
function letArguments(term: KInner, args: readonly KInner[]): KInner {
  if (term.node === "KApply" && (term.label.name === "#Exists" || term.label.name === "#Forall")) {
    return letTerms(term, [at(term.args, 0), ...args]);
  }
  return letTerms(term, args);
}

/**
 * Wrap `term` in `inj{actual, expected}` if it needs one — pyk `_inject`
 * (`_kast_to_kore.py:206-220`).
 *
 * The three pseudo-labels are all at sort `K` by construction and have no
 * production to resolve, so they short-circuit.
 *
 * @throws {TypeError} `Sort X is not a subsort of Y` when the injection is not
 *   legal. **The `Sort X is not a subsort of Y` prefix is part of the
 *   contract** — it is precisely the exception `KPrint.kast_to_kore` catches to
 *   fall back to shelling out to the `kast` CLI (`ktool/kprint.py:262-289`), so
 *   any consumer wiring up the same fallback matches on it, and it must stay at
 *   the front of the message. What follows the colon is diagnostic only:
 *   {@link describeTerm}'s rendering of the offending term, since pyk
 *   interpolates the term itself (`_kast_to_kore.py:219`) and a message naming
 *   only two sorts is unactionable in a configuration with thousands of
 *   subterms.
 *
 *   Java has **no subsort check at all** here
 *   (`AddSortInjections.internalAddSortInjections:123-203`): it emits
 *   `inj{actual, expected}` unconditionally and lets the backend's validator
 *   complain later. So a term that trips this guard is one Java would happily
 *   convert into possibly-invalid KORE. The guard is kept anyway, following
 *   pyk — it is what makes the failure legible, and it is what the fallback
 *   contract is built on.
 */
function injectTo(definition: KDefinition, term: KInner, sort: KSort): KInner {
  const isPseudo =
    term.node === "KApply" &&
    (term.label.name === "kseq" || term.label.name === "dotk" || term.label.name === "append");
  const actual = isPseudo ? K : definition.sortStrict(term);

  // Structural sort equality (parameters included), as pyk's frozen-dataclass
  // `==` is, rather than a `.name` test that would conflate `Map{Int, K}` with
  // `Map{K, Int}`. `kompile` output never puts a parametric sort in a term
  // position, so this changes no outcome; it is simply what the comparison
  // means.
  const actualKey = sortKey(actual);
  if (actualKey === sortKey(sort)) return term;
  if (definition.subsorts(sort).some((sub) => sortKey(sub) === actualKey)) {
    return inj(actual, sort, term);
  }
  throw new TypeError(`Sort ${actual.name} is not a subsort of ${sort.name}: ${describeTerm(term)}`);
}

/**
 * A one-line rendering of a term for an error message: its node kind, and just
 * enough of its top level to identify *which* subterm of a configuration is
 * meant.
 *
 * Deliberately not the pretty-printer and deliberately not recursive — the term
 * that trips {@link injectTo} may be a whole configuration, and an error message
 * is not the place to unparse one. pyk interpolates the term's `repr`
 * (`_kast_to_kore.py:219`), which for a real configuration is unreadable; this
 * is the identifying part of that.
 */
function describeTerm(term: KInner): string {
  switch (term.node) {
    case "KApply":
      return `KApply(${term.label.name}, ${term.args.length} args)`;
    case "KVariable":
      return `KVariable(${term.name})`;
    case "KToken":
      return `KToken(${term.token}, ${term.sort.name})`;
    case "KSequence":
      return `KSequence(${term.items.length} items)`;
    default:
      return term.node;
  }
}

/**
 * Insert sort injections bottom-up — pyk `_add_sort_injections`
 * (`_kast_to_kore.py:124-160`).
 *
 * pyk's is an explicit 5-slot stack machine (`term`, `sort`, `argument_terms`,
 * `argument_sorts`, `done_terms`), written that way to survive CPython's
 * recursion limit; the same five slots are a frame object here, and the same
 * reason applies — a real configuration nests deeper than a JS engine's default
 * stack.
 */
export function addSortInjections(definition: KDefinition, term: KInner, sort: KSort): KInner {
  interface Frame {
    readonly term: KInner;
    readonly sort: KSort;
    readonly argumentTerms: readonly KInner[];
    readonly argumentSorts: readonly KSort[];
    readonly doneTerms: KInner[];
  }

  const frameFor = (t: KInner, s: KSort): Frame => ({
    term: t,
    sort: s,
    argumentTerms: argumentTerms(t),
    argumentSorts: argumentSorts(definition, t),
    doneTerms: [],
  });

  const stack: Frame[] = [frameFor(term, sort)];

  for (;;) {
    const frame = top(stack);
    if (frame.doneTerms.length === frame.argumentTerms.length) {
      stack.pop();
      const injected = injectTo(definition, letArguments(frame.term, frame.doneTerms), frame.sort);
      if (stack.length === 0) return injected;
      top(stack).doneTerms.push(injected);
    } else {
      const index = frame.doneTerms.length;
      const child = at(frame.argumentTerms, index);
      const childSort = frame.argumentSorts[index];
      if (childSort === undefined) {
        throw new TypeError(`No argument sort at index ${index} of ${frame.term.node}`);
      }
      stack.push(frameFor(child, childSort));
    }
  }
}

/** Options for {@link kastToKore}. */
export interface KastToKoreOptions {
  /** The sort the whole term must be injected to. Defaults to `K`, as pyk's does. */
  readonly sort?: KSort;
}

/**
 * KAST → KORE — pyk `kast_to_kore` (`_kast_to_kore.py:79-88`).
 *
 * Six stages, in this order and no other:
 *
 * 1. `addKsequenceUnderKProductions` — an argument in a position the production
 *    declares as `K`, but whose own sort is not `K`, becomes a one-element
 *    `KSequence`. `Int` cannot inject straight into `K`.
 * 2. `sortVars(·, sort)` — every `KVariable` acquires a sort, inferred from
 *    every position it occurs in.
 * 3. `addCellMapItems` — the cell-collection encoding, the forward counterpart
 *    of `removeCellMapItems`. (Java's is `AddSortInjections.wrapElement`,
 *    `:141-197`, which is where `cellMapItemInfo` being a `kastToKore`
 *    dependency comes from.)
 * 4. `addSortParams` — a parametric label with no explicit parameters gets them
 *    from its argument sorts. This, not a hardcoded `ite` case, is what makes
 *    `KLabel('ite', [])` convert.
 * 5. {@link replaceKsequenceByKapply} — sequences become cons chains.
 * 6. {@link addSortInjections} — then the pure fold.
 *
 * The token hook map comes from the definition (see {@link sortHooks}), which
 * is the one place `kastToKore` is *more* faithful to Java than pyk is.
 */
export function kastToKore(definition: KDefinition, kast: KInner, options: KastToKoreOptions = {}): Pattern {
  const sort = options.sort ?? K;
  let term = definition.addKsequenceUnderKProductions(kast);
  term = definition.sortVars(term, sort);
  term = definition.addCellMapItems(term);
  term = definition.addSortParams(term);
  term = replaceKsequenceByKapply(definition, term);
  term = addSortInjections(definition, term, sort);
  return kastToKorePure(term, { hooks: sortHooks(definition) });
}

/**
 * KORE → KAST — pyk `kore_to_kast` (`_kore_to_kast.py:42-44`).
 *
 * The pure fold, then `removeCellMapItems`. That is the whole of the
 * definition's involvement in this direction, bar the hook map that decides
 * which sorts are `String` and `Bytes`.
 */
export function koreToKast(definition: KDefinition, kore: Pattern): KInner {
  return definition.removeCellMapItems(koreToKastPure(kore, { hooks: sortHooks(definition) }));
}
