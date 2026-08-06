/**
 * Definition-level reading utilities: what a parsed `definition.kore`
 * *says*.
 *
 * A real `definition.kore` is 15–71 MB and ~95 % axioms.  {@link parseDefinition}
 * turns it into a {@link Definition}; this module turns that into answers —
 * which sorts, symbols and aliases exist, what subsorts what, what an attribute
 * says, and what kind of rule each axiom encodes.
 *
 * Transcribed from pyk (`k/pyk/src/pyk/kore/`, BSD-3-Clause, K v7.1.337):
 *
 * - `kompiled.py` — `KoreSortTable.for_definition` (subsort closure),
 *   `KoreSymbolTable` (symbol lookup and its duplicate-name policy),
 * - `rule.py` — how a rule kind is recovered from an axiom,
 * - `internal.py` — `KoreDefn`, as a reference for what to index.
 *
 * The `pyk-definition.kore.json` side-car cache (`kompiled.py:36-119`) is
 * deliberately not transcribed: it is a pyk-local file format, not part of what
 * KORE means.
 *
 * Two contract differences from pyk, both deliberate and both load-bearing:
 *
 * 1. **Nothing here throws on real input.**  pyk's `Rule.from_axiom` raises
 *    `ValueError` on any axiom outside the handful of shapes it expects — and a
 *    real `definition.kore` contains several (see {@link classifyAxiom}).  Every
 *    function below either answers or returns `undefined`/`{kind: "other"}`.
 * 2. **Attribute keys are matched in their mangled spelling.**  `Source` is
 *    {@link ATT_SOURCE}, not `org.kframework.attributes.Source`; demangling
 *    lives in `demangle.ts` and this module does not depend on it.
 *
 * Depth safety: no function here recurses over pattern structure.  The
 * classifier matches at a bounded depth and walks the one unbounded shape (an
 * argument-list conjunction) with a loop.
 *
 * Memory: `parseDefinition(text, {lazyAxioms: true})` yields a `LazyDefinition`
 * whose axioms carry attributes but not bodies, and {@link indexDefinition}
 * accepts one — every table below is built from declarations and attributes
 * alone, so a lazy index is the same index.  {@link classifyAxiom} is the one
 * function here that reads a body, so a `LazyAxiom` has to go through
 * `forceAxiom` before it can be classified.
 */

import type { LazyAxiom, LazyDefinition, LazyModule } from "./parser.js";
import type {
  AliasDecl,
  App,
  Axiom,
  Claim,
  Definition,
  EVar,
  Import,
  Module,
  Pattern,
  Sort,
  SortDecl,
  SymbolDecl,
} from "./syntax.js";
import { koreText } from "./syntax.js";

//////////////////////////
// Attribute keys       //
//////////////////////////

/**
 * The mangled spellings of the attribute keys this module knows about.
 *
 * `kompile` writes attribute keys through `StringUtil.asciiReadableEncodingKore`
 * (`ModuleToKORE.java:2154-2186`), so `org.kframework.attributes.Source` reaches
 * KORE as `org'Stop'kframework'Stop'attributes'Stop'Source` and `UNIQUE_ID` as
 * `UNIQUE'Unds'ID`.  Keys made only of characters KORE's `Id` grammar already
 * allows — `assoc`, `owise`, even `symbol-overload`, since `-` is legal in an
 * `Id` — travel through unchanged.
 *
 * These are the strings to match against `App.symbol`; do not demangle first.
 */

/** `subsort{Sub, Super}()` — attributes.md §Subsort. */
export const ATT_SUBSORT = "subsort";

/** `assoc{}()` — attributes.md §Assoc. */
export const ATT_ASSOC = "assoc";

/** `comm{}()` — attributes.md §Comm. */
export const ATT_COMM = "comm";

/** `idem{}()` — attributes.md §Idem. */
export const ATT_IDEM = "idem";

/** `unit{}()` — attributes.md §Unit. */
export const ATT_UNIT = "unit";

/** `functional{}()` — the totality axiom's marker. */
export const ATT_FUNCTIONAL = "functional";

/** `constructor{}()` — marks no-junk *and* both no-confusion axioms. */
export const ATT_CONSTRUCTOR = "constructor";

/** `symbol-overload{}(greater, lesser)` — `ModuleToKORE.java:958-960`. */
export const ATT_SYMBOL_OVERLOAD = "symbol-overload";

/** `simplification{}()` / `simplification{}("<priority>")` — attributes.md §Simplification. */
export const ATT_SIMPLIFICATION = "simplification";

/** `owise{}()` — attributes.md §Owise.  Implies priority 200. */
export const ATT_OWISE = "owise";

/** `anywhere{}()` — attributes.md §Anywhere. */
export const ATT_ANYWHERE = "anywhere";

/** `priority{}("123")` — attributes.md §Priority. */
export const ATT_PRIORITY = "priority";

/** `label{}("MODULE.name")`. */
export const ATT_LABEL = "label";

/** `UNIQUE'Unds'ID{}("<sha>")` — attributes.md §"Unique ID", mangled from `UNIQUE_ID`. */
export const ATT_UNIQUE_ID = "UNIQUE'Unds'ID";

/** `org'Stop'kframework'Stop'attributes'Stop'Source{}("Source(<path>)")` — attributes.md §Source. */
export const ATT_SOURCE = "org'Stop'kframework'Stop'attributes'Stop'Source";

/** `org'Stop'kframework'Stop'attributes'Stop'Location{}("Location(sl,sc,el,ec)")` — attributes.md §Location. */
export const ATT_LOCATION = "org'Stop'kframework'Stop'attributes'Stop'Location";

/**
 * `function{}()` — attributes.md §Function.  A *symbol declaration* attribute,
 * unlike {@link ATT_FUNCTIONAL} above, which marks the totality axiom.
 */
export const ATT_FUNCTION = "function";

/** `hook{}("MAP.Map")` — the builtin a hooked sort or symbol implements. */
export const ATT_HOOK = "hook";

/** `element{}(LblSetItem{}())` — a collection sort's element wrapper (`internal.py:38`). */
export const ATT_ELEMENT = "element";

/** `concat{}(Lbl'Unds'Set'Unds'{}())` — a collection sort's cons symbol (`internal.py:37`). */
export const ATT_CONCAT = "concat";

/** `sortInjection{}()` — the `inj{From, To}` declaration's marker (`prelude.kore`). */
export const ATT_SORT_INJECTION = "sortInjection";

//////////////////////////
// Printing attributes  //
//////////////////////////

/**
 * The nine attributes `ModuleToKORE` computes for a symbol declaration from
 * the K production it came from (`syntaxAttributes`,
 * `ModuleToKORE.java:1765-1835`).
 *
 * Four are copied straight off the production (`attsToCopy`, `:1793`: `assoc`,
 * `bracket`, `colors`, `comm`) and five are computed (`format` at `:1791`,
 * `colors` again from `color` at `:1812`, `terminals` at `:1822`, and
 * `priorities`/`left`/`right` at `:1824-1832`).
 *
 * They are the KORE-level pretty-printing tables — everything a printer needs to
 * lay a term back out as concrete syntax — and they are in no pyk source.  They
 * are written onto `syntaxDefinition.kore`'s symbol declarations, and (for the
 * builtins at least) onto `definition.kore`'s too.
 */

/** `format{}("%1 %c[%r %2 %c]%r")` — the production's format string, terminals inlined. */
export const ATT_FORMAT = "format";

/** `terminals{}("0101")` — one bit per production item: `1` terminal, `0` non-terminal. */
export const ATT_TERMINALS = "terminals";

/** `colors{}("red,red")` — one color per `%c` in {@link ATT_FORMAT}, comma-separated. */
export const ATT_COLORS = "colors";

/** `priorities{}(Lblfoo{}(), …)` — the labels this one binds tighter than. */
export const ATT_PRIORITIES = "priorities";

/** `left{}(Lblfoo{}(), …)` — the labels this one associates left with. */
export const ATT_LEFT = "left";

/** `right{}(Lblfoo{}(), …)` — the labels this one associates right with. */
export const ATT_RIGHT = "right";

/** `bracket{}()` — the production is a bracket and prints as its contents. */
export const ATT_BRACKET = "bracket";

//////////////////////////
// Attribute helpers    //
//////////////////////////

/**
 * Attributes indexed by key — pyk `WithAttrs.attrs_by_key`
 * (`syntax.py:1824-1826`).
 *
 * An attribute *is* an application pattern (there is no separate attribute node
 * anywhere in this package), and its key is that application's head symbol.
 * Repeated keys: **last wins**, because pyk builds a dict comprehension over the
 * attribute tuple and so does this.
 *
 * A `Map`, not an object: `constructor` is a real and common KORE attribute key,
 * and on a plain object it would collide with `Object.prototype.constructor`.
 */
export function attsByKey(attrs: readonly App[]): ReadonlyMap<string, App> {
  const byKey = new Map<string, App>();
  for (const attr of attrs) byKey.set(attr.symbol, attr);
  return byKey;
}

/** The attribute spelled `key`, or `undefined`.  Last one wins, as {@link attsByKey}. */
export function getAtt(attrs: readonly App[], key: string): App | undefined {
  let found: App | undefined;
  for (const attr of attrs) {
    if (attr.symbol === key) found = attr;
  }
  return found;
}

/** Whether `key` is among `attrs` — pyk's `'key' in axiom.attrs_by_key`. */
export function hasAtt(attrs: readonly App[], key: string): boolean {
  for (const attr of attrs) {
    if (attr.symbol === key) return true;
  }
  return false;
}

/**
 * The single string argument of the attribute spelled `key`.
 *
 * This is the `App(args=(String(v),))` shape that `rule.py`'s `_extract_uid`,
 * `_extract_label` and `_extract_priority` all match on
 * (`rule.py:479-508`).  `undefined` when the attribute is absent or has any
 * other shape — including `key{}()` (no argument at all) and `key{}(a, b)`.
 * Never throws; pyk raises `ValueError` in the same places.
 */
export function attString(attrs: readonly App[], key: string): string | undefined {
  const attr = getAtt(attrs, key);
  if (attr === undefined || attr.args.length !== 1) return undefined;
  const [arg] = attr.args;
  if (arg === undefined || arg.tag !== "String") return undefined;
  return arg.value;
}

/**
 * The attribute's single string argument read as a base-10 integer.
 *
 * `undefined` when absent, not the single-String shape, or not an integer
 * literal — where pyk's `int(p)` would raise.  Leading `+`, surrounding
 * whitespace and a trailing `.0` are all rejected, because `kompile` never
 * writes them and accepting them would mean guessing.
 */
export function attInteger(attrs: readonly App[], key: string): number | undefined {
  const text = attString(attrs, key);
  if (text === undefined || !/^-?\d+$/.test(text)) return undefined;
  return Number.parseInt(text, 10);
}

/**
 * The K source file a declaration came from — attributes.md §Source.
 *
 * The attribute's value is the wrapper `Source(<path>)`, not a bare path, so
 * this returns the unwrapped path.  `undefined` when the attribute is absent or
 * the value is not that wrapper; {@link attString} with {@link ATT_SOURCE} gives
 * the raw value.
 */
export function attSource(attrs: readonly App[]): string | undefined {
  const value = attString(attrs, ATT_SOURCE);
  if (value === undefined) return undefined;
  const match = /^Source\((.*)\)$/s.exec(value);
  return match?.[1];
}

/** A span in a K source file, as `Location(sl,sc,el,ec)` records it. */
export interface SourceLocation {
  /** 1-based line the declaration starts on. */
  readonly startLine: number;
  /** 1-based column the declaration starts at. */
  readonly startColumn: number;
  /** 1-based line the declaration ends on. */
  readonly endLine: number;
  /** 1-based column the declaration ends at. */
  readonly endColumn: number;
}

/**
 * The source span of a declaration — attributes.md §Location.
 *
 * Parses the attribute's `Location(sl,sc,el,ec)` value into numbers.
 * `undefined` when the attribute is absent, is not the single-String shape, or
 * does not have exactly four decimal components — a malformed location is not
 * worth an exception, since attributes are advisory metadata and a caller that
 * asked for one is prepared not to get it.
 */
export function attLocation(attrs: readonly App[]): SourceLocation | undefined {
  const value = attString(attrs, ATT_LOCATION);
  if (value === undefined) return undefined;
  const match = /^Location\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\)$/.exec(value);
  if (match === null) return undefined;
  const [, sl, sc, el, ec] = match;
  if (sl === undefined || sc === undefined || el === undefined || ec === undefined) return undefined;
  return {
    startLine: Number.parseInt(sl, 10),
    startColumn: Number.parseInt(sc, 10),
    endLine: Number.parseInt(el, 10),
    endColumn: Number.parseInt(ec, 10),
  };
}

//////////////////////////
// Definition index     //
//////////////////////////

/**
 * Everything a {@link Definition}'s sentences declare, indexed.
 *
 * Shaped after pyk's `KoreDefn` (`internal.py:66-107`) and the two tables
 * `KompiledKore` holds (`kompiled.py:39-43`), with the module structure kept
 * alongside — pyk flattens `Definition.sentences` across modules
 * (`syntax.py:2237-2238`) and then cannot say which module a symbol came from.
 *
 * **Duplicate names: last wins.**  `KoreSymbolTable.__init__`
 * (`kompiled.py:266-267`) is a dict comprehension over every module's
 * `symbol_decls` in definition order, so a later module's declaration silently
 * replaces an earlier one; {@link indexDefinition} matches that, and applies the
 * same policy to sorts, aliases and module names.  In `kompile` output this
 * never fires — every name is declared once — but a hand-written or
 * concatenated definition can trip it, and matching pyk means a disagreement
 * here is a bug in one of us rather than a difference of opinion.
 *
 * pyk's `with_ml_symbols=True` also chains `ML_SYMBOL_DECLS` in *after* the
 * definition's own symbols, letting the built-in signatures win.  We do not:
 * this package models `\and`, `\equals` and friends as their own pattern tags
 * rather than as applications, so no `App.symbol` in a parsed term is ever an ML
 * head and there is nothing for those declarations to resolve.
 */
export interface LazyKoreDefinitionIndex {
  /** The definition this index was built from. */
  readonly definition: LazyDefinition;
  /** Module names in declaration order, duplicates included. */
  readonly moduleNames: readonly string[];
  /** Module by name; last declaration of a repeated name wins. */
  readonly modules: ReadonlyMap<string, LazyModule>;
  /** `sort`/`hooked-sort` declarations by sort name. */
  readonly sorts: ReadonlyMap<string, SortDecl>;
  /** `symbol`/`hooked-symbol` declarations by symbol name. */
  readonly symbols: ReadonlyMap<string, SymbolDecl>;
  /** `alias … where …` declarations by alias name. */
  readonly aliases: ReadonlyMap<string, AliasDecl>;
  /** Every `import` sentence, in definition order. */
  readonly imports: readonly Import[];
  /**
   * Every axiom, in definition order — pyk `Definition.axioms`
   * (`syntax.py:2241-2242`).
   *
   * A {@link LazyAxiom} appears here exactly where its {@link Axiom} would; use
   * `forceAxiom` on it to get a body.  Under an eager parse — the default — the
   * array holds only `Axiom`s, which is what {@link KoreDefinitionIndex} says.
   */
  readonly axioms: readonly (Axiom | LazyAxiom)[];
  /** Every claim, in definition order.  Claims are never lazy. */
  readonly claims: readonly Claim[];
  /** The subsort relation, closed — see {@link buildSubsortTable}. */
  readonly sortTable: SubsortTable;
}

/**
 * A {@link LazyKoreDefinitionIndex} over an eagerly parsed definition: every
 * axiom has a body, and `definition` is a {@link Definition}.
 *
 * This is what `indexDefinition(parseDefinition(text))` returns, and what every
 * consumer that does not ask for `lazyAxioms` sees.  Functions that only query
 * the tables take the wider type, so they serve both.
 */
export interface KoreDefinitionIndex extends LazyKoreDefinitionIndex {
  readonly definition: Definition;
  readonly modules: ReadonlyMap<string, Module>;
  readonly axioms: readonly Axiom[];
}

/**
 * Index every sentence of `def` — one pass, no pattern traversal.
 *
 * Axiom *bodies* are not touched: an axiom is indexed by identity into
 * {@link KoreDefinitionIndex.axioms}, and its shape is only ever examined when
 * something calls {@link classifyAxiom} on it.  The one exception is the subsort
 * table, which reads axiom *attributes* (not bodies) exactly as pyk does — which
 * is why a definition parsed with `lazyAxioms` indexes to exactly the same
 * tables as an eager one.
 */
export function indexDefinition(def: Definition): KoreDefinitionIndex;
export function indexDefinition(def: LazyDefinition): LazyKoreDefinitionIndex;
export function indexDefinition(def: LazyDefinition): LazyKoreDefinitionIndex {
  const moduleNames: string[] = [];
  const modules = new Map<string, LazyModule>();
  const sorts = new Map<string, SortDecl>();
  const symbols = new Map<string, SymbolDecl>();
  const aliases = new Map<string, AliasDecl>();
  const imports: Import[] = [];
  const axioms: (Axiom | LazyAxiom)[] = [];
  const claims: Claim[] = [];

  for (const module of def.modules) {
    moduleNames.push(module.name);
    modules.set(module.name, module);
    for (const sentence of module.sentences) {
      switch (sentence.tag) {
        case "SortDecl":
          sorts.set(sentence.name, sentence);
          break;
        case "SymbolDecl":
          symbols.set(sentence.symbol.name, sentence);
          break;
        case "AliasDecl":
          aliases.set(sentence.alias.name, sentence);
          break;
        case "Import":
          imports.push(sentence);
          break;
        case "Axiom":
        case "LazyAxiom":
          axioms.push(sentence);
          break;
        case "Claim":
          claims.push(sentence);
          break;
      }
    }
  }

  return {
    definition: def,
    moduleNames,
    modules,
    sorts,
    symbols,
    aliases,
    imports,
    axioms,
    claims,
    sortTable: buildSubsortTable(subsortPairs(axioms)),
  };
}

//////////////////////////
// Subsort closure      //
//////////////////////////

/**
 * The key a {@link Sort} is indexed under: its KORE text.
 *
 * pyk keys its subsort table by `Sort` *objects*, which are frozen dataclasses
 * and so compare and hash structurally (`kompiled.py:215`).  JS `Map` keys
 * compare by identity, so the structural identity has to be spelled out; the
 * sort's own text is exactly it — `SortInt{}`, `SortMap{SortInt{}, SortK{}}`,
 * `R` — and it distinguishes a parametric sort from its instances, which a bare
 * `.name` would not.
 */
export function sortKey(sort: Sort): string {
  return koreText(sort);
}

/**
 * The subsort relation of a definition, transitively closed.
 *
 * pyk `KoreSortTable` (`kompiled.py:212-258`) built on `POSet`
 * (`utils.py:91-114`).  Two properties of that closure that are easy to get
 * wrong:
 *
 * - **Direction.**  `KoreSortTable.__init__` flips each `(sub, super)` pair
 *   before handing it to `POSet` (`kompiled.py:218`), so the table maps a
 *   **supersort to the set of its subsorts** — {@link image} is indexed by the
 *   *super*sort.
 * - **Not reflexive.**  `POSet._compute_image` (`utils.py:100-114`) is Warshall's
 *   transitive closure and nothing else; a sort appears in its own image only if
 *   the definition actually declares a cycle.  Reflexivity is added at *query*
 *   time instead, by {@link isSubsort}'s `sort1 === sort2` case
 *   (`kompiled.py:231-232`).
 */
export interface SubsortTable {
  /** Supersort key to the keys of all its (transitive, proper) subsorts. */
  readonly image: ReadonlyMap<string, ReadonlySet<string>>;
  /** Every sort key seen, back to the {@link Sort} it came from. */
  readonly sorts: ReadonlyMap<string, Sort>;
}

/**
 * The `(subsort, supersort)` pairs a definition's axioms declare — pyk
 * `KoreSortTable.for_definition` (`kompiled.py:221-228`).
 *
 * The declaration is the *attribute*, not the axiom body: every axiom's
 * attributes are scanned for one whose head is {@link ATT_SUBSORT}, and its two
 * **sort parameters** — `subsort{Sub, Super}()`, not its arguments — are the
 * pair.  The axiom body (an `\exists` stating the injection is surjective onto
 * the subsort) is never read.
 *
 * pyk's generator would raise on an attribute with other than two sorts; such an
 * attribute is skipped here instead.
 *
 * A {@link LazyAxiom} is as good as an {@link Axiom} here, since only attributes
 * are read.
 */
export function subsortPairs(axioms: Iterable<Axiom | LazyAxiom>): readonly (readonly [Sort, Sort])[] {
  const pairs: (readonly [Sort, Sort])[] = [];
  for (const axiom of axioms) {
    for (const attr of axiom.attrs) {
      if (attr.symbol !== ATT_SUBSORT || attr.sorts.length !== 2) continue;
      const [sub, sup] = attr.sorts;
      if (sub !== undefined && sup !== undefined) pairs.push([sub, sup]);
    }
  }
  return pairs;
}

/**
 * Warshall's transitive closure over the keys that have outgoing edges — pyk
 * `POSet._compute_image` (`utils.py:100-114`), including its restriction of the
 * domain to `set(image)` (only those keys can contribute a hop).
 *
 * One deviation: the innermost loop iterates a *snapshot* of `image[k]`.  pyk
 * iterates the live set, which Python turns into a `RuntimeError` if the
 * relation has a cycle through `k`; a JS `Set` would instead visit the elements
 * appended during iteration and could spin forever.  On an acyclic relation —
 * every relation `kompile` emits — the two are identical, because only the
 * `i === k` step can touch the set being iterated and everything it would add is
 * already there.
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

/**
 * Build the closed subsort table from `(subsort, supersort)` pairs — pyk
 * `KoreSortTable.__init__` (`kompiled.py:217-219`).  Pair them up with
 * {@link subsortPairs} to get pyk's `for_definition` (`kompiled.py:221-228`).
 */
export function buildSubsortTable(pairs: Iterable<readonly [Sort, Sort]>): SubsortTable {
  const sorts = new Map<string, Sort>();
  const relation: (readonly [string, string])[] = [];
  for (const [sub, sup] of pairs) {
    const subKey = sortKey(sub);
    const supKey = sortKey(sup);
    sorts.set(subKey, sub);
    sorts.set(supKey, sup);
    // Flipped, as `kompiled.py:218` flips it: supersort -> subsort.
    relation.push([supKey, subKey]);
  }
  return { image: computeImage(relation), sorts };
}

function tableOf(from: LazyKoreDefinitionIndex | SubsortTable): SubsortTable {
  return "image" in from ? from : from.sortTable;
}

/** `SortK{}`, the sort every sort is a subsort of — pyk `SORT_K` (`prelude/kore.py`). */
const SORT_K_KEY = "SortK{}";

/**
 * The proper subsorts of `sort`, transitively — the row `pyk` looks up in
 * `_subsort_table` (`kompiled.py:240`).
 *
 * Proper: a sort is not its own subsort here, matching the non-reflexive closure
 * (see {@link SubsortTable}).  Nor is `SortK{}` special-cased — that is
 * {@link isSubsort}'s job, and `\top`-like membership of every sort in `SortK`
 * is not something the table stores.  The result is ordered by sort key so it is
 * stable to compare.
 */
export function subsorts(from: LazyKoreDefinitionIndex | SubsortTable, sort: Sort): readonly Sort[] {
  const table = tableOf(from);
  const keys = table.image.get(sortKey(sort));
  if (keys === undefined) return [];
  const found: Sort[] = [];
  for (const key of [...keys].toSorted()) {
    const resolved = table.sorts.get(key);
    if (resolved !== undefined) found.push(resolved);
  }
  return found;
}

/**
 * Whether `sort1` is a subsort of `sort2` — pyk `KoreSortTable.is_subsort`
 * (`kompiled.py:230-240`), transcribed case for case:
 *
 * 1. equal sorts are subsorts (this is where reflexivity enters),
 * 2. everything is a subsort of `SortK{}`,
 * 3. `SortK{}` is a subsort of nothing else,
 * 4. otherwise, look `sort1` up in `sort2`'s row of the closed table.
 */
export function isSubsort(from: LazyKoreDefinitionIndex | SubsortTable, sort1: Sort, sort2: Sort): boolean {
  const key1 = sortKey(sort1);
  const key2 = sortKey(sort2);
  if (key1 === key2) return true;
  if (key2 === SORT_K_KEY) return true;
  if (key1 === SORT_K_KEY) return false;
  return tableOf(from).image.get(key2)?.has(key1) === true;
}

/**
 * Every sort below both `sort1` and `sort2` — the intersection pyk's
 * `KoreSortTable.meet` computes at `kompiled.py:249-251`, exposed on its own.
 *
 * Reflexively closed on both sides, as pyk's `.union({sort1})` makes it: a sort
 * comparable to the other is in its own intersection.  `SortK{}` is *not*
 * special-cased — pyk reads `_subsort_table` directly here rather than going
 * through `is_subsort` — so `commonSubsorts(t, SortK{}, S)` is empty unless the
 * table happens to relate them.  Ordered by sort key, so it is stable to
 * compare.
 *
 * This exists because {@link meetSorts} answers `undefined` in two very
 * different situations, and this is what tells them apart: empty means no common
 * subsort at all, non-empty means the maximum was not unique.
 */
export function commonSubsorts(
  from: LazyKoreDefinitionIndex | SubsortTable,
  sort1: Sort,
  sort2: Sort,
): readonly Sort[] {
  const table = tableOf(from);
  const key1 = sortKey(sort1);
  const key2 = sortKey(sort2);

  const closure1 = new Set(table.image.get(key1) ?? []).add(key1);
  const closure2 = new Set(table.image.get(key2) ?? []).add(key2);

  const found: Sort[] = [];
  for (const key of [...closure1].toSorted()) {
    if (!closure2.has(key)) continue;
    // A key in a closure came either from the table (so `sorts` has it) or from
    // `sort1`/`sort2` themselves, which may be sorts the table has never seen.
    const resolved = table.sorts.get(key) ?? (key === key1 ? sort1 : key === key2 ? sort2 : undefined);
    if (resolved !== undefined) found.push(resolved);
  }
  return found;
}

/**
 * The greatest common subsort of two sorts — pyk `KoreSortTable.meet`
 * (`kompiled.py:242-258`).
 *
 * When the sorts are comparable this is the smaller of the two, `SortK{}`'s
 * top-ness included, since the comparison goes through {@link isSubsort}.
 * Otherwise it is the common subsort with the most subsorts of its own, which is
 * pyk's stand-in for "the greatest": correct on the tree-shaped lattices
 * `kompile` emits, and undefined behaviour on anything else.
 *
 * `undefined` where pyk raises, in both of its cases:
 *
 * - no common subsort — pyk's explicit `ValueError` (`kompiled.py:252-253`);
 * - the maximum is not unique — pyk's `(subsort,) = max_subsorts`
 *   (`kompiled.py:257`), an unguarded single-element unpack whose `ValueError`
 *   says nothing about what went wrong.
 *
 * A caller that asked for a meet is prepared not to get one; {@link
 * commonSubsorts} distinguishes the two cases for a caller that cares.
 */
export function meetSorts(from: LazyKoreDefinitionIndex | SubsortTable, sort1: Sort, sort2: Sort): Sort | undefined {
  if (isSubsort(from, sort1, sort2)) return sort1;
  if (isSubsort(from, sort2, sort1)) return sort2;

  const table = tableOf(from);
  const common = commonSubsorts(table, sort1, sort2);
  if (common.length === 0) return undefined;

  let best: Sort | undefined;
  let bestCount = -1;
  let ambiguous = false;
  for (const sort of common) {
    const count = table.image.get(sortKey(sort))?.size ?? 0;
    if (count > bestCount) {
      best = sort;
      bestCount = count;
      ambiguous = false;
    } else if (count === bestCount) {
      ambiguous = true;
    }
  }
  return ambiguous ? undefined : best;
}

//////////////////////////
// Declaration views    //
//////////////////////////

/**
 * The head symbol of an attribute's single application argument —
 * `element{}(LblSetItem{}())` gives `"LblSetItem"`.
 *
 * pyk's `Collection._extract_label` (`internal.py:49-55`), which matches
 * `App(attr, args=(App(res),))` and raises `AssertionError` on anything else.
 * `undefined` here, on the same grounds as {@link attString}: an attribute is
 * advisory metadata.
 */
export function attSymbol(attrs: readonly App[], key: string): string | undefined {
  const attr = getAtt(attrs, key);
  if (attr === undefined || attr.args.length !== 1) return undefined;
  const [arg] = attr.args;
  if (arg === undefined || arg.tag !== "App") return undefined;
  return arg.symbol;
}

/**
 * The head symbols of *every* application argument of the attribute spelled
 * `key` — `priorities{}(Lblfoo{}(), Lblbar{}())` gives both.
 *
 * Empty both when the attribute is absent and when it is present with no
 * arguments, which `kompile` writes constantly (`priorities{}()`, `left{}()`);
 * the distinction is not one any consumer of the printing tables makes.
 * Arguments that are not applications are skipped rather than reported.
 */
export function attSymbols(attrs: readonly App[], key: string): readonly string[] {
  const attr = getAtt(attrs, key);
  if (attr === undefined) return [];
  const found: string[] = [];
  for (const arg of attr.args) {
    if (arg.tag === "App") found.push(arg.symbol);
  }
  return found;
}

/**
 * Whether a symbol is a function — `function{}()`, pyk `KoreDefn.from_definition`
 * (`internal.py:89`).
 *
 * Not to be confused with `functional{}()` ({@link ATT_FUNCTIONAL}), which on a
 * symbol declaration means *total*: `function` says the symbol is defined by
 * equations rather than being a constructor, and `functional` says it is defined
 * everywhere.  A `hooked-symbol` is typically both.
 */
export function isFunctionSymbol(decl: SymbolDecl): boolean {
  return hasAtt(decl.attrs, ATT_FUNCTION);
}

/** Whether a symbol is a constructor — pyk `KoreDefn.constructors` (`internal.py:109-117`). */
export function isConstructorSymbol(decl: SymbolDecl): boolean {
  return hasAtt(decl.attrs, ATT_CONSTRUCTOR);
}

/** Whether a symbol is the prelude's `inj`, or another declared injection — `sortInjection{}()`. */
export function isSortInjection(decl: SymbolDecl): boolean {
  return hasAtt(decl.attrs, ATT_SORT_INJECTION);
}

/**
 * The builtin a hooked symbol implements — `hook{}("MAP.lookup")`.
 *
 * The whole dotted name, not split: the part before the dot is the hook
 * *namespace* and the part after it the operation, and a caller that wants
 * either can split a string.  `undefined` when the attribute is absent, which is
 * the case for every symbol `kompile` did not hook.
 */
export function symbolHook(decl: SymbolDecl): string | undefined {
  return attString(decl.attrs, ATT_HOOK);
}

/** What a collection sort declares — pyk `Collection` (`internal.py:25-63`). */
export interface CollectionInfo {
  /** `element{}(…)` — the symbol wrapping one element, e.g. `LblSetItem`. */
  readonly element: string;
  /** `concat{}(…)` — the associative cons symbol. */
  readonly concat: string | undefined;
  /** `unit{}(…)` — the empty collection, e.g. `Lbl'Stop'Set`. */
  readonly unit: string | undefined;
  /** `hook{}("MAP.Map")` — the whole hook name. */
  readonly hook: string | undefined;
  /**
   * The hook's operation part — `"Map"` from `"MAP.Map"`.
   *
   * pyk turns this into a three-valued `CollectionKind` enum
   * (`internal.py:19-22`, `LIST`/`MAP`/`SET`) and so raises on `RANGEMAP.RangeMap`,
   * which K does emit.  A string keeps the answer total.
   */
  readonly kind: string | undefined;
}

/**
 * What a sort declaration says about being a collection, or `undefined` if it
 * says nothing — pyk `Collection.from_decl` (`internal.py:32-47`).
 *
 * The test is pyk's: a sort is a collection iff it carries `element`.  That is
 * the one attribute of the four that is never optional, and it is what
 * `KoreDefn.collections` (`internal.py:119-127`) filters on.  Everything else is
 * reported as found — pyk raises when `concat`, `unit` or `hook` is missing or
 * malformed, which would make an odd `syntaxDefinition.kore` unreadable rather
 * than partly readable.
 */
export function collectionInfo(decl: SortDecl): CollectionInfo | undefined {
  const element = attSymbol(decl.attrs, ATT_ELEMENT);
  if (element === undefined) return undefined;
  const hook = attString(decl.attrs, ATT_HOOK);
  return Object.freeze({
    element,
    concat: attSymbol(decl.attrs, ATT_CONCAT),
    unit: attSymbol(decl.attrs, ATT_UNIT),
    hook,
    kind: hook?.split(".")[1],
  });
}

/**
 * The pretty-printing tables `kompile` computed for a symbol — see the
 * {@link ATT_FORMAT} block for what each one is.
 *
 * Not in pyk at all: `KoreSymbolTable` stores whole declarations and never
 * inspects their attributes.
 */
export interface SymbolPrinting {
  /** `format{}("%1 %c[%r %2 %c]%r")`, or `undefined` if the production had no printable format. */
  readonly format: string | undefined;
  /** `terminals{}("0101")` — one character per production item. */
  readonly terminals: string | undefined;
  /** `colors{}("red,red")` — raw, comma-separated, one entry per `%c` of {@link format}. */
  readonly colors: string | undefined;
  /** `priorities{}(…)` — the labels this symbol binds tighter than. */
  readonly priorities: readonly string[];
  /** `left{}(…)` — the labels this symbol associates left with. */
  readonly left: readonly string[];
  /** `right{}(…)` — the labels this symbol associates right with. */
  readonly right: readonly string[];
  /** `assoc{}()`, copied from the K production (`ModuleToKORE.java:1793`). */
  readonly assoc: boolean;
  /**
   * `comm{}()`, copied from the K production alongside `assoc`
   * (`ModuleToKORE.java:1793`) — the fourth member of `attsToCopy`.
   *
   * It is a printing attribute here only by provenance: a printer wanting to
   * normalise the argument order of a commutative symbol is the reason it is on
   * the *declaration*.  The same key on an *axiom* is what
   * {@link AttributeAxiom}'s `comm` kind reads, and the two are unrelated
   * questions asked of the same word.
   */
  readonly comm: boolean;
  /** `bracket{}()` — the symbol prints as its single argument. */
  readonly bracket: boolean;
}

/**
 * The printing attributes of a symbol declaration — `syntaxAttributes`,
 * `ModuleToKORE.java:1765-1835`.
 *
 * Always answers: a declaration with none of them gives every field `undefined`,
 * empty or `false`, which is what a printer should do with a symbol `kompile`
 * gave no concrete syntax.  These are richest in `syntaxDefinition.kore`, which
 * is where `kompile` writes the parsing/printing view of the definition, but the
 * builtins carry them in `definition.kore` too.
 */
export function symbolPrinting(decl: SymbolDecl): SymbolPrinting {
  const { attrs } = decl;
  return Object.freeze({
    format: attString(attrs, ATT_FORMAT),
    terminals: attString(attrs, ATT_TERMINALS),
    colors: attString(attrs, ATT_COLORS),
    priorities: attSymbols(attrs, ATT_PRIORITIES),
    left: attSymbols(attrs, ATT_LEFT),
    right: attSymbols(attrs, ATT_RIGHT),
    assoc: hasAtt(attrs, ATT_ASSOC),
    comm: hasAtt(attrs, ATT_COMM),
    bracket: hasAtt(attrs, ATT_BRACKET),
  });
}

//////////////////////////
// Axiom classification //
//////////////////////////

/**
 * An axiom that exists only to state an algebraic property of a symbol, or the
 * inhabitants of a sort.  It carries no rule; the attribute *is* the content.
 *
 * Every kind here except `comm`, `no-junk` and `no-confusion` is one pyk's
 * `Rule.is_rule` skips outright (`rule.py:100-108, 143-156`); `no-junk` and
 * `no-confusion` are the two structural roles of the single `constructor`
 * attribute, split apart because `ModuleToKORE.java` itself distinguishes them
 * (`:774`, `:801`, `:865`) and a caller almost always means one or the other.
 */
export interface AttributeAxiom {
  readonly kind:
    | "assoc"
    | "comm"
    | "idem"
    | "unit"
    | "functional"
    | "no-junk"
    | "no-confusion"
    | "constructor"
    | "overload";
  /** The attribute that decided the classification. */
  readonly attr: App;
}

/**
 * `axiom{R} \exists{R}(Val:Super, \equals{Super,R}(Val, inj{Sub,Super}(From))) [subsort{Sub, Super}()]`
 * — the injection-is-surjective axiom that declares `Sub < Super`.
 */
export interface SubsortAxiom {
  readonly kind: "subsort";
  readonly attr: App;
  /** The attribute's first sort parameter, or `undefined` if it does not have two. */
  readonly subsort: Sort | undefined;
  /** The attribute's second sort parameter, or `undefined` if it does not have two. */
  readonly supersort: Sort | undefined;
}

/**
 * A rewrite rule — pyk `RewriteRule` (`rule.py:163-232`).
 *
 * `kompile` emits two different shapes for the same rule, chosen by
 * `--enable-kore-antileft` (`ModuleToKORE.java:1334-1380`), and they differ in
 * the *order* of both conjunctions:
 *
 * | | LHS | RHS |
 * | --- | --- | --- |
 * | default | `\and{T}(lhs, requires)` | `\and{T}(rhs, ensures)` |
 * | `--enable-kore-antileft` | `ruleNLHS{}(vars…)`, optionally under `\and{T}(\not{T}(prevGroup{}()), …)` | `\and{T}(ensures, rhs)` |
 *
 * pyk only ever matches the default shape (`rule.py:209-232`); the antileft
 * shape is what our `a-to-f` fixture contains, so it is handled here too.  Which
 * shape an axiom is in is decided by the LHS — an application (or a `\not`/
 * application conjunction) means antileft — and that decision also fixes how to
 * read the RHS.  {@link lhsAlias} says which happened.
 *
 * pyk additionally insists the configuration head is literally
 * `Lbl'-LT-'generatedTop'-GT-'` (`rule.py:217-230`); that check is dropped,
 * since under `--enable-kore-antileft` the head is an alias by construction.
 */
export interface RewriteAxiom {
  readonly kind: "rewrite";
  /** The `\rewrites` sort — `SortGeneratedTopCell{}` for a semantic rule. */
  readonly sort: Sort;
  /** The configuration being matched, or the LHS alias application. */
  readonly lhs: Pattern;
  /** Set when {@link lhs} is an alias application, i.e. `--enable-kore-antileft` output. */
  readonly lhsAlias: App | undefined;
  /** The configuration produced. */
  readonly rhs: Pattern;
  /** The rule's `requires`, unwrapped from `\equals(cond, \dv{SortBool}("true"))`; `undefined` for `\top`. */
  readonly requires: Pattern | undefined;
  /** The rule's `ensures`, unwrapped the same way. */
  readonly ensures: Pattern | undefined;
  /** The `\not(…)` guard excluding higher-priority rules, when present. */
  readonly antiLeft: Pattern | undefined;
  /** pyk's `ctx`: the `Var'Hash'Configuration` variable of a claim-style LHS (`rule.py:219`). */
  readonly ctx: EVar | undefined;
  /** `priority{}` if given, else 200 for `owise`, else 50 — pyk `_extract_priority` (`rule.py:499-508`). */
  readonly priority: number;
  /** `UNIQUE'Unds'ID{}("…")`; `undefined` where pyk's `_extract_uid` would raise. */
  readonly uid: string | undefined;
  /** `label{}("MODULE.name")`. */
  readonly label: string | undefined;
}

/**
 * A function (equation) rule — pyk `FunctionRule` (`rule.py:235-329`).
 *
 * The canonical shape, in full:
 *
 * ```text
 * axiom{R} \implies{R}(
 *   \and{R}(                                    // optional \not(antiLeft) wrapper
 *     \and{R}(requires, \and{R}(\in{S0,R}(X0:S0, arg0), … \top{R}()))),
 *   \equals{Sort, R}(f{}(X0:S0, …), \and{Sort}(rhs, ensures)))
 * ```
 *
 * The `\in`-conjunction is the argument list: each `\in{Si,R}(Xi:Si, argi)` binds
 * the pattern `f` matches in position `i`, and pyk reassembles them into
 * {@link lhs} (`rule.py:300-301`).
 *
 * Three `kind` values share this payload.  pyk has only `FunctionRule` and
 * recovers `owise` from the priority (`rule.py:505-506`); splitting the
 * discriminant means a histogram over a real definition separates the default
 * rules from the fallback ones without a second lookup.  `anywhere` is
 * transcribed the same way but is not exercised by our fixtures — neither of
 * them contains an `anywhere{}()` axiom.
 */
export interface EquationAxiom {
  readonly kind: "equation" | "owise" | "anywhere";
  /** The head symbol being defined. */
  readonly symbol: string;
  /** `f{}(arg0, …)` — the declared head with the matched arguments substituted in. */
  readonly lhs: App;
  /** The sorts of the `\in` binders, in order. */
  readonly argSorts: readonly Sort[];
  /** The `\equals` argument sort: the sort `f` returns. */
  readonly sort: Sort;
  /** The right-hand side. */
  readonly rhs: Pattern;
  /** `requires`, unwrapped from `\equals(cond, \dv{SortBool}("true"))`; `undefined` for `\top`. */
  readonly requires: Pattern | undefined;
  /** `ensures`, unwrapped the same way. */
  readonly ensures: Pattern | undefined;
  /** The `\not(…)` guard an `owise` rule carries — pyk's `anti_left` (`rule.py:284-290`). */
  readonly antiLeft: Pattern | undefined;
  /** `priority{}` if given, else 200 for `owise`, else 50. */
  readonly priority: number;
  /** `UNIQUE'Unds'ID{}("…")`, when the axiom has one. */
  readonly uid: string | undefined;
  /** `label{}("MODULE.name")`. */
  readonly label: string | undefined;
}

/**
 * A `simplification{}()` axiom — pyk's `SimpliRule` family (`rule.py:332-458`),
 * whose three subclasses differ only in what the left-hand side is:
 * `AppRule` (an application), `CeilRule` (a `\ceil`), `EqualsRule` (an
 * `\equals`).  {@link shape} is that distinction, plus `"other"` for a left-hand
 * side pyk would reject.
 *
 * pyk matches only `\implies(requires, \equals(lhs, \and(rhs, ensures)))`
 * (`rule.py:359-368`).  The prelude's `INJ` module contains one more shape — a
 * bare `\equals` with no `\implies` — which pyk skips by comparing the whole
 * axiom against a hard-coded literal (`rule.py:89-96, 144-145`); it is read here
 * instead, with `requires` and `ensures` `undefined`.
 */
export interface SimplificationAxiom {
  readonly kind: "simplification";
  readonly shape: "App" | "Ceil" | "Equals" | "other";
  /** The pattern the rule rewrites. */
  readonly lhs: Pattern;
  /** What it rewrites to. */
  readonly rhs: Pattern;
  /** The `\equals` argument sort. */
  readonly sort: Sort;
  readonly requires: Pattern | undefined;
  readonly ensures: Pattern | undefined;
  /** `simplification{}("N")` if given, else 50 — pyk `_extract_simpl_priority` (`rule.py:511-519`). */
  readonly priority: number;
  readonly uid: string | undefined;
  readonly label: string | undefined;
}

/**
 * An axiom none of the above matched.
 *
 * This is where pyk raises `ValueError`.  Reaching it on `kompile` output means
 * either a shape this module has not been taught or — far more likely — a
 * definition emitted by a K version with different conventions; {@link reason}
 * says which test failed.
 */
export interface OtherAxiom {
  readonly kind: "other";
  readonly reason: string;
}

/** What {@link classifyAxiom} answers. */
export type AxiomClass =
  | AttributeAxiom
  | SubsortAxiom
  | RewriteAxiom
  | EquationAxiom
  | SimplificationAxiom
  | OtherAxiom;

/** The `kind` discriminants of {@link AxiomClass}. */
export type AxiomKind = AxiomClass["kind"];

/**
 * The attribute-marked, non-rule kinds, in the order they are tested.
 *
 * pyk's `_SKIPPED_ATTRS` (`rule.py:100-108`) is tested with `any()`, so its
 * order carries no meaning; an order has to be picked to assign a single kind,
 * and this one puts the most specific markers first.  `comm` is in this list but
 * **not** in pyk's: a `comm` axiom is `\equals(f(K1,K2), f(K2,K1))`, which pyk's
 * `Rule.from_axiom` then tries to read as a function rule and raises on
 * (`rule.py:129-140`).  Classifying it by its attribute is the fix.
 */
const MARKER_ATTRS: readonly (readonly [string, AttributeAxiom["kind"]])[] = [
  [ATT_FUNCTIONAL, "functional"],
  [ATT_ASSOC, "assoc"],
  [ATT_COMM, "comm"],
  [ATT_IDEM, "idem"],
  [ATT_UNIT, "unit"],
  [ATT_SYMBOL_OVERLOAD, "overload"],
];

/**
 * Read `\dv{SortBool{}}("true")`, the right-hand side of every side condition.
 */
function isBoolTrue(p: Pattern): boolean {
  return (
    p.tag === "DV" &&
    p.sort.tag === "SortApp" &&
    p.sort.name === "SortBool" &&
    p.sort.sorts.length === 0 &&
    p.value.value === "true"
  );
}

/**
 * pyk `_extract_condition` (`rule.py:469-476`): `\top` means no condition, and
 * `\equals(cond, \dv{SortBool}("true"))` is the ML encoding of the K-level
 * `cond`.
 *
 * pyk raises on anything else; anything else is returned unchanged here, on the
 * grounds that an unrecognised *predicate* is still the rule's condition and
 * losing it would be worse than not simplifying it.
 */
function extractCondition(p: Pattern): Pattern | undefined {
  if (p.tag === "Top") return undefined;
  if (p.tag === "Equals" && isBoolTrue(p.right)) return p.left;
  return p;
}

/** The two operands of a binary `\and`, or `undefined`. */
function andPair(p: Pattern): readonly [Pattern, Pattern] | undefined {
  if (p.tag !== "And" || p.patterns.length !== 2) return undefined;
  const [a, b] = p.patterns;
  if (a === undefined || b === undefined) return undefined;
  return [a, b];
}

/** pyk `_extract_rhs` (`rule.py:461-466`): `\and(rhs, ensures)`. */
function extractRhs(p: Pattern): { readonly rhs: Pattern; readonly ensures: Pattern | undefined } | undefined {
  const pair = andPair(p);
  if (pair === undefined) return undefined;
  return { rhs: pair[0], ensures: extractCondition(pair[1]) };
}

/**
 * pyk `FunctionRule._extract_args` (`rule.py:320-329`), as a loop.
 *
 * The `\and`/`\in` spine is as deep as the symbol's arity, so recursion would be
 * safe here in practice — but "no recursion over pattern structure" is a rule of
 * this package, not a case-by-case judgement.
 */
function extractArgs(
  p: Pattern,
): { readonly argSorts: readonly Sort[]; readonly args: readonly Pattern[] } | undefined {
  const argSorts: Sort[] = [];
  const args: Pattern[] = [];
  let cur = p;
  for (;;) {
    if (cur.tag === "Top") return { argSorts, args };
    const pair = andPair(cur);
    if (pair === undefined) return undefined;
    const [binder, rest] = pair;
    if (binder.tag !== "In" || binder.left.tag !== "EVar") return undefined;
    argSorts.push(binder.left.sort);
    args.push(binder.right);
    cur = rest;
  }
}

/** pyk `_extract_priority` (`rule.py:499-508`). */
function extractPriority(attrs: readonly App[]): number {
  return attInteger(attrs, ATT_PRIORITY) ?? (hasAtt(attrs, ATT_OWISE) ? 200 : 50);
}

/** pyk `_extract_simpl_priority` (`rule.py:511-519`): a bare or empty argument means 50. */
function extractSimplPriority(attrs: readonly App[]): number {
  return attInteger(attrs, ATT_SIMPLIFICATION) ?? 50;
}

function classifyMarker(attrs: readonly App[], pattern: Pattern): AxiomClass | undefined {
  const subsortAttr = getAtt(attrs, ATT_SUBSORT);
  if (subsortAttr !== undefined) {
    const [sub, sup] = subsortAttr.sorts;
    return {
      kind: "subsort",
      attr: subsortAttr,
      subsort: subsortAttr.sorts.length === 2 ? sub : undefined,
      supersort: subsortAttr.sorts.length === 2 ? sup : undefined,
    };
  }

  const ctorAttr = getAtt(attrs, ATT_CONSTRUCTOR);
  if (ctorAttr !== undefined) {
    // `ModuleToKORE.java` writes all three from the same attribute and tells
    // them apart only in a trailing `//` comment: no-junk is the `\or … \bottom`
    // disjunction of every inhabitant (`:824-870`, degenerating to a bare
    // `\bottom` when a hooked sort has no constructors), while both no-confusion
    // axioms are `\implies` (same constructor, `:749-774`) or `\not` (different
    // constructors, `:777-801`).
    switch (pattern.tag) {
      case "Or":
      case "Bottom":
      case "Exists":
        return { kind: "no-junk", attr: ctorAttr };
      case "Implies":
      case "Not":
        return { kind: "no-confusion", attr: ctorAttr };
      default:
        return { kind: "constructor", attr: ctorAttr };
    }
  }

  for (const [key, kind] of MARKER_ATTRS) {
    const attr = getAtt(attrs, key);
    if (attr !== undefined) return { kind, attr };
  }
  return undefined;
}

/** Which of pyk's three `SimpliRule` subclasses an axiom's left-hand side picks. */
function simplificationShape(lhs: Pattern): SimplificationAxiom["shape"] {
  return lhs.tag === "App" || lhs.tag === "Ceil" || lhs.tag === "Equals" ? lhs.tag : "other";
}

function classifySimplification(pattern: Pattern, attrs: readonly App[]): AxiomClass {
  const common = {
    kind: "simplification",
    priority: extractSimplPriority(attrs),
    uid: attString(attrs, ATT_UNIQUE_ID),
    label: attString(attrs, ATT_LABEL),
  } as const;

  if (pattern.tag === "Implies" && pattern.right.tag === "Equals") {
    const eq = pattern.right;
    const rhs = extractRhs(eq.right);
    return {
      ...common,
      shape: simplificationShape(eq.left),
      lhs: eq.left,
      rhs: rhs?.rhs ?? eq.right,
      sort: eq.opSort,
      requires: extractCondition(pattern.left),
      ensures: rhs?.ensures,
    };
  }

  // The prelude `INJ` axiom: `\equals{S3,R}(inj{S2,S3}(inj{S1,S2}(T)), inj{S1,S3}(T))`.
  if (pattern.tag === "Equals") {
    return {
      ...common,
      shape: simplificationShape(pattern.left),
      lhs: pattern.left,
      rhs: pattern.right,
      sort: pattern.opSort,
      requires: undefined,
      ensures: undefined,
    };
  }

  return { kind: "other", reason: `simplification axiom is neither \\implies nor \\equals: ${pattern.tag}` };
}

function classifyRewrite(pattern: Pattern, attrs: readonly App[]): AxiomClass {
  if (pattern.tag !== "Rewrites") return { kind: "other", reason: "not a \\rewrites axiom" };

  const common = {
    kind: "rewrite",
    sort: pattern.sort,
    priority: extractPriority(attrs),
    uid: attString(attrs, ATT_UNIQUE_ID),
    label: attString(attrs, ATT_LABEL),
  } as const;

  let lhs: Pattern;
  let lhsAlias: App | undefined;
  let antiLeft: Pattern | undefined;
  let requires: Pattern | undefined;
  let ctx: EVar | undefined;

  const leftPair = andPair(pattern.left);
  if (pattern.left.tag === "App") {
    // `--enable-kore-antileft`, no previous priority group.
    lhs = pattern.left;
    lhsAlias = pattern.left;
  } else if (leftPair !== undefined && leftPair[0].tag === "Not" && leftPair[1].tag === "App") {
    // `--enable-kore-antileft`, guarded by the previous priority group's alias
    // (`ModuleToKORE.java:1515-1532`).
    antiLeft = leftPair[0].pattern;
    lhs = leftPair[1];
    lhsAlias = leftPair[1];
  } else if (leftPair !== undefined) {
    // The default shape pyk matches (`rule.py:210`).
    lhs = leftPair[0];
    requires = extractCondition(leftPair[1]);
    // pyk `rule.py:219`: a configuration paired with `Var'Hash'Configuration`.
    const ctxPair = andPair(lhs);
    if (ctxPair !== undefined && ctxPair[0].tag === "App" && ctxPair[1].tag === "EVar") {
      lhs = ctxPair[0];
      ctx = ctxPair[1];
    }
  } else {
    return { kind: "other", reason: `cannot extract rewrite LHS from \\rewrites left operand: ${pattern.left.tag}` };
  }

  const rightPair = andPair(pattern.right);
  if (rightPair === undefined) {
    return { kind: "other", reason: `cannot extract rewrite RHS from \\rewrites right operand: ${pattern.right.tag}` };
  }
  // Antileft output writes the RHS conjunction the other way round
  // (`ModuleToKORE.java:1372-1380`).
  const [rhs, ensures] =
    lhsAlias === undefined
      ? [rightPair[0], extractCondition(rightPair[1])]
      : [rightPair[1], extractCondition(rightPair[0])];

  return { ...common, lhs, lhsAlias, rhs, requires, ensures, antiLeft, ctx };
}

function classifyEquation(pattern: Pattern, attrs: readonly App[]): AxiomClass {
  if (pattern.tag !== "Implies") return { kind: "other", reason: `axiom is not \\implies: ${pattern.tag}` };
  if (pattern.right.tag !== "Equals") {
    return { kind: "other", reason: `\\implies right operand is not \\equals: ${pattern.right.tag}` };
  }
  const eq = pattern.right;
  if (eq.left.tag !== "App") {
    return { kind: "other", reason: `equation left-hand side is not an application: ${eq.left.tag}` };
  }
  const head = eq.left;

  const leftPair = andPair(pattern.left);
  if (leftPair === undefined) {
    return { kind: "other", reason: `\\implies left operand is not a binary \\and: ${pattern.left.tag}` };
  }
  // pyk tries the `\not(antiLeft)` shape first and falls through to the plain
  // one (`rule.py:285-297`); an axiom whose first conjunct is a `\not` but whose
  // second is not a binary `\and` takes the second branch in pyk too.
  let antiLeft: Pattern | undefined;
  let condition = leftPair[0];
  let argsPattern = leftPair[1];
  const guarded = leftPair[0].tag === "Not" ? andPair(leftPair[1]) : undefined;
  if (leftPair[0].tag === "Not" && guarded !== undefined) {
    antiLeft = leftPair[0].pattern;
    condition = guarded[0];
    argsPattern = guarded[1];
  }

  const extracted = extractArgs(argsPattern);
  if (extracted === undefined) {
    return { kind: "other", reason: `cannot extract an argument list from: ${argsPattern.tag}` };
  }
  const rhs = extractRhs(eq.right);
  if (rhs === undefined) {
    return { kind: "other", reason: `equation right-hand side is not a binary \\and: ${eq.right.tag}` };
  }

  const kind: EquationAxiom["kind"] = hasAtt(attrs, ATT_OWISE)
    ? "owise"
    : hasAtt(attrs, ATT_ANYWHERE)
      ? "anywhere"
      : "equation";

  return {
    kind,
    symbol: head.symbol,
    lhs: { ...head, args: extracted.args },
    argSorts: extracted.argSorts,
    sort: eq.opSort,
    rhs: rhs.rhs,
    requires: extractCondition(condition),
    ensures: rhs.ensures,
    antiLeft,
    priority: extractPriority(attrs),
    uid: attString(attrs, ATT_UNIQUE_ID),
    label: attString(attrs, ATT_LABEL),
  };
}

/**
 * What kind of thing an axiom (or claim) is.
 *
 * The match order is pyk's, made total:
 *
 * 1. **Marker attributes first**, because pyk's `Rule.is_rule`
 *    (`rule.py:142-156`) filters on them before `Rule.from_axiom` ever looks at
 *    the pattern.  `subsort`, then `constructor`, then the rest of
 *    {@link MARKER_ATTRS}.
 * 2. **`\rewrites`** — pyk `from_axiom`'s first test (`rule.py:126-127`).
 * 3. **`simplification`** — pyk's second (`rule.py:129`), which routes to
 *    `AppRule`/`CeilRule`/`EqualsRule` by the `\equals` left-hand side.
 * 4. **the function-rule shape**, pyk's fallback (`rule.py:130`).
 * 5. `{kind: "other"}` with a reason, where pyk raises.
 *
 * Four things a real `definition.kore` contains that pyk cannot read, and this
 * can:
 *
 * - `comm` axioms — see {@link MARKER_ATTRS};
 * - `--enable-kore-antileft` rewrite axioms — see {@link RewriteAxiom};
 * - the prelude's bare-`\equals` `INJ` simplification, and its two `KSEQ`
 *   `append` equations, all three of which pyk skips by comparing the axiom to a
 *   hard-coded literal (`rule.py:49-96, 144-149`).  Both `append` axioms have the
 *   canonical function-rule shape and are classified as `equation` here — pyk
 *   skips them only because they lack the `UNIQUE'Unds'ID` its `_extract_uid`
 *   demands (`rule.py:479-485`), which is why {@link EquationAxiom.uid} is
 *   optional;
 * - the 15 attribute-free `LblisSort{}` predicate equations, for the same reason.
 */
export function classifyAxiom(axiom: Axiom | Claim): AxiomClass {
  const { attrs, pattern } = axiom;

  const marker = classifyMarker(attrs, pattern);
  if (marker !== undefined) return marker;

  if (pattern.tag === "Rewrites") return classifyRewrite(pattern, attrs);
  if (hasAtt(attrs, ATT_SIMPLIFICATION)) return classifySimplification(pattern, attrs);
  return classifyEquation(pattern, attrs);
}

/**
 * A histogram of {@link classifyAxiom} over some axioms, keyed by `kind`.
 *
 * Cheap, total, and the fastest way to see whether a definition is shaped the
 * way this module thinks it is: a nonzero `other` bucket is the signal to look.
 */
export function classifyAxioms(axioms: Iterable<Axiom | Claim>): ReadonlyMap<AxiomKind, number> {
  const counts = new Map<AxiomKind, number>();
  for (const axiom of axioms) {
    const { kind } = classifyAxiom(axiom);
    counts.set(kind, (counts.get(kind) ?? 0) + 1);
  }
  return counts;
}
