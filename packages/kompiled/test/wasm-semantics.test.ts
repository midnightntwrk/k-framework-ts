/**
 * The one **real** semantics in this suite.
 *
 * Everything else here is IMP, and IMP is a toy: 273 syntax productions, 31
 * sorts, no macro rule, no overload, no cell collection, and a `macros.kore`
 * that is ten bytes of comment.  A reader can be completely correct against IMP and still
 * be wrong about K, and this file exists because it *was*: `macrosKore` sent a
 * non-empty `macros.kore` to `parseDefinition`, which cannot ever accept one
 * (`ModuleToKORE.java:335-365` writes a bare sentence list into that file), and
 * no IMP-shaped fixture could show it.
 *
 * The fixture is `wasm-semantics`' `test.md` — KWasm — kompiled with the
 * haskell backend at the same K release as the IMP fixtures.  It is vendored
 * **partially**: `compiled.json`, `macros.kore`, `allRules.txt` and the
 * markers, without the two KORE definition files, which together are 6 MB and
 * would more than double this repository's fixture footprint for coverage that
 * `wasm-soak.test.ts` gets from a local build instead.  `fixtures/PROVENANCE.md`
 * records the exact invocation, the licence position, and the recipe.
 *
 * So the assertions here are about the **KAST layer at real scale**, and each
 * one names the thing IMP could not have shown.
 */

import { describe, expect, test } from "bun:test";

import { Atts, collect, sentenceUniqueId } from "@kframework-ts/kast";
import { ATT_UNIQUE_ID, attString } from "@kframework-ts/kore";

import { MissingKompiledFileError } from "../src/errors.ts";
import { loadKompiledDefinition } from "../src/fs.ts";
import { MACROS_MODULE_NAME } from "../src/kompiled.ts";
import { lookupRule } from "../src/layout.ts";
import { caught } from "./caught.ts";
import { IMP_HASKELL, WASM_HASKELL } from "./fixtures.ts";

const wasm = await loadKompiledDefinition(WASM_HASKELL);
const imp = await loadKompiledDefinition(IMP_HASKELL);

describe("the fixture is a real semantics, and a partial directory on purpose", () => {
  test("the markers read, and the layout is KWasm's own", () => {
    expect(wasm.layout.backend).toBe("haskell");
    expect(wasm.layout.mainModule).toBe("WASM-TEST");
    expect(wasm.layout.mainSyntaxModule).toBe("WASM-TEST-SYNTAX");
    // A real configuration variable at a sort that is not `KItem` — IMP's is
    // `Pgm`, so this is the second independent spelling the parser has seen.
    expect(wasm.layout.configVars).toEqual(["PGM"]);
    expect(wasm.layout.configVarSorts.get("PGM")).toBe("Stmts");
  });

  test("the two absent KORE artifacts fail on their own, leaving the KAST side whole", () => {
    // This is the layering claim from the README stated against a directory
    // that really is missing them, rather than against a synthetic source: the
    // KORE getters throw, and `definition` — read after them — still loads.
    expect(caught(() => wasm.koreDefinition, MissingKompiledFileError).file).toBe("definition.kore");
    expect(caught(() => wasm.syntaxKore, MissingKompiledFileError).file).toBe("syntaxDefinition.kore");
    expect(wasm.definition.mainModuleName).toBe("WASM-TEST");
  });

  test("it is an order of magnitude past IMP on every axis that matters", () => {
    const wasmSorts = new Set(wasm.definition.syntaxProductions.map((p) => p.sort.name));
    const impSorts = new Set(imp.definition.syntaxProductions.map((p) => p.sort.name));

    // The module count is the number that barely moves — 1.5× — which is
    // exactly why it is the wrong one to size a fixture by.
    expect(imp.definition.allModules.length).toBe(67);
    expect(wasm.definition.allModules.length).toBe(99);

    expect(imp.definition.rules.length).toBe(300);
    expect(wasm.definition.rules.length).toBe(2062);
    expect(imp.definition.syntaxProductions.length).toBe(273);
    expect(wasm.definition.syntaxProductions.length).toBe(1784);
    expect(impSorts.size).toBe(31);
    expect(wasmSorts.size).toBe(302);
  });
});

describe("macros.kore, non-empty for the first time", () => {
  test("it parses, and every axiom in it is a macro", () => {
    // IMP's is `// macros\n`; the llvm-backend's test input is zero bytes.
    // Both are the *empty* form, and between them they were the entire corpus.
    const index = wasm.macrosKore;
    expect(index.moduleNames).toEqual([MACROS_MODULE_NAME]);
    expect(index.axioms.length).toBe(13);
    for (const axiom of index.axioms) expect(axiom.tag).toBe("Axiom");
  });

  test("the file is a sentence list — it has no module of its own", () => {
    // The expected result, asserted on K's own bytes.
    const text = wasm.text("macros.kore")!;
    expect(text.startsWith("// macros\n")).toBe(true);
    expect(text).not.toContain("\nmodule ");
    expect(text).not.toContain("endmodule");
  });

  test("its axioms are exactly the definition's macro rules, joined by UNIQUE_ID", () => {
    // A cross-artifact oracle: `compiled.json` and `macros.kore` are written by
    // two different passes over the same rules (`ModuleToKORE.java:336-352`
    // routes a rule to one file or the other by `ExpandMacros.isMacro`), so
    // agreeing on the set of ids is a real check on both readers.
    const fromKore = new Set(wasm.macrosKore.axioms.map((axiom) => attString(axiom.attrs, ATT_UNIQUE_ID)));
    // `sentenceUniqueId` returns `JsonValue`, because `Atts.UNIQUE_ID` is typed
    // `Any` at rest (`att.ts`).  Narrowed by a guard rather than an assertion,
    // and the count below proves the guard discarded nothing.
    const fromKast = new Set(
      wasm.definition.macroRules
        .map((rule) => sentenceUniqueId(rule))
        .filter((id): id is string => typeof id === "string"),
    );

    expect(fromKore.size).toBe(13);
    expect(fromKore).toEqual(fromKast);

    // …and none of them is in `definition.kore`'s job — the semantics file gets
    // the complement, which is why `allRules.txt` sees fewer rules than the
    // definition has.
    expect(wasm.definition.rules.length).toBeGreaterThan(wasm.definition.macroRules.length);
  });

  test("IMP's empty form still behaves, so the wrapper did not trade one case for the other", () => {
    expect(imp.macrosKore.moduleNames).toEqual([]);
    expect(imp.macrosKore.axioms).toEqual([]);
  });
});

describe("KDefinition machinery that IMP leaves at zero", () => {
  test("overloads — an index that was empty in every other fixture in this repo", () => {
    // `KDefinition.overloads` is consumed by the formatter and by
    // `_module_to_kore`'s `_overload_axioms`.  IMP declares no `overload`
    // attribute at all, so the pointwise-subsort ordering that builds this map
    // has never run on real input here.
    expect(imp.definition.overloads.size).toBe(0);
    expect(wasm.definition.overloads.size).toBe(6);

    // The index direction is the one that trips people: the key is the *more
    // general* symbol and the values are the more specific ones.
    const key = "___WASM-COMMON-SYNTAX_Stmts_Stmt_Stmts";
    const specific = wasm.definition.overloads.get(key);
    expect(specific).toBeDefined();
    expect(specific!.size).toBeGreaterThan(0);
    expect(specific!.has(key)).toBe(false);

    // Every symbol named on either side is a real production of this definition.
    for (const [general, specifics] of wasm.definition.overloads) {
      expect(wasm.definition.symbols.has(general)).toBe(true);
      for (const name of specifics) expect(wasm.definition.symbols.has(name)).toBe(true);
    }
  });

  test("cell collections — the `<…>Map` productions `addCellMapItems` exists for", () => {
    expect(imp.definition.cellCollectionProductions.length).toBe(0);
    expect(wasm.definition.cellCollectionProductions.length).toBe(6);
    for (const production of wasm.definition.cellCollectionProductions) {
      expect(production.att.has(Atts.CELL_COLLECTION)).toBe(true);
      // A cell collection is a collection first: it must carry the `element`
      // and `unit` that `cellMapItemInfo` reads.
      expect(production.att.has(Atts.ELEMENT)).toBe(true);
      expect(production.att.has(Atts.UNIT)).toBe(true);
    }
  });

  test("macro rules — `macroRules` was an empty list everywhere until now", () => {
    expect(imp.definition.macroRules.length).toBe(0);
    expect(wasm.definition.macroRules.length).toBe(13);
    // `macroRules` is `macro` ∪ `aliasRules` (`outer.ts`), and KWasm happens to
    // declare no alias — so the alias half of that union is *still* uncovered,
    // and saying so is worth more than a fixture that hides it.
    expect(wasm.definition.aliasRules.length).toBe(0);
    for (const rule of wasm.definition.macroRules) expect(rule.att.has(Atts.MACRO)).toBe(true);
  });
});

describe("allRules.txt against a definition that has 2062 rules", () => {
  test("every line joins to a sentence, and the file is a strict subset", () => {
    // `Kompile.java:363-381` writes a line only for a main-module rule or claim
    // carrying all of Source, Location and UNIQUE_ID.  With IMP the shortfall is
    // one rule; here it is over a thousand, which is the shape of the claim.
    expect(wasm.layout.allRules.size).toBe(929);
    expect(wasm.definition.sentenceByUniqueId.size).toBe(2038);

    for (const [hash, location] of wasm.layout.allRules) {
      expect(wasm.definition.sentenceByUniqueId.has(hash)).toBe(true);
      expect(location.line).toBeGreaterThan(0);
      // No assertion on `location.source`: it is an absolute path baked in at
      // kompile time (`fixtures/PROVENANCE.md`, the reproducibility caveat).
      expect(typeof location.source).toBe("string");
    }
  });

  test("lookupRule takes either the full hash or pyk's 12-character prefix", () => {
    const [hash] = [...wasm.layout.allRules.keys()];
    expect(hash).toMatch(/^[0-9a-f]{64}$/u);
    expect(lookupRule(wasm.layout, hash!)).toBe(wasm.layout.allRules.get(hash!));
    expect(lookupRule(wasm.layout, hash!.slice(0, 12))).toBe(wasm.layout.allRules.get(hash!));
  });
});

describe("the formatter, on 3630 real terms", () => {
  /** Every rule side, which is what `prettyPrint` is actually handed in anger. */
  const sides = wasm.definition.rules.flatMap((rule) =>
    rule.body.node === "KRewrite" ? [rule.body.lhs, rule.body.rhs] : [rule.body],
  );

  test("the corpus is the size the claim needs", () => {
    expect(sides.length).toBe(3880);
  });

  /**
   * `formatter.ts` has no case for `KRewrite` or `KAs`, and neither does pyk's
   * `PrettyPrinter` — a nested one is as fatal as a top-level one, so the
   * partition is over the whole subtree rather than the root node.
   */
  const printable = sides.filter((term) => {
    let ok = true;
    collect((sub) => {
      if (sub.node === "KRewrite" || sub.node === "KAs") ok = false;
    }, term);
    return ok;
  });

  test("everything the formatter claims to handle, it handles — 3630 terms, not 488", () => {
    for (const term of printable) expect(typeof wasm.prettyPrint(term)).toBe("string");
    expect(printable.length).toBe(3630);
  });

  test("printing is a function of the term, not of what was printed before it", () => {
    // The pre-passes (`undoAliases`, `sortCollections`) run per call and the
    // production tables are memoised across calls; a table built lazily during
    // the first print and then mutated would show up here and nowhere else.
    const sample = printable.filter((_, index) => index % 250 === 0);
    const first = sample.map((term) => wasm.prettyPrint(term));
    expect(sample.map((term) => wasm.prettyPrint(term))).toEqual(first);
  });

  test("the `format` table is read from this definition, not defaulted", () => {
    // 90 productions carry an explicit `format` here against IMP's 19, so the
    // non-default branch of `Formatter` is what most of the corpus above took.
    expect(imp.definition.syntaxProductions.filter((p) => p.att.has(Atts.FORMAT)).length).toBe(19);
    expect(wasm.definition.syntaxProductions.filter((p) => p.att.has(Atts.FORMAT)).length).toBe(90);
  });
});
