import { describe, expect, test } from "bun:test";
import {
  collectSymbols,
  conjuncts,
  eliminateAliases,
  freeOccurrences,
  substituteVariables,
  substituteVars,
  variableKey,
} from "../src/manip.ts";
import type { EVar, Pattern } from "../src/syntax.ts";
import { and, app, dv, evar, exists, equals, koreString, koreText, sortApp, top } from "../src/syntax.ts";

const INT = sortApp("SortInt");
const TOP_CELL = sortApp("SortGeneratedTopCell");

const x = evar("X", INT);
const one = dv(INT, koreString("1"));
const eq = equals(INT, TOP_CELL, x, one);

describe("conjuncts", () => {
  test("top is the empty conjunction", () => {
    expect(conjuncts(top(TOP_CELL))).toEqual([]);
  });

  test("a non-and pattern is its own sole conjunct", () => {
    expect(conjuncts(eq)).toEqual([eq]);
  });

  test("nested and flattens, dropping interior top", () => {
    const chain = and(TOP_CELL, [eq, and(TOP_CELL, [top(TOP_CELL), eq])]);
    expect(conjuncts(chain)).toEqual([eq, eq]);
  });

  test("n-ary and fans out in order", () => {
    const other = equals(INT, TOP_CELL, evar("Y", INT), one);
    expect(conjuncts(and(TOP_CELL, [eq, other, eq]))).toEqual([eq, other, eq]);
  });

  test("empty and is the empty conjunction", () => {
    expect(conjuncts(and(TOP_CELL, []))).toEqual([]);
  });

  test("a 100k-deep nested and flattens without exhausting the call stack", () => {
    let left: ReturnType<typeof and> = and(TOP_CELL, [eq]);
    let right: ReturnType<typeof and> = and(TOP_CELL, [eq]);
    for (let i = 0; i < 100_000; i += 1) {
      left = and(TOP_CELL, [left, eq]);
      right = and(TOP_CELL, [eq, right]);
    }
    expect(conjuncts(left)).toHaveLength(100_001);
    expect(conjuncts(right)).toHaveLength(100_001);
  });
});

describe("KLean-ready generic helpers", () => {
  test("collectSymbols visits application heads in source order", () => {
    const pattern = app("f", [], [app("g"), app("f"), app("h")]);
    expect([...collectSymbols(pattern)]).toEqual(["f", "g", "h"]);
  });

  test("freeOccurrences respects element quantifiers", () => {
    const free = freeOccurrences(exists(INT, x, and(INT, [x, evar("Y", INT)])));
    expect([...free.keys()]).toEqual(["Y"]);
    expect(free.get("Y")).toEqual([evar("Y", INT)]);
  });

  test("eliminateAliases replaces compiler-introduced binary aliases", () => {
    const value = app("f", [], [evar("Y", INT)]);
    const pattern = app("g", [], [and(INT, [value, x]), x]);
    expect(eliminateAliases(pattern)).toEqual(app("g", [], [value, value]));
  });

  test("eliminateAliases keys aliases by variable sort as pyk's EVar equality does", () => {
    const string = sortApp("SortString");
    const sameNameDifferentSort = evar("X", string);
    const value = app("f", [], [evar("Y", INT)]);
    const pattern = app("g", [], [and(INT, [value, x]), sameNameDifferentSort]);
    expect(eliminateAliases(pattern)).toEqual(app("g", [], [value, sameNameDifferentSort]));
  });
});

/**
 * `substituteVariables` against pyk `substitute_vars` (`manip.py:60-75`).
 *
 * The expectations spelled as KORE text below were produced by running the
 * reference implementation at the pinned release, not by reading it:
 *
 * ```sh
 * cd k/pyk/src && PYTHONPATH=. python3 -c '
 * from pyk.kore.manip import substitute_vars
 * from pyk.kore.syntax import App, DV, EVar, SortApp, String
 * I, B = SortApp("SortInt"), SortApp("SortBool")
 * xi, xb = EVar("X", I), EVar("X", B)
 * print(substitute_vars(App("f", (), (xi, xb)), {xi: DV(I, String("1"))}).text)'
 * ```
 *
 * `pyk/src/pyk/kore/manip.py` is byte-identical between the pinned v7.1.337
 * tree and the installed `kframework` distribution, so either interpreter
 * produces these.
 */
describe("substituteVariables", () => {
  const BOOL = sortApp("SortBool");
  const xInt = evar("X", INT);
  const xBool = evar("X", BOOL);
  const oneInt = dv(INT, koreString("1"));
  const yes = dv(sortApp("SortBool"), koreString("true"));

  test("a substitution is keyed by name AND sort — X:SortInt does not touch X:SortBool", () => {
    // The regression this test exists for: keying by the bare `EVar.name`
    // replaced both occurrences with `1`, producing a term whose second
    // argument is an Int where a Bool belongs.
    //
    // pyk: f{}(\dv{SortInt{}}("1"), X : SortBool{})
    const substituted = substituteVariables(app("f", [], [xInt, xBool]), [[xInt, oneInt]]);
    expect(koreText(substituted)).toBe(String.raw`f{}(\dv{SortInt{}}("1"), X : SortBool{})`);
  });

  test("both sorts substituted independently", () => {
    // pyk: f{}(\dv{SortInt{}}("1"), \dv{SortBool{}}("true"))
    const substituted = substituteVariables(app("f", [], [xInt, xBool]), [
      [xInt, oneInt],
      [xBool, yes],
    ]);
    expect(koreText(substituted)).toBe(String.raw`f{}(\dv{SortInt{}}("1"), \dv{SortBool{}}("true"))`);
  });

  test("a parametric sort is part of the key, not just the sort's name", () => {
    const listInt = evar("L", sortApp("SortList", [INT]));
    const listBool = evar("L", sortApp("SortList", [BOOL]));
    const substituted = substituteVariables(app("f", [], [listInt, listBool]), [[listInt, oneInt]]);
    expect(koreText(substituted)).toBe(String.raw`f{}(\dv{SortInt{}}("1"), L : SortList{SortBool{}})`);
  });

  test("a Map<EVar, Pattern> may be passed straight in, its identity keying discarded", () => {
    // The map's key is a *distinct object* from the `X : SortInt{}` inside the
    // term, so identity keying would substitute nothing.
    const byIdentity = new Map<EVar, Pattern>([[evar("X", sortApp("SortInt")), oneInt]]);
    expect(koreText(substituteVariables(app("f", [], [xInt]), byIdentity))).toBe(String.raw`f{}(\dv{SortInt{}}("1"))`);
  });

  test("the last pair for a variable wins, as assignment into pyk's dict does", () => {
    const two = dv(INT, koreString("2"));
    const substituted = substituteVariables(xInt, [
      [xInt, oneInt],
      [xInt, two],
    ]);
    expect(koreText(substituted)).toBe(String.raw`\dv{SortInt{}}("2")`);
  });

  test("an empty substitution is the identity", () => {
    const pattern = app("f", [], [xInt, xBool]);
    expect(substituteVariables(pattern, [])).toBe(pattern);
  });

  test("substitution is binder-blind, exactly as pyk's is", () => {
    // pyk: \exists{SortInt{}}(X : SortInt{}, \dv{SortInt{}}("1"))
    //
    // Capturing, and deliberately so: `elim_aliases` is the only caller and its
    // aliases are compiler-introduced. Documented rather than fixed, because a
    // capture-avoiding version would silently disagree with the reference.
    const substituted = substituteVariables(exists(INT, xInt, xInt), [[xInt, oneInt]]);
    expect(koreText(substituted)).toBe(String.raw`\exists{SortInt{}}(X : SortInt{}, \dv{SortInt{}}("1"))`);
  });

  test("a 100k-deep term substitutes without exhausting the call stack", () => {
    let deep: Pattern = xInt;
    for (let i = 0; i < 100_000; i += 1) deep = app("f", [], [deep]);
    let result = substituteVariables(deep, [[xInt, oneInt]]);
    for (let i = 0; i < 100_000; i += 1) {
      if (result.tag !== "App") throw new Error("expected an application");
      const [child] = result.args;
      if (child === undefined) throw new Error("expected an argument");
      result = child;
    }
    expect(result).toEqual(oneInt);
  });

  test("substituteVars is the pyk-compatible spelling of the same function", () => {
    expect(substituteVars).toBe(substituteVariables);
  });

  test("variableKey separates name from sort unambiguously", () => {
    // Neither a KORE identifier nor a KORE sort text can contain a NUL, so the
    // two halves cannot be confused for one another however they are spelled.
    expect(variableKey(xInt)).not.toBe(variableKey(xBool));
    expect(variableKey(xInt)).toBe(variableKey(evar("X", sortApp("SortInt"))));
    expect(variableKey(xInt).split("\u0000")).toEqual(["X", "SortInt{}"]);
  });
});

/**
 * `eliminateAliases` against pyk `elim_aliases` (`manip.py:78-95`), which is
 * `substitute_vars` composed with an alias-collecting `bottom_up`.
 */
describe("eliminateAliases uses the fixed substitution", () => {
  test("same-named aliases at two sorts stay apart", () => {
    // Produced by pyk:
    //   elim_aliases(App('g', (), (And(I, (int_dv(7), xi)), And(B, (TRUE, xb)), xi, xb)))
    //   -> g{}(\dv{SortInt{}}("7"), \dv{SortBool{}}("true"),
    //          \dv{SortInt{}}("7"), \dv{SortBool{}}("true"))
    const BOOL = sortApp("SortBool");
    const xInt = evar("X", INT);
    const xBool = evar("X", BOOL);
    const seven = dv(INT, koreString("7"));
    const yes = dv(BOOL, koreString("true"));
    const pattern = app("g", [], [and(INT, [seven, xInt]), and(BOOL, [yes, xBool]), xInt, xBool]);
    expect(koreText(eliminateAliases(pattern))).toBe(
      String.raw`g{}(\dv{SortInt{}}("7"), \dv{SortBool{}}("true"), \dv{SortInt{}}("7"), \dv{SortBool{}}("true"))`,
    );
  });
});
