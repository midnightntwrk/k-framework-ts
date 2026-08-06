/**
 * `KompiledDefinition.prettyPrint` — Route A, end to end through a real
 * kompiled directory.
 *
 * `pyk/src/tests/integration/kast/test_formatter.py`'s five inline expectations
 * are already tested at `packages/kast`, where the `Formatter` lives.  What is
 * tested here is the layer above it: that a directory loads, that its
 * `compiled.json` yields a `KDefinition` whose `format` attributes survive the
 * round trip, and that printing a term through it produces the layout K's own
 * `format` strings describe.
 *
 * # The Route B goldens, and a genuine surprise
 *
 * `fixtures/upstream/imp-llvm/*.out` and `imp++-llvm/*.out` are **Route B**
 * output: `krun -o pretty` runs `kore-print`, which prefers the LLVM backend's
 * C++ printer reading `syntaxDefinition.kore` (`printer.cpp:211-232`), a
 * different `format` language from the KAST-level one this package implements.
 * They gate a Route B printer, which does not exist here, and are therefore
 * vendored evidence rather than assertions.
 *
 * They were checked once anyway, and three of the five **match Route A byte for
 * byte** (modulo the golden's trailing newline, which `Formatter` does not
 * emit).  That is asserted below, because a passing byte-exact test against
 * upstream's own bytes is worth more than a comment saying it might pass — but
 * read the assertion for what it is: evidence that the two printers *agree on
 * these terms*, not that they agree in general.  They are flat two-cell
 * configurations of integers and `Map`s, which is precisely where the two
 * `format` languages cannot diverge.  The remaining two (`imp++`'s `div` and
 * `spawn` — `#Or` of `#Equals`, six-deep cells, escapes) come from a definition
 * the fixture set has no `compiled.json` for, so Route A cannot be run on them
 * at all; they stay evidence.
 *
 * # The two pre-passes, and why they need a synthetic definition
 *
 * `prettyPrint` runs `undoAliases` (default on) and `sortAcCollections`
 * (default off) before the `Formatter`, which is pyk's order and pyk's defaults
 * (`ktool/kprint.py:301-312`).  **IMP has no `alias` rule and no `Map` in its
 * printable configuration**, which is exactly why a missing `undoAliases` was
 * invisible against the fixtures for as long as it was.  So the tests for the
 * two options build a definition by hand, serialise it to a KAST v4
 * `compiled.json` and feed it through a `Map`-backed {@link KompiledSource} —
 * the same trick `kompiled.test.ts` uses for the artifacts no local `kompile`
 * produces.  The definition is a two-production cut-down of pyk's own
 * `TestUnparsingDefn.KOMPILE_DEFINITION` (`test_kprint.py:317-345`), including
 * its nested-alias pair, because the fixpoint is the part of `undoAliases` a
 * one-rule test would not reach.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  attEntry,
  Atts,
  definitionToDict,
  fromDict,
  KAtt,
  kapply,
  kastTerm,
  KDefinition,
  kflatmodule,
  knonterminal,
  kproduction,
  krewrite,
  krule,
  ksort,
  kterminal,
  ktoken,
} from "@kframework-ts/kast";

import { loadKompiledDefinition } from "../src/fs.ts";
import { KompiledDefinition } from "../src/kompiled.ts";
import { parseKompiledLayout } from "../src/layout.ts";
import { KAST_VERSION } from "../src/version.ts";
import { GENERATED, IMP_HASKELL, IMP_LLVM, UPSTREAM } from "./fixtures.ts";

const TOP = ksort("GeneratedTopCell");

const readTerm = (path: string) => fromDict(kastTerm(JSON.parse(readFileSync(path, "utf8"))));

describe("prettyPrint through a loaded definition", () => {
  test("the empty configuration, laid out by the cells' own format attributes", async () => {
    // `<T>`'s format is `%1%i%n%2%n%3%d%n%4`; the indentation below is what
    // that string means, and it is the thing `pretty.ts` alone cannot produce.
    const kompiled = await loadKompiledDefinition(IMP_LLVM);
    expect(kompiled.prettyPrint(kompiled.definition.emptyConfig(TOP))).toBe(
      ["<T>", "  <k>", "    K_CELL", "  </k>", "  <state>", "    STATE_CELL", "  </state>", "</T>"].join("\n"),
    );
  });

  test("the initial configuration, with the configuration variable in place", async () => {
    const kompiled = await loadKompiledDefinition(IMP_LLVM);
    expect(kompiled.prettyPrint(kompiled.definition.initConfig(TOP))).toBe(
      ["<T>", "  <k>", "    $PGM", "  </k>", "  <state>", "    .Map", "  </state>", "</T>"].join("\n"),
    );
  });

  test("the two backends' definitions print the same configuration identically", async () => {
    // They disagree about which modules exist (see `kompiled.test.ts`), but not
    // about IMP's own syntax, so the printed configuration must not move.
    const haskell = await loadKompiledDefinition(IMP_HASKELL);
    const llvm = await loadKompiledDefinition(IMP_LLVM);
    expect(haskell.prettyPrint(haskell.definition.emptyConfig(TOP))).toBe(
      llvm.prettyPrint(llvm.definition.emptyConfig(TOP)),
    );
  });

  test("the indent option starts the counter where you ask", async () => {
    const kompiled = await loadKompiledDefinition(IMP_LLVM);
    const indented = kompiled.prettyPrint(kompiled.definition.emptyConfig(TOP), { indent: 2 });
    // Only the *continuation* lines move: `%n` emits the indent, and the first
    // chunk is written before any `%n` has run.
    expect(indented.startsWith("<T>\n      <k>")).toBe(true);
  });

  test("inModule re-roots the definition, as pyk's in_module does", async () => {
    // `KPrint.pretty_print(in_module=...)` is `definition.let(main_module_name=...)`
    // (`ktool/kprint.py:304`).  Naming a module that does not import the cell
    // productions makes the symbol unfindable, which is the observable effect.
    const kompiled = await loadKompiledDefinition(IMP_LLVM);
    const config = kompiled.definition.emptyConfig(TOP);
    expect(() => kompiled.prettyPrint(config, { inModule: "IMP-SYNTAX" })).toThrow(/Symbol not found/);
  });

  test("an unknown symbol is a clear error, not silent garbage", async () => {
    const kompiled = await loadKompiledDefinition(IMP_LLVM);
    expect(() => kompiled.prettyPrint(kapply("<nope>"))).toThrow(/Symbol not found in definition: <nope>/);
  });
});

describe("the Route B goldens (vendored evidence — see the module docstring)", () => {
  // Each pair is a `krun --output json` term and the pretty golden `k`'s own CI
  // checks, for the *same run* (`fixtures/PROVENANCE.md`).  The trick is
  // `packages/kast-json/fixtures/term/`'s: the JSON term makes the byte-exact
  // test need no K at test time.
  const MATCHING = [
    ["imp-llvm-krun/sum.imp.json", "imp-llvm/sum.imp.out"],
    ["imp-llvm-krun/collatz.imp.json", "imp-llvm/collatz.imp.out"],
    ["imp-llvm-krun/primes.imp.json", "imp-llvm/primes.imp.out"],
  ] as const;

  for (const [term, golden] of MATCHING) {
    test(`${golden} matches Route A byte for byte`, async () => {
      // NB: these terms come from `upstream/imp-llvm/imp.k`, a *different* IMP
      // from `fixtures/src/imp.k` (different `!` and sequencing grammar — see
      // PROVENANCE).  The configuration symbols they use happen to be the same,
      // which is why this works at all; a program that used the differing
      // syntax would not parse under this definition.
      const kompiled = await loadKompiledDefinition(IMP_LLVM);
      const expected = readFileSync(join(UPSTREAM, golden), "utf8");
      // The golden ends in a newline; `Formatter` emits none, and `krun` adds
      // it. That single byte is the whole of the difference.
      expect(`${kompiled.prettyPrint(readTerm(join(GENERATED, term)))}\n`).toBe(expected);
    });
  }

  const UNPRINTABLE = [
    ["imp++-llvm-krun/div.imp.search.json", "imp++-llvm/div.imp.out"],
    ["imp++-llvm-krun/spawn.imp.search.json", "imp++-llvm/spawn.imp.out"],
  ] as const;

  for (const [term, golden] of UNPRINTABLE) {
    test(`${golden} cannot be printed here — its definition has no compiled.json`, async () => {
      // The richest goldens in the ecosystem, and out of reach: they are IMP++
      // (`upstream/imp++-llvm/imp.md`), whose kompiled directory was not
      // vendored — only the `krun` terms were.  Route A needs the KAST
      // definition, so the failure is `<env>`, a cell IMP does not have.  This
      // is asserted rather than skipped so that vendoring an IMP++ directory
      // later turns this test red and is noticed.
      const kompiled = await loadKompiledDefinition(IMP_LLVM);
      expect(readFileSync(join(UPSTREAM, golden), "utf8").length).toBeGreaterThan(1000);
      expect(() => kompiled.prettyPrint(readTerm(join(GENERATED, term)))).toThrow(
        /Symbol not found in definition: <env>/,
      );
    });
  }
});

///////////////////////////////////////////////////////////////////////
// The two pre-passes — see the module docstring for the definition   //
///////////////////////////////////////////////////////////////////////

const T = kterminal;
const NT = knonterminal;

/** `[symbol(name), alias]`, pyk's `symbolAlias` (`test_kprint.py:322`). */
const symbolAlias = (name: string): KAtt => new KAtt([attEntry(Atts.SYMBOL, name), attEntry(Atts.ALIAS, null)]);
const symbol = (name: string): KAtt => new KAtt([attEntry(Atts.SYMBOL, name)]);
const ALIAS = new KAtt([attEntry(Atts.ALIAS, null)]);

/**
 * `syntax Int ::= "hundred" [symbol(hundred), alias]`
 * `                 | "twoHundred" [symbol(twoHundred), alias]`
 * `                 | Int "+Int" Int [symbol(_+Int_)]`
 * `syntax Map ::= "a" [symbol(a)] | "b" [symbol(b)] | Map "," Map [symbol(_Map_)]`
 * `rule hundred => 100 [alias]`
 * `rule twoHundred => hundred +Int hundred [alias]`
 *
 * No `format` attributes anywhere: `productionDefaultFormat` (pyk's
 * `KProduction.default_format`) supplies `%1 %2 %3`, which is all these need.
 */
const PREPASS_DEFINITION = new KDefinition("PREPASS", [
  kflatmodule("PREPASS", {
    sentences: [
      kproduction("Int", { items: [T("hundred")], klabel: "hundred", att: symbolAlias("hundred") }),
      kproduction("Int", { items: [T("twoHundred")], klabel: "twoHundred", att: symbolAlias("twoHundred") }),
      kproduction("Int", {
        items: [NT("Int"), T("+Int"), NT("Int")],
        klabel: "_+Int_",
        att: symbol("_+Int_"),
      }),
      kproduction("Map", { items: [T("a")], klabel: "a", att: symbol("a") }),
      kproduction("Map", { items: [T("b")], klabel: "b", att: symbol("b") }),
      kproduction("Map", { items: [NT("Map"), T(","), NT("Map")], klabel: "_Map_", att: symbol("_Map_") }),
      krule(krewrite(kapply("hundred"), ktoken("100", "Int")), { att: ALIAS }),
      krule(krewrite(kapply("twoHundred"), kapply("_+Int_", [kapply("hundred"), kapply("hundred")])), {
        att: ALIAS,
      }),
    ],
  }),
]);

/** The hand-built definition, reached the way a real one is: through `compiled.json`. */
function prepassKompiled(): KompiledDefinition {
  const text = JSON.stringify({
    format: "KAST",
    version: KAST_VERSION,
    term: definitionToDict(PREPASS_DEFINITION),
  });
  return new KompiledDefinition({
    path: "<memory>",
    layout: parseKompiledLayout({
      mainModule: "PREPASS",
      mainSyntaxModule: "PREPASS",
      backend: "llvm",
      timestampMtimeMs: 0,
    }),
    read: (artifact) => (artifact === "compiled.json" ? text : undefined),
  });
}

describe("unalias — on by default, as in pyk and in the Java unparser", () => {
  test("a term that is an alias's expansion prints as the alias", () => {
    // `KPrint.pretty_print(unalias=True)` is the default (`ktool/kprint.py:302`),
    // and `KPrint.unparseInternal` runs reverse macro expansion as its first
    // stage (`KPrint.java:203-212`).  Without the pre-pass this prints `100`.
    expect(prepassKompiled().prettyPrint(ktoken("100", "Int"))).toBe("hundred");
  });

  test("unalias: false opts out and prints the expanded term", () => {
    expect(prepassKompiled().prettyPrint(ktoken("100", "Int"), { unalias: false })).toBe("100");
  });

  test("aliases fold to a fixpoint, so an alias of an alias still folds", () => {
    // `100 +Int 100` → `hundred +Int hundred` → `twoHundred`.  This is what
    // `indexedRewrite` buys over a single `bottomUp` pass (`manip.py:638`), and
    // it is pyk's own `hundred`/`rangeHundred` shape.
    const expanded = kapply("_+Int_", [ktoken("100", "Int"), ktoken("100", "Int")]);
    expect(prepassKompiled().prettyPrint(expanded)).toBe("twoHundred");
    expect(prepassKompiled().prettyPrint(expanded, { unalias: false })).toBe("100 +Int 100");
  });

  test("the option composes with inModule, which decides which aliases exist", () => {
    // `undoAliases` reads `definition.aliasRules`, which is computed from the
    // main module's import closure — so re-rooting changes the alias set, not
    // just the symbol set.
    const kompiled = prepassKompiled();
    expect(kompiled.prettyPrint(ktoken("100", "Int"), { inModule: "PREPASS" })).toBe("hundred");
  });

  test("IMP has no aliases, so the default is a no-op on the fixtures", async () => {
    // Which is exactly why this needed a synthetic definition: every other
    // assertion in this file would pass with or without the pre-pass.
    const kompiled = await loadKompiledDefinition(IMP_LLVM);
    expect(kompiled.definition.aliasRules).toEqual([]);
    expect(kompiled.prettyPrint(kompiled.definition.emptyConfig(TOP), { unalias: false })).toBe(
      kompiled.prettyPrint(kompiled.definition.emptyConfig(TOP)),
    );
  });
});

describe("sortCollections — off by default, as in pyk", () => {
  const unsorted = kapply("_Map_", [kapply("b"), kapply("a")]);

  test("the default leaves an AC collection in the order it was given", () => {
    // `pretty_print(sort_collections=False)` (`ktool/kprint.py:302`).
    expect(prepassKompiled().prettyPrint(unsorted)).toBe("b , a");
  });

  test("sortCollections: true puts it into the KAst total order", () => {
    // What `pyk rpc-print` passes (`__main__.py:149,163,168,195`), and therefore
    // what a comparison against a `.pretty.golden` from that command needs.
    expect(prepassKompiled().prettyPrint(unsorted, { sortCollections: true })).toBe("a , b");
  });

  test("an already-sorted collection is unchanged by either setting", () => {
    const sorted = kapply("_Map_", [kapply("a"), kapply("b")]);
    expect(prepassKompiled().prettyPrint(sorted, { sortCollections: true })).toBe("a , b");
    expect(prepassKompiled().prettyPrint(sorted)).toBe("a , b");
  });
});
