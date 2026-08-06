import { describe, expect, test } from "bun:test";
import {
  Atts,
  KAtt,
  attEntry,
  kapply,
  kclaim,
  kflatmodule,
  knonterminal,
  kproduction,
  krewrite,
  ksort,
  kvariable,
  KDefinition,
  type KInner,
} from "@kframework-ts/kast";
import { intToken } from "@kframework-ts/kast/prelude/kint";
import { mlAnd, mlEqualsTrue } from "@kframework-ts/kast/prelude/ml";

import { ctermBuildClaim, ctermBuildRule } from "../src/builders.ts";
import { CTerm } from "../src/cterm.ts";

const k = (...args: readonly KInner[]) => kapply("<k>", args);
const mem = (...args: readonly KInner[]) => kapply("<mem>", args);
const top = (...args: readonly KInner[]) => kapply("<generatedTop>", args);
const constraint = (variable: ReturnType<typeof kvariable>) => kapply("_<=Int_", [intToken(0), variable]);

describe("ctermBuildRule", () => {
  test("ports pyk test_cterm.py BUILD_RULE_TEST_DATA", () => {
    const lhs = top(k(kvariable("K_CELL", "K")), mem(kvariable("MEM_CELL")));
    const rhs = top(
      k(kvariable("K_CELL")),
      mem(kapply("_[_<-_]", [kvariable("MEM_CELL"), kvariable("KEY"), kvariable("VALUE")])),
    );
    const expected = top(
      k(kvariable("_K_CELL", "K")),
      mem(
        krewrite(
          kvariable("MEM_CELL"),
          kapply("_[_<-_]", [kvariable("MEM_CELL"), kvariable("?_KEY"), kvariable("?_VALUE")]),
        ),
      ),
    );

    const [rule] = ctermBuildRule("test-rule", CTerm.fromKast(lhs), CTerm.fromKast(rhs), { keepVars: ["K_CELL"] });
    expect(rule.body).toEqual(expected);
  });

  test("forwards the generated-rule label and priority attributes", () => {
    const [rule] = ctermBuildRule("generated-rule", new CTerm(k(kvariable("X"))), new CTerm(k(kvariable("Y"))), {
      priority: 42,
    });

    expect(rule.att.require(Atts.LABEL)).toBe("generated-rule");
    expect(rule.att.require(Atts.PRIORITY)).toBe("42");
  });

  test("forwards defuncWith to turn an LHS function into a side condition", () => {
    const functionTerm = kapply("f", [intToken(1)]);
    const int = ksort("Int");
    const definition = new KDefinition("MAIN", [
      kflatmodule("MAIN", {
        sentences: [
          kproduction(int, {
            klabel: functionTerm.label,
            items: [knonterminal(int)],
            att: new KAtt([attEntry(Atts.FUNCTION, null)]),
          }),
        ],
      }),
    ]);
    const [rule] = ctermBuildRule("defunc-rule", new CTerm(k(functionTerm)), new CTerm(k(kvariable("RESULT", "Int"))), {
      defuncWith: definition,
    });

    expect(rule.body.node).toBe("KApply");
    if (rule.body.node === "KApply") {
      const rewrite = rule.body.args[0];
      expect(rewrite?.node).toBe("KRewrite");
      if (rewrite?.node === "KRewrite") expect(rewrite.lhs.node).toBe("KVariable");
    }
    expect(rule.requires.node).toBe("KApply");
    if (rule.requires.node === "KApply") {
      expect(rule.requires.label.name).toBe("_==Int_");
      expect(rule.requires.args[1]).toEqual(functionTerm);
    }
  });
});

describe("ctermBuildClaim", () => {
  const V1 = kvariable("V1");
  const V2 = kvariable("V2");
  const V1Sorted = kvariable("V1", "Int");
  const expectedAtt = new KAtt([attEntry(Atts.LABEL, "claim")]);

  const cases = [
    {
      name: "sorted variable from body",
      init: mlAnd([k(V1Sorted), mlEqualsTrue(constraint(V1))]),
      final: k(V2),
      expected: kclaim(k(krewrite(V1Sorted, kvariable("?_V2"))), { requires: constraint(V1), att: expectedAtt }),
    },
    {
      name: "sorted variable from constraint",
      init: mlAnd([k(V1), mlEqualsTrue(constraint(V1Sorted))]),
      final: k(V2),
      expected: kclaim(k(krewrite(V1, kvariable("?_V2"))), { requires: constraint(V1Sorted), att: expectedAtt }),
    },
    {
      name: "required RHS variable stays available",
      init: mlAnd([k(V1), mlEqualsTrue(constraint(V2))]),
      final: k(V2),
      expected: kclaim(k(krewrite(kvariable("_V1"), V2)), { requires: constraint(V2), att: expectedAtt }),
    },
    {
      name: "free RHS variable receives question/anonymous naming",
      init: k(V1),
      final: k(V2),
      expected: kclaim(k(krewrite(kvariable("_V1"), kvariable("?_V2"))), { att: expectedAtt }),
    },
    {
      name: "RHS constraint becomes ensures",
      init: k(V1),
      final: mlAnd([k(V2), mlEqualsTrue(constraint(V2))]),
      expected: kclaim(k(krewrite(kvariable("_V1"), kvariable("?V2"))), {
        ensures: constraint(kvariable("?V2")),
        att: expectedAtt,
      }),
    },
  ] as const;

  for (const row of cases) {
    test(`ports pyk test_cterm.py BUILD_CLAIM_TEST_DATA: ${row.name}`, () => {
      const [actual] = ctermBuildClaim("claim", CTerm.fromKast(row.init), CTerm.fromKast(row.final));
      expect(actual).toEqual(row.expected);
    });
  }
});
