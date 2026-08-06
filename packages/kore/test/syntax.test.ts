/**
 * The AST suite.
 *
 * Three upstream tables are transcribed verbatim, and they are the acceptance
 * bar for this module:
 *
 * - `k/pyk/src/tests/unit/kore/test_identifiers.py` — 52 identifier cases,
 * - `k/pyk/src/tests/unit/kore/test_ml_pattern.py:47-72` — 24 `MLPattern.of`
 *   cases over the 18 ML heads,
 * - `k/pyk/src/tests/unit/kore/test_syntax.py` — the two traversal-order tests,
 *   whose expected outputs encode the exact visit order and nothing else.
 *
 * Everything else here is a writer golden or a depth guarantee.
 */

import { describe, expect, test } from "bun:test";
import {
  aliasDecl,
  and,
  app,
  axiom,
  bottom,
  bottomUp,
  ceil,
  claim,
  collect,
  ctorPatterns,
  definition,
  dv,
  equals,
  evar,
  exists,
  floor,
  forall,
  iff,
  implies,
  inPred,
  isId,
  isSetVarId,
  isSymbolId,
  koreImport,
  koreModule,
  koreString,
  koreSymbol,
  koreText,
  leftAssoc,
  ML_SYMBOLS,
  mlPattern,
  mlSorts,
  mlSymbol,
  mu,
  multiOr,
  next,
  not,
  nu,
  or,
  patterns,
  rewrites,
  rightAssoc,
  sortApp,
  sortDecl,
  sortVar,
  svar,
  symbolDecl,
  top,
  topDown,
  withPatterns,
  type MLPattern,
  type MLSymbol,
  type Pattern,
  type Sort,
} from "../src/syntax.ts";

//////////////////////
// Identifiers      //
//////////////////////

/** `test_identifiers.py:6-17`. */
const BASE_TEST_DATA: readonly (readonly [string, boolean])[] = [
  ["", false],
  ["-", false],
  ["'", false],
  ["0", false],
  ["@", false],
  ["a", true],
  ["A", true],
  ["a0", true],
  ["a-", true],
  ["a'", true],
];

/** `test_identifiers.py:19`. */
const ID_TEST_DATA = BASE_TEST_DATA;

/** `test_identifiers.py:31` — the base table, the same table `\`-prefixed, and `\sort`. */
const SYMBOL_ID_TEST_DATA: readonly (readonly [string, boolean])[] = [
  ...ID_TEST_DATA,
  ...BASE_TEST_DATA.map(([s, expected]) => ["\\" + s, expected] as const),
  ["\\sort", true],
];

/** `test_identifiers.py:43-47` — `@`-prefixed base, then every bare id (all false), then `@sort`. */
const SET_VARIABLE_ID_TEST_DATA: readonly (readonly [string, boolean])[] = [
  ...BASE_TEST_DATA.map(([s, expected]) => ["@" + s, expected] as const),
  ...ID_TEST_DATA.map(([s]) => [s, false] as const),
  ["@sort", true],
];

describe("isId — test_identifiers.py ID_TEST_DATA", () => {
  for (const [s, expected] of ID_TEST_DATA) {
    test(JSON.stringify(s), () => {
      expect(isId(s)).toBe(expected);
    });
  }
});

describe("isSymbolId — test_identifiers.py SYMBOL_ID_TEST_DATA", () => {
  for (const [s, expected] of SYMBOL_ID_TEST_DATA) {
    test(JSON.stringify(s), () => {
      expect(isSymbolId(s)).toBe(expected);
    });
  }
});

describe("isSetVarId — test_identifiers.py SET_VARIABLE_ID_TEST_DATA", () => {
  for (const [s, expected] of SET_VARIABLE_ID_TEST_DATA) {
    test(JSON.stringify(s), () => {
      expect(isSetVarId(s)).toBe(expected);
    });
  }
});

describe("constructors validate identifiers", () => {
  test("sort, module and element-variable names are <id>", () => {
    expect(() => sortVar("0")).toThrow(TypeError);
    expect(() => sortApp("\\Foo")).toThrow(TypeError);
    expect(() => evar("@x", sortApp("s"))).toThrow(TypeError);
    expect(() => koreImport("-M")).toThrow(TypeError);
    expect(() => koreModule("0M")).toThrow(TypeError);
    expect(() => sortDecl("'")).toThrow(TypeError);
  });

  test("symbols are <symbol-id>, set variables are <set-variable-id>", () => {
    expect(() => app("@f")).toThrow(TypeError);
    expect(app("\\f").symbol).toBe("\\f");
    expect(() => svar("x", sortApp("s"))).toThrow(TypeError);
    expect(svar("@x", sortApp("s")).name).toBe("@x");
    expect(() => koreSymbol("0")).toThrow(TypeError);
  });

  test("\\left-assoc and \\right-assoc reject an empty argument list", () => {
    // syntax.py:613-614, 670-672.
    expect(() => leftAssoc("f", [], [])).toThrow(TypeError);
    expect(() => rightAssoc("f", [], [])).toThrow(TypeError);
  });
});

//////////////////////
// ML patterns      //
//////////////////////

// `test_ml_pattern.py:41-45`.
const s = sortApp("s");
const t = sortApp("t");
const u = svar("@u", s);
const x = evar("x", s);
const y = evar("y", s);
const z = evar("z", s);
const val = koreString("val");
const appXY = app("app", [], [x, y]);

/** `test_ml_pattern.py:47-72` — `[id, symbol, sorts, patterns, expected]`. */
const ML_PATTERN_OF_TEST_DATA: readonly (readonly [
  string,
  MLSymbol,
  readonly Sort[],
  readonly Pattern[],
  MLPattern,
])[] = [
  ["top", "\\top", [s], [], top(s)],
  ["bottom", "\\bottom", [s], [], bottom(s)],
  ["not", "\\not", [s], [x], not(s, x)],
  ["and0", "\\and", [s], [], and(s, [])],
  ["and1", "\\and", [s], [x], and(s, [x])],
  ["and2", "\\and", [s], [x, y], and(s, [x, y])],
  ["and3", "\\and", [s], [x, y, z], and(s, [x, y, z])],
  ["or0", "\\or", [s], [], or(s, [])],
  ["or1", "\\or", [s], [x], or(s, [x])],
  ["or2", "\\or", [s], [x, y], or(s, [x, y])],
  ["or3", "\\or", [s], [x, y, z], or(s, [x, y, z])],
  ["implies", "\\implies", [s], [x, y], implies(s, x, y)],
  ["iff", "\\iff", [s], [x, y], iff(s, x, y)],
  ["exists", "\\exists", [s], [x, y], exists(s, x, y)],
  ["forall", "\\forall", [s], [x, y], forall(s, x, y)],
  ["mu", "\\mu", [], [u, x], mu(u, x)],
  ["nu", "\\nu", [], [u, x], nu(u, x)],
  ["ceil", "\\ceil", [s, t], [x], ceil(s, t, x)],
  ["floor", "\\floor", [s, t], [x], floor(s, t, x)],
  ["equals", "\\equals", [s, t], [x, y], equals(s, t, x, y)],
  ["in", "\\in", [s, t], [x, y], inPred(s, t, x, y)],
  ["next", "\\next", [s], [x], next(s, x)],
  ["rewrites", "\\rewrites", [s], [x, y], rewrites(s, x, y)],
  ["dv", "\\dv", [s], [val], dv(s, val)],
];

describe("mlPattern — test_ml_pattern.py ML_PATTERN_OF_TEST_DATA", () => {
  for (const [id, symbol, sorts, ps, expected] of ML_PATTERN_OF_TEST_DATA) {
    test(id, () => {
      const actual = mlPattern(symbol, sorts, ps);
      // The four assertions of `test_ml_pattern.py:88-94`.
      expect(actual).toEqual(expected);
      expect(mlSymbol(actual)).toBe(symbol);
      expect(mlSorts(actual)).toEqual(sorts);
      expect(ctorPatterns(actual)).toEqual(ps);
    });
  }
});

describe("ML_SYMBOLS", () => {
  test("has exactly the 18 heads of syntax.py:1793-1812", () => {
    expect(Object.keys(ML_SYMBOLS)).toEqual([
      "\\top",
      "\\bottom",
      "\\not",
      "\\and",
      "\\or",
      "\\implies",
      "\\iff",
      "\\exists",
      "\\forall",
      "\\mu",
      "\\nu",
      "\\ceil",
      "\\floor",
      "\\equals",
      "\\in",
      "\\next",
      "\\rewrites",
      "\\dv",
    ]);
  });

  test("does not contain the assoc sugar", () => {
    expect(() => mlPattern("\\left-assoc", [], [x])).toThrow(TypeError);
    expect(() => mlPattern("\\right-assoc", [], [x])).toThrow(TypeError);
    expect(() => mlPattern("\\nope", [s], [])).toThrow(TypeError);
  });
});

describe("mlPattern arity and type rules", () => {
  test("sort arity", () => {
    expect(() => mlPattern("\\top", [], [])).toThrow(TypeError);
    expect(() => mlPattern("\\top", [s, t], [])).toThrow(TypeError);
    expect(() => mlPattern("\\ceil", [s], [x])).toThrow(TypeError);
    // syntax.py:1300, 1340 — a fixpoint takes no sort parameters.
    expect(() => mlPattern("\\mu", [s], [u, x])).toThrow(TypeError);
    expect(() => mlPattern("\\nu", [s], [u, x])).toThrow(TypeError);
  });

  test("pattern arity", () => {
    expect(() => mlPattern("\\top", [s], [x])).toThrow(TypeError);
    expect(() => mlPattern("\\not", [s], [x, y])).toThrow(TypeError);
    expect(() => mlPattern("\\implies", [s], [x])).toThrow(TypeError);
    expect(() => mlPattern("\\rewrites", [s], [x, y, z])).toThrow(TypeError);
  });

  test("the three class constraints — syntax.py:1183, 1302, 1765", () => {
    expect(() => mlPattern("\\exists", [s], [u, x])).toThrow(TypeError); // needs EVar
    expect(() => mlPattern("\\forall", [s], [u, x])).toThrow(TypeError);
    expect(() => mlPattern("\\mu", [], [x, y])).toThrow(TypeError); // needs SVar
    expect(() => mlPattern("\\nu", [], [x, y])).toThrow(TypeError);
    expect(() => mlPattern("\\dv", [s], [x])).toThrow(TypeError); // needs String
  });
});

//////////////////////
// Writer goldens   //
//////////////////////

describe("koreText — sorts and leaves", () => {
  test("SortVar writes bare, SortApp writes its braces even when empty", () => {
    expect(koreText(sortVar("S"))).toBe("S");
    expect(koreText(sortApp("s"))).toBe("s{}");
    expect(koreText(sortApp("Map", [sortApp("Int"), sortVar("V")]))).toBe("Map{Int{}, V}");
  });

  test("variables", () => {
    expect(koreText(x)).toBe("x : s{}");
    expect(koreText(u)).toBe("@u : s{}");
  });

  test("strings are quoted here and escaped by escape.ts", () => {
    expect(koreText(koreString("val"))).toBe('"val"');
    expect(koreText(koreString('a"b\\c\n\u{1F642}'))).toBe('"a\\"b\\\\c\\n\\U0001f642"');
  });
});

describe("koreText — one golden per ML head", () => {
  const cases: readonly (readonly [string, Pattern, string])[] = [
    ["top", top(s), "\\top{s{}}()"],
    ["bottom", bottom(s), "\\bottom{s{}}()"],
    ["not", not(s, x), "\\not{s{}}(x : s{})"],
    ["and0", and(s, []), "\\and{s{}}()"],
    ["and1", and(s, [x]), "\\and{s{}}(x : s{})"],
    ["and3", and(s, [x, y, z]), "\\and{s{}}(x : s{}, y : s{}, z : s{})"],
    ["or0", or(s, []), "\\or{s{}}()"],
    ["or2", or(s, [x, y]), "\\or{s{}}(x : s{}, y : s{})"],
    ["implies", implies(s, x, y), "\\implies{s{}}(x : s{}, y : s{})"],
    ["iff", iff(s, x, y), "\\iff{s{}}(x : s{}, y : s{})"],
    ["exists", exists(s, x, y), "\\exists{s{}}(x : s{}, y : s{})"],
    ["forall", forall(s, x, y), "\\forall{s{}}(x : s{}, y : s{})"],
    ["mu", mu(u, x), "\\mu{}(@u : s{}, x : s{})"],
    ["nu", nu(u, x), "\\nu{}(@u : s{}, x : s{})"],
    ["ceil", ceil(s, t, x), "\\ceil{s{}, t{}}(x : s{})"],
    ["floor", floor(s, t, x), "\\floor{s{}, t{}}(x : s{})"],
    ["equals", equals(s, t, x, y), "\\equals{s{}, t{}}(x : s{}, y : s{})"],
    ["in", inPred(s, t, x, y), "\\in{s{}, t{}}(x : s{}, y : s{})"],
    ["next", next(s, x), "\\next{s{}}(x : s{})"],
    ["rewrites", rewrites(s, x, y), "\\rewrites{s{}}(x : s{}, y : s{})"],
    ["dv", dv(s, val), '\\dv{s{}}("val")'],
  ];

  for (const [id, node, expected] of cases) {
    test(id, () => {
      expect(koreText(node)).toBe(expected);
    });
  }
});

describe("koreText — applications and assoc sugar", () => {
  test("App", () => {
    expect(koreText(app("f"))).toBe("f{}()");
    expect(koreText(appXY)).toBe("app{}(x : s{}, y : s{})");
    expect(koreText(app("inj", [s, t], [x]))).toBe("inj{s{}, t{}}(x : s{})");
  });

  test("the sugar head carries no sorts; the wrapped application carries them", () => {
    // syntax.py:594-598 with `Assoc.app` at 582-584.
    expect(koreText(leftAssoc("f", [s], [x, y, z]))).toBe("\\left-assoc{}(f{s{}}(x : s{}, y : s{}, z : s{}))");
    expect(koreText(rightAssoc("f", [], [x, y]))).toBe("\\right-assoc{}(f{}(x : s{}, y : s{}))");
  });
});

describe("koreText — MultiOr", () => {
  test("writes as the n-ary \\or, losing `assoc`", () => {
    const left = multiOr("Left", s, [x, y, z]);
    const right = multiOr("Right", s, [x, y, z]);
    expect(koreText(left)).toBe("\\or{s{}}(x : s{}, y : s{}, z : s{})");
    // The documented lossiness: the two differ as values but not as text, and
    // an `Or` of the same contents is textually identical to both.
    expect(koreText(right)).toBe(koreText(left));
    expect(koreText(or(s, [x, y, z]))).toBe(koreText(left));
    expect(left).not.toEqual(right);
  });
});

describe("koreText — one golden per sentence form", () => {
  const attr = app("bar", [], [koreString("v")]);
  const S = sortVar("S");

  test("import", () => {
    expect(koreText(koreImport("FOO"))).toBe("import FOO []");
    expect(koreText(koreImport("FOO", [attr]))).toBe('import FOO [bar{}("v")]');
  });

  test("sort / hooked-sort", () => {
    expect(koreText(sortDecl("Foo", [S]))).toBe("sort Foo{S} []");
    expect(koreText(sortDecl("Foo", [], [attr], true))).toBe('hooked-sort Foo{} [bar{}("v")]');
  });

  test("symbol / hooked-symbol", () => {
    expect(koreText(symbolDecl(koreSymbol("f", [S]), [S, S], S))).toBe("symbol f{S}(S, S) : S []");
    expect(koreText(symbolDecl(koreSymbol("f"), [], sortApp("Int"), [attr], true))).toBe(
      'hooked-symbol f{}() : Int{} [bar{}("v")]',
    );
  });

  test("alias", () => {
    const decl = aliasDecl(koreSymbol("a", [S]), [S], S, app("a", [S], [evar("x", S)]), evar("x", S), [attr]);
    expect(koreText(decl)).toBe('alias a{S}(S) : S where a{S}(x : S) := x : S [bar{}("v")]');
  });

  test("axiom and claim differ only in the keyword", () => {
    const R = sortVar("R");
    expect(koreText(axiom([R], top(R)))).toBe("axiom{R} \\top{R}() []");
    expect(koreText(claim([R], top(R), [attr]))).toBe('claim{R} \\top{R}() [bar{}("v")]');
    expect(koreText(axiom([], top(R)))).toBe("axiom{} \\top{R}() []");
  });

  test("module — four-space sentence indent, attributes on endmodule", () => {
    const mod = koreModule("M", [koreImport("FOO"), sortDecl("Foo", [])], [attr]);
    expect(koreText(mod)).toBe(
      ["module M", "    import FOO []", "    sort Foo{} []", 'endmodule [bar{}("v")]'].join("\n"),
    );
    expect(koreText(koreModule("M"))).toBe("module M\nendmodule []");
  });

  test("definition — attributes first, modules separated by a blank line", () => {
    const def = definition([koreModule("A"), koreModule("B")], [attr]);
    expect(koreText(def)).toBe('[bar{}("v")]\n\nmodule A\nendmodule []\n\nmodule B\nendmodule []');
    expect(koreText(definition())).toBe("[]");
  });

  test("the symbol head on its own", () => {
    expect(koreText(koreSymbol("\\f", [S, sortVar("T")]))).toBe("\\f{S, T}");
  });
});

//////////////////////
// Child access     //
//////////////////////

describe("patterns / withPatterns", () => {
  test("binders do not expose their bound variable — syntax.py:1125-1127, 1256-1258", () => {
    expect(patterns(exists(s, x, y))).toEqual([y]);
    expect(patterns(forall(s, x, y))).toEqual([y]);
    expect(patterns(mu(u, x))).toEqual([x]);
    expect(patterns(nu(u, x))).toEqual([x]);
  });

  test("a \\dv has no subpatterns — syntax.py:1780-1782", () => {
    expect(patterns(dv(s, val))).toEqual([]);
    // ...but it writes one.
    expect(ctorPatterns(dv(s, val))).toEqual([val]);
  });

  test("leaves have none", () => {
    for (const leaf of [x, u, val, top(s), bottom(s)]) {
      expect(patterns(leaf)).toEqual([]);
    }
  });

  test("withPatterns is the inverse of patterns", () => {
    const nodes: readonly Pattern[] = [
      x,
      val,
      appXY,
      leftAssoc("f", [s], [x, y]),
      rightAssoc("f", [s], [x, y]),
      and(s, [x, y, z]),
      or(s, []),
      multiOr("Right", s, [x, y]),
      not(s, x),
      implies(s, x, y),
      exists(s, x, y),
      mu(u, x),
      ceil(s, t, x),
      equals(s, t, x, y),
      next(s, x),
      rewrites(s, x, y),
      dv(s, val),
    ];
    for (const node of nodes) {
      expect(withPatterns(node, patterns(node))).toEqual(node);
    }
  });

  test("withPatterns enforces arity", () => {
    expect(() => withPatterns(not(s, x), [])).toThrow(TypeError);
    expect(() => withPatterns(not(s, x), [x, y])).toThrow(TypeError);
    expect(() => withPatterns(implies(s, x, y), [x])).toThrow(TypeError);
    expect(() => withPatterns(x, [y])).toThrow(TypeError);
    expect(() => withPatterns(leftAssoc("f", [], [x]), [])).toThrow(TypeError);
    expect(() => withPatterns(multiOr("Left", s, [x]), [])).toThrow(TypeError);
  });

  test("withPatterns carries everything that is not a subpattern", () => {
    expect(withPatterns(multiOr("Right", s, [x]), [y])).toEqual(multiOr("Right", s, [y]));
    expect(withPatterns(exists(s, x, y), [z])).toEqual(exists(s, x, z));
    expect(withPatterns(ceil(s, t, x), [y])).toEqual(ceil(s, t, y));
  });
});

//////////////////////
// Traversals       //
//////////////////////

/**
 * `test_syntax.py:16-39`.  pyk builds its fixture from `prelude.dv(0)`, which
 * is `DV(SortApp('SortInt'), String('0'))` (`prelude.py:22,47-48`).
 */
const INT = sortApp("SortInt");
const intDv = (n: number): Pattern => dv(INT, koreString(String(n)));

const PATTERN: Pattern = app(
  "foo",
  [],
  [app("bar", [], [intDv(0), intDv(0)]), intDv(0), app("baz", [], [intDv(0), intDv(0), intDv(0)])],
);

/** `test_syntax.py:27-39` — a counter that renames every App and renumbers every DV. */
function rewriter(): (p: Pattern) => Pattern {
  let counter = 0;
  return (p: Pattern): Pattern => {
    if (p.tag === "App") return { ...p, symbol: `f${counter++}` };
    if (p.tag === "DV") return { ...p, value: koreString(String(counter++)) };
    return p;
  };
}

describe("traversal order", () => {
  test("bottomUp — test_syntax.py:42-58", () => {
    const expected = app(
      "f8",
      [],
      [app("f2", [], [intDv(0), intDv(1)]), intDv(3), app("f7", [], [intDv(4), intDv(5), intDv(6)])],
    );
    expect(bottomUp(PATTERN, rewriter())).toEqual(expected);
  });

  test("topDown — test_syntax.py:61-77", () => {
    const expected = app(
      "f0",
      [],
      [app("f1", [], [intDv(2), intDv(3)]), intDv(4), app("f5", [], [intDv(6), intDv(7), intDv(8)])],
    );
    expect(topDown(PATTERN, rewriter())).toEqual(expected);
  });

  test("collect — depth-first, node before children, left to right", () => {
    // syntax.py:367-372.
    const seen: string[] = [];
    collect(PATTERN, (p) => {
      seen.push(p.tag === "App" ? p.symbol : p.tag === "DV" ? `dv${p.value.value}` : p.tag);
    });
    expect(seen).toEqual(["foo", "bar", "dv0", "dv0", "dv0", "baz", "dv0", "dv0", "dv0"]);
  });

  test("collect does not descend into a binder's variable or a \\dv's value", () => {
    const seen: string[] = [];
    collect(exists(s, x, mu(u, dv(s, val))), (p) => {
      seen.push(p.tag);
    });
    expect(seen).toEqual(["Exists", "Mu", "DV"]);
  });

  test("topDown sees the children of f's result, not of the original", () => {
    // syntax.py:350-365 — `f` is applied before descent, and descent uses the
    // rewritten node.
    const replaced = topDown(app("a", [], [x]), (p) => (p.tag === "App" && p.symbol === "a" ? appXY : p));
    expect(replaced).toEqual(appXY);
  });
});

//////////////////////
// Depth            //
//////////////////////

describe("no recursion anywhere", () => {
  const DEPTH = 100_000;

  /** Built with a loop, because building it with recursion would itself blow the stack. */
  function deepNot(depth: number): Pattern {
    let node: Pattern = top(s);
    for (let i = 0; i < depth; i++) node = not(s, node);
    return node;
  }

  test(`koreText renders a ${DEPTH}-deep \\not chain`, () => {
    const text = koreText(deepNot(DEPTH));
    // `\not{s{}}(` is 10 chars, the closing `)` is 1, and the core is `\top{s{}}()`.
    expect(text.length).toBe(DEPTH * 11 + "\\top{s{}}()".length);
    expect(text.startsWith("\\not{s{}}(\\not{s{}}(")).toBe(true);
    expect(text.endsWith("\\top{s{}}()" + ")".repeat(DEPTH))).toBe(true);
  });

  test(`bottomUp walks a ${DEPTH}-deep \\not chain`, () => {
    let visits = 0;
    const result = bottomUp(deepNot(DEPTH), (p) => {
      visits++;
      return p;
    });
    expect(visits).toBe(DEPTH + 1);
    expect(result.tag).toBe("Not");
  });

  test(`topDown and collect walk a ${DEPTH}-deep \\not chain`, () => {
    let down = 0;
    topDown(deepNot(DEPTH), (p) => {
      down++;
      return p;
    });
    expect(down).toBe(DEPTH + 1);

    let visited = 0;
    collect(deepNot(DEPTH), () => {
      visited++;
    });
    expect(visited).toBe(DEPTH + 1);
  });
});
