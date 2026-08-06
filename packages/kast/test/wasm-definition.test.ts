/**
 * `kast` against a definition IMP cannot be: KWasm.
 *
 * # Why this file exists
 *
 * Every other fixture in this suite is either hand-built or `imp.k`, and IMP
 * has **zero** overloads, **zero** cell collections and **zero** macro rules.
 * So four of `outer.ts`'s indices, two of `manip.ts`'s passes and `formatter.ts`
 * itself had never in this repository met anything `kompile` produced at scale —
 * only reconstructions written here from upstream's test sources:
 *
 * | code path                                                            | what it had seen before                                    |
 * | -------------------------------------------------------------------- | ------------------------------------------------------------ |
 * | `KDefinition.overloads` (`outer.py:1266-1305`)                       | `test/definition-indices.test.ts:700`, a 5-production lattice |
 * | `cellCollectionProductions` / `cellMapItemInfo` (`outer.py:1133-1155`) | nothing — no fixture declared `cellCollection`               |
 * | the `CellMap_` branch of `sortAcCollections` (`manip.py:86-94`)       | `test/pretty-parity.test.ts`'s `_AccountCellMap_`, by hand   |
 * | `inlineCellMaps` (`manip.py:401-418`)                                | `test/manip-parity.test.ts:419`'s `<accountCellMapItem>`      |
 * | `KDefinition.macro_rules` (`outer.py:1167-1170`)                     | nothing — IMP has no `macro`                                 |
 * | `formatter.ts` end to end                                            | 3 IMP rows and 13 hand-built bracket rows, 273 productions   |
 *
 * KWasm supplies all six: 6 overloads, 6 cell collections, 13 macro rules,
 * 1784 syntax productions over 302 sorts, and 2062 rules — 4124 rule sides for
 * the formatter to chew on.
 *
 * # Provenance
 *
 * `@kframework-ts/wasm-fixtures` — a **dev** dependency, private and never
 * published — owns the bytes: `runtimeverification/wasm-semantics`' `test.md`
 * at `v0.1.156`, `kompile --backend haskell --emit-json` at K `v7.1.337`.
 * `packages/wasm-fixtures/fixtures/PROVENANCE.md` is the canonical account and
 * `packages/wasm-fixtures/test/artifact.test.ts` re-derives every number in
 * `WASM_CENSUS` from the committed file, so nothing here restates the census —
 * this file asserts the **identity** (one hash) and then pins *contents*, which
 * counts cannot.
 *
 * Hermetic: 4.9 MB of JSON off disk, no K install, no network.  That parse is
 * ~130 ms and is done once, at module level, exactly as
 * `packages/konvert/test/wasm-soak.test.ts` does it.
 *
 * # Upstream has none of this
 *
 * pyk never runs a unit test against a real `compiled.json`; its equivalents
 * are integration tests that shell out to `kompile`.  There is therefore no
 * upstream table to transcribe here, and every expectation below was measured
 * from the vendored bytes.  Bulk sweeps assert invariants (no-throw,
 * idempotence, round-trip); single terms are pinned exactly and are selected by
 * `UNIQUE_ID` rather than by index so a re-ordering of the definition's rules
 * fails loudly instead of silently pinning a different rule.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { WASM_CENSUS, WASM_DEFINITION_HASH, WASM_HASKELL_KOMPILED_DIR } from "@kframework-ts/wasm-fixtures";

import { Atts } from "../src/att.ts";
import { eq } from "../src/eq.ts";
import { DEFAULT_BRACKET_LABEL, Formatter, addBrackets } from "../src/formatter.ts";
import { flattenLabel, kapply, ksort, kvariable, type KInner } from "../src/inner.ts";
import { extractLhs, extractRhs, inlineCellMaps, sortAcCollections, sortAssocLabel } from "../src/manip.ts";
import {
  bracketLabelName,
  productionDefaultFormat,
  productionIsFunction,
  readKastDefinitionFromJson,
  type KDefinition,
  type KProduction,
  type KRule,
} from "../src/outer.ts";
import { PrettyPrinter } from "../src/pretty.ts";

//////////////////////////////////////////////////////////
// The definition, and the vocabulary for talking about it //
//////////////////////////////////////////////////////////

/** The vendored KWasm definition, parsed once for the whole file. */
const WASM: KDefinition = readKastDefinitionFromJson(
  readFileSync(join(WASM_HASKELL_KOMPILED_DIR, "compiled.json"), "utf8"),
);

const FORMATTER = new Formatter(WASM);
const PRETTY = new PrettyPrinter(WASM);

/**
 * The rule carrying `UNIQUE_ID(uid)`.
 *
 * Rules are named by their `UNIQUE_ID` rather than by their index in
 * {@link KDefinition.rules} so that a pin says *which* rule it is about and a
 * changed definition fails on the lookup instead of quietly pinning a
 * different rule.  `UNIQUE_ID` is `kompile`'s, and stable for these bytes;
 * `source`/`location` are not usable for the purpose, because every one of them
 * holds the absolute path of the machine that ran `kompile`.
 */
function rule(uid: string): KRule {
  const found = WASM.rules.filter((r) => r.att.get(Atts.UNIQUE_ID) === uid);
  expect(found.length).toBe(1);
  return found[0]!;
}

/** Every subterm of `term`, parents before children. */
function subterms(term: KInner, out: KInner[] = []): KInner[] {
  out.push(term);
  switch (term.node) {
    case "KApply":
      for (const arg of term.args) subterms(arg, out);
      break;
    case "KSequence":
      for (const item of term.items) subterms(item, out);
      break;
    case "KRewrite":
      subterms(term.lhs, out);
      subterms(term.rhs, out);
      break;
    case "KAs":
      subterms(term.pattern, out);
      subterms(term.alias, out);
      break;
    case "KToken":
    case "KVariable":
      break;
  }
  return out;
}

/** The symbol at the head of a rule body, looking through the rewrite. */
function topLabel(term: KInner): string {
  if (term.node === "KRewrite") return topLabel(term.lhs);
  return term.node === "KApply" ? term.label.name : term.node;
}

/** The five attributes `_cell_map_item_info` (`outer.py:1138-1155`) reads. */
function cellCollectionSummary(production: KProduction): Record<string, unknown> {
  return {
    sort: production.sort.name,
    klabel: production.klabel?.name,
    wrapElement: production.att.get(Atts.WRAP_ELEMENT),
    element: production.att.get(Atts.ELEMENT),
    unit: production.att.get(Atts.UNIT),
  };
}

/** `kompile`'s name for the unit of the user list whose cons is `cons`. */
function listUnitLabel(cons: string): string {
  return `.List{${JSON.stringify(cons)}}_${cons.split("_").at(-1) ?? ""}`;
}

/** `label(S, SS)` — a list cons applied to two variables. */
function consOf(label: string): KInner {
  return kapply(label, [kvariable("S"), kvariable("SS")]);
}

/** Lexicographic, for the `toSorted` calls whose elements are arrays. */
function byJson(a: unknown, b: unknown): number {
  return JSON.stringify(a).localeCompare(JSON.stringify(b));
}

/**
 * The 4124 sides of the 2062 rules — `extractLhs`/`extractRhs` of every body.
 *
 * This is what the formatter is actually pointed at: `Formatter` cannot print a
 * `KRewrite` (`formatter.py:90` raises), and 2055 of the 2062 bodies are one,
 * so a sweep over bodies would measure nothing but that.
 */
const RULE_SIDES: readonly KInner[] = WASM.rules.flatMap((r) => [extractLhs(r.body), extractRhs(r.body)]);

//////////////////////////////
// Identity                 //
//////////////////////////////

describe("the definition under test", () => {
  test("is the build wasm-fixtures pins, and nothing else", () => {
    // `KAst.hash` — pyk's `KPrint.definition_hash` (`ktool/kprint.py:238-240`).
    // One equality is the whole guard: a different K release or a different
    // `wasm-semantics` commit fails here rather than three describes later
    // with a confusing count.
    expect(WASM.hash).toBe(WASM_DEFINITION_HASH);
    expect(WASM.mainModuleName).toBe(WASM_CENSUS.mainModule);
  });

  test("has the four things IMP has none of", () => {
    // Not a census — `packages/wasm-fixtures/test/artifact.test.ts` re-derives
    // that from the same bytes.  These four are the sizes the tables *below*
    // are written to, restated here so a drift names itself.
    expect(WASM.overloads.size).toBe(WASM_CENSUS.overloads);
    expect(WASM.cellCollectionProductions.length).toBe(WASM_CENSUS.cellCollectionProductions);
    expect(WASM.macroRules.length).toBe(WASM_CENSUS.macroRules);
    expect(WASM.rules.length).toBe(WASM_CENSUS.rules);
    expect(RULE_SIDES.length).toBe(2 * WASM_CENSUS.rules);
  });
});

//////////////////////////////
// Overloads                //
//////////////////////////////

describe("overloads (outer.py:1266-1305)", () => {
  const table = (): Record<string, readonly string[]> =>
    Object.fromEntries([...WASM.overloads].map(([key, value]) => [key, [...value].toSorted()]));

  const DEFNS = "___WASM-COMMON-SYNTAX_Defns_Defn_Defns";
  const INSTRS = "___WASM-COMMON-SYNTAX_Instrs_Instr_Instrs";
  const STMTS = "___WASM-COMMON-SYNTAX_Stmts_Stmt_Stmts";
  const EMPTY = "___WASM-COMMON-SYNTAX_EmptyStmts_EmptyStmt_EmptyStmts";

  test("all six entries, keyed by the overloaded (general) symbol", () => {
    expect(table()).toEqual({
      [STMTS]: [DEFNS, EMPTY, INSTRS].toSorted(),
      [DEFNS]: [EMPTY],
      [INSTRS]: [EMPTY],
      [listUnitLabel(STMTS)]: [listUnitLabel(DEFNS), listUnitLabel(INSTRS), '.List{"listStmt"}'].toSorted(),
      [listUnitLabel(DEFNS)]: ['.List{"listStmt"}'],
      [listUnitLabel(INSTRS)]: ['.List{"listStmt"}'],
    });
  });

  test("all of it comes from one `overload(listStmt)` group of eight productions", () => {
    const group = WASM.syntaxProductions.filter((p) => p.att.get(Atts.OVERLOAD) !== undefined);
    expect(group.length).toBe(8);
    expect(new Set(group.map((p) => p.att.get(Atts.OVERLOAD)))).toEqual(new Set(["listStmt"]));
    // Six of the eight are keys; the two `EmptyStmts` productions are the
    // bottom of the lattice and overload nothing, which is why `overloads.size`
    // is 6 and not 8.
    expect(group.filter((p) => WASM.overloads.has(p.klabel!.name)).length).toBe(6);
  });

  test("the ordering is the definition's own subsort lattice, pointwise", () => {
    // `Stmts ::= Defns | Instrs`, `Defns ::= EmptyStmts`, `Instrs ::=
    // EmptyStmts`.  The `Stmts` cons therefore lists the `EmptyStmts` cons as
    // an overloader even though `EmptyStmts < Stmts` is two subsort steps —
    // real evidence that `_overloads` compares sorts through
    // `isStrictSubsort` (the transitive relation) and not through the
    // immediate-subsort productions.
    expect([...WASM.subsorts(ksort("Stmts"))].map((s) => s.name).toSorted()).toEqual(["Defns", "EmptyStmts", "Instrs"]);
    expect([...WASM.subsorts(ksort("Defns"))].map((s) => s.name)).toEqual(["EmptyStmts"]);
    expect(WASM.subsorts(ksort("EmptyStmts")).length).toBe(0);
    expect([...(WASM.overloads.get(STMTS) ?? [])]).toContain(EMPTY);
  });

  test("the relation is a strict order — no symbol overloads itself", () => {
    for (const [overloaded, overloaders] of WASM.overloads) {
      expect(overloaders.has(overloaded)).toBe(false);
    }
  });

  test("both halves of the group print, and print the same way", () => {
    // The overload group is the list cons of three different sorts; `kompile`
    // gives all three the same `format`, so the printed form carries no trace
    // of which one a term was built from.  That is the property `overloads`
    // exists to recover, and it is worth having stated once against real data.
    // Two spaces: the production is `Stmt "" Stmts` — an empty terminal
    // between the two non-terminals — and the default format is `%1 %2 %3`.
    expect(FORMATTER.format(consOf(STMTS))).toBe("S  SS");
    expect(FORMATTER.format(consOf(DEFNS))).toBe("S  SS");
    expect(FORMATTER.format(consOf(INSTRS))).toBe("S  SS");
    expect(FORMATTER.format(consOf(EMPTY))).toBe("S  SS");
  });
});

//////////////////////////////
// Cell collections         //
//////////////////////////////

describe("cellCollectionProductions / cellMapItemInfo (outer.py:1133-1155)", () => {
  test("all six, with the attributes `_cell_map_item_info` reads", () => {
    const summaries = WASM.cellCollectionProductions
      .map((production) => cellCollectionSummary(production))
      .toSorted((a, b) => String(a["sort"]).localeCompare(String(b["sort"])));
    expect(summaries).toEqual(
      ["ElemInst", "FuncDef", "GlobalInst", "MemInst", "ModuleInst", "TabInst"].map((base) => ({
        sort: `${base}CellMap`,
        klabel: `_${base}CellMap_`,
        wrapElement: `<${base.charAt(0).toLowerCase()}${base.slice(1)}>`,
        element: `${base}CellMapItem`,
        unit: `.${base}CellMap`,
      })),
    );
  });

  test("cellMapItemInfo is that table keyed by the wrapped cell", () => {
    const info = [...WASM.cellMapItemInfo].map(([cell, [ctor, sort]]) => [cell, ctor, sort.name]).toSorted(byJson);
    expect(info).toEqual([
      ["<elemInst>", "ElemInstCellMapItem", "ElemInstCellMap"],
      ["<funcDef>", "FuncDefCellMapItem", "FuncDefCellMap"],
      ["<globalInst>", "GlobalInstCellMapItem", "GlobalInstCellMap"],
      ["<memInst>", "MemInstCellMapItem", "MemInstCellMap"],
      ["<moduleInst>", "ModuleInstCellMapItem", "ModuleInstCellMap"],
      ["<tabInst>", "TabInstCellMapItem", "TabInstCellMap"],
    ]);
  });

  test("the two suffixes hard-coded across the package really are kompile's", () => {
    // `manip.ts:773` tests `endsWith('CellMapItem')`, `manip.ts:1232` tests
    // `endsWith('CellMap_')`, and `outer.ts:1050` tests both.  Three string
    // literals, and until now nothing in this repository had ever confronted
    // them with a name `kompile` generated.  Note the shape: the element
    // constructor is `TabInstCellMapItem`, *without* angle brackets, where
    // `test/manip-parity.test.ts:419`'s hand-built term (pyk's own
    // `test_manip.py` datum) writes `<accountCellMapItem>`.  Both satisfy the
    // predicate, which is the only reason the hand-built row was ever a
    // faithful test.
    for (const [cell, [ctor]] of WASM.cellMapItemInfo) {
      expect(cell.startsWith("<")).toBe(true);
      expect(ctor.endsWith("CellMapItem")).toBe(true);
      expect(ctor.startsWith("<")).toBe(false);
    }
    for (const production of WASM.cellCollectionProductions) {
      expect(production.klabel!.name.endsWith("CellMap_")).toBe(true);
    }
  });

  test("the twelve generated constructors carry `function` and are not functions", () => {
    // `productionIsFunction` (`outer.py:861-883`) exists to exclude exactly
    // these.  IMP declares none, so the exclusion had never fired on real data.
    const generated = WASM.syntaxProductions.filter(
      (p) => p.klabel!.name.endsWith("CellMapItem") || p.klabel!.name.endsWith("CellMap_"),
    );
    expect(generated.length).toBe(12);
    expect(generated.every((p) => p.att.has(Atts.FUNCTION))).toBe(true);
    expect(generated.some((p) => productionIsFunction(p))).toBe(false);
    expect(generated.every((p) => WASM.constructors.includes(p))).toBe(true);
    // The six `.XCellMap` units are *not* excluded — they end in neither
    // suffix — so they stay functions.  Stated because it looks like an
    // oversight and is upstream's behaviour.
    const units = WASM.syntaxProductions.filter((p) => /^\.\w+CellMap$/u.test(p.klabel!.name));
    expect(units.length).toBe(6);
    expect(units.every((p) => productionIsFunction(p))).toBe(true);
    expect(WASM.functions.length + WASM.constructors.length).toBe(WASM_CENSUS.syntaxProductions);
  });
});

describe("addCellMapItems / removeCellMapItems / inlineCellMaps over real rules", () => {
  test("every rule body round-trips, and 67 of them have something to round-trip", () => {
    let changed = 0;
    for (const r of WASM.rules) {
      const wrapped = WASM.addCellMapItems(r.body);
      if (!eq(wrapped, r.body)) changed += 1;
      // `remove ∘ add == id` is `outer.py:1561-1562`'s own reason for existing.
      expect(eq(WASM.removeCellMapItems(wrapped), r.body)).toBe(true);
      // And `inline_cell_maps` undoes the same wrapping, because every key
      // `add_cell_map_items` puts in first position is a cell
      // (`manip.py:401-418`).
      expect(eq(inlineCellMaps(wrapped), r.body)).toBe(true);
    }
    expect(changed).toBe(67);
  });

  test("addCellMapItems is idempotent, as the strip-first ordering promises", () => {
    for (const r of WASM.rules) {
      const once = WASM.addCellMapItems(r.body);
      expect(eq(WASM.addCellMapItems(once), once)).toBe(true);
    }
  });

  /**
   * The smallest cell-collection subterm in the whole definition — the
   * `_ElemInstCellMap_` on the left of one `<elemInst>` rule.
   *
   * Small enough that its printing can be written out in full, which is the
   * only reason the three exact pins below are readable.
   */
  const ELEM = (): KInner => {
    const side = extractLhs(rule("89bf93e8ce8882b2895f64934a80fecd072e475ff31f1c07d661801bf577c3bd").body);
    const found = subterms(side).filter((t) => t.node === "KApply" && t.label.name === "_ElemInstCellMap_");
    expect(found.length).toBe(1);
    return found[0]!;
  };

  const AS_STORED = [
    "<elemInst>",
    "  <eAddr>",
    "    EA:Int",
    "  </eAddr>",
    "  _DotVar6:ETypeCell",
    "  <eValue>",
    "    _Gen0:ListRef",
    "  </eValue>",
    "</elemInst> _DotVar5:ElemInstCellMap",
  ].join("\n");

  test("inlineCellMaps is a no-op for the *formatter* — kompile's format(%5) already hides the key", () => {
    // A finding, and not one IMP could ever have produced.  `kompile` gives
    // `ElemInstCellMapItem` the production
    // `ElemInstCellMapItem ( EAddrCell , ElemInstCell )` with `format(%5)`,
    // and item 5 is the `ElemInstCell` non-terminal — so `Formatter` prints a
    // wrapped element as just its cell whether or not anything inlined it.
    const term = ELEM();
    expect(FORMATTER.format(term)).toBe(AS_STORED);
    expect(FORMATTER.format(WASM.addCellMapItems(term))).toBe(AS_STORED);
  });

  test("…and is load-bearing for the pretty printer, which builds its unparser from items", () => {
    // `pretty.ts`'s `unparserForProduction` reads the production's *items*, not
    // its `format`, so the wrapper shows.  This is the printing
    // `inline_cell_maps` exists to prevent, and its first appearance anywhere in
    // this repository against a definition `kompile` produced.
    const term = ELEM();
    const wrapped = WASM.addCellMapItems(term);
    expect(PRETTY.print(term)).toBe(AS_STORED);
    expect(PRETTY.print(wrapped)).toBe(
      [
        "ElemInstCellMapItem ( <eAddr>",
        "  EA:Int",
        "</eAddr> , <elemInst>",
        "  <eAddr>",
        "    EA:Int",
        "  </eAddr>",
        "  _DotVar6:ETypeCell",
        "  <eValue>",
        "    _Gen0:ListRef",
        "  </eValue>",
        "</elemInst> ) _DotVar5:ElemInstCellMap",
      ].join("\n"),
    );
    expect(PRETTY.print(inlineCellMaps(wrapped))).toBe(AS_STORED);
  });
});

describe("sortAcCollections over real rules (manip.py:86-94)", () => {
  /** Every AC-collection subterm `sortAssocLabel` would change, by label. */
  function changedByLabel(): Map<string, { readonly reordered: number; readonly reassociated: number }> {
    const result = new Map<string, { reordered: number; reassociated: number }>();
    for (const r of WASM.rules) {
      for (const term of subterms(r.body)) {
        if (term.node !== "KApply") continue;
        const name = term.label.name;
        const isAc = name === "_Set_" || name === "_Map_" || name === "_RangeMap_" || name.endsWith("CellMap_");
        if (!isAc) continue;
        const sorted = sortAssocLabel(name, term);
        if (eq(sorted, term)) continue;
        const before = flattenLabel(name, term);
        const after = flattenLabel(name, sorted);
        const sameOrder = before.length === after.length && before.every((t, i) => eq(t, after[i]!));
        const entry = result.get(name) ?? { reordered: 0, reassociated: 0 };
        if (sameOrder) entry.reassociated += 1;
        else entry.reordered += 1;
        result.set(name, entry);
      }
    }
    return result;
  }

  test("it is idempotent on all 2062 bodies, and changes exactly seven", () => {
    let changed = 0;
    for (const r of WASM.rules) {
      const once = sortAcCollections(r.body);
      expect(eq(sortAcCollections(once), once)).toBe(true);
      if (!eq(once, r.body)) changed += 1;
    }
    expect(changed).toBe(7);
  });

  test("the CellMap_ branch fires — three times, and only ever to re-associate", () => {
    // The branch `manip.ts:1232` adds to upstream's three builtin labels.
    // Before KWasm the only thing that had ever gone through it was
    // `test/pretty-parity.test.ts`'s hand-built `_AccountCellMap_`.
    expect(Object.fromEntries(changedByLabel())).toEqual({
      // Two genuine reorderings and one re-association among the builtins…
      _Map_: { reordered: 2, reassociated: 1 },
      _Set_: { reordered: 1, reassociated: 0 },
      // …and three cell-collection terms that were left-nested and come out
      // right-nested.  Their *printed* form is unchanged — the label is
      // `assoc`, so association is invisible — which is the point: this pass
      // normalises term shape, not text, and only `eq` can see it.
      _ModuleInstCellMap_: { reordered: 0, reassociated: 3 },
    });
  });

  test("the six cell-collection labels really do occur in rule bodies", () => {
    const counts = new Map<string, number>();
    for (const r of WASM.rules) {
      for (const term of subterms(r.body)) {
        if (term.node !== "KApply" || !term.label.name.endsWith("CellMap_")) continue;
        counts.set(term.label.name, (counts.get(term.label.name) ?? 0) + 1);
      }
    }
    expect(Object.fromEntries([...counts].toSorted((a, b) => a[0].localeCompare(b[0])))).toEqual({
      _ElemInstCellMap_: 4,
      _FuncDefCellMap_: 6,
      _GlobalInstCellMap_: 6,
      _MemInstCellMap_: 17,
      _ModuleInstCellMap_: 57,
      _TabInstCellMap_: 13,
    });
  });
});

//////////////////////////////
// Macros                   //
//////////////////////////////

describe("macroRules (outer.py:1167-1170)", () => {
  test("thirteen, and every one of them is the `macro` half", () => {
    // `macro_rules` is `macro` rules **followed by** alias rules; KWasm has 13
    // and 0, so the concatenation is observable here only in that its length is
    // the first count.  No fixture in this repository has an alias rule — the
    // reason `WASM_CENSUS.aliasRules` is kept at 0 rather than dropped.
    expect(WASM.macroRules.length).toBe(13);
    expect(WASM.aliasRules.length).toBe(0);
    expect(WASM.macroRules.every((r) => r.att.has(Atts.MACRO))).toBe(true);
    expect(WASM.macroRules.some((r) => r.att.has(Atts.MACRO_REC))).toBe(false);
    expect(WASM.rules.filter((r) => r.att.has(Atts.MACRO)).length).toBe(13);
  });

  test("the thirteen symbols they define", () => {
    // Labels rather than `UNIQUE_ID`s: a label says what the macro is *about*,
    // and `source` cannot be pinned at all — every rule in this definition
    // carries the absolute path of the machine that ran `kompile`.
    expect(WASM.macroRules.map((r) => topLabel(r.body)).toSorted()).toEqual([
      "(_)_WASM-TEXT-COMMON-SYNTAX_ElemExpr_Instrs",
      "(_)_WASM-TEXT-COMMON-SYNTAX_Offset_Instrs",
      "(elem___)_WASM-TEXT-COMMON-SYNTAX_ElemDefn_OptionalId_Offset_ElemList",
      "(module_binary_)_WASM-REFERENCE-INTERPRETER-SYNTAX_ModuleDecl_OptionalId_DataString",
      "(module_quote_)_WASM-REFERENCE-INTERPRETER-SYNTAX_ModuleDecl_OptionalId_DefnStrings",
      "call_indirect__WASM-TEXT-COMMON-SYNTAX_PlainInstr_TypeUse",
      "table.copy_WASM-TEXT-COMMON-SYNTAX_PlainInstr",
      "table.fill_WASM-TEXT-COMMON-SYNTAX_PlainInstr",
      "table.get_WASM-TEXT-COMMON-SYNTAX_PlainInstr",
      "table.grow_WASM-TEXT-COMMON-SYNTAX_PlainInstr",
      "table.init__WASM-TEXT-COMMON-SYNTAX_PlainInstr_Index",
      "table.set_WASM-TEXT-COMMON-SYNTAX_PlainInstr",
      "table.size_WASM-TEXT-COMMON-SYNTAX_PlainInstr",
    ]);
  });

  test("every macro body is a rewrite with no side conditions", () => {
    // What `krun`'s macro expansion would need of them (`ktool/krun.py:414`);
    // nothing in this repository expands macros yet, so this is the shape
    // assertion a future consumer gets for free.
    for (const macro of WASM.macroRules) {
      expect(macro.body.node).toBe("KRewrite");
      expect(macro.requires.node).toBe("KToken");
      expect(macro.ensures.node).toBe("KToken");
    }
  });
});

//////////////////////////////
// The formatter at scale   //
//////////////////////////////

describe("Formatter over all 4124 rule sides", () => {
  test("4117 print, and the 7 that do not are all KAs", () => {
    // `formatter.py:90` raises on a `KAs`, and `test/formatter.test.ts` pins
    // that on a hand-built term.  KWasm is where it happens for real:
    // `extract_lhs` leaves `KAs` alone, and 7 rules match with `#as`.
    const failures: string[] = [];
    let printed = 0;
    for (const side of RULE_SIDES) {
      try {
        FORMATTER.format(side);
        printed += 1;
      } catch (error) {
        failures.push(error instanceof Error ? error.message : String(error));
      }
    }
    expect(printed).toBe(4117);
    expect(new Set(failures)).toEqual(new Set(["Unsupported term: KAs"]));
    expect(failures.length).toBe(7);
  });

  test("printing is deterministic — and the indent returns to zero", () => {
    // `Formatter.indent` is instance state and is *not* reset between calls
    // (`formatter.py:60-77`), so a definition whose `%i`/`%d` did not balance
    // would make the second sweep disagree with the first.  4117 real
    // productions' `format` attributes say they balance.
    const formatter = new Formatter(WASM);
    for (const side of RULE_SIDES) {
      let first: string;
      try {
        first = formatter.format(side);
      } catch {
        continue;
      }
      expect(formatter.format(side)).toBe(first);
    }
    expect(formatter.indent).toBe(0);
  });

  test("PrettyPrinter, by contrast, prints all 2062 bodies including the rewrites", () => {
    // Not redundant: it is the reason the sweep above is over *sides*.
    for (const r of WASM.rules) expect(typeof PRETTY.print(r.body)).toBe("string");
  });
});

describe("addBrackets over all 4124 rule sides (formatter.py:163-193)", () => {
  test("it changes 26 of them and inserts 54 brackets", () => {
    let changed = 0;
    let inserted = 0;
    for (const side of RULE_SIDES) {
      let bracketed: KInner;
      try {
        bracketed = addBrackets(WASM, side);
      } catch {
        continue; // the 7 KAs sides
      }
      if (eq(bracketed, side)) continue;
      changed += 1;
      inserted += subterms(bracketed).filter(
        (t) => t.node === "KApply" && t.label.name === DEFAULT_BRACKET_LABEL,
      ).length;
    }
    expect(changed).toBe(26);
    expect(inserted).toBe(54);
  });

  test("every one of the 54 is the synthetic default — KWasm's own two bracket productions never fire", () => {
    // A finding.  KWasm declares brackets for exactly two sorts, `LocalDecl`
    // and `TypeDecl`, and no rule ever needs one; all 54 insertions are the
    // hard-coded `KSEQ` bracket of `formatter.py:42-57`, on `Int` arithmetic.
    // So the branch `test/formatter.test.ts` exercises with a hand-built
    // `(_)_BRACKETS_Exp_Exp` is the one a real definition leaves cold, and vice
    // versa — the two files are complementary, not overlapping.
    expect([...WASM.brackets.values()].map((p) => bracketLabelName(p)).toSorted()).toEqual([
      "(_)_WASM-COMMON-SYNTAX_TypeDecl_TypeDecl",
      "(_)_WASM-TEXT-COMMON-SYNTAX_LocalDecl_LocalDecl",
    ]);
    const declared = new Set([...WASM.brackets.values()].map((p) => bracketLabelName(p)));
    for (const side of RULE_SIDES) {
      let bracketed: KInner;
      try {
        bracketed = addBrackets(WASM, side);
      } catch {
        continue;
      }
      for (const term of subterms(bracketed)) {
        if (term.node === "KApply") expect(declared.has(term.label.name)).toBe(false);
      }
    }
  });

  test("two exact printings, both through the default bracket", () => {
    // `Int` has no bracket production of its own, so these go through
    // `DEFAULT_BRACKET` — the `%1 %2 %3` format that puts spaces inside the
    // parentheses, which is why upstream's own expectations read `( 1 + 2 )`.
    expect(
      FORMATTER.format(extractLhs(rule("e2166a2b9e9f92c4a42d187b79cc7cfffd29e649f29e5b5a880ca4a3a47bc215").body)),
    ).toBe("I1:Int -Int ( I2:Int -Int C:Int )");
    expect(
      FORMATTER.format(extractRhs(rule("d74a5051d6c5db6f1cd82d246016e530a2c889e65ad1871d4ef3c794a0ebbfdb").body)),
    ).toBe("A:Int +Int ( 0 -Int I:Int )");
  });

  test("1694 of the 1784 syntax productions have no `format` and every default resolves", () => {
    // `productionDefaultFormat` (`outer.py:328-351`) throws for a regex
    // terminal in a record production.  1694 real productions say KWasm has
    // none, which is the only evidence in this repository that the throw is
    // unreachable in practice.
    const formatless = WASM.syntaxProductions.filter((p) => !p.att.has(Atts.FORMAT));
    expect(formatless.length).toBe(1694);
    for (const production of formatless) {
      expect(productionDefaultFormat(production).tokens.length).toBeGreaterThan(0);
    }
  });
});
