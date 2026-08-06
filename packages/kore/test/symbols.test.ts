/**
 * `src/symbols.ts` — sort resolution over a definition's symbol declarations.
 *
 * Three oracles:
 *
 * 1. **pyk's integration assertion** (`tests/integration/test_kompile.py:118`),
 *    `symbol_table.resolve('Lblbar') == (SortFoo, (SortBar,))` for the subsort
 *    production `syntax Foo ::= Bar [symbol(bar)]`.  There is no *unit* test of
 *    `KoreSymbolTable` upstream — `tests/unit/kore/test_kompiled.py` covers only
 *    `KoreSortTable` — so the shape is transcribed from the integration one.
 * 2. **`prelude.kore`'s `inj{From, To}`**, the one parametric symbol every
 *    definition has, for the substitution.
 * 3. **The two real definitions**, for the invariant pyk asserts and cannot
 *    always meet: `patternSorts(p)` is parallel to `patterns(p)`.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { indexDefinition, type KoreDefinitionIndex } from "../src/definition.ts";
import { parseDefinition, parsePattern } from "../src/parser.ts";
import { inferSort, patternSorts, resolveSymbol, type SymbolTable } from "../src/symbols.ts";
import {
  app,
  collect,
  koreText,
  type Pattern,
  patterns,
  type Sort,
  sortApp,
  sortVar,
  type SymbolDecl,
} from "../src/syntax.ts";

const FIXTURES = join(import.meta.dir, "..", "fixtures", "definitions");

function indexFixture(name: string): KoreDefinitionIndex {
  return indexDefinition(parseDefinition(readFileSync(join(FIXTURES, name), "utf8")));
}

const EMPTY = indexFixture("empty.definition.kore");
const A_TO_F = indexFixture("a-to-f.definition.kore");

/**
 * `syntax Foo ::= Bar [symbol(bar)]` as `kompile` writes it, plus the two
 * parametric declarations pyk's `resolve` documentation is about.
 */
const TEST = indexDefinition(
  parseDefinition(`
[]
module TEST
  sort SortFoo{} []
  sort SortBar{} []
  sort SortList{S} []
  symbol Lblbar{}(SortBar{}) : SortFoo{} [constructor{}()]
  symbol Lbldot{}() : SortFoo{} [constructor{}()]
  symbol inj{From, To}(From) : To [sortInjection{}()]
  symbol Lblfoo{S}(SortList{S}) : S []
endmodule []
`),
);

const [SORT_FOO, SORT_BAR] = [sortApp("SortFoo"), sortApp("SortBar")];
const SORT_K = sortApp("SortK");

describe("resolveSymbol", () => {
  test("Lblbar resolves to (SortFoo, (SortBar,)) — test_kompile.py:118", () => {
    expect(resolveSymbol(TEST, "Lblbar")).toEqual({ sort: SORT_FOO, paramSorts: [SORT_BAR] });
  });

  test("a plain `SymbolTable` works as well as an index", () => {
    const table: SymbolTable = TEST.symbols;
    expect(resolveSymbol(table, "Lblbar")).toEqual({ sort: SORT_FOO, paramSorts: [SORT_BAR] });
  });

  test("sort variables are substituted positionally", () => {
    expect(resolveSymbol(TEST, "inj", [SORT_BAR, SORT_FOO])).toEqual({
      sort: SORT_FOO,
      paramSorts: [SORT_BAR],
    });
  });

  /**
   * pyk's documented limitation (`kompiled.py:293-296`): `resolve_sort` replaces
   * a sort only when the sort *is* a variable, so `SortList{S}` keeps its `S`.
   * Transcribed rather than fixed — see the doc comment.
   */
  test("substitution is top-level only, as pyk's is", () => {
    const resolved = resolveSymbol(TEST, "Lblfoo", [SORT_BAR]);
    expect(resolved && koreText(resolved.sort)).toBe("SortBar{}");
    expect(resolved?.paramSorts.map(koreText)).toEqual(["SortList{S}"]);
  });

  test("undefined where pyk raises", () => {
    // Undeclared.
    expect(resolveSymbol(TEST, "Lblnope")).toBeUndefined();
    // An ML head is never an `App.symbol` here, so it is undeclared too — this
    // is the `ML_SYMBOL_DECLS` chaining we deliberately do not do.
    expect(resolveSymbol(TEST, "\\and")).toBeUndefined();
    // Wrong number of sort parameters, both ways.
    expect(resolveSymbol(TEST, "inj", [SORT_BAR])).toBeUndefined();
    expect(resolveSymbol(TEST, "Lblbar", [SORT_BAR])).toBeUndefined();
  });

  test("the answer does not share an array with the declaration", () => {
    // The answer must own its parameter array. Returning `decl.paramSorts`
    // would expose the parsed definition's shared state through the result.
    const decl = TEST.symbols.get("Lblbar")!;
    const resolved = resolveSymbol(TEST, "Lblbar")!;
    expect(resolved.paramSorts).not.toBe(decl.paramSorts);
    expect(resolved.paramSorts).toEqual(decl.paramSorts);
    expect(Object.isFrozen(resolved.paramSorts)).toBe(true);
    // And the parametric path, which builds a fresh array, agrees.
    const injected = resolveSymbol(TEST, "inj", [SORT_BAR, SORT_FOO])!;
    expect(Object.isFrozen(injected.paramSorts)).toBe(true);
    // A second call is unaffected by anything done to the first.
    expect(Reflect.set(resolved.paramSorts, 0, SORT_FOO)).toBe(false);
    expect(resolveSymbol(TEST, "Lblbar")).toEqual({ sort: SORT_FOO, paramSorts: [SORT_BAR] });
    expect(decl.paramSorts).toEqual([SORT_BAR]);
  });

  test("an alias is not a symbol", () => {
    // `--enable-kore-antileft` left-hand sides are alias applications; the
    // symbol table does not know them, and `aliases` does.
    const [aliasName] = [...A_TO_F.aliases.keys()];
    expect(aliasName).toBeDefined();
    expect(resolveSymbol(A_TO_F, aliasName!)).toBeUndefined();
  });
});

describe("inferSort", () => {
  test.each([
    ["a variable", "X:SortFoo{}", "SortFoo{}"],
    ["a set variable", "@X:SortFoo{}", "SortFoo{}"],
    ["a domain value", String.raw`\dv{SortInt{}}("1")`, "SortInt{}"],
    ["an application", "Lblbar{}(X:SortBar{})", "SortFoo{}"],
    ["an injection", "inj{SortBar{}, SortFoo{}}(X:SortBar{})", "SortFoo{}"],
    ["a connective", String.raw`\and{SortFoo{}}()`, "SortFoo{}"],
    // A predicate's sort is the *result* sort, not the argument sort.
    ["a predicate", String.raw`\ceil{SortBar{}, SortFoo{}}(X:SortBar{})`, "SortFoo{}"],
    ["a rewrite", String.raw`\rewrites{SortFoo{}}(X:SortFoo{}, Y:SortFoo{})`, "SortFoo{}"],
  ])("%s", (_name, text, expected) => {
    const sort = inferSort(TEST, parsePattern(text));
    expect(sort && koreText(sort)).toBe(expected);
  });

  test.each([
    ["an undeclared application", "Lblnope{}()"],
    ["a right-assoc", String.raw`\right-assoc{}(Lblbar{}(X:SortBar{}, Y:SortBar{}))`],
    ["a fixpoint", String.raw`\mu{}(@X:SortFoo{}, @X:SortFoo{})`],
  ])("%s has no sort", (_name, text) => {
    expect(inferSort(TEST, parsePattern(text))).toBeUndefined();
  });

  test("a bare String has no sort", () => {
    // Not reachable from `parsePattern`: a `String` is only ever a `\dv`'s
    // literal, which `patterns` does not yield either.
    expect(inferSort(TEST, { tag: "String", value: "x" })).toBeUndefined();
  });
});

describe("patternSorts", () => {
  function sortsOf(text: string): string[] | undefined {
    return patternSorts(TEST, parsePattern(text))?.map(koreText);
  }

  test.each([
    ["a domain value has no children", String.raw`\dv{SortInt{}}("1")`, []],
    ["a variable has no children", "X:SortFoo{}", []],
    ["\\top has no children", String.raw`\top{SortFoo{}}()`, []],
    ["\\not takes its own sort", String.raw`\not{SortFoo{}}(X:SortFoo{})`, ["SortFoo{}"]],
    ["\\implies takes it twice", String.raw`\implies{SortFoo{}}(X:SortFoo{}, Y:SortFoo{})`, ["SortFoo{}", "SortFoo{}"]],
    ["a quantifier takes its own sort", String.raw`\exists{SortFoo{}}(X:SortBar{}, Y:SortFoo{})`, ["SortFoo{}"]],
    // `\ceil{S, T}`'s child is at `S`, the *argument* sort.
    ["\\ceil takes its argument sort", String.raw`\ceil{SortBar{}, SortFoo{}}(X:SortBar{})`, ["SortBar{}"]],
    [
      "\\equals takes it twice",
      String.raw`\equals{SortBar{}, SortFoo{}}(X:SortBar{}, Y:SortBar{})`,
      ["SortBar{}", "SortBar{}"],
    ],
    ["a fixpoint takes its bound variable's sort", String.raw`\mu{}(@X:SortFoo{}, @X:SortFoo{})`, ["SortFoo{}"]],
    ["an application takes its parameter sorts", "Lblbar{}(X:SortBar{})", ["SortBar{}"]],
    ["an injection takes its instantiated one", "inj{SortBar{}, SortFoo{}}(X:SortBar{})", ["SortBar{}"]],
  ])("%s", (_name, text, expected) => {
    expect(sortsOf(text)).toEqual(expected);
  });

  /**
   * pyk's eleven `ML_SYMBOL_DECLS` declare `\and` and `\or` **binary**
   * (`syntax.py:1999-2000`), so its own `assert len(sorts) == len(patterns)`
   * (`kompiled.py:330`) fires on any other arity — and `\and{R}()` and
   * `\and{R}(a, b, c)` are both all over a real `definition.kore`.
   */
  test.each([0, 1, 2, 3, 4])("an n-ary \\and answers at arity %i", (arity) => {
    const args = Array.from({ length: arity }, (_, i) => `X${i}:SortFoo{}`).join(", ");
    expect(sortsOf(String.raw`\and{SortFoo{}}(${args})`)).toEqual(Array.from({ length: arity }, () => "SortFoo{}"));
  });

  test("undefined for an undeclared head and for assoc sugar", () => {
    expect(sortsOf("Lblnope{}()")).toBeUndefined();
    expect(sortsOf(String.raw`\right-assoc{}(Lblbar{}(X:SortBar{}, Y:SortBar{}))`)).toBeUndefined();
  });

  /**
   * The same-length contract is the function's whole point (pyk's closing
   * `assert len(sorts) == len(pattern.patterns)`, `kompiled.py:330`), and an
   * application whose arity disagrees with its declaration's is exactly where
   * pyk's assertion fires.  Returning the declaration's `paramSorts` unchecked
   * would break the contract on precisely the input it exists for.
   */
  test.each([
    ["too few arguments", "Lblbar{}()", 1, 0],
    ["too many arguments", "Lblbar{}(X:SortBar{}, Y:SortBar{})", 1, 2],
    ["a nullary declaration applied", "Lbldot{}(X:SortBar{})", 0, 1],
    ["a parametric symbol at the wrong arity", "inj{SortBar{}, SortFoo{}}()", 1, 0],
  ])("undefined when an application's arity is not its declaration's: %s", (_name, text, declared, written) => {
    const pattern = parsePattern(text);
    expect(pattern.tag).toBe("App");
    if (pattern.tag !== "App") return;
    // The premise: the symbol *is* declared, and the two arities really differ.
    const signature = resolveSymbol(TEST, pattern.symbol, pattern.sorts);
    expect(signature?.paramSorts).toHaveLength(declared);
    expect(patterns(pattern)).toHaveLength(written);

    expect(patternSorts(TEST, pattern)).toBeUndefined();
  });

  test("and defined, at the right length, when the arities agree", () => {
    expect(sortsOf("Lblbar{}(X:SortBar{})")).toEqual(["SortBar{}"]);
    expect(sortsOf("Lbldot{}()")).toEqual([]);
    expect(sortsOf("inj{SortBar{}, SortFoo{}}(X:SortBar{})")).toEqual(["SortBar{}"]);
  });

  /**
   * pyk's closing assertion, as a property over every pattern of both real
   * definitions: the expected-sorts array is parallel to the children.
   *
   * The only patterns exempted are the two the doc comment names — an
   * application whose head is an *alias* (`--enable-kore-antileft` left-hand
   * sides) and `\left-assoc`/`\right-assoc` — and the test asserts that both
   * exemptions are counted, so the test cannot pass vacuously where they apply:
   * only `a-to-f` was compiled with `--enable-kore-antileft` and so only it has
   * alias applications in an axiom body, and neither fixture contains a single
   * `\left-assoc`.
   */
  test.each([
    ["empty.definition.kore", EMPTY, 0],
    ["a-to-f.definition.kore", A_TO_F, 5],
  ] as const)("%s: patternSorts is parallel to patterns", (_name, index, expectedAliasHeads) => {
    let checked = 0;
    let aliasHeads = 0;
    let assocs = 0;
    for (const sentence of [...index.axioms, ...index.claims]) {
      collect(sentence.pattern, (p: Pattern) => {
        if (p.tag === "LeftAssoc" || p.tag === "RightAssoc") {
          expect(patternSorts(index, p)).toBeUndefined();
          assocs += 1;
          return;
        }
        if (p.tag === "App" && !index.symbols.has(p.symbol)) {
          expect(index.aliases.has(p.symbol)).toBe(true);
          expect(patternSorts(index, p)).toBeUndefined();
          aliasHeads += 1;
          return;
        }
        const sorts = patternSorts(index, p);
        expect(sorts).toBeDefined();
        expect(sorts).toHaveLength(patterns(p).length);
        checked += 1;
      });
    }
    expect(checked).toBeGreaterThan(1000);
    expect(aliasHeads).toBe(expectedAliasHeads);
    expect(assocs).toBe(0);
  });

  test("every symbol declaration resolves to itself", () => {
    for (const index of [EMPTY, A_TO_F]) {
      for (const [name, decl] of index.symbols) {
        const sorts: readonly Sort[] = decl.symbol.vars.map((v) => sortVar(v.name));
        expect(resolveSymbol(index, name, sorts)).toEqual({
          sort: decl.sort,
          paramSorts: decl.paramSorts,
        });
      }
    }
  });
});

describe("over a lazily parsed definition", () => {
  test("a lazy index resolves exactly as an eager one", () => {
    const text = readFileSync(join(FIXTURES, "empty.definition.kore"), "utf8");
    const lazy = indexDefinition(parseDefinition(text, { lazyAxioms: true }));
    expect(lazy.symbols.size).toBe(EMPTY.symbols.size);
    expect(resolveSymbol(lazy, "kseq")).toEqual(resolveSymbol(EMPTY, "kseq"));
    expect(inferSort(lazy, app("dotk"))).toEqual(SORT_K);
  });
});

/** A declaration built by hand resolves the same as a parsed one. */
test("resolveSymbol reads the declaration, not the text", () => {
  const decl: SymbolDecl = {
    tag: "SymbolDecl",
    symbol: { tag: "Symbol", name: "f", vars: [sortVar("S")] },
    paramSorts: [sortVar("S"), SORT_BAR],
    sort: sortVar("S"),
    attrs: [],
    hooked: false,
  };
  expect(resolveSymbol(new Map([["f", decl]]), "f", [SORT_FOO])).toEqual({
    sort: SORT_FOO,
    paramSorts: [SORT_FOO, SORT_BAR],
  });
});
