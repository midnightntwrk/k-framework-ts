import { describe, expect, test } from "bun:test";
import { eq, hashOf, kapply, ktoken, kvariable, type KInner } from "@kframework-ts/kast";
import { GENERATED_TOP_CELL } from "@kframework-ts/kast/prelude/k";
import { intToken } from "@kframework-ts/kast/prelude/kint";
import { mlAnd, mlBottom, mlEquals, mlEqualsTrue, mlTop } from "@kframework-ts/kast/prelude/ml";

import { CTerm, ctermEq } from "../src/cterm.ts";

const config = (term: KInner): KInner => kapply("<generatedTop>", [term]);
const k = (term: KInner): KInner => config(kapply("<k>", [term]));
const f = (...args: readonly KInner[]): KInner => kapply("f", args);
const g = (...args: readonly KInner[]): KInner => kapply("g", args);
const h = (...args: readonly KInner[]): KInner => kapply("h", args);

function expectTerm(actual: KInner, expected: KInner): void {
  expect(eq(actual, expected)).toBe(true);
}

describe("CTerm matching", () => {
  const a = ktoken("a", "Id");
  const b = ktoken("b", "Id");
  const c = ktoken("c", "Id");
  const x = kvariable("X");
  const y = kvariable("Y");
  const z = kvariable("Z");
  // `MATCH_TEST_DATA` from pyk/src/tests/unit/test_cterm.py.
  for (const [term, pattern] of [
    [a, a],
    [a, x],
    [f(a), x],
    [f(a), f(a)],
    [f(a), f(x)],
    [f(a, b), f(x, y)],
    [f(a, b, c), f(x, y, z)],
    [f(g(h(a))), x],
    [f(g(h(x))), x],
    [f(a, g(b, h(c))), f(x, y)],
  ] as const) {
    test("matches a pyk configuration row", () => {
      const source = new CTerm(k(pattern));
      const target = new CTerm(k(term));
      const subst = source.match(target);
      expect(subst).not.toBeNull();
      if (subst !== null) expectTerm(subst.apply(source.config), target.config);
    });
  }

  test("rejects repeated-variable mismatch", () => {
    expect(new CTerm(k(f(x, x))).match(new CTerm(k(f(x, a))))).toBeNull();
  });

  test("returns residual target constraints and plain match rejects them", () => {
    const source = new CTerm(k(x), [mlEqualsTrue(kapply("_>=Int_", [x, intToken(0)]))]);
    const target = new CTerm(k(y), [
      mlEqualsTrue(kapply("_>=Int_", [y, intToken(0)])),
      mlEqualsTrue(kapply("_>=Int_", [y, intToken(5)])),
    ]);
    const csubst = source.matchWithConstraint(target);
    expect(csubst).not.toBeNull();
    if (csubst !== null) expect(ctermEq(csubst.apply(source), target)).toBe(true);
    expect(source.match(target)).toBeNull();
  });
});

describe("CTerm canonicalization", () => {
  test("turns weak top and bottom into their canonical absorbing values", () => {
    expect(ctermEq(new CTerm(mlAnd([mlTop(), mlTop()])), CTerm.top())).toBe(true);
    expect(ctermEq(new CTerm(mlAnd([config(kvariable("X")), mlBottom()])), CTerm.bottom())).toBe(true);
    expect(ctermEq(CTerm.fromKast(mlAnd([mlBottom(), mlBottom()])), CTerm.bottom())).toBe(true);
  });

  test("requires a cell configuration", () => {
    expect(() => new CTerm(kvariable("X"))).toThrow("Expected cell label");
  });

  test("flattens, removes tautologies/duplicates, and uses the pyk repr sort key", () => {
    const x = kvariable("X", "Int");
    const y = kvariable("Y", "Int");
    const long = mlEqualsTrue(kapply("_>=Int_", [x, intToken(0)]));
    const short = mlEquals(x, y);
    const normalized = new CTerm(k(x), [long, mlAnd([short, long]), mlTop(), mlEquals(x, x)]);
    expect(normalized.constraints).toHaveLength(2);
    // The exact ordering is not hand-picked; it is `(len(repr(term)), repr(term))`.
    expectTerm(normalized.constraints[0] ?? mlTop(), short);
    expectTerm(normalized.constraints[1] ?? mlTop(), long);
  });

  test("counts Unicode code points when applying pyk's repr length key", () => {
    const astral = ktoken("😀", "String");
    const twoBmp = ktoken("aa", "String");
    const normalized = new CTerm(k(kvariable("X")), [twoBmp, astral]);

    // Python counts the emoji as one character, while JavaScript's
    // `String.length` counts its surrogate pair as two code units.
    expectTerm(normalized.constraints[0] ?? mlTop(), astral);
    expectTerm(normalized.constraints[1] ?? mlTop(), twoBmp);
  });

  test("exposes cells, free variables, combined term, and pyk-compatible hash", () => {
    const state = new CTerm(config(kapply("<k>", [kvariable("X")])));
    expectTerm(state.cell("K_CELL"), kvariable("X"));
    expect(state.tryCell("OTHER_CELL")).toBeUndefined();
    expect(() => state.cell("OTHER_CELL")).toThrow("OTHER_CELL");
    expect(state.freeVars.has("X")).toBe(true);
    expectTerm(state.kast, mlAnd([state.config], GENERATED_TOP_CELL));
    expect(state.hash).toBe(hashOf(state.kast));
  });

  test("drops detached constraints only when requested", () => {
    const x = kvariable("X", "Int");
    const detached = mlEqualsTrue(kapply("_>=Int_", [kvariable("Y", "Int"), intToken(0)]));
    const attached = mlEqualsTrue(kapply("_>=Int_", [x, intToken(0)]));
    const state = new CTerm(k(x), [detached, attached]);
    const reduced = state.removeUselessConstraints();
    expect(reduced.constraints.some((constraint) => eq(constraint, attached))).toBe(true);
    expect(reduced.constraints.some((constraint) => eq(constraint, detached))).toBe(false);
    expect(state.removeUselessConstraints(["Y"]).constraints).toHaveLength(2);
  });
});
