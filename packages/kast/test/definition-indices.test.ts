/**
 * `KDefinition`'s derived indices — the sort lattice, the sort-inference
 * machinery, the unparser indices and the sentence filters added for
 * `konvert` and `kompiled`.
 *
 * # Provenance of every table here
 *
 * pyk has **no unit test** for any of this: its coverage is entirely indirect,
 * through `konvert`'s integration suite, which needs a `*-kompiled` directory.
 * One table is a transcription and the rest are ours:
 *
 * 1. `SORT_TERM_DATA` (`tests/integration/konvert/test_simple_proofs.py:664`,
 *    12 rows) tests `KDefinition.sort` directly, and runs here against the
 *    same definition upstream runs it against: `packages/konvert/fixtures/
 *    definitions/simple-proofs.compiled.json`, the real output of
 *    `kompile simple-proofs.k --syntax-module SIMPLE-PROOFS --backend haskell
 *    --emit-json` at K `v7.1.337` (`packages/konvert/fixtures/PROVENANCE.md`).
 *    All 12 rows also pass against the `.llvm.` build of the same source, the
 *    one pyk's `KompiledTest` default actually produces; the rows only reach
 *    for `Int < KItem < K`, `Bool < KItem` and the parametric `ite`, on which
 *    the two builds agree.
 * 2. Everything else is behaviour with no upstream test at all, written
 *    against the `outer.py` line numbers each `describe` cites, on the
 *    hand-built lattices below.
 *
 * `kast` is a leaf package, so the fixture is read by relative path rather than
 * through a dependency — the convention `packages/ktool/test/kprint.test.ts`
 * already uses for `kompiled`'s fixtures.
 *
 * `test/formatter.test.ts` covers `brackets` / `priorities` / `*Assocs` /
 * `syntaxSymbols` end to end; what is here is their shape.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Atts, EMPTY_ATT, KAtt, attEntry } from "../src/att.ts";
import {
  kapply,
  klabel,
  krewrite,
  ksequence,
  ksort,
  ktoken,
  kvariable,
  type KInner,
  type KSort,
} from "../src/inner.ts";
import {
  KAssoc,
  KDefinition,
  kflatmodule,
  kimport,
  knonterminal,
  kproduction,
  krule,
  kclaim,
  ksyntaxassociativity,
  ksyntaxpriority,
  ksyntaxsort,
  kterminal,
  moduleClaims,
  moduleConstructors,
  moduleFunctions,
  moduleMapSentences,
  moduleSentenceByUniqueId,
  moduleSyntaxSorts,
  productionIsFunction,
  readKastDefinitionFromJson,
  sortKey,
  intersperse,
  notNone,
  type KProduction,
  type KProductionItem,
  type KSentence,
} from "../src/outer.ts";
import { K, K_ITEM } from "../src/prelude/k.ts";
import { BOOL } from "../src/prelude/kbool.ts";
import { INT, intToken } from "../src/prelude/kint.ts";

const NT = knonterminal;
const T = kterminal;

function att(...entries: readonly (readonly [Parameters<typeof attEntry>[0], unknown])[]): KAtt {
  return new KAtt(entries.map(([key, value]) => attEntry(key, value)));
}

/** `syntax Sup ::= Sub` — the only shape {@link productionAsSubsort} recognises. */
function subsort(sup: string, sub: string): KProduction {
  return kproduction(sup, { items: [NT(ksort(sub))] });
}

function symbol(
  sort: string,
  label: string,
  items: readonly KProductionItem[] = [],
  attributes: KAtt = EMPTY_ATT,
  params: readonly string[] = [],
): KProduction {
  return kproduction(sort, { items, klabel: klabel(label), att: attributes, params });
}

//////////////////////////////////////////////////////////////////
// The lattice fixture — `simple-proofs.k`'s prelude, by hand    //
//////////////////////////////////////////////////////////////////

/**
 * `Int < KItem < K`, `Bool < KItem`, plus an `ite` and a couple of plain
 * symbols.  Enough for the lattice tables, which need a `Nat` the real
 * definition does not declare and want a lattice small enough to state in full.
 */
const LATTICE = new KDefinition("TEST", [
  kflatmodule("TEST", {
    sentences: [
      subsort("K", "KItem"),
      subsort("KItem", "Int"),
      subsort("KItem", "Bool"),
      subsort("Int", "Nat"),
      symbol("Int", "_+Int_", [NT(INT), T("+Int"), NT(INT)]),
      symbol("Bool", "_<Int_", [NT(INT), T("<"), NT(INT)], att([Atts.FUNCTION, null])),
      symbol("Int", "ite", [T("ite"), T("("), NT(BOOL), T(","), NT(ksort("S")), T(","), NT(ksort("S")), T(")")]),
    ],
  }),
]);

/**
 * `simple-proofs.k` as `kompile` emits it — 67 modules, the whole K prelude.
 * `SORT_TERM_DATA`, `resolveSorts` and `addSortParams` run against this rather
 * than a hand-built lattice: its `ite` is the genuinely parametric
 * `syntax {Sort} Sort ::= ite(Bool, Sort, Sort)` of `K-EQUAL-SYNTAX`, which is
 * the production those three describes are about.
 */
const SIMPLE_PROOFS = readKastDefinitionFromJson(
  readFileSync(
    join(import.meta.dir, "..", "..", "konvert", "fixtures", "definitions", "simple-proofs.compiled.json"),
    "utf8",
  ),
);

describe("subsortTable / subsorts / isSubsort", () => {
  test("is the transitive closure of `syntax Sup ::= Sub` (outer.py:1220-1224)", () => {
    const names = (sort: string): readonly string[] => LATTICE.subsorts(ksort(sort)).map((s) => s.name);
    expect(names("K")).toEqual(["Bool", "Int", "KItem", "Nat"].toSorted());
    expect(names("KItem")).toEqual(["Bool", "Int", "Nat"].toSorted());
    expect(names("Int")).toEqual(["Nat"]);
    expect(names("Nat")).toEqual([]);
    expect(names("Bool")).toEqual([]);
  });

  test("is keyed by sortKey, not by identity", () => {
    // Two structurally equal `KSort` objects, deliberately distinct instances.
    expect(LATTICE.subsortTable.get(sortKey(ksort("KItem")))?.has(sortKey(ksort("Int")))).toBe(true);
    expect(LATTICE.subsortTable.has("KItem")).toBe(false);
  });

  test("is not reflexive — POSet is Warshall and nothing else (utils.py:100-114)", () => {
    expect(LATTICE.subsorts(ksort("K")).some((s) => s.name === "K")).toBe(false);
  });

  test("isSubsort is reflexive where subsorts is not", () => {
    expect(LATTICE.isSubsort(ksort("Int"), ksort("K"))).toBe(true);
    expect(LATTICE.isSubsort(ksort("K"), ksort("Int"))).toBe(false);
    expect(LATTICE.isSubsort(ksort("Int"), ksort("Int"))).toBe(true);
    expect(LATTICE.isSubsort(ksort("Unheard"), ksort("Unheard"))).toBe(true);
    expect(LATTICE.isSubsort(ksort("Unheard"), ksort("K"))).toBe(false);
  });

  test("a sort nothing declares has no subsorts", () => {
    expect(LATTICE.subsorts(ksort("Unheard"))).toEqual([]);
  });

  test("the table is computed once", () => {
    expect(LATTICE.subsortTable).toBe(LATTICE.subsortTable);
  });
});

describe("leastCommonSupersort / greatestCommonSubsort (outer.py:1380-1403)", () => {
  const lcs = (a: string, b: string): string | undefined => LATTICE.leastCommonSupersort(ksort(a), ksort(b))?.name;
  const gcs = (a: string, b: string): string | undefined => LATTICE.greatestCommonSubsort(ksort(a), ksort(b))?.name;

  test("equal sorts are their own join and meet", () => {
    expect(lcs("Int", "Int")).toBe("Int");
    expect(gcs("Int", "Int")).toBe("Int");
  });

  test("comparable sorts pick the right end", () => {
    expect(lcs("Int", "KItem")).toBe("KItem");
    expect(lcs("KItem", "Int")).toBe("KItem");
    expect(gcs("Int", "KItem")).toBe("Int");
    expect(gcs("KItem", "Int")).toBe("Int");
  });

  test("incomparable sorts are undefined, even though a LUB exists", () => {
    // `Int` and `Bool` do have `KItem` above them; upstream's comment
    // (`outer.py:1387-1389`) says computing that is unsupported.  Kept.
    expect(lcs("Int", "Bool")).toBeUndefined();
    expect(gcs("Int", "Bool")).toBeUndefined();
  });
});

/** `SORT_TERM_DATA` (`test_simple_proofs.py:664-740`), 12 rows. */
const SORT_TERM_DATA: readonly (readonly [string, KInner, KSort])[] = [
  ["variable-int", kvariable("X", "Int"), INT],
  ["variable-bool", kvariable("X", "Bool"), BOOL],
  ["variable-k", kvariable("X", "K"), K],
  ["variable-kitem", kvariable("X", "KItem"), K_ITEM],
  ["int-token", intToken(1), INT],
  ["bool-token", ktoken("true", "Bool"), BOOL],
  ["ksequence", ksequence([intToken(0), intToken(1), intToken(2)]), K],
  ["krewrite-same-sort", krewrite(intToken(0), intToken(1)), INT],
  ["krewrite-direct-supersort-lhs", krewrite(intToken(0), kvariable("X", "KItem")), K_ITEM],
  ["krewrite-direct-supersort-rhs", krewrite(kvariable("X", "KItem"), intToken(0)), K_ITEM],
  ["sort-parametric-int", kapply(klabel("ite", [INT]), [ktoken("true", "Bool"), intToken(1), intToken(2)]), INT],
  [
    "sort-parametric-bool",
    kapply(klabel("ite", [BOOL]), [ktoken("true", "Bool"), ktoken("true", "Bool"), ktoken("false", "Bool")]),
    BOOL,
  ],
];

describe("sortOf — SORT_TERM_DATA (test_simple_proofs.py:664)", () => {
  for (const [id, term, expected] of SORT_TERM_DATA) {
    test(id, () => {
      expect(SIMPLE_PROOFS.sortOf(term)?.name).toBe(expected.name);
    });
  }
});

describe("sortOf / sortStrict (outer.py:1344-1368)", () => {
  test("an unsorted variable has no sort", () => {
    expect(LATTICE.sortOf(kvariable("X"))).toBeUndefined();
  });

  test("a KAs has no sort", () => {
    expect(LATTICE.sortOf({ node: "KAs", pattern: intToken(1), alias: kvariable("X") })).toBeUndefined();
  });

  test("a rewrite between incomparable sorts has no sort", () => {
    expect(LATTICE.sortOf(krewrite(intToken(1), ktoken("true", "Bool")))).toBeUndefined();
  });

  // Regression: these four returned `RangeError` instead of `undefined` when
  // the rewrite arm read its side sorts through the out-of-bounds-checking
  // `at()`, which cannot represent a legitimately-undefined element
  // (`outer.py:1348-1353` answers `None` for all four).
  test("a rewrite with an undeterminable side has no sort, not an error", () => {
    expect(LATTICE.sortOf(krewrite(kvariable("X"), intToken(2)))).toBeUndefined();
    expect(LATTICE.sortOf(krewrite(intToken(2), kvariable("X")))).toBeUndefined();
    expect(LATTICE.sortOf(krewrite(kvariable("X"), kvariable("Y")))).toBeUndefined();
    expect(
      LATTICE.sortOf(krewrite({ node: "KAs", pattern: intToken(1), alias: kvariable("X") }, intToken(2))),
    ).toBeUndefined();
  });

  test("nested rewrites do not recurse — the machine is a stack", () => {
    // Deep enough that a recursive implementation would blow the JS stack.
    let term: KInner = intToken(0);
    for (let i = 0; i < 50_000; i++) term = krewrite(term, intToken(i));
    expect(LATTICE.sortOf(term)?.name).toBe("Int");
  });

  test("sortStrict throws where sortOf answers undefined", () => {
    expect(() => LATTICE.sortStrict(kvariable("X"))).toThrow(/Could not determine sort/u);
    expect(LATTICE.sortStrict(intToken(1)).name).toBe("Int");
  });

  test("an unknown symbol is an error, as `self.symbols[...]` is upstream", () => {
    expect(() => LATTICE.sortOf(kapply("nope"))).toThrow(/Symbol not found/u);
  });
});

describe("resolveSorts (outer.py:1370-1378)", () => {
  test("substitutes the label's params for the production's", () => {
    const [result, args] = SIMPLE_PROOFS.resolveSorts(klabel("ite", [INT]));
    expect(result.name).toBe("Int");
    expect(args.map((s) => s.name)).toEqual(["Bool", "Int", "Int"]);
  });

  test("leaves a non-parametric production alone", () => {
    const [result, args] = LATTICE.resolveSorts(klabel("_+Int_"));
    expect(result.name).toBe("Int");
    expect(args.map((s) => s.name)).toEqual(["Int", "Int"]);
  });

  test("a parameter-count mismatch is an error (zip strict=True)", () => {
    expect(() => SIMPLE_PROOFS.resolveSorts(klabel("ite"))).toThrow(/expected 1 argument/u);
  });
});

//////////////////////////////
// sortVars                 //
//////////////////////////////

/** `Int < KItem < K`, `Nat < Int`, a binary `f(Int, KItem)` and the ML binders. */
const VARS = new KDefinition("TEST", [
  kflatmodule("TEST", {
    sentences: [
      subsort("K", "KItem"),
      subsort("KItem", "Int"),
      subsort("Int", "Nat"),
      symbol("KItem", "f", [T("f"), T("("), NT(INT), T(","), NT(K_ITEM), T(")")]),
      symbol("Int", "g", [T("g"), T("("), NT(ksort("Nat")), T(")")]),
      symbol("KItem", "#Exists", [T("#Exists"), NT(K_ITEM), NT(K_ITEM)]),
      symbol("KItem", "poly", [T("poly"), T("("), NT(ksort("S")), T(")")], EMPTY_ATT, ["S"]),
    ],
  }),
]);

describe("sortVars (outer.py:1423-1500)", () => {
  test("gives an argument variable the production's argument sort", () => {
    expect(VARS.sortVars(kapply("f", [kvariable("X"), kvariable("Y")]))).toEqual(
      kapply("f", [kvariable("X", INT), kvariable("Y", K_ITEM)]),
    );
  });

  test("reconciles two demands with greatestCommonSubsort", () => {
    // `X` is demanded as `Int` by `f`'s first argument and as `Nat` by `g`'s.
    expect(VARS.sortVars(kapply("f", [kvariable("X"), kapply("g", [kvariable("X")])]))).toEqual(
      kapply("f", [kvariable("X", ksort("Nat")), kapply("g", [kvariable("X", ksort("Nat"))])]),
    );
  });

  test("conflicting demands are an error, not a widening", () => {
    // `Int` and `KItem` are comparable; `Int` and a sort outside the lattice
    // are not.
    const term = kapply("f", [kvariable("X"), kvariable("X", ksort("String"))]);
    expect(() => VARS.sortVars(term)).toThrow(/Cannot compute greatest common subsort of X/u);
  });

  test("both sides of a rewrite agree — the shape kruleToKore relies on", () => {
    // `_kast_to_kore.py:253` calls this once on a synthetic `KRewrite`.
    const sorted = VARS.sortVars(
      krewrite(kapply("g", [kvariable("X")]), kapply("f", [kvariable("X"), kvariable("Y")])),
    );
    expect(sorted).toEqual(
      krewrite(
        kapply("g", [kvariable("X", ksort("Nat"))]),
        kapply("f", [kvariable("X", ksort("Nat")), kvariable("Y", K_ITEM)]),
      ),
    );
  });

  test("a KSequence demands KItem, except in the last position (outer.py:1487-1495)", () => {
    expect(VARS.sortVars(ksequence([kvariable("X"), kvariable("Y")]))).toEqual(
      ksequence([kvariable("X", K_ITEM), kvariable("Y", K)]),
    );
  });

  test("the optional sort applies only to a bare top-level variable (outer.py:1427-1428)", () => {
    expect(VARS.sortVars(kvariable("X"), INT)).toEqual(kvariable("X", INT));
    // Already sorted: untouched.
    expect(VARS.sortVars(kvariable("X", K), INT)).toEqual(kvariable("X", K));
    // Not at the top: the expectation does not propagate.
    expect(VARS.sortVars(ksequence([kvariable("X")]), INT)).toEqual(ksequence([kvariable("X", K)]));
  });

  test("a quantifier scopes its bound variable (outer.py:1467-1472)", () => {
    // `X` inside `#Exists` is demanded as `Nat`, outside as `Int`.  Deleting
    // the bound name from the occurrence map is what keeps the *outer* answer
    // from being narrowed to `Nat` — but the final `Subst` is naive
    // (`inner.py:723-731`) and rewrites by name only, so the inner
    // occurrences are then re-substituted with the outer sort.  Both halves
    // are upstream's behaviour; do not "fix" the second.
    const term = kapply("f", [kvariable("X"), kapply("#Exists", [kvariable("X"), kapply("g", [kvariable("X")])])]);
    expect(VARS.sortVars(term)).toEqual(
      kapply("f", [kvariable("X", INT), kapply("#Exists", [kvariable("X", INT), kapply("g", [kvariable("X", INT)])])]),
    );
  });

  test("a quantifier's demands cannot conflict with the enclosing scope", () => {
    // Without the `del occurrences[var.name]` at `outer.py:1471`, `String`
    // and `Int` would meet and the reconciliation would throw.
    const term = kapply("f", [kvariable("X"), kapply("#Exists", [kvariable("X", "String"), kvariable("X", "String")])]);
    expect(VARS.sortVars(term)).toEqual(
      kapply("f", [kvariable("X", INT), kapply("#Exists", [kvariable("X", INT), kvariable("X", INT)])]),
    );
  });

  test("a quantifier must bind a variable", () => {
    expect(() => VARS.sortVars(kapply("#Exists", [intToken(1), kvariable("X")]))).toThrow(
      /first child to be a variable/u,
    );
    expect(() => VARS.sortVars(kapply("#Forall", [kvariable("X")]))).toThrow(/2 children/u);
  });

  test("a production with sort parameters contributes no demand (outer.py:1479)", () => {
    expect(VARS.sortVars(kapply(klabel("poly", [INT]), [kvariable("X")]))).toEqual(
      kapply(klabel("poly", [INT]), [kvariable("X")]),
    );
  });
});

describe("addSortParams (outer.py:1503-1529)", () => {
  test("fills the label's params in from the argument sorts", () => {
    expect(SIMPLE_PROOFS.addSortParams(kapply("ite", [ktoken("true", "Bool"), intToken(1), intToken(2)]))).toEqual(
      kapply(klabel("ite", [INT]), [ktoken("true", "Bool"), intToken(1), intToken(2)]),
    );
  });

  test("leaves the term alone when an argument's sort is unknown", () => {
    const term = kapply("ite", [ktoken("true", "Bool"), kvariable("X"), intToken(2)]);
    expect(SIMPLE_PROOFS.addSortParams(term)).toEqual(term);
  });

  test("leaves the term alone when two occurrences of a parameter disagree", () => {
    const term = kapply("ite", [ktoken("true", "Bool"), intToken(1), ktoken("true", "Bool")]);
    expect(SIMPLE_PROOFS.addSortParams(term)).toEqual(term);
  });

  test("leaves an already-parameterised label alone", () => {
    const term = kapply(klabel("ite", [K_ITEM]), [ktoken("true", "Bool"), intToken(1), intToken(2)]);
    expect(SIMPLE_PROOFS.addSortParams(term)).toEqual(term);
  });
});

describe("addKsequenceUnderKProductions (outer.py:1405-1421)", () => {
  const K_ARG = new KDefinition("TEST", [
    kflatmodule("TEST", {
      sentences: [
        subsort("K", "KItem"),
        subsort("KItem", "Int"),
        symbol("KItem", "<k>", [T("<k>"), NT(K), T("</k>")]),
        symbol("KItem", "f", [T("f"), T("("), NT(INT), T(")")]),
      ],
    }),
  ]);

  test("wraps an argument in a K position whose sort is not already K", () => {
    expect(K_ARG.addKsequenceUnderKProductions(kapply("<k>", [intToken(1)]))).toEqual(
      kapply("<k>", [ksequence([intToken(1)])]),
    );
  });

  test("leaves an argument that is already sort K alone", () => {
    const already = kapply("<k>", [kvariable("X", K)]);
    expect(K_ARG.addKsequenceUnderKProductions(already)).toEqual(already);
    const seq = kapply("<k>", [ksequence([intToken(1), intToken(2)])]);
    expect(K_ARG.addKsequenceUnderKProductions(seq)).toEqual(seq);
  });

  test("leaves non-K positions alone", () => {
    const term = kapply("<k>", [kapply("f", [intToken(1)])]);
    expect(K_ARG.addKsequenceUnderKProductions(term)).toEqual(kapply("<k>", [ksequence([kapply("f", [intToken(1)])])]));
  });

  // Regression: `kastToKore` runs this pass *before* `sortVars`, so the
  // rewrite under `<k>` still holds unsorted variables — `sortOf` answering
  // `undefined` (not throwing) for it is what keeps the pipeline alive.
  test("wraps a rewrite between unsorted variables — the kastToKore entry shape", () => {
    const term = kapply("<k>", [krewrite(kvariable("X"), kvariable("Y"))]);
    expect(K_ARG.addKsequenceUnderKProductions(term)).toEqual(
      kapply("<k>", [ksequence([krewrite(kvariable("X"), kvariable("Y"))])]),
    );
  });
});

//////////////////////////////
// Sentence filters         //
//////////////////////////////

describe("productionIsFunction (outer.py:861-883)", () => {
  const fn = (label?: string, key = Atts.FUNCTION): KProduction =>
    kproduction("Int", { klabel: label === undefined ? undefined : klabel(label), att: att([key, null]) });

  test("`function` or `functional` both count", () => {
    expect(productionIsFunction(fn("foo"))).toBe(true);
    expect(productionIsFunction(fn("foo", Atts.FUNCTIONAL))).toBe(true);
    expect(productionIsFunction(kproduction("Int", { klabel: klabel("foo") }))).toBe(false);
  });

  test("the builtin data constructors are excluded (outer.py:865-877)", () => {
    for (const label of [
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
    ]) {
      expect(productionIsFunction(fn(label))).toBe(false);
    }
  });

  test("generated cell-map constructors are excluded by suffix", () => {
    expect(productionIsFunction(fn("AccountCellMapItem"))).toBe(false);
    expect(productionIsFunction(fn("_AccountCellMap_"))).toBe(false);
    expect(productionIsFunction(fn("_AccountCellMap_x"))).toBe(true);
  });

  test("a production without a klabel is not exempted", () => {
    // `prod.klabel and is_not_actually_function(...)` is falsy without a
    // label, so the exclusion list never applies.
    expect(productionIsFunction(fn())).toBe(true);
  });
});

const FILTERS = new KDefinition("MAIN", [
  kflatmodule("MAIN", {
    imports: [kimport("LIB")],
    sentences: [
      symbol("Int", "add", [T("add")], att([Atts.FUNCTION, null])),
      symbol("Int", "zero", [T("zero")]),
      ksyntaxsort(INT),
      krule(kapply("<generatedTop>", [kapply("zero")]), { att: att([Atts.UNIQUE_ID, "r1"]) }),
      krule(krewrite(kapply("<generatedTop>", [kapply("zero")]), kapply("zero")), {
        att: att([Atts.UNIQUE_ID, "r2"]),
      }),
      krule(krewrite(kapply("zero"), kapply("zero"))),
      kclaim(kapply("zero"), { att: att([Atts.UNIQUE_ID, "c1"]) }),
    ],
  }),
  kflatmodule("LIB", { sentences: [symbol("Int", "_Map_", [T("m")], att([Atts.FUNCTION, null]))] }),
  // Never imported: still contributes to `sentenceByUniqueId`.
  kflatmodule("ORPHAN", { sentences: [krule(kapply("zero"), { att: att([Atts.UNIQUE_ID, "orphan"]) })] }),
]);

describe("functions / functionLabels / constructors (outer.py:1118-1131)", () => {
  test("splits the syntax productions by productionIsFunction", () => {
    expect(FILTERS.functions.map((p) => p.klabel?.name)).toEqual(["add"]);
    expect(FILTERS.functionLabels).toEqual(["add"]);
    expect(FILTERS.constructors.map((p) => p.klabel?.name ?? "").toSorted()).toEqual(["_Map_", "zero"]);
  });

  test("`_Map_` carries `function` but is a constructor", () => {
    expect(FILTERS.constructors.some((p) => p.klabel?.name === "_Map_")).toBe(true);
  });
});

describe("semanticRules (outer.py:1172-1184)", () => {
  test("keeps the rules whose body is a whole configuration", () => {
    expect(FILTERS.semanticRules.length).toBe(2);
    expect(FILTERS.rules.length).toBe(3);
  });
});

describe("sentenceByUniqueId (outer.py:1185-1197)", () => {
  test("is over allModules, not the import closure", () => {
    expect([...FILTERS.sentenceByUniqueId.keys()].toSorted()).toEqual(["c1", "orphan", "r1", "r2"]);
  });

  test("a conflicting duplicate is dropped, not thrown (outer.py:1191-1193)", () => {
    const clash = new KDefinition("A", [
      kflatmodule("A", { sentences: [krule(kapply("a"), { att: att([Atts.UNIQUE_ID, "dup"]) })] }),
      kflatmodule("B", { sentences: [krule(kapply("b"), { att: att([Atts.UNIQUE_ID, "dup"]) })] }),
    ]);
    const found = clash.sentenceByUniqueId.get("dup");
    expect(found?.node).toBe("KRule");
    // First wins.
    expect(found).toEqual(clash.module("A").sentences[0]);
  });

  test("an identical duplicate is fine", () => {
    const rule = krule(kapply("a"), { att: att([Atts.UNIQUE_ID, "dup"]) });
    const same = new KDefinition("A", [
      kflatmodule("A", { sentences: [rule] }),
      kflatmodule("B", { sentences: [rule] }),
    ]);
    expect(same.sentenceByUniqueId.size).toBe(1);
  });
});

describe("claims", () => {
  test("definition level folds the modules, module level filters (outer.py:895-898)", () => {
    expect(FILTERS.claims.length).toBe(1);
    expect(moduleClaims(FILTERS.module("MAIN")).length).toBe(1);
    expect(moduleClaims(FILTERS.module("LIB")).length).toBe(0);
  });
});

describe("KFlatModule helpers", () => {
  const main = FILTERS.module("MAIN");

  test("moduleFunctions / moduleConstructors (outer.py:846-854)", () => {
    expect(moduleFunctions(main).map((p) => p.klabel?.name)).toEqual(["add"]);
    expect(moduleConstructors(main).map((p) => p.klabel?.name)).toEqual(["zero"]);
  });

  test("moduleSyntaxSorts (outer.py:885-888)", () => {
    expect(moduleSyntaxSorts(main).map((s) => s.sort.name)).toEqual(["Int"]);
  });

  test("moduleSentenceByUniqueId skips sentences without one (outer.py:900-902)", () => {
    expect([...moduleSentenceByUniqueId(main).keys()].toSorted()).toEqual(["c1", "r1", "r2"]);
  });

  test("moduleMapSentences without ofType touches every sentence (outer.py:904-914)", () => {
    let seen = 0;
    const mapped = moduleMapSentences(main, (sentence: KSentence) => {
      seen += 1;
      return sentence;
    });
    expect(seen).toBe(main.sentences.length);
    expect(mapped.sentences).toEqual(main.sentences);
  });

  test("moduleMapSentences with ofType narrows", () => {
    const mapped = moduleMapSentences(main, (rule) => krule(rule.body, { att: att([Atts.LABEL, "tagged"]) }), "KRule");
    expect(mapped.sentences.filter((s) => s.att.get(Atts.LABEL) === "tagged").length).toBe(3);
    // Everything else is the same object.
    expect(mapped.sentences[0]).toBe(notNone(main.sentences[0]));
  });
});

//////////////////////////////
// Unparser indices         //
//////////////////////////////

const UNPARSER = new KDefinition("U", [
  kflatmodule("U", {
    sentences: [
      symbol("Exp", "_+_", [NT(ksort("Exp")), T("+"), NT(ksort("Exp"))]),
      symbol("Exp", "_-_", [NT(ksort("Exp")), T("-"), NT(ksort("Exp"))]),
      symbol("Exp", "_*_", [NT(ksort("Exp")), T("*"), NT(ksort("Exp"))]),
      symbol("Exp", "_==_", [NT(ksort("Exp")), T("=="), NT(ksort("Exp"))]),
      kproduction("Exp", {
        items: [T("("), NT(ksort("Exp")), T(")")],
        att: att([Atts.BRACKET, null], [Atts.BRACKET_LABEL, { node: "KLabel", name: "(_)_U", params: [] }]),
      }),
      ksyntaxpriority([["_*_"], ["_+_", "_-_"], ["_==_"]]),
      ksyntaxassociativity(KAssoc.LEFT, { tags: ["_+_", "_-_"] }),
      ksyntaxassociativity(KAssoc.NON_ASSOC, { tags: ["_==_"] }),
    ],
  }),
]);

describe("brackets / syntaxSymbols (outer.py:1230-1264)", () => {
  test("brackets is keyed by the bracketed sort", () => {
    expect([...UNPARSER.brackets.keys()]).toEqual([sortKey(ksort("Exp"))]);
  });

  test("syntaxSymbols is symbols plus the brackets under their bracketLabel", () => {
    expect(UNPARSER.syntaxSymbols.has("(_)_U")).toBe(true);
    expect(UNPARSER.symbols.has("(_)_U")).toBe(false);
    for (const name of UNPARSER.symbols.keys()) expect(UNPARSER.syntaxSymbols.has(name)).toBe(true);
  });

  test("a bracket production with a klabel is an error (outer.py:1234)", () => {
    const bad = new KDefinition("B", [
      kflatmodule("B", {
        sentences: [symbol("Exp", "oops", [T("("), NT(ksort("Exp")), T(")")], att([Atts.BRACKET, null]))],
      }),
    ]);
    expect(() => bad.brackets).toThrow(/must not have a klabel/u);
  });

  test("two brackets for one sort is an error (outer.py:1237)", () => {
    const bad = new KDefinition("B", [
      kflatmodule("B", {
        sentences: [
          kproduction("Exp", { items: [T("("), NT(ksort("Exp")), T(")")], att: att([Atts.BRACKET, null]) }),
          kproduction("Exp", { items: [T("["), NT(ksort("Exp")), T("]")], att: att([Atts.BRACKET, null]) }),
        ],
      }),
    ]);
    expect(() => bad.brackets).toThrow(/Multiple bracket productions for sort: Exp/u);
  });
});

describe("priorities (outer.py:1307-1320)", () => {
  test("is the transitive closure of consecutive priority groups", () => {
    const lower = (label: string): readonly string[] => [...(UNPARSER.priorities.get(label) ?? [])].toSorted();
    expect(lower("_*_")).toEqual(["_+_", "_-_", "_==_"].toSorted());
    expect(lower("_+_")).toEqual(["_==_"]);
    expect(lower("_==_")).toEqual([]);
  });
});

describe("leftAssocs / rightAssocs (outer.py:1321-1342)", () => {
  test("a left declaration is a full square, itself included", () => {
    expect([...(UNPARSER.leftAssocs.get("_+_") ?? [])].toSorted()).toEqual(["_+_", "_-_"]);
    expect([...(UNPARSER.leftAssocs.get("_-_") ?? [])].toSorted()).toEqual(["_+_", "_-_"]);
    expect(UNPARSER.rightAssocs.get("_+_")).toBeUndefined();
  });

  test("NON_ASSOC lands in BOTH (outer.py:1334; outer.scala:450)", () => {
    expect([...(UNPARSER.leftAssocs.get("_==_") ?? [])]).toEqual(["_==_"]);
    expect([...(UNPARSER.rightAssocs.get("_==_") ?? [])]).toEqual(["_==_"]);
  });

  test("is not transitively closed, unlike priorities", () => {
    const chained = new KDefinition("C", [
      kflatmodule("C", {
        sentences: [
          ksyntaxassociativity(KAssoc.LEFT, { tags: ["a", "b"] }),
          ksyntaxassociativity(KAssoc.LEFT, { tags: ["b", "c"] }),
        ],
      }),
    ]);
    expect([...(chained.leftAssocs.get("a") ?? [])].toSorted()).toEqual(["a", "b"]);
    expect([...(chained.leftAssocs.get("b") ?? [])].toSorted()).toEqual(["a", "b", "c"]);
  });
});

describe("overloads (outer.py:1266-1305)", () => {
  const OVERLOADS = new KDefinition("O", [
    kflatmodule("O", {
      sentences: [
        subsort("KItem", "Int"),
        subsort("Int", "Nat"),
        symbol("KItem", "gen", [T("gen"), T("("), NT(K_ITEM), T(")")], att([Atts.OVERLOAD, "grp"])),
        symbol("Int", "mid", [T("mid"), T("("), NT(INT), T(")")], att([Atts.OVERLOAD, "grp"])),
        symbol("Nat", "spec", [T("spec"), T("("), NT(ksort("Nat")), T(")")], att([Atts.OVERLOAD, "grp"])),
        // Same group, different arity: incomparable, not an error.
        symbol("Int", "arity", [T("arity"), T("("), NT(INT), T(","), NT(INT), T(")")], att([Atts.OVERLOAD, "grp"])),
        // A different group never compares against the first.
        symbol("Int", "other", [T("other"), T("("), NT(INT), T(")")], att([Atts.OVERLOAD, "elsewhere"])),
      ],
    }),
  ]);

  test("keys are the overloaded (general) symbols, values the overloaders", () => {
    expect([...(OVERLOADS.overloads.get("gen") ?? [])].toSorted()).toEqual(["mid", "spec"]);
    expect([...(OVERLOADS.overloads.get("mid") ?? [])].toSorted()).toEqual(["spec"]);
    expect(OVERLOADS.overloads.get("spec")).toBeUndefined();
  });

  test("a differing arity compares as incomparable, not as an error", () => {
    expect(OVERLOADS.overloads.get("arity")).toBeUndefined();
    expect([...(OVERLOADS.overloads.get("gen") ?? [])]).not.toContain("arity");
  });

  test("groups do not cross", () => {
    expect(OVERLOADS.overloads.has("other")).toBe(false);
  });

  test("all-equal sorts are not an overload — `less` never gets set", () => {
    const twins = new KDefinition("T", [
      kflatmodule("T", {
        sentences: [
          symbol("Int", "a", [T("a"), T("("), NT(INT), T(")")], att([Atts.OVERLOAD, "g"])),
          symbol("Int", "b", [T("b"), T("("), NT(INT), T(")")], att([Atts.OVERLOAD, "g"])),
        ],
      }),
    ]);
    expect(twins.overloads.size).toBe(0);
  });
});

//////////////////////////////
// Odds and ends            //
//////////////////////////////

describe("KDefinition.hash (kast.py:32-35)", () => {
  test("is the sha256 of the definition's canonical JSON", () => {
    expect(FILTERS.hash).toMatch(/^[0-9a-f]{64}$/u);
    expect(FILTERS.hash).toBe(FILTERS.hash);
  });

  test("changes when the definition does", () => {
    expect(FILTERS.hash).not.toBe(FILTERS.let({ mainModuleName: "LIB" }).hash);
  });
});

describe("intersperse / notNone (utils.py:143,264)", () => {
  test("intersperse puts the delimiter between, not around", () => {
    expect(intersperse([1, 2, 3], 0)).toEqual([1, 0, 2, 0, 3]);
    expect(intersperse([1], 0)).toEqual([1]);
    expect(intersperse([], 0)).toEqual([]);
  });

  test("notNone rejects both null and undefined", () => {
    expect(notNone(0)).toBe(0);
    expect(notNone("")).toBe("");
    const missing: string | undefined = undefined;
    const empty: string | null = null;
    expect(() => {
      notNone(missing);
    }).toThrow(/other than None/u);
    expect(() => {
      notNone(empty);
    }).toThrow(/other than None/u);
  });
});

describe("ksequence flattens nested sequences (inner.py:602-609)", () => {
  test("one level of nesting is spliced by the constructor", () => {
    expect(ksequence([intToken(0), ksequence([intToken(1), intToken(2)]), intToken(3)]).items).toEqual([
      intToken(0),
      intToken(1),
      intToken(2),
      intToken(3),
    ]);
  });

  test("an empty nested sequence disappears", () => {
    expect(ksequence([ksequence([]), intToken(0)]).items).toEqual([intToken(0)]);
    expect(ksequence([ksequence([])]).items).toEqual([]);
  });

  test("the invariant holds for a deeply nested build", () => {
    // Every construction path goes through `ksequence`, so one splice is
    // enough: the inner sequences are already flat.
    let seq = ksequence([intToken(0)]);
    for (let i = 1; i < 1000; i++) seq = ksequence([seq, intToken(i)]);
    expect(seq.items.length).toBe(1000);
    expect(seq.items.every((item) => item.node === "KToken")).toBe(true);
  });
});
