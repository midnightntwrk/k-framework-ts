/**
 * `src/definition.ts` against the three real fixtures.
 *
 * Every count here was computed once from the fixtures and hard-coded, which is
 * the point: the numbers pin the fixtures *and* the classifier at the same time.
 * A fixture that gets re-vendored, or a classifier that starts reading an axiom
 * differently, moves at least one of them.
 *
 * `empty.definition.kore` and `a-to-f.definition.kore` are `kompile` output from
 * `haskell-backend/test/rpc-server` (see `fixtures/PROVENANCE.md`); `a-to-f` was
 * compiled with `--enable-kore-antileft`, which is what makes it the only one of
 * the two with rewrite axioms in the alias shape.  `prelude.kore` is the module
 * sequence every `definition.kore` starts with.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  ATT_FUNCTIONAL,
  ATT_LOCATION,
  ATT_SOURCE,
  attInteger,
  attLocation,
  attsByKey,
  attSource,
  attString,
  attSymbol,
  attSymbols,
  type AxiomKind,
  buildSubsortTable,
  classifyAxiom,
  classifyAxioms,
  collectionInfo,
  commonSubsorts,
  type EquationAxiom,
  getAtt,
  hasAtt,
  indexDefinition,
  isConstructorSymbol,
  isFunctionSymbol,
  isSortInjection,
  isSubsort,
  type KoreDefinitionIndex,
  meetSorts,
  sortKey,
  subsortPairs,
  subsorts,
  symbolHook,
  symbolPrinting,
} from "../src/definition.ts";
import { forceAxiom, KoreParser, parseDefinition } from "../src/parser.ts";
import {
  app,
  type Axiom,
  type Claim,
  collect,
  definition,
  evar,
  koreModule,
  koreString,
  koreText,
  type Module,
  sortApp,
  sortVar,
} from "../src/syntax.ts";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "definitions");

function indexFixture(name: string): KoreDefinitionIndex {
  return indexDefinition(parseDefinition(readFileSync(join(FIXTURES, name), "utf8")));
}

/**
 * `prelude.kore` is a *module sequence*, not a definition — it has no leading
 * definition-level attribute list, because `kompile` concatenates it in front of
 * one.  `test/parser.test.ts` documents why `parseDefinition` rejects it; wrap
 * the modules in a `Definition` to index them.
 */
function indexPrelude(): KoreDefinitionIndex {
  const parser = new KoreParser(readFileSync(join(FIXTURES, "prelude.kore"), "utf8"));
  const modules: Module[] = [];
  while (!parser.eof) modules.push(parser.module());
  return indexDefinition(definition(modules));
}

const EMPTY = indexFixture("empty.definition.kore");
const A_TO_F = indexFixture("a-to-f.definition.kore");
const PRELUDE = indexPrelude();

/** The closed subsort table as sorted `super: sub,sub` lines — stable to compare. */
function subsortRows(from: { sortTable: { image: ReadonlyMap<string, ReadonlySet<string>> } }): string[] {
  return [...from.sortTable.image].map(([sup, subs]) => `${sup}: ${[...subs].toSorted().join(",")}`).toSorted();
}

/** The classification histogram, as sorted entries — stable to compare. */
function histogram(axioms: readonly (Axiom | Claim)[]): readonly (readonly [AxiomKind, number])[] {
  return [...classifyAxioms(axioms)].toSorted(([a], [b]) => a.localeCompare(b));
}

/** The single axiom matching `predicate`; fails loudly if there is not exactly one. */
function onlyAxiom(index: KoreDefinitionIndex, predicate: (axiom: Axiom) => boolean): Axiom {
  const found = index.axioms.filter((axiom) => predicate(axiom));
  expect(found).toHaveLength(1);
  return found[0]!;
}

/**
 * The `append{}(dotk{}(), TAIL) = TAIL` base case of the prelude's `KSEQ`
 * module — the first of pyk's two hard-coded skipped axioms (`rule.py:52-60`).
 * Its sibling recurses on `kseq{}(K, KS)`, so the first argument's head is what
 * tells them apart.
 */
function isAppendDotK(axiom: Axiom): boolean {
  const rule = classifyAxiom(axiom);
  if (rule.kind !== "equation" || rule.symbol !== "append") return false;
  const [first] = rule.lhs.args;
  return first !== undefined && first.tag === "App" && first.symbol === "dotk";
}

//////////////////////////
// Attribute helpers    //
//////////////////////////

describe("attribute helpers", () => {
  const attrs = [
    app("owise"),
    app("label", [], [koreString("TEST.AB")]),
    app("priority", [], [koreString("200")]),
    app("subsort", [sortApp("SortInt"), sortApp("SortKItem")]),
    app("constructor"),
    app("pair", [], [koreString("a"), koreString("b")]),
    app("notAString", [], [evar("X", sortApp("SortK"))]),
  ];

  test("attsByKey survives the `constructor` key", () => {
    // A plain object would answer `Object.prototype.constructor` here, which is
    // why `attsByKey` returns a Map. `constructor{}()` is one of the most common
    // attributes in a real definition, so this is not a hypothetical.
    const byKey = attsByKey(attrs);
    expect(byKey.get("constructor")).toEqual(app("constructor"));
    expect(byKey.get("toString")).toBeUndefined();
    expect(byKey.size).toBe(attrs.length);
  });

  test("attsByKey and getAtt: last occurrence of a repeated key wins", () => {
    // pyk `syntax.py:1824-1826` builds a dict comprehension over the attribute
    // tuple, so a later entry replaces an earlier one.
    const repeated = [app("label", [], [koreString("first")]), app("label", [], [koreString("second")])];
    expect(attString(repeated, "label")).toBe("second");
    expect(attsByKey(repeated).get("label")).toEqual(repeated[1]);
    expect(getAtt(repeated, "label")).toEqual(repeated[1]);
  });

  test("hasAtt / getAtt", () => {
    expect(hasAtt(attrs, "owise")).toBe(true);
    expect(hasAtt(attrs, "simplification")).toBe(false);
    expect(getAtt(attrs, "subsort")?.sorts.map(sortKey)).toEqual(["SortInt{}", "SortKItem{}"]);
    expect(getAtt(attrs, "nope")).toBeUndefined();
  });

  test("attString reads only the single-String shape", () => {
    expect(attString(attrs, "label")).toBe("TEST.AB");
    expect(attString(attrs, "owise")).toBeUndefined(); // no argument
    expect(attString(attrs, "pair")).toBeUndefined(); // two arguments
    expect(attString(attrs, "notAString")).toBeUndefined(); // wrong argument kind
    expect(attString(attrs, "absent")).toBeUndefined();
  });

  test("attInteger accepts integer literals only", () => {
    expect(attInteger(attrs, "priority")).toBe(200);
    expect(attInteger([app("priority", [], [koreString("-1")])], "priority")).toBe(-1);
    for (const bad of ["", " 1", "+1", "1.0", "1e3", "0x10", "two"]) {
      expect(attInteger([app("priority", [], [koreString(bad)])], "priority")).toBeUndefined();
    }
    expect(attInteger(attrs, "label")).toBeUndefined();
  });

  test("attSource unwraps the Source(…) wrapper", () => {
    expect(attSource([app(ATT_SOURCE, [], [koreString("Source(/a/b/test.k)")])])).toBe("/a/b/test.k");
    // A path may itself contain parentheses; the wrapper is stripped greedily so
    // the whole remainder survives.
    expect(attSource([app(ATT_SOURCE, [], [koreString("Source(/a (1)/b.k)")])])).toBe("/a (1)/b.k");
    expect(attSource([app(ATT_SOURCE, [], [koreString("/a/b/test.k")])])).toBeUndefined();
    expect(attSource([])).toBeUndefined();
  });

  test("attLocation parses Location(sl,sc,el,ec)", () => {
    expect(attLocation([app(ATT_LOCATION, [], [koreString("Location(12,14,12,20)")])])).toEqual({
      startLine: 12,
      startColumn: 14,
      endLine: 12,
      endColumn: 20,
    });
    expect(attLocation([app(ATT_LOCATION, [], [koreString("Location( 1 , 2 , 3 , 4 )")])])).toEqual({
      startLine: 1,
      startColumn: 2,
      endLine: 3,
      endColumn: 4,
    });
  });

  test("a malformed Location is undefined, not an exception", () => {
    const malformed = [
      "", // empty
      "Location(1,2,3)", // three components
      "Location(1,2,3,4,5)", // five
      "Location(1,2,3,4", // unterminated
      "Location(a,b,c,d)", // non-numeric
      "Location(1,2,3,-4)", // negative
      "12,14,12,20", // unwrapped
      "location(1,2,3,4)", // wrong case
      "Location(1,2,3,4) ", // trailing space
    ];
    for (const value of malformed) {
      expect(attLocation([app(ATT_LOCATION, [], [koreString(value)])])).toBeUndefined();
    }
    expect(attLocation([app(ATT_LOCATION)])).toBeUndefined(); // no argument at all
    expect(attLocation([])).toBeUndefined();
  });
});

//////////////////////////
// Definition index     //
//////////////////////////

describe("indexDefinition", () => {
  test("empty.definition.kore", () => {
    expect(EMPTY.moduleNames).toEqual(["BASIC-K", "KSEQ", "INJ", "K", "TEST"]);
    expect(EMPTY.modules.size).toBe(5);
    expect(EMPTY.sorts.size).toBe(14);
    expect(EMPTY.symbols.size).toBe(79);
    expect(EMPTY.aliases.size).toBe(3);
    expect(EMPTY.imports).toHaveLength(4);
    expect(EMPTY.axioms).toHaveLength(138);
    expect(EMPTY.claims).toHaveLength(0);
  });

  test("a-to-f.definition.kore", () => {
    expect(A_TO_F.moduleNames).toEqual(["BASIC-K", "KSEQ", "INJ", "K", "TEST"]);
    expect(A_TO_F.sorts.size).toBe(15);
    expect(A_TO_F.symbols.size).toBe(81);
    // `--enable-kore-antileft` adds one `ruleNLHS` alias per rewrite rule on top
    // of the prelude's three.
    expect(A_TO_F.aliases.size).toBe(8);
    expect(A_TO_F.imports).toHaveLength(4);
    expect(A_TO_F.axioms).toHaveLength(148);
    expect(A_TO_F.claims).toHaveLength(0);
  });

  test("indexing covers every sentence exactly once", () => {
    for (const index of [EMPTY, A_TO_F, PRELUDE]) {
      const sentences = index.definition.modules.flatMap((module) => [...module.sentences]);
      const indexed =
        index.sorts.size +
        index.symbols.size +
        index.aliases.size +
        index.imports.length +
        index.axioms.length +
        index.claims.length;
      expect(indexed).toBe(sentences.length);
    }
  });

  test("declarations keep their nodes, not copies", () => {
    const kseq = EMPTY.symbols.get("kseq");
    expect(kseq?.symbol.name).toBe("kseq");
    expect(kseq?.paramSorts.map(sortKey)).toEqual(["SortKItem{}", "SortK{}"]);
    expect(sortKey(kseq!.sort)).toBe("SortK{}");
    expect(EMPTY.sorts.get("SortK")?.hooked).toBe(false);
    expect(EMPTY.modules.get("INJ")?.name).toBe("INJ");
  });

  test("duplicate names: last declaration wins", () => {
    // pyk `KoreSymbolTable.__init__` (`kompiled.py:266-267`) is a dict
    // comprehension over every module's `symbol_decls` in definition order, so a
    // later module silently replaces an earlier one. Same for sorts, aliases and
    // modules here.
    const first = koreModule("A", [{ tag: "SortDecl", name: "S", vars: [], attrs: [app("first")], hooked: false }]);
    const second = koreModule("B", [{ tag: "SortDecl", name: "S", vars: [], attrs: [app("second")], hooked: false }]);
    const index = indexDefinition(definition([first, second]));
    expect(index.sorts.get("S")?.attrs.map((a) => a.symbol)).toEqual(["second"]);
    expect(index.moduleNames).toEqual(["A", "B"]);
  });
});

describe("symbol resolution", () => {
  /**
   * The rule asserted: **every application head occurring in an axiom body is
   * declared in the same definition, as either a `symbol` or an `alias`.**
   *
   * There is no exemption list, and there does not need to be one:
   *
   * - the matching-logic connectives are not applications in this AST — `\and`,
   *   `\equals`, `\dv` and the rest are their own pattern tags, so they can never
   *   turn up as an `App.symbol`;
   * - `inj`, the one head that looks built-in, is an ordinary declared symbol of
   *   the prelude's `INJ` module (`symbol inj{From, To}(From) : To`);
   * - `--enable-kore-antileft` rewrite left-hand sides are alias applications,
   *   which is why aliases count too.
   */
  test.each([
    ["empty.definition.kore", EMPTY],
    ["a-to-f.definition.kore", A_TO_F],
    ["prelude.kore", PRELUDE],
  ] as const)("%s: every App head in every axiom resolves", (_name, index) => {
    const unresolved = new Set<string>();
    let heads = 0;
    for (const sentence of [...index.axioms, ...index.claims]) {
      collect(sentence.pattern, (p) => {
        if (p.tag !== "App" && p.tag !== "LeftAssoc" && p.tag !== "RightAssoc") return;
        heads += 1;
        if (!index.symbols.has(p.symbol) && !index.aliases.has(p.symbol)) unresolved.add(p.symbol);
      });
    }
    expect([...unresolved]).toEqual([]);
    expect(heads).toBeGreaterThan(0);
  });

  test("inj is a declared symbol, not a builtin", () => {
    for (const index of [EMPTY, A_TO_F, PRELUDE]) {
      const inj = index.symbols.get("inj");
      expect(inj?.symbol.vars.map((v) => v.name)).toEqual(["From", "To"]);
      expect(hasAtt(inj!.attrs, "sortInjection")).toBe(true);
    }
  });
});

//////////////////////////
// Subsort closure      //
//////////////////////////

describe("subsort closure", () => {
  test("the relation comes from `subsort{Sub, Super}()` attributes", () => {
    const pairs = subsortPairs(EMPTY.axioms).map(([sub, sup]) => `${sortKey(sub)} < ${sortKey(sup)}`);
    expect(pairs).toHaveLength(13);
    expect(pairs).toContain("SortKCell{} < SortKCellOpt{}");
    expect(pairs).toContain("SortGeneratedCounterCell{} < SortGeneratedCounterCellOpt{}");
    expect(subsortPairs(A_TO_F.axioms)).toHaveLength(14);
    // The prelude declares no subsorts at all: `inj` is there, the relation is not.
    expect(subsortPairs(PRELUDE.axioms)).toEqual([]);
  });

  test("subsorts() is indexed by the SUPERsort", () => {
    // pyk flips each pair before closing it (`kompiled.py:218`), so the table
    // maps a supersort to its subsorts, never the other way round.
    expect(subsorts(EMPTY, sortApp("SortKItem")).map(sortKey)).toEqual([
      "SortBool{}",
      "SortGeneratedCounterCellOpt{}",
      "SortGeneratedCounterCell{}",
      "SortGeneratedTopCellFragment{}",
      "SortGeneratedTopCell{}",
      "SortInt{}",
      "SortKCellOpt{}",
      "SortKCell{}",
      "SortList{}",
      "SortMap{}",
      "SortSet{}",
    ]);
    expect(subsorts(EMPTY, sortApp("SortKCellOpt")).map(sortKey)).toEqual(["SortKCell{}"]);
    // `a-to-f` adds the one sort its `test.k` declares.
    expect(subsorts(A_TO_F, sortApp("SortKItem")).map(sortKey)).toContain("SortState{}");
    expect(subsorts(EMPTY, sortApp("SortKCell"))).toEqual([]); // a leaf: no subsorts
    expect(subsorts(EMPTY, sortApp("SortNoSuchThing"))).toEqual([]);
  });

  test("the stored closure is NOT reflexive", () => {
    // pyk's `POSet` (`utils.py:100-114`) computes the transitive closure and
    // nothing else; reflexivity is `is_subsort`'s equality case, not a row.
    for (const [supersort, subs] of EMPTY.sortTable.image) {
      expect([...subs]).not.toContain(supersort);
    }
  });

  test("isSubsort transcribes pyk's four cases", () => {
    const kItem = sortApp("SortKItem");
    const kCell = sortApp("SortKCell");
    const k = sortApp("SortK");
    // 1. equal sorts (this is where reflexivity lives)
    expect(isSubsort(EMPTY, kItem, kItem)).toBe(true);
    expect(isSubsort(EMPTY, sortApp("SortNoSuchThing"), sortApp("SortNoSuchThing"))).toBe(true);
    // 2. everything is a subsort of SortK{}
    expect(isSubsort(EMPTY, kItem, k)).toBe(true);
    expect(isSubsort(EMPTY, sortApp("SortNoSuchThing"), k)).toBe(true);
    // 3. SortK{} is a subsort of nothing else
    expect(isSubsort(EMPTY, k, kItem)).toBe(false);
    // 4. otherwise, look it up
    expect(isSubsort(EMPTY, kCell, kItem)).toBe(true);
    expect(isSubsort(EMPTY, kCell, sortApp("SortKCellOpt"))).toBe(true);
    expect(isSubsort(EMPTY, kItem, kCell)).toBe(false); // not symmetric
    expect(isSubsort(EMPTY, sortApp("SortInt"), sortApp("SortBool"))).toBe(false);
    expect(isSubsort(A_TO_F, sortApp("SortState"), kItem)).toBe(true);
    expect(isSubsort(EMPTY, sortApp("SortState"), kItem)).toBe(false); // not in this fixture
  });

  test("a sort variable is keyed by its own text", () => {
    // `sortKey` is the sort's KORE text, so `R` and `SortR{}` are different keys
    // and a parametric sort is distinguished from its instances.
    expect(sortKey(sortVar("R"))).toBe("R");
    expect(sortKey(sortApp("SortMap", [sortApp("SortInt"), sortApp("SortK")]))).toBe("SortMap{SortInt{}, SortK{}}");
    expect(isSubsort(EMPTY, sortVar("R"), sortVar("R"))).toBe(true);
  });

  test("the fixtures' relations are already transitively closed", () => {
    // `kompile` emits every implied pair explicitly — `SortKCell < SortKItem` is
    // written out even though `SortKCell < SortKCellOpt < SortKItem` implies it.
    // So the closure step adds nothing here, and transitivity has to be checked
    // against a relation that is not pre-closed (next test).
    for (const index of [EMPTY, A_TO_F]) {
      let closedEdges = 0;
      for (const subs of index.sortTable.image.values()) closedEdges += subs.size;
      expect(closedEdges).toBe(subsortPairs(index.axioms).length);
    }
    // The chain is real even so: both of its links are declared.
    const chain = [sortApp("SortKCell"), sortApp("SortKCellOpt"), sortApp("SortKItem")] as const;
    expect(isSubsort(EMPTY, chain[0], chain[1])).toBe(true);
    expect(isSubsort(EMPTY, chain[1], chain[2])).toBe(true);
    expect(isSubsort(EMPTY, chain[0], chain[2])).toBe(true);
  });

  test("the closure is transitive over a chain that is not pre-closed", () => {
    const [a, b, c, d] = [sortApp("SortA"), sortApp("SortB"), sortApp("SortC"), sortApp("SortD")];
    const table = buildSubsortTable([
      [a, b],
      [b, c],
      [c, d],
    ]);
    expect(subsorts(table, d).map((s) => sortKey(s))).toEqual(["SortA{}", "SortB{}", "SortC{}"]);
    expect(subsorts(table, c).map((s) => sortKey(s))).toEqual(["SortA{}", "SortB{}"]);
    expect(subsorts(table, a)).toEqual([]);
    expect(isSubsort(table, a, d)).toBe(true);
    expect(isSubsort(table, d, a)).toBe(false);
    // Still not reflexive in the table itself.
    expect([...(table.image.get("SortD{}") ?? [])]).not.toContain("SortD{}");
  });

  test("a cyclic relation terminates instead of hanging", () => {
    // pyk would raise `RuntimeError` here (it mutates the set it iterates);
    // `computeImage` snapshots, so a cycle closes into itself and returns.
    const [a, b] = [sortApp("SortA"), sortApp("SortB")];
    const table = buildSubsortTable([
      [a, b],
      [b, a],
    ]);
    expect(subsorts(table, a).map((s) => sortKey(s))).toEqual(["SortA{}", "SortB{}"]);
    expect(isSubsort(table, a, b)).toBe(true);
  });
});

//////////////////////////
// meet                 //
//////////////////////////

describe("meetSorts", () => {
  const [a, b, c, d] = [sortApp("A"), sortApp("B"), sortApp("C"), sortApp("D")];

  /**
   * pyk's own `KoreSortTable` unit fixture (`test_kompiled.py:10-34`): `A < B`,
   * `B < C`, `B < D`, closing to `{B: {A}, C: {A, B}, D: {A, B}}`.
   */
  const POSET = buildSubsortTable([
    [a, b],
    [b, c],
    [b, d],
  ]);

  test("the closure is pyk's test_kore_sort_table expectation", () => {
    const image = [...POSET.image].map(([sup, subs]) => `${sup}: ${[...subs].toSorted().join(",")}`).toSorted();
    expect(image).toEqual(["B{}: A{}", "C{}: A{},B{}", "D{}: A{},B{}"]);
  });

  test("comparable sorts meet at the smaller one", () => {
    expect(meetSorts(POSET, a, b)).toEqual(a);
    expect(meetSorts(POSET, b, a)).toEqual(a);
    expect(meetSorts(POSET, a, c)).toEqual(a); // transitively
    expect(meetSorts(POSET, c, c)).toEqual(c);
  });

  test("incomparable sorts meet at the common subsort with the most subsorts", () => {
    // `{A, B}` are common to C and D; B has one subsort of its own and A none.
    expect(commonSubsorts(POSET, c, d)).toEqual([a, b]);
    expect(meetSorts(POSET, c, d)).toEqual(b);
  });

  test("undefined when there is no common subsort", () => {
    const table = buildSubsortTable([
      [a, b],
      [c, d],
    ]);
    expect(commonSubsorts(table, b, d)).toEqual([]);
    // pyk raises `ValueError('Sorts have no common subsort')` (`kompiled.py:253`).
    expect(meetSorts(table, b, d)).toBeUndefined();
  });

  test("undefined when the maximum is not unique, and commonSubsorts says why", () => {
    // Two candidates, neither with subsorts of its own: pyk's
    // `(subsort,) = max_subsorts` (`kompiled.py:257`) raises an opaque
    // `ValueError` here.
    const table = buildSubsortTable([
      [a, c],
      [a, d],
      [b, c],
      [b, d],
    ]);
    expect(meetSorts(table, c, d)).toBeUndefined();
    expect(commonSubsorts(table, c, d)).toEqual([a, b]);
    // The two undefined cases are told apart by whether that list is empty.
    expect(commonSubsorts(table, c, sortApp("E"))).toEqual([]);
  });

  test("SortK{} is top for the meet too, because isSubsort says so", () => {
    const k = sortApp("SortK");
    const kItem = sortApp("SortKItem");
    expect(meetSorts(EMPTY, k, kItem)).toEqual(kItem);
    expect(meetSorts(EMPTY, kItem, k)).toEqual(kItem);
    // …but the raw intersection does not special-case it, as pyk's does not:
    // `SortK{}` is in no row of the table.
    expect(commonSubsorts(EMPTY, k, kItem)).toEqual([]);
  });

  test("over a real definition", () => {
    const kCell = sortApp("SortKCell");
    const kCellOpt = sortApp("SortKCellOpt");
    const kItem = sortApp("SortKItem");
    expect(meetSorts(EMPTY, kCellOpt, kItem)).toEqual(kCellOpt);
    expect(meetSorts(EMPTY, kItem, kCell)).toEqual(kCell);
    // Two unrelated hooked sorts have nothing below either.
    expect(meetSorts(EMPTY, sortApp("SortInt"), sortApp("SortBool"))).toBeUndefined();
    expect(commonSubsorts(EMPTY, sortApp("SortInt"), sortApp("SortBool"))).toEqual([]);
  });

  test("commonSubsorts is reflexively closed and sorted", () => {
    expect(commonSubsorts(POSET, b, b).map(sortKey)).toEqual(["A{}", "B{}"]);
    // A sort the table has never seen is still in its own closure.
    const nowhere = sortApp("SortNoSuchThing");
    expect(commonSubsorts(POSET, nowhere, nowhere)).toEqual([nowhere]);
  });
});

//////////////////////////
// Declaration views    //
//////////////////////////

describe("declaration views", () => {
  test("isFunctionSymbol is `function`, not `functional`", () => {
    // `Lbl'Stop'Map` carries both; `kseq` carries `functional` and is not a
    // function; `Lbl'-LT-'k'-GT-'` carries neither.
    const unit = EMPTY.symbols.get("Lbl'Stop'Map")!;
    expect(isFunctionSymbol(unit)).toBe(true);
    expect(hasAtt(unit.attrs, ATT_FUNCTIONAL)).toBe(true);

    const kseq = EMPTY.symbols.get("kseq")!;
    expect(isFunctionSymbol(kseq)).toBe(false);
    expect(hasAtt(kseq.attrs, ATT_FUNCTIONAL)).toBe(true);
    expect(isConstructorSymbol(kseq)).toBe(true);

    expect(isFunctionSymbol(EMPTY.symbols.get("Lbl'-LT-'k'-GT-'")!)).toBe(false);
  });

  test("isSortInjection finds the prelude's inj", () => {
    expect(isSortInjection(EMPTY.symbols.get("inj")!)).toBe(true);
    expect(isSortInjection(EMPTY.symbols.get("kseq")!)).toBe(false);
  });

  test("symbolHook is the whole dotted name", () => {
    expect(symbolHook(EMPTY.symbols.get("LblMap'Coln'lookup")!)).toBe("MAP.lookup");
    expect(symbolHook(EMPTY.symbols.get("Lbl'Stop'Map")!)).toBe("MAP.unit");
    expect(symbolHook(EMPTY.symbols.get("kseq")!)).toBeUndefined();
  });

  test("collectionInfo reads a collection sort's four attributes", () => {
    expect(collectionInfo(EMPTY.sorts.get("SortMap")!)).toEqual({
      element: "Lbl'UndsPipe'-'-GT-Unds'",
      concat: "Lbl'Unds'Map'Unds'",
      unit: "Lbl'Stop'Map",
      hook: "MAP.Map",
      kind: "Map",
    });
    expect(collectionInfo(EMPTY.sorts.get("SortList")!)?.element).toBe("LblListItem");
    expect(collectionInfo(EMPTY.sorts.get("SortSet")!)?.kind).toBe("Set");
  });

  test("collectionInfo is undefined for a sort with no `element`", () => {
    // pyk's own test: `element` is what makes a sort a collection
    // (`internal.py:34`, `:123`).
    expect(collectionInfo(EMPTY.sorts.get("SortK")!)).toBeUndefined();
    expect(collectionInfo(EMPTY.sorts.get("SortInt")!)).toBeUndefined();
  });

  test("the three collection sorts are exactly the collections", () => {
    const collections = [...EMPTY.sorts.values()].filter((decl) => collectionInfo(decl) !== undefined);
    expect(collections.map((decl) => decl.name).toSorted()).toEqual(["SortList", "SortMap", "SortSet"]);
  });

  test("symbolPrinting reads the tables ModuleToKORE computed", () => {
    expect(symbolPrinting(EMPTY.symbols.get("LblMap'Coln'lookup")!)).toEqual({
      format: "%1 %c[%r %2 %c]%r",
      // One character per production item: `Map:lookup` is `M [ K ]`.
      terminals: "0101",
      colors: undefined,
      priorities: [],
      left: [],
      right: [],
      assoc: false,
      comm: false,
      bracket: false,
    });
  });

  test("symbolPrinting reads the associativity tables as symbol lists", () => {
    const concat = symbolPrinting(EMPTY.symbols.get("Lbl'Unds'Map'Unds'")!);
    expect(concat.assoc).toBe(true);
    expect(concat.format).toBe("%1%n%2");
    expect(concat.terminals).toBe("00");
    // `left{}(Lbl'Unds'Map'Unds'{}())` — the argument is an application, and its
    // head is the label.
    expect(concat.left).toEqual(["Lbl'Unds'Map'Unds'"]);
    expect(concat.right).toEqual([]);
  });

  test("symbolPrinting reads comm, the fourth member of ModuleToKORE's attsToCopy", () => {
    // `attsToCopy` is `List.of(Att.ASSOC(), Att.BRACKET(), Att.COLORS(),
    // Att.COMM())` (`ModuleToKORE.java:1793`) — four copied keys, not three, and
    // `_Map_`/`_Set_` are the two declarations in these fixtures that carry it.
    for (const symbol of ["Lbl'Unds'Map'Unds'", "Lbl'Unds'Set'Unds'"]) {
      expect(symbolPrinting(EMPTY.symbols.get(symbol)!).comm).toBe(true);
    }
    // The declaration attribute and the axiom attribute are different questions
    // asked of the same word: `Map:lookup` is a function, not a commutative
    // constructor, and carries no `comm`.
    expect(symbolPrinting(EMPTY.symbols.get("LblMap'Coln'lookup")!).comm).toBe(false);
    // Every one of the nine keys is present on a `SymbolPrinting`, always.
    expect(Object.keys(symbolPrinting(EMPTY.symbols.get("kseq")!)).toSorted()).toEqual([
      "assoc",
      "bracket",
      "colors",
      "comm",
      "format",
      "left",
      "priorities",
      "right",
      "terminals",
    ]);
  });

  test("symbolPrinting always answers, even for a symbol with no concrete syntax", () => {
    expect(symbolPrinting(EMPTY.symbols.get("kseq")!)).toEqual({
      format: undefined,
      terminals: undefined,
      colors: undefined,
      priorities: [],
      left: [],
      right: [],
      assoc: false,
      comm: false,
      bracket: false,
    });
  });

  test("attSymbol and attSymbols read application arguments, attString does not", () => {
    const decl = EMPTY.sorts.get("SortMap")!;
    expect(attSymbol(decl.attrs, "element")).toBe("Lbl'UndsPipe'-'-GT-Unds'");
    // The argument is an `App`, not a `String`, so the string reader declines.
    expect(attString(decl.attrs, "element")).toBeUndefined();
    expect(attSymbol(decl.attrs, "hook")).toBeUndefined();
    expect(attSymbol(decl.attrs, "nosuchthing")).toBeUndefined();
    expect(attSymbols(decl.attrs, "nosuchthing")).toEqual([]);
    // Present but empty, which is what `priorities{}()` is.
    expect(attSymbols(EMPTY.symbols.get("Lbl'Stop'Map")!.attrs, "priorities")).toEqual([]);
    // Two arguments, both applications.
    expect(attSymbols([app("pair", [], [app("x"), app("y")])], "pair")).toEqual(["x", "y"]);
    // A non-application argument is skipped, not reported.
    expect(attSymbols([app("mixed", [], [app("x"), koreString("y")])], "mixed")).toEqual(["x"]);
  });
});

//////////////////////////
// Lazy axioms          //
//////////////////////////

/**
 * The indexer over `parseDefinition(text, {lazyAxioms: true})` — the gap that
 * blocks reading a real `definition.kore`, which is 15–71 MB and ~95 % axiom
 * bodies.
 *
 * The claim is that a lazy index is *the same index*: everything here is built
 * from declarations and attributes, and only `classifyAxiom` reads a body.
 */
describe("indexing a lazily parsed definition", () => {
  const NAMES = ["empty.definition.kore", "a-to-f.definition.kore"];

  test.each(NAMES)("%s: the tables are identical to the eager ones", (name) => {
    const text = readFileSync(join(FIXTURES, name), "utf8");
    const eager = indexDefinition(parseDefinition(text));
    const lazy = indexDefinition(parseDefinition(text, { lazyAxioms: true }));

    expect(lazy.moduleNames).toEqual(eager.moduleNames);
    expect([...lazy.sorts.keys()]).toEqual([...eager.sorts.keys()]);
    expect([...lazy.symbols.keys()]).toEqual([...eager.symbols.keys()]);
    expect([...lazy.aliases.keys()]).toEqual([...eager.aliases.keys()]);
    expect(lazy.imports).toEqual(eager.imports);
    expect(lazy.claims).toEqual(eager.claims);
    expect(lazy.axioms).toHaveLength(eager.axioms.length);
    // Every axiom is lazy, and its attributes are the eager one's.
    for (const [i, axiom] of lazy.axioms.entries()) {
      expect(axiom.tag).toBe("LazyAxiom");
      expect(axiom.attrs).toEqual(eager.axioms[i]!.attrs);
      expect(axiom.vars).toEqual(eager.axioms[i]!.vars);
    }
  });

  test.each(NAMES)("%s: the subsort table survives, attributes being all it needs", (name) => {
    const text = readFileSync(join(FIXTURES, name), "utf8");
    const eager = indexDefinition(parseDefinition(text));
    const lazy = indexDefinition(parseDefinition(text, { lazyAxioms: true }));

    expect(subsortPairs(lazy.axioms).map(([sub, sup]) => `${sortKey(sub)} < ${sortKey(sup)}`)).toEqual(
      subsortPairs(eager.axioms).map(([sub, sup]) => `${sortKey(sub)} < ${sortKey(sup)}`),
    );
    expect(subsortRows(lazy)).toEqual(subsortRows(eager));
    expect(isSubsort(lazy, sortApp("SortKCell"), sortApp("SortKItem"))).toBe(true);
  });

  test("classifyAxiom needs a body, so a lazy axiom goes through forceAxiom", () => {
    const text = readFileSync(join(FIXTURES, "empty.definition.kore"), "utf8");
    const eager = indexDefinition(parseDefinition(text));
    const lazy = indexDefinition(parseDefinition(text, { lazyAxioms: true }));
    // The one function in this module that reads a pattern. Forcing is per-axiom
    // and costs only that axiom's body.
    const forced = lazy.axioms.map((axiom) => (axiom.tag === "LazyAxiom" ? forceAxiom(text, axiom) : axiom));
    expect(histogram(forced)).toEqual(histogram(eager.axioms));
  });
});

//////////////////////////
// Axiom classification //
//////////////////////////

describe("classifyAxiom", () => {
  test("empty.definition.kore histogram", () => {
    expect(histogram(EMPTY.axioms)).toEqual([
      ["assoc", 3],
      ["comm", 2],
      ["equation", 34],
      ["functional", 46],
      ["idem", 1],
      ["no-confusion", 4],
      ["no-junk", 14],
      ["owise", 13],
      ["simplification", 2],
      ["subsort", 13],
      ["unit", 6],
    ]);
  });

  test("a-to-f.definition.kore histogram", () => {
    expect(histogram(A_TO_F.axioms)).toEqual([
      ["assoc", 3],
      ["comm", 2],
      ["equation", 36],
      ["functional", 47],
      ["idem", 1],
      ["no-confusion", 4],
      ["no-junk", 15],
      ["owise", 14],
      ["rewrite", 5],
      ["simplification", 1],
      ["subsort", 14],
      ["unit", 6],
    ]);
  });

  test("no axiom in either fixture falls through to `other`", () => {
    // This is the whole claim of the module: pyk's `Rule.from_axiom` raises on
    // `comm` axioms, on `--enable-kore-antileft` rewrites, and on every axiom
    // without a `UNIQUE'Unds'ID`. All three are in these fixtures.
    for (const index of [EMPTY, A_TO_F, PRELUDE]) {
      const others = index.axioms.map((a) => classifyAxiom(a)).filter((c) => c.kind === "other");
      expect(others).toEqual([]);
    }
  });

  test("`anywhere` is transcribed but unexercised by the fixtures", () => {
    // Neither fixture contains an `anywhere{}()` axiom, so the branch is proved
    // by construction instead: the same body, re-tagged.
    for (const index of [EMPTY, A_TO_F]) {
      expect(histogram(index.axioms).some(([kind]) => kind === "anywhere")).toBe(false);
    }
    const equation = onlyAxiom(EMPTY, isAppendDotK);
    const anywhere = classifyAxiom({ ...equation, attrs: [...equation.attrs, app("anywhere")] });
    expect(anywhere.kind).toBe("anywhere");
  });

  test("a rewrite axiom: TEST.AB, in the `--enable-kore-antileft` alias shape", () => {
    const axiom = onlyAxiom(A_TO_F, (a) => attString(a.attrs, "label") === "TEST.AB");
    const rule = classifyAxiom(axiom);
    expect(rule.kind).toBe("rewrite");
    if (rule.kind !== "rewrite") throw new Error("unreachable");

    expect(sortKey(rule.sort)).toBe("SortGeneratedTopCell{}");
    expect(rule.label).toBe("TEST.AB");
    expect(rule.uid).toBe("c1f590c5d8ddb1b2c2c60b5518088733bde280013d0d8c69b05264cc34678d84");
    expect(rule.priority).toBe(50);

    // The LHS is an alias application, and the alias it names is declared.
    expect(rule.lhsAlias?.symbol).toBe("rule0LHS");
    expect(rule.lhs).toBe(rule.lhsAlias!);
    expect(rule.lhs).toEqual(
      app(
        "rule0LHS",
        [],
        [evar("Var'Unds'DotVar0", sortApp("SortGeneratedCounterCell")), evar("Var'Unds'DotVar1", sortApp("SortK"))],
      ),
    );
    expect(A_TO_F.aliases.get("rule0LHS")?.paramSorts.map(sortKey)).toEqual(["SortGeneratedCounterCell{}", "SortK{}"]);

    // The RHS is the configuration; in the alias shape the `\and` is written
    // ensures-first, so reading it the other way round would hand back `\top`.
    expect(rule.rhs.tag).toBe("App");
    expect(koreText(rule.rhs)).toBe(
      "Lbl'-LT-'generatedTop'-GT-'{}(Lbl'-LT-'k'-GT-'{}(kseq{}(inj{SortState{}, SortKItem{}}" +
        "(\\dv{SortState{}}(\"b\")), Var'Unds'DotVar1 : SortK{})), Var'Unds'DotVar0 : SortGeneratedCounterCell{})",
    );

    // Unconditional rule, no priority group to exclude, no `#Configuration` var.
    expect(rule.requires).toBeUndefined();
    expect(rule.ensures).toBeUndefined();
    expect(rule.antiLeft).toBeUndefined();
    expect(rule.ctx).toBeUndefined();
  });

  test("all five a-to-f rewrites are the a→b→c→d→e→f chain", () => {
    const rewrites = A_TO_F.axioms.map((a) => classifyAxiom(a)).filter((c) => c.kind === "rewrite");
    expect(rewrites.map((r) => r.label)).toEqual(["TEST.AB", "TEST.AC", "TEST.CD", "TEST.DE", "TEST.EF"]);
    expect(rewrites.map((r) => r.lhsAlias?.symbol)).toEqual([
      "rule0LHS",
      "rule1LHS",
      "rule2LHS",
      "rule3LHS",
      "rule4LHS",
    ]);
    expect(rewrites.every((r) => r.priority === 50)).toBe(true);
    expect(rewrites.every((r) => r.uid !== undefined)).toBe(true);
  });

  test("an equation axiom: `append(dotk(), TAIL) = TAIL` from the prelude's KSEQ", () => {
    // pyk hard-skips this exact axiom by literal comparison (`rule.py:52-60`,
    // `144-149`) because it has no `UNIQUE'Unds'ID` and `_extract_uid` would
    // raise. Its shape is the canonical function rule, so it is read here.
    const axiom = onlyAxiom(PRELUDE, isAppendDotK);
    const rule = classifyAxiom(axiom);
    expect(rule.kind).toBe("equation");
    if (rule.kind !== "equation") throw new Error("unreachable");

    expect(rule.symbol).toBe("append");
    // The `\in` binders are reassembled into the head, pyk `rule.py:300-301`.
    expect(rule.lhs).toEqual(app("append", [], [app("dotk"), evar("TAIL", sortApp("SortK"))]));
    expect(rule.argSorts.map(sortKey)).toEqual(["SortK{}", "SortK{}"]);
    expect(sortKey(rule.sort)).toBe("SortK{}");
    expect(rule.rhs).toEqual(evar("TAIL", sortApp("SortK")));
    expect(rule.requires).toBeUndefined();
    expect(rule.ensures).toBeUndefined();
    expect(rule.antiLeft).toBeUndefined();
    expect(rule.priority).toBe(50);
    expect(rule.uid).toBeUndefined(); // this is exactly why pyk skips it
    expect(rule.label).toBeUndefined();
  });

  test("an owise equation carries its anti-left guard and priority 200", () => {
    const rules = EMPTY.axioms.map((a) => classifyAxiom(a)).filter((c): c is EquationAxiom => c.kind === "owise");
    expect(rules).toHaveLength(13);
    const isBool = rules.filter((r) => r.symbol === "LblisBool");
    expect(isBool).toHaveLength(1);
    const rule = isBool[0]!;
    expect(rule.lhs).toEqual(app("LblisBool", [], [evar("VarK", sortApp("SortK"))]));
    expect(rule.argSorts.map(sortKey)).toEqual(["SortK{}"]);
    expect(koreText(rule.rhs)).toBe('\\dv{SortBool{}}("false")');
    // pyk derives 200 from the `owise` attribute (`rule.py:505-506`).
    expect(rule.priority).toBe(200);
    // The guard is the `\or` of every non-owise left-hand side for this symbol.
    expect(rule.antiLeft?.tag).toBe("Or");
    expect(rules.every((r) => r.antiLeft !== undefined && r.priority === 200)).toBe(true);
  });

  test("a projection equation matches under a constructor pattern", () => {
    const rule = EMPTY.axioms
      .map((a) => classifyAxiom(a))
      .find((c) => c.kind === "equation" && c.symbol === "Lblproject'Coln'Bool");
    expect(rule?.kind).toBe("equation");
    if (rule?.kind !== "equation") throw new Error("unreachable");
    expect(koreText(rule.lhs)).toBe(
      "Lblproject'Coln'Bool{}(kseq{}(inj{SortBool{}, SortKItem{}}(VarK : SortBool{}), dotk{}()))",
    );
    expect(sortKey(rule.sort)).toBe("SortBool{}");
    expect(rule.rhs).toEqual(evar("VarK", sortApp("SortBool")));
  });

  test("both simplification shapes in empty.definition.kore", () => {
    const simpls = EMPTY.axioms.map((a) => classifyAxiom(a)).filter((c) => c.kind === "simplification");
    expect(simpls).toHaveLength(2);
    expect(simpls.map((s) => s.shape)).toEqual(["App", "Ceil"]);

    // 1. The prelude INJ axiom: a bare `\equals`, no `\implies`. pyk skips this
    //    one by literal comparison (`rule.py:89-96`).
    const inj = simpls[0]!;
    expect(sortKey(inj.sort)).toBe("S3");
    expect(koreText(inj.lhs)).toBe("inj{S2, S3}(inj{S1, S2}(T : S1))");
    expect(koreText(inj.rhs)).toBe("inj{S1, S3}(T : S1)");
    expect(inj.requires).toBeUndefined();
    expect(inj.ensures).toBeUndefined();
    expect(inj.priority).toBe(50);

    // 2. A `\ceil` simplification — pyk's `CeilRule` (`rule.py:401-428`).
    const ceil = simpls[1]!;
    expect(ceil.lhs.tag).toBe("Ceil");
    expect(sortKey(ceil.sort)).toBe("Q0");
    expect(ceil.priority).toBe(50);
  });

  test('`simplification{}("N")` sets the priority', () => {
    const axiom = onlyAxiom(EMPTY, (a) => {
      const c = classifyAxiom(a);
      return c.kind === "simplification" && c.shape === "Ceil";
    });
    const reprioritized = classifyAxiom({
      ...axiom,
      attrs: [app("simplification", [], [koreString("42")])],
    });
    expect(reprioritized.kind).toBe("simplification");
    if (reprioritized.kind !== "simplification") throw new Error("unreachable");
    expect(reprioritized.priority).toBe(42);
  });

  test("marker axioms are classified by attribute, before any shape is looked at", () => {
    const kinds = new Map<string, string>();
    for (const axiom of EMPTY.axioms) {
      const c = classifyAxiom(axiom);
      const key = axiom.attrs
        .map((a) => a.symbol)
        .toSorted()
        .join(",");
      if (key !== "") kinds.set(`${key}|${axiom.pattern.tag}`, c.kind);
    }
    expect(kinds.get("functional|Exists")).toBe("functional");
    expect(kinds.get("subsort|Exists")).toBe("subsort");
    // One attribute, three structural roles — split the way ModuleToKORE's own
    // trailing comments split them.
    expect(kinds.get("constructor|Or")).toBe("no-junk");
    expect(kinds.get("constructor|Bottom")).toBe("no-junk");
    expect(kinds.get("constructor|Implies")).toBe("no-confusion");
    // `comm` is *not* in pyk's `_SKIPPED_ATTRS`; pyk would try to read this as a
    // function rule and raise.
    expect(kinds.get("comm|Equals")).toBe("comm");
    expect(kinds.get("assoc|Equals")).toBe("assoc");
    expect(kinds.get("idem|Equals")).toBe("idem");
    expect(kinds.get("unit|Equals")).toBe("unit");
  });

  test("a subsort axiom exposes the attribute's two sort parameters", () => {
    const classes = EMPTY.axioms.map((a) => classifyAxiom(a)).filter((c) => c.kind === "subsort");
    expect(classes).toHaveLength(13);
    const pairs = classes.map(
      (c) => `${c.subsort ? sortKey(c.subsort) : "?"} < ${c.supersort ? sortKey(c.supersort) : "?"}`,
    );
    expect(pairs).toContain("SortKCell{} < SortKCellOpt{}");
    // The body is an `\exists`, and it is never read: the attribute is the claim.
    expect(classes.every((c) => c.subsort !== undefined && c.supersort !== undefined)).toBe(true);
  });

  test("an unrecognised axiom is `other`, not an exception", () => {
    const nonsense: Axiom = { tag: "Axiom", vars: [], pattern: app("Lblfoo"), attrs: [] };
    const result = classifyAxiom(nonsense);
    expect(result.kind).toBe("other");
    if (result.kind !== "other") throw new Error("unreachable");
    expect(result.reason).toContain("App");

    // Every branch that can fail says which test failed.
    const halfRewrite: Axiom = {
      tag: "Axiom",
      vars: [],
      pattern: { tag: "Rewrites", sort: sortApp("SortK"), left: koreString("x"), right: koreString("y") },
      attrs: [],
    };
    expect(classifyAxiom(halfRewrite).kind).toBe("other");
  });

  test("classifyAxiom accepts a Claim", () => {
    const claim: Claim = { tag: "Claim", vars: [], pattern: app("Lblfoo"), attrs: [app("assoc")] };
    expect(classifyAxiom(claim).kind).toBe("assoc");
  });
});

describe("source attributes on a real axiom", () => {
  test("TEST.AB carries its K source file and span", () => {
    const axiom = onlyAxiom(A_TO_F, (a) => attString(a.attrs, "label") === "TEST.AB");
    expect(attSource(axiom.attrs)).toBe(
      "/home/jost/work/RV/code/haskell-backend/test/rpc-server/resources/a-to-f/test.k",
    );
    expect(attString(axiom.attrs, ATT_SOURCE)).toBe(
      "Source(/home/jost/work/RV/code/haskell-backend/test/rpc-server/resources/a-to-f/test.k)",
    );
    expect(attLocation(axiom.attrs)).toEqual({
      startLine: 12,
      startColumn: 14,
      endLine: 12,
      endColumn: 20,
    });
  });

  test("every a-to-f rewrite has a location, and the five are consecutive lines", () => {
    const rewrites = A_TO_F.axioms.filter((a) => classifyAxiom(a).kind === "rewrite");
    expect(rewrites.map((a) => attLocation(a.attrs)?.startLine)).toEqual([12, 13, 14, 15, 16]);
  });

  test("an axiom without the attributes reads as undefined", () => {
    const bare = onlyAxiom(PRELUDE, isAppendDotK);
    expect(bare.attrs).toEqual([]);
    expect(attSource(bare.attrs)).toBeUndefined();
    expect(attLocation(bare.attrs)).toBeUndefined();
  });
});

//////////////////////////
// prelude.kore         //
//////////////////////////

describe("prelude.kore", () => {
  test("its four modules index", () => {
    expect(PRELUDE.moduleNames).toEqual(["BASIC-K", "KSEQ", "INJ", "K"]);
    expect(PRELUDE.sorts.size).toBe(2);
    expect([...PRELUDE.sorts.keys()]).toEqual(["SortK", "SortKItem"]);
    expect(PRELUDE.axioms).toHaveLength(3);
    expect(PRELUDE.imports).toHaveLength(3);
  });

  test("kseq, dotk, append and inj are all found", () => {
    expect([...PRELUDE.symbols.keys()]).toEqual(["kseq", "dotk", "append", "inj"]);
    expect(PRELUDE.symbols.get("dotk")?.paramSorts).toEqual([]);
    expect(sortKey(PRELUDE.symbols.get("dotk")!.sort)).toBe("SortK{}");
    expect(PRELUDE.symbols.get("append")?.paramSorts.map(sortKey)).toEqual(["SortK{}", "SortK{}"]);
    expect(hasAtt(PRELUDE.symbols.get("kseq")!.attrs, "constructor")).toBe(true);
    expect(hasAtt(PRELUDE.symbols.get("append")!.attrs, "function")).toBe(true);
  });

  test("its three aliases are the temporal-logic connectives", () => {
    expect([...PRELUDE.aliases.keys()]).toEqual(["weakExistsFinally", "weakAlwaysFinally", "allPathGlobally"]);
  });

  test("its three axioms are the two append equations and the inj simplification", () => {
    expect(histogram(PRELUDE.axioms)).toEqual([
      ["equation", 2],
      ["simplification", 1],
    ]);
  });

  test("the prelude's symbols keep their signatures inside a real definition", () => {
    // Signatures only, not whole declarations: `kompile` re-emits the prelude
    // with a different attribute set (the standalone `prelude.kore` marks `kseq`
    // and `dotk` `injective{}()`; `definition.kore` does not), and that
    // difference is the emitter's, not this index's.
    for (const name of ["kseq", "dotk", "append", "inj"]) {
      const reference = PRELUDE.symbols.get(name)!;
      for (const index of [EMPTY, A_TO_F]) {
        const found = index.symbols.get(name);
        expect(found?.symbol).toEqual(reference.symbol);
        expect(found?.paramSorts).toEqual(reference.paramSorts);
        expect(found?.sort).toEqual(reference.sort);
      }
    }
  });
});
