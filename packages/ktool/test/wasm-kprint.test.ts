/**
 * `KPrint` and `definition-cache` one layer up from IMP: KWasm.
 *
 * # Why this file exists
 *
 * `test/kprint.test.ts` and `test/definition-cache.test.ts` run against
 * `imp-{llvm,haskell}-kompiled` and nothing else, and IMP is 273 productions
 * with **zero** overloads, **zero** cell collections and **zero** macro rules.
 * So everything this package wires around a printer — the symbol table it hands
 * to `PrettyPrinter`, the per-`(inModule, unalias, sortCollections)` printer
 * memo, the two-printer split, the `allRules.txt` join, the 5 MB parse the
 * definition cache exists to avoid — had only ever met a definition small
 * enough that most of it could not fire.
 *
 * KWasm is 1784 productions over 302 sorts, 2062 rules (4124 sides), 6
 * overloads, 6 cell collections and 13 macros, from a 4.9 MB `compiled.json`.
 *
 * # Hermetic, and what that rules out
 *
 * `@kframework-ts/wasm-fixtures` vendors a deliberately **partial** kompiled
 * directory: `compiled.json`, `allRules.txt`, `macros.kore`, `configVars.sh`
 * and the markers — and **no** `definition.kore`, **no**
 * `syntaxDefinition.kore`, no LLVM interpreter and no generated Bison parsers.
 * So this file reads 4.9 MB off disk and starts nothing, and the following
 * lanes are structurally **out of scope** here:
 *
 * - `krun` and the LLVM interpreter — no `interpreter` binary;
 * - `kparse` / `parseToken` — no `parser_<Sort>_<Module>` and no `kast`;
 * - `kompile` — building the complete directory takes a K install and 21 s,
 *   which is `packages/wasm-fixtures`' `kompile-soak` and is opt-in;
 * - `koreToKast` / `koreToPretty` under `conversionStrategy: 'binary'` — those
 *   are `kore-print` and `kast`, and their argv is `kore-print.test.ts`'s and
 *   `kast-cli.test.ts`'s table.
 *
 * The **pure** conversion strategy needs only `compiled.json`, so it is in.
 *
 * # What is deliberately left to `packages/kast`
 *
 * `packages/kast/test/wasm-definition.test.ts` already pins, against these same
 * bytes, everything that is a property of the *printers themselves*: the
 * `overloads` table, `cellCollectionProductions` / `cellMapItemInfo`,
 * `macroRules`, `sortAcCollections`' `CellMap_` branch, `Formatter` over all
 * 4124 sides, `addBrackets`, and the exact printing of the `_ElemInstCellMap_`
 * term.  None of that is restated here.
 *
 * This file's subject is what **ktool** adds on top: `KPrint.load`'s eager
 * marker reads and lazy artifacts, `definitionHash`, the `allRules.txt` join,
 * the symbol table `patchSymbolTable` receives, the printer memo, the
 * `prettyPrint` / `formatPrint` split as *this class* exposes it, and the
 * definition cache at 5 MB.  Where a number below (4124, 4117, 7) also appears
 * in the kast file it is because the same corpus is being pushed through
 * `KPrint`'s method rather than through `Formatter` directly, and the point is
 * that `KPrint` does not lose anything on the way.
 *
 * # Upstream has none of this
 *
 * pyk's `test_kprint.py` is an integration test that kompiles `imp.k`; there is
 * no upstream table to transcribe.  Every expectation was measured from the
 * vendored bytes.  Rules are named by `UNIQUE_ID`, never by index and never by
 * `source`/`location` — every location in this definition holds the absolute
 * path of the machine that ran `kompile`.
 */

import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { cp, mkdtemp, rm, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";

import {
  assocWithUnit,
  Atts,
  extractLhs,
  extractRhs,
  kapply,
  ksort,
  kvariable,
  moduleSyntaxProductions,
  type KInner,
  type KRule,
  type SymbolTable,
} from "@kframework-ts/kast";
import { lookupRule, MissingKompiledFileError } from "@kframework-ts/kompiled";
import { WASM_CENSUS, WASM_DEFINITION_HASH, WASM_HASKELL_KOMPILED_DIR } from "@kframework-ts/wasm-fixtures";

import { caughtAsync } from "./caught.ts";
import {
  clearKompiledDefinitionCache,
  kompiledDefinitionCacheStats,
  loadKompiledDefinitionCached,
  resetKompiledDefinitionCacheStats,
} from "../src/definition-cache.ts";
import { KPrint } from "../src/kprint.ts";

//////////////////////////////////////////////////////////
// The printer, and the vocabulary for talking about it  //
//////////////////////////////////////////////////////////

/**
 * One `KPrint` for the whole file, built **outside** the shared definition
 * cache.
 *
 * `cacheDefinition: false` on purpose: `test/definition-cache.test.ts` asserts
 * absolute `hits`/`misses`/`entries` counters, and those counters are
 * process-global.  A module-level load through the cache would leave an entry
 * and three counter increments behind for whichever file runs next.  The cache
 * is exercised deliberately, and only inside `describe("definition-cache …")`,
 * which clears and resets around itself.
 */
let printer: Promise<KPrint> | undefined;
const wasm = (): Promise<KPrint> => (printer ??= KPrint.load(WASM_HASKELL_KOMPILED_DIR, { cacheDefinition: false }));

/**
 * A second printer over the **same** parse, through the public constructor.
 *
 * `KPrint`'s constructor takes an already-loaded `KompiledDefinition` precisely
 * so a caller who has one does not pay for it twice (`kprint.ts`'s "Why
 * `KPrint.load` and not `new KPrint(dir)`"), and nothing in this package tested
 * that door before.  It is also what keeps this file's eight printers to one
 * 4.9 MB parse: `cacheDefinition: false` everywhere plus `KPrint.load` per
 * printer would be eight.
 */
async function printerOver(options: Parameters<typeof KPrint.load>[1] = {}): Promise<KPrint> {
  return new KPrint((await wasm()).kompiled, options);
}

/** The same definition under `conversionStrategy: 'pure'` — no child, ever. */
let purePrinter: Promise<KPrint> | undefined;
const pure = (): Promise<KPrint> => (purePrinter ??= printerOver({ conversionStrategy: "pure" }));

/**
 * The 4124 sides of the 2062 rules, computed once.
 *
 * Sides and not bodies: `Formatter` — and therefore {@link KPrint.formatPrint}
 * — cannot print a `KRewrite`, and 2055 of the 2062 bodies are one.
 */
let sides: readonly KInner[] | undefined;
async function ruleSides(): Promise<readonly KInner[]> {
  if (sides === undefined) {
    const { definition } = await wasm();
    sides = definition.rules.flatMap((r) => [extractLhs(r.body), extractRhs(r.body)]);
  }
  return sides;
}

/**
 * The rule carrying `UNIQUE_ID(uid)`, and the assertion that it is the only one.
 *
 * Not merely defensive: 29 of this definition's `UNIQUE_ID`s are carried by
 * more than one rule (see the `allRules.txt` describe), so "the rule with this
 * id" is a claim that has to be checked rather than assumed.
 */
async function rule(uid: string): Promise<KRule> {
  const { definition } = await wasm();
  const found = definition.rules.filter((r) => r.att.get(Atts.UNIQUE_ID) === uid);
  expect(found.length).toBe(1);
  return found[0]!;
}

/** The four list-cons symbols of the definition's one overload group. */
const STMTS = "___WASM-COMMON-SYNTAX_Stmts_Stmt_Stmts";
const DEFNS = "___WASM-COMMON-SYNTAX_Defns_Defn_Defns";
const INSTRS = "___WASM-COMMON-SYNTAX_Instrs_Instr_Instrs";
const EMPTY_STMTS = "___WASM-COMMON-SYNTAX_EmptyStmts_EmptyStmt_EmptyStmts";

/** `label(S, SS)` — a list cons applied to two variables. */
const cons = (label: string): KInner => kapply(label, [kvariable("S"), kvariable("SS")]);

const TOP = ksort("GeneratedTopCell");

//////////////////////////////
// Identity                 //
//////////////////////////////

describe("KPrint.load over the vendored KWasm directory", () => {
  test("is the build wasm-fixtures pins, and reports the markers pyk reads eagerly", async () => {
    const kprint = await wasm();
    // `KPrint.definition_hash` (`kprint.py:238-240`).  One equality is the
    // whole identity guard: another K release or another `wasm-semantics`
    // commit fails here rather than four describes later on a count.
    expect(kprint.definitionHash).toBe(WASM_DEFINITION_HASH);
    expect(kprint.mainModule).toBe(WASM_CENSUS.mainModule);
    expect(kprint.backend).toBe("haskell");
    expect(kprint.definitionDir).toBe(WASM_HASKELL_KOMPILED_DIR);
    expect(kprint.conversionStrategy).toBe("pure-then-binary");
  });

  test("the definition behind it is the 2062-rule one, and `configVars.sh` was read", async () => {
    const kprint = await wasm();
    expect(kprint.definition.rules.length).toBe(WASM_CENSUS.rules);
    expect(kprint.definition.syntaxProductions.length).toBe(WASM_CENSUS.syntaxProductions);
    // `$PGM : Stmts` — the configuration variable that made `test.md` the right
    // module to kompile (`WASM_KOMPILE_ARGV`'s rationale).
    expect(kprint.kompiled.layout.hasConfigVarsFile).toBe(true);
    expect(kprint.kompiled.layout.configVars).toEqual(["PGM"]);
    expect([...kprint.kompiled.layout.configVarSorts]).toEqual([["PGM", "Stmts"]]);
  });
});

describe("the partial directory — what is absent, and the shape of saying so", () => {
  // The value here is precisely that `KPrint.load` *succeeds*.  pyk's
  // `KPrint.__init__` reads two markers and nothing else, and this package's
  // KORE artifacts are lazy getters; a directory with no `definition.kore` is
  // therefore a perfectly usable printer, and the failure is deferred to the
  // one caller that actually wants KORE.  Nothing in this repository had
  // demonstrated that before, because every other fixture is complete.

  test("load succeeds with neither KORE layer present", async () => {
    const kprint = await wasm();
    expect(kprint.kompiled.text("definition.kore")).toBeUndefined();
    expect(kprint.kompiled.text("syntaxDefinition.kore")).toBeUndefined();
    // …while the two artifacts that *are* vendored read normally.
    expect(kprint.kompiled.text("compiled.json")?.length).toBe(4_902_059);
    expect(kprint.kompiled.macrosKore.axioms.length).toBe(WASM_CENSUS.macroRules);
  });

  test("and each missing layer names itself when it is finally wanted", async () => {
    const kprint = await wasm();
    for (const artifact of ["definition.kore", "syntaxDefinition.kore"] as const) {
      const get =
        artifact === "definition.kore" ? () => kprint.kompiled.koreDefinition : () => kprint.kompiled.syntaxKore;
      expect(get).toThrow(MissingKompiledFileError);
      expect(get).toThrow(new RegExp(`Missing ${artifact.replace(".", "\\.")} in kompiled directory`, "u"));
      // Memoised negatively: the second ask is the same error, not a re-read.
      expect(get).toThrow(MissingKompiledFileError);
    }
  });
});

//////////////////////////////
// allRules.txt             //
//////////////////////////////

describe("allRules — the join `KPrint.all_rules` (kprint.py:222-236) exposes", () => {
  test("929 entries for 2062 rules: `allRules.txt` is not a list of all rules", async () => {
    const kprint = await wasm();
    expect(kprint.allRules.size).toBe(929);
    expect(kprint.kompiled.layout.allRules.size).toBe(929);
    // Equal sizes ⇒ no two `UNIQUE_ID`s collide in their first 12 characters,
    // which is the assumption pyk's prefix-keyed dict makes silently.
    for (const key of kprint.allRules.keys()) expect(key).toHaveLength(12);
    // Every line parsed: `file:line:col` split from the right, over 12
    // different source files whose paths are absolute and machine-specific —
    // hence a shape assertion and not a value one.
    for (const location of kprint.allRules.values()) {
      expect(Number.isInteger(location.line)).toBe(true);
      expect(Number.isInteger(location.column)).toBe(true);
      expect(isAbsolute(location.source)).toBe(true);
    }
    expect(new Set([...kprint.allRules.values()].map((l) => l.source)).size).toBe(12);
  });

  test("2062 rules carry only 2000 distinct UNIQUE_IDs, and 929 of those are locatable", async () => {
    // A finding, and one IMP is too small to produce.  A rule imported into
    // several modules appears once per module in `compiled.json` with the same
    // `UNIQUE_ID` — up to **six** times here — so "the rule with this id" is a
    // lookup that can return more than one, which is why {@link rule} checks.
    // And `allRules.txt` holds fewer than half of them: `kompile` writes a line
    // only for rules that reached the backend.
    const { definition, kompiled } = await wasm();
    const uids = definition.rules
      .map((r) => r.att.get(Atts.UNIQUE_ID))
      .filter((uid): uid is string => typeof uid === "string");
    expect(uids.length).toBe(WASM_CENSUS.rules);
    const distinct = new Set(uids);
    expect(distinct.size).toBe(2000);

    // Every `allRules.txt` entry belongs to a rule that is really in the
    // definition, and no entry is orphaned: the join is total in that
    // direction and partial in the other.
    const locatable = [...distinct].filter((uid) => lookupRule(kompiled.layout, uid) !== undefined);
    expect(locatable.length).toBe(kompiled.layout.allRules.size);
    expect(locatable.length).toBe(929);
  });
});

//////////////////////////////
// prettyPrint              //
//////////////////////////////

/** `emptyConfig(GeneratedTopCell)` — 26 cells, 4 of them nested two deep. */
const EMPTY_CONFIG = [
  "<generatedTop>",
  "  <wasm-test>",
  "    <k>",
  "      K_CELL",
  "    </k>",
  "    <wasm>",
  "      <instrs>",
  "        INSTRS_CELL",
  "      </instrs>",
  "      <valstack>",
  "        VALSTACK_CELL",
  "      </valstack>",
  "      <curFrame>",
  "        <locals>",
  "          LOCALS_CELL",
  "        </locals>",
  "        <curModIdx>",
  "          CURMODIDX_CELL",
  "        </curModIdx>",
  "      </curFrame>",
  "      <moduleRegistry>",
  "        MODULEREGISTRY_CELL",
  "      </moduleRegistry>",
  "      <moduleIds>",
  "        MODULEIDS_CELL",
  "      </moduleIds>",
  "      <moduleInstances>",
  "        MODULEINSTANCES_CELL",
  "      </moduleInstances>",
  "      <nextModuleIdx>",
  "        NEXTMODULEIDX_CELL",
  "      </nextModuleIdx>",
  "      <mainStore>",
  "        <funcs>",
  "          FUNCS_CELL",
  "        </funcs>",
  "        <nextFuncAddr>",
  "          NEXTFUNCADDR_CELL",
  "        </nextFuncAddr>",
  "        <tabs>",
  "          TABS_CELL",
  "        </tabs>",
  "        <nextTabAddr>",
  "          NEXTTABADDR_CELL",
  "        </nextTabAddr>",
  "        <mems>",
  "          MEMS_CELL",
  "        </mems>",
  "        <nextMemAddr>",
  "          NEXTMEMADDR_CELL",
  "        </nextMemAddr>",
  "        <globals>",
  "          GLOBALS_CELL",
  "        </globals>",
  "        <nextGlobAddr>",
  "          NEXTGLOBADDR_CELL",
  "        </nextGlobAddr>",
  "        <elems>",
  "          ELEMS_CELL",
  "        </elems>",
  "        <nextElemAddr>",
  "          NEXTELEMADDR_CELL",
  "        </nextElemAddr>",
  "      </mainStore>",
  "      <deterministicMemoryGrowth>",
  "        DETERMINISTICMEMORYGROWTH_CELL",
  "      </deterministicMemoryGrowth>",
  "    </wasm>",
  "  </wasm-test>",
  "  <generatedCounter>",
  "    GENERATEDCOUNTER_CELL",
  "  </generatedCounter>",
  "</generatedTop>",
].join("\n");

/**
 * `initConfig(GeneratedTopCell)` — the same shape with the cells' initialisers,
 * and the only place in this repository where **six** cell-collection units
 * (`.ModuleInstCellMap`, `.FuncDefCellMap`, `.TabInstCellMap`,
 * `.MemInstCellMap`, `.GlobalInstCellMap`, `.ElemInstCellMap`) are printed in
 * one term.  IMP's initial configuration has a `.Map` and nothing else.
 */
const INIT_CONFIG = EMPTY_CONFIG.replace("K_CELL", "$PGM")
  .replace("INSTRS_CELL", ".K")
  .replace("VALSTACK_CELL", ".ValStack")
  .replace("LOCALS_CELL", ".Map")
  .replace("CURMODIDX_CELL", ".Int")
  .replace("MODULEREGISTRY_CELL", ".Map")
  .replace("MODULEIDS_CELL", ".Map")
  .replace("MODULEINSTANCES_CELL", ".ModuleInstCellMap")
  .replace("NEXTMODULEIDX_CELL", "0")
  .replace("FUNCS_CELL", ".FuncDefCellMap")
  .replace("NEXTFUNCADDR_CELL", "0")
  .replace("TABS_CELL", ".TabInstCellMap")
  .replace("NEXTTABADDR_CELL", "0")
  .replace("MEMS_CELL", ".MemInstCellMap")
  .replace("NEXTMEMADDR_CELL", "0")
  .replace("GLOBALS_CELL", ".GlobalInstCellMap")
  .replace("NEXTGLOBADDR_CELL", "0")
  .replace("ELEMS_CELL", ".ElemInstCellMap")
  .replace("NEXTELEMADDR_CELL", "0")
  .replace("DETERMINISTICMEMORYGROWTH_CELL", "true")
  .replace("GENERATEDCOUNTER_CELL", "0");

describe("prettyPrint over real KWasm configurations", () => {
  test("emptyConfig(GeneratedTopCell) — 26 cells, exactly", async () => {
    const kprint = await wasm();
    expect(kprint.prettyPrint(kprint.definition.emptyConfig(TOP))).toBe(EMPTY_CONFIG);
  });

  test("initConfig(GeneratedTopCell) — six cell-collection units in one term", async () => {
    const kprint = await wasm();
    expect(kprint.prettyPrint(kprint.definition.initConfig(TOP))).toBe(INIT_CONFIG);
    // The `.XCellMap` units really are the cell collections' own, not an
    // accident of the string above.
    for (const production of kprint.definition.cellCollectionProductions) {
      expect(INIT_CONFIG).toContain(String(production.att.get(Atts.UNIT)));
    }
  });

  test("a sub-configuration prints on its own, as `inModule`-free re-rooting", async () => {
    const kprint = await wasm();
    expect(kprint.prettyPrint(kprint.definition.emptyConfig(ksort("CurFrameCell")))).toBe(
      [
        "<curFrame>",
        "  <locals>",
        "    LOCALS_CELL",
        "  </locals>",
        "  <curModIdx>",
        "    CURMODIDX_CELL",
        "  </curModIdx>",
        "</curFrame>",
      ].join("\n"),
    );
  });

  test("inModule re-roots a 99-module definition, and a bad module is refused", async () => {
    const kprint = await wasm();
    const config = kprint.definition.emptyConfig(TOP);
    expect(kprint.definition.allModules.length).toBe(WASM_CENSUS.modules);
    // `WASM` is a real module of this definition and the cell productions are
    // reachable from it, so the term is unaffected — the observable is that the
    // lookup succeeded at all, at 99 modules.
    expect(kprint.prettyPrint(config, { inModule: "WASM" })).toBe(EMPTY_CONFIG);
    expect(() => kprint.prettyPrint(config, { inModule: "NO-SUCH-MODULE" })).toThrow(/Module not found/u);
    // Each `inModule` is a separately memoised printer, so the unrestricted one
    // still works after a failing one.
    expect(kprint.prettyPrint(config)).toBe(EMPTY_CONFIG);
  });
});

//////////////////////////////
// The bulk sweep           //
//////////////////////////////

describe("prettyPrint and formatPrint over all 4124 rule sides", () => {
  test("prettyPrint prints every one of them, twice, byte for byte", async () => {
    // Determinism is not free: `Formatter.indent` is instance state that is not
    // reset between calls, and `KPrint` memoises one printer per option key and
    // reuses it for every term.  A definition whose `%i`/`%d` did not balance
    // would make the second pass disagree with the first — which is exactly
    // what a 4124-term sweep through *one* printer detects and a per-term
    // printer would hide.
    const kprint = await wasm();
    const all = await ruleSides();
    expect(all.length).toBe(2 * WASM_CENSUS.rules);
    const first = all.map((side) => kprint.prettyPrint(side));
    const second = all.map((side) => kprint.prettyPrint(side));
    expect(second).toEqual(first);
    expect(first.every((text) => text.length > 0)).toBe(true);
  });

  test("formatPrint prints 4117 and refuses the 7 KAs sides, deterministically", async () => {
    const kprint = await wasm();
    const all = await ruleSides();
    const run = (): { readonly texts: (string | undefined)[]; readonly errors: string[] } => {
      const texts: (string | undefined)[] = [];
      const errors: string[] = [];
      for (const side of all) {
        try {
          texts.push(kprint.formatPrint(side));
        } catch (error) {
          texts.push(undefined);
          errors.push(error instanceof Error ? error.message : String(error));
        }
      }
      return { texts, errors };
    };
    const first = run();
    expect(first.texts.filter((t) => t !== undefined).length).toBe(4117);
    expect(new Set(first.errors)).toEqual(new Set(["Unsupported term: KAs"]));
    expect(first.errors.length).toBe(7);
    expect(run().texts).toEqual(first.texts);
  });

  test("the two printers disagree on 707 of the 4117 — the split is not cosmetic", async () => {
    // The reason `KPrint` exposes both.  `prettyPrint` drives a `label →
    // unparser` symbol table; `formatPrint` renders each production's own
    // `format` attribute.  On IMP the two agree on very nearly everything,
    // which is why the choice between them has never mattered in this
    // repository.  At 1784 productions it matters for one side in six.
    const kprint = await wasm();
    const all = await ruleSides();
    let compared = 0;
    let differing = 0;
    for (const side of all) {
      let formatted: string;
      try {
        formatted = kprint.formatPrint(side);
      } catch {
        continue;
      }
      compared += 1;
      if (formatted !== kprint.prettyPrint(side)) differing += 1;
    }
    expect(compared).toBe(4117);
    expect(differing).toBe(707);
  });

  test("formatPrint drops the generated wrapper cells `prettyPrint` keeps", async () => {
    // Stated because it looks like a KWasm bug and is not one: IMP's build does
    // the same, so this is `Formatter`'s treatment of `<generatedTop>`'s
    // `format`, not anything this definition's size provoked.  Pinned here
    // because `KPrint` is where a caller *chooses* between the two printers and
    // needs to know they do not agree about what a configuration is.
    const kprint = await wasm();
    const config = kprint.definition.initConfig(TOP);
    const formatted = kprint.formatPrint(config);
    expect(formatted.startsWith("<wasm-test>")).toBe(true);
    expect(formatted).not.toContain("<generatedTop>");
    expect(formatted).not.toContain("<generatedCounter>");
    // …and what it *does* print is `prettyPrint`'s output with the wrapper's
    // first line, its last four, and one level of indentation removed — so the
    // divergence is exactly the wrapper and nothing else.
    expect(formatted).toBe(
      INIT_CONFIG.split("\n")
        .slice(1, -4)
        .map((line) => line.slice(2))
        .join("\n"),
    );
  });
});

//////////////////////////////
// The option surface       //
//////////////////////////////

describe("prettyPrint options against real data", () => {
  test("`sortCollections: true` rewrites exactly three of the 4124 sides", async () => {
    const kprint = await wasm();
    const all = await ruleSides();
    let changed = 0;
    for (const side of all) {
      if (kprint.prettyPrint(side, { sortCollections: true }) !== kprint.prettyPrint(side)) changed += 1;
    }
    // Three, not seven.  `sortAcCollections` changes seven rule *bodies* here
    // (`packages/kast/test/wasm-definition.test.ts`), but four of those changes
    // are re-associations of `assoc` cell collections, and association is
    // invisible in the printed text.  Only a genuine **reordering** survives to
    // this layer, which is the thing a caller of `sortCollections` is actually
    // buying.
    expect(changed).toBe(3);
  });

  test("…and this is what those three look like", async () => {
    const kprint = await wasm();
    const cases: readonly (readonly [string, string, string])[] = [
      [
        "c396521bfe7afc5f27d6c4e4961517fb7cb16925205484f669d867e352bfd7f8",
        "IDENT:Identifier |-> N:Int #ids2Idxs ( N:Int +Int 1 , .TypeDecls , LDS:LocalDecls )",
        "#ids2Idxs ( N:Int +Int 1 , .TypeDecls , LDS:LocalDecls ) IDENT:Identifier |-> N:Int",
      ],
      [
        "fb4bc43cfe9c11974b27a0a7809b6ac15554dd8b3c2154704a9e7df96dce3b33",
        "IDENT:Identifier |-> N:Int #ids2Idxs ( N:Int +Int 1 , TDS:TypeDecls , LDS:LocalDecls )",
        "#ids2Idxs ( N:Int +Int 1 , TDS:TypeDecls , LDS:LocalDecls ) IDENT:Identifier |-> N:Int",
      ],
      [
        "c384edb8f3875244a593dda6163c3dee1bce5485e4e1848892aebc2bab67d2e9",
        "S1:Set S2:Set -Set S1:Set",
        "S2:Set -Set S1:Set S1:Set",
      ],
    ];
    const rules = await Promise.all(cases.map(([uid]) => rule(uid)));
    for (const [index, [, before, after]] of cases.entries()) {
      const side = extractRhs(rules[index]!.body);
      expect(kprint.prettyPrint(side)).toBe(before);
      expect(kprint.prettyPrint(side, { sortCollections: true })).toBe(after);
    }
  });

  test("`unalias: false` is inert here, because KWasm has no alias rule", async () => {
    // The honest form of "untested": `undoAliases` has never had an alias to
    // undo anywhere in this repository (`WASM_CENSUS.aliasRules` is 0 and is
    // kept for exactly this reason), so what this pins is that the *default*
    // `unalias: true` costs nothing on 4124 real terms rather than that the
    // pass works.
    const kprint = await wasm();
    const all = await ruleSides();
    expect(kprint.definition.aliasRules.length).toBe(WASM_CENSUS.aliasRules);
    for (const side of all) expect(kprint.prettyPrint(side, { unalias: false })).toBe(kprint.prettyPrint(side));
  });
});

//////////////////////////////
// The symbol table         //
//////////////////////////////

describe("patchSymbolTable — the hook, and what overloading does to it", () => {
  test("the table it hands the hook is 1808 unparsers, and here is where they come from", async () => {
    let seen: SymbolTable | undefined;
    const kprint = await printerOver({
      patchSymbolTable: (table) => {
        seen = table;
      },
    });
    kprint.prettyPrint(cons(STMTS));
    const table = seen ?? {};
    expect(Object.keys(table).length).toBe(1808);
    for (const unparser of Object.values(table)) expect(typeof unparser).toBe("function");

    // 1808 is neither 1784 nor 1901, and the arithmetic is worth stating
    // because both wrong answers are plausible.  `buildSymbolTable` walks
    // `allModules` — all 99, not the 63 the main module imports — so it sees
    // 1901 productions rather than `syntaxProductions`' 1784; those 1901 carry
    // only 1802 distinct klabels, the repeats being silently overwritten by
    // whichever module comes last; and 6 `symbol(...)` attributes name
    // something that is not itself a klabel and add a second key each.
    const productions = kprint.definition.allModules.flatMap((module) => [...moduleSyntaxProductions(module)]);
    expect(productions.length).toBe(1901);
    expect(kprint.definition.syntaxProductions.length).toBe(WASM_CENSUS.syntaxProductions);
    const klabels = new Set(productions.map((production) => production.klabel?.name));
    expect(klabels.size).toBe(1802);
    const aliases = productions
      .map((production) => production.att.get(Atts.SYMBOL))
      .filter((symbol): symbol is string => typeof symbol === "string");
    expect(new Set(aliases).size).toBe(361);
    expect(new Set(aliases.filter((symbol) => !klabels.has(symbol))).size).toBe(6);
    expect(new Set([...klabels, ...aliases]).size).toBe(Object.keys(table).length);
  });

  test("patching an overloaded symbol does NOT reach its overloaders", async () => {
    // The finding this whole file's overload coverage exists for, and one IMP
    // structurally cannot produce.  `Stmts ::= Stmt Stmts` is `overload`ed by
    // the `Defns`, `Instrs` and `EmptyStmts` conses — `kompile` gives all four
    // the same `format`, so all four print identically by default, and a reader
    // of the output cannot tell them apart.  A symbol table, though, is keyed
    // by **klabel**: patching the general symbol changes one of the four and
    // leaves the other three printing the old way.  So `patchSymbolTable` is
    // not overload-aware, and a KEVM-style consumer that patches a symbol which
    // happens to be overloaded gets inconsistent output rather than an error.
    const kprint = await printerOver({
      patchSymbolTable: (table) => {
        table[STMTS] = assocWithUnit(" ;; ", "");
      },
    });
    expect(kprint.prettyPrint(cons(STMTS))).toBe("S ;; SS");
    for (const overloader of [DEFNS, INSTRS, EMPTY_STMTS]) {
      expect(kprint.prettyPrint(cons(overloader))).toBe("S  SS");
    }
    // And unpatched, all four agree — the two spaces are the empty terminal of
    // `Stmt "" Stmts` under the default `%1 %2 %3`.
    const plain = await wasm();
    for (const label of [STMTS, DEFNS, INSTRS, EMPTY_STMTS]) expect(plain.prettyPrint(cons(label))).toBe("S  SS");
    // `overloads` does know about the relation; the printer simply does not
    // consult it.
    expect([...(plain.definition.overloads.get(STMTS) ?? [])].toSorted()).toEqual(
      [DEFNS, EMPTY_STMTS, INSTRS].toSorted(),
    );
  });

  test("the hook runs once per printer key, not once per call", async () => {
    // `KPrint` memoises a `PrettyPrinter` per `(inModule, unalias,
    // sortCollections)`, and building one walks every production of every
    // module in scope — 1901 of them here, across 99 modules, which is why the
    // memo exists at all.
    let runs = 0;
    const kprint = await printerOver({
      patchSymbolTable: () => {
        runs += 1;
      },
    });
    const term = cons(STMTS);
    kprint.prettyPrint(term);
    kprint.prettyPrint(term);
    expect(runs).toBe(1);
    kprint.prettyPrint(term, { sortCollections: true });
    expect(runs).toBe(2);
    kprint.prettyPrint(term, { inModule: "WASM" });
    expect(runs).toBe(3);
    kprint.prettyPrint(term, { inModule: "WASM" });
    expect(runs).toBe(3);
  });

  test("formatPrint still refuses the hook, at 1784 productions as at 273", async () => {
    const kprint = await printerOver({
      patchSymbolTable: () => {
        // Deliberately empty: the refusal is about the option being *present*.
      },
    });
    expect(() => kprint.formatPrint(kprint.definition.emptyConfig(TOP))).toThrow(/no symbol table to patch/u);
  });
});

//////////////////////////////
// The pure conversion lane //
//////////////////////////////

describe("kastToKore / koreToKast / koreToPretty with no child process", () => {
  test("a real KWasm configuration goes to KORE and comes back", async () => {
    const kprint = await pure();
    const config = kprint.definition.initConfig(TOP);
    const kore = await kprint.kastToKore(config, { sort: TOP });
    expect(kore.tag).toBe("App");
    expect(kore.tag === "App" ? kore.symbol : undefined).toBe("Lbl'-LT-'generatedTop'-GT-'");
    // 26 cells, six of them cell-collection units, all the way down and back.
    expect((await kprint.koreToKast(kore)).node).toBe("KApply");
  });

  test("…but not unchanged: KORE round-tripping *adds* the variable's sort", async () => {
    // A finding, and the reason `test/kprint.test.ts`'s `toEqual` round-trip
    // could never have caught it: its terms are `krun` outputs, which have no
    // variables at all.  `initConfig` produces `$PGM` with no sort; `konvert`
    // writes it to KORE as a `SortK{}` variable and reads it back *sorted*, so
    // the round trip is idempotent but not the identity, and the difference is
    // visible in the printed text.
    const kprint = await pure();
    const config = kprint.definition.initConfig(TOP);
    const back = await kprint.koreToKast(await kprint.kastToKore(config, { sort: TOP }));
    expect(kprint.prettyPrint(config)).toBe(INIT_CONFIG);
    expect(kprint.prettyPrint(back)).toBe(INIT_CONFIG.replace("$PGM", "$PGM:K"));
    // Idempotent from the second pass on.
    const twice = await kprint.koreToKast(await kprint.kastToKore(back, { sort: TOP }));
    expect(kprint.prettyPrint(twice)).toBe(kprint.prettyPrint(back));
  });

  test("koreToPretty({ pykPrint: true }) is that composition, and starts nothing", async () => {
    // pyk's `kore_to_pretty` shells out; under `conversionStrategy: 'pure'`
    // this route is `koreToKast` + `prettyPrint` in process, which is the whole
    // reason the partial directory is usable at all.  A `runner` that would
    // throw proves no child was even considered.
    const kprint = await printerOver({
      conversionStrategy: "pure",
      runner: () => {
        throw new Error("no child process should be spawned");
      },
    });
    const kore = await kprint.kastToKore(kprint.definition.initConfig(TOP), { sort: TOP });
    expect(await kprint.koreToPretty(kore, { pykPrint: true })).toBe(INIT_CONFIG.replace("$PGM", "$PGM:K"));
  });
});

//////////////////////////////
// definition-cache at 5 MB //
//////////////////////////////

/**
 * `test/definition-cache.test.ts` pins the cache's three observable behaviours
 * — instance identity, `timestamp` staleness, and "a failed load is not
 * cached" — against a 1.4 MB IMP directory.  This is the same three at 4.9 MB,
 * plus the one question only a big definition can ask: that what the cache
 * shares is a **parse**, not just a directory handle.
 *
 * The counters are process-global, so everything here clears and resets around
 * itself; the rest of this file stays out of the cache entirely
 * (`cacheDefinition: false`).
 */
describe("definition-cache over the 4.9 MB definition", () => {
  const scratch: string[] = [];

  beforeEach(() => {
    clearKompiledDefinitionCache();
    resetKompiledDefinitionCacheStats();
  });

  afterAll(async () => {
    clearKompiledDefinitionCache();
    resetKompiledDefinitionCacheStats();
    await Promise.all(scratch.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  async function copyFixture(): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), "ktool-wasm-defcache-"));
    scratch.push(root);
    const dir = join(root, "wasm-haskell-kompiled");
    await cp(WASM_HASKELL_KOMPILED_DIR, dir, { recursive: true });
    return dir;
  }

  test("the 4.9 MB definition round-trips, and the second caller shares the parse", async () => {
    const first = await loadKompiledDefinitionCached(WASM_HASKELL_KOMPILED_DIR);
    // Touch the expensive getters *before* the second load, so that what the
    // identity assertions below prove is that 1784 productions and 2062 rules
    // were built once, not that two handles point at one path.
    expect(first.definition.rules.length).toBe(WASM_CENSUS.rules);
    expect(first.definitionHash).toBe(WASM_DEFINITION_HASH);

    const second = await loadKompiledDefinitionCached(WASM_HASKELL_KOMPILED_DIR);
    expect(second).toBe(first);
    expect(second.definition).toBe(first.definition);
    expect(second.definitionHash).toBe(WASM_DEFINITION_HASH);
    expect(kompiledDefinitionCacheStats()).toMatchObject({ hits: 1, misses: 1, staleReloads: 0, entries: 1 });
  });

  test("five concurrent callers parse it once", async () => {
    const all = await Promise.all([1, 2, 3, 4, 5].map(() => loadKompiledDefinitionCached(WASM_HASKELL_KOMPILED_DIR)));
    const head = await loadKompiledDefinitionCached(WASM_HASKELL_KOMPILED_DIR);
    for (const one of all) expect(one).toBe(head);
    expect(kompiledDefinitionCacheStats().misses).toBe(1);
    expect(new Set(all.map((k) => k.definition)).size).toBe(1);
  });

  test("touching `timestamp` reparses, and the identity survives the reparse", async () => {
    const dir = await copyFixture();
    const first = await loadKompiledDefinitionCached(dir);
    expect(first.definitionHash).toBe(WASM_DEFINITION_HASH);

    const later = new Date(Date.now() + 5_000);
    await utimes(join(dir, "timestamp"), later, later);

    const second = await loadKompiledDefinitionCached(dir);
    expect(second).not.toBe(first);
    expect(second.definition).not.toBe(first.definition);
    // A different parse of the same bytes is the same definition — which is the
    // whole premise of keying the cache on a marker's mtime rather than on
    // content.
    expect(second.definitionHash).toBe(first.definitionHash);
    expect(kompiledDefinitionCacheStats()).toMatchObject({ hits: 0, misses: 1, staleReloads: 1, entries: 1 });
  });

  test("the partial directory is cacheable — the missing KORE layers are not marker files", async () => {
    // The question the task shape invites: does `definition-cache` need
    // something this directory lacks?  It does not.  What it `stat`s is
    // `timestamp`, and what `loadKompiledDefinition` requires is the marker
    // set — `mainModule.txt`, `backend.txt`, `mainSyntaxModule.txt` — all of
    // which are vendored.  `definition.kore` and `syntaxDefinition.kore` are
    // lazy getters and stay absent, cached negatively along with everything
    // else.
    const cached = await loadKompiledDefinitionCached(WASM_HASKELL_KOMPILED_DIR);
    expect(cached.layout.mainModule).toBe(WASM_CENSUS.mainModule);
    expect(() => cached.koreDefinition).toThrow(MissingKompiledFileError);
    // …and the shared instance is still shared afterwards: a thrown getter does
    // not evict the entry.
    expect(await loadKompiledDefinitionCached(WASM_HASKELL_KOMPILED_DIR)).toBe(cached);
    expect(kompiledDefinitionCacheStats().entries).toBe(1);
  });

  test("a copy with no `timestamp` raises and is not cached", async () => {
    const dir = await copyFixture();
    await rm(join(dir, "timestamp"));

    await caughtAsync(loadKompiledDefinitionCached(dir), MissingKompiledFileError);
    expect(kompiledDefinitionCacheStats().entries).toBe(0);

    await cp(join(WASM_HASKELL_KOMPILED_DIR, "timestamp"), join(dir, "timestamp"));
    const recovered = await loadKompiledDefinitionCached(dir);
    expect(recovered.path).toBe(dir);
    expect(recovered.definition.rules.length).toBe(WASM_CENSUS.rules);
  });

  test("KPrint.load goes through it, and `cacheDefinition: false` opts out", async () => {
    const a = await KPrint.load(WASM_HASKELL_KOMPILED_DIR);
    const b = await KPrint.load(WASM_HASKELL_KOMPILED_DIR);
    expect(b.kompiled).toBe(a.kompiled);
    expect(b.definition).toBe(a.definition);
    expect(b).not.toBe(a);

    const own = await KPrint.load(WASM_HASKELL_KOMPILED_DIR, { cacheDefinition: false });
    expect(own.kompiled).not.toBe(a.kompiled);
    // Same content, independently parsed — a distinct 1784-production object.
    expect(own.definition).not.toBe(a.definition);
    expect(own.definitionHash).toBe(WASM_DEFINITION_HASH);
    // The file's own printer took this branch too, and is therefore not in the
    // cache — which is what keeps `test/definition-cache.test.ts`'s absolute
    // counters honest.
    expect((await wasm()).kompiled).not.toBe(a.kompiled);
  });
});
