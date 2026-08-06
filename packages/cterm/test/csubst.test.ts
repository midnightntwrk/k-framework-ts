import { describe, expect, test } from "bun:test";
import { KDefinition, Subst, eq, kapply, kflatmodule, kvariable, type KInner } from "@kframework-ts/kast";
import { K } from "@kframework-ts/kast/prelude/k";
import { TRUE } from "@kframework-ts/kast/prelude/kbool";
import { intToken } from "@kframework-ts/kast/prelude/kint";
import { mlAnd, mlEquals, mlEqualsTrue, mlTop } from "@kframework-ts/kast/prelude/ml";

import { CSubst } from "../src/csubst.ts";
import { CTerm } from "../src/cterm.ts";

const config = (term: KInner): KInner => kapply("<generatedTop>", [kapply("<k>", [term])]);

function expectTerm(actual: KInner, expected: KInner): void {
  expect(eq(actual, expected)).toBe(true);
}

describe("CSubst.pred", () => {
  test("ports pyk empty, singleton, identity, and double rows", () => {
    expectTerm(new CSubst().pred(), mlTop());
    expectTerm(new CSubst(new Subst({ X: TRUE })).pred(), mlEquals(kvariable("X", K), TRUE, K));
    expectTerm(new CSubst(new Subst({ X: kvariable("X") })).pred(), mlTop());
    expectTerm(
      new CSubst(new Subst({ X: TRUE, Y: intToken(4) })).pred(),
      mlAnd([mlEquals(kvariable("X", K), TRUE, K), mlEquals(kvariable("Y", K), intToken(4), K)]),
    );
  });

  test("can independently omit substitution or constraints", () => {
    const constraint = mlEqualsTrue(kapply("_>=Int_", [kvariable("X", "Int"), intToken(0)]));
    const csubst = new CSubst(new Subst({ X: intToken(1) }), [constraint]);
    expectTerm(csubst.pred({ subst: false }), constraint);
    expectTerm(csubst.pred({ constraints: false }), mlEquals(kvariable("X", K), intToken(1), K));
  });

  test("uses a supplied definition to infer the matching-logic equality sort", () => {
    const definition = new KDefinition("MAIN", [kflatmodule("MAIN")]);
    const csubst = new CSubst(new Subst({ X: intToken(1) }));
    expectTerm(csubst.pred({ sortWith: definition }), mlEquals(kvariable("X", "Int"), intToken(1), "Int"));
  });
});

describe("CSubst application", () => {
  test("ports top/bottom, substitution, rename, and constraint rows", () => {
    expectTerm(new CSubst().apply(CTerm.top()).config, CTerm.top().config);
    expectTerm(new CSubst().apply(CTerm.bottom()).config, CTerm.bottom().config);
    expectTerm(
      new CSubst(new Subst({ X: intToken(5) })).apply(new CTerm(config(kvariable("X")))).config,
      config(intToken(5)),
    );
    expectTerm(
      new CSubst(new Subst({ X: kvariable("Y") })).apply(new CTerm(config(kvariable("X")))).config,
      config(kvariable("Y")),
    );

    const lt = mlEqualsTrue(kapply("_<Int_", [kvariable("X", "Int"), intToken(5)]));
    const ge = mlEqualsTrue(kapply("_>=Int_", [kvariable("Y", "Int"), intToken(0)]));
    const applied = new CSubst(new Subst({ X: kvariable("Y") }), [ge]).apply(new CTerm(config(kvariable("X")), [lt]));
    expect(applied.constraints.some((constraint) => eq(constraint, ge))).toBe(true);
    expect(
      applied.constraints.some((constraint) =>
        eq(constraint, mlEqualsTrue(kapply("_<Int_", [kvariable("Y"), intToken(5)]))),
      ),
    ).toBe(true);
  });

  test("extracts substitutions and leaves residual predicates", () => {
    const x = kvariable("X", "Int");
    const y = kvariable("Y", "Int");
    const residual = mlEqualsTrue(kapply("_>=Int_", [y, intToken(0)]));
    const result = CSubst.fromPred(mlAnd([mlEquals(x, intToken(1), "Int"), residual]));
    expectTerm(result.subst.get("X") ?? kvariable("MISSING"), intToken(1));
    expect(result.constraints).toHaveLength(1);
    expectTerm(result.constraints[0] ?? mlTop(), residual);
  });
});
