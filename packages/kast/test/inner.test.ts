/**
 * Transcribed from `pyk/src/tests/unit/kast/test_inner.py` at K v7.1.337 —
 * all 19 cases (`flatten_label` 15, `keep_vars_sorted` 4) — plus the
 * traversal, structure, `buildCons` and `KRewrite` coverage that pyk's unit
 * suite simply does not have.
 */

import { describe, expect, test } from "bun:test";
import {
  bottomUp,
  bottomUpWithSummary,
  buildCons,
  collect,
  flattenLabel,
  isCell,
  kapply,
  kas,
  keepVarsSorted,
  klabel,
  krewrite,
  ksequence,
  ktoken,
  kvariable,
  letTerms,
  mapInner,
  rewriteApply,
  rewriteApplyTop,
  rewriteReplace,
  rewriteReplaceTop,
  terms,
  topDown,
  varOccurrences,
  type KInner,
  type KVariable,
} from "../src/inner.ts";
import { a, b, expectTerm, expectTerms, f, g, x, y, z } from "./helpers.ts";

////////////////////////////////////////////
// FLATTEN_LABEL_DATA (test_inner.py:17)   //
////////////////////////////////////////////

const FLATTEN_LABEL_DATA: readonly (readonly [string, KInner, readonly KInner[]])[] = [
  // `a` is `KApply('a')` with no arguments, so flattening *by* `a` yields the
  // empty list — the one case where the input term disappears entirely.
  ["a", a, []],
  ["b", a, [a]],
  ["x", x, [x]],
  ["y", x, [x]],
  ["f", f(x), [x]],
  ["g", f(x), [f(x)]],
  ["f", f(x, y), [x, y]],
  ["f", f(x, x), [x, x]],
  ["f", f(x, y, z), [x, y, z]],
  ["f", f(f(x)), [x]],
  ["f", f(f(f(x))), [x]],
  ["f", f(g(f(x))), [g(f(x))]],
  ["f", f(f(x, y, z)), [x, y, z]],
  ["f", f(x, f(y, x, f(y)), z), [x, y, x, y, z]],
  ["f", f(x, f(y, x, f(g(f(y))), z)), [x, y, x, g(f(y)), z]],
];

describe("flattenLabel", () => {
  FLATTEN_LABEL_DATA.forEach(([label, term, expected], i) => {
    test(String(i), () => {
      expectTerms(flattenLabel(label, term), expected);
    });
  });
});

//////////////////////////////////////////////
// KEEP_VARS_SORTED_DATA (test_inner.py:44)  //
//////////////////////////////////////////////

const KEEP_VARS_SORTED_DATA: readonly (readonly [ReadonlyMap<string, readonly KVariable[]>, Map<string, KVariable>])[] =
  [
    [
      new Map([
        ["a", [kvariable("a"), kvariable("a")]],
        ["b", [kvariable("b"), kvariable("b")]],
      ]),
      new Map([
        ["a", kvariable("a")],
        ["b", kvariable("b")],
      ]),
    ],
    [
      new Map([
        ["a", [kvariable("a", "K"), kvariable("a", "X")]],
        ["b", [kvariable("b", "K"), kvariable("b", "X")]],
      ]),
      new Map([
        ["a", kvariable("a")],
        ["b", kvariable("b")],
      ]),
    ],
    [
      new Map([
        ["a", [kvariable("a", "K"), kvariable("a")]],
        ["b", [kvariable("b", "K"), kvariable("b", "K")]],
      ]),
      new Map([
        ["a", kvariable("a", "K")],
        ["b", kvariable("b", "K")],
      ]),
    ],
    [new Map([["a", [kvariable("a", "A"), kvariable("a"), kvariable("a", "B")]]]), new Map([["a", kvariable("a")]])],
  ];

describe("keepVarsSorted", () => {
  KEEP_VARS_SORTED_DATA.forEach(([occurrences, expected], i) => {
    test(String(i), () => {
      expect(keepVarsSorted(occurrences)).toEqual(expected);
    });
  });
});

////////////////////////////////////////////////////////////
// Not upstream: pyk has no unit tests for the traversals, //
// the structural accessors, `buildCons` or the `KRewrite` //
// operations.  Expected values below were produced by     //
// running the pyk originals at v7.1.337.                  //
////////////////////////////////////////////////////////////

describe("structure", () => {
  test("terms and letTerms round-trip every node kind", () => {
    const cases: readonly KInner[] = [
      ktoken("1", "Int"),
      kvariable("v"),
      f(x, y),
      kas(x, y),
      krewrite(x, y),
      ksequence([x, y]),
    ];
    for (const term of cases) expectTerm(letTerms(term, terms(term)), term);
  });

  test("terms never returns a sort or a label parameter", () => {
    // `inner.py:29,57` — `KSort` and `KLabel` extend `KAst`, not `KInner`.
    expect(terms(kapply(klabel("inj", ["A", "B"]), []))).toEqual([]);
    expect(terms(ktoken("1", "Int"))).toEqual([]);
  });

  test("letTerms on a leaf rejects children", () => {
    expect(() => letTerms(x, [a])).toThrow(/takes no children/u);
  });

  test("letTerms re-flattens a KSequence", () => {
    // The invariant that makes `match`'s tail binding safe.
    expectTerm(letTerms(ksequence([x]), [ksequence([a, b])]), ksequence([a, b]));
  });

  test("mapInner applies f to direct children only", () => {
    expectTerm(
      mapInner(f(x, g(x)), (child) => (child.node === "KVariable" ? a : child)),
      f(a, g(x)),
    );
  });

  test("isCell is `KApply.is_cell`'s heuristic, over any KInner (inner.py:397-400)", () => {
    expect(isCell(kapply("<k>", [x]))).toBe(true);
    expect(isCell(kapply("<generatedTop>"))).toBe(true);
    // Upstream tests `len(name) > 1` before the two ends, so `<>` is a cell
    // and the one-character label `<` is not — even though `'<'[0] == '<'`
    // and `'<'[-1] == '>'` would both be checked against the same character.
    expect(isCell(kapply("<>"))).toBe(true);
    expect(isCell(kapply("<"))).toBe(false);
    expect(isCell(kapply("k"))).toBe(false);
    expect(isCell(kapply("<k"))).toBe(false);
    expect(isCell(kapply("k>"))).toBe(false);
    // Every non-`KApply` node is out by construction.
    expect(isCell(kvariable("<k>"))).toBe(false);
    expect(isCell(ktoken("<k>", "String"))).toBe(false);
    expect(isCell(ksequence([kapply("<k>")]))).toBe(false);
  });
});

/** `x |-> f(w)`, which introduces structure `topDown` must then descend into. */
function wrap(term: KInner): KInner {
  return term.node === "KVariable" && term.name === "x" ? f(kvariable("w")) : term;
}

describe("traversals", () => {
  test("bottomUp rebuilds from the leaves", () => {
    expectTerm(bottomUp(wrap, f(x)), f(f(kvariable("w"))));
  });

  test("topDown rebuilds from the root", () => {
    expectTerm(topDown(wrap, f(x)), f(f(kvariable("w"))));
  });

  test("bottomUpWithSummary sees its children's summaries", () => {
    const [term, count] = bottomUpWithSummary<number>(
      (subterm, summaries) => [subterm, 1 + summaries.reduce((total, n) => total + n, 0)],
      f(x, g(y, z)),
    );
    expectTerm(term, f(x, g(y, z)));
    expect(count).toBe(5);
  });

  test("collect visits top-down, left to right", () => {
    const seen: string[] = [];
    collect(
      (term) => {
        seen.push(term.node === "KApply" ? term.label.name : term.node === "KVariable" ? term.name : term.node);
      },
      f(x, g(y)),
    );
    expect(seen).toEqual(["f", "x", "g", "y"]);
  });

  test("varOccurrences keys on name and keeps every occurrence", () => {
    const occurrences = varOccurrences(f(x, g(x, y)));
    expect([...occurrences.keys()]).toEqual(["x", "y"]);
    expect(occurrences.get("x")?.length).toBe(2);
    expect(occurrences.get("y")?.length).toBe(1);
  });
});

describe("buildCons", () => {
  test("an empty list is the unit", () => {
    expectTerm(buildCons(a, "cons", []), a);
  });

  test("the terminator is always emitted", () => {
    expectTerm(buildCons(a, "cons", [x]), kapply("cons", [x, a]));
    expectTerm(buildCons(a, "cons", [x, y]), kapply("cons", [x, kapply("cons", [y, a])]));
  });

  test("unit-valued items are kept, unlike buildAssoc", () => {
    expectTerm(buildCons(a, "cons", [a]), kapply("cons", [a, a]));
  });

  test("100k items build without recursing", () => {
    // pyk's `build_cons` is the one recursive function in `inner.py:935-951`.
    const built = buildCons(
      a,
      "cons",
      Array.from({ length: 100_000 }, () => x),
    );
    expect(built.node).toBe("KApply");
  });
});

describe("KRewrite operations", () => {
  test("applyTop rewrites once at the top, or not at all", () => {
    expectTerm(rewriteApplyTop(krewrite(x, f(x)), a), f(a));
    expectTerm(rewriteApplyTop(krewrite(a, b), g(a)), g(a));
  });

  test("apply is one bottom-up pass with no fixpoint", () => {
    // `inner.py:552-561`.  `x => f(x)` on `g(a)` fires at `a` and then at the
    // rebuilt `g(f(a))`, and stops — it does not saturate.
    expectTerm(rewriteApply(krewrite(x, f(x)), g(a)), f(g(f(a))));
  });

  test("replace uses structural equality instead of matching", () => {
    expectTerm(rewriteReplace(krewrite(a, b), g(a, f(a))), g(b, f(b)));
    // A variable LHS matches everything under `apply` but only itself here.
    expectTerm(rewriteReplaceTop(krewrite(x, a), b), b);
  });
});
