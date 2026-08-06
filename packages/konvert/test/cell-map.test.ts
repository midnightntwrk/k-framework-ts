/**
 * Corpus #6 — `test_cell_map.py`, the cell-collection encoding.
 *
 * Transcribed from `k/pyk/src/tests/integration/konvert/test_cell_map.py` at K
 * v7.1.337: 3 `kast_to_kore` cases and 3 `kore_to_kast` cases over
 * `cell-map.k`, vendored as `fixtures/definitions/cell-map.compiled.json` (see
 * `fixtures/PROVENANCE.md`; `test_cell_map.py` passes no extra kompile args).
 *
 * The one row that matters is `account-cell-map`, and it is the only test in
 * either suite that exercises `addCellMapItems` / `removeCellMapItems`.  The
 * KAST side spells the collection as `_AccountCellMap_(<account>(…), …)`; the
 * KORE side spells it as `_AccountCellMap_(AccountCellMapItem(<id>(…),
 * <account>(…)), …)` — the key is **hoisted out of the element and duplicated
 * beside it**.  Neither direction is derivable from the term alone: the
 * definition's `cellMapItemInfo` is what says which cell is the key.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  type KDefinition,
  type KInner,
  type KSort,
  kapply,
  ksort,
  kvariable,
  readKastDefinitionFromJson,
} from "@kframework-ts/kast";
import { INT, intToken } from "@kframework-ts/kast/prelude/kint";
import { parsePattern } from "@kframework-ts/kore";

import { kastToKore, koreToKast } from "../src/convert.ts";

const FIXTURES = join(import.meta.dir, "..", "fixtures", "definitions");

function loadDefinition(name: string): KDefinition {
  return readKastDefinitionFromJson(readFileSync(join(FIXTURES, name), "utf8"));
}

const DEFINITION = loadDefinition("cell-map.compiled.json");

type ConversionCase = readonly [string, KSort, string, KInner];

/** `BIDIRECTIONAL_TEST_DATA` — `test_cell_map.py:22-59`. */
const BIDIRECTIONAL_TEST_DATA: readonly ConversionCase[] = [
  ["domain-value-int", INT, String.raw`\dv{SortInt{}}("3")`, intToken(3)],
  [
    "account-cell-map",
    ksort("AccountsCell"),
    String.raw`
        Lbl'-LT-'accounts'-GT-'{}(
            Lbl'Unds'AccountCellMap'Unds'{}(
                LblAccountCellMapItem{}(
                    Lbl'-LT-'id'-GT-'{}(\dv{SortInt{}}("3")),
                    Lbl'-LT-'account'-GT-'{}(
                        Lbl'-LT-'id'-GT-'{}(\dv{SortInt{}}("3")),
                        Lbl'-LT-'balance'-GT-'{}(\dv{SortInt{}}("0"))
                    )
                ),
                Var'Unds'DotVar2 : SortAccountCellMap{}
            )
        )
        `,
    kapply("<accounts>", [
      kapply("_AccountCellMap_", [
        kapply("<account>", [kapply("<id>", [intToken(3)]), kapply("<balance>", [intToken(0)])]),
        kvariable("_DotVar2", ksort("AccountCellMap")),
      ]),
    ]),
  ],
];

/** `KAST_TO_KORE_TEST_DATA` — `:61-68`. */
const KAST_TO_KORE_TEST_DATA: readonly ConversionCase[] = [
  ...BIDIRECTIONAL_TEST_DATA,
  ["variable-without-sort", ksort("Bar"), "VarX : SortBar{}", kvariable("X")],
];

/** `KORE_TO_KAST_TEST_DATA` — `:70-91`. */
const KORE_TO_KAST_TEST_DATA: readonly ConversionCase[] = [
  ...BIDIRECTIONAL_TEST_DATA,
  [
    "left-assoc",
    ksort("Map"),
    String.raw`
        \left-assoc{}(
            Lbl'Unds'Map'Unds'{}(
                VarX : SortMap{},
                VarY : SortMap{},
                VarZ : SortMap{},
            )
        )
        `,
    kapply("_Map_", [
      kapply("_Map_", [kvariable("X", ksort("Map")), kvariable("Y", ksort("Map"))]),
      kvariable("Z", ksort("Map")),
    ]),
  ],
];

describe("kastToKore — 3 cases", () => {
  for (const [id, sort, koreText_, kast] of KAST_TO_KORE_TEST_DATA) {
    test(id, () => {
      expect(kastToKore(DEFINITION, kast, { sort })).toEqual(parsePattern(koreText_));
    });
  }
});

describe("koreToKast — 3 cases", () => {
  for (const [id, , koreText_, kast] of KORE_TO_KAST_TEST_DATA) {
    test(id, () => {
      expect(koreToKast(DEFINITION, parsePattern(koreText_))).toEqual(kast);
    });
  }
});

/** The `PROVENANCE.md` caveat again — see `simple-proofs.test.ts`. */
describe("the llvm build agrees with the haskell build", () => {
  const LLVM = loadDefinition("cell-map.llvm.compiled.json");

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
