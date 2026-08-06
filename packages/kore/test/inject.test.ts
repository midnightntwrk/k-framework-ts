/**
 * `src/inject.ts` against pyk `KompiledKore.add_injections` (`kompiled.py:121-162`).
 *
 * The oracle is pyk run over **the same fixture** this test loads —
 * `fixtures/definitions/a-to-f.definition.kore`, a real kompiled definition —
 * so the sort lattice both implementations consult is byte-identical:
 *
 * ```sh
 * cd k/pyk/src && PYTHONPATH=. python3 -c '
 * from pyk.kore.kompiled import KompiledKore
 * from pyk.kore.parser import KoreParser
 * from pyk.kore.syntax import SortApp
 * kk = KompiledKore.for_definition(KoreParser(open(
 *     "packages/kore/fixtures/definitions/a-to-f.definition.kore").read()).definition())
 * p = KoreParser(r"kseq{}(\dv{SortInt{}}(\"1\"), dotk{}())").pattern()
 * print(kk.add_injections(p).text)'
 * # kseq{}(inj{SortInt{}, SortKItem{}}(\dv{SortInt{}}("1")), dotk{}())
 * ```
 *
 * Each expectation below is labelled with the pyk output it was taken from.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { indexDefinition } from "../src/definition.ts";
import { addInjections, KoreInjectionError } from "../src/inject.ts";

import { KoreParser, parseDefinition } from "../src/parser.ts";
import {
  generatedCounter,
  generatedTop,
  INT,
  intDv,
  k,
  kseq,
  SORT_GENERATED_TOP_CELL,
  SORT_K,
  SORT_K_ITEM,
} from "../src/prelude.ts";
import { app, evar, koreText, leftAssoc, type Pattern, sortApp } from "../src/syntax.ts";

const FIXTURES = join(import.meta.dir, "..", "fixtures", "definitions");

const A_TO_F = indexDefinition(parseDefinition(readFileSync(join(FIXTURES, "a-to-f.definition.kore"), "utf8")));

/** Parse a bare pattern, so expectations can be written as KORE text. */
const parse = (text: string): ReturnType<KoreParser["pattern"]> => new KoreParser(text).pattern();

/** `addInjections` over the fixture, answered as KORE text. */
const inject = (text: string, sort?: Parameters<typeof addInjections>[2]): string =>
  koreText(addInjections(A_TO_F, parse(text), sort));

/**
 * The error `run` threw, narrowed — `instanceof`, not a cast, so a *different*
 * error type is reported here rather than read as the expected one.
 */
function thrownInjectionError(run: () => unknown): KoreInjectionError {
  try {
    run();
  } catch (error) {
    if (error instanceof KoreInjectionError) return error;
    throw error;
  }
  throw new Error("Expected a KoreInjectionError, but nothing was thrown");
}

describe("addInjections", () => {
  test("a subsorted domain value is wrapped", () => {
    // pyk: inj{SortInt{}, SortKItem{}}(\dv{SortInt{}}("1"))
    expect(inject(String.raw`\dv{SortInt{}}("1")`, SORT_K_ITEM)).toBe(
      String.raw`inj{SortInt{}, SortKItem{}}(\dv{SortInt{}}("1"))`,
    );
  });

  test("the default sort is SortK{}, which everything is a subsort of", () => {
    // pyk: inj{SortInt{}, SortK{}}(\dv{SortInt{}}("1")) — note that the default
    // *injects*, it does not leave the term alone.
    expect(inject(String.raw`\dv{SortInt{}}("1")`)).toBe(String.raw`inj{SortInt{}, SortK{}}(\dv{SortInt{}}("1"))`);
    expect(inject(String.raw`\dv{SortInt{}}("1")`, SORT_K)).toBe(
      String.raw`inj{SortInt{}, SortK{}}(\dv{SortInt{}}("1"))`,
    );
  });

  test("a term already at the required sort is returned untouched", () => {
    // pyk: \dv{SortInt{}}("1")
    expect(inject(String.raw`\dv{SortInt{}}("1")`, INT)).toBe(String.raw`\dv{SortInt{}}("1")`);
    // Structural sort comparison, not identity: a fresh `sortApp` is the same sort.
    expect(inject(String.raw`\dv{SortInt{}}("1")`, sortApp("SortInt"))).toBe(String.raw`\dv{SortInt{}}("1")`);
  });

  test("an argument is placed at its declaration's parameter sort", () => {
    // The motivating case: `kseq{}(SortKItem{}, SortK{})`, and `SortInt{}` is
    // only a subsort of `SortKItem{}`.
    // pyk: kseq{}(inj{SortInt{}, SortKItem{}}(\dv{SortInt{}}("1")), dotk{}())
    expect(inject(String.raw`kseq{}(\dv{SortInt{}}("1"), dotk{}())`, SORT_K)).toBe(
      String.raw`kseq{}(inj{SortInt{}, SortKItem{}}(\dv{SortInt{}}("1")), dotk{}())`,
    );
  });

  test("injections are inserted at every depth, inner first", () => {
    // pyk: inj{SortKCell{}, SortKItem{}}(
    //        Lbl'-LT-'k'-GT-'{}(kseq{}(inj{SortInt{}, SortKItem{}}(\dv{SortInt{}}("1")), dotk{}())))
    expect(inject(String.raw`Lbl'-LT-'k'-GT-'{}(kseq{}(\dv{SortInt{}}("1"), dotk{}()))`, SORT_K_ITEM)).toBe(
      String.raw`inj{SortKCell{}, SortKItem{}}(Lbl'-LT-'k'-GT-'{}(kseq{}(inj{SortInt{}, SortKItem{}}(\dv{SortInt{}}("1")), dotk{}())))`,
    );
  });

  test("the top of the term is injected too, into the default SortK{}", () => {
    // pyk: inj{SortGeneratedCounterCell{}, SortK{}}(
    //        Lbl'-LT-'generatedCounter'-GT-'{}(\dv{SortInt{}}("0")))
    expect(inject(String.raw`Lbl'-LT-'generatedCounter'-GT-'{}(\dv{SortInt{}}("0"))`)).toBe(
      String.raw`inj{SortGeneratedCounterCell{}, SortK{}}(Lbl'-LT-'generatedCounter'-GT-'{}(\dv{SortInt{}}("0")))`,
    );
  });

  test("a variable carries its own sort and is injected like anything else", () => {
    expect(koreText(addInjections(A_TO_F, evar("X", INT), SORT_K_ITEM))).toBe(
      "inj{SortInt{}, SortKItem{}}(X : SortInt{})",
    );
  });
});

describe("addInjections refuses rather than guesses", () => {
  test("a sort that is not a supersort is an error naming both sorts", () => {
    // pyk: ValueError: Sort SortInt is not a subsort of SortBool: DV(...)
    expect(() => inject(String.raw`\dv{SortInt{}}("1")`, sortApp("SortBool"))).toThrow(KoreInjectionError);
    expect(() => inject(String.raw`\dv{SortInt{}}("1")`, sortApp("SortBool"))).toThrow(
      "Sort SortInt{} is not a subsort of SortBool{}",
    );
  });

  test("the error carries the subterm and both sorts, so a deep failure is diagnosable", () => {
    const error = thrownInjectionError(() =>
      addInjections(A_TO_F, parse(String.raw`kseq{}(\dv{SortString{}}("s"), dotk{}())`), SORT_K),
    );
    // The failure is the *argument*, not the term handed in.
    expect(koreText(error.pattern)).toBe(String.raw`\dv{SortString{}}("s")`);
    expect(error.actualSort && koreText(error.actualSort)).toBe("SortString{}");
    expect(error.expectedSort && koreText(error.expectedSort)).toBe("SortKItem{}");
    expect(error.name).toBe("KoreInjectionError");
    expect(error).toBeInstanceOf(TypeError);
  });

  test("an undeclared symbol is an error, where pyk raises 'Undeclared symbol'", () => {
    const error = thrownInjectionError(() => addInjections(A_TO_F, app("Lblnosuchsymbol", [], []), SORT_K));
    expect(error.message).toContain("Cannot determine the argument sorts of");
    expect(error.actualSort).toBeUndefined();
  });

  test("an arity disagreement with the declaration is an error, not a truncated answer", () => {
    // `dotk{}()` is nullary; `dotk{}(X)` is where pyk's
    // `assert len(sorts) == len(pattern.patterns)` (kompiled.py:330) fires.
    expect(() => addInjections(A_TO_F, app("dotk", [], [evar("X", INT)]), SORT_K)).toThrow(KoreInjectionError);
  });

  test("a \\left-assoc has no sort of its own and is refused", () => {
    // Assoc sugar's arguments are the operands of an *expansion*, not the
    // symbol's parameters — `symbols.ts` answers `undefined` for both questions
    // and pyk asserts.
    expect(() => addInjections(A_TO_F, leftAssoc("kseq", [], [app("dotk"), app("dotk")]), SORT_K)).toThrow(
      KoreInjectionError,
    );
  });
});

describe("addInjections is depth-safe", () => {
  test("a 50k-deep term does not exhaust the call stack", () => {
    // `Lbl'-LT-'k'-GT-'` is not self-nestable, so the depth comes from `kseq`'s
    // tail, which is `SortK{}` — no injection anywhere, which is the point: the
    // walk itself must not recurse.
    const item = app("inj", [INT, SORT_K_ITEM], [parse(String.raw`\dv{SortInt{}}("1")`)]);
    let deep: Pattern = app("dotk");
    for (let i = 0; i < 50_000; i += 1) deep = app("kseq", [], [item, deep]);

    const injected = addInjections(A_TO_F, deep, SORT_K);

    // Walked, not `toEqual`d: bun's deep comparison is itself recursive and
    // blows the stack on a term this deep, which would test the assertion
    // rather than the function.  One `expect` at the end, not 50 000 of them.
    const itemText = koreText(item);
    let node: Pattern = injected;
    let depth = 0;
    let everyItemUntouched = true;
    while (node.tag === "App" && node.symbol === "kseq") {
      const [head, tail] = node.args;
      if (head === undefined || tail === undefined) break;
      everyItemUntouched &&= koreText(head) === itemText;
      node = tail;
      depth += 1;
    }
    expect({ depth, everyItemUntouched, tail: koreText(node) }).toEqual({
      depth: 50_000,
      everyItemUntouched: true,
      tail: "dotk{}()",
    });
  });
});

describe("addInjections composes with the prelude builders", () => {
  test("a whole configuration assembled from prelude constructors becomes well-sorted", () => {
    // This is the whole reason the function exists: `generatedTop`, `k` and
    // `kseq` write symbol names, not sorts, and only `\dv{SortInt{}}` inside the
    // `<k>` cell actually needs an injection.
    //
    // pyk: Lbl'-LT-'generatedTop'-GT-'{}(Lbl'-LT-'k'-GT-'{}(kseq{}(
    //        inj{SortInt{}, SortKItem{}}(\dv{SortInt{}}("1")), dotk{}())),
    //        Lbl'-LT-'generatedCounter'-GT-'{}(\dv{SortInt{}}("0")))
    const term = generatedTop([k(kseq([parse(String.raw`\dv{SortInt{}}("1")`)])), generatedCounter(intDv(0))]);
    expect(koreText(addInjections(A_TO_F, term, SORT_GENERATED_TOP_CELL))).toBe(
      String.raw`Lbl'-LT-'generatedTop'-GT-'{}(Lbl'-LT-'k'-GT-'{}(kseq{}(inj{SortInt{}, SortKItem{}}(\dv{SortInt{}}("1")), dotk{}())), Lbl'-LT-'generatedCounter'-GT-'{}(\dv{SortInt{}}("0")))`,
    );
  });

  test("a cell is not a subsort of the top cell — the lattice is consulted, not guessed", () => {
    // pyk: ValueError: Sort SortKCell is not a subsort of SortGeneratedTopCell
    expect(() => addInjections(A_TO_F, k(app("dotk")), SORT_GENERATED_TOP_CELL)).toThrow(
      "Sort SortKCell{} is not a subsort of SortGeneratedTopCell{}",
    );
  });
});
