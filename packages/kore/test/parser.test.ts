/**
 * The parser suite.
 *
 * Two oracles, and they answer different questions:
 *
 * 1. **`fixtures/parser/`** — 98 `.kore` inputs paired with the *stderr of the
 *    reference parser* (`fixtures/PROVENANCE.md`).  It is a positive and a
 *    negative oracle at once, and the two classes of non-empty golden must not
 *    be conflated: a `<file>.kore:<line>:<col>: …` golden is a parse error we
 *    must reproduce **at that position**, while an `Error:` golden is a
 *    *semantic-validity* failure of an input that is syntactically fine and
 *    that we must therefore **accept** (§Validity of `kore-syntax.md` is out of
 *    scope for this package).
 * 2. **pyk's tables** — `test_parser.py::MULTI_OR_TEST_DATA` (4) and
 *    `MULTIARY_TEST_DATA` (10), transcribed verbatim.  `STRING_TEST_DATA` is
 *    not here; it is `test/escape.test.ts`'s business.
 *
 * Round-trip everywhere it applies: parse → `koreText` → reparse → deep-equal.
 * The text round-trip catches writer and reader bugs symmetrically.
 */

import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { KoreSyntaxError } from "../src/lexer.ts";
import {
  forceAxiom,
  KoreParser,
  type LazyAxiom,
  type LazyDefinition,
  parseDefinition,
  parseMultiOr,
  parsePattern,
  parseSort,
} from "../src/parser.ts";
import { and, app, koreText, or, sortVar, type Definition, type Module, type Pattern } from "../src/syntax.ts";

const FIXTURES = join(import.meta.dir, "..", "fixtures");

function koreFiles(dir: string): string[] {
  return readdirSync(dir)
    .filter((name) => name.endsWith(".kore"))
    .toSorted();
}

/** Parse, write, reparse, and require the two parses to be the same term. */
function roundTrips<T extends Definition | Module | Pattern>(parse: (text: string) => T, value: T): void {
  expect(parse(koreText(value))).toEqual(value);
}

/** Run `f`, require it to throw a {@link KoreSyntaxError}, and hand it back positioned. */
function expectSyntaxError(f: () => unknown): KoreSyntaxError {
  let thrown: unknown;
  try {
    f();
  } catch (err) {
    thrown = err;
  }
  expect(thrown).toBeInstanceOf(KoreSyntaxError);
  if (!(thrown instanceof KoreSyntaxError)) throw new Error("expected a KoreSyntaxError");
  return thrown;
}

/** `text` with every line ending rewritten to CRLF. */
function crlf(text: string): string {
  return text.replaceAll("\n", "\r\n");
}

/** Parse `text` lazily and return the lazy axioms of every module. */
function lazyAxiomsOf(text: string): LazyAxiom[] {
  return parseDefinition(text, { lazyAxioms: true }).modules.flatMap((module) =>
    module.sentences.filter((s) => s.tag === "LazyAxiom"),
  );
}

//////////////////////////////
// fixtures/parser (98)     //
//////////////////////////////

/**
 * A golden of the form `<file>.kore:<line>:<col>: …` — the reference parser
 * rejected the input at that position.  Anything else (empty, or the `Error:`
 * prose of the validity checker) means the input parses.
 */
const GOLDEN_POSITION = /^\S+\.kore:(\d+):(\d+):/u;

/**
 * Files whose *column* the reference and this parser disagree about.
 *
 * Empty, and that is the finding: all ten parse-error goldens match to the
 * column.  Two of them only do so because the lexer validates string literals
 * itself rather than deferring to `dequoteString` — see the header of
 * `src/lexer.ts`.  If an entry is ever added here it must name the
 * tokenization-convention difference that causes it; the line assertion stays
 * unconditional either way.
 */
const COLUMN_DIVERGENCE: ReadonlySet<string> = new Set<string>();

const PARSER_DIR = join(FIXTURES, "parser");
const PARSER_FILES = koreFiles(PARSER_DIR);

const PARSER_CASES = PARSER_FILES.map((name) => {
  const golden = readFileSync(join(PARSER_DIR, `${name}.golden`), "utf8");
  const position = GOLDEN_POSITION.exec(golden);
  return { name, golden, position };
});

const ACCEPT_CASES = PARSER_CASES.filter((c) => c.position === null).map((c) => c.name);
const REJECT_CASES = PARSER_CASES.filter((c) => c.position !== null);

describe("fixtures/parser", () => {
  test("the corpus is complete and split as PROVENANCE describes", () => {
    expect(PARSER_FILES).toHaveLength(98);
    // 88 syntactically valid (72 fully valid + 16 that fail only the validity
    // checker), 10 genuine parse errors.
    expect(ACCEPT_CASES).toHaveLength(88);
    expect(REJECT_CASES).toHaveLength(10);
  });

  describe("parses and round-trips", () => {
    test.each(ACCEPT_CASES)("%s", (name) => {
      const text = readFileSync(join(PARSER_DIR, name), "utf8");
      const parsed = parseDefinition(text);
      roundTrips(parseDefinition, parsed);
    });
  });

  describe("rejects at the reference's position", () => {
    test.each(REJECT_CASES)("$name → $position.1:$position.2", ({ name, position }) => {
      const text = readFileSync(join(PARSER_DIR, name), "utf8");
      const [, line, col] = position!;

      let thrown: unknown;
      try {
        parseDefinition(text);
      } catch (err) {
        thrown = err;
      }
      expect(thrown).toBeInstanceOf(KoreSyntaxError);
      if (!(thrown instanceof KoreSyntaxError)) return;

      expect(thrown.line).toBe(Number(line));
      if (!COLUMN_DIVERGENCE.has(name)) expect(thrown.col).toBe(Number(col));
      // The message text is not chased: the reference names Haskell token
      // constructors (`TokenSort`, `TokenLeftBracket`) that have no counterpart
      // here. The position is the contract.
      expect(thrown.message).toStartWith(`${line}:${col}: `);
    });
  });

  test("the semantically-invalid inputs are accepted, not rejected", () => {
    // The 16 `Error:` goldens: syntactically fine, semantically wrong. If a
    // validity checker is ever written, these are its ready-made suite.
    const semantic = PARSER_CASES.filter((c) => c.position === null && c.golden.startsWith("Error:"));
    expect(semantic).toHaveLength(16);
    for (const { name } of semantic) {
      expect(() => parseDefinition(readFileSync(join(PARSER_DIR, name), "utf8"))).not.toThrow();
    }
  });
});

//////////////////////////////
// fixtures/patterns (4)    //
//////////////////////////////

const PATTERNS_DIR = join(FIXTURES, "patterns");

describe("fixtures/patterns", () => {
  const files = koreFiles(PATTERNS_DIR);

  test("all four are present", () => {
    expect(files).toEqual(["left-assoc.kore", "right-assoc.kore", "string-aposthrophe.kore", "top.kore"]);
  });

  describe("parses and round-trips", () => {
    test.each(files)("%s", (name) => {
      const parsed = parsePattern(readFileSync(join(PATTERNS_DIR, name), "utf8"));
      roundTrips(parsePattern, parsed);
    });
  });

  test("`\\left-assoc{}(app(…))` is a LeftAssoc, not an expanded cascade", () => {
    // pyk keeps the sugar as a node (`syntax.py:601-656`); scala-kore expands
    // it eagerly and cannot write it back. The three operands stay three.
    const parsed = parsePattern(readFileSync(join(PATTERNS_DIR, "left-assoc.kore"), "utf8"));
    expect(parsed.tag).toBe("LeftAssoc");
    if (parsed.tag !== "LeftAssoc") return;
    expect(parsed.symbol).toBe("Lbl'Unds'Map'Unds'");
    expect(parsed.sorts).toEqual([]);
    expect(parsed.args).toHaveLength(3);
    expect(parsed.args.map((a) => a.tag)).toEqual(["App", "App", "App"]);
  });

  test("`\\right-assoc{}(app(…))` is a RightAssoc", () => {
    const parsed = parsePattern(readFileSync(join(PATTERNS_DIR, "right-assoc.kore"), "utf8"));
    expect(parsed.tag).toBe("RightAssoc");
    if (parsed.tag !== "RightAssoc") return;
    expect(parsed.symbol).toBe("Lbl'Unds'Map'Unds'");
    expect(parsed.args).toHaveLength(3);
  });

  test("the assoc sugar's own sort list must be empty", () => {
    // `Parser.y:228-236`: `leftAssoc '{' '}' '('…`. The sorts belong to the
    // wrapped application.
    expect(() => parsePattern(String.raw`\left-assoc{S}(f{}(a{}(), b{}()))`)).toThrow(KoreSyntaxError);
  });

  test("the assoc sugar needs at least one operand", () => {
    // `syntax.py:613-614` and `Parser.y:228` (`NePatterns`) agree. The error is
    // positioned at the `\left-assoc` head, not at the AST constructor.
    expect(() => parsePattern(String.raw`\left-assoc{}(f{}())`)).toThrow("1:1: ");
  });

  test("an apostrophe inside a string literal survives the round trip", () => {
    const parsed = parsePattern(readFileSync(join(PATTERNS_DIR, "string-aposthrophe.kore"), "utf8"));
    expect(parsed).toEqual({ tag: "String", value: '"' });
  });
});

//////////////////////////////
// fixtures/definitions (3) //
//////////////////////////////

const DEFINITIONS_DIR = join(FIXTURES, "definitions");

describe("fixtures/definitions", () => {
  test.each(["empty.definition.kore", "a-to-f.definition.kore"])("%s parses and round-trips", (name) => {
    const parsed = parseDefinition(readFileSync(join(DEFINITIONS_DIR, name), "utf8"));
    expect(parsed.modules.length).toBeGreaterThan(4);
    roundTrips(parseDefinition, parsed);
  });

  /**
   * `prelude.kore` is a *module sequence*, not a definition: it has no leading
   * definition-level attribute list, because `kompile` concatenates it in front
   * of one.  `Parser.y:129-130` (`Definition : Attributes Modules`) makes the
   * `[…]` mandatory, so the reference parser would reject this file standalone
   * too, and `parseDefinition` correctly does.  Reading it as what it is takes
   * the {@link KoreParser} class directly.
   */
  function preludeModules(): Module[] {
    const parser = new KoreParser(readFileSync(join(DEFINITIONS_DIR, "prelude.kore"), "utf8"));
    const modules: Module[] = [];
    while (!parser.eof) modules.push(parser.module());
    return modules;
  }

  test("prelude.kore is a module sequence, not a definition", () => {
    expect(() => parseDefinition(readFileSync(join(DEFINITIONS_DIR, "prelude.kore"), "utf8"))).toThrow(
      '1:1: unexpected KW_MODULE "module", expected LBRACK',
    );
  });

  test("prelude.kore declares BASIC-K, KSEQ, INJ and K", () => {
    expect(preludeModules().map((m) => m.name)).toEqual(["BASIC-K", "KSEQ", "INJ", "K"]);
  });

  test("prelude.kore's other whitespace style is read the same", () => {
    // 4-space indent and `axiom {R}` with a space, where pyk's writer emits
    // `axiom{R}`. A reader must not care; only the writer picks a spelling.
    const modules = preludeModules();
    for (const parsed of modules) {
      expect(new KoreParser(koreText(parsed)).module()).toEqual(parsed);
    }
  });

  test("prelude.kore carries the sentences it is famous for", () => {
    const [basicK, kseq, inj] = preludeModules();
    expect(basicK?.sentences.map((s) => s.tag)).toEqual(["SortDecl", "SortDecl"]);
    expect(kseq?.sentences.filter((s) => s.tag === "SymbolDecl").map((s) => s.symbol.name)).toEqual([
      "kseq",
      "dotk",
      "append",
    ]);
    expect(inj?.sentences.some((s) => s.tag === "SymbolDecl" && s.symbol.name === "inj")).toBe(true);
  });
});

//////////////////////////////
// Lazy axiom bodies        //
//////////////////////////////

/**
 * `parseDefinition(text, {lazyAxioms: true})` — the memory fix.
 *
 * Three properties:
 *
 * 1. **Nothing is materialized.**  Asserted structurally — every axiom is a
 *    `LazyAxiom` carrying offsets and no `pattern` field — rather than by
 *    measuring the heap, which is not a stable thing to assert on.
 * 2. **Nothing is lost.**  `forceAxiom` on every axiom of a lazy parse reproduces
 *    the eager parse exactly, sentence for sentence.
 * 3. **Nothing moves.**  A rejected input is rejected at the same line and column
 *    either way — which for a body-level error means *after* `forceAxiom`, since
 *    a lazy parse does not look inside a body at all.  See
 *    {@link assertLazyAgreesWithEager}, which is the whole contract in one
 *    function, and the sweep below that runs it over every `.kore` file the
 *    package ships.
 */
describe("lazy axiom bodies", () => {
  const LAZY_FIXTURES = ["empty.definition.kore", "a-to-f.definition.kore"];

  function read(name: string): string {
    return readFileSync(join(DEFINITIONS_DIR, name), "utf8");
  }

  test.each(LAZY_FIXTURES)("%s: no axiom body is materialized", (name) => {
    const text = read(name);
    const lazy = parseDefinition(text, { lazyAxioms: true });
    const axioms = lazy.modules.flatMap((module) => module.sentences.filter((s) => s.tag === "LazyAxiom"));
    expect(axioms.length).toBeGreaterThan(100);

    let bodyBytes = 0;
    for (const axiom of axioms) {
      // The whole retained representation of a body: four numbers, two of them
      // the span and two the position the span starts at. No `pattern` key
      // exists to hold a body, and the offsets bracket a non-empty stretch of
      // the source that is never sliced.
      expect(Object.keys(axiom).toSorted()).toEqual([
        "attrs",
        "bodyCol",
        "bodyEnd",
        "bodyLine",
        "bodyStart",
        "tag",
        "vars",
      ]);
      expect(axiom).not.toHaveProperty("pattern");
      expect(axiom.bodyEnd).toBeGreaterThan(axiom.bodyStart);
      expect(text.charAt(axiom.bodyEnd)).toBe("[");
      // `bodyLine`/`bodyCol` address `bodyStart` under the lexer's rule: only
      // `\n` starts a line, so the column is the distance to the last one.
      expect(text.slice(0, axiom.bodyStart).split("\n")).toHaveLength(axiom.bodyLine);
      expect(axiom.bodyStart - (text.lastIndexOf("\n", axiom.bodyStart - 1) + 1)).toBe(axiom.bodyCol - 1);
      bodyBytes += axiom.bodyEnd - axiom.bodyStart;
    }
    // Axiom bodies are the bulk of the file — 45 % of these two, and ~95 % of a
    // real one, where the `Source(/nix/store/…)` attribute that dominates these
    // small fixtures is amortized over far more rules.
    expect(bodyBytes).toBeGreaterThan(text.length / 3);
  });

  test.each(LAZY_FIXTURES)("%s: attributes are eager, so the definition still indexes", (name) => {
    const lazy = parseDefinition(read(name), { lazyAxioms: true });
    const axioms = lazy.modules.flatMap((module) => module.sentences.filter((s) => s.tag === "LazyAxiom"));
    // `subsort`, `UNIQUE'Unds'ID`, `label`, `priority` — everything
    // `definition.ts` reads is here, parsed.
    expect(axioms.some((a) => a.attrs.some((attr) => attr.symbol === "subsort"))).toBe(true);
    expect(axioms.some((a) => a.attrs.some((attr) => attr.symbol === "UNIQUE'Unds'ID"))).toBe(true);
    expect(axioms.flatMap((a) => a.attrs).length).toBeGreaterThan(100);
  });

  const SKIPPER_CASES: readonly (readonly [string, string])[] = [
    // The hazard the skipper exists for: `[`, `(`, `)` and an escaped quote
    // inside a string literal, none of which may end the body.
    ["a string literal", String.raw`\dv{SortString{}}("[ ) ( \" ]")`],
    ["a line comment", "\\top{R}() // a ] and a ) in a comment\n"],
    ["a block comment", "\\top{R}(/* ] ) [ */)"],
    // Not every body is parenthesized: a bare variable is a legal pattern, and a
    // skipper written as "match the paren after the head" would not find its end.
    ["a bare variable", "X:SortK{}"],
    ["a bare string", String.raw`"]"`],
    ["nested parentheses", String.raw`\and{R}(\top{R}(), \equals{SortK{}, R}(X:SortK{}, dotk{}()))`],
  ];

  describe("the body skipper respects strings and comments", () => {
    test.each(SKIPPER_CASES)("%s", (_name, body) => {
      const text = `[]\nmodule M\n  axiom{R} ${body} [foo{}("bar")]\nendmodule []\n`;
      const [lazy] = lazyAxiomsOf(text);
      const [eager] = parseDefinition(text).modules[0]!.sentences;
      expect(lazy).toBeDefined();
      expect(eager?.tag).toBe("Axiom");
      if (lazy === undefined || eager?.tag !== "Axiom") return;
      expect(forceAxiom(text, lazy)).toEqual(eager);
      expect(lazy.attrs.map((a) => a.symbol)).toEqual(["foo"]);
    });
  });

  test("claims are not lazy", () => {
    const text = "[]\nmodule M\n  claim{R} \\top{R}() []\n  axiom{R} \\top{R}() []\nendmodule []\n";
    const sentences = parseDefinition(text, { lazyAxioms: true }).modules[0]!.sentences;
    expect(sentences.map((s) => s.tag)).toEqual(["Claim", "LazyAxiom"]);
  });

  /**
   * The skipper maintains `line`/`col` itself and hands them back to the lexer,
   * so an error *after* a skipped body must be reported where an eager parse
   * reports it.  Nothing else in the suite would catch that bookkeeping being
   * off.
   */
  test("positions after a skipped body are the eager parser's", () => {
    const text = [
      "[]",
      "module M",
      "  axiom{R} \\and{R}(",
      '    \\dv{SortString{}}("a\\nb"),   // ] ) [',
      "    \\top{R}()",
      "  ) []",
      "  sort ??? []",
      "endmodule []",
    ].join("\n");

    const eagerError = expectSyntaxError(() => parseDefinition(text));
    const lazyError = expectSyntaxError(() => parseDefinition(text, { lazyAxioms: true }));
    expect(eagerError.line).toBe(7);
    expect(lazyError.line).toBe(eagerError.line);
    expect(lazyError.col).toBe(eagerError.col);
  });

  test("an unterminated body is a syntax error, not a hang", () => {
    const err = expectSyntaxError(() =>
      parseDefinition("[]\nmodule M\n  axiom{R} \\top{R}(\nendmodule []\n", {
        lazyAxioms: true,
      }),
    );
    expect(err.message).toContain("unexpected end of input");
  });

  test("an unbalanced `)` in a body is rejected where the eager parser rejects it", () => {
    expect(() =>
      parseDefinition("[]\nmodule M\n  axiom{R} \\top{R}()) []\nendmodule []\n", { lazyAxioms: true }),
    ).toThrow(KoreSyntaxError);
  });

  //////////////////////////////
  // The contract, everywhere //
  //////////////////////////////

  /**
   * The whole lazy/eager contract, asserted over one text.  Returns how many
   * axioms it forced, so a caller can prove it did not pass vacuously.
   *
   * The rejecting half is the part that is easy to get wrong.  A lazy parse does
   * not tokenise a body, so a *body*-level error cannot surface until
   * `forceAxiom` — and when it does, its position must be the eager parser's, in
   * file coordinates.  Anything else is a position that cannot be looked up in
   * the file it came from.
   */
  function assertLazyAgreesWithEager(text: string): number {
    let eager: Definition | undefined;
    let eagerError: KoreSyntaxError | undefined;
    try {
      eager = parseDefinition(text);
    } catch (err) {
      if (!(err instanceof KoreSyntaxError)) throw err;
      eagerError = err;
    }

    if (eagerError !== undefined) {
      let lazy: LazyDefinition | undefined;
      try {
        lazy = parseDefinition(text, { lazyAxioms: true });
      } catch (err) {
        // The error is outside every axiom body, so the lazy parse meets it too.
        expect(err).toBeInstanceOf(KoreSyntaxError);
        if (!(err instanceof KoreSyntaxError)) return 0;
        expect([err.line, err.col]).toEqual([eagerError.line, eagerError.col]);
        return 0;
      }
      // The error is *inside* a body, so the lazy parse accepted a definition
      // the eager one rejected. Forcing must find it, at the same position.
      const forced = expectSyntaxError(() => {
        for (const axiom of lazy.modules.flatMap((m) => m.sentences.filter((s) => s.tag === "LazyAxiom"))) {
          forceAxiom(text, axiom);
        }
      });
      expect([forced.line, forced.col]).toEqual([eagerError.line, eagerError.col]);
      return 0;
    }

    const lazy = parseDefinition(text, { lazyAxioms: true });
    expect(lazy.modules).toHaveLength(eager!.modules.length);
    let forcedAxioms = 0;
    for (const [m, module] of lazy.modules.entries()) {
      const eagerModule = eager!.modules[m]!;
      expect(module.name).toBe(eagerModule.name);
      expect(module.attrs).toEqual(eagerModule.attrs);
      expect(module.sentences).toHaveLength(eagerModule.sentences.length);
      for (const [s, sentence] of module.sentences.entries()) {
        const expected = eagerModule.sentences[s]!;
        if (sentence.tag !== "LazyAxiom") {
          // Everything that is not an axiom is parsed identically, claims included.
          expect(sentence).toEqual(expected);
          continue;
        }
        // A lazy axiom stands exactly where an eager one stood.
        expect(expected.tag).toBe("Axiom");
        if (expected.tag !== "Axiom") continue;
        expect(forceAxiom(text, sentence)).toEqual(expected);
        forcedAxioms += 1;
      }
    }
    return forcedAxioms;
  }

  /** Every `.kore` file the package ships, as a path relative to `fixtures/`. */
  const ALL_KORE_FILES: string[] = ["definitions", "parser", "patterns"].flatMap((dir) =>
    koreFiles(join(FIXTURES, dir)).map((name) => `${dir}/${name}`),
  );

  /**
   * The sweep covers every shipped fixture so both accepted and rejected
   * shapes are checked under lazy and eager parsing.
   */
  describe("every .kore fixture agrees, lazy and eager", () => {
    test("the sweep really is every file", () => {
      // 98 in `parser/`, 4 in `patterns/`, 3 in `definitions/`.
      expect(ALL_KORE_FILES).toHaveLength(105);
    });

    test.each(ALL_KORE_FILES)("%s", (relative) => {
      assertLazyAgreesWithEager(readFileSync(join(FIXTURES, relative), "utf8"));
    });

    test("and there are axioms in it to force", () => {
      // Guards the sweep against passing because no file happened to have an
      // axiom — `patterns/*.kore` are bare patterns and `prelude.kore` is a
      // module sequence, so a fair share of the corpus contributes nothing.
      let axioms = 0;
      let rejected = 0;
      for (const relative of ALL_KORE_FILES) {
        const text = readFileSync(join(FIXTURES, relative), "utf8");
        try {
          parseDefinition(text);
        } catch {
          rejected += 1;
          continue;
        }
        axioms += lazyAxiomsOf(text).length;
      }
      expect(axioms).toBeGreaterThan(300);
      // And the rejecting half of the contract is exercised too: 10 goldens in
      // `parser/`, plus the 4 bare patterns and `prelude.kore`, which are not
      // definitions at all.
      expect(rejected).toBe(15);
    });
  });

  /**
   * Body shapes no fixture contains.
   *
   * `\left-assoc`, `\right-assoc`, `\mu` and `\nu` appear in no `.kore`
   * *definition* the package ships (the two assoc fixtures are bare patterns),
   * and they are exactly the shapes a body skipper written against "the head is
   * an application" would mishandle.
   */
  const SHAPE_CASES: readonly (readonly [string, string, string])[] = [
    ["R", "\\left-assoc", String.raw`\left-assoc{}(Lbl'Unds'Map'Unds'{}(a{}(), b{}(), c{}()))`],
    ["R", "\\right-assoc", String.raw`\right-assoc{}(kseq{}(a{}(), b{}(), dotk{}()))`],
    ["", "\\mu", String.raw`\mu{}(@X:SortFoo{}, \and{SortFoo{}}(@X:SortFoo{}, \top{SortFoo{}}()))`],
    ["", "\\nu", String.raw`\nu{}(@X:SortFoo{}, \or{SortFoo{}}(@X:SortFoo{}, \bottom{SortFoo{}}()))`],
    // A multi-sort-variable axiom head: `sortVarList` runs before the skipper,
    // and the body's recorded position starts after the last of them.
    ["R, S, T", "three sort variables", String.raw`\equals{SortK{}, R}(X:SortK{}, dotk{}())`],
    [
      "R",
      "an assoc sugar nested in a connective",
      String.raw`\and{R}(\left-assoc{}(Lbl'Unds'Map'Unds'{}(a{}(), b{}())))`,
    ],
  ];

  test.each(SHAPE_CASES)("a body containing %s: %s", (vars, _name, body) => {
    const text = `[]\nmodule M\n  axiom{${vars}} ${body} [foo{}()]\nendmodule []\n`;
    expect(assertLazyAgreesWithEager(text)).toBe(1);
  });

  /**
   * CRLF.
   *
   * `\r` is not a line terminator to this lexer — only `\n` is — so it advances
   * the column like any other character, and it only ever sits at end of line,
   * where nothing is ever positioned.  Columns are therefore unchanged by
   * rewriting a file to CRLF, and the lazy path must agree with the eager one
   * there too: `skipAxiomBody` maintains `line`/`col` by hand, and `forceAxiom`
   * rebases onto them.
   */
  describe("CRLF line endings", () => {
    test.each(LAZY_FIXTURES)("%s under CRLF still agrees, lazy and eager", (name) => {
      const text = crlf(read(name));
      expect(text).toContain("\r\n");
      expect(assertLazyAgreesWithEager(text)).toBeGreaterThan(100);
    });

    test.each(SHAPE_CASES)("a CRLF body containing %s: %s", (vars, _name, body) => {
      const text = crlf(`[]\nmodule M\n  axiom{${vars}}\n    ${body}\n  [foo{}()]\nendmodule []\n`);
      expect(assertLazyAgreesWithEager(text)).toBe(1);
    });

    test("a body error keeps its position under CRLF", () => {
      // `test-exception-2.kore`, whose golden is `6:5`: a body that is the bare
      // keyword `sort`. The `\r`s sit at ends of line, so every column is the
      // one the LF spelling has, and both parsers must still say 6:5.
      const text = crlf(readFileSync(join(PARSER_DIR, "test-exception-2.kore"), "utf8"));
      const eagerError = expectSyntaxError(() => parseDefinition(text));
      expect([eagerError.line, eagerError.col]).toEqual([6, 5]);
      assertLazyAgreesWithEager(text);
    });
  });

  /**
   * The two fixtures that lazy-parse and then fail at `forceAxiom` — the finding
   * the sweep above generalizes, kept here by name because the goldens are the
   * reference parser's own stderr and the positions are the contract.
   */
  test.each([
    ["test-dv-2.kore", 3, 22],
    ["test-exception-2.kore", 6, 5],
  ])("%s: a lazy parse defers the error to forceAxiom, at the golden position", (name, line, col) => {
    const text = readFileSync(join(PARSER_DIR, name), "utf8");
    // The premise: the eager parser rejects it at the golden position, and the
    // lazy one accepts it — which is what makes `forceAxiom` the only place the
    // error can be found.
    const eagerError = expectSyntaxError(() => parseDefinition(text));
    expect([eagerError.line, eagerError.col]).toEqual([line, col]);
    const [lazy] = lazyAxiomsOf(text);
    expect(lazy).toBeDefined();
    if (lazy === undefined) return;

    const forced = expectSyntaxError(() => forceAxiom(text, lazy));
    // Rebased onto the file, not left at its position in the sliced body.
    expect([forced.line, forced.col]).toEqual([line, col]);
    expect(forced.message).toStartWith(`${line}:${col}: `);
    // And the position is one that can be looked up: the body starts there or
    // later, and the file has that many lines.
    expect(text.split("\n").length).toBeGreaterThanOrEqual(forced.line);
  });

  test("an error on a body's second line is offset in line only, not in column", () => {
    // Only the body's first line shares a line with the `axiom{…}` head, so only
    // its columns are shifted. Getting this wrong is invisible on a one-line
    // body, which is what every fixture has.
    const text = [
      "[]",
      "module M",
      "  axiom{R} \\and{R}(",
      "    \\top{R}(),",
      "    \\or{R}",
      "  ) []",
      "endmodule []",
    ].join("\n");
    const eagerError = expectSyntaxError(() => parseDefinition(text));
    expect(eagerError.line).toBe(6);
    assertLazyAgreesWithEager(text);
  });
});

//////////////////////////////
// pyk MULTIARY_TEST_DATA   //
//////////////////////////////

const S = sortVar("S");
const [a, b, c, d] = [app("a"), app("b"), app("c"), app("d")];

/** `test_parser.py:125-136`, verbatim: `\and`/`\or` at arities 0 through 4. */
const MULTIARY_TEST_DATA: readonly (readonly [string, string, Pattern])[] = [
  ["nullary-and", String.raw`\and{S}()`, and(S, [])],
  ["unary-and", String.raw`\and{S}(a{}())`, and(S, [a])],
  ["binary-and", String.raw`\and{S}(a{}(), b{}())`, and(S, [a, b])],
  ["ternary-and", String.raw`\and{S}(a{}(), b{}(), c{}())`, and(S, [a, b, c])],
  ["quaternary-and", String.raw`\and{S}(a{}(), b{}(), c{}(), d{}())`, and(S, [a, b, c, d])],
  ["nullary-or", String.raw`\or{S}()`, or(S, [])],
  ["unary-or", String.raw`\or{S}(a{}())`, or(S, [a])],
  ["binary-or", String.raw`\or{S}(a{}(), b{}())`, or(S, [a, b])],
  ["ternary-or", String.raw`\or{S}(a{}(), b{}(), c{}())`, or(S, [a, b, c])],
  ["quaternary-or", String.raw`\or{S}(a{}(), b{}(), c{}(), d{}())`, or(S, [a, b, c, d])],
];

describe("pyk MULTIARY_TEST_DATA", () => {
  // Arity is preserved at both ends: 0-ary `\and` does not become `\top` and
  // 1-ary `\or` does not collapse to its operand, though `Parser.y:417-425`
  // (`mkAnd`/`mkOr`) does exactly that. See the arity note in `src/syntax.ts`.
  test.each(MULTIARY_TEST_DATA)("%s", (_id, text, expected) => {
    const parsed = parsePattern(text);
    expect(parsed).toEqual(expected);
    roundTrips(parsePattern, parsed);
  });
});

//////////////////////////////
// pyk MULTI_OR_TEST_DATA   //
//////////////////////////////

/** `test_parser.py:98-103`, verbatim. `multi_or` yields the operand *list*. */
const MULTI_OR_TEST_DATA: readonly (readonly [string, string, Pattern[]])[] = [
  ["nullary", String.raw`\left-assoc{}(\or{S}())`, []],
  ["unary", String.raw`\left-assoc{}(\or{S}(x{}()))`, [app("x")]],
  ["binary", String.raw`\left-assoc{}(\or{S}(x{}(), y{}()))`, [app("x"), app("y")]],
  ["multiary", String.raw`\left-assoc{}(\or{S}(x{}(), y{}(), z{}()))`, [app("x"), app("y"), app("z")]],
];

describe("pyk MULTI_OR_TEST_DATA", () => {
  test.each(MULTI_OR_TEST_DATA)("%s", (_id, text, expected) => {
    expect(parseMultiOr(text)).toEqual(expected);
  });

  test("is not reachable from `pattern()`", () => {
    // pyk's `pattern()` routes `\left-assoc` through `app()`, whose head must be
    // a `SYMBOL_ID` or an `ID` — `\or` is neither. `Parser.y:233-236` *does*
    // accept the legacy form as a pattern, under both `\left-assoc` and
    // `\right-assoc`; we follow pyk, which accepts it only through this
    // dedicated entry point and only under `\left-assoc`.
    expect(() => parsePattern(String.raw`\left-assoc{}(\or{S}(x{}(), y{}()))`)).toThrow(KoreSyntaxError);
    expect(() => parseMultiOr(String.raw`\right-assoc{}(\or{S}(x{}()))`)).toThrow(KoreSyntaxError);
  });

  test("does not accept an `\\and` head", () => {
    // `Parser.y` has no `and` alternative for the assoc rules and `mkApply`
    // (`Parser.y:432-441`) only knows `TokenOr` and `TokenIdent`, its comment's
    // claim about `\implies`/`\iff` notwithstanding.
    expect(() => parseMultiOr(String.raw`\left-assoc{}(\and{S}(x{}()))`)).toThrow(KoreSyntaxError);
  });
});

//////////////////////////////
// Entry points             //
//////////////////////////////

describe("entry points", () => {
  test("parseSort reads both sort shapes", () => {
    expect(parseSort("S")).toEqual({ tag: "SortVar", name: "S" });
    expect(parseSort("S{}")).toEqual({ tag: "SortApp", name: "S", sorts: [] });
    expect(parseSort("Map{K, V{}}")).toEqual({
      tag: "SortApp",
      name: "Map",
      sorts: [
        { tag: "SortVar", name: "K" },
        { tag: "SortApp", name: "V", sorts: [] },
      ],
    });
  });

  test("parseSentence reads one sentence of each kind", () => {
    const parser = new KoreParser("");
    expect(parser.eof).toBe(true);
    for (const text of [
      "import M []",
      "sort S{} []",
      'hooked-sort S{} [hook{}("X")]',
      "symbol f{}(S{}) : S{} []",
      "hooked-symbol f{}(S{}) : S{} []",
      "alias a{}(S{}) : S{} where a{}(X:S{}) := X:S{} []",
      "axiom{R} \\top{R}() []",
      "claim{R} \\top{R}() []",
    ]) {
      expect(new KoreParser(text).sentence().tag).toBeString();
    }
  });

  test("every entry point insists on reaching end of input", () => {
    // pyk exposes `.eof` and leaves the check to its caller; here it is part of
    // the contract.
    expect(() => parsePattern(String.raw`\top{S}() \top{S}()`)).toThrow("1:11: ");
    expect(() => parseSort("S T")).toThrow("1:3: ");
  });

  test("App and EVar are told apart by the token after the identifier", () => {
    // `parser.py:202-210`, the grammar's one two-token decision.
    expect(parsePattern("x{}()")).toEqual({ tag: "App", symbol: "x", sorts: [], args: [] });
    expect(parsePattern("x : S")).toEqual({ tag: "EVar", name: "x", sort: { tag: "SortVar", name: "S" } });
    expect(parsePattern("@x : S")).toEqual({ tag: "SVar", name: "@x", sort: { tag: "SortVar", name: "S" } });
  });

  test("a string literal is decoded, and a bad code point is reported at its quote", () => {
    expect(parsePattern(String.raw`"aα\U0001F642"`)).toEqual({ tag: "String", value: "aα🙂" });
    // `Lexer.x:134-139` reports `unescape` failures at the token, which is all
    // the position a value error has.
    expect(() => parsePattern(String.raw`f{}(  "\ud800"  )`)).toThrow("1:7: ");
  });
});

//////////////////////////////
// Depth                    //
//////////////////////////////

describe("depth", () => {
  const N = 100_000;

  test(`a ${N}-deep \\not parses without touching the call stack`, () => {
    const text = String.raw`\not{S}(`.repeat(N) + String.raw`\top{S}()` + ")".repeat(N);
    let node: Pattern = parsePattern(text);

    // Walked, not deep-compared: `toEqual` on a 100k-deep object would recurse
    // in the matcher and prove nothing about the parser.
    let depth = 0;
    while (node.tag === "Not") {
      depth += 1;
      node = node.pattern;
    }
    expect(depth).toBe(N);
    expect(node.tag).toBe("Top");
  });

  test(`a ${N}-deep sort parses without touching the call stack`, () => {
    const sort = parseSort("S{".repeat(N) + "}".repeat(N));

    let depth = 0;
    let node = sort;
    while (node.tag === "SortApp" && node.sorts.length === 1) {
      depth += 1;
      const [inner] = node.sorts;
      if (inner === undefined) break;
      node = inner;
    }
    expect(depth).toBe(N - 1);
    expect(node).toEqual({ tag: "SortApp", name: "S", sorts: [] });
  });

  test(`a ${N}-wide argument list parses`, () => {
    // The other axis: the frame stack stays one deep and `args` grows instead.
    const text = `f{}(${Array.from({ length: N }, () => "a{}()").join(", ")})`;
    const parsed = parsePattern(text);
    expect(parsed.tag).toBe("App");
    if (parsed.tag !== "App") return;
    expect(parsed.args).toHaveLength(N);
  });
});
