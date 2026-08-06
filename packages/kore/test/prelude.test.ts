/**
 * `src/prelude.ts` against `prelude.kore` and pyk's `kore/prelude.py`.
 *
 * The oracle for the constants is the normative file itself — `prelude.kore` is
 * `fixtures/definitions/prelude.kore`, the 61 lines `kompile` prepends to every
 * `definition.kore` — so the `kseq`/`dotk`/`inj` signatures are checked against
 * the declarations rather than against a transcription of them.  The oracle for
 * the constructors is `koreText`: every expectation below is the KORE text the
 * pattern must write as.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { indexDefinition } from "../src/definition.ts";
import { demangleName } from "../src/demangle.ts";
import { KoreParser, parseDefinition } from "../src/parser.ts";
import {
  andBool,
  BOOL,
  boolDv,
  BYTES,
  bytesDv,
  DOTK,
  eqBool,
  eqInt,
  FALSE,
  generatedCounter,
  generatedTop,
  geInt,
  gtInt,
  ID,
  impliesBool,
  initGeneratedTopCell,
  INJ,
  inj,
  INT,
  intDv,
  k,
  kConfigVar,
  KSEQ,
  kseq,
  LBL_AND_BOOL,
  LBL_EQ_BOOL,
  LBL_EQ_INT,
  LBL_GE_INT,
  LBL_GENERATED_COUNTER,
  LBL_GENERATED_TOP,
  LBL_GT_INT,
  LBL_IMPLIES_BOOL,
  LBL_INIT_GENERATED_TOP_CELL,
  LBL_ITE,
  LBL_K,
  LBL_LE_INT,
  LBL_LIST,
  LBL_LIST_ITEM,
  LBL_LT_INT,
  LBL_MAP,
  LBL_MAP_ITEM,
  LBL_NE_BOOL,
  LBL_NE_INT,
  LBL_NOT_BOOL,
  LBL_OR_BOOL,
  LBL_RANGEMAP,
  LBL_RANGEMAP_ITEM,
  LBL_RANGEMAP_RANGE,
  LBL_SET,
  LBL_SET_ITEM,
  LBL_XOR_BOOL,
  leInt,
  listPattern,
  ltInt,
  mapPattern,
  mapSymbols,
  neBool,
  neInt,
  notBool,
  orBool,
  rangemapPattern,
  setPattern,
  SORT_GENERATED_COUNTER_CELL,
  SORT_GENERATED_TOP_CELL,
  SORT_K,
  SORT_K_CONFIG_VAR,
  SORT_K_ITEM,
  STOP_LIST,
  STOP_MAP,
  STOP_RANGEMAP,
  STOP_SET,
  STRING,
  strDv,
  topCellInitializer,
  TRUE,
  xorBool,
} from "../src/prelude.ts";
import { resolveSymbol } from "../src/symbols.ts";
import { app, definition, evar, koreText, type Module, type Pattern, sortApp } from "../src/syntax.ts";

const FIXTURES = join(import.meta.dir, "..", "fixtures", "definitions");

/**
 * `prelude.kore` is a module sequence, not a definition (see
 * `test/parser.test.ts`); wrap it to index it.
 */
const PRELUDE = (() => {
  const parser = new KoreParser(readFileSync(join(FIXTURES, "prelude.kore"), "utf8"));
  const modules: Module[] = [];
  while (!parser.eof) modules.push(parser.module());
  return indexDefinition(definition(modules));
})();

/**
 * A real `kompile` output, the second oracle for the semantics-level symbol
 * names: `prelude.kore` declares `kseq`/`dotk`/`inj` and nothing else, so
 * `Lbl'Unds'Map'Unds'` and the cell symbols have to be checked against a
 * definition that actually contains them.
 */
const A_TO_F = indexDefinition(parseDefinition(readFileSync(join(FIXTURES, "a-to-f.definition.kore"), "utf8")));

/**
 * Every singleton this module exports, paired with its exported name.
 *
 * The whole point of the list is that it is exhaustive: a constant added later
 * and left out of it is a constant nothing checks is frozen, so the count below
 * is asserted too.
 */
const SINGLETONS: readonly (readonly [string, object])[] = [
  ["BOOL", BOOL],
  ["INT", INT],
  ["BYTES", BYTES],
  ["STRING", STRING],
  ["ID", ID],
  ["TRUE", TRUE],
  ["FALSE", FALSE],
  ["SORT_K", SORT_K],
  ["SORT_K_ITEM", SORT_K_ITEM],
  ["SORT_K_CONFIG_VAR", SORT_K_CONFIG_VAR],
  ["SORT_GENERATED_TOP_CELL", SORT_GENERATED_TOP_CELL],
  ["SORT_GENERATED_COUNTER_CELL", SORT_GENERATED_COUNTER_CELL],
  ["DOTK", DOTK],
  ["STOP_LIST", STOP_LIST],
  ["STOP_SET", STOP_SET],
  ["STOP_MAP", STOP_MAP],
  ["STOP_RANGEMAP", STOP_RANGEMAP],
];

/**
 * The singletons are constants, not shared mutable state.
 *
 * pyk's are instances of frozen dataclasses.  JavaScript has no such thing, and
 * a module's exports are one object graph shared by every importer in the
 * process — so an unfrozen `BOOL` is a global variable that any consumer, or any
 * dependency of any consumer, can rewrite for everyone else.
 */
describe("the singletons are frozen", () => {
  test("the list below is every exported singleton", () => {
    // Guards the exhaustiveness the rest of this block relies on.
    expect(SINGLETONS).toHaveLength(17);
    expect(new Set(SINGLETONS.map(([, value]) => value)).size).toBe(17);
  });

  test.each(SINGLETONS)("%s", (_name, value) => {
    expect(Object.isFrozen(value)).toBe(true);
    // Deeply: a frozen `SortApp` whose `sorts` array is writable is not frozen
    // in any sense a caller cares about.
    for (const child of Object.values(value)) {
      if (typeof child === "object" && child !== null) expect(Object.isFrozen(child)).toBe(true);
    }
  });

  test("the sorts reachable through a singleton are frozen too", () => {
    // `TRUE.sort === BOOL` and `TRUE.value` is a `String` node; both are one `.`
    // away and both would otherwise be writable.
    expect(TRUE.sort).toBe(BOOL);
    expect(Object.isFrozen(TRUE.sort)).toBe(true);
    expect(Object.isFrozen(TRUE.value)).toBe(true);
    expect(Object.isFrozen(FALSE.sort)).toBe(true);
    expect(Object.isFrozen(BOOL.sorts)).toBe(true);
    expect(Object.isFrozen(DOTK.sorts)).toBe(true);
    expect(Object.isFrozen(DOTK.args)).toBe(true);
  });

  test("a write through a singleton does not change what anything writes as", () => {
    // The reported reproduction: `BOOL` is `TRUE.sort`, `boolDv(true)` is
    // `TRUE`, and `kseq([])` is `DOTK`, so one assignment used to rewrite the
    // KORE text of all of them.
    //
    // `Reflect.set` reports the refusal rather than throwing it, which is the
    // same fact stated without a type assertion: the plain `BOOL.name = …` a
    // consumer would write is strict-mode code, and a strict-mode write to a
    // frozen property throws a `TypeError`.
    expect(Reflect.set(BOOL, "name", "SortHacked")).toBe(false);
    expect(Reflect.set(TRUE.value, "value", "hacked")).toBe(false);
    expect(Reflect.set(DOTK, "symbol", "Lblhacked")).toBe(false);
    expect(Reflect.set(DOTK.args, 0, TRUE)).toBe(false);
    expect(Reflect.defineProperty(BOOL, "name", { value: "SortHacked" })).toBe(false);
    expect(Reflect.deleteProperty(BOOL, "name")).toBe(false);

    expect(koreText(BOOL)).toBe("SortBool{}");
    expect(koreText(TRUE)).toBe(String.raw`\dv{SortBool{}}("true")`);
    expect(koreText(boolDv(true))).toBe(String.raw`\dv{SortBool{}}("true")`);
    expect(koreText(kseq([]))).toBe("dotk{}()");
  });
});

describe("sorts", () => {
  test.each([
    [BOOL, "SortBool{}"],
    [INT, "SortInt{}"],
    [BYTES, "SortBytes{}"],
    [STRING, "SortString{}"],
    [ID, "SortId{}"],
    [SORT_K, "SortK{}"],
    [SORT_K_ITEM, "SortKItem{}"],
    [SORT_K_CONFIG_VAR, "SortKConfigVar{}"],
    [SORT_GENERATED_TOP_CELL, "SortGeneratedTopCell{}"],
    [SORT_GENERATED_COUNTER_CELL, "SortGeneratedCounterCell{}"],
  ])("%o writes as %s", (sort, text) => {
    expect(koreText(sort)).toBe(text);
  });

  test("SortK and SortKItem are the two sorts BASIC-K declares", () => {
    expect([...PRELUDE.sorts.keys()]).toEqual([SORT_K.name, SORT_K_ITEM.name]);
  });
});

describe("symbol names", () => {
  test("kseq, dotk and inj are declared by prelude.kore, and Lblite is not", () => {
    expect(PRELUDE.symbols.has(KSEQ)).toBe(true);
    expect(PRELUDE.symbols.has(DOTK.symbol)).toBe(true);
    expect(PRELUDE.symbols.has(INJ)).toBe(true);
    // `Lblite` is a semantics-level symbol; it is only *named* here because it is
    // the one polymorphic operator a converter special-cases (`prelude.py:152`).
    expect(PRELUDE.symbols.has(LBL_ITE)).toBe(false);
  });

  /**
   * The argument-sort split this package's `kseq` depends on, read off the
   * declaration: a K sequence's head is an *item* and its tail is a *sequence*.
   * `append`, which takes two sequences, is the contrast that makes the point.
   */
  test("kseq{}(SortKItem{}, SortK{}) : SortK{}, and append{}(SortK{}, SortK{})", () => {
    expect(resolveSymbol(PRELUDE, KSEQ)).toEqual({
      sort: SORT_K,
      paramSorts: [SORT_K_ITEM, SORT_K],
    });
    expect(resolveSymbol(PRELUDE, "append")).toEqual({
      sort: SORT_K,
      paramSorts: [SORT_K, SORT_K],
    });
    expect(resolveSymbol(PRELUDE, DOTK.symbol)).toEqual({ sort: SORT_K, paramSorts: [] });
  });

  test("inj{From, To}(From) : To — the parameter order", () => {
    const decl = PRELUDE.symbols.get(INJ);
    expect(decl?.symbol.vars.map((v) => v.name)).toEqual(["From", "To"]);
    expect(decl?.paramSorts.map(koreText)).toEqual(["From"]);
    expect(decl && koreText(decl.sort)).toBe("To");
    // Instantiated, `inj` is exactly what `inj(from, to, p)` builds.
    expect(resolveSymbol(PRELUDE, INJ, [BOOL, SORT_K_ITEM])).toEqual({
      sort: SORT_K_ITEM,
      paramSorts: [BOOL],
    });
  });
});

describe("inj", () => {
  test("inj(from, to, pattern) — prelude.py:175-176", () => {
    expect(koreText(inj(BOOL, SORT_K_ITEM, TRUE))).toBe(
      String.raw`inj{SortBool{}, SortKItem{}}(\dv{SortBool{}}("true"))`,
    );
  });
});

describe("kseq", () => {
  const a = app("a");
  const b = app("b");
  const c = app("c");
  const tail = evar("KS", SORT_K);

  /** `prelude.py:179-192`, arity by arity — the empty case is the tail alone. */
  test.each([
    ["empty", [], undefined, "dotk{}()"],
    ["empty with dotvar", [], tail, "KS : SortK{}"],
    ["one item", [a], undefined, "kseq{}(a{}(), dotk{}())"],
    ["one item with dotvar", [a], tail, "kseq{}(a{}(), KS : SortK{})"],
    ["two items", [a, b], undefined, String.raw`\right-assoc{}(kseq{}(a{}(), b{}(), dotk{}()))`],
    ["three items", [a, b, c], tail, String.raw`\right-assoc{}(kseq{}(a{}(), b{}(), c{}(), KS : SortK{}))`],
  ] as const)("%s", (_name, items, dotvar, text) => {
    expect(koreText(kseq(items, dotvar))).toBe(text);
  });

  test("an empty kseq with no dotvar is DOTK itself", () => {
    expect(kseq([])).toBe(DOTK);
  });

  test("a dotvar of the wrong sort is a TypeError", () => {
    // pyk raises `ValueError` here (`prelude.py:180-181`); this package has no
    // equivalent and throws `TypeError`, as `syntax.ts` does for a wrong
    // subpattern kind.
    expect(() => kseq([a], evar("KS", SORT_K_ITEM))).toThrow(TypeError);
    expect(() => kseq([a], evar("KS", SORT_K_ITEM))).toThrow("Expected SortK{} as dotvar sort, got: SortKItem{}");
    // The sort is compared structurally, not by identity.
    expect(() => kseq([a], evar("KS", sortApp("SortK")))).not.toThrow();
  });
});

describe("domain values", () => {
  test("TRUE and FALSE — prelude.py:27-28", () => {
    expect(koreText(TRUE)).toBe(String.raw`\dv{SortBool{}}("true")`);
    expect(koreText(FALSE)).toBe(String.raw`\dv{SortBool{}}("false")`);
    expect(boolDv(true)).toBe(TRUE);
    expect(boolDv(false)).toBe(FALSE);
  });

  test.each([
    [0, "0"],
    [-1, "-1"],
    [42, "42"],
    // A `number` this large would render as `1e+21`, which is not a KORE integer.
    [1e21, "1000000000000000000000"],
    [2n ** 256n, (2n ** 256n).toString()],
    [-(2n ** 64n), (-(2n ** 64n)).toString()],
  ])("intDv(%s)", (value, expected) => {
    expect(koreText(intDv(value))).toBe(String.raw`\dv{SortInt{}}("${expected}")`);
  });

  test("intDv rejects a non-integer number", () => {
    expect(() => intDv(1.5)).toThrow(TypeError);
  });

  test("strDv escapes on the way out, not on the way in", () => {
    expect(strDv("a\nb").value.value).toBe("a\nb");
    expect(koreText(strDv("a\nb"))).toBe(String.raw`\dv{SortString{}}("a\nb")`);
  });

  test("bytesDv is latin-1, one character per byte", () => {
    const bytes = Uint8Array.from([0x00, 0x41, 0x80, 0xff]);
    expect(bytesDv(bytes).value.value).toBe(" Aÿ");
    // `koreText` escapes as a *string*: U+0080 and U+00FF are not printable
    // ASCII. `enquoteBytes` is what a byte-exact writer wants.
    expect(koreText(bytesDv(bytes))).toBe(String.raw`\dv{SortBytes{}}("\x00A\x80\xff")`);
  });
});

describe("kConfigVar", () => {
  test("kConfigVar — prelude.py:195-196", () => {
    // pyk: k_config_var('$PGM').text == '\\dv{SortKConfigVar{}}("$PGM")'
    expect(koreText(kConfigVar("$PGM"))).toBe(String.raw`\dv{SortKConfigVar{}}("$PGM")`);
    // The `$` is part of the caller's name; nothing adds or checks it.
    expect(koreText(kConfigVar("PGM"))).toBe(String.raw`\dv{SortKConfigVar{}}("PGM")`);
  });
});

/**
 * The write half completed in this pass, checked against the reference.
 *
 * Every expectation below is the `.text` pyk produces for the same call, taken
 * from a run of the pinned tree rather than read off the source:
 *
 * ```sh
 * cd k/pyk/src && PYTHONPATH=. python3 -c '
 * from pyk.kore.prelude import *
 * from pyk.kore.syntax import App
 * a, b, c = App("a"), App("b"), App("c")
 * print(and_bool(TRUE, FALSE).text)
 * print(map_pattern((a, b), cell="Acct").text)
 * print(top_cell_initializer({"$PGM": a}).text)'
 * ```
 *
 * `pyk/src/pyk/kore/prelude.py` is byte-identical between the pinned v7.1.337
 * tree and the installed `kframework` distribution, so either interpreter
 * produces these.
 *
 * A second, independent oracle runs alongside: every mangled symbol name is put
 * through `demangleName` (`src/demangle.ts`, the codec for `ModuleToKORE.java`'s
 * encoding) and must come back as the K label it is supposed to encode — a
 * hand-transcription typo shows up there as nonsense — and the universal ones
 * are looked up in `a-to-f.definition.kore`'s symbol table, a real `kompile`
 * output.
 */
describe("Bool operators", () => {
  test.each([
    ["notBool", notBool(TRUE), String.raw`LblnotBool'Unds'{}(\dv{SortBool{}}("true"))`],
    [
      "andBool",
      andBool(TRUE, FALSE),
      String.raw`Lbl'Unds'andBool'Unds'{}(\dv{SortBool{}}("true"), \dv{SortBool{}}("false"))`,
    ],
    [
      "orBool",
      orBool(TRUE, FALSE),
      String.raw`Lbl'Unds'orBool'Unds'{}(\dv{SortBool{}}("true"), \dv{SortBool{}}("false"))`,
    ],
    [
      "impliesBool",
      impliesBool(TRUE, FALSE),
      String.raw`Lbl'Unds'impliesBool'Unds'{}(\dv{SortBool{}}("true"), \dv{SortBool{}}("false"))`,
    ],
    [
      "xorBool",
      xorBool(TRUE, FALSE),
      String.raw`Lbl'Unds'xorBool'Unds'{}(\dv{SortBool{}}("true"), \dv{SortBool{}}("false"))`,
    ],
    [
      "eqBool",
      eqBool(TRUE, FALSE),
      String.raw`Lbl'UndsEqlsEqls'Bool'Unds'{}(\dv{SortBool{}}("true"), \dv{SortBool{}}("false"))`,
    ],
    [
      "neBool",
      neBool(TRUE, FALSE),
      String.raw`Lbl'UndsEqlsSlshEqls'Bool'Unds'{}(\dv{SortBool{}}("true"), \dv{SortBool{}}("false"))`,
    ],
  ] as const)("%s writes as pyk writes it", (_name, pattern, text) => {
    expect(koreText(pattern)).toBe(text);
  });

  test("the mangled names decode to the K labels they encode", () => {
    expect(demangleName(LBL_NOT_BOOL)).toBe("LblnotBool_");
    expect(demangleName(LBL_AND_BOOL)).toBe("Lbl_andBool_");
    expect(demangleName(LBL_OR_BOOL)).toBe("Lbl_orBool_");
    expect(demangleName(LBL_IMPLIES_BOOL)).toBe("Lbl_impliesBool_");
    expect(demangleName(LBL_XOR_BOOL)).toBe("Lbl_xorBool_");
    expect(demangleName(LBL_EQ_BOOL)).toBe("Lbl_==Bool_");
    expect(demangleName(LBL_NE_BOOL)).toBe("Lbl_=/=Bool_");
  });
});

describe("Int operators", () => {
  const one = intDv(1);
  const two = intDv(2);

  test.each([
    ["eqInt", eqInt(one, two), "Lbl'UndsEqlsEqls'Int'Unds'"],
    ["neInt", neInt(one, two), "Lbl'UndsEqlsSlshEqls'Int'Unds'"],
    ["gtInt", gtInt(one, two), "Lbl'Unds-GT-'Int'Unds'"],
    ["geInt", geInt(one, two), "Lbl'Unds-GT-Eqls'Int'Unds'"],
    ["ltInt", ltInt(one, two), "Lbl'Unds-LT-'Int'Unds'"],
    ["leInt", leInt(one, two), "Lbl'Unds-LT-Eqls'Int'Unds'"],
  ] as const)("%s writes as pyk writes it", (_name, pattern, symbol) => {
    expect(koreText(pattern)).toBe(String.raw`${symbol}{}(\dv{SortInt{}}("1"), \dv{SortInt{}}("2"))`);
  });

  test("the mangled names decode to the K labels they encode", () => {
    expect(demangleName(LBL_EQ_INT)).toBe("Lbl_==Int_");
    expect(demangleName(LBL_NE_INT)).toBe("Lbl_=/=Int_");
    expect(demangleName(LBL_GT_INT)).toBe("Lbl_>Int_");
    expect(demangleName(LBL_GE_INT)).toBe("Lbl_>=Int_");
    expect(demangleName(LBL_LT_INT)).toBe("Lbl_<Int_");
    expect(demangleName(LBL_LE_INT)).toBe("Lbl_<=Int_");
  });

  test("only the six comparisons pyk carries are here — no arithmetic", () => {
    // Stated as a test so adding `+Int` is a deliberate act with its own
    // authority, not a quiet extension of what pyk vouches for.
    expect(new Set([LBL_EQ_INT, LBL_NE_INT, LBL_GT_INT, LBL_GE_INT, LBL_LT_INT, LBL_LE_INT]).size).toBe(6);
  });
});

describe("configuration builders", () => {
  const a = app("a");
  const b = app("b");

  test("the cell symbols are the ones a real definition declares", () => {
    // `a-to-f.definition.kore` is real `kompile` output; a wrong mangled
    // spelling above would simply not be in its symbol table.
    expect(A_TO_F.symbols.has(LBL_GENERATED_TOP)).toBe(true);
    expect(A_TO_F.symbols.has(LBL_GENERATED_COUNTER)).toBe(true);
    expect(A_TO_F.symbols.has(LBL_K)).toBe(true);
    expect(A_TO_F.symbols.has(LBL_INIT_GENERATED_TOP_CELL)).toBe(true);
  });

  test.each([
    ["initGeneratedTopCell", initGeneratedTopCell(a), "LblinitGeneratedTopCell{}(a{}())"],
    ["generatedTop", generatedTop([a, b]), "Lbl'-LT-'generatedTop'-GT-'{}(a{}(), b{}())"],
    ["generatedTop (empty)", generatedTop([]), "Lbl'-LT-'generatedTop'-GT-'{}()"],
    ["generatedCounter", generatedCounter(a), "Lbl'-LT-'generatedCounter'-GT-'{}(a{}())"],
    ["k", k(a), "Lbl'-LT-'k'-GT-'{}(a{}())"],
  ] as const)("%s writes as pyk writes it", (_name, pattern, text) => {
    expect(koreText(pattern)).toBe(text);
  });

  test("topCellInitializer of an empty config is the unit map", () => {
    // pyk: LblinitGeneratedTopCell{}(Lbl'Stop'Map{}())
    expect(koreText(topCellInitializer([]))).toBe("LblinitGeneratedTopCell{}(Lbl'Stop'Map{}())");
  });

  test("topCellInitializer injects each name into SortKItem", () => {
    expect(koreText(topCellInitializer([["$PGM", a]]))).toBe(
      String.raw`LblinitGeneratedTopCell{}(\left-assoc{}(Lbl'Unds'Map'Unds'{}(Lbl'UndsPipe'-'-GT-Unds'{}(inj{SortKConfigVar{}, SortKItem{}}(\dv{SortKConfigVar{}}("$PGM")), a{}()))))`,
    );
  });

  test("topCellInitializer preserves the order the entries arrive in", () => {
    // pyk iterates a dict, which preserves insertion order; the order is
    // observable as the `\left-assoc`'s argument order.
    const config = new Map<string, Pattern>([
      ["$PGM", a],
      ["$STDIN", strDv("x")],
    ]);
    expect(koreText(topCellInitializer(config))).toBe(
      String.raw`LblinitGeneratedTopCell{}(\left-assoc{}(Lbl'Unds'Map'Unds'{}(Lbl'UndsPipe'-'-GT-Unds'{}(inj{SortKConfigVar{}, SortKItem{}}(\dv{SortKConfigVar{}}("$PGM")), a{}()), Lbl'UndsPipe'-'-GT-Unds'{}(inj{SortKConfigVar{}, SortKItem{}}(\dv{SortKConfigVar{}}("$STDIN")), \dv{SortString{}}("x")))))`,
    );
  });

  test("entries, not a Record — a config variable may be named anything", () => {
    // `"__proto__"` as an object-literal key is not an own property at all; an
    // entries iterable simply carries it.
    expect(koreText(topCellInitializer([["__proto__", a]]))).toContain(String.raw`\dv{SortKConfigVar{}}("__proto__")`);
  });
});

describe("collection builders", () => {
  const a = app("a");
  const b = app("b");
  const c = app("c");

  test.each([
    ["empty", listPattern(), "Lbl'Stop'List{}()"],
    ["one", listPattern(a), String.raw`\left-assoc{}(Lbl'Unds'List'Unds'{}(LblListItem{}(a{}())))`],
    [
      "three",
      listPattern(a, b, c),
      String.raw`\left-assoc{}(Lbl'Unds'List'Unds'{}(LblListItem{}(a{}()), LblListItem{}(b{}()), LblListItem{}(c{}())))`,
    ],
  ] as const)("listPattern %s", (_name, pattern, text) => {
    expect(koreText(pattern)).toBe(text);
  });

  test("a one-element list still gets the \\left-assoc wrapper, unlike kseq", () => {
    // pyk's branch is on emptiness alone (`prelude.py:223-225`); `kseq` branches
    // on arity too. The asymmetry is real and easy to "fix" by mistake.
    expect(listPattern()).toBe(STOP_LIST);
    expect(listPattern(a).tag).toBe("LeftAssoc");
    expect(kseq([a]).tag).toBe("App");
  });

  test.each([
    ["empty", setPattern(), "Lbl'Stop'Set{}()"],
    ["one", setPattern(a), String.raw`\left-assoc{}(Lbl'Unds'Set'Unds'{}(LblSetItem{}(a{}())))`],
    [
      "three",
      setPattern(a, b, c),
      String.raw`\left-assoc{}(Lbl'Unds'Set'Unds'{}(LblSetItem{}(a{}()), LblSetItem{}(b{}()), LblSetItem{}(c{}())))`,
    ],
  ] as const)("setPattern %s", (_name, pattern, text) => {
    expect(koreText(pattern)).toBe(text);
  });

  test.each([
    ["empty", mapPattern([]), "Lbl'Stop'Map{}()"],
    [
      "one",
      mapPattern([[a, b]]),
      String.raw`\left-assoc{}(Lbl'Unds'Map'Unds'{}(Lbl'UndsPipe'-'-GT-Unds'{}(a{}(), b{}())))`,
    ],
    [
      "two",
      mapPattern([
        [a, b],
        [b, c],
      ]),
      String.raw`\left-assoc{}(Lbl'Unds'Map'Unds'{}(Lbl'UndsPipe'-'-GT-Unds'{}(a{}(), b{}()), Lbl'UndsPipe'-'-GT-Unds'{}(b{}(), c{}())))`,
    ],
    ["empty cell", mapPattern([], { cell: "Acct" }), "Lbl'Stop'AcctMap{}()"],
    [
      "one cell",
      mapPattern([[a, b]], { cell: "Acct" }),
      String.raw`\left-assoc{}(Lbl'Unds'AcctMap'Unds'{}(LblAcctMapItem{}(a{}(), b{}())))`,
    ],
  ] as const)("mapPattern %s", (_name, pattern, text) => {
    expect(koreText(pattern)).toBe(text);
  });

  test('an empty cell name is no cell at all, as pyk\'s `cell or ""` makes it', () => {
    expect(mapPattern([], { cell: "" })).toBe(STOP_MAP);
    expect(mapSymbols("")).toEqual(mapSymbols());
    expect(mapSymbols()).toEqual({ stop: "Lbl'Stop'Map", cons: LBL_MAP, item: LBL_MAP_ITEM });
    expect(mapSymbols("Acct")).toEqual({
      stop: "Lbl'Stop'AcctMap",
      cons: "Lbl'Unds'AcctMap'Unds'",
      item: "LblAcctMapItem",
    });
  });

  test.each([
    ["empty", rangemapPattern([]), "Lbl'Stop'RangeMap{}()"],
    [
      "one",
      rangemapPattern([[[a, b], c]]),
      String.raw`\left-assoc{}(Lbl'Unds'RangeMap'Unds'{}(Lbl'Unds'r'Pipe'-'-GT-Unds'{}(LblRangeMap'Coln'Range{}(a{}(), b{}()), c{}())))`,
    ],
  ] as const)("rangemapPattern %s", (_name, pattern, text) => {
    expect(koreText(pattern)).toBe(text);
  });

  test("the collection symbol names decode to the K labels they encode", () => {
    expect(demangleName(STOP_LIST.symbol)).toBe("Lbl.List");
    expect(demangleName(LBL_LIST)).toBe("Lbl_List_");
    expect(demangleName(LBL_LIST_ITEM)).toBe("LblListItem");
    expect(demangleName(STOP_SET.symbol)).toBe("Lbl.Set");
    expect(demangleName(LBL_SET)).toBe("Lbl_Set_");
    expect(demangleName(LBL_SET_ITEM)).toBe("LblSetItem");
    expect(demangleName(STOP_MAP.symbol)).toBe("Lbl.Map");
    expect(demangleName(LBL_MAP)).toBe("Lbl_Map_");
    expect(demangleName(LBL_MAP_ITEM)).toBe("Lbl_|->_");
    expect(demangleName(STOP_RANGEMAP.symbol)).toBe("Lbl.RangeMap");
    expect(demangleName(LBL_RANGEMAP)).toBe("Lbl_RangeMap_");
    expect(demangleName(LBL_RANGEMAP_ITEM)).toBe("Lbl_r|->_");
    expect(demangleName(LBL_RANGEMAP_RANGE)).toBe("LblRangeMap:Range");
  });

  test("the List, Set and Map symbols are the ones a real definition declares", () => {
    const declared = [
      STOP_LIST.symbol,
      LBL_LIST,
      LBL_LIST_ITEM,
      STOP_SET.symbol,
      LBL_SET,
      LBL_SET_ITEM,
      STOP_MAP.symbol,
      LBL_MAP,
      LBL_MAP_ITEM,
    ];
    expect(declared.filter((symbol) => !A_TO_F.symbols.has(symbol))).toEqual([]);
  });
});
