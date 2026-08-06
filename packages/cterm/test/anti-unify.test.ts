import { describe, expect, test } from "bun:test";
import { KDefinition, eq, kapply, kflatmodule, ksort, ktoken, kvariable, type KInner } from "@kframework-ts/kast";
import { mlEqualsTrue } from "@kframework-ts/kast/prelude/ml";

import { antiUnify, ctermAntiUnify, ctermsAntiUnify } from "../src/anti-unify.ts";
import { CTerm } from "../src/cterm.ts";

function expectTerm(actual: KInner, expected: KInner): void {
  expect(eq(actual, expected)).toBe(true);
}

function config(contents: KInner): KInner {
  return kapply("<generatedTop>", [kapply("<k>", [contents])]);
}

function expectCterm(actual: CTerm, expected: CTerm): void {
  expectTerm(actual.config, expected.config);
  expect(actual.constraints).toHaveLength(expected.constraints.length);
  actual.constraints.forEach((constraint, index) => {
    const target = expected.constraints[index];
    expect(target).toBeDefined();
    if (target !== undefined) expectTerm(constraint, target);
  });
}

describe("antiUnify", () => {
  test("generalizes a pushed-down rewrite and returns reconstruction witnesses", () => {
    const first = kapply("state", [kapply("f", [ktoken("1", "Int")]), ktoken("2", "Int")]);
    const second = kapply("state", [kapply("f", [ktoken("1", "Int")]), ktoken("3", "Int")]);

    const [generalized, firstSubst, secondSubst] = antiUnify(first, second);

    expectTerm(firstSubst.apply(generalized), first);
    expectTerm(secondSubst.apply(generalized), second);
    expect(generalized.node).toBe("KApply");
  });

  test("identical states stay unchanged and have identity witnesses", () => {
    const state = kapply("state", [kvariable("X")]);
    const [generalized, firstSubst, secondSubst] = antiUnify(state, state);

    expectTerm(generalized, state);
    expect(firstSubst.isIdentity).toBe(true);
    expect(secondSubst.isIdentity).toBe(true);
  });

  test("uses the supplied definition to preserve an abstracted rewrite's sort", () => {
    const definition = new KDefinition("MAIN", [kflatmodule("MAIN")]);
    const [generalized] = antiUnify(ktoken("1", "Int"), ktoken("2", "Int"), { kdef: definition });

    expect(generalized.node).toBe("KVariable");
    if (generalized.node === "KVariable") expect(generalized.sort).toEqual(ksort("Int"));
  });
});

describe("ctermAntiUnify", () => {
  test("retains useful common constraints and reconstructs both inputs", () => {
    const common = mlEqualsTrue(kapply("_>Int_", [kvariable("N", "Int"), ktoken("0", "Int")]));
    const detached = mlEqualsTrue(kapply("_>Int_", [kvariable("UNRELATED", "Int"), ktoken("0", "Int")]));
    const first = new CTerm(config(kapply("_|->_", [kvariable("N", "Int"), ktoken("1", "Int")])), [common, detached]);
    const second = new CTerm(config(kapply("_|->_", [kvariable("N", "Int"), ktoken("2", "Int")])), [common]);

    const [generalized, firstCSubst, secondCSubst] = ctermAntiUnify(first, second);

    expectCterm(firstCSubst.apply(generalized), first);
    expectCterm(secondCSubst.apply(generalized), second);
    expect(generalized.constraints.some((constraint) => eq(constraint, common))).toBe(true);
    expect(generalized.constraints.some((constraint) => eq(constraint, detached))).toBe(false);
  });

  test("keepValues records the alternative input values", () => {
    const first = new CTerm(config(kapply("_|->_", [kvariable("N", "Int"), ktoken("1", "Int")])));
    const second = new CTerm(config(kapply("_|->_", [kvariable("N", "Int"), ktoken("2", "Int")])));

    const [generalized, firstCSubst, secondCSubst] = ctermAntiUnify(first, second, { keepValues: true });

    expectTerm(firstCSubst.subst.apply(generalized.config), first.config);
    expectTerm(secondCSubst.subst.apply(generalized.config), second.config);
    expect(generalized.constraints).toHaveLength(1);
  });

  test("keepValues leaves an already-common state unchanged", () => {
    const state = new CTerm(config(kapply("_|->_", [kvariable("N", "Int"), ktoken("1", "Int")])));
    const [generalized, firstSubst, secondSubst] = ctermAntiUnify(state, state, { keepValues: true });

    expectCterm(generalized, state);
    expectCterm(firstSubst.apply(generalized), state);
    expectCterm(secondSubst.apply(generalized), state);
  });

  test("generalizes many states in input order", () => {
    const inputs = ["1", "2", "3"].map((value) => new CTerm(config(ktoken(value, "Int"))));
    const [generalized, substitutions] = ctermsAntiUnify(inputs);

    expect(substitutions).toHaveLength(inputs.length);
    substitutions.forEach((subst, index) => {
      const original = inputs[index];
      expect(original).toBeDefined();
      if (original !== undefined) expectCterm(subst.apply(generalized), original);
    });
  });

  test("rejects an empty collection", () => {
    expect(() => ctermsAntiUnify([])).toThrow("no CTerms provided");
  });
});
