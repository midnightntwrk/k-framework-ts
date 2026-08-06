/**
 * Transcribed from `pyk/src/tests/unit/kast/test_manip.py` at K v7.1.337, plus
 * the two `test_subst.py` tables whose subject is `manip.extract_subst`.
 *
 * pyk collects 75 cases in `test_manip.py`.  61 are transcribed below;
 * the 14 skipped rows all belong to functions that need `KDefinition` or
 * `KAtt`, or that this package rules out, and each is marked where its table
 * would have gone.  The 12 cases near the bottom are `test_extract_subst` (11)
 * and `test_propagate_subst` (1), which `test/subst.test.ts` left for this
 * file.  Three more are not upstream at all: pyk tests none of the four places
 * `manip.py` raises.
 *
 * The last two blocks are also not upstream.  `noCellRewriteToDots` is the one
 * function here that deliberately does not match pyk — upstream's is the
 * identity on every input, for the reason `src/manip.ts` sets out — so the
 * deviation is pinned from both sides rather than left in prose, and
 * `onAttributes`/`removeSourceMap` get the sentence kinds pyk's single
 * `KBubble` case (`test_manip.py:643-668`) does not reach.
 */

import { describe, expect, test } from "bun:test";
import {
  Subst,
  kapply,
  klabel,
  krewrite,
  ksequence,
  ksort,
  ktoken,
  kvariable,
  type KInner,
  type KLabel,
  type KSort,
} from "../src/inner.ts";
import {
  boolToMlPred,
  buildClaim,
  buildRule,
  collapseDots,
  defunctionalize,
  extractSubst,
  isSpuriousConstraint,
  isTermLike,
  minimizeTerm,
  mlPredToBool,
  noCellRewriteToDots,
  normalizeConstraints,
  normalizeMlPred,
  onAttributes,
  pushDownRewrites,
  reprKInner,
  removeGeneratedCells,
  removeSourceMap,
  renameGeneratedVars,
  simplifyBool,
  splitConfigAndConstraints,
  splitConfigFrom,
} from "../src/manip.ts";
import { Atts, KAtt, attEntry } from "../src/att.ts";
import { eq } from "../src/eq.ts";
import { KDefinition, kflatmodule, knonterminal, kproduction, krule, kterminal } from "../src/outer.ts";
import { DOTS } from "../src/prelude/k.ts";
import { andBool, notBool } from "../src/prelude/kbool.ts";
import { mlNot } from "../src/prelude/ml.ts";
import {
  BOOL,
  FALSE,
  GENERATED_TOP_CELL,
  INT,
  TRUE,
  a,
  b,
  c,
  expectTerm,
  expectTerms,
  f,
  intToken,
  k,
  mlAnd,
  mlBottom,
  mlEquals,
  mlEqualsFalse,
  mlEqualsTrue,
  mlTop,
  x,
  y,
} from "./helpers.ts";

/** `test_manip.py:42-46`. */
const K_CELL = kapply("<k>", [ksequence([kvariable("S1"), kvariable("_DotVar0")])]);
const T_CELL = kapply("<T>", [K_CELL, kapply("<state>", [kvariable("MAP")])]);
const GENERATED_COUNTER_CELL = kapply("<generatedCounter>", [kvariable("X")]);
const GENERATED_TOP_CELL_1 = kapply("<generatedTop>", [T_CELL, kvariable("_GENERATED_COUNTER_PLACEHOLDER")]);
const GENERATED_TOP_CELL_2 = kapply("<generatedTop>", [T_CELL, GENERATED_COUNTER_CELL]);

///////////////////////////////////////////////
// PUSH_REWRITES_TEST_DATA (test_manip.py:48) //
///////////////////////////////////////////////

const PUSH_REWRITES_TEST_DATA: readonly (readonly [KInner, KInner])[] = [
  [krewrite(ksequence([f(a), b]), ksequence([f(c), b])), ksequence([f(krewrite(a, c)), b])],
  [krewrite(ksequence([a, b]), ksequence([b])), ksequence([krewrite(ksequence([a]), ksequence([])), b])],
  [krewrite(ksequence([a, x]), x), ksequence([krewrite(ksequence([a]), ksequence([])), x])],
];

describe("pushDownRewrites", () => {
  PUSH_REWRITES_TEST_DATA.forEach(([term, expected], i) => {
    test(String(i), () => {
      expectTerm(pushDownRewrites(term), expected);
    });
  });
});

///////////////////////////////////////////////
// MINIMIZE_TERM_TEST_DATA (test_manip.py:66) //
///////////////////////////////////////////////

const STATE: KLabel = klabel("<state>");
const PC: KLabel = klabel("<pc>");
const state = (...args: readonly KInner[]): KInner => kapply(STATE, args);
const pc = (...args: readonly KInner[]): KInner => kapply(PC, args);

const MINIMIZE_TERM_TEST_DATA: readonly (readonly [KInner, KInner])[] = [
  [f(k(a), state(a), pc(a)), f(k(a), state(a), pc(a))],
];

describe("minimizeTerm", () => {
  MINIMIZE_TERM_TEST_DATA.forEach(([term, expected], i) => {
    test(String(i), () => {
      expectTerm(minimizeTerm(term), expected);
    });
  });
});

////////////////////////////////////////////
// ML_TO_BOOL_TEST_DATA (test_manip.py:81) //
////////////////////////////////////////////

const ML_TO_BOOL_TEST_DATA: readonly (readonly [string, boolean, KInner, KInner])[] = [
  ["equals-true", false, kapply(klabel("#Equals", [BOOL, GENERATED_TOP_CELL]), [TRUE, f(a)]), f(a)],
  ["equals-true-comm", false, kapply(klabel("#Equals", [BOOL, GENERATED_TOP_CELL]), [f(a), TRUE]), f(a)],
  ["equals-false", false, kapply(klabel("#Equals", [BOOL, GENERATED_TOP_CELL]), [FALSE, f(a)]), notBool(f(a))],
  ["equals-false-comm", false, kapply(klabel("#Equals", [BOOL, GENERATED_TOP_CELL]), [f(a), FALSE]), notBool(f(a))],
  ["top-sort-bool", false, kapply(klabel("#Top", [BOOL])), TRUE],
  ["top-no-sort", false, kapply("#Top"), TRUE],
  ["top-no-sort-prelude", false, mlTop(), TRUE],
  ["equals-variabl", false, kapply(klabel("#Equals"), [x, f(a)]), kapply("_==K_", [x, f(a)])],
  ["equals-true-no-sort", false, kapply(klabel("#Equals"), [TRUE, f(a)]), f(a)],
  ["equals-true-comm-no-sort", false, kapply(klabel("#Equals"), [f(a), TRUE]), f(a)],
  [
    "equals-token",
    false,
    kapply(klabel("#Equals", [ksort("Int"), GENERATED_TOP_CELL]), [intToken(3), f(a)]),
    kapply("_==Int_", [intToken(3), f(a)]),
  ],
  ["not-top", false, kapply(klabel("#Not", [GENERATED_TOP_CELL]), [mlTop()]), notBool(TRUE)],
  ["equals-term", true, kapply(klabel("#Equals"), [f(a), f(x)]), kapply("_==K_", [f(a), f(x)])],
  [
    "simplify-and-true",
    false,
    kapply(klabel("#And", [GENERATED_TOP_CELL]), [mlEqualsTrue(TRUE), mlEqualsTrue(TRUE)]),
    TRUE,
  ],
  [
    "ceil-set-concat-no-sort",
    true,
    kapply(klabel("#Ceil", [ksort("Set"), GENERATED_TOP_CELL]), [
      kapply(klabel("_Set_"), [kvariable("_"), kvariable("_")]),
    ]),
    kvariable("Ceil_db45cd3a"),
  ],
  [
    "ceil-set-concat-sort",
    true,
    kapply(klabel("#Not", [GENERATED_TOP_CELL]), [
      kapply(klabel("#Ceil", [ksort("Set"), GENERATED_TOP_CELL]), [
        kapply(klabel("_Set_"), [kvariable("_"), kvariable("_")]),
      ]),
    ]),
    notBool(kvariable("Ceil_db45cd3a")),
  ],
  [
    "exists-equal-int",
    true,
    kapply(klabel("#Exists", [INT, BOOL]), [kvariable("X"), kapply("_==Int_", [kvariable("X"), kvariable("Y")])]),
    kvariable("Exists_a0a13db0"),
  ],
  [
    "kapply-equal-kappy",
    false,
    kapply(klabel("#Equals", [ksort("Int"), ksort("GeneratedTopCell")]), [
      kapply(klabel("#lookup(_,_)_EVM-TYPES_Int_Map_Int", []), [
        kvariable("?STORAGE", ksort("Map")),
        ktoken("32", ksort("Int")),
      ]),
      kapply(klabel("#lookup(_,_)_EVM-TYPES_Int_Map_Int", []), [
        kvariable("?STORAGE", ksort("Map")),
        ktoken("32", ksort("Int")),
      ]),
    ]),
    kapply(klabel("_==K_", []), [
      kapply(klabel("#lookup(_,_)_EVM-TYPES_Int_Map_Int", []), [
        kvariable("?STORAGE", ksort("Map")),
        ktoken("32", ksort("Int")),
      ]),
      kapply(klabel("#lookup(_,_)_EVM-TYPES_Int_Map_Int", []), [
        kvariable("?STORAGE", ksort("Map")),
        ktoken("32", ksort("Int")),
      ]),
    ]),
  ],
];

describe("mlPredToBool", () => {
  for (const [id, abstractUnsafe, mlPred, expected] of ML_TO_BOOL_TEST_DATA) {
    test(id, () => {
      expectTerm(mlPredToBool(mlPred, { abstractUnsafe }), expected);
    });
  }
});

/////////////////////////////////////////////
// BOOL_TO_ML_TEST_DATA (test_manip.py:204) //
/////////////////////////////////////////////

/** pyk's tuple is `(test_id, expected, term)` — the last two are swapped. */
const BOOL_TO_ML_TEST_DATA: readonly (readonly [string, KInner, KInner])[] = [
  ["equals-true", kapply(klabel("#Equals", [BOOL, GENERATED_TOP_CELL]), [TRUE, f(a)]), f(a)],
];

describe("boolToMlPred", () => {
  for (const [id, expected, term] of BOOL_TO_ML_TEST_DATA) {
    test(id, () => {
      expectTerm(boolToMlPred(term), expected);
    });
  }
});

///////////////////////////////////////////////
// REMOVE_GENERATED_TEST_DATA (test_manip.py:220) //
///////////////////////////////////////////////

const REMOVE_GENERATED_TEST_DATA: readonly (readonly [KInner, KInner])[] = [
  [GENERATED_TOP_CELL_1, T_CELL],
  [GENERATED_TOP_CELL_2, T_CELL],
];

describe("removeGeneratedCells", () => {
  REMOVE_GENERATED_TEST_DATA.forEach(([term, expected], i) => {
    test(String(i), () => {
      expectTerm(removeGeneratedCells(term), expected);
    });
  });
});

//////////////////////////////////////////////////////////
// RENAME_GENERATED_VARS_TEST_DATA (test_manip.py:235)   //
//////////////////////////////////////////////////////////

const RENAME_GENERATED_VARS_TEST_DATA: readonly (readonly [string, KInner, KInner])[] = [
  [
    "non-generated",
    kapply("<k>", [
      ksequence([
        kvariable("Gen"),
        kvariable("DotVar"),
        kvariable("?Gen"),
        kvariable("?DotVar"),
        kvariable("_notGen"),
        kvariable("_notDotVar"),
        kvariable("?_notGen"),
        kvariable("?_ntDotVar"),
      ]),
    ]),
    kapply("<k>", [
      ksequence([
        kvariable("Gen"),
        kvariable("DotVar"),
        kvariable("?Gen"),
        kvariable("?DotVar"),
        kvariable("_notGen"),
        kvariable("_notDotVar"),
        kvariable("?_notGen"),
        kvariable("?_ntDotVar"),
      ]),
    ]),
  ],
  [
    "name-conflicts",
    kapply("<k>", [ksequence([kvariable("_Gen"), kvariable("_DotVar"), kvariable("?_Gen"), kvariable("?_DotVar")])]),
    kapply("<k>", [
      ksequence([
        kvariable("K_CELL_8b13e996"),
        kvariable("K_CELL_3ee7a189"),
        kvariable("K_CELL_40796e18"),
        kvariable("K_CELL_20fb46a2"),
      ]),
    ]),
  ],
  [
    "nested-cells",
    kapply("<k>", [
      kapply("<cell1>", [kvariable("_Gen1")]),
      kapply("<cell2>", [kapply("<cell3>", [kvariable("_Gen2")])]),
    ]),
    kapply("<k>", [
      kapply("<cell1>", [kvariable("CELL1_CELL_dbe3b121")]),
      kapply("<cell2>", [kapply("<cell3>", [kvariable("CELL3_CELL_125dfae6")])]),
    ]),
  ],
  [
    "multiple-args",
    kapply("<generatedTop>", [
      kapply("<k>", [krewrite(kvariable("_Gen0"), kvariable("?_Gen1"))]),
      kapply("<generatedCounter>", [kvariable("GENERATEDCOUNTER_CELL")]),
      kapply("<outerCell>", [
        krewrite(kvariable("_Gen1"), kvariable("_Gen4")),
        krewrite(kvariable("_Gen3"), kvariable("_Gen5")),
      ]),
    ]),
    kapply("<generatedTop>", [
      kapply("<k>", [krewrite(kvariable("K_CELL_7d91010a"), kvariable("K_CELL_3efbf5b5"))]),
      kapply("<generatedCounter>", [kvariable("GENERATEDCOUNTER_CELL")]),
      kapply("<outerCell>", [
        krewrite(kvariable("OUTERCELL_CELL_dbe3b121"), kvariable("OUTERCELL_CELL_3efb5235")),
        krewrite(kvariable("OUTERCELL_CELL_82e8f7a8"), kvariable("OUTERCELL_CELL_f301f679")),
      ]),
    ]),
  ],
  [
    "no-outer-cell",
    kapply("#And", [kapply("<k>", [kvariable("_Gen1")]), kvariable("_Gen2")]),
    kapply("#And", [kapply("<k>", [kvariable("K_CELL_dbe3b121")]), kvariable("_Gen2")]),
  ],
];

describe("renameGeneratedVars", () => {
  for (const [id, term, expected] of RENAME_GENERATED_VARS_TEST_DATA) {
    test(id, () => {
      expectTerm(renameGeneratedVars(term), expected);
    });
  }
});

//////////////////////////////////////
// test_collapse_dots (test_manip.py:339) //
//////////////////////////////////////

describe("collapseDots", () => {
  test("0", () => {
    const term = new Subst({ MAP: DOTS, _GENERATED_COUNTER_PLACEHOLDER: DOTS }).apply(GENERATED_TOP_CELL_1);
    const expected = kapply("<generatedTop>", [kapply("<T>", [K_CELL, DOTS]), DOTS]);
    expectTerm(collapseDots(term), expected);
  });
});

/////////////////////////////////////////////////
// SIMPLIFY_BOOL_TEST_DATA (test_manip.py:351)  //
/////////////////////////////////////////////////

const SIMPLIFY_BOOL_TEST_DATA: readonly (readonly [string, KInner, KInner])[] = [
  ["trivial-false", andBool([FALSE, TRUE]), FALSE],
  [
    "and-true",
    andBool([kapply("_==Int_", [intToken(3), intToken(4)]), TRUE]),
    kapply("_==Int_", [intToken(3), intToken(4)]),
  ],
  ["not-false", notBool(FALSE), TRUE],
];

describe("simplifyBool", () => {
  for (const [id, term, expected] of SIMPLIFY_BOOL_TEST_DATA) {
    test(id, () => {
      expectTerm(simplifyBool(term), expected);
    });
  }
});

////////////////////////////////////////////////////
// NORMALIZE_ML_PRED_TEST_DATA (test_manip.py:375) //
////////////////////////////////////////////////////

const X = kvariable("X");
const Y = kvariable("Y");
const XInt = kvariable("X", ksort("Int"));
const YInt = kvariable("Y", ksort("Int"));

const NORMALIZE_ML_PRED_TEST_DATA: readonly (readonly [string, KInner, KInner])[] = [
  ["not-top", mlNot(mlTop()), mlBottom()],
  ["not-bottom", mlNot(mlTop()), mlBottom()],
  [
    "mlAnd-bottom",
    mlAnd([
      mlEqualsTrue(kapply("_==Int_", [X, Y])),
      mlBottom(),
      mlEqualsTrue(kapply("_==Int_", [kvariable("Z"), kvariable("T")])),
    ]),
    mlBottom(),
  ],
  [
    "mlAnd-top",
    mlAnd([
      mlEqualsTrue(kapply("_==Int_", [X, Y])),
      mlTop(),
      mlEqualsTrue(kapply("_==Int_", [kvariable("Z"), kvariable("T")])),
    ]),
    mlAnd([mlEqualsTrue(kapply("_==Int_", [X, Y])), mlEqualsTrue(kapply("_==Int_", [kvariable("Z"), kvariable("T")]))]),
  ],
  ["mlEqualsTrue-eqK-idempotent", mlEqualsTrue(kapply("_==K_", [X, Y])), mlEqualsTrue(kapply("_==K_", [X, Y]))],
  ["mlEqualsTrue-neqK-idempotent", mlEqualsTrue(kapply("_=/=K_", [X, Y])), mlEqualsTrue(kapply("_=/=K_", [X, Y]))],
  ["mlEqualsFalse-eqK", mlEqualsFalse(kapply("_==K_", [X, Y])), mlEqualsTrue(kapply("_=/=K_", [X, Y]))],
  ["mlEqualsFalse-neqK", mlEqualsFalse(kapply("_=/=K_", [X, Y])), mlEqualsTrue(kapply("_==K_", [X, Y]))],
  ["mlEqualsTrue-eqInt-idempotent", mlEqualsTrue(kapply("_==Int_", [X, Y])), mlEqualsTrue(kapply("_==Int_", [X, Y]))],
  [
    "mlEqualsTrue-neqInt-idempotent",
    mlEqualsTrue(kapply("_=/=Int_", [X, Y])),
    mlEqualsTrue(kapply("_=/=Int_", [X, Y])),
  ],
  ["mlEqualsFalse-eqInt", mlEqualsFalse(kapply("_==Int_", [X, Y])), mlEqualsTrue(kapply("_=/=Int_", [X, Y]))],
  ["mlEqualsFalse-neqInt", mlEqualsFalse(kapply("_=/=Int_", [X, Y])), mlEqualsTrue(kapply("_==Int_", [X, Y]))],
  ["mlEquals-eqK", kapply("#Equals", [X, Y]), mlEqualsTrue(kapply("_==K_", [X, Y]))],
  ["mlEquals-eqInt", kapply("#Equals", [XInt, YInt]), mlEqualsTrue(kapply("_==Int_", [XInt, YInt]))],
  ["mlNEquals-eqK", mlNot(kapply("#Equals", [X, Y])), mlEqualsTrue(kapply("_=/=K_", [X, Y]))],
  ["mlNEquals-eqInt", mlNot(kapply("#Equals", [XInt, YInt])), mlEqualsTrue(kapply("_=/=Int_", [XInt, YInt]))],
];

describe("normalizeMlPred", () => {
  for (const [id, term, expected] of NORMALIZE_ML_PRED_TEST_DATA) {
    test(id, () => {
      expectTerm(normalizeMlPred(term), expected);
    });
  }
});

/////////////////////////////////////////////
// SPLIT_CONFIG_TEST_DATA (test_manip.py:482) //
/////////////////////////////////////////////

const MAP_ITEM_CELL = kapply("<mapItem>", [kapply("foo")]);

const SPLIT_CONFIG_TEST_DATA: readonly (readonly [KInner, KInner, Readonly<Record<string, KInner>>])[] = [
  [
    kapply("<k>", [ksequence([kapply("foo"), kapply("bar")])]),
    kapply("<k>", [kvariable("K_CELL")]),
    { K_CELL: ksequence([kapply("foo"), kapply("bar")]) },
  ],
  [
    kapply("<mapCell>", [kapply("map_join", [MAP_ITEM_CELL, MAP_ITEM_CELL])]),
    kapply("<mapCell>", [kvariable("MAPCELL_CELL")]),
    { MAPCELL_CELL: kapply("map_join", [MAP_ITEM_CELL, MAP_ITEM_CELL]) },
  ],
];

describe("splitConfigFrom", () => {
  SPLIT_CONFIG_TEST_DATA.forEach(([term, expectedConfig, expectedSubst], i) => {
    test(String(i), () => {
      const [actualConfig, actualSubst] = splitConfigFrom(term);
      expectTerm(actualConfig, expectedConfig);
      expect(Object.fromEntries(actualSubst)).toEqual(expectedSubst);
    });
  });
});

////////////////////////////////////////////////
// IS_TERM_LIKE_TEST_DATA (test_manip.py:506)  //
////////////////////////////////////////////////

const IS_TERM_LIKE_TEST_DATA: readonly (readonly [string, KInner, boolean])[] = [
  ["var_with_at", kvariable("@S1"), false],
  ["var_without_at", kvariable("S1"), true],
  ...(["#Equals", "#And", "#Or", "#Implies"] as const).map(
    (labelName) =>
      [`label_${labelName}`, kapply(klabel(labelName), [kvariable("S1"), kvariable("S2")]), false] as const,
  ),
  ["label_lookup", kapply(klabel("<kevm>")), true],
  ["nested-1", kapply(klabel("<output>"), [kapply(klabel("#And"), [kvariable("S1"), kvariable("S2")])]), false],
  ["nested-2", kapply(klabel("<pc>"), [kapply(klabel("#lookup"), [kvariable("S1"), kvariable("@S2")])]), false],
];

describe("isTermLike", () => {
  for (const [id, term, expected] of IS_TERM_LIKE_TEST_DATA) {
    test(id, () => {
      expect(isTermLike(term)).toBe(expected);
    });
  }
});

//////////////////////////////////////////////////////////////////
// Not upstream: the error paths, which pyk does not test        //
//////////////////////////////////////////////////////////////////

describe("failure modes", () => {
  test("mlPredToBool rejects both options at once", () => {
    // `manip.py:118-119`.
    expect(() => mlPredToBool(mlTop(), { abstractUnsafe: true, keepUnsafe: true })).toThrow();
  });

  test("mlPredToBool throws on a predicate it cannot convert", () => {
    // `manip.py:173`, a `ValueError` upstream.
    const ceil = kapply(klabel("#Ceil", [ksort("Set"), GENERATED_TOP_CELL]), [kapply("_Set_", [x, y])]);
    expect(() => mlPredToBool(ceil)).toThrow();
    expect(mlPredToBool(ceil, { keepUnsafe: true })).toBe(ceil);
  });

  test("splitConfigAndConstraints needs exactly one configuration", () => {
    // `manip.py:298,303`, both `ValueError` upstream.
    expect(() => splitConfigAndConstraints(mlEqualsTrue(kapply("_==K_", [x, a])))).toThrow();
    expect(() => splitConfigAndConstraints(mlAnd([K_CELL, T_CELL]))).toThrow();
  });
});

//////////////////////////////////////////////////////////////////
// Skipped tables                                               //
//////////////////////////////////////////////////////////////////

// `INDEXED_REWRITE_TEST_DATA` (test_manip.py:528, 6 rows): `indexed_rewrite`
// lives in `rewrite.py` and is decided out of scope.
// `test_on_attributes_recurses_into_kdefinition_sentences` (test_manip.py:643,
// 1 row): `on_attributes` needs `KAtt` and the outer sentences (phase 2).

//////////////////////////////////////////////////////////////////////
// CTerm prerequisites (`manip.py:665-892`, `test_cterm.py:126-185`) //
//////////////////////////////////////////////////////////////////////

describe("constraint normalization", () => {
  test("drops weak tops and reflexive equality while retaining first unique constraints", () => {
    const useful = mlEquals(x, a, INT);
    const reflexive = mlEquals(b, b, INT);
    const constraints = normalizeConstraints([mlAnd([useful, useful, mlTop()]), reflexive, mlTop()]);
    expectTerms(constraints, [useful]);
  });

  test("recognizes the two spurious shapes exactly as pyk does", () => {
    expect(isSpuriousConstraint(mlEquals(a, a, INT))).toBe(true);
    expect(isSpuriousConstraint(mlAnd([mlTop(), mlTop()]))).toBe(true);
    expect(isSpuriousConstraint(mlEquals(a, b, INT))).toBe(false);
  });
});

describe("reprKInner", () => {
  test("matches pyk's generated frozen-dataclass spelling", () => {
    expect(reprKInner(f(kvariable("X")))).toBe(
      "KApply(label=KLabel(name='f', params=()), args=(KVariable(name='X', sort=None),))",
    );
  });
});

const ADD = klabel("_+_");
const INIT_S = klabel("init_s");
const TO_S = klabel("to_s");
const TO_S_2 = klabel("to_s_2");
const TO_INT = klabel("to_int");
const S = ksort("S");

const production = (label: KLabel, sort: KSort, items: readonly (KSort | string)[], isFunction: boolean) =>
  kproduction(sort, {
    klabel: label,
    items: items.map((item) => (typeof item === "string" ? kterminal(item) : knonterminal(item))),
    att: isFunction ? new KAtt([attEntry(Atts.FUNCTION, null)]) : new KAtt(),
  });

const DEFUNCT_DEFINITION = new KDefinition("TEST", [
  kflatmodule("TEST", {
    sentences: [
      production(ADD, INT, [INT, "+", INT], true),
      production(INIT_S, S, [], false),
      production(TO_S, S, [INT], false),
      production(TO_S_2, S, [INT, S], false),
      production(TO_INT, INT, [S], true),
    ],
  }),
]);

const add = (left: KInner, right: KInner) => kapply(ADD, [left, right]);
const initS = () => kapply(INIT_S);
const toS = (term: KInner) => kapply(TO_S, [term]);
const toS2 = (first: KInner, second: KInner) => kapply(TO_S_2, [first, second]);
const toInt = (term: KInner) => kapply(TO_INT, [term]);
const varEquals = (name: string, term: KInner) => mlEquals(kvariable(name, INT), term, INT);

/** The complete seven-row upstream `test_defunctionalize` corpus. */
const DEFUNCT_TEST_DATA: readonly (readonly [KInner, KInner, readonly KInner[]])[] = [
  [
    add(intToken(1), intToken(2)),
    kvariable("F_8e8c9492", INT),
    [varEquals("F_8e8c9492", add(intToken(1), intToken(2)))],
  ],
  [toS(intToken(1)), toS(intToken(1)), []],
  [
    toS(toInt(toS(add(intToken(1), intToken(2))))),
    toS(kvariable("F_3ddc64b8", INT)),
    [varEquals("F_3ddc64b8", toInt(toS(add(intToken(1), intToken(2)))))],
  ],
  [
    toS2(add(intToken(1), intToken(2)), initS()),
    toS2(kvariable("F_8e8c9492", INT), initS()),
    [varEquals("F_8e8c9492", add(intToken(1), intToken(2)))],
  ],
  [toS2(intToken(1), initS()), toS2(intToken(1), initS()), []],
  [
    toS2(add(intToken(1), intToken(2)), toS(add(intToken(1), intToken(2)))),
    toS2(kvariable("F_8e8c9492", INT), toS(kvariable("F_8e8c9492", INT))),
    [varEquals("F_8e8c9492", add(intToken(1), intToken(2)))],
  ],
  [
    toS2(add(intToken(1), intToken(2)), toS(toInt(initS()))),
    toS2(kvariable("F_8e8c9492", INT), toS(kvariable("F_3294e1be", INT))),
    [varEquals("F_8e8c9492", add(intToken(1), intToken(2))), varEquals("F_3294e1be", toInt(initS()))],
  ],
];

describe("defunctionalize", () => {
  DEFUNCT_TEST_DATA.forEach(([input, expectedTerm, expectedConstraints], i) => {
    test(String(i), () => {
      const [term, constraints] = defunctionalize(DEFUNCT_DEFINITION, input);
      expectTerm(term, expectedTerm);
      expectTerms(constraints, expectedConstraints);
    });
  });
});

describe("buildRule and buildClaim", () => {
  test("uses pyk's frontend-safe names, label and priority", () => {
    const v1 = kvariable("V1");
    const v2 = kvariable("V2");
    const [rule, map] = buildRule("test-rule", k(v1), k(v2), { priority: 42 });
    expectTerm(rule.body, k(krewrite(kvariable("_V1"), kvariable("?_V2"))));
    expect(rule.att.require(Atts.LABEL)).toBe("test-rule");
    expect(rule.att.require(Atts.PRIORITY)).toBe("42");
    expectTerm(map.get("_V1") ?? kvariable("MISSING"), v1);
    expectTerm(map.get("?_V2") ?? kvariable("MISSING"), v2);
  });

  test("keeps final-only constrained variables existential, as `test_cterm.py`", () => {
    const v1 = kvariable("V1");
    const v2 = kvariable("V2");
    const condition = mlEqualsTrue(kapply("_<=Int_", [intToken(0), v2]));
    const [claim] = buildClaim("claim", k(v1), k(v2), { finalConstraints: [condition] });
    expectTerm(claim.body, k(krewrite(kvariable("_V1"), kvariable("?V2"))));
    expectTerm(claim.ensures, kapply("_<=Int_", [intToken(0), kvariable("?V2")]));
    expect(claim.att.require(Atts.LABEL)).toBe("claim");
  });
});

//////////////////////////////////////////////////////////////////
// EXTRACT_SUBST_TEST_DATA (test_subst.py:112)                   //
//////////////////////////////////////////////////////////////////

const zero = intToken(0);
const eqInt = (left: KInner, right: KInner): KInner => kapply(klabel("_==Int_"), [left, right]);

const EXTRACT_SUBST_TEST_DATA: readonly (readonly [KInner, Readonly<Record<string, KInner>>, KInner])[] = [
  [a, {}, a],
  [mlEquals(a, b, INT), {}, mlEquals(a, b, INT)],
  [mlEquals(x, a, INT), { x: a }, mlTop()],
  [mlEquals(x, zero, INT), { x: zero }, mlTop()],
  [mlEquals(x, y, INT), { x: y }, mlTop()],
  [mlEquals(x, f(x), INT), {}, mlEquals(x, f(x), INT)],
  [mlAnd([mlEquals(x, y, INT), mlEquals(x, b, INT)]), { x: y }, mlEquals(x, b, INT)],
  [mlAnd([mlEquals(x, b, INT), mlEquals(x, y, INT)]), { x: b }, mlEquals(x, y, INT)],
  [mlAnd([mlEquals(a, b, INT), mlEquals(x, a, INT)]), { x: a }, mlEquals(a, b, INT)],
  [mlEqualsTrue(eqInt(a, b)), {}, mlEqualsTrue(eqInt(a, b))],
  [mlEqualsTrue(eqInt(x, a)), { x: a }, mlTop()],
];

describe("extractSubst", () => {
  EXTRACT_SUBST_TEST_DATA.forEach(([term, expectedSubst, expectedTerm], i) => {
    test(String(i), () => {
      const [actualSubst, actualTerm] = extractSubst(term);
      expect(actualSubst.toRecord()).toEqual(expectedSubst);
      expectTerm(actualTerm, expectedTerm);
    });
  });
});

//////////////////////////////////////////////////////////////////
// test_propagate_subst (test_subst.py:137)                      //
//////////////////////////////////////////////////////////////////

describe("extractSubst then unapply", () => {
  test("propagates a substitution back into a constrained term", () => {
    const v1 = kvariable("V1");
    const varX = kvariable("X");
    const barX = kapply("bar", [varX]);
    const config = kapply("<k>", [barX]);

    const substConjunct = mlEquals(v1, barX, INT);
    const otherConjunct = mlEqualsTrue(kapply("_<=Int_", [v1, kapply("foo", [varX, barX])]));

    const term = mlAnd([config, substConjunct, otherConjunct]);
    const termWoSubst = mlAnd([config, otherConjunct]);

    const [subst] = extractSubst(term);
    const actual = subst.unapply(termWoSubst);

    const expectedConfig = kapply("<k>", [v1]);
    const expectedConjunct = mlEqualsTrue(kapply("_<=Int_", [v1, kapply("foo", [varX, v1])]));
    expectTerm(actual, mlAnd([expectedConfig, expectedConjunct]));
  });
});

//////////////////////////////////////////////////////////////////
// noCellRewriteToDots — the one place this package leaves pyk   //
//////////////////////////////////////////////////////////////////

/**
 * `manip.py:843-865` is the identity function on every input: it maps its
 * inner transform over `split_config_from`'s substitution, whose values are
 * never cells, so the `is_cell` guard never fires and `subst(config)` rebuilds
 * the input.  `src/manip.ts` implements the behaviour pyk's *docstring*
 * describes instead, so these two rows are the deviation, pinned from both
 * sides.  Both fixtures were run through pyk 7.1.337 to produce the "pyk"
 * column; the first is upstream's own test input (`test_kcfg.py:838-871`).
 */
describe("noCellRewriteToDots", () => {
  const rewritingCell = kapply("<T>", [
    kapply("<k>", [krewrite(ksequence([a, kvariable("S")]), ksequence([b, kvariable("S")]))]),
    kapply("<state>", [krewrite(x, y)]),
  ]);
  const unchangedStateCell = kapply("<T>", [
    kapply("<k>", [krewrite(ksequence([a, kvariable("S")]), ksequence([b, kvariable("S")]))]),
    kapply("<state>", [krewrite(x, x)]),
  ]);

  test("agrees with pyk when every cell rewrites", () => {
    // pyk returns the input unchanged, and so does this — for different
    // reasons: pyk never looks, and here no cell has lhs === rhs.
    expectTerm(noCellRewriteToDots(rewritingCell), rewritingCell);
  });

  test("dots an unchanged cell, where pyk returns the term untouched", () => {
    const expected = kapply("<T>", [
      kapply("<k>", [krewrite(ksequence([a, kvariable("S")]), ksequence([b, kvariable("S")]))]),
      kapply("<state>", [DOTS]),
    ]);
    expectTerm(noCellRewriteToDots(unchangedStateCell), expected);
    // The deviation, stated as an assertion rather than only in prose.
    expect(eq(noCellRewriteToDots(unchangedStateCell), unchangedStateCell)).toBe(false);
  });

  test("collapses a parent whose children have all become dots", () => {
    const allUnchanged = kapply("<T>", [kapply("<k>", [krewrite(x, x)]), kapply("<state>", [krewrite(y, y)])]);
    // Bottom up: both leaves dot first, then `<T>`'s two sides are equal too.
    expectTerm(noCellRewriteToDots(allUnchanged), kapply("<T>", [DOTS]));
  });
});

//////////////////////////////////////////////////////////////////
// onAttributes over a sentence kind that is not a rule          //
//////////////////////////////////////////////////////////////////

describe("onAttributes", () => {
  test("dispatches over every sentence kind, not just rules", () => {
    const located = kproduction(INT, {
      items: [kterminal("foo")],
      att: new KAtt([attEntry(Atts.SOURCE, "/a/b.k"), attEntry(Atts.LOCATION, [1, 2, 3, 4])]),
    });
    const stripped = onAttributes(located, (att) => att.dropSource());
    expect(stripped.node).toBe("KProduction");
    expect(stripped.att.get(Atts.SOURCE)).toBeUndefined();
    expect(stripped.att.get(Atts.LOCATION)).toBeUndefined();
  });

  test("removeSourceMap keeps every other attribute", () => {
    const rule = krule(k(a), {
      att: new KAtt([attEntry(Atts.LABEL, "R"), attEntry(Atts.SOURCE, "/a/b.k")]),
    });
    const module = kflatmodule("TEST", { sentences: [rule], att: new KAtt([attEntry(Atts.SOURCE, "/a/b.k")]) });
    const stripped = removeSourceMap(new KDefinition("TEST", [module]));
    const strippedRule = stripped.module("TEST").sentences[0];
    expect(strippedRule?.att.get(Atts.SOURCE)).toBeUndefined();
    expect(strippedRule?.att.get(Atts.LABEL)).toBe("R");
    expect(stripped.module("TEST").att.get(Atts.SOURCE)).toBeUndefined();
  });
});
