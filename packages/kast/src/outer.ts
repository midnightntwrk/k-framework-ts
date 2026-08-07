/**
 * K's **outer** syntax — modules, sentences, productions and `KDefinition` — a
 * hand-transcription of `pyk/kast/outer.py` (1,679 L) at K **v7.1.337**.
 *
 * # Two tiers, on purpose
 *
 * **The data model is complete.**  Every `KOuter` node upstream declares is
 * here, with a strict `fromDict`/`toDict` pair that names the JSON path of
 * whatever went wrong, so a `compiled.json` reads in and writes back out
 * unchanged.  Nothing is dropped, nothing is normalised.
 *
 * **The `KDefinition` behaviour tier is now almost complete too.**  Upstream
 * carries ~40 cached indices, most of which exist for `konvert` and the sort
 * inference it needs; all but the two listed below are here:
 *
 * | implemented | why |
 * | ----------- | --- |
 * | `mainModule`, `mainModuleName`, `allModules`, `module(name)` | the entry points |
 * | `allModuleNames`, `moduleNames`, `modules` | the import closure everything else is defined over |
 * | `productions`, `syntaxProductions` | `symbols`; pretty's symbol table |
 * | `rules`, `aliasRules`, `macroRules`, `semanticRules` | macro expansion; `undoAliases` |
 * | `symbols`, `syntaxSymbols` | the label → production index almost everything reaches for |
 * | `functions`, `functionLabels`, `constructors` | `kruleToKore`'s axiom-shape branch |
 * | `sentenceByUniqueId` | the join partner for `allRules.txt` |
 * | `cellCollectionProductions`, `cellMapItemInfo` | `addCellMapItems` |
 * | `addCellMapItems`, `removeCellMapItems` | v7.1.337 regression, `test_definition.py` |
 * | `productionForCellSort`, `emptyConfig`, `instantiateCellVars`, `initConfig` | configuration construction |
 * | `subsortTable`, `subsorts`, `isSubsort` | the sort lattice — {@link computeImage} |
 * | `sortOf`, `sortStrict`, `resolveSorts`, `leastCommonSupersort`, `greatestCommonSubsort` | sort inference |
 * | `sortVars`, `addSortParams`, `addKsequenceUnderKProductions` | `kastToKore`'s pre-passes |
 * | `brackets`, `overloads`, `priorities`, `leftAssocs`, `rightAssocs` | `formatter.ts`; `moduleToKore` |
 * | `hash` | `ktool/kprint.py:238-240` |
 *
 * Still deferred, and why:
 *
 * - `expandMacros` — not a transcription: pyk does not implement it either
 *   ({@link macroRules} has no consumer upstream, `ktool/krun.py:414-415`
 *   shells out to the K binary).  Writing it means working from
 *   `ExpandMacros.java` against a test corpus that does not exist yet.
 * - `KDefinition.sentences` — asked for by the original task list, but it does
 *   **not** exist upstream at v7.1.337 and is not invented here.  Sentences
 *   live on the module: `definition.module(name).sentences`, or
 *   `definition.modules.flatMap(m => m.sentences)`.
 *
 * `KFlatModule`'s indices are free functions over the frozen interface rather
 * than members — {@link moduleProductions}, {@link moduleSyntaxProductions},
 * {@link moduleRules}, {@link moduleCellCollectionProductions},
 * {@link moduleFunctions}, {@link moduleConstructors},
 * {@link moduleSyntaxSorts}, {@link moduleClaims},
 * {@link moduleSentenceByUniqueId} and {@link moduleMapSentences} — and are
 * recomputed per call, where upstream's are `cached_property`.  A module is
 * small and the definition-level getters that fold over them are the ones that
 * cache.
 *
 * # Shape: frozen data, one class
 *
 * Production items, sentences, `KImport`, `KRequire`, `KFlatModule` and
 * `KFlatModuleList` are frozen `readonly` interfaces discriminated on `node`,
 * with lowercase factory functions and `let*` copiers — the `inner.ts` style,
 * because that is all they are.  {@link KDefinition} is a **class**, for the
 * same reason {@link KAtt} is one: it validates on construction and it caches,
 * and a getter that memoises into a private field is the honest spelling of
 * `@cached_property`.  Its caches are per-instance and every `let*` returns a
 * fresh instance, so a stale index is not reachable.
 *
 * # Attributes
 *
 * Every sentence, every module and the definition carry a {@link KAtt} and
 * satisfy {@link WithKAtt}; `att.ts`'s `mapAtt` / `updateAtts` work on all of
 * them via the matching `let*` copier ({@link letSentenceAtt} does the
 * dispatch for a `KSentence` whose kind you do not know).
 *
 * # Recursion
 *
 * Module and sentence lists are shallow — a definition is a list of modules of
 * a list of sentences, three levels, never more — so the decoder walks them
 * with ordinary loops.  The **terms** inside rules, claims and contexts are
 * unbounded, and those go through `json.ts`'s existing stack-based
 * {@link fromDict} / {@link toDict}: term decoding is not duplicated here.
 *
 * # Transcription notes (deliberate deviations)
 *
 * - **`KSyntaxLexical.toDict` emits the node name `"KSyntaxLexcial"`.**  That
 *   is upstream's typo (`outer.py:467`), faithfully kept: a `KSyntaxLexical`
 *   does not round-trip through pyk, and it must not round-trip here either,
 *   or the two libraries would disagree about a byte of `compiled.json`.
 *   {@link sentenceFromDict} accepts only the correctly-spelled node, exactly
 *   as `KSentence._NODES` does.
 * - **`frozenset` becomes `ReadonlySet`, and set order becomes insertion
 *   order.**  `KSyntaxAssociativity.tags` and `KSyntaxPriority.priorities`
 *   serialise as JSON arrays built from Python `frozenset`s, whose iteration
 *   order is unspecified.  Ours is deterministic (insertion), which means a
 *   byte-comparison of those two nodes against pyk is meaningless in either
 *   direction; compare them as sets.  Nothing else in the format is affected.
 * - **`let` can clear `klabel`.**  `outer.py:267` carries a TODO about being
 *   unable to set `klabel` back to `None`; the `Object.hasOwn` convention
 *   `inner.ts` already uses makes that a non-problem.
 * - **`KRule.requires` defaults to the prelude's `TRUE`.**  The `_BOOL` /
 *   `_TRUE` duplicates at `outer.py:47-48` exist only to break a Python import
 *   cycle; we import `prelude/kbool.js` and the cycle does
 *   not arise.
 * - **Error messages are ours.**  pyk interpolates dataclass `repr`s into its
 *   `ValueError`s; we name the sort or the symbol.  The *conditions* are
 *   transcribed exactly — that is what callers can depend on.
 */

import { EMPTY_ATT, Atts, KAtt, parseFormat, type Format, type WithKAtt } from "./att.js";
import { canonicalJson, eq, eqLabel, eqSort, hashOfDict } from "./eq.js";
import {
  Subst,
  bottomUp,
  bottomUpWithSummary,
  isCell,
  kapply,
  klabel,
  ksequence,
  ksort,
  kvariable,
  letKApply,
  letKVariable,
  topDown,
  type KApply,
  type KInner,
  type KLabel,
  type KRewrite,
  type KSort,
  type KVariable,
} from "./inner.js";
import { fromDict, kastTerm, sortFromDict, sortToDict, toDict, type JsonObject, type JsonValue } from "./json.js";
import { K, K_ITEM } from "./prelude/k.js";
import { TRUE } from "./prelude/kbool.js";
import { indexedRewrite } from "./rewrite.js";

//////////////////////
// JSON plumbing    //
//////////////////////

/**
 * The same reader helpers `json.ts` uses, which it keeps private.  Duplicated
 * rather than exported: they are three lines each, and widening a module's
 * public surface to share them would be the worse trade.
 */

function jsonError(message: string, path: string, options?: ErrorOptions): SyntaxError {
  return new SyntaxError(`${message} (at ${path})`, options);
}

function isArray(value: unknown): value is readonly unknown[] {
  return Array.isArray(value);
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !isArray(value);
}

function describe(value: unknown): string {
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") return String(value);
  if (value === undefined) return "nothing";
  if (value === null) return "null";
  if (typeof value === "symbol") return value.toString();
  if (typeof value === "function") return "a function";
  return isArray(value) ? "an array" : "an object";
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

function asBoolean(value: unknown, path: string): boolean {
  if (typeof value !== "boolean") throw jsonError(`Expected a boolean, got ${describe(value)}`, path);
  return value;
}

/** Read a required field, reporting its absence rather than its type. */
function field(obj: Readonly<Record<string, unknown>>, name: string, path: string, node: string): unknown {
  if (!Object.hasOwn(obj, name)) {
    throw jsonError(`${node} is missing the field ${JSON.stringify(name)}`, path);
  }
  return obj[name];
}

/** Prove at compile time that a `switch` over a node union is exhaustive. */
function exhausted(value: never): never {
  throw new TypeError(`Unhandled KAST node: ${JSON.stringify(value)}`);
}

/**
 * An attribute value as text.  The hot attributes here (`label`, `depends`,
 * `element`, `wrapElement`) are declared `ANY_TYPE`, so their static type is
 * `JsonValue` even though K only ever writes a string into them.
 */
function attText(value: JsonValue): string {
  return typeof value === "string" ? value : JSON.stringify(value);
}

/** Index into an array whose bounds the caller has already established. */
function at<T>(xs: readonly T[], i: number): T {
  const x = xs[i];
  if (x === undefined) throw new RangeError(`Index ${i} is out of range (length ${xs.length})`);
  return x;
}

/**
 * `d.get(key)` used as a *truth test* — the shape `outer.py` writes for every
 * optional field (`att`, `klabel`, `requires`, `ensures`).  Python's falsiness
 * makes an empty object mean "absent", which is why an empty `{}` is folded in
 * here rather than being handed to a decoder that would reject it.
 */
function optionalField(obj: Readonly<Record<string, unknown>>, name: string): unknown {
  const value = obj[name];
  if (value === undefined || value === null || value === false) return undefined;
  if (isRecord(value) && Object.keys(value).length === 0) return undefined;
  if (isArray(value) && value.length === 0) return undefined;
  if (value === "") return undefined;
  return value;
}

/** `KAtt.from_dict(d['att']) if d.get('att') else EMPTY_ATT`, everywhere. */
function attFromDict(obj: Readonly<Record<string, unknown>>, path: string): KAtt {
  const raw = optionalField(obj, "att");
  return raw === undefined ? EMPTY_ATT : KAtt.fromDict(raw, `${path}.att`);
}

function sortsFromDict(value: unknown, path: string): readonly KSort[] {
  return asArray(value, path).map((param, i) => sortFromDict(param, `${path}.${i}`));
}

/** `KLabel.from_dict` (`inner.py:108-110`), inlined because `json.ts` keeps its own. */
function labelFromDict(value: unknown, path: string): KLabel {
  const obj = asObject(value, path);
  const name = asString(field(obj, "name", path, "KLabel"), `${path}.name`);
  return klabel(name, sortsFromDict(field(obj, "params", path, "KLabel"), `${path}.params`));
}

function labelToDict(label: KLabel): JsonObject {
  return { node: "KLabel", name: label.name, params: label.params.map((param) => sortToDict(param)) };
}

//////////////////////
// Small utilities  //
//////////////////////

/** `utils.single` (`utils.py:287-299`). */
function single<T>(items: Iterable<T>): T {
  const all = [...items];
  if (all.length === 0) throw new TypeError("Expected a single element, found none");
  if (all.length > 1) throw new TypeError("Expected a single element, found more");
  return at(all, 0);
}

/** `zip(..., strict=True)`: a length mismatch is an error, not a truncation. */
function checkArity(expected: number, actual: number, what: string): void {
  if (expected !== actual) {
    throw new TypeError(`${what}: expected ${expected} argument(s), got ${actual}`);
  }
}

/**
 * `utils.not_none` (`utils.py:143-146`).
 *
 * Lives here rather than in a new `utils.ts` because this is where the
 * package's small helpers already are, and because `konvert`'s
 * `_module_to_kore.py:560` is its only real caller.
 */
export function notNone<T>(value: T | undefined | null, what = "value"): T {
  if (value === undefined || value === null) throw new TypeError(`Expected ${what} other than None`);
  return value;
}

/**
 * `utils.intersperse` (`utils.py:264-274`) — `delimiter` between consecutive
 * elements, nothing before the first or after the last.
 *
 * A generator upstream; an array here, because every caller
 * (`_module_to_kore.py:1379`, `formatter.py:96`) immediately materialises it.
 */
export function intersperse<T>(items: Iterable<T>, delimiter: T): readonly T[] {
  const out: T[] = [];
  for (const item of items) {
    if (out.length > 0) out.push(delimiter);
    out.push(item);
  }
  return out;
}

/**
 * Warshall's transitive closure over the keys that have outgoing edges — pyk
 * `POSet._compute_image` (`utils.py:99-114`), including its restriction of the
 * domain to `set(image)` (only those keys can contribute a hop).
 *
 * **This is a deliberate copy.**  The canonical implementation is
 * `packages/kore/src/definition.ts:427` `computeImage`, transcribed from the
 * same `utils.py` lines for the KORE subsort table; the two must not diverge.
 * It is duplicated rather than shared because `kast` must not depend on
 * `kore` — inverting that layering breaks both packages — and forty lines is
 * a better price than the dependency.
 *
 * One deviation from pyk, inherited from that copy: the innermost loop
 * iterates a *snapshot* of `image[k]`.  pyk iterates the live set, which
 * Python turns into a `RuntimeError` if the relation has a cycle through `k`;
 * a JS `Set` would instead visit the elements appended during iteration and
 * could spin forever.  On an acyclic relation — every relation `kompile`
 * emits — the two are identical, because only the `i === k` step can touch the
 * set being iterated and everything it would add is already there.
 */
function computeImage(relation: Iterable<readonly [string, string]>): Map<string, Set<string>> {
  const image = new Map<string, Set<string>>();
  for (const [x, y] of relation) {
    const ys = image.get(x);
    if (ys === undefined) image.set(x, new Set([y]));
    else ys.add(y);
  }

  const domain = [...image.keys()];
  for (const k of domain) {
    const viaK = image.get(k);
    if (viaK === undefined) continue;
    const hops = [...viaK];
    for (const i of domain) {
      const fromI = image.get(i);
      if (fromI === undefined || !fromI.has(k)) continue;
      for (const j of hops) fromI.add(j);
    }
  }
  return image;
}

/** {@link computeImage}, frozen into the read-only shape the getters expose. */
function freezeImage(image: ReadonlyMap<string, Set<string>>): ReadonlyMap<string, ReadonlySet<string>> {
  const out = new Map<string, ReadonlySet<string>>();
  for (const [key, values] of image) out.set(key, values);
  return out;
}

/** `dct.setdefault(key, set()).add(value)` (`outer.py:1338-1340`). */
function addToSetMap(map: Map<string, Set<string>>, key: string, value: string): void {
  const set = map.get(key);
  if (set === undefined) map.set(key, new Set([value]));
  else set.add(value);
}

const NO_SORTS: readonly KSort[] = Object.freeze([]);
const NO_ITEMS: readonly KProductionItem[] = Object.freeze([]);
const NO_SENTENCES: readonly KSentence[] = Object.freeze([]);
const NO_IMPORTS: readonly KImport[] = Object.freeze([]);
const NO_REQUIRES: readonly KRequire[] = Object.freeze([]);

/** Coerce the `str | KSort` unions pyk's constructors accept (`outer.py:220-225`). */
function toSort(sort: string | KSort): KSort {
  return typeof sort === "string" ? ksort(sort) : sort;
}

function toSorts(sorts: readonly (string | KSort)[]): readonly KSort[] {
  return sorts.length === 0 ? NO_SORTS : Object.freeze(sorts.map((sort) => toSort(sort)));
}

//////////////////////////////
// Production items         //
//////////////////////////////

/** A regular-expression terminal (`outer.py:74-96`). */
export interface KRegexTerminal {
  readonly node: "KRegexTerminal";
  readonly regex: string;
}

/** A non-terminal of a given sort, optionally named (`outer.py:99-125`). */
export interface KNonTerminal {
  readonly node: "KNonTerminal";
  readonly sort: KSort;
  readonly name: string | undefined;
}

/** A string literal in a production (`outer.py:128-147`). */
export interface KTerminal {
  readonly node: "KTerminal";
  readonly value: string;
}

/** The EBNF elements a production is built from (`outer.py:60-71`). */
export type KProductionItem = KRegexTerminal | KNonTerminal | KTerminal;

/** `KProductionItem._NODES` (`outer.py:63`). */
export const K_PRODUCTION_ITEM_NODES = ["KTerminal", "KRegexTerminal", "KNonTerminal"] as const;

export function kregexterminal(regex: string): KRegexTerminal {
  return Object.freeze({ node: "KRegexTerminal" as const, regex });
}

export function knonterminal(sort: string | KSort, name?: string): KNonTerminal {
  return Object.freeze({ node: "KNonTerminal" as const, sort: toSort(sort), name });
}

export function kterminal(value: string): KTerminal {
  return Object.freeze({ node: "KTerminal" as const, value });
}

export interface KRegexTerminalChanges {
  readonly regex?: string;
}

export function letKRegexTerminal(item: KRegexTerminal, changes: KRegexTerminalChanges): KRegexTerminal {
  return kregexterminal(changes.regex ?? item.regex);
}

export interface KNonTerminalChanges {
  readonly sort?: string | KSort;
  /** Present-and-`undefined` clears the name; absent keeps it. */
  readonly name?: string | undefined;
}

export function letKNonTerminal(item: KNonTerminal, changes: KNonTerminalChanges): KNonTerminal {
  return knonterminal(changes.sort ?? item.sort, Object.hasOwn(changes, "name") ? changes.name : item.name);
}

export interface KTerminalChanges {
  readonly value?: string;
}

export function letKTerminal(item: KTerminal, changes: KTerminalChanges): KTerminal {
  return kterminal(changes.value ?? item.value);
}

/** `KProductionItem.from_dict` (`outer.py:65-71`). */
export function productionItemFromDict(value: unknown, path = "productionItem"): KProductionItem {
  const obj = asObject(value, path);
  const node = asString(field(obj, "node", path, "A KProductionItem"), `${path}.node`);
  switch (node) {
    case "KRegexTerminal":
      return kregexterminal(asString(field(obj, "regex", path, node), `${path}.regex`));
    case "KNonTerminal": {
      // `outer.py:113`: the key's presence decides, so a `name` of `null` is
      // an error rather than an unnamed non-terminal.
      const sort = sortFromDict(field(obj, "sort", path, node), `${path}.sort`);
      if (!Object.hasOwn(obj, "name")) return knonterminal(sort);
      return knonterminal(sort, asString(obj["name"], `${path}.name`));
    }
    case "KTerminal":
      return kterminal(asString(field(obj, "value", path, node), `${path}.value`));
    default:
      throw jsonError(`Invalid KProductionItem node: ${JSON.stringify(node)}`, `${path}.node`);
  }
}

/** `KProductionItem.to_dict` (`outer.py:88-92,116-120,142-143`). */
export function productionItemToDict(item: KProductionItem): JsonObject {
  switch (item.node) {
    case "KRegexTerminal":
      return { node: "KRegexTerminal", regex: item.regex };
    case "KNonTerminal":
      return item.name === undefined
        ? { node: "KNonTerminal", sort: sortToDict(item.sort) }
        : { node: "KNonTerminal", sort: sortToDict(item.sort), name: item.name };
    case "KTerminal":
      return { node: "KTerminal", value: item.value };
    default:
      return exhausted(item);
  }
}

//////////////////////////////
// Sentences                //
//////////////////////////////

/** A production in K's EBNF grammar (`outer.py:200-351`). */
export interface KProduction extends WithKAtt {
  readonly node: "KProduction";
  readonly sort: KSort;
  readonly items: readonly KProductionItem[];
  readonly params: readonly KSort[];
  readonly klabel: KLabel | undefined;
  readonly att: KAtt;
}

/** A (potentially parametric) sort declaration (`outer.py:354-398`). */
export interface KSyntaxSort extends WithKAtt {
  readonly node: "KSyntaxSort";
  readonly sort: KSort;
  readonly params: readonly KSort[];
  readonly att: KAtt;
}

/** A new name for an existing sort (`outer.py:401-440`). */
export interface KSortSynonym extends WithKAtt {
  readonly node: "KSortSynonym";
  readonly newSort: KSort;
  readonly oldSort: KSort;
  readonly att: KAtt;
}

/** A named regular expression (`outer.py:443-480`). */
export interface KSyntaxLexical extends WithKAtt {
  readonly node: "KSyntaxLexical";
  readonly name: string;
  readonly regex: string;
  readonly att: KAtt;
}

/** Operator associativity for a set of production tags (`outer.py:489-528`). */
export interface KSyntaxAssociativity extends WithKAtt {
  readonly node: "KSyntaxAssociativity";
  readonly assoc: KAssoc;
  readonly tags: ReadonlySet<string>;
  readonly att: KAtt;
}

/** Syntax priority groups, highest first (`outer.py:531-563`). */
export interface KSyntaxPriority extends WithKAtt {
  readonly node: "KSyntaxPriority";
  readonly priorities: readonly ReadonlySet<string>[];
  readonly att: KAtt;
}

/** An unparsed chunk of user syntax (`outer.py:566-603`). */
export interface KBubble extends WithKAtt {
  readonly node: "KBubble";
  readonly sentenceType: string;
  readonly contents: string;
  readonly att: KAtt;
}

/** A rule (`outer.py:624-677`). */
export interface KRule extends WithKAtt {
  readonly node: "KRule";
  readonly body: KInner;
  readonly requires: KInner;
  readonly ensures: KInner;
  readonly att: KAtt;
}

/** A claim (`outer.py:680-747`). */
export interface KClaim extends WithKAtt {
  readonly node: "KClaim";
  readonly body: KInner;
  readonly requires: KInner;
  readonly ensures: KInner;
  readonly att: KAtt;
}

/** An evaluation context (`outer.py:750-787`). */
export interface KContext extends WithKAtt {
  readonly node: "KContext";
  readonly body: KInner;
  readonly requires: KInner;
  readonly att: KAtt;
}

/** An individual declaration in a module (`outer.py:150-197`). */
export type KSentence =
  | KProduction
  | KSyntaxSort
  | KSortSynonym
  | KSyntaxLexical
  | KSyntaxAssociativity
  | KSyntaxPriority
  | KBubble
  | KRule
  | KClaim
  | KContext;

/** `KRuleLike` (`outer.py:606-621`) — body/requires/ensures. */
export type KRuleLike = KRule | KClaim;

/** `KSentence._NODES` (`outer.py:153-164`). */
export const K_SENTENCE_NODES = [
  "KProduction",
  "KSyntaxSort",
  "KSortSynonym",
  "KSyntaxLexical",
  "KSyntaxAssociativity",
  "KSyntaxPriority",
  "KBubble",
  "KRule",
  "KClaim",
  "KContext",
] as const;

/** `KAssoc` (`outer.py:483-486`). */
export const KAssoc = {
  LEFT: "Left",
  RIGHT: "Right",
  NON_ASSOC: "NonAssoc",
} as const;

export type KAssoc = (typeof KAssoc)[keyof typeof KAssoc];

/** `KAssoc(d['assoc'])` (`outer.py:506`) — the enum lookup, as a decoder. */
function assocFromString(value: string, path: string): KAssoc {
  switch (value) {
    case KAssoc.LEFT:
      return KAssoc.LEFT;
    case KAssoc.RIGHT:
      return KAssoc.RIGHT;
    case KAssoc.NON_ASSOC:
      return KAssoc.NON_ASSOC;
    default:
      throw jsonError(`Invalid KAssoc: ${JSON.stringify(value)}`, path);
  }
}

//////////////////////////////
// Sentence constructors    //
//////////////////////////////

export interface KProductionOptions {
  readonly items?: readonly KProductionItem[];
  readonly params?: readonly (string | KSort)[];
  readonly klabel?: string | KLabel | undefined;
  readonly att?: KAtt;
}

/** `KProduction(sort, items, params, klabel, att)` (`outer.py:212-231`). */
export function kproduction(sort: string | KSort, options: KProductionOptions = {}): KProduction {
  const items = options.items ?? NO_ITEMS;
  const label = options.klabel;
  return Object.freeze({
    node: "KProduction" as const,
    sort: toSort(sort),
    items: items.length === 0 ? NO_ITEMS : Object.freeze([...items]),
    params: toSorts(options.params ?? NO_SORTS),
    klabel: typeof label === "string" ? klabel(label) : label,
    att: options.att ?? EMPTY_ATT,
  });
}

export interface KSyntaxSortOptions {
  readonly params?: readonly (string | KSort)[];
  readonly att?: KAtt;
}

/** `KSyntaxSort(sort, params, att)` (`outer.py:363-367`). */
export function ksyntaxsort(sort: string | KSort, options: KSyntaxSortOptions = {}): KSyntaxSort {
  return Object.freeze({
    node: "KSyntaxSort" as const,
    sort: toSort(sort),
    params: toSorts(options.params ?? NO_SORTS),
    att: options.att ?? EMPTY_ATT,
  });
}

/** `KSortSynonym(new_sort, old_sort, att)` (`outer.py:410-413`). */
export function ksortsynonym(newSort: string | KSort, oldSort: string | KSort, att: KAtt = EMPTY_ATT): KSortSynonym {
  return Object.freeze({
    node: "KSortSynonym" as const,
    newSort: toSort(newSort),
    oldSort: toSort(oldSort),
    att,
  });
}

/** `KSyntaxLexical(name, regex, att)` (`outer.py:452-455`). */
export function ksyntaxlexical(name: string, regex: string, att: KAtt = EMPTY_ATT): KSyntaxLexical {
  return Object.freeze({ node: "KSyntaxLexical" as const, name, regex, att });
}

export interface KSyntaxAssociativityOptions {
  readonly tags?: Iterable<string>;
  readonly att?: KAtt;
}

/** `KSyntaxAssociativity(assoc, tags, att)` (`outer.py:498-501`). */
export function ksyntaxassociativity(assoc: KAssoc, options: KSyntaxAssociativityOptions = {}): KSyntaxAssociativity {
  return Object.freeze({
    node: "KSyntaxAssociativity" as const,
    assoc,
    tags: Object.freeze(new Set(options.tags ?? [])),
    att: options.att ?? EMPTY_ATT,
  });
}

/** `KSyntaxPriority(priorities, att)` (`outer.py:539-541`). */
export function ksyntaxpriority(priorities: Iterable<Iterable<string>> = [], att: KAtt = EMPTY_ATT): KSyntaxPriority {
  const groups: ReadonlySet<string>[] = [];
  for (const group of priorities) groups.push(Object.freeze(new Set(group)));
  return Object.freeze({ node: "KSyntaxPriority" as const, priorities: Object.freeze(groups), att });
}

/** `KBubble(sentence_type, contents, att)` (`outer.py:575-578`). */
export function kbubble(sentenceType: string, contents: string, att: KAtt = EMPTY_ATT): KBubble {
  return Object.freeze({ node: "KBubble" as const, sentenceType, contents, att });
}

export interface KRuleOptions {
  readonly requires?: KInner;
  readonly ensures?: KInner;
  readonly att?: KAtt;
}

/** `KRule(body, requires, ensures, att)` (`outer.py:634-638`). */
export function krule(body: KInner, options: KRuleOptions = {}): KRule {
  return Object.freeze({
    node: "KRule" as const,
    body,
    requires: options.requires ?? TRUE,
    ensures: options.ensures ?? TRUE,
    att: options.att ?? EMPTY_ATT,
  });
}

/** `KClaim(body, requires, ensures, att)` (`outer.py:690-694`). */
export function kclaim(body: KInner, options: KRuleOptions = {}): KClaim {
  return Object.freeze({
    node: "KClaim" as const,
    body,
    requires: options.requires ?? TRUE,
    ensures: options.ensures ?? TRUE,
    att: options.att ?? EMPTY_ATT,
  });
}

export interface KContextOptions {
  readonly requires?: KInner;
  readonly att?: KAtt;
}

/** `KContext(body, requires, att)` (`outer.py:759-762`). */
export function kcontext(body: KInner, options: KContextOptions = {}): KContext {
  return Object.freeze({
    node: "KContext" as const,
    body,
    requires: options.requires ?? TRUE,
    att: options.att ?? EMPTY_ATT,
  });
}

//////////////////////////////
// Sentence `let` copies    //
//////////////////////////////

export interface KProductionChanges extends KProductionOptions {
  readonly sort?: string | KSort;
}

/** `KProduction.let` (`outer.py:255-269`) — and, unlike pyk's, able to clear `klabel`. */
export function letKProduction(prod: KProduction, changes: KProductionChanges): KProduction {
  return kproduction(changes.sort ?? prod.sort, {
    items: changes.items ?? prod.items,
    params: changes.params ?? prod.params,
    klabel: Object.hasOwn(changes, "klabel") ? changes.klabel : prod.klabel,
    att: changes.att ?? prod.att,
  });
}

export interface KSyntaxSortChanges extends KSyntaxSortOptions {
  readonly sort?: string | KSort;
}

/** `KSyntaxSort.let` (`outer.py:385-395`). */
export function letKSyntaxSort(sentence: KSyntaxSort, changes: KSyntaxSortChanges): KSyntaxSort {
  return ksyntaxsort(changes.sort ?? sentence.sort, {
    params: changes.params ?? sentence.params,
    att: changes.att ?? sentence.att,
  });
}

export interface KSortSynonymChanges {
  readonly newSort?: string | KSort;
  readonly oldSort?: string | KSort;
  readonly att?: KAtt;
}

/** `KSortSynonym.let` (`outer.py:431-437`). */
export function letKSortSynonym(sentence: KSortSynonym, changes: KSortSynonymChanges): KSortSynonym {
  return ksortsynonym(
    changes.newSort ?? sentence.newSort,
    changes.oldSort ?? sentence.oldSort,
    changes.att ?? sentence.att,
  );
}

export interface KSyntaxLexicalChanges {
  readonly name?: string;
  readonly regex?: string;
  readonly att?: KAtt;
}

/** `KSyntaxLexical.let` (`outer.py:473-477`). */
export function letKSyntaxLexical(sentence: KSyntaxLexical, changes: KSyntaxLexicalChanges): KSyntaxLexical {
  return ksyntaxlexical(changes.name ?? sentence.name, changes.regex ?? sentence.regex, changes.att ?? sentence.att);
}

export interface KSyntaxAssociativityChanges extends KSyntaxAssociativityOptions {
  readonly assoc?: KAssoc;
}

/** `KSyntaxAssociativity.let` (`outer.py:519-525`). */
export function letKSyntaxAssociativity(
  sentence: KSyntaxAssociativity,
  changes: KSyntaxAssociativityChanges,
): KSyntaxAssociativity {
  return ksyntaxassociativity(changes.assoc ?? sentence.assoc, {
    tags: changes.tags ?? sentence.tags,
    att: changes.att ?? sentence.att,
  });
}

export interface KSyntaxPriorityChanges {
  readonly priorities?: Iterable<Iterable<string>>;
  readonly att?: KAtt;
}

/** `KSyntaxPriority.let` (`outer.py:557-560`). */
export function letKSyntaxPriority(sentence: KSyntaxPriority, changes: KSyntaxPriorityChanges): KSyntaxPriority {
  return ksyntaxpriority(changes.priorities ?? sentence.priorities, changes.att ?? sentence.att);
}

export interface KBubbleChanges {
  readonly sentenceType?: string;
  readonly contents?: string;
  readonly att?: KAtt;
}

/** `KBubble.let` (`outer.py:596-600`). */
export function letKBubble(sentence: KBubble, changes: KBubbleChanges): KBubble {
  return kbubble(
    changes.sentenceType ?? sentence.sentenceType,
    changes.contents ?? sentence.contents,
    changes.att ?? sentence.att,
  );
}

export interface KRuleChanges extends KRuleOptions {
  readonly body?: KInner;
}

/** `KRule.let` (`outer.py:658-670`). */
export function letKRule(rule: KRule, changes: KRuleChanges): KRule {
  return krule(changes.body ?? rule.body, {
    requires: changes.requires ?? rule.requires,
    ensures: changes.ensures ?? rule.ensures,
    att: changes.att ?? rule.att,
  });
}

/** `KClaim.let` (`outer.py:714-726`). */
export function letKClaim(claim: KClaim, changes: KRuleChanges): KClaim {
  return kclaim(changes.body ?? claim.body, {
    requires: changes.requires ?? claim.requires,
    ensures: changes.ensures ?? claim.ensures,
    att: changes.att ?? claim.att,
  });
}

export interface KContextChanges extends KContextOptions {
  readonly body?: KInner;
}

/** `KContext.let` (`outer.py:780-784`). */
export function letKContext(context: KContext, changes: KContextChanges): KContext {
  return kcontext(changes.body ?? context.body, {
    requires: changes.requires ?? context.requires,
    att: changes.att ?? context.att,
  });
}

/**
 * `KSentence.let_att` for a sentence whose kind is not statically known —
 * the `LetAtt` to hand `att.ts`'s `mapAtt` / `updateAtts`.
 */
export function letSentenceAtt(sentence: KSentence, att: KAtt): KSentence {
  switch (sentence.node) {
    case "KProduction":
      return letKProduction(sentence, { att });
    case "KSyntaxSort":
      return letKSyntaxSort(sentence, { att });
    case "KSortSynonym":
      return letKSortSynonym(sentence, { att });
    case "KSyntaxLexical":
      return letKSyntaxLexical(sentence, { att });
    case "KSyntaxAssociativity":
      return letKSyntaxAssociativity(sentence, { att });
    case "KSyntaxPriority":
      return letKSyntaxPriority(sentence, { att });
    case "KBubble":
      return letKBubble(sentence, { att });
    case "KRule":
      return letKRule(sentence, { att });
    case "KClaim":
      return letKClaim(sentence, { att });
    case "KContext":
      return letKContext(sentence, { att });
    default:
      return exhausted(sentence);
  }
}

//////////////////////////////
// Sentence accessors       //
//////////////////////////////

/** `KSentence.unique_id` (`outer.py:174-177`). */
export function sentenceUniqueId(sentence: KSentence): JsonValue | undefined {
  return sentence.att.get(Atts.UNIQUE_ID);
}

/** `KSentence.source` (`outer.py:179-184`) — `"<source>:<location>"`, or nothing. */
export function sentenceSource(sentence: KSentence): string | undefined {
  const source = sentence.att.get(Atts.SOURCE);
  const location = sentence.att.get(Atts.LOCATION);
  if (source === undefined || location === undefined) return undefined;
  // pyk interpolates the Python tuple, which prints as `(1, 1, 2, 10)`.
  return `${source}:(${location.join(", ")})`;
}

/**
 * `KSentence.label` (`outer.py:186-197`): the `label` attribute, else the
 * frontend's `UNIQUE_ID`, else an error.
 */
export function sentenceLabel(sentence: KSentence): string {
  const label = sentence.att.get(Atts.LABEL) ?? sentenceUniqueId(sentence);
  if (label === undefined || label === null) {
    throw new TypeError(`Found sentence without label or UNIQUE_ID: ${sentence.node}`);
  }
  return attText(label);
}

/**
 * `KRule.priority` (`outer.py:675-677`).
 *
 * pyk annotates this `int` but returns the attribute unconverted, and
 * `Atts.PRIORITY` is an `ANY_TYPE` key — so upstream a `compiled.json` rule
 * yields the *string* `'200'`.  We honour the annotation and coerce; the
 * defaults (50, or 200 with `owise`) are numbers in both.
 */
export function rulePriority(rule: KRule): number {
  const priority = rule.att.get(Atts.PRIORITY);
  if (priority === undefined || priority === null) return rule.att.has(Atts.OWISE) ? 200 : 50;
  return Number(priority);
}

/** `KClaim.is_circularity` (`outer.py:731-734`). */
export function claimIsCircularity(claim: KClaim): boolean {
  return claim.att.has(Atts.CIRCULARITY);
}

/** `KClaim.is_trusted` (`outer.py:736-739`). */
export function claimIsTrusted(claim: KClaim): boolean {
  return claim.att.has(Atts.TRUSTED);
}

/** `KClaim.dependencies` (`outer.py:741-747`). */
export function claimDependencies(claim: KClaim): readonly string[] {
  const deps = claim.att.get(Atts.DEPENDS);
  if (deps === undefined || deps === null) return [];
  return attText(deps)
    .split(",")
    .map((x) => x.trim());
}

//////////////////////////////
// KProduction accessors    //
//////////////////////////////

/** `KProduction.as_subsort` (`outer.py:274-285`) — `[supersort, subsort]` or nothing. */
export function productionAsSubsort(prod: KProduction): readonly [KSort, KSort] | undefined {
  if (prod.klabel !== undefined) return undefined;
  if (prod.items.length !== 1) return undefined;
  const item = at(prod.items, 0);
  if (item.node !== "KNonTerminal") return undefined;
  return [prod.sort, item.sort];
}

/**
 * One declared (not transitively closed) subsort edge.
 *
 * `from` is the child/subsort and `to` is the parent/supersort, the direction
 * a KAST term must be injected when it occupies a `to` position.
 */
export interface SubsortEdge {
  readonly production: KProduction;
  readonly from: KSort;
  readonly to: KSort;
}

/** The direct subsort edge declared by `prod`, if it has the subsort shape. */
export function productionSubsortEdge(prod: KProduction): SubsortEdge | undefined {
  const pair = productionAsSubsort(prod);
  if (pair === undefined) return undefined;
  const [to, from] = pair;
  return Object.freeze({ production: prod, from, to });
}

/** `KProduction.non_terminals` (`outer.py:287-290`). */
export function productionNonTerminals(prod: KProduction): readonly KNonTerminal[] {
  return prod.items.filter((item): item is KNonTerminal => item.node === "KNonTerminal");
}

/** `KProduction.argument_sorts` (`outer.py:292-295`). */
export function productionArgumentSorts(prod: KProduction): readonly KSort[] {
  return productionNonTerminals(prod).map((nt) => nt.sort);
}

/**
 * `KProduction.is_prefix` (`outer.py:297-321`): the items spell
 * `t* "(" (n ("," n)*)? ")"`.
 *
 * Transcribed as pyk writes it — encode each item to one character, then match
 * the whole string against `t*\((n(,n)*)?\)`.
 */
export function productionIsPrefix(prod: KProduction): boolean {
  const encoded = prod.items.map((item) => encodeProductionItem(item)).join("");
  return PREFIX_PATTERN.test(encoded);
}

/** `pattern = r't*\((n(,n)*)?\)'` (`outer.py:320`), anchored as `re.fullmatch` is. */
const PREFIX_PATTERN = /^t*\((n(,n)*)?\)$/u;

/** `encode` (`outer.py:306-317`). */
function encodeProductionItem(item: KProductionItem): string {
  switch (item.node) {
    case "KTerminal":
      return ["(", ",", ")"].includes(item.value) ? item.value : "t";
    case "KNonTerminal":
      return "n";
    case "KRegexTerminal":
      return "r";
    default:
      return exhausted(item);
  }
}

/**
 * The labels `KFlatModule._is_function` refuses to call functions
 * (`outer.py:864-878`), even though their productions carry `function`.
 *
 * They are the builtin collection constructors — `_Map_` and friends are
 * `function` only because K implements concatenation as one — plus the
 * generated cell-map wrappers, matched by suffix in
 * {@link productionIsFunction}.
 */
const NOT_ACTUALLY_FUNCTIONS: ReadonlySet<string> = new Set([
  "_Set_",
  "_List_",
  "_Map_",
  "_RangeMap_",
  ".Set",
  ".List",
  ".Map",
  ".RangeMap",
  "SetItem",
  "ListItem",
  "_|->_",
  "_r|->_",
]);

/**
 * `KFlatModule._is_function` (`outer.py:861-883`) — a `staticmethod` on the
 * module upstream, a free function over the production here, because that is
 * all it ever looks at.
 *
 * `function` **or** `functional`, minus {@link NOT_ACTUALLY_FUNCTIONS} and the
 * generated cell-map constructors (`…CellMapItem`, `…CellMap_`).
 */
export function productionIsFunction(prod: KProduction): boolean {
  if (!prod.att.has(Atts.FUNCTION) && !prod.att.has(Atts.FUNCTIONAL)) return false;
  const label = prod.klabel?.name;
  if (label === undefined) return true;
  const isCellMapConstructor = label.endsWith("CellMapItem") || label.endsWith("CellMap_");
  return !isCellMapConstructor && !NOT_ACTUALLY_FUNCTIONS.has(label);
}

/** `KProduction.is_record` (`outer.py:323-326`). */
export function productionIsRecord(prod: KProduction): boolean {
  const nonTerminals = productionNonTerminals(prod);
  return productionIsPrefix(prod) && nonTerminals.length > 0 && nonTerminals.every((nt) => nt.name !== undefined);
}

/**
 * `KProduction.default_format` (`outer.py:328-351`).
 *
 * Throws for a regex terminal in a *record* production, exactly as upstream:
 * the non-record branch never inspects the items at all.
 */
export function productionDefaultFormat(prod: KProduction): Format {
  let formatStr: string;
  if (productionIsRecord(prod)) {
    const tokens: string[] = [];
    prod.items.forEach((item, i) => {
      switch (item.node) {
        case "KTerminal":
          tokens.push(item.value === "(" ? `%${i + 1}...` : `%${i + 1}`);
          break;
        case "KNonTerminal":
          // `productionIsRecord` has established every non-terminal is named.
          tokens.push(`${item.name ?? ""}:`, `%${i + 1}`);
          break;
        case "KRegexTerminal":
          throw new TypeError("Default format is not supported for productions with regex terminals");
      }
    });
    formatStr = tokens.join(" ");
  } else {
    formatStr = prod.items.map((_, i) => `%${i + 1}`).join(" ");
  }
  return parseFormat(formatStr);
}

//////////////////////////////
// Sentence JSON            //
//////////////////////////////

/** `KSentence.from_dict` (`outer.py:166-172`). */
export function sentenceFromDict(value: unknown, path = "sentence"): KSentence {
  const obj = asObject(value, path);
  const node = asString(field(obj, "node", path, "A KSentence"), `${path}.node`);
  const att = attFromDict(obj, path);

  switch (node) {
    case "KProduction": {
      const rawKlabel = optionalField(obj, "klabel");
      return kproduction(sortFromDict(field(obj, "sort", path, node), `${path}.sort`), {
        items: asArray(field(obj, "productionItems", path, node), `${path}.productionItems`).map((item, i) =>
          productionItemFromDict(item, `${path}.productionItems.${i}`),
        ),
        params: sortsFromDict(field(obj, "params", path, node), `${path}.params`),
        klabel: rawKlabel === undefined ? undefined : labelFromDict(rawKlabel, `${path}.klabel`),
        att,
      });
    }
    case "KSyntaxSort":
      return ksyntaxsort(sortFromDict(field(obj, "sort", path, node), `${path}.sort`), {
        params: sortsFromDict(field(obj, "params", path, node), `${path}.params`),
        att,
      });
    case "KSortSynonym":
      return ksortsynonym(
        sortFromDict(field(obj, "newSort", path, node), `${path}.newSort`),
        sortFromDict(field(obj, "oldSort", path, node), `${path}.oldSort`),
        att,
      );
    case "KSyntaxLexical":
      return ksyntaxlexical(
        asString(field(obj, "name", path, node), `${path}.name`),
        asString(field(obj, "regex", path, node), `${path}.regex`),
        att,
      );
    case "KSyntaxAssociativity": {
      const assoc = assocFromString(asString(field(obj, "assoc", path, node), `${path}.assoc`), `${path}.assoc`);
      return ksyntaxassociativity(assoc, {
        tags: asArray(field(obj, "tags", path, node), `${path}.tags`).map((tag, i) =>
          asString(tag, `${path}.tags.${i}`),
        ),
        att,
      });
    }
    case "KSyntaxPriority":
      return ksyntaxpriority(
        asArray(field(obj, "priorities", path, node), `${path}.priorities`).map((group, i) =>
          asArray(group, `${path}.priorities.${i}`).map((tag, j) => asString(tag, `${path}.priorities.${i}.${j}`)),
        ),
        att,
      );
    case "KBubble":
      return kbubble(
        asString(field(obj, "sentenceType", path, node), `${path}.sentenceType`),
        asString(field(obj, "contents", path, node), `${path}.contents`),
        att,
      );
    case "KRule":
      return krule(fromDict(field(obj, "body", path, node), `${path}.body`), {
        requires: optionalTerm(obj, "requires", path),
        ensures: optionalTerm(obj, "ensures", path),
        att,
      });
    case "KClaim":
      return kclaim(fromDict(field(obj, "body", path, node), `${path}.body`), {
        requires: optionalTerm(obj, "requires", path),
        ensures: optionalTerm(obj, "ensures", path),
        att,
      });
    case "KContext":
      return kcontext(fromDict(field(obj, "body", path, node), `${path}.body`), {
        requires: optionalTerm(obj, "requires", path),
        att,
      });
    default:
      throw jsonError(`Invalid KSentence node: ${JSON.stringify(node)}`, `${path}.node`);
  }
}

/** `KInner.from_dict(d['requires']) if d.get('requires') else _TRUE` (`outer.py:644-645`). */
function optionalTerm(obj: Readonly<Record<string, unknown>>, name: string, path: string): KInner {
  const raw = optionalField(obj, name);
  return raw === undefined ? TRUE : fromDict(raw, `${path}.${name}`);
}

/** `KSentence.to_dict` — the per-class ones at `outer.py:243,377,423,465,511,550,588,649,705,772`. */
export function sentenceToDict(sentence: KSentence): JsonObject {
  switch (sentence.node) {
    case "KProduction": {
      // `filter_none` (`outer.py:244`): `klabel` is the only nullable field,
      // so the whole key disappears when there is no label.
      const base = {
        node: "KProduction",
        sort: sortToDict(sentence.sort),
        productionItems: sentence.items.map((item) => productionItemToDict(item)),
        params: sentence.params.map((param) => sortToDict(param)),
      };
      return sentence.klabel === undefined
        ? { ...base, att: sentence.att.toDict() }
        : { ...base, klabel: labelToDict(sentence.klabel), att: sentence.att.toDict() };
    }
    case "KSyntaxSort":
      return {
        node: "KSyntaxSort",
        sort: sortToDict(sentence.sort),
        params: sentence.params.map((param) => sortToDict(param)),
        att: sentence.att.toDict(),
      };
    case "KSortSynonym":
      return {
        node: "KSortSynonym",
        newSort: sortToDict(sentence.newSort),
        oldSort: sortToDict(sentence.oldSort),
        att: sentence.att.toDict(),
      };
    case "KSyntaxLexical":
      // `outer.py:467` — upstream's typo, kept so the two libraries agree.
      return {
        node: "KSyntaxLexcial",
        name: sentence.name,
        regex: sentence.regex,
        att: sentence.att.toDict(),
      };
    case "KSyntaxAssociativity":
      return {
        node: "KSyntaxAssociativity",
        assoc: sentence.assoc,
        tags: [...sentence.tags],
        att: sentence.att.toDict(),
      };
    case "KSyntaxPriority":
      return {
        node: "KSyntaxPriority",
        priorities: sentence.priorities.map((group) => [...group]),
        att: sentence.att.toDict(),
      };
    case "KBubble":
      return {
        node: "KBubble",
        sentenceType: sentence.sentenceType,
        contents: sentence.contents,
        att: sentence.att.toDict(),
      };
    case "KRule":
      return {
        node: "KRule",
        body: toDict(sentence.body),
        requires: toDict(sentence.requires),
        ensures: toDict(sentence.ensures),
        att: sentence.att.toDict(),
      };
    case "KClaim":
      return {
        node: "KClaim",
        body: toDict(sentence.body),
        requires: toDict(sentence.requires),
        ensures: toDict(sentence.ensures),
        att: sentence.att.toDict(),
      };
    case "KContext":
      return {
        node: "KContext",
        body: toDict(sentence.body),
        requires: toDict(sentence.requires),
        att: sentence.att.toDict(),
      };
    default:
      return exhausted(sentence);
  }
}

//////////////////////////////
// Modules and requires     //
//////////////////////////////

/** A module import (`outer.py:790-812`). */
export interface KImport {
  readonly node: "KImport";
  readonly name: string;
  readonly public: boolean;
}

/** `KImport(name, public)` (`outer.py:798-800`). */
export function kimport(name: string, isPublic = true): KImport {
  return Object.freeze({ node: "KImport" as const, name, public: isPublic });
}

export interface KImportChanges {
  readonly name?: string;
  readonly public?: boolean;
}

/** `KImport.let` (`outer.py:809-812`). */
export function letKImport(imp: KImport, changes: KImportChanges): KImport {
  return kimport(changes.name ?? imp.name, changes.public ?? imp.public);
}

/** `KImport.from_dict` (`outer.py:802-804`). */
export function importFromDict(value: unknown, path = "import"): KImport {
  const obj = asObject(value, path);
  return kimport(
    asString(field(obj, "name", path, "KImport"), `${path}.name`),
    asBoolean(field(obj, "isPublic", path, "KImport"), `${path}.isPublic`),
  );
}

/** `KImport.to_dict` (`outer.py:806-807`). */
export function importToDict(imp: KImport): JsonObject {
  return { node: "KImport", name: imp.name, isPublic: imp.public };
}

/** A file-level `requires` (`outer.py:981-1000`). */
export interface KRequire {
  readonly node: "KRequire";
  readonly require: string;
}

/** `KRequire(require)` (`outer.py:988-989`). */
export function krequire(require: string): KRequire {
  return Object.freeze({ node: "KRequire" as const, require });
}

export interface KRequireChanges {
  readonly require?: string;
}

/** `KRequire.let` (`outer.py:998-1000`). */
export function letKRequire(req: KRequire, changes: KRequireChanges): KRequire {
  return krequire(changes.require ?? req.require);
}

/** `KRequire.from_dict` (`outer.py:991-993`). */
export function requireFromDict(value: unknown, path = "require"): KRequire {
  const obj = asObject(value, path);
  return krequire(asString(field(obj, "require", path, "KRequire"), `${path}.require`));
}

/** `KRequire.to_dict` (`outer.py:995-996`). */
export function requireToDict(req: KRequire): JsonObject {
  return { node: "KRequire", require: req.require };
}

/** A K module: a name, imports and sentences (`outer.py:815-949`). */
export interface KFlatModule extends WithKAtt {
  readonly node: "KFlatModule";
  readonly name: string;
  readonly sentences: readonly KSentence[];
  readonly imports: readonly KImport[];
  readonly att: KAtt;
}

export interface KFlatModuleOptions {
  readonly sentences?: readonly KSentence[];
  readonly imports?: readonly KImport[];
  readonly att?: KAtt;
}

/** `KFlatModule(name, sentences, imports, att)` (`outer.py:825-831`). */
export function kflatmodule(name: string, options: KFlatModuleOptions = {}): KFlatModule {
  const sentences = options.sentences ?? NO_SENTENCES;
  const imports = options.imports ?? NO_IMPORTS;
  return Object.freeze({
    node: "KFlatModule" as const,
    name,
    sentences: sentences.length === 0 ? NO_SENTENCES : Object.freeze([...sentences]),
    imports: imports.length === 0 ? NO_IMPORTS : Object.freeze([...imports]),
    att: options.att ?? EMPTY_ATT,
  });
}

export interface KFlatModuleChanges extends KFlatModuleOptions {
  readonly name?: string;
}

/** `KFlatModule.let` (`outer.py:934-946`). */
export function letKFlatModule(module: KFlatModule, changes: KFlatModuleChanges): KFlatModule {
  return kflatmodule(changes.name ?? module.name, {
    sentences: changes.sentences ?? module.sentences,
    imports: changes.imports ?? module.imports,
    att: changes.att ?? module.att,
  });
}

/** `KFlatModule.let_att` (`outer.py:948-949`) as an `att.ts` `LetAtt`. */
export function letModuleAtt(module: KFlatModule, att: KAtt): KFlatModule {
  return letKFlatModule(module, { att });
}

/** `KFlatModule.from_dict` (`outer.py:916-923`). */
export function flatModuleFromDict(value: unknown, path = "module"): KFlatModule {
  const obj = asObject(value, path);
  return kflatmodule(asString(field(obj, "name", path, "KFlatModule"), `${path}.name`), {
    sentences: asArray(field(obj, "localSentences", path, "KFlatModule"), `${path}.localSentences`).map((sentence, i) =>
      sentenceFromDict(sentence, `${path}.localSentences.${i}`),
    ),
    imports: asArray(field(obj, "imports", path, "KFlatModule"), `${path}.imports`).map((imp, i) =>
      importFromDict(imp, `${path}.imports.${i}`),
    ),
    att: attFromDict(obj, path),
  });
}

/** `KFlatModule.to_dict` (`outer.py:925-932`). */
export function flatModuleToDict(module: KFlatModule): JsonObject {
  return {
    node: "KFlatModule",
    name: module.name,
    localSentences: module.sentences.map((sentence) => sentenceToDict(sentence)),
    imports: module.imports.map((imp) => importToDict(imp)),
    att: module.att.toDict(),
  };
}

/** `KFlatModule.productions` (`outer.py:836-839`). */
export function moduleProductions(module: KFlatModule): readonly KProduction[] {
  return module.sentences.filter((s): s is KProduction => s.node === "KProduction");
}

/** The direct subsort edges declared locally in `module`, in sentence order. */
export function moduleSubsortEdges(module: KFlatModule): readonly SubsortEdge[] {
  return Object.freeze(
    moduleProductions(module).flatMap((production) => {
      const edge = productionSubsortEdge(production);
      return edge === undefined ? [] : [edge];
    }),
  );
}

/** `KFlatModule.syntax_productions` (`outer.py:841-844`) — the ones with a label. */
export function moduleSyntaxProductions(module: KFlatModule): readonly KProduction[] {
  return moduleProductions(module).filter((prod) => prod.klabel !== undefined);
}

/** `KFlatModule.rules` (`outer.py:890-893`). */
export function moduleRules(module: KFlatModule): readonly KRule[] {
  return module.sentences.filter((s): s is KRule => s.node === "KRule");
}

/** `KFlatModule.cell_collection_productions` (`outer.py:856-859`). */
export function moduleCellCollectionProductions(module: KFlatModule): readonly KProduction[] {
  return moduleSyntaxProductions(module).filter((prod) => prod.att.has(Atts.CELL_COLLECTION));
}

/** `KFlatModule.functions` (`outer.py:846-849`). */
export function moduleFunctions(module: KFlatModule): readonly KProduction[] {
  return moduleSyntaxProductions(module).filter((prod) => productionIsFunction(prod));
}

/** `KFlatModule.constructors` (`outer.py:851-854`) — the syntax productions that are *not* functions. */
export function moduleConstructors(module: KFlatModule): readonly KProduction[] {
  return moduleSyntaxProductions(module).filter((prod) => !productionIsFunction(prod));
}

/** `KFlatModule.syntax_sorts` (`outer.py:885-888`). */
export function moduleSyntaxSorts(module: KFlatModule): readonly KSyntaxSort[] {
  return module.sentences.filter((s): s is KSyntaxSort => s.node === "KSyntaxSort");
}

/** `KFlatModule.claims` (`outer.py:895-898`). */
export function moduleClaims(module: KFlatModule): readonly KClaim[] {
  return module.sentences.filter((s): s is KClaim => s.node === "KClaim");
}

/**
 * `KFlatModule.sentence_by_unique_id` (`outer.py:900-902`).
 *
 * A dict comprehension upstream, so a later sentence silently wins over an
 * earlier one with the same id; kept.  {@link KDefinition.sentenceByUniqueId}
 * is the one that notices the collision.
 */
export function moduleSentenceByUniqueId(module: KFlatModule): ReadonlyMap<string, KSentence> {
  const result = new Map<string, KSentence>();
  for (const sentence of module.sentences) {
    const uniqueId = sentenceUniqueId(sentence);
    if (uniqueId === undefined || uniqueId === null) continue;
    result.set(attText(uniqueId), sentence);
  }
  return result;
}

/**
 * `KFlatModule.map_sentences` (`outer.py:904-914`): rewrite every sentence, or
 * every sentence of one kind.
 *
 * pyk's `of_type` is a Python *class* and the two `@overload`s exist only to
 * work around a mypy bug; here it is the sentence's `node` string, which is
 * how the rest of this file discriminates, and the narrowing falls out for
 * free.  Every upstream call site passes a single concrete class —
 * `KClaim` (`ktool/claim_index.py:84`), `KRule` and `KSyntaxSort`
 * (`konvert/_module_to_kore.py:814,861,929,972`).
 */
export function moduleMapSentences<N extends KSentence["node"]>(
  module: KFlatModule,
  f: (sentence: Extract<KSentence, { node: N }>) => KSentence,
  ofType: N,
): KFlatModule;
export function moduleMapSentences(module: KFlatModule, f: (sentence: KSentence) => KSentence): KFlatModule;
export function moduleMapSentences(
  module: KFlatModule,
  f: (sentence: KSentence) => KSentence,
  ofType?: KSentence["node"],
): KFlatModule {
  return letKFlatModule(module, {
    sentences: module.sentences.map((sentence) =>
      ofType === undefined || sentence.node === ofType ? f(sentence) : sentence,
    ),
  });
}

/** A list of modules with one called out as main (`outer.py:952-978`). */
export interface KFlatModuleList {
  readonly node: "KFlatModuleList";
  readonly mainModule: string;
  readonly modules: readonly KFlatModule[];
}

/** `KFlatModuleList(main_module, modules)` (`outer.py:960-962`). */
export function kflatmodulelist(mainModule: string, modules: readonly KFlatModule[]): KFlatModuleList {
  return Object.freeze({
    node: "KFlatModuleList" as const,
    mainModule,
    modules: Object.freeze([...modules]),
  });
}

export interface KFlatModuleListChanges {
  readonly mainModule?: string;
  readonly modules?: readonly KFlatModule[];
}

/** `KFlatModuleList.let` (`outer.py:975-978`). */
export function letKFlatModuleList(list: KFlatModuleList, changes: KFlatModuleListChanges): KFlatModuleList {
  return kflatmodulelist(changes.mainModule ?? list.mainModule, changes.modules ?? list.modules);
}

/** `KFlatModuleList.from_dict` (`outer.py:964-966`) — note the field is `term`. */
export function flatModuleListFromDict(value: unknown, path = "moduleList"): KFlatModuleList {
  const obj = asObject(value, path);
  return kflatmodulelist(
    asString(field(obj, "mainModule", path, "KFlatModuleList"), `${path}.mainModule`),
    asArray(field(obj, "term", path, "KFlatModuleList"), `${path}.term`).map((module, i) =>
      flatModuleFromDict(module, `${path}.term.${i}`),
    ),
  );
}

/** `KFlatModuleList.to_dict` (`outer.py:968-973`). */
export function flatModuleListToDict(list: KFlatModuleList): JsonObject {
  return {
    node: "KFlatModuleList",
    mainModule: list.mainModule,
    term: list.modules.map((module) => flatModuleToDict(module)),
  };
}

//////////////////////////////
// KDefinition              //
//////////////////////////////

/** What {@link KDefinition} accepts beyond the two required arguments. */
export interface KDefinitionOptions {
  readonly requires?: readonly KRequire[];
  readonly att?: KAtt;
}

/** The cell label → `[element constructor, cell-map sort]` index. */
export type CellMapItemInfo = ReadonlyMap<string, readonly [string, KSort]>;

/**
 * A whole K definition (`outer.py:1003-1670`).
 *
 * The constructor resolves and validates the main module, exactly as
 * `outer.py:1025-1033` does — a missing or duplicated main module is an error
 * at construction, not at first use.
 */
export class KDefinition implements WithKAtt {
  readonly node = "KDefinition" as const;
  readonly mainModuleName: string;
  readonly allModules: readonly KFlatModule[];
  readonly requires: readonly KRequire[];
  readonly att: KAtt;
  /** `main_module` (`outer.py:1013,1033`) — resolved once, in the constructor. */
  readonly mainModule: KFlatModule;

  #allModulesDict: ReadonlyMap<string, KFlatModule> | undefined;
  #moduleNames: readonly string[] | undefined;
  #modules: readonly KFlatModule[] | undefined;
  #productions: readonly KProduction[] | undefined;
  #syntaxProductions: readonly KProduction[] | undefined;
  #rules: readonly KRule[] | undefined;
  #aliasRules: readonly KRule[] | undefined;
  #macroRules: readonly KRule[] | undefined;
  #semanticRules: readonly KRule[] | undefined;
  #claims: readonly KClaim[] | undefined;
  #symbols: ReadonlyMap<string, KProduction> | undefined;
  #functions: readonly KProduction[] | undefined;
  #functionLabels: readonly string[] | undefined;
  #constructors: readonly KProduction[] | undefined;
  #sentenceByUniqueId: ReadonlyMap<string, KSentence> | undefined;
  #subsortIndex: SubsortIndex | undefined;
  #brackets: ReadonlyMap<string, KProduction> | undefined;
  #syntaxSymbols: ReadonlyMap<string, KProduction> | undefined;
  #overloads: ReadonlyMap<string, ReadonlySet<string>> | undefined;
  #priorities: ReadonlyMap<string, ReadonlySet<string>> | undefined;
  #leftAssocs: ReadonlyMap<string, ReadonlySet<string>> | undefined;
  #rightAssocs: ReadonlyMap<string, ReadonlySet<string>> | undefined;
  #hash: string | undefined;
  #cellCollectionProductions: readonly KProduction[] | undefined;
  #cellMapItemInfo: CellMapItemInfo | undefined;
  /** `_empty_config` / `_init_config` (`outer.py:1015-1016`), keyed by canonical sort JSON. */
  readonly #emptyConfig = new Map<string, KInner>();
  readonly #initConfig = new Map<string, KInner>();

  constructor(mainModuleName: string, allModules: readonly KFlatModule[], options: KDefinitionOptions = {}) {
    const modules = Object.freeze([...allModules]);
    const mainModules = modules.filter((module) => module.name === mainModuleName);
    if (mainModules.length === 0) throw new TypeError(`Module not found: ${mainModuleName}`);
    if (mainModules.length > 1) throw new TypeError(`Module is not unique: ${mainModuleName}`);

    this.mainModuleName = mainModuleName;
    this.allModules = modules;
    this.requires = Object.freeze([...(options.requires ?? NO_REQUIRES)]);
    this.att = options.att ?? EMPTY_ATT;
    this.mainModule = at(mainModules, 0);
  }

  /** `KDefinition.let` (`outer.py:1064-1076`). */
  let(changes: KDefinitionChanges): KDefinition {
    return new KDefinition(changes.mainModuleName ?? this.mainModuleName, changes.allModules ?? this.allModules, {
      requires: changes.requires ?? this.requires,
      att: changes.att ?? this.att,
    });
  }

  /** `KDefinition.let_att` (`outer.py:1078-1079`). */
  letAtt(att: KAtt): KDefinition {
    return this.let({ att });
  }

  /** `KDefinition.from_dict` (`outer.py:1046-1053`). */
  static fromDict(value: unknown, path = "definition"): KDefinition {
    const obj = asObject(value, path);
    const rawRequires = optionalField(obj, "requires");
    return new KDefinition(
      asString(field(obj, "mainModule", path, "KDefinition"), `${path}.mainModule`),
      asArray(field(obj, "modules", path, "KDefinition"), `${path}.modules`).map((module, i) =>
        flatModuleFromDict(module, `${path}.modules.${i}`),
      ),
      {
        requires:
          rawRequires === undefined
            ? NO_REQUIRES
            : asArray(rawRequires, `${path}.requires`).map((req, i) => requireFromDict(req, `${path}.requires.${i}`)),
        att: attFromDict(obj, path),
      },
    );
  }

  /** `KDefinition.to_dict` (`outer.py:1055-1062`). */
  toDict(): JsonObject {
    return {
      node: "KDefinition",
      mainModule: this.mainModuleName,
      modules: this.allModules.map((module) => flatModuleToDict(module)),
      requires: this.requires.map((req) => requireToDict(req)),
      att: this.att.toDict(),
    };
  }

  /** `KDefinition.all_module_names` (`outer.py:1081-1084`). */
  get allModuleNames(): readonly string[] {
    return this.allModules.map((module) => module.name);
  }

  /** `KDefinition.all_modules_dict` (`outer.py:1098-1101`). */
  get allModulesDict(): ReadonlyMap<string, KFlatModule> {
    return (this.#allModulesDict ??= this.#computeAllModulesDict());
  }

  #computeAllModulesDict(): ReadonlyMap<string, KFlatModule> {
    const dict = new Map<string, KFlatModule>();
    for (const module of this.allModules) dict.set(module.name, module);
    return dict;
  }

  /**
   * `KDefinition.module_names` (`outer.py:1086-1096`): the modules the main
   * module transitively imports, **breadth-first from the main module**, and
   * *not* everything in {@link allModuleNames} — a definition can carry
   * modules nobody imports.
   */
  get moduleNames(): readonly string[] {
    return (this.#moduleNames ??= this.#computeModuleNames());
  }

  #computeModuleNames(): readonly string[] {
    const queue = [this.mainModuleName];
    const seen: string[] = [];
    const seenSet = new Set<string>();
    while (queue.length > 0) {
      const name = queue.shift();
      if (name === undefined) break;
      if (seenSet.has(name)) continue;
      seenSet.add(name);
      seen.push(name);
      for (const imp of this.module(name).imports) queue.push(imp.name);
    }
    return Object.freeze(seen);
  }

  /** `KDefinition.modules` (`outer.py:1103-1106`). */
  get modules(): readonly KFlatModule[] {
    return (this.#modules ??= Object.freeze(this.moduleNames.map((name) => this.module(name))));
  }

  /** `KDefinition.module` (`outer.py:1216-1218`). */
  module(name: string): KFlatModule {
    const module = this.allModulesDict.get(name);
    if (module === undefined) throw new TypeError(`Module not found: ${name}`);
    return module;
  }

  /** `KDefinition.productions` (`outer.py:1108-1111`). */
  get productions(): readonly KProduction[] {
    return (this.#productions ??= Object.freeze(this.modules.flatMap((module) => [...moduleProductions(module)])));
  }

  /** `KDefinition.syntax_productions` (`outer.py:1113-1116`). */
  get syntaxProductions(): readonly KProduction[] {
    return (this.#syntaxProductions ??= Object.freeze(
      this.modules.flatMap((module) => [...moduleSyntaxProductions(module)]),
    ));
  }

  /** `KDefinition.rules` (`outer.py:1157-1160`). */
  get rules(): readonly KRule[] {
    return (this.#rules ??= Object.freeze(this.modules.flatMap((module) => [...moduleRules(module)])));
  }

  /** `KDefinition.alias_rules` (`outer.py:1162-1165`). */
  get aliasRules(): readonly KRule[] {
    return (this.#aliasRules ??= Object.freeze(this.rules.filter((rule) => rule.att.has(Atts.ALIAS))));
  }

  /**
   * `KDefinition.macro_rules` (`outer.py:1167-1170`): the `macro` rules
   * **followed by** the alias rules — order matters, and a rule that is both
   * appears twice, upstream and here.
   */
  get macroRules(): readonly KRule[] {
    return (this.#macroRules ??= Object.freeze([
      ...this.rules.filter((rule) => rule.att.has(Atts.MACRO)),
      ...this.aliasRules,
    ]));
  }

  /**
   * `KDefinition.semantic_rules` (`outer.py:1172-1184`): the rules whose body
   * is a whole configuration — a `<generatedTop>` application, or a rewrite
   * whose left-hand side is one.
   */
  get semanticRules(): readonly KRule[] {
    return (this.#semanticRules ??= Object.freeze(this.rules.filter((rule) => isSemanticRule(rule))));
  }

  /**
   * The `KClaim` sentences the main module transitively imports.
   *
   * **Not in pyk at v7.1.337** — `KDefinition` has `rules` but no `claims`,
   * and callers spell it `[c for m in defn.modules for c in m.claims]`
   * (`ktool/claim_index.py:37`).  Added here as the obvious analogue of
   * {@link rules}; {@link moduleClaims} is the transcribed half.
   */
  get claims(): readonly KClaim[] {
    return (this.#claims ??= Object.freeze(this.modules.flatMap((module) => [...moduleClaims(module)])));
  }

  /**
   * `KDefinition.symbols` (`outer.py:1242-1256`): klabel name → production.
   *
   * The duplicate check is transcribed literally, **including its bug**:
   * upstream compares `prod.let(att=prod.att.drop_source())` against
   * `other.let(att=prod.att.drop_source())` — note `prod.att` on both sides —
   * so two productions that agree everywhere except in their attributes are
   * accepted as the same symbol.  Changing that here would make us reject
   * definitions pyk loads.
   */
  get symbols(): ReadonlyMap<string, KProduction> {
    return (this.#symbols ??= this.#computeSymbols());
  }

  #computeSymbols(): ReadonlyMap<string, KProduction> {
    const symbols = new Map<string, KProduction>();
    for (const prod of this.productions) {
      if (prod.klabel === undefined) continue;
      const symbol = prod.klabel.name;
      const other = symbols.get(symbol);
      if (other !== undefined) {
        if (!sameSymbolProduction(prod, other)) {
          throw new TypeError(`Found multiple productions for ${symbol}`);
        }
        continue;
      }
      symbols.set(symbol, prod);
    }
    return symbols;
  }

  /** `KDefinition.functions` (`outer.py:1118-1121`). */
  get functions(): readonly KProduction[] {
    return (this.#functions ??= Object.freeze(this.modules.flatMap((module) => [...moduleFunctions(module)])));
  }

  /**
   * `KDefinition.function_labels` (`outer.py:1123-1126`).
   *
   * A *list*, not a set, and it can repeat.  {@link functions} folds over
   * {@link modules} without the de-duplication {@link symbols} does, and K
   * really does re-declare a symbol in more than one module — the fixture
   * definitions in this repo declare `<generatedCounter>` twice.
   * `kruleToKore` only ever asks `in`, so upstream never noticed; kept as-is,
   * because a caller counting occurrences should see the numbers pyk does.
   */
  get functionLabels(): readonly string[] {
    return (this.#functionLabels ??= Object.freeze(
      this.functions.map((prod) => notNone(prod.klabel, "klabel on a function production").name),
    ));
  }

  /** `KDefinition.constructors` (`outer.py:1128-1131`). */
  get constructors(): readonly KProduction[] {
    return (this.#constructors ??= Object.freeze(this.modules.flatMap((module) => [...moduleConstructors(module)])));
  }

  /**
   * `KDefinition.sentence_by_unique_id` (`outer.py:1186-1197`): the join
   * partner for `allRules.txt`.
   *
   * Over {@link allModules}, **not** {@link modules} — a definition's
   * unimported modules still contribute ids.  A second sentence under an id
   * already taken by a *different* sentence is **dropped, not an error**:
   * upstream logs it at `DEBUG` (`outer.py:1191-1193`) and keeps the first.
   * This package has no logger, so the log is dropped too; what callers can
   * depend on is that the map does not throw and that the first sentence wins.
   */
  get sentenceByUniqueId(): ReadonlyMap<string, KSentence> {
    return (this.#sentenceByUniqueId ??= this.#computeSentenceByUniqueId());
  }

  #computeSentenceByUniqueId(): ReadonlyMap<string, KSentence> {
    const result = new Map<string, KSentence>();
    for (const module of this.allModules) {
      for (const [uniqueId, sentence] of moduleSentenceByUniqueId(module)) {
        const other = result.get(uniqueId);
        if (other !== undefined && !eqSentence(sentence, other)) continue;
        result.set(uniqueId, sentence);
      }
    }
    return result;
  }

  //////////////////////////////
  // The sort lattice         //
  //////////////////////////////

  /**
   * `KDefinition.subsort_table` (`outer.py:1220-1224`): every sort to the set
   * of its **proper** subsorts, transitively closed.
   *
   * Keyed by {@link sortKey} in both directions, because a JS `Map` compares
   * keys by identity and pyk's compares `KSort`s by value.  The relation is
   * {@link productionAsSubsort} over {@link productions}, closed with
   * {@link computeImage}.
   *
   * **Not reflexive** — `POSet._compute_image` is Warshall and nothing else, so
   * a sort appears in its own image only if the definition declares a cycle.
   * Reflexivity is a query-time question; {@link isSubsort} answers it.
   */
  get subsortTable(): ReadonlyMap<string, ReadonlySet<string>> {
    return this.#subsorts().image;
  }

  #subsorts(): SubsortIndex {
    return (this.#subsortIndex ??= this.#computeSubsorts());
  }

  #computeSubsorts(): SubsortIndex {
    const sorts = new Map<string, KSort>();
    const relation: (readonly [string, string])[] = [];
    for (const prod of this.productions) {
      const pair = productionAsSubsort(prod);
      if (pair === undefined) continue;
      const [supersort, subsort] = pair;
      const supKey = sortKey(supersort);
      const subKey = sortKey(subsort);
      sorts.set(supKey, supersort);
      sorts.set(subKey, subsort);
      relation.push([supKey, subKey]);
    }
    return { image: freezeImage(computeImage(relation)), sorts };
  }

  /**
   * `KDefinition.subsorts` (`outer.py:1226-1228`): the proper subsorts of
   * `sort`, or an empty list for a sort with none.
   *
   * pyk returns a `frozenset`, whose iteration order is unspecified; this is
   * ordered by {@link sortKey} so it is stable to compare, exactly as
   * `kore/src/definition.ts:485` `subsorts` is.
   */
  subsorts(sort: KSort): readonly KSort[] {
    const index = this.#subsorts();
    const keys = index.image.get(sortKey(sort));
    if (keys === undefined) return NO_SORTS;
    const found: KSort[] = [];
    for (const key of [...keys].toSorted()) {
      const resolved = index.sorts.get(key);
      if (resolved !== undefined) found.push(resolved);
    }
    return Object.freeze(found);
  }

  /**
   * Whether `sub` is a subsort of `sup`, **reflexively**.
   *
   * Not in pyk — upstream spells it `sort in defn.subsorts(other)`, which is
   * the strict version — but it is what every caller actually wants, and it is
   * the same contract `kore/src/definition.ts` `isSubsort` offers on the KORE
   * side (`kompiled.py:230-232`).
   */
  isSubsort(sub: KSort, sup: KSort): boolean {
    if (eqSort(sub, sup)) return true;
    return this.#subsorts().image.get(sortKey(sup))?.has(sortKey(sub)) ?? false;
  }

  /**
   * `KDefinition.least_common_supersort` (`outer.py:1380-1390`): the lattice
   * join, **partially**.
   *
   * `undefined` unless one sort is a subsort of the other — upstream's own
   * comment says computing a real LUB is unsupported and that `None` does not
   * mean there is none.  Kept exactly, because `sortOf` and `_add_sort_injections`
   * are calibrated against that partiality.
   */
  leastCommonSupersort(sort1: KSort, sort2: KSort): KSort | undefined {
    if (eqSort(sort1, sort2)) return sort1;
    if (this.#isStrictSubsort(sort1, sort2)) return sort2;
    if (this.#isStrictSubsort(sort2, sort1)) return sort1;
    return undefined;
  }

  /** `KDefinition.greatest_common_subsort` (`outer.py:1392-1403`) — the dual, equally partial. */
  greatestCommonSubsort(sort1: KSort, sort2: KSort): KSort | undefined {
    if (eqSort(sort1, sort2)) return sort1;
    if (this.#isStrictSubsort(sort1, sort2)) return sort1;
    if (this.#isStrictSubsort(sort2, sort1)) return sort2;
    return undefined;
  }

  /** `sort1 in self.subsorts(sort2)` — the strict membership test, without materialising the list. */
  #isStrictSubsort(sub: KSort, sup: KSort): boolean {
    return this.#subsorts().image.get(sortKey(sup))?.has(sortKey(sub)) ?? false;
  }

  //////////////////////////////
  // Sort inference           //
  //////////////////////////////

  /**
   * `KDefinition.resolve_sorts` (`outer.py:1370-1378`): a label's result and
   * argument sorts, with the production's sort *parameters* substituted by the
   * label's.
   *
   * The substitution is **top level only** — a parameter occurring inside a
   * parametric sort's own arguments is not rewritten, upstream or here.
   * `zip(..., strict=True)`: a label whose parameter count disagrees with its
   * production's is an error.
   */
  resolveSorts(label: KLabel): readonly [KSort, readonly KSort[]] {
    const prod = this.#symbolFor(label.name);
    checkArity(prod.params.length, label.params.length, `resolveSorts: ${label.name}`);
    const sorts = new Map<string, KSort>();
    for (const [i, param] of prod.params.entries()) sorts.set(sortKey(param), at(label.params, i));
    const resolve = (sort: KSort): KSort => sorts.get(sortKey(sort)) ?? sort;
    return [resolve(prod.sort), Object.freeze(productionArgumentSorts(prod).map((sort) => resolve(sort)))];
  }

  /**
   * `KDefinition.sort` (`outer.py:1344-1361`) — best-effort sort inference,
   * `undefined` where the algorithm gives up.
   *
   * Named `sortOf` rather than `sort`: `sort` reads as a verb on a class whose
   * other members are verbs, and `KDefinition.sort(term)` would be a trap next
   * to `Array.prototype.sort`.
   *
   * `KToken`/`KVariable` answer with their own sort (a variable without one
   * answers `undefined`), a `KSequence` is always `K`, a `KApply` is
   * {@link resolveSorts}' result sort, a `KRewrite` is the
   * {@link leastCommonSupersort} of its sides, and a `KAs` is `undefined`.
   *
   * **De-recursed.**  Only the `KRewrite` case recurses upstream, and only
   * into `lhs` and `rhs`, so the machine here is a two-slot post-order over
   * the rewrite spine — nested rewrites are legal KAST and this file does not
   * recurse.
   */
  sortOf(term: KInner): KSort | undefined {
    const stack: { readonly rewrite: KRewrite; readonly results: (KSort | undefined)[] }[] = [];
    let pending: KInner | undefined = term;
    let value: KSort | undefined;
    for (;;) {
      if (pending !== undefined) {
        if (pending.node === "KRewrite") {
          // Annotated because `pending` is reassigned from this very binding,
          // which tsc otherwise reads as a circular inference (TS7022).
          const rewrite: KRewrite = pending;
          stack.push({ rewrite, results: [] });
          pending = rewrite.lhs;
          continue;
        }
        value = this.#sortDirect(pending);
        pending = undefined;
      }
      const top = stack.pop();
      if (top === undefined) return value;
      top.results.push(value);
      if (top.results.length === 1) {
        stack.push(top);
        pending = top.rewrite.rhs;
        continue;
      }
      // Plain indexing, not `at()`: a side with no determinable sort stores a
      // legitimate `undefined` here, which must flow into the guard below —
      // `if lhs_sort and rhs_sort … return None` (`outer.py:1350-1353`).
      const lhsSort = top.results[0];
      const rhsSort = top.results[1];
      value = lhsSort !== undefined && rhsSort !== undefined ? this.leastCommonSupersort(lhsSort, rhsSort) : undefined;
    }
  }

  /** Every {@link sortOf} case but `KRewrite`, which is the only recursive one. */
  #sortDirect(term: KInner): KSort | undefined {
    switch (term.node) {
      case "KToken":
        return term.sort;
      case "KVariable":
        return term.sort;
      case "KSequence":
        return K;
      case "KApply":
        return this.resolveSorts(term.label)[0];
      // `case _: return None` (`outer.py:1360-1361`) — a `KAs` has no sort, and
      // a `KRewrite` never reaches here.
      case "KAs":
      case "KRewrite":
        return undefined;
      default:
        return exhausted(term);
    }
  }

  /** `KDefinition.sort_strict` (`outer.py:1363-1368`) — {@link sortOf}, or an error. */
  sortStrict(term: KInner): KSort {
    const sort = this.sortOf(term);
    if (sort === undefined) throw new TypeError(`Could not determine sort of term: ${JSON.stringify(toDict(term))}`);
    return sort;
  }

  /**
   * `KDefinition.add_ksequence_under_k_productions` (`outer.py:1405-1421`).
   *
   * A sort like `Int` cannot inject straight into `K`, so an argument sitting
   * in a position the production declares as `K` — and whose own sort is not
   * already `K` — is wrapped in a one-element `KSequence`.  `zip(strict=True)`:
   * an application whose arity disagrees with its production is an error.
   */
  addKsequenceUnderKProductions(kast: KInner): KInner {
    const wrap = (term: KInner): KInner => {
      if (term.node !== "KApply") return term;
      const prod = this.#symbolFor(term.label.name);
      const argSorts = productionArgumentSorts(prod);
      checkArity(argSorts.length, term.args.length, `addKsequenceUnderKProductions: ${term.label.name}`);
      return kapply(
        term.label,
        term.args.map((arg, i) => {
          const sort = at(argSorts, i);
          if (sort.name !== "K") return arg;
          const argSort = this.sortOf(arg);
          return argSort !== undefined && eqSort(argSort, K) ? arg : ksequence([arg]);
        }),
      );
    };
    return topDown(wrap, kast);
  }

  /**
   * `KDefinition.sort_vars` (`outer.py:1423-1500`): give every variable the
   * most specific sort its occurrences agree on.
   *
   * Bottom-up, accumulating per variable *name* the list of sorted occurrences
   * the term demands — a variable in an argument position gets the
   * production's argument sort, a variable in a `KSequence` gets `KItem`
   * (or `K` in the last position) — then reconciling them with
   * {@link greatestCommonSubsort} and substituting.  Conflicting sorts are an
   * error, not a silent widening.
   *
   * Three contracts callers depend on:
   *
   * - The optional `sort` applies to **one** shape only: a bare unsorted
   *   `KVariable` at the very top (`outer.py:1427-1428`).  It is not a
   *   whole-term expectation and does not propagate.
   * - `#Exists` / `#Forall` bind their first argument: that variable is
   *   resolved and substituted *inside* the quantifier and then removed from
   *   the occurrence map, so an outer occurrence of the same name is
   *   independent (`outer.py:1467-1472`).
   * - `kruleToKore` calls this **once** on a synthetic `KRewrite(lhs, rhs)`
   *   (`_kast_to_kore.py:253`) precisely so both sides agree on a variable's
   *   sort.  That is why it takes a term rather than a rule.
   *
   * Sort *parameters* defeat it: a production with any `params` contributes no
   * argument-sort demands at all (`outer.py:1479`), because the parameter is
   * not a sort until the label carries one.
   */
  sortVars(kast: KInner, sort?: KSort): KInner {
    if (kast.node === "KVariable" && kast.sort === undefined && sort !== undefined) {
      return letKVariable(kast, { sort });
    }

    const transform = (
      term: KInner,
      childOccurrences: readonly VarOccurrences[],
    ): readonly [KInner, VarOccurrences] => {
      const occurrences = mergeVarOccurrences(term, childOccurrences);

      if (term.node === "KApply") {
        if (ML_QUANTIFIERS.has(term.label.name)) {
          const variable = quantifierVariable(term);
          const subst = new Map<string, KInner>();
          this.#addVarToSubst(variable.name, occurrences.get(variable.name) ?? [], subst);
          occurrences.delete(variable.name);
          return [new Subst(subst).apply(term), occurrences];
        }
        const prod = this.#symbolFor(term.label.name);
        if (prod.params.length === 0) {
          const argSorts = productionArgumentSorts(prod);
          checkArity(argSorts.length, term.args.length, `sortVars: ${term.label.name}`);
          term.args.forEach((arg, i) => {
            if (arg.node !== "KVariable") return;
            pushOccurrence(occurrences, arg.name, letKVariable(arg, { sort: at(argSorts, i) }));
          });
        }
      } else if (term.node === "KSequence") {
        term.items.forEach((item, i) => {
          if (item.node !== "KVariable") return;
          if (item.sort !== undefined) pushOccurrence(occurrences, item.name, item);
          else if (i === term.items.length - 1) pushOccurrence(occurrences, item.name, letKVariable(item, { sort: K }));
          else pushOccurrence(occurrences, item.name, letKVariable(item, { sort: K_ITEM }));
        });
      }

      return [term, occurrences];
    };

    const [newTerm, varOccurrences] = bottomUpWithSummary(transform, kast);
    const subst = new Map<string, KInner>();
    for (const [name, occurrences] of varOccurrences) this.#addVarToSubst(name, occurrences, subst);
    return new Subst(subst).apply(newTerm);
  }

  /**
   * `add_var_to_subst` (`outer.py:1455-1465`): fold the distinct sorts a
   * variable's occurrences demand with {@link greatestCommonSubsort}.
   *
   * "Distinct" is `utils.unique` — order-preserving, first occurrence wins —
   * so the fold starts at the *first* sort seen and the error message names
   * the pair that failed, as upstream's does.
   */
  #addVarToSubst(name: string, occurrences: readonly KVariable[], subst: Map<string, KInner>): void {
    const seen = new Set<string>();
    const sorts: KSort[] = [];
    for (const occurrence of occurrences) {
      if (occurrence.sort === undefined) continue;
      const key = sortKey(occurrence.sort);
      if (seen.has(key)) continue;
      seen.add(key);
      sorts.push(occurrence.sort);
    }
    if (sorts.length === 0) return;
    let sort = at(sorts, 0);
    for (const other of sorts.slice(1)) {
      const merged = this.greatestCommonSubsort(sort, other);
      if (merged === undefined) {
        // `sortKey`, not `.name`: parametric sorts differing only in their
        // parameters would otherwise produce identical messages.
        throw new TypeError(`Cannot compute greatest common subsort of ${name}: (${sortKey(sort)}, ${sortKey(other)})`);
      }
      sort = merged;
    }
    subst.set(name, kvariable(name, sort));
  }

  /**
   * `KDefinition.add_sort_params` (`outer.py:1503-1529`): fill a `KLabel`'s
   * missing sort parameters in from the sorts of the arguments sitting in the
   * parameter positions.
   *
   * Best-effort and context-insensitive: an argument whose sort
   * {@link sortOf} cannot determine, or two occurrences of one parameter
   * disagreeing, leave the application untouched.  pyk logs a warning in both
   * cases (`outer.py:1513,1521`); this package has no logger, so the term
   * coming back unchanged is the only signal — the same signal upstream
   * callers actually act on.
   *
   * One divergence: the arity check is eager here, where pyk's
   * `zip(…, strict=True)` over a lazy `map(self.sort, …)` may `return` from
   * inside the loop — behind an earlier undeterminable argument — before the
   * mismatch is ever observed.  A mis-arity application is malformed input
   * either way; this port prefers the loud answer.
   */
  addSortParams(kast: KInner): KInner {
    const fill = (term: KInner): KInner => {
      if (term.node !== "KApply") return term;
      const prod = this.#symbolFor(term.label.name);
      if (term.label.params.length > 0 || prod.params.length === 0) return term;

      const argSorts = productionArgumentSorts(prod);
      checkArity(argSorts.length, term.args.length, `addSortParams: ${term.label.name}`);
      const params = new Set(prod.params.map((param) => sortKey(param)));
      const sortDict = new Map<string, KSort>();
      for (const [i, psort] of argSorts.entries()) {
        const asort = this.sortOf(at(term.args, i));
        if (asort === undefined) return term;
        const pkey = sortKey(psort);
        if (!params.has(pkey)) continue;
        const bound = sortDict.get(pkey);
        if (bound === undefined) sortDict.set(pkey, asort);
        else if (!eqSort(bound, asort)) return term;
      }
      if (!prod.params.every((param) => sortDict.has(sortKey(param)))) return term;
      return letKApply(term, {
        label: klabel(
          term.label.name,
          prod.params.map((param) => notNone(sortDict.get(sortKey(param)), "sort parameter")),
        ),
      });
    };
    return bottomUp(fill, kast);
  }

  //////////////////////////////
  // Unparser indices         //
  //////////////////////////////

  /**
   * `KDefinition.brackets` (`outer.py:1230-1241`): the `bracket` productions,
   * keyed by the {@link sortKey} of the sort they bracket.
   *
   * A bracket production has no `klabel` — upstream `assert`s it — and there
   * can be at most one per sort.  The label the formatter builds an
   * application with comes from the production's `bracketLabel` attribute
   * instead; {@link syntaxSymbols} is that index.
   */
  get brackets(): ReadonlyMap<string, KProduction> {
    return (this.#brackets ??= this.#computeBrackets());
  }

  #computeBrackets(): ReadonlyMap<string, KProduction> {
    const brackets = new Map<string, KProduction>();
    for (const prod of this.productions) {
      if (!prod.att.has(Atts.BRACKET)) continue;
      if (prod.klabel !== undefined) {
        throw new TypeError(`Bracket production must not have a klabel: ${prod.klabel.name}`);
      }
      const key = sortKey(prod.sort);
      if (brackets.has(key)) throw new TypeError(`Multiple bracket productions for sort: ${prod.sort.name}`);
      brackets.set(key, prod);
    }
    return brackets;
  }

  /**
   * `KDefinition.syntax_symbols` (`outer.py:1258-1264`): {@link symbols}
   * overlaid with the {@link brackets}, keyed by their `bracketLabel`'s
   * `name`.
   *
   * The bracket entries win on a collision, as the `{**symbols, **brackets}`
   * merge does upstream.
   */
  get syntaxSymbols(): ReadonlyMap<string, KProduction> {
    return (this.#syntaxSymbols ??= this.#computeSyntaxSymbols());
  }

  #computeSyntaxSymbols(): ReadonlyMap<string, KProduction> {
    const result = new Map<string, KProduction>(this.symbols);
    for (const prod of this.brackets.values()) result.set(bracketLabelName(prod), prod);
    return result;
  }

  /**
   * `KDefinition.overloads` (`outer.py:1266-1305`): overloaded symbol → the
   * set of symbols that overload it (i.e. the *more specific* ones).
   *
   * Two productions in the same `overload` group are ordered by a **pointwise**
   * comparison of `[sort, ...argumentSorts]`: every position must be equal or a
   * subsort, and at least one must be a strict subsort.  Differing arities
   * compare as incomparable rather than as an error.
   *
   * Note the index direction — the key is the *overloaded* (more general)
   * symbol, which is what `_overload_axioms` (`_module_to_kore.py:658-698`)
   * looks up.
   */
  get overloads(): ReadonlyMap<string, ReadonlySet<string>> {
    return (this.#overloads ??= this.#computeOverloads());
  }

  #computeOverloads(): ReadonlyMap<string, ReadonlySet<string>> {
    const lt = (overloader: KProduction, overloaded: KProduction): boolean => {
      const overloaderSorts = [overloader.sort, ...productionArgumentSorts(overloader)];
      const overloadedSorts = [overloaded.sort, ...productionArgumentSorts(overloaded)];
      if (overloaderSorts.length !== overloadedSorts.length) return false;
      let less = false;
      for (const [i, overloaderSort] of overloaderSorts.entries()) {
        const overloadedSort = at(overloadedSorts, i);
        if (eqSort(overloaderSort, overloadedSort)) continue;
        if (this.#isStrictSubsort(overloaderSort, overloadedSort)) {
          less = true;
          continue;
        }
        return false;
      }
      return less;
    };

    const symbolsByOverload = new Map<string, string[]>();
    for (const [symbol, prod] of this.symbols) {
      const group = prod.att.get(Atts.OVERLOAD);
      if (group === undefined) continue;
      const members = symbolsByOverload.get(group);
      if (members === undefined) symbolsByOverload.set(group, [symbol]);
      else members.push(symbol);
    }

    const overloads = new Map<string, Set<string>>();
    const record = (overloader: string, overloaded: string): void => {
      if (overloader === overloaded) return;
      if (!lt(this.#symbolFor(overloader), this.#symbolFor(overloaded))) return;
      // Indexed by the *overloaded* symbol, so a lookup is one step.
      addToSetMap(overloads, overloaded, overloader);
    };
    for (const members of symbolsByOverload.values()) {
      for (const overloader of members) {
        for (const overloaded of members) record(overloader, overloaded);
      }
    }
    return freezeImage(overloads);
  }

  /**
   * `KDefinition.priorities` (`outer.py:1307-1320`): symbol → the set of
   * symbols with **lower** priority, transitively closed.
   *
   * A `KSyntaxPriority` sentence is a list of tag groups, highest first; each
   * consecutive pair of groups (`itertools.pairwise`) contributes the full
   * cross product from the higher group to the lower, and {@link computeImage}
   * closes the result.
   */
  get priorities(): ReadonlyMap<string, ReadonlySet<string>> {
    return (this.#priorities ??= this.#computePriorities());
  }

  #computePriorities(): ReadonlyMap<string, ReadonlySet<string>> {
    const relation: (readonly [string, string])[] = [];
    // `pairwise(priorities)` × `product(highers, lowers)` (`outer.py:1313-1318`).
    const crossPairs = (sentence: KSyntaxPriority): void => {
      for (let i = 0; i + 1 < sentence.priorities.length; i++) {
        for (const higher of at(sentence.priorities, i)) {
          for (const lower of at(sentence.priorities, i + 1)) relation.push([higher, lower]);
        }
      }
    };
    for (const module of this.modules) {
      for (const sentence of module.sentences) {
        if (sentence.node === "KSyntaxPriority") crossPairs(sentence);
      }
    }
    return freezeImage(computeImage(relation));
  }

  /** `KDefinition.left_assocs` (`outer.py:1321-1324`). */
  get leftAssocs(): ReadonlyMap<string, ReadonlySet<string>> {
    return (this.#leftAssocs ??= this.#computeAssocs(KAssoc.LEFT));
  }

  /** `KDefinition.right_assocs` (`outer.py:1325-1328`). */
  get rightAssocs(): ReadonlyMap<string, ReadonlySet<string>> {
    return (this.#rightAssocs ??= this.#computeAssocs(KAssoc.RIGHT));
  }

  /**
   * `KDefinition._assocs` (`outer.py:1329-1342`): tag → every tag it shares a
   * `KSyntaxAssociativity` sentence with, **including itself**
   * (`product(tags, tags)` is not the strict product).
   *
   * The one thing to get right: a `non-assoc` sentence matches *both*
   * directions (`outer.py:1334`, `sent.assoc in (assoc, KAssoc.NON_ASSOC)`),
   * so its tags land in {@link leftAssocs} **and** {@link rightAssocs} — which
   * is what Scala's `outer.scala:450` does, and is exactly what makes a
   * non-associative operator need brackets on either side.
   *
   * Unlike {@link priorities} this is **not** transitively closed; upstream
   * builds a plain dict of sets, not a `POSet`.
   */
  #computeAssocs(assoc: KAssoc): ReadonlyMap<string, ReadonlySet<string>> {
    const result = new Map<string, Set<string>>();
    const square = (tags: ReadonlySet<string>): void => {
      for (const key of tags) {
        for (const value of tags) addToSetMap(result, key, value);
      }
    };
    for (const module of this.modules) {
      for (const sentence of module.sentences) {
        if (sentence.node !== "KSyntaxAssociativity") continue;
        if (sentence.assoc !== assoc && sentence.assoc !== KAssoc.NON_ASSOC) continue;
        square(sentence.tags);
      }
    }
    return freezeImage(result);
  }

  /**
   * `KAst.hash` (`kast.py:32-35`) for a definition — the sha256 of its
   * canonical JSON, which is the identity `ktool/kprint.py:238-240` hands out
   * as `KPrint.backend_hash`-adjacent state.
   */
  get hash(): string {
    return (this.#hash ??= hashOfDict(this.toDict()));
  }

  /** `KDefinition.cell_collection_productions` (`outer.py:1133-1136`). */
  get cellCollectionProductions(): readonly KProduction[] {
    return (this.#cellCollectionProductions ??= Object.freeze(
      this.modules.flatMap((module) => [...moduleCellCollectionProductions(module)]),
    ));
  }

  /** `KDefinition.cell_map_item_info` (`outer.py:1138-1155`). */
  get cellMapItemInfo(): CellMapItemInfo {
    return (this.#cellMapItemInfo ??= this.#computeCellMapItemInfo());
  }

  #computeCellMapItemInfo(): CellMapItemInfo {
    const result = new Map<string, readonly [string, KSort]>();
    for (const ccp of this.cellCollectionProductions) {
      const cellLabel = ccp.att.get(Atts.WRAP_ELEMENT);
      const elementCtor = ccp.att.get(Atts.ELEMENT);
      if (cellLabel === undefined || elementCtor === undefined) continue;
      const ctorName = attText(elementCtor);
      const ctorProd = this.symbols.get(ctorName);
      if (ctorProd === undefined) continue;
      result.set(attText(cellLabel), [ctorName, ctorProd.sort]);
    }
    return result;
  }

  /**
   * `KDefinition.production_for_cell_sort` (`outer.py:1198-1214`).
   *
   * A cell sort has several productions — a projection, an initializer, and
   * the actual `<cell>` one; this returns the one carrying `cell`.
   */
  productionForCellSort(sort: KSort): KProduction {
    if (!sort.name.endsWith("Cell")) {
      throw new TypeError(
        `Method productionForCellSort only intended to be called on sorts ending in "Cell", not: ${sort.name}`,
      );
    }
    try {
      return single(this.productions.filter((prod) => eqSort(prod.sort, sort) && prod.att.has(Atts.CELL)));
    } catch (error) {
      throw new TypeError(`Expected a single cell production for sort ${sort.name}`, { cause: error });
    }
  }

  /**
   * `KDefinition.add_cell_map_items` (`outer.py:1531-1563`).
   *
   * Wraps `<cell>(...)` children in the `…CellMapItem` constructor the
   * frontend generates — but only where the parent position expects the *map*
   * sort.  The guard on `argSort == elementCtorSort` is the v7.1.337
   * regression fix `tests/unit/kast/test_definition.py` pins.
   */
  addCellMapItems(kast: KInner): KInner {
    const info = this.cellMapItemInfo;
    const wrapElements = (term: KInner): KInner => {
      if (term.node !== "KApply") return term;
      const prod = this.symbols.get(term.label.name);
      if (prod === undefined) return term;
      if (!term.args.some((arg) => arg.node === "KApply" && info.has(arg.label.name))) return term;
      const argSorts = productionArgumentSorts(prod);
      checkArity(argSorts.length, term.args.length, `addCellMapItems: ${term.label.name}`);
      const newArgs = term.args.map((arg, i) => {
        if (arg.node !== "KApply") return arg;
        const entry = info.get(arg.label.name);
        if (entry === undefined) return arg;
        const [elementCtor, elementCtorSort] = entry;
        if (!eqSort(at(argSorts, i), elementCtorSort)) return arg;
        return kapply(elementCtor, [at(arg.args, 0), arg]);
      });
      return letKApply(term, { args: newArgs });
    };
    // `outer.py:1561-1562`: strip first, so a second call cannot double-wrap.
    return bottomUp(wrapElements, this.removeCellMapItems(kast));
  }

  /** `KDefinition.remove_cell_map_items` (`outer.py:1565-1580`). */
  removeCellMapItems(kast: KInner): KInner {
    const cellWrappers = new Map<string, string>();
    for (const [label, [ctor]] of this.cellMapItemInfo) cellWrappers.set(ctor, label);

    const unwrapElements = (term: KInner): KInner => {
      if (term.node !== "KApply") return term;
      const wrapped = cellWrappers.get(term.label.name);
      if (wrapped === undefined || term.args.length !== 2) return term;
      const second = at(term.args, 1);
      if (second.node !== "KApply" || second.label.name !== wrapped) return term;
      return second;
    };
    return bottomUp(unwrapElements, kast);
  }

  /**
   * `KDefinition.empty_config` (`outer.py:1582-1609`): the configuration's
   * constructor skeleton, with a fresh variable in every non-cell position.
   *
   * The variable's name is the cell sort minus its `Cell` suffix, uppercased,
   * plus `_CELL` — `KCell` gives `K_CELL`.
   */
  emptyConfig(sort: KSort): KInner {
    const key = sortKey(sort);
    const cached = this.#emptyConfig.get(key);
    if (cached !== undefined) return cached;
    const computed = this.#computeEmptyConfig(sort);
    this.#emptyConfig.set(key, computed);
    return computed;
  }

  /** `_compute_empty_config` (`outer.py:1588-1609`). */
  #computeEmptyConfig(sort: KSort): KInner {
    const build = (cellSort: KSort): KApply => {
      const cellProd = this.productionForCellSort(cellSort);
      const cellKlabel = cellProd.klabel;
      if (cellKlabel === undefined) throw new TypeError(`Cell production without a label: ${cellSort.name}`);
      const production = this.#symbolFor(cellKlabel.name);
      const args: KInner[] = [];
      let numNonterminals = 0;
      let numFreshvars = 0;
      for (const item of production.items) {
        if (item.node !== "KNonTerminal") continue;
        numNonterminals += 1;
        if (item.sort.name.endsWith("Cell")) {
          args.push(build(item.sort));
        } else {
          numFreshvars += 1;
          args.push(kvariable(`${cellSort.name.slice(0, -4).toUpperCase()}_CELL`));
        }
      }
      if (numNonterminals > 1 && numFreshvars > 0) {
        // `outer.py:1606` reports the *outer* sort, not `_sort`; kept.
        throw new TypeError(`Found mixed cell and non-cell arguments to cell constructor for: ${sort.name}`);
      }
      return kapply(cellKlabel, args);
    };
    return build(sort);
  }

  /**
   * `KDefinition.instantiate_cell_vars` (`outer.py:1611-1627`): replace a
   * variable sitting where a cell should be with that cell's empty config.
   */
  instantiateCellVars(term: KInner): KInner {
    const cellVarsToLabels = (kast: KInner): KInner => {
      if (!isCell(kast)) return kast;
      const production = this.#symbolFor(kast.label.name);
      const productionArity = productionNonTerminals(production).map((nt) => nt.sort);
      checkArity(productionArity.length, kast.args.length, `instantiateCellVars: ${kast.label.name}`);
      const newArgs = kast.args.map((arg, i) => {
        const sort = at(productionArity, i);
        if (sort.name.endsWith("Cell") && arg.node === "KVariable") return this.emptyConfig(sort);
        return arg;
      });
      return kapply(kast.label, newArgs);
    };
    return bottomUp(cellVarsToLabels, term);
  }

  /**
   * `KDefinition.init_config` (`outer.py:1629-1670`): the configuration as the
   * semantics declares it, with `$PGM`-style configuration variables in place.
   *
   * Runs the definition's `initializer` rules to a fixpoint with
   * {@link indexedRewrite}, then rewrites every surviving
   * `project:S(Map:lookup(CONFIG_VAR_MAP, #token("$X", "KConfigVar")))` back
   * into the variable `$X`.
   */
  initConfig(sort: KSort): KInner {
    const key = sortKey(sort);
    const cached = this.#initConfig.get(key);
    if (cached !== undefined) return cached;
    const computed = this.#computeInitConfig(sort);
    this.#initConfig.set(key, computed);
    return computed;
  }

  /** `_compute_init_config` (`outer.py:1635-1670`). */
  #computeInitConfig(sort: KSort): KInner {
    const configVarMap = kvariable(CONFIG_VAR_MAP_NAME);
    const mapLookup = klabel("Map:lookup");

    const removeConfigVarLookups = (kast: KInner): KInner => {
      if (kast.node !== "KApply" || !kast.label.name.startsWith("project:") || kast.args.length !== 1) return kast;
      const term = at(kast.args, 0);
      if (term.node !== "KApply" || !eqLabel(term.label, mapLookup) || term.args.length < 2) return kast;
      if (!eq(at(term.args, 0), configVarMap)) return kast;
      const tokenVar = at(term.args, 1);
      if (tokenVar.node !== "KToken" || !eqSort(tokenVar.sort, KCONFIG_VAR_SORT)) return kast;
      return kvariable(tokenVar.token);
    };

    let initProd: KProduction;
    try {
      initProd = single(
        this.syntaxProductions.filter((prod) => prod.att.has(Atts.INITIALIZER) && eqSort(prod.sort, sort)),
      );
    } catch (error) {
      throw new TypeError(`Did not find unique initializer for sort: ${sort.name}`, { cause: error });
    }

    const prodKlabel = initProd.klabel;
    if (prodKlabel === undefined) throw new TypeError(`Initializer production without a label: ${sort.name}`);
    const argSorts = productionArgumentSorts(initProd);

    let initConfig: KInner;
    if (argSorts.length === 0) {
      initConfig = kapply(prodKlabel);
    } else if (argSorts.length === 1 && eqSort(at(argSorts, 0), MAP_SORT)) {
      initConfig = kapply(prodKlabel, [configVarMap]);
    } else {
      throw new TypeError(`Cannot handle initializer for label: ${prodKlabel.name}`);
    }

    const initRewrites = this.rules.flatMap((rule) =>
      rule.att.has(Atts.INITIALIZER) && rule.body.node === "KRewrite" ? [rule.body] : [],
    );

    initConfig = indexedRewrite(initConfig, initRewrites);
    return topDown(removeConfigVarLookups, initConfig);
  }

  /** `self.symbols[name]`, with the `KeyError` turned into a message. */
  #symbolFor(name: string): KProduction {
    const prod = this.symbols.get(name);
    if (prod === undefined) throw new TypeError(`Symbol not found in definition: ${name}`);
    return prod;
  }
}

export interface KDefinitionChanges {
  readonly mainModuleName?: string;
  readonly allModules?: readonly KFlatModule[];
  readonly requires?: readonly KRequire[];
  readonly att?: KAtt;
}

/**
 * The names in an arbitrary module's import closure, breadth-first and
 * including the named module itself.
 *
 * This deliberately does not reuse {@link KDefinition.moduleNames}: that
 * getter is, and remains, specifically the main module's closure.
 */
export function moduleImportClosureNames(definition: KDefinition, moduleName: string): readonly string[] {
  const queue = [moduleName];
  const names: string[] = [];
  const seen = new Set<string>();
  while (queue.length > 0) {
    const name = queue.shift();
    if (name === undefined || seen.has(name)) continue;
    const module = definition.module(name);
    seen.add(name);
    names.push(name);
    for (const imported of module.imports) queue.push(imported.name);
  }
  return Object.freeze(names);
}

/** The modules in an arbitrary named module's import closure. */
export function moduleImportClosure(definition: KDefinition, moduleName: string): readonly KFlatModule[] {
  return Object.freeze(moduleImportClosureNames(definition, moduleName).map((name) => definition.module(name)));
}

/** The productions declared locally by an arbitrary named module. */
export function moduleLocalProductions(definition: KDefinition, moduleName: string): readonly KProduction[] {
  return moduleProductions(definition.module(moduleName));
}

/**
 * The direct subsort edges available to an arbitrary named module, retaining
 * their declaring productions rather than collapsing them into a closure.
 */
export function moduleImportSubsortEdges(definition: KDefinition, moduleName: string): readonly SubsortEdge[] {
  return Object.freeze(moduleImportClosure(definition, moduleName).flatMap((module) => moduleSubsortEdges(module)));
}

/** `KDefinition.let_att` (`outer.py:1078-1079`) as an `att.ts` `LetAtt`. */
export function letDefinitionAtt(definition: KDefinition, att: KAtt): KDefinition {
  return definition.letAtt(att);
}

/** `outer.py:1636` — the placeholder the initializer rules thread the config map through. */
const CONFIG_VAR_MAP_NAME = "__###CONFIG_VAR_MAP###__";

/** `KSort('Map')` (`outer.py:1659`) — the only initializer argument sort K generates. */
const MAP_SORT: KSort = ksort("Map");

/** `KSort('KConfigVar')` (`outer.py:1643`) — the sort of a `$PGM`-style token. */
const KCONFIG_VAR_SORT: KSort = ksort("KConfigVar");

/**
 * A stable string key for a `KSort`.
 *
 * pyk keys its sort-indexed dicts by `KSort` *objects*, which are frozen
 * dataclasses and so compare and hash structurally.  JS `Map` keys compare by
 * identity, so the structural identity has to be spelled out; the sort's
 * canonical JSON is exactly it, and it distinguishes `Map{Int, K}` from
 * `Map{K, Int}` where a bare `.name` would not.  Every sort-keyed `Map` this
 * package exposes — {@link KDefinition.subsortTable},
 * {@link KDefinition.brackets} — is keyed with this, as
 * `kore/src/definition.ts:361` is on the KORE side.
 */
export function sortKey(sort: KSort): string {
  return canonicalJson(sortToDict(sort));
}

/**
 * Structural equality on productions, over their canonical JSON — the same
 * decision procedure {@link KAtt.equals} uses, and the one `symbols` needs.
 */
function eqProduction(a: KProduction, b: KProduction): boolean {
  return canonicalJson(sentenceToDict(a)) === canonicalJson(sentenceToDict(b));
}

/**
 * Whether two productions can denote the same K symbol.
 *
 * This is the deliberately asymmetric `KDefinition.symbols` parity rule from
 * pyk: source attribution is ignored by applying the first production's
 * source-stripped attributes to both sides.  Consumers that index labels over
 * an import closure must use this rule too, or they reject definitions whose
 * own `symbols` index accepts them.
 */
export function sameSymbolProduction(a: KProduction, b: KProduction): boolean {
  const att = a.att.dropSource();
  return eqProduction(letKProduction(a, { att }), letKProduction(b, { att }));
}

/** {@link eqProduction} for any sentence — `sent != unique_id_map[unique_id]` (`outer.py:1190`). */
function eqSentence(a: KSentence, b: KSentence): boolean {
  return canonicalJson(sentenceToDict(a)) === canonicalJson(sentenceToDict(b));
}

/** `is_semantic` (`outer.py:1176-1182`). */
function isSemanticRule(rule: KRule): boolean {
  const body = rule.body;
  if (body.node === "KApply") return body.label.name === GENERATED_TOP_LABEL;
  if (body.node === "KRewrite") return body.lhs.node === "KApply" && body.lhs.label.name === GENERATED_TOP_LABEL;
  return false;
}

/** `'<generatedTop>'` (`outer.py:1177,1180`) — the head of a whole configuration. */
const GENERATED_TOP_LABEL = "<generatedTop>";

/**
 * `prod.att[Atts.BRACKET_LABEL]['name']` (`outer.py:1261`), with the
 * `ANY_TYPE` unpacked — the label a `bracket` production's applications carry,
 * since the production itself has no `klabel`.
 */
export function bracketLabelName(prod: KProduction): string {
  const label = prod.att.get(Atts.BRACKET_LABEL);
  if (label === null || typeof label !== "object" || isArray(label)) {
    throw new TypeError(`Bracket production has no bracketLabel object: ${prod.sort.name}`);
  }
  const name = label["name"];
  if (typeof name !== "string") throw new TypeError(`bracketLabel has no name: ${prod.sort.name}`);
  return name;
}

/** The closed subsort relation plus the sorts its keys came from. */
interface SubsortIndex {
  /** Supersort key → the keys of all its proper, transitive subsorts. */
  readonly image: ReadonlyMap<string, ReadonlySet<string>>;
  /** Every sort key seen, back to the `KSort` it came from. */
  readonly sorts: ReadonlyMap<string, KSort>;
}

//////////////////////////////
// sort_vars scaffolding    //
//////////////////////////////

/** `ml_quantifiers` (`outer.py:1425`) — the two binders `sortVars` scopes over. */
const ML_QUANTIFIERS: ReadonlySet<string> = new Set(["#Exists", "#Forall"]);

/** Variable name → every occurrence carrying a sort demand, in traversal order. */
type VarOccurrences = Map<string, KVariable[]>;

/** `get_quantifier_variable` (`outer.py:1430-1436`). */
function quantifierVariable(term: KApply): KVariable {
  if (term.args.length !== 2) {
    throw new TypeError(`Expected a quantifier to have 2 children, got ${term.args.length}.`);
  }
  const variable = at(term.args, 0);
  if (variable.node !== "KVariable") {
    throw new TypeError(`Expected a quantifier's first child to be a variable, got ${variable.node}.`);
  }
  return variable;
}

/** `defaultdict(list)` append. */
function pushOccurrence(occurrences: VarOccurrences, name: string, variable: KVariable): void {
  const list = occurrences.get(name);
  if (list === undefined) occurrences.set(name, [variable]);
  else list.push(variable);
}

/**
 * `merge_variables` (`outer.py:1438-1453`): concatenate the children's
 * occurrence maps, then add this node's own contribution — the variable
 * itself, or a quantifier's bound variable.
 */
function mergeVarOccurrences(term: KInner, childOccurrences: readonly VarOccurrences[]): VarOccurrences {
  const result: VarOccurrences = new Map();
  for (const occurrences of childOccurrences) {
    for (const [name, variables] of occurrences) {
      const list = result.get(name);
      if (list === undefined) result.set(name, [...variables]);
      else list.push(...variables);
    }
  }
  if (term.node === "KVariable") pushOccurrence(result, term.name, term);
  else if (term.node === "KApply" && ML_QUANTIFIERS.has(term.label.name)) {
    const variable = quantifierVariable(term);
    pushOccurrence(result, variable.name, variable);
  }
  return result;
}

//////////////////////////////
// Reading a definition     //
//////////////////////////////

/**
 * `read_kast_definition` (`outer.py:1673-1679`), minus the file I/O: unwrap the
 * `{format: "KAST", version: 4, term}` envelope a `compiled.json` carries, then
 * decode the `KDefinition` inside it.
 *
 * This package does not touch the filesystem — `packages/kast` has no runtime
 * dependency on `node:fs` and should not acquire one for a one-line
 * convenience.  Read the file however your runtime prefers, `JSON.parse` it,
 * and pass the result here (or use {@link readKastDefinitionFromJson}).
 */
export function readKastDefinition(doc: unknown): KDefinition {
  return KDefinition.fromDict(kastTerm(doc), "term");
}

/** {@link readKastDefinition} on the text of a `compiled.json`. */
export function readKastDefinitionFromJson(text: string): KDefinition {
  return readKastDefinition(JSON.parse(text));
}

/** `KDefinition.from_dict` on a bare definition — no envelope (`outer.py:1046`). */
export function definitionFromDict(value: unknown, path = "definition"): KDefinition {
  return KDefinition.fromDict(value, path);
}

/** `KDefinition.to_dict` (`outer.py:1055`). */
export function definitionToDict(definition: KDefinition): JsonObject {
  return definition.toDict();
}
