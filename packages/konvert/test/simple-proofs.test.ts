/**
 * Corpus #2 — `test_simple_proofs.py`, the main konvert table.
 *
 * Transcribed from `k/pyk/src/tests/integration/konvert/test_simple_proofs.py`
 * at K v7.1.337: `KAST_TO_KORE_TEST_DATA` (47 cases), `KORE_TO_KAST_TEST_DATA`
 * (29), `KRULE_TO_KORE_DATA` (12), `KRULE_TO_KORE_EXPLICIT_DATA` (1) and
 * `SORT_TERM_DATA` (12).  The first 27 rows of each of the first two are the
 * shared `BIDIRECTIONAL_TEST_DATA`.
 *
 * Upstream this is an *integration* suite only because it kompiles
 * `simple-proofs.k` at test time.  `fixtures/definitions/simple-proofs.compiled.json`
 * is that kompile, run once, vendored — see `fixtures/PROVENANCE.md`, including
 * its warning that pyk's own test kompiler defaults to the **llvm** backend, so
 * a disagreement with the haskell fixture is worth re-checking against
 * `simple-proofs.llvm.compiled.json` before being called a transcription bug.
 * Every case below was checked against **both** builds; see the last `describe`.
 *
 * Two upstream test functions are deliberately not reproduced:
 * `test_kast_to_kore_frontend` (compares against the `kast` binary, which needs
 * a K install) and the `frontend-comp-skip` list it reads, which is vendored at
 * `fixtures/upstream/frontend-comp-skip` for the record and is data about that
 * comparison, not about this one.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  Atts,
  type KDefinition,
  type KInner,
  type KRule,
  type KSort,
  kapply,
  klabel,
  krewrite,
  krule,
  ksequence,
  ksort,
  ktoken,
  kvariable,
  moduleRules,
  readKastDefinitionFromJson,
} from "@kframework-ts/kast";
import { bytesToken } from "@kframework-ts/kast/prelude/bytes";
import { BOOL, TRUE } from "@kframework-ts/kast/prelude/kbool";
import { INT, intToken } from "@kframework-ts/kast/prelude/kint";
import { mlBottom, mlImplies, mlTop } from "@kframework-ts/kast/prelude/ml";
import { stringToken } from "@kframework-ts/kast/prelude/string";
import { koreText, parsePattern } from "@kframework-ts/kore";

import { kastToKore, koreToKast } from "../src/convert.ts";
import { kruleToKore } from "../src/rule.ts";

const FIXTURES = join(import.meta.dir, "..", "fixtures", "definitions");

function loadDefinition(name: string): KDefinition {
  return readKastDefinitionFromJson(readFileSync(join(FIXTURES, name), "utf8"));
}

const DEFINITION = loadDefinition("simple-proofs.compiled.json");

/** `[test id, sort, KORE text, KAST]`. */
type ConversionCase = readonly [string, KSort, string, KInner];

/** `BIDIRECTIONAL_TEST_DATA` — `test_simple_proofs.py:30-280`, 27 rows. */
const BIDIRECTIONAL_TEST_DATA: readonly ConversionCase[] = [
  ["domain-value-int", INT, String.raw`\dv{SortInt{}}("3")`, intToken(3)],
  ["domain-value-string", ksort("String"), String.raw`\dv{SortString{}}("foobar\n")`, stringToken("foobar\n")],
  [
    "domain-value-bytes",
    ksort("Bytes"),
    '\\dv{SortBytes{}}("\\x00<`\\xf5")',
    bytesToken(new Uint8Array([0x00, 0x3c, 0x60, 0xf5])),
  ],
  ["domain-value-other", ksort("Foo"), String.raw`\dv{SortFoo{}}("hello\\n")`, ktoken("hello\\n", "Foo")],
  ["ml-top", ksort("GeneratedTopCell"), String.raw`\top{SortGeneratedTopCell{}}()`, mlTop()],
  ["ml-bottom", ksort("GeneratedTopCell"), String.raw`\bottom{SortGeneratedTopCell{}}()`, mlBottom()],
  [
    "ml-implies",
    ksort("GeneratedTopCell"),
    String.raw`
        \implies{SortGeneratedTopCell{}}(
            VarX : SortGeneratedTopCell{},
            VarY : SortGeneratedTopCell{}
        )
        `,
    mlImplies(kvariable("X", "GeneratedTopCell"), kvariable("Y", "GeneratedTopCell"), "GeneratedTopCell"),
  ],
  ["variable-with-sort", INT, "VarX : SortInt{}", kvariable("X", INT)],
  ["variable-with-super-sort", ksort("Bar"), "inj{SortBaz{}, SortBar{}}(VarX : SortBaz{})", kvariable("X", "Baz")],
  ["variable-with-underscore", INT, "VarX'Unds'Y : SortInt{}", kvariable("X_Y", INT)],
  ["issue:k/2762", ksort("Bool"), String.raw`Lblpred1{}(\dv{SortInt{}}("3"))`, kapply("pred1", [intToken(3)])],
  ["cells-conversion", ksort("KCell"), "Lbl'-LT-'k'-GT-'{}(dotk{}())", kapply("<k>", [ksequence([])])],
  [
    "constrained-term",
    ksort("KCell"),
    String.raw`
        \and{SortKCell{}}(
            Lbl'-LT-'k'-GT-'{}(dotk{}()),
            VarX : SortKCell{}
        )
        `,
    kapply(klabel("#And", [ksort("KCell")]), [kapply("<k>", [ksequence([])]), kvariable("X", "KCell")]),
  ],
  [
    "ml-equals",
    ksort("GeneratedTopCell"),
    String.raw`
        \equals{SortBool{}, SortGeneratedTopCell{}}(
            VarX : SortBool{},
            \dv{SortBool{}}("true")
        )
        `,
    kapply(klabel("#Equals", [ksort("Bool"), ksort("GeneratedTopCell")]), [kvariable("X", "Bool"), TRUE]),
  ],
  [
    "ml-ceil",
    ksort("GeneratedTopCell"),
    String.raw`\ceil{SortBool{}, SortGeneratedTopCell{}}(VarX : SortBool{})`,
    kapply(klabel("#Ceil", [ksort("Bool"), ksort("GeneratedTopCell")]), [kvariable("X", "Bool")]),
  ],
  [
    "ml-exists",
    ksort("Bool"),
    String.raw`\exists{SortBool{}}(VarX : SortBool{}, VarX : SortBool{})`,
    kapply(klabel("#Exists", [ksort("Bool"), ksort("Bool")]), [kvariable("X", "Bool"), kvariable("X", "Bool")]),
  ],
  [
    "ml-not",
    ksort("Bool"),
    String.raw`\not{SortBool{}}(VarX : SortBool{})`,
    kapply(klabel("#Not", [ksort("Bool")]), [kvariable("X", "Bool")]),
  ],
  ["simple-injection", ksort("Foo"), "Lblfoo{}(inj{SortBaz{}, SortBar{}}(Lblbaz{}()))", kapply("foo", [kapply("baz")])],
  [
    "cells-conversion-kitem",
    ksort("KItem"),
    "inj{SortKCell{}, SortKItem{}}(Lbl'-LT-'k'-GT-'{}(dotk{}()))",
    kapply("<k>", [ksequence([])]),
  ],
  [
    "munging-problem",
    ksort("Baz"),
    String.raw`Lblfoo-bar'Unds'SIMPLE-PROOFS'Unds'Baz{}()`,
    kapply("foo-bar_SIMPLE-PROOFS_Baz", []),
  ],
  ["kseq-empty", ksort("K"), "dotk{}()", ksequence([])],
  [
    "kseq-singleton",
    ksort("K"),
    "kseq{}(inj{SortBaz{}, SortKItem{}}(Lblfoo-bar'Unds'SIMPLE-PROOFS'Unds'Baz{}()), dotk{}())",
    ksequence([kapply("foo-bar_SIMPLE-PROOFS_Baz")]),
  ],
  [
    "kseq-two-element",
    ksort("K"),
    `
        kseq{}(
            Lblfoo'Unds'SIMPLE-PROOFS'Unds'KItem{}(),
            kseq{}(
                inj{SortBaz{}, SortKItem{}}(Lblfoo-bar'Unds'SIMPLE-PROOFS'Unds'Baz{}()),
                dotk{}()
            )
        )
        `,
    ksequence([kapply("foo_SIMPLE-PROOFS_KItem"), kapply("foo-bar_SIMPLE-PROOFS_Baz")]),
  ],
  [
    "kseq-with-k-head",
    ksort("K"),
    String.raw`append{}(VarX : SortK{}, kseq{}(inj{SortInt{}, SortKItem{}}(\dv{SortInt{}}("1")), dotk{}()))`,
    ksequence([kvariable("X", "K"), intToken(1)]),
  ],
  [
    "kseq-with-k-middle",
    ksort("K"),
    String.raw`
        kseq{}(
            inj{SortInt{}, SortKItem{}}(\dv{SortInt{}}("1")),
            append{}(
                VarX : SortK{},
                kseq{}(
                    inj{SortInt{}, SortKItem{}}(\dv{SortInt{}}("2")),
                    dotk{}()
                )
            )
        )
        `,
    ksequence([intToken(1), kvariable("X", "K"), intToken(2)]),
  ],
  [
    "kseq-with-multiple-ks",
    ksort("K"),
    String.raw`
        kseq{}(
            inj{SortInt{}, SortKItem{}}(\dv{SortInt{}}("1")),
            append{}(
                VarX1 : SortK{},
                append{}(
                    VarX2 : SortK{},
                    append{}(
                        VarX3 : SortK{},
                        kseq{}(
                            inj{SortInt{}, SortKItem{}}(\dv{SortInt{}}("2")),
                            VarX4 : SortK{}
                        )
                    )
                )
            )
        )
        `,
    ksequence([
      intToken(1),
      kvariable("X1", "K"),
      kvariable("X2", "K"),
      kvariable("X3", "K"),
      intToken(2),
      kvariable("X4", "K"),
    ]),
  ],
  [
    "if-then-else",
    ksort("K"),
    String.raw`Lblite{SortK{}}(VarC : SortBool{}, VarB1 : SortK{}, VarB2 : SortK {})`,
    kapply(klabel("ite", [ksort("K")]), [kvariable("C", "Bool"), kvariable("B1", "K"), kvariable("B2", "K")]),
  ],
];

/** `KAST_TO_KORE_TEST_DATA` — `:282-550`, the 27 shared rows plus 20. */
const KAST_TO_KORE_TEST_DATA: readonly ConversionCase[] = [
  ...BIDIRECTIONAL_TEST_DATA,
  [
    "kitem-function-k-arg",
    ksort("Bool"),
    `
        Lbl'UndsEqlsEqls'K'Unds'{}(
          VarX:SortK{},
          VarY:SortK{},
        )
        `,
    kapply("_==K_", [kvariable("X", "K"), kvariable("Y", "K")]),
  ],
  [
    "kitem-function-k-arg-2",
    ksort("Bool"),
    `
        Lbl'UndsEqlsEqls'K'Unds'{}(
          VarX:SortK{},
          VarY:SortK{},
        )
        `,
    kapply("_==K_", [kvariable("X"), kvariable("Y")]),
  ],
  [
    "kitem-function",
    ksort("Foo"),
    `
        Lblabcd{}(kseq{}(
            VarX:SortKItem{},
            dotk{}()
        ))
        `,
    kapply("abcd", [kvariable("X", "KItem")]),
  ],
  [
    "equals-k-encoding",
    ksort("KItem"),
    String.raw`
        inj{SortBool{}, SortKItem{}}(
        Lbl'UndsEqlsEqls'K'Unds'{}(
          kseq{}(
            inj{SortInt{}, SortKItem{}}(VarX:SortInt{}),
            dotk{}()
          ),
          kseq{}(
            inj{SortInt{}, SortKItem{}}(\dv{SortInt{}}("0")),
            dotk{}()
          )
        ))
        `,
    kapply("_==K_", [kvariable("X", "Int"), ktoken("0", "Int")]),
  ],
  [
    "ksequence-under-kequal-not-reapplied",
    ksort("KItem"),
    String.raw`
        inj{SortBool{}, SortKItem{}}(
        Lbl'UndsEqlsEqls'K'Unds'{}(
          kseq{}(
            inj{SortInt{}, SortKItem{}}(VarX:SortInt{}),
            dotk{}()
          ),
          kseq{}(
            inj{SortInt{}, SortKItem{}}(\dv{SortInt{}}("0")),
            dotk{}()
          )
        ))
        `,
    kapply("_==K_", [ksequence([kvariable("X", "Int")]), ksequence([ktoken("0", "Int")])]),
  ],
  [
    "k-under-kequal",
    ksort("KItem"),
    `
        inj{SortBool{}, SortKItem{}}(
        Lbl'UndsEqlsEqls'K'Unds'{}(
            VarX:SortK{},
            VarY:SortK{},
        ))
        `,
    kapply("_==K_", [kvariable("X", "K"), kvariable("Y", "K")]),
  ],
  [
    "empty-ksequence-under-kequal",
    ksort("KItem"),
    `
        inj{SortBool{}, SortKItem{}}(
        Lbl'UndsEqlsEqls'K'Unds'{}(
            dotk{}(),
            dotk{}(),
        ))
        `,
    kapply("_==K_", [ksequence([]), ksequence([])]),
  ],
  [
    "multi-ksequence-under-kequal",
    ksort("KItem"),
    String.raw`
        inj{SortBool{}, SortKItem{}}(
        Lbl'UndsEqlsEqls'K'Unds'{}(
          kseq{}(
            inj{SortInt{}, SortKItem{}}(VarX:SortInt{}),
            kseq{}(
              inj{SortInt{}, SortKItem{}}(VarY:SortInt{}),
              dotk{}()
            )
          ),
          kseq{}(
            inj{SortInt{}, SortKItem{}}(\dv{SortInt{}}("0")),
            kseq{}(
              inj{SortInt{}, SortKItem{}}(\dv{SortInt{}}("1")),
              dotk{}()
            )
          )
        ))
        `,
    kapply("_==K_", [
      ksequence([kvariable("X", "Int"), kvariable("Y", "Int")]),
      ksequence([ktoken("0", "Int"), ktoken("1", "Int")]),
    ]),
  ],
  ["variable-without-sort", ksort("Bar"), "VarX : SortBar{}", kvariable("X")],
  [
    "variable-different-sorts",
    ksort("BarHolder"),
    `
        Lblbarholder{}(
            Lblfoo{}(inj{SortBaz{}, SortBar{}}(VarB : SortBaz{})),
            inj{SortBaz{}, SortBar{}}(VarB : SortBaz{})
        )
        `,
    kapply("barholder", [kapply("foo", [kvariable("B", ksort("Baz"))]), kvariable("B")]),
  ],
  [
    "variable-with-multi-sort",
    ksort("BarHolder"),
    "Lblbarholder2{}(inj{SortBaz{}, SortBar{}}(VarX : SortBaz{}), VarX : SortBaz{})",
    kapply("barholder2", [kvariable("X", ksort("Baz")), kvariable("X", ksort("Bar"))]),
  ],
  [
    "ml-exists-var-inference",
    ksort("Foo"),
    String.raw`\exists{SortFoo{}}(VarX : SortBar{}, Lblfoo{}(VarX : SortBar{}))`,
    kapply(klabel("#Exists", [ksort("Bar"), ksort("Foo")]), [kvariable("X"), kapply("foo", [kvariable("X")])]),
  ],
  [
    "ml-multiple-exists-var-inference",
    ksort("Foo"),
    String.raw`\and{SortFoo{}}(
          \exists{SortFoo{}}(VarX : SortK{}, \equals{SortK{}, SortFoo{}}(VarX : SortK{}, VarX:SortK{})),
          \exists{SortFoo{}}(VarX : SortBar{}, Lblfoo{}(VarX : SortBar{}))
        )`,
    kapply(klabel("#And", [ksort("Foo")]), [
      kapply(klabel("#Exists", [ksort("K"), ksort("Foo")]), [
        kvariable("X"),
        kapply(klabel("#Equals", [ksort("K"), ksort("Foo")]), [kvariable("X"), ksequence([kvariable("X")])]),
      ]),
      kapply(klabel("#Exists", [ksort("Bar"), ksort("Foo")]), [kvariable("X"), kapply("foo", [kvariable("X")])]),
    ]),
  ],
  ["ksequence-empty", ksort("K"), "dotk{}()", ksequence([])],
  ["ksequence-singleton-var", ksort("K"), "VarCONT : SortK{}", ksequence([kvariable("CONT")])],
  [
    "ksequence-duo-var-1",
    ksort("K"),
    "kseq{}(VarELEM : SortKItem{}, VarCONT : SortK{})",
    ksequence([kvariable("ELEM"), kvariable("CONT")]),
  ],
  [
    "ksequence-duo-var-2",
    ksort("K"),
    "kseq{}(VarELEM1 : SortKItem{}, kseq{}(VarELEM2 : SortKItem{}, dotk{}()))",
    ksequence([kvariable("ELEM1", ksort("KItem")), kvariable("ELEM2", ksort("KItem"))]),
  ],
  [
    "if-then-else-no-sort-param-k",
    ksort("K"),
    String.raw`Lblite{SortK{}}(VarC : SortBool{}, VarB1 : SortK{}, VarB2 : SortK {})`,
    kapply(klabel("ite", []), [
      kvariable("C", ksort("Bool")),
      kvariable("B1", ksort("K")),
      kvariable("B2", ksort("K")),
    ]),
  ],
  [
    "if-then-else-no-sort-param-int",
    INT,
    String.raw`
        Lbl'UndsPlus'Int'Unds'{}(
            VarA : SortInt{},
            Lblite{SortInt{}}(VarC : SortBool{}, VarI1 : SortInt{}, VarI2 : SortInt {})
        )
        `,
    kapply("_+Int_", [
      kvariable("A", ksort("Int")),
      kapply(klabel("ite", []), [
        kvariable("C", ksort("Bool")),
        kvariable("I1", ksort("Int")),
        kvariable("I2", ksort("Int")),
      ]),
    ]),
  ],
  [
    "if-then-else-no-sort-param-nested",
    INT,
    String.raw`
        Lblite{SortInt{}}(
            VarC1 : SortBool{},
            Lblite{SortInt{}}(
                VarC2 : SortBool{}, VarI1 : SortInt{} , VarI2 : SortInt{}
            ),
            VarI3 : SortInt{}
        )
        `,
    kapply(klabel("ite", []), [
      kvariable("C1", ksort("Bool")),
      kapply(klabel("ite", []), [
        kvariable("C2", ksort("Bool")),
        kvariable("I1", ksort("Int")),
        kvariable("I2", ksort("Int")),
      ]),
      kvariable("I3", ksort("Int")),
    ]),
  ],
];

/** `KORE_TO_KAST_TEST_DATA` — `:552-577`, the 27 shared rows plus 2. */
const KORE_TO_KAST_TEST_DATA: readonly ConversionCase[] = [
  ...BIDIRECTIONAL_TEST_DATA,
  [
    "left-assoc",
    ksort("Map"),
    String.raw`\left-assoc{}(Lbl'Unds'Map'Unds'{}(VarX : SortMap{}, VarY : SortMap{}, VarZ : SortMap{}))`,
    kapply("_Map_", [
      kapply("_Map_", [kvariable("X", ksort("Map")), kvariable("Y", ksort("Map"))]),
      kvariable("Z", ksort("Map")),
    ]),
  ],
  [
    "right-assoc",
    ksort("Map"),
    String.raw`\right-assoc{}(Lbl'Unds'Map'Unds'{}(VarX : SortMap{}, VarY : SortMap{}, VarZ : SortMap{}))`,
    kapply("_Map_", [
      kvariable("X", ksort("Map")),
      kapply("_Map_", [kvariable("Y", ksort("Map")), kvariable("Z", ksort("Map"))]),
    ]),
  ],
];

describe("kastToKore — 47 cases", () => {
  test("the table is 47 rows", () => {
    expect(KAST_TO_KORE_TEST_DATA.length).toBe(47);
  });

  for (const [id, sort, koreText_, kast] of KAST_TO_KORE_TEST_DATA) {
    test(id, () => {
      expect(kastToKore(DEFINITION, kast, { sort })).toEqual(parsePattern(koreText_));
    });
  }
});

describe("koreToKast — 29 cases", () => {
  test("the table is 29 rows", () => {
    expect(KORE_TO_KAST_TEST_DATA.length).toBe(29);
  });

  for (const [id, , koreText_, kast] of KORE_TO_KAST_TEST_DATA) {
    test(id, () => {
      expect(koreToKast(DEFINITION, parsePattern(koreText_))).toEqual(kast);
    });
  }
});

/**
 * `KRULE_TO_KORE_DATA` — `:579-628`.
 *
 * Each row is `[rule label, expected axiom text]`; the rule itself is looked up
 * in the definition's main module by that label, as `test_krule_to_kore:822-823`
 * does.  The comparison is on the **written** axiom, not the structure, because
 * that is what upstream compares — which makes it also a test of
 * `@kframework-ts/kore`'s writer.
 */
const KRULE_TO_KORE_DATA: readonly (readonly [string, string])[] = [
  [
    "SIMPLE-PROOFS.foo-to-bar",
    String.raw`axiom{} \rewrites{SortGeneratedTopCell{}}(\and{SortGeneratedTopCell{}}(Lbl'-LT-'generatedTop'-GT-'{}(Lbl'-LT-'k'-GT-'{}(kseq{}(Lblfoo'Unds'SIMPLE-PROOFS'Unds'KItem{}(), Var'Unds'DotVar1 : SortK{})), Lbl'-LT-'state'-GT-'{}(Lbl'Unds'Map'Unds'{}(Lbl'UndsPipe'-'-GT-Unds'{}(inj{SortInt{}, SortKItem{}}(\dv{SortInt{}}("3")), inj{SortInt{}, SortKItem{}}(VarN : SortInt{})), Var'Unds'DotVar2 : SortMap{})), Var'Unds'DotVar0 : SortGeneratedCounterCell{}), \equals{SortBool{}, SortGeneratedTopCell{}}(\dv{SortBool{}}("true"), Lblpred1{}(VarN : SortInt{}))), Lbl'-LT-'generatedTop'-GT-'{}(Lbl'-LT-'k'-GT-'{}(kseq{}(Lblbar'Unds'SIMPLE-PROOFS'Unds'KItem{}(), Var'Unds'DotVar1 : SortK{})), Lbl'-LT-'state'-GT-'{}(Lbl'Unds'Map'Unds'{}(Lbl'UndsPipe'-'-GT-Unds'{}(inj{SortInt{}, SortKItem{}}(\dv{SortInt{}}("3")), inj{SortInt{}, SortKItem{}}(VarN : SortInt{})), Var'Unds'DotVar2 : SortMap{})), Var'Unds'DotVar0 : SortGeneratedCounterCell{})) [label{}("SIMPLE-PROOFS.foo-to-bar"), priority{}("50")]`,
  ],
  [
    "SIMPLE-PROOFS.foo-to-bar-false",
    String.raw`axiom{} \rewrites{SortGeneratedTopCell{}}(\and{SortGeneratedTopCell{}}(Lbl'-LT-'generatedTop'-GT-'{}(Lbl'-LT-'k'-GT-'{}(kseq{}(Lblfoo'Unds'SIMPLE-PROOFS'Unds'KItem{}(), Var'Unds'RestK : SortK{})), Lbl'-LT-'state'-GT-'{}(Lbl'Unds'Map'Unds'{}(Lbl'UndsPipe'-'-GT-Unds'{}(inj{SortInt{}, SortKItem{}}(\dv{SortInt{}}("3")), inj{SortInt{}, SortKItem{}}(VarN : SortInt{})), Var'Unds'RestState : SortMap{})), Var'Unds'DotVar0 : SortGeneratedCounterCell{}), \and{SortGeneratedTopCell{}}(\equals{SortBool{}, SortGeneratedTopCell{}}(\dv{SortBool{}}("true"), Lblpred1{}(VarN : SortInt{})), \bottom{SortGeneratedTopCell{}}())), Lbl'-LT-'generatedTop'-GT-'{}(Lbl'-LT-'k'-GT-'{}(kseq{}(Lblbar'Unds'SIMPLE-PROOFS'Unds'KItem{}(), Var'Unds'RestK : SortK{})), Lbl'-LT-'state'-GT-'{}(Lbl'Unds'Map'Unds'{}(Lbl'UndsPipe'-'-GT-Unds'{}(inj{SortInt{}, SortKItem{}}(\dv{SortInt{}}("3")), inj{SortInt{}, SortKItem{}}(VarN : SortInt{})), Var'Unds'RestState : SortMap{})), Var'Unds'DotVar0 : SortGeneratedCounterCell{})) [label{}("SIMPLE-PROOFS.foo-to-bar-false"), priority{}("30")]`,
  ],
  [
    "SIMPLE-PROOFS.foo-to-baz-owise",
    String.raw`axiom{} \rewrites{SortGeneratedTopCell{}}(\and{SortGeneratedTopCell{}}(Lbl'-LT-'generatedTop'-GT-'{}(Lbl'-LT-'k'-GT-'{}(kseq{}(Lblfoo'Unds'SIMPLE-PROOFS'Unds'KItem{}(), kseq{}(Lblfoo'Unds'SIMPLE-PROOFS'Unds'KItem{}(), kseq{}(Lblfoo'Unds'SIMPLE-PROOFS'Unds'KItem{}(), Var'Unds'DotVar1 : SortK{})))), Var'Unds'Gen0 : SortStateCell{}, Var'Unds'Gen1 : SortGeneratedCounterCell{}), \top{SortGeneratedTopCell{}}()), Lbl'-LT-'generatedTop'-GT-'{}(Lbl'-LT-'k'-GT-'{}(kseq{}(inj{SortBaz{}, SortKItem{}}(Lblbaz{}()), kseq{}(Lblfoo'Unds'SIMPLE-PROOFS'Unds'KItem{}(), kseq{}(Lblfoo'Unds'SIMPLE-PROOFS'Unds'KItem{}(), Var'Unds'DotVar1 : SortK{})))), Var'Unds'Gen0 : SortStateCell{}, Var'Unds'Gen1 : SortGeneratedCounterCell{})) [label{}("SIMPLE-PROOFS.foo-to-baz-owise"), priority{}("200")]`,
  ],
  [
    "SIMPLE-PROOFS.simple-func",
    String.raw`axiom{R} \implies{R}(\equals{SortBool{}, R}(\dv{SortBool{}}("true"), \dv{SortBool{}}("true")), \equals{SortInt{}, R}(LblsimpleFunc{}(), \and{SortInt{}}(\dv{SortInt{}}("3"), \top{SortInt{}}()))) [label{}("SIMPLE-PROOFS.simple-func"), priority{}("50")]`,
  ],
  [
    "SIMPLE-PROOFS.simple-func-req-1",
    String.raw`axiom{R} \implies{R}(\equals{SortBool{}, R}(Lbl'Unds-LT-Eqls'Int'Unds'{}(VarX : SortInt{}, \dv{SortInt{}}("0")), \dv{SortBool{}}("true")), \equals{SortInt{}, R}(LblleqZero{}(VarX : SortInt{}), \and{SortInt{}}(\dv{SortInt{}}("0"), \top{SortInt{}}()))) [label{}("SIMPLE-PROOFS.simple-func-req-1"), priority{}("50")]`,
  ],
  [
    "SIMPLE-PROOFS.simple-func-simplification",
    String.raw`axiom{R} \implies{R}(\equals{SortBool{}, R}(Lbl'Unds-LT-'Int'Unds'{}(\dv{SortInt{}}("0"), VarX : SortInt{}), \dv{SortBool{}}("true")), \equals{SortInt{}, R}(LblleqZero{}(VarX : SortInt{}), \and{SortInt{}}(\dv{SortInt{}}("1"), \top{SortInt{}}()))) [label{}("SIMPLE-PROOFS.simple-func-simplification"), simplification{}("")]`,
  ],
  [
    "SIMPLE-PROOFS.simple-func-simplification-prio",
    String.raw`axiom{R} \implies{R}(\equals{SortBool{}, R}(Lbl'Unds-LT-'Int'Unds'{}(\dv{SortInt{}}("0"), VarX : SortInt{}), \dv{SortBool{}}("true")), \equals{SortInt{}, R}(LblleqZero{}(VarX : SortInt{}), \and{SortInt{}}(\dv{SortInt{}}("1"), \top{SortInt{}}()))) [label{}("SIMPLE-PROOFS.simple-func-simplification-prio"), simplification{}("38")]`,
  ],
  [
    "SIMPLE-PROOFS.simple-func-simplification-concrete-noarg",
    String.raw`axiom{R} \implies{R}(\equals{SortBool{}, R}(Lbl'Unds-LT-'Int'Unds'{}(\dv{SortInt{}}("0"), VarX : SortInt{}), \dv{SortBool{}}("true")), \equals{SortInt{}, R}(LblleqZero{}(VarX : SortInt{}), \and{SortInt{}}(\dv{SortInt{}}("1"), \top{SortInt{}}()))) [concrete{}(), label{}("SIMPLE-PROOFS.simple-func-simplification-concrete-noarg"), simplification{}("")]`,
  ],
  [
    "SIMPLE-PROOFS.simple-func-simplification-concrete",
    String.raw`axiom{R} \implies{R}(\equals{SortBool{}, R}(Lbl'Unds-LT-'Int'Unds'{}(\dv{SortInt{}}("0"), VarX : SortInt{}), \dv{SortBool{}}("true")), \equals{SortInt{}, R}(LblleqZero{}(VarX : SortInt{}), \and{SortInt{}}(\dv{SortInt{}}("1"), \top{SortInt{}}()))) [concrete{}(VarX : SortInt{}), label{}("SIMPLE-PROOFS.simple-func-simplification-concrete"), simplification{}("")]`,
  ],
  [
    "SIMPLE-PROOFS.simple-func-simplification-symbolic",
    String.raw`axiom{R} \implies{R}(\equals{SortBool{}, R}(Lbl'Unds-LT-'Int'Unds'{}(\dv{SortInt{}}("0"), VarX : SortInt{}), \dv{SortBool{}}("true")), \equals{SortInt{}, R}(LblleqZero{}(VarX : SortInt{}), \and{SortInt{}}(\dv{SortInt{}}("1"), \top{SortInt{}}()))) [label{}("SIMPLE-PROOFS.simple-func-simplification-symbolic"), simplification{}(""), symbolic{}(VarX : SortInt{})]`,
  ],
  [
    "SIMPLE-PROOFS.simple-func-simplification-symbolic-2vars",
    String.raw`axiom{R} \implies{R}(\equals{SortBool{}, R}(Lbl'Unds-LT-'Int'Unds'{}(\dv{SortInt{}}("0"), VarX : SortInt{}), \dv{SortBool{}}("true")), \equals{SortInt{}, R}(Lblleq{}(VarX : SortInt{}, Var'Unds'Y : SortInt{}), \and{SortInt{}}(\dv{SortInt{}}("1"), \top{SortInt{}}()))) [label{}("SIMPLE-PROOFS.simple-func-simplification-symbolic-2vars"), simplification{}(""), symbolic{}(VarX : SortInt{}, Var'Unds'Y : SortInt{})]`,
  ],
  [
    "SIMPLE-PROOFS.simple-func-simplification-smt-lemma",
    String.raw`axiom{R} \implies{R}(\equals{SortBool{}, R}(\dv{SortBool{}}("true"), \dv{SortBool{}}("true")), \equals{SortBool{}, R}(Lbl'UndsEqlsEqls'Int'Unds'{}(Lblleq{}(Var'Unds'Gen0 : SortInt{}, Var'Unds'Gen1 : SortInt{}), \dv{SortInt{}}("0")), \and{SortBool{}}(\dv{SortBool{}}("false"), \top{SortBool{}}()))) [label{}("SIMPLE-PROOFS.simple-func-simplification-smt-lemma"), simplification{}(""), smt-lemma{}()]`,
  ],
];

function ruleLabelled(definition: KDefinition, label: string): KRule {
  const found = moduleRules(definition.module(definition.mainModuleName)).filter(
    (rule) => rule.att.get(Atts.LABEL) === label,
  );
  const rule = found[0];
  if (found.length !== 1 || rule === undefined) {
    throw new Error(`Expected exactly one rule labelled ${label}, found ${found.length}`);
  }
  return rule;
}

describe("kruleToKore — 12 cases", () => {
  test("the table is 12 rows", () => {
    expect(KRULE_TO_KORE_DATA.length).toBe(12);
  });

  for (const [label, expected] of KRULE_TO_KORE_DATA) {
    test(label, () => {
      expect(koreText(kruleToKore(DEFINITION, ruleLabelled(DEFINITION, label)))).toBe(expected);
    });
  }
});

/**
 * `KRULE_TO_KORE_EXPLICIT_DATA` — `:630-662`.
 *
 * A rule built in the test rather than read from the definition, whose point is
 * the unsorted `V` in `requires`: sort inference has to reach into the
 * requires clause, which is why `kruleToKore` runs it once over a synthetic
 * `KRewrite` of the whole rule rather than per side.
 */
test("kruleToKore — unsorted variable in requires", () => {
  const rule = krule(
    krewrite(
      kapply("<generatedTop>", [
        kapply("<k>", [ksequence([kapply("pred1", [kvariable("U", INT)])])]),
        kapply("<state>", [kapply(".Map", [])]),
        kvariable("Counter", ksort("GeneratedCounterCell")),
      ]),
      kapply("<generatedTop>", [
        kapply("<k>", [ksequence([])]),
        kapply("<state>", [kapply(".Map", [])]),
        kvariable("Counter", ksort("GeneratedCounterCell")),
      ]),
    ),
    {
      requires: kapply(klabel("#And", [BOOL]), [
        TRUE,
        kapply(klabel("#Equals", [BOOL, BOOL]), [TRUE, kapply("pred1", [kvariable("V")])]),
      ]),
    },
  );

  expect(koreText(kruleToKore(DEFINITION, rule))).toBe(
    String.raw`axiom{} \rewrites{SortGeneratedTopCell{}}(\and{SortGeneratedTopCell{}}(Lbl'-LT-'generatedTop'-GT-'{}(Lbl'-LT-'k'-GT-'{}(kseq{}(inj{SortBool{}, SortKItem{}}(Lblpred1{}(VarU : SortInt{})), dotk{}())), Lbl'-LT-'state'-GT-'{}(Lbl'Stop'Map{}()), VarCounter : SortGeneratedCounterCell{}), \equals{SortBool{}, SortGeneratedTopCell{}}(\dv{SortBool{}}("true"), \and{SortBool{}}(\dv{SortBool{}}("true"), \equals{SortBool{}, SortBool{}}(\dv{SortBool{}}("true"), Lblpred1{}(VarV : SortInt{}))))), Lbl'-LT-'generatedTop'-GT-'{}(Lbl'-LT-'k'-GT-'{}(dotk{}()), Lbl'-LT-'state'-GT-'{}(Lbl'Stop'Map{}()), VarCounter : SortGeneratedCounterCell{})) [priority{}("50")]`,
  );
});

/**
 * `SORT_TERM_DATA` — `:664-731`.
 *
 * This is `KDefinition.sort`'s table, not `konvert`'s, and
 * `@kframework-ts/kast` already covers it against a synthetic definition
 * (`packages/kast/test/outer.test.ts`).  It is repeated here against the
 * **real** `simple-proofs` definition, which is what upstream runs it against —
 * a synthetic subsort lattice cannot exercise `KItem`'s real position in K's
 * builtin one.
 */
const SORT_TERM_DATA: readonly (readonly [string, KInner, string])[] = [
  ["variable-int", kvariable("X", "Int"), "Int"],
  ["variable-bool", kvariable("X", "Bool"), "Bool"],
  ["variable-k", kvariable("X", "K"), "K"],
  ["variable-kitem", kvariable("X", "KItem"), "KItem"],
  ["int-token", intToken(1), "Int"],
  ["bool-token", ktoken("true", "Bool"), "Bool"],
  ["ksequence", ksequence([intToken(0), intToken(1), intToken(2)]), "K"],
  ["krewrite-same-sort", krewrite(intToken(0), intToken(1)), "Int"],
  ["krewrite-direct-supersort-lhs", krewrite(intToken(0), kvariable("X", "KItem")), "KItem"],
  ["krewrite-direct-supersort-rhs", krewrite(kvariable("X", "KItem"), intToken(0)), "KItem"],
  [
    "sort-parametric-int",
    kapply(klabel("ite", [ksort("Int")]), [ktoken("true", "Bool"), intToken(1), intToken(2)]),
    "Int",
  ],
  [
    "sort-parametric-bool",
    kapply(klabel("ite", [ksort("Bool")]), [ktoken("true", "Bool"), ktoken("true", "Bool"), ktoken("false", "Bool")]),
    "Bool",
  ],
];

describe("sortOf — 12 cases against the real definition", () => {
  test("the table is 12 rows", () => {
    expect(SORT_TERM_DATA.length).toBe(12);
  });

  for (const [id, kast, expected] of SORT_TERM_DATA) {
    test(id, () => {
      expect(DEFINITION.sortOf(kast)?.name).toBe(expected);
    });
  }
});

/**
 * The `PROVENANCE.md` caveat, discharged.
 *
 * pyk's `KompiledTest` leaves `KOMPILE_BACKEND = None`, which
 * `Kompile.from_dict` reads as **llvm** (`ktool/kompile.py:243`), so the
 * definition these 100 upstream cases actually run against is the llvm build —
 * and the two builds' module sets genuinely differ (67 modules vs 60). Every
 * `kastToKore` and `koreToKast` case is therefore replayed against
 * `simple-proofs.llvm.compiled.json` as well. They agree, which is what makes
 * the haskell fixture safe to use as the primary.
 */
describe("the llvm build agrees with the haskell build", () => {
  const LLVM = loadDefinition("simple-proofs.llvm.compiled.json");

  test("the two builds are not the same definition", () => {
    expect(LLVM.allModules.length).not.toBe(DEFINITION.allModules.length);
  });

  for (const [id, sort, , kast] of KAST_TO_KORE_TEST_DATA) {
    test(`kastToKore ${id}`, () => {
      expect(kastToKore(LLVM, kast, { sort })).toEqual(kastToKore(DEFINITION, kast, { sort }));
    });
  }

  for (const [id, , koreText_] of KORE_TO_KAST_TEST_DATA) {
    test(`koreToKast ${id}`, () => {
      const kore = parsePattern(koreText_);
      expect(koreToKast(LLVM, kore)).toEqual(koreToKast(DEFINITION, kore));
    });
  }
});
