/**
 * `src/formatter.ts` — the `format`-driven printer and its bracket insertion.
 *
 * # Provenance
 *
 * Upstream's suite is `pyk/src/tests/integration/kast/test_formatter.py`, and
 * it is an **integration** test: both of its classes are `KompiledTest`s that
 * run `kompile` and read the resulting `compiled.json`.  The terms and the
 * expected strings below are upstream's, unchanged; the definitions they run
 * against differ in provenance, one per table:
 *
 * - `FORMATTER_TEST_DATA` (`test_formatter.py:29-94`), all 3 rows, against the
 *   **real** `packages/kompiled/fixtures/generated/imp-llvm-kompiled/
 *   compiled.json` — `kompile imp.k --backend llvm --emit-json` at K
 *   `v7.1.337` on upstream's own `k-files/imp.k`
 *   (`packages/kompiled/fixtures/PROVENANCE.md`).  `llvm` because that is what
 *   `KompiledTest` produces when a test does not set `KOMPILE_BACKEND`, which
 *   `TestFormatter` does not (`_kompiler.py:102`, `kompile.py:243`); all 3
 *   rows also pass against the sibling `imp-haskell-kompiled` build.
 * - `BRACKETS_TEST_DATA` (`test_formatter.py:105-127`), all 13 rows, still
 *   against a **hand-built** transcription of that test's own inline
 *   `KOMPILE_DEFINITION` (`:131-142`).  `TestBrackets` kompiles a string
 *   literal rather than a file in `k-files/`, so there is no upstream `.k` to
 *   vendor and no `*-kompiled` fixture in this repo to point at.
 *
 * Every `format` attribute in the `BRACKETS` transcription is therefore either
 * written verbatim in that module, copied from a real `compiled.json`, or
 * absent so that {@link productionDefaultFormat} supplies it — the two cases
 * `kompile` itself produces.  In particular:
 *
 * - The generated cell format is `%1%i%n%2…%d%n%N`
 *   (`GenerateSentencesFromConfigDecl.java:409-417`).
 * - A `bracket` production gets **no** `format` from `kompile` unless the
 *   source writes one, so the default `%1 %2 %3` applies — which is why
 *   upstream expects `( 1 + 2 )` with spaces.
 *
 * The same points hold for `imp.k` and are now simply *observed* rather than
 * asserted: the real fixture is where `<generatedTop>`'s `format(%2)` comes
 * from, which is why upstream's third expectation starts at `<T>` and never
 * shows the counter.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Atts, EMPTY_ATT, KAtt, attEntry, parseFormat } from "../src/att.ts";
import { DEFAULT_BRACKET, DEFAULT_BRACKET_LABEL, Formatter, addBrackets } from "../src/formatter.ts";
import { kapply, klabel, ksequence, ksort, ktoken, kvariable, type KInner } from "../src/inner.ts";
import {
  KAssoc,
  KDefinition,
  kflatmodule,
  knonterminal,
  kproduction,
  ksyntaxassociativity,
  ksyntaxpriority,
  kterminal,
  readKastDefinitionFromJson,
  type KProduction,
  type KProductionItem,
} from "../src/outer.ts";
import { K } from "../src/prelude/k.ts";
import { INT, intToken } from "../src/prelude/kint.ts";

const NT = knonterminal;
const T = kterminal;

function symbol(
  sort: string,
  label: string,
  items: readonly KProductionItem[],
  format?: string,
  att: KAtt = EMPTY_ATT,
): KProduction {
  return kproduction(sort, {
    items,
    klabel: klabel(label),
    att: format === undefined ? att : new KAtt([...att, attEntry(Atts.FORMAT, parseFormat(format))]),
  });
}

/** `syntax Sort ::= "(" Sort ")" [bracket, bracketLabel(...)]`, format-less. */
function bracket(sort: string, label: string): KProduction {
  return kproduction(sort, {
    items: [T("("), NT(ksort(sort)), T(")")],
    att: new KAtt([
      attEntry(Atts.BRACKET, null),
      attEntry(Atts.BRACKET_LABEL, { node: "KLabel", name: label, params: [] }),
    ]),
  });
}

//////////////////////////////////////////////////////////
// `test_formatter.py:131-142` — module BRACKETS         //
//////////////////////////////////////////////////////////

/**
 * ```k
 * module BRACKETS
 *   imports INT
 *   syntax Exp ::= Int
 *                | sgn ( Exp ) [symbol(sgn(_))]
 *                > Exp "*" Exp [symbol(_*_), left]
 *                | Exp "/" Exp [symbol(_/_), left]
 *                > Exp "+" Exp [symbol(_+_), left]
 *                | Exp "-" Exp [symbol(_-_), left]
 *                > "(" Exp ")" [bracket]
 * endmodule
 * ```
 *
 * plus the `INT` productions the `_*Int_` / `_+Int_` row reaches for, whose
 * shapes are copied from a real `compiled.json`: items `Int "+Int" Int`, no
 * `format`, `left`, and `*Int` above `+Int` in priority.  `Int` declares no
 * bracket production of its own, so that row exercises
 * {@link DEFAULT_BRACKET}; `Exp` declares one, so the rest exercise the
 * definition's.
 */
const EXP = ksort("Exp");
const BRACKETS = new KDefinition("BRACKETS", [
  kflatmodule("BRACKETS", {
    sentences: [
      kproduction(EXP, { items: [NT(INT)] }),
      symbol("Exp", "sgn(_)", [T("sgn"), T("("), NT(EXP), T(")")]),
      symbol("Exp", "_*_", [NT(EXP), T("*"), NT(EXP)]),
      symbol("Exp", "_/_", [NT(EXP), T("/"), NT(EXP)]),
      symbol("Exp", "_+_", [NT(EXP), T("+"), NT(EXP)]),
      symbol("Exp", "_-_", [NT(EXP), T("-"), NT(EXP)]),
      bracket("Exp", "(_)_BRACKETS_Exp_Exp"),
      symbol("Int", "_*Int_", [NT(INT), T("*Int"), NT(INT)]),
      symbol("Int", "_+Int_", [NT(INT), T("+Int"), NT(INT)]),
      symbol("KItem", "<k>", [T("<k>"), NT(K), T("</k>")], "%1%i%n%2%d%n%3"),
      ksyntaxpriority([["sgn(_)"], ["_*_", "_/_"], ["_+_", "_-_"]]),
      ksyntaxpriority([["_*Int_"], ["_+Int_"]]),
      ksyntaxassociativity(KAssoc.LEFT, { tags: ["_*_", "_/_"] }),
      ksyntaxassociativity(KAssoc.LEFT, { tags: ["_+_", "_-_"] }),
      ksyntaxassociativity(KAssoc.LEFT, { tags: ["_*Int_"] }),
      ksyntaxassociativity(KAssoc.LEFT, { tags: ["_+Int_"] }),
    ],
  }),
]);

const plus = (a: KInner, b: KInner): KInner => kapply("_+_", [a, b]);
const minus = (a: KInner, b: KInner): KInner => kapply("_-_", [a, b]);
const times = (a: KInner, b: KInner): KInner => kapply("_*_", [a, b]);

/** `BRACKETS_TEST_DATA` (`test_formatter.py:105-127`), 13 rows. */
const BRACKETS_TEST_DATA: readonly (readonly [KInner, string])[] = [
  [intToken(1), "1"],
  [plus(intToken(1), intToken(2)), "1 + 2"],
  [plus(plus(intToken(1), intToken(2)), intToken(3)), "1 + 2 + 3"],
  [plus(minus(intToken(1), intToken(2)), intToken(3)), "1 - 2 + 3"],
  [plus(intToken(1), plus(intToken(2), intToken(3))), "1 + ( 2 + 3 )"],
  [plus(intToken(1), times(intToken(2), intToken(3))), "1 + 2 * 3"],
  [plus(times(intToken(1), intToken(2)), intToken(3)), "1 * 2 + 3"],
  [times(intToken(1), plus(intToken(2), intToken(3))), "1 * ( 2 + 3 )"],
  [times(plus(intToken(1), intToken(2)), intToken(3)), "( 1 + 2 ) * 3"],
  [kapply("_*Int_", [kapply("_+Int_", [intToken(1), intToken(2)]), intToken(3)]), "( 1 +Int 2 ) *Int 3"],
  [kapply("sgn(_)", [plus(intToken(1), intToken(2))]), "sgn ( 1 + 2 )"],
  [
    kapply("<k>", [ksequence([times(plus(intToken(1), intToken(2)), intToken(3))])]),
    "<k>\n  ( 1 + 2 ) * 3 ~> .K\n</k>",
  ],
];

describe("BRACKETS_TEST_DATA (test_formatter.py:105)", () => {
  for (const [i, [term, expected]] of BRACKETS_TEST_DATA.entries()) {
    test(`${i}`, () => {
      expect(new Formatter(BRACKETS).format(term)).toBe(expected);
    });
  }
});

//////////////////////////////////////////////////////////
// `k-files/imp.k`, really kompiled                      //
//////////////////////////////////////////////////////////

/**
 * The whole of `imp.k` as `kompile` emits it — every production the
 * `FORMATTER_TEST_DATA` rows touch (`imp.k:7-31` and the `configuration` at
 * `:48-51`) with the `format` attributes `kompile` actually attached, plus the
 * cells it generated: `<T>`, `<generatedCounter>` and the `format(%2)` on
 * `<generatedTop>` that keeps the counter out of the third expectation.
 */
const IMP = readKastDefinitionFromJson(
  readFileSync(
    join(import.meta.dir, "..", "..", "kompiled", "fixtures", "generated", "imp-llvm-kompiled", "compiled.json"),
    "utf8",
  ),
);

const ID = ksort("Id");
const x = ktoken("x", ID);
const y = ktoken("y", ID);

/** `FORMATTER_TEST_DATA` (`test_formatter.py:29-94`), 3 rows. */
const FORMATTER_TEST_DATA: readonly (readonly [KInner, string])[] = [
  [kapply("<k>", [ksequence([])]), "<k>\n  .K\n</k>"],
  [kapply("<k>", [ksequence([kvariable("X")])]), "<k>\n  X ~> .K\n</k>"],
  [
    kapply("<generatedTop>", [
      kapply("<T>", [
        kapply("<k>", [
          ksequence([
            kapply("while(_)_", [
              ktoken("true", "Bool"),
              kapply("{_}", [
                kapply("__", [
                  kapply("_=_;", [x, kapply("_+_", [x, intToken(1)])]),
                  kapply("_=_;", [y, kapply("_-_", [y, intToken(1)])]),
                ]),
              ]),
            ]),
          ]),
        ]),
        kapply("<state>", [kapply("_Map_", [kapply("_|->_", [x, intToken(0)]), kapply("_|->_", [y, intToken(0)])])]),
      ]),
      kapply("<generatedCounter>", [intToken(0)]),
    ]),
    [
      "<T>",
      "  <k>",
      "    while (true) {",
      "      x = x + 1;",
      "      y = y - 1;",
      "    } ~> .K",
      "  </k>",
      "  <state>",
      "    x |-> 0",
      "    y |-> 0",
      "  </state>",
      "</T>",
    ].join("\n"),
  ],
];

describe("FORMATTER_TEST_DATA (test_formatter.py:29)", () => {
  for (const [i, [term, expected]] of FORMATTER_TEST_DATA.entries()) {
    test(`${i}`, () => {
      expect(new Formatter(IMP).format(term)).toBe(expected);
    });
  }
});

//////////////////////////////
// Behaviour with no table  //
//////////////////////////////

describe("Formatter options", () => {
  test("brackets: false skips addBrackets entirely (formatter.py:75-76)", () => {
    const term = times(plus(intToken(1), intToken(2)), intToken(3));
    expect(new Formatter(BRACKETS, { brackets: false }).format(term)).toBe("1 + 2 * 3");
  });

  test("indent seeds the level every %n then honours (formatter.py:68)", () => {
    const term = kapply("<k>", [ksequence([])]);
    expect(new Formatter(BRACKETS, { indent: 2 }).format(term)).toBe("<k>\n      .K\n    </k>");
  });

  test("the indent level is instance state and returns to where it started", () => {
    const formatter = new Formatter(BRACKETS);
    formatter.format(kapply("<k>", [ksequence([])]));
    expect(formatter.indent).toBe(0);
  });
});

describe("format escapes (formatter.py:113-160)", () => {
  const one = (format: string, items: readonly KProductionItem[], args: readonly KInner[] = []): string => {
    const defn = new KDefinition("E", [kflatmodule("E", { sentences: [symbol("Exp", "e", items, format)] })]);
    return new Formatter(defn, { brackets: false }).format(kapply("e", args));
  };

  test("%N indexes items, terminals included — not arguments", () => {
    expect(one("%2 %1 %3", [T("a"), NT(EXP), T("c")], [intToken(1)])).toBe("1 a c");
  });

  test("literal text between escapes is preserved", () => {
    expect(one("<%1>", [T("a")])).toBe("<a>");
  });

  test("%% prints a percent (the `case _: return escape` branch)", () => {
    expect(one("%%%1", [T("a")])).toBe("%a");
  });

  test("%c and %r are dropped, not printed (formatter.py:138)", () => {
    // Java prints a literal `c`/`r` here (`Formatter.java:124`); pyk drops
    // them, and so do we.
    expect(one("%c%1%r", [T("a")])).toBe("a");
  });

  test("%i / %d move the indent and %n emits it eagerly", () => {
    // The trailing spaces after the second `%n` are pyk's eager indentation
    // (`formatter.py:130`); `Indenter.java` would not emit them.
    expect(one("%1%i%n%2%n%d%3", [T("a"), T("b"), T("c")])).toBe("a\n  b\n  c");
  });

  test("a multi-digit index is one token", () => {
    const items = Array.from({ length: 12 }, (_, i) => T(`t${i}`));
    expect(one("%12", items)).toBe("t11");
  });

  test("an out-of-range index is an error", () => {
    expect(() => one("%4", [T("a")])).toThrow(/out of bounds/u);
  });

  test("an index onto a regex terminal is an error (formatter.py:158)", () => {
    const defn = new KDefinition("E", [
      kflatmodule("E", {
        sentences: [symbol("Exp", "e", [{ node: "KRegexTerminal", regex: "[0-9]+" }], "%1")],
      }),
    ]);
    expect(() => new Formatter(defn, { brackets: false }).format(kapply("e"))).toThrow(/regex terminal/u);
  });

  test("a non-terminal with no matching argument is an error", () => {
    expect(() => one("%1", [NT(EXP)])).toThrow(/NonTerminal index out of bounds/u);
  });

  test("an unknown symbol is an error", () => {
    expect(() => new Formatter(BRACKETS, { brackets: false }).format(kapply("nope"))).toThrow(/Symbol not found/u);
  });

  test("a KAs cannot be formatted (formatter.py:90)", () => {
    const term: KInner = { node: "KAs", pattern: intToken(1), alias: kvariable("X") };
    expect(() => new Formatter(BRACKETS).format(term)).toThrow(/Unsupported term/u);
  });
});

describe("leaves (formatter.py:81-84)", () => {
  test("a token prints its text and a variable its name", () => {
    const formatter = new Formatter(BRACKETS, { brackets: false });
    expect(formatter.format(intToken(7))).toBe("7");
    expect(formatter.format(kvariable("X"))).toBe("X");
    expect(formatter.format(kvariable("X", INT))).toBe("X:Int");
  });

  test("an empty KSequence is `.K` (formatter.py:93-96)", () => {
    const formatter = new Formatter(BRACKETS, { brackets: false });
    expect(formatter.format(ksequence([]))).toBe(".K");
    expect(formatter.format(ksequence([intToken(1), intToken(2)]))).toBe("1 ~> 2 ~> .K");
  });
});

describe("addBrackets (formatter.py:163-193)", () => {
  test("wraps with the definition's own bracket label where there is one", () => {
    const wrapped = addBrackets(BRACKETS, times(intToken(1), plus(intToken(2), intToken(3))));
    expect(wrapped).toEqual(
      kapply("_*_", [intToken(1), kapply("(_)_BRACKETS_Exp_Exp", [plus(intToken(2), intToken(3))])]),
    );
  });

  test("falls back to the synthetic default bracket for a sort with none", () => {
    const wrapped = addBrackets(
      BRACKETS,
      kapply("_*Int_", [kapply("_+Int_", [intToken(1), intToken(2)]), intToken(3)]),
    );
    expect(wrapped).toEqual(
      kapply("_*Int_", [kapply(DEFAULT_BRACKET_LABEL, [kapply("_+Int_", [intToken(1), intToken(2)])]), intToken(3)]),
    );
  });

  test("the default bracket is the KSEQ production pyk hard-codes (formatter.py:42-57)", () => {
    expect(DEFAULT_BRACKET.klabel).toBeUndefined();
    expect(DEFAULT_BRACKET.att.has(Atts.BRACKET)).toBe(true);
    expect(DEFAULT_BRACKET.att.get(Atts.FORMAT)?.tokens.join("")).toBe("%1 %2 %3");
  });

  test("tokens, variables, sequences and unary applications never get brackets", () => {
    const unary = kapply("sgn(_)", [plus(intToken(1), intToken(2))]);
    expect(addBrackets(BRACKETS, times(unary, intToken(3)))).toEqual(times(unary, intToken(3)));
  });

  test("is not idempotent — the bracket label is not a symbol", () => {
    // `_add_brackets` looks every application up in `definition.symbols`
    // (`formatter.py:167`), and a bracket production has no klabel, so its
    // label is only in `syntax_symbols`.  Running the pass twice is a
    // `KeyError` upstream and a `TypeError` here; `Formatter.format` runs it
    // exactly once.  Within a single pass the newly created brackets are
    // never revisited — `bottom_up` has already been past them.
    const once = addBrackets(BRACKETS, times(plus(intToken(1), intToken(2)), intToken(3)));
    expect(() => addBrackets(BRACKETS, once)).toThrow(/Symbol not found/u);
  });
});
