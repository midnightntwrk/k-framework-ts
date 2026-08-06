/**
 * The textual-KAST parser.
 *
 * Three sources, kept apart:
 *
 * 1. `TEST_DATA` is pyk's `tests/unit/kast/test_parser.py:89-101` transcribed
 *    row for row — same 11 inputs in the same order, same expected terms,
 *    including the `assert parser.eof()` that `test_parser.py:113` makes.
 * 2. `KPRINT_TERMS` is the term list from
 *    `k-frontend/src/test/java/org/kframework/unparser/KPrintTest.java:44-57`,
 *    written in the format `ToKast` prints them in.  Two of the five are
 *    unrepresentable and are recorded, not skipped silently.
 * 3. The fixture suite parses every file under `fixtures/kast-text/` and checks
 *    the result — term or error — against `parse-expected.json`, which is pyk's
 *    own output at v7.1.337.  See `fixtures/PROVENANCE.md`.
 *
 * Everything after that describes behaviour none of the three reaches: what
 * `_unquote` does and does not undo, and the depth this parser survives.
 */

import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { kapply, ksequence, ktoken, kvariable, type KInner } from "../src/inner.ts";
import { toDict, type JsonObject } from "../src/json.ts";
import { KastSyntaxError } from "../src/lexer.ts";
import { KAstParser, parseKast } from "../src/parser.ts";
import { expectTerm } from "./helpers.ts";

//////////////////////////////
// test_parser.py:89-101    //
//////////////////////////////

const TEST_DATA: readonly (readonly [string, KInner])[] = [
  ["_", kvariable("_")],
  ["X", kvariable("X")],
  ["X:Int", kvariable("X", "Int")],
  ['#token("1", "Int")', ktoken("1", "Int")],
  ['#token("\\"foo\\"", "String")', ktoken('"foo"', "String")],
  [".K", ksequence([])],
  ["foo(.KList)", kapply("foo")],
  ['`_+_`(#token("1", "Int"), X)', kapply("_+_", [ktoken("1", "Int"), kvariable("X")])],
  ["`\\``(.KList)", kapply("`")],
  ["`_\\\\_`(.KList)", kapply("_\\_")],
  ["`<k>`(foo(.KList)~>bar(.KList))", kapply("<k>", [ksequence([kapply("foo"), kapply("bar")])])],
];

describe("test_parser.py", () => {
  for (const [text, expected] of TEST_DATA) {
    test(JSON.stringify(text), () => {
      const parser = new KAstParser(text);
      const actual = parser.k();
      expect(parser.eof()).toBe(true);
      expectTerm(actual, expected);
    });
  }
});

//////////////////////////////
// KPrintTest.java:44-57    //
//////////////////////////////

/**
 * Three of the five terms `KPrintTest` round-trips, spelled as
 * `ToKast`/`KPrint.serialize` prints them (`Unparse.scala:75-114`).
 *
 * The other two are **not expressible** in what this parser reads, and the
 * reason is the same for both: `terms.get(3)` puts an `InjectedKLabel` inside a
 * `<k>` cell, printed `#klabel(`_+_`)` (`Unparse.scala:77`), and `terms.get(4)`
 * contains `terms.get(3)`.  `InjectedKLabel` is not one of pyk's six `KInner`
 * nodes and so is not one of ours; pyk's lexer has no
 * token for it either — `#klabel` lexes as a plain `ID`, and the parser then
 * demands a `klist` where a label sits.  There is nothing to transcribe.
 */
const KPRINT_TERMS: readonly (readonly [string, KInner])[] = [
  // KPrintTest.java:45
  ['`_|->_`(#token("x","Id"),#token("1","Int"))', kapply("_|->_", [ktoken("x", "Id"), ktoken("1", "Int")])],
  // KPrintTest.java:46
  ['#token("foo","Bar")', ktoken("foo", "Bar")],
  // KPrintTest.java:47
  ["`_+_`(Baz,Baz2)", kapply("_+_", [kvariable("Baz"), kvariable("Baz2")])],
];

describe("KPrintTest.java", () => {
  for (const [text, expected] of KPRINT_TERMS) {
    test(JSON.stringify(text), () => {
      expectTerm(parseKast(text), expected);
    });
  }

  test("#klabel is not a term, so KPrintTest's last two are unrepresentable", () => {
    // `#klabel` reaches the parser as a plain ID, i.e. as a label awaiting its
    // arguments, and the label it wraps is read as another such label — so the
    // failure lands on the `)` that should have been its `(`.  pyk raises the
    // same message.
    expect(() => parseKast("#klabel(`_+_`)")).toThrow("1:14: Unexpected token: ')'. Expected: LPAREN");
  });
});

//////////////////////////////
// Fixtures                  //
//////////////////////////////

const FIXTURES = join(import.meta.dir, "..", "fixtures", "kast-text");

/** One row of `parse-expected.json`: what pyk does with that file. */
type ExpectedParse =
  | { readonly parses: true; readonly term: JsonObject }
  | { readonly parses: false; readonly error: string };

const EXPECTED: Readonly<Record<string, ExpectedParse>> = JSON.parse(
  readFileSync(join(FIXTURES, "parse-expected.json"), "utf8"),
);

/** Run `body`, returning whatever it threw. The narrowing form `toThrow` cannot express. */
function catchError(body: () => unknown): unknown {
  try {
    body();
  } catch (error) {
    return error;
  }
  throw new Error("Expected a throw, got none");
}

/** Every vendored fixture, as `<subdir>/<file>` — the keys of `parse-expected.json`. */
function fixtureFiles(): string[] {
  const files: string[] = [];
  for (const dir of readdirSync(FIXTURES, { withFileTypes: true })) {
    if (!dir.isDirectory()) continue;
    for (const name of readdirSync(join(FIXTURES, dir.name))) files.push(`${dir.name}/${name}`);
  }
  return files.toSorted();
}

describe("upstream fixtures", () => {
  const files = fixtureFiles();

  test("all 19 vendored files are accounted for", () => {
    expect(files).toHaveLength(19);
    expect(Object.keys(EXPECTED).toSorted()).toEqual(files);
  });

  test("6 of them are textual KAST this parser reads; 13 are not", () => {
    // The count is the point: `kast-kore-input/` is KORE, `kast-rule/*.kast`
    // and `kast-default-output/*.kast` are K surface syntax, and three of the
    // `kast-rule/` outputs are rules — `=>` is a construct pyk's parser has no
    // production for.  `fixtures/PROVENANCE.md` has the file-by-file table.
    const parses = files.filter((f) => EXPECTED[f]?.parses === true);
    expect(parses).toEqual([
      "kast-default-output/kast-out1.kast.out",
      "kast-default-output/kast-out2.kast.out",
      "kast-input/kast-in1.kast",
      "kast-input/kast-in2.kast",
      "kast-rule/kast-in3.kast.out",
      "kast-rule/kast-in5.kast.out",
    ]);
  });

  for (const file of files) {
    const expected = EXPECTED[file];
    if (expected === undefined) throw new Error(`No expectation for ${file}`);

    test(file, () => {
      const text = readFileSync(join(FIXTURES, file), "utf8");
      if (expected.parses) {
        // Differential: `to_dict()` of pyk's term, byte-compared with ours.
        expect(toDict(parseKast(text))).toEqual(expected.term);
      } else {
        const thrown = catchError(() => parseKast(text));
        expect(thrown).toBeInstanceOf(KastSyntaxError);
        if (!(thrown instanceof KastSyntaxError)) return;
        expect(thrown.description).toBe(expected.error);
      }
    });
  }
});

//////////////////////////////
// _unquote                  //
//////////////////////////////

/**
 * `_unquote` (`parser.py:125-126`) strips the `\` of every escape without
 * decoding it.  That inverts the *klabel* writer exactly and the `#token`
 * writer only where the token text was already escaped once; see `parser.ts`'s
 * header.  Each expectation below was confirmed against pyk.
 */
describe("_unquote", () => {
  test("a doubly-escaped String token round-trips", () => {
    // `ToKast` prints `KToken('"hello\\nworld"', String)` — whose `token` field
    // already holds K's own escape — by escaping it a second time.
    expectTerm(parseKast('#token("\\"hello\\\\nworld\\"","String")'), ktoken('"hello\\nworld"', "String"));
  });

  test("a `\\n` that was only escaped once decodes to the letter n", () => {
    // The lossy case.  `StringUtil.enquoteKString:251-252` writes a raw newline
    // as `\n`; this reads it back as `n`.
    expectTerm(parseKast('#token("a\\nb","Foo")'), ktoken("anb", "Foo"));
  });

  test("a `\\uHHHH` decodes to its own letters", () => {
    // `StringUtil.enquoteKString:260` writes every non-ASCII code point this
    // way.  Same lossy strip.
    expectTerm(parseKast('#token("\\u00e9","Foo")'), ktoken("u00e9", "Foo"));
  });

  test("backtick and backslash in a klabel are exact inverses of the writer", () => {
    // `escapeBackTicksAndSlashes` (`Unparse.scala:47-48`) escapes exactly these
    // two, which is the whole reason `_unquote` may not be a real K dequoter.
    expectTerm(parseKast("`\\``(.KList)"), kapply("`"));
    expectTerm(parseKast("`a\\\\b`(.KList)"), kapply("a\\b"));
  });

  test("a backslash before a newline survives, backslash and all", () => {
    // Python's `re` has no DOTALL here (`parser.py:122`) and neither does
    // `/\\./g`; the two languages agree by accident.
    expectTerm(parseKast('#token("a\\\nb","Foo")'), ktoken("a\\\nb", "Foo"));
  });
});

//////////////////////////////
// Shape and failure         //
//////////////////////////////

describe("grammar", () => {
  test("a KSequence of one collapses", () => {
    // `parser.py:68-70`.
    expectTerm(parseKast("foo(.KList)"), kapply("foo"));
  });

  test("an argument is a whole k, so a sequence may sit in an argument list", () => {
    // `parser.py:115-119` — `klist` is a list of `k`, not of `kitem`.
    expectTerm(
      parseKast("f(a(.KList)~>b(.KList),c(.KList))"),
      kapply("f", [ksequence([kapply("a"), kapply("b")]), kapply("c")]),
    );
  });

  test(".K takes no `~>` continuation", () => {
    // `parser.py:58-60` returns immediately, so the `~>` is trailing input.
    expect(() => parseKast(".K~>foo(.KList)")).toThrow("1:3: Unexpected token: '~>'");
  });

  test("an empty argument list must be spelled .KList", () => {
    expect(() => parseKast("foo()")).toThrow(
      "1:5: Unexpected token: ')'. Expected one of: ID, KLABEL, TOKEN, VARIABLE",
    );
  });

  test("trailing input is an error, not a silent truncation", () => {
    // `parseKast` is the assertion `test_parser.py:113` writes by hand.
    expect(() => parseKast("X Y")).toThrow("1:3: Unexpected token: 'Y'");
    // The incremental class reads the two terms happily.
    const parser = new KAstParser("X Y");
    expectTerm(parser.k(), kvariable("X"));
    expectTerm(parser.k(), kvariable("Y"));
    expect(parser.eof()).toBe(true);
  });

  test("a sort must follow a colon", () => {
    expect(() => parseKast("X:")).toThrow("1:3: Unexpected token: ''. Expected: SORT");
  });

  test("reading past EOF is a syntax error, where pyk raises StopIteration", () => {
    const parser = new KAstParser("");
    expect(() => parser.k()).toThrow("1:1: Unexpected token: ''. Expected one of: ID, KLABEL, TOKEN, VARIABLE");
  });

  test("klist and kitem are reachable on their own, as in pyk", () => {
    const parser = new KAstParser("a(.KList),b(.KList)");
    const args = parser.klist();
    expect(args).toHaveLength(2);
    expect(parser.eof()).toBe(true);

    const one = new KAstParser("a(.KList)~>b(.KList)");
    expectTerm(one.kitem(), kapply("a"));
    expect(one.eof()).toBe(false);
  });
});

describe("non-recursion", () => {
  test("a 100k-deep argument nest parses without a RangeError", () => {
    // pyk's `k`/`kitem`/`klist` cycle recurses; the machine in `parseTerm`
    // does not.
    const depth = 100_000;
    const text = `${"f(".repeat(depth)}.KList${")".repeat(depth)}`;
    let term: KInner | undefined = parseKast(text);
    let seen = 0;
    while (term !== undefined && term.node === "KApply" && term.args.length === 1) {
      seen += 1;
      term = term.args[0];
    }
    expect(seen).toBe(depth - 1);
  });

  test("a 100k-long sequence parses without a RangeError", () => {
    const length = 100_000;
    const term = parseKast(Array.from({ length }, () => "a(.KList)").join("~>"));
    expect(term.node).toBe("KSequence");
    if (term.node !== "KSequence") return;
    expect(term.items).toHaveLength(length);
  });
});
