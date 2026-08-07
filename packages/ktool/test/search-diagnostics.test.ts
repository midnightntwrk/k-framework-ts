import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { fromDict, kastTerm, kapply, klabel, ksort, kvariable, toDict } from "@kframework-ts/kast";
import { KoreParser } from "@kframework-ts/kore";
import { koreToKastPure } from "@kframework-ts/konvert";

import {
  classifyKDiagnostic,
  decodeSearchConfigurations,
  decodeSearchConfigurationsKore,
  decodeSearchResult,
  decodeSearchResultKore,
  parseAmbiguity,
  parseKDiagnostics,
  K_FRONTEND_EXIT_CODES,
  K_NATIVE_PARSER_EXIT_CODES,
} from "../src/index.ts";

const eq = (name: string, value: string) => kapply("#Equals", [kvariable(name), kapply(value)]);
const HERE = dirname(fileURLToPath(import.meta.url));
const IMP_SEARCH = join(HERE, "..", "..", "kompiled", "fixtures", "generated", "imp++-llvm-krun");
const DIAGNOSTICS = join(HERE, "..", "fixtures", "diagnostics");
const SEARCH_FIXTURES = join(HERE, "..", "fixtures", "search");
const SEARCH_MATRIX = ([0, 1, 2, 3, 5] as const).flatMap((count) =>
  (["json", "kore"] as const).flatMap((format) =>
    (["default", "no-pattern"] as const).map((mode) => ({ count, format, mode })),
  ),
);

function encodedSet(entries: readonly string[]): readonly string[] {
  return [...new Set(entries)].toSorted();
}

function kastSearchContent(
  result: ReturnType<typeof decodeSearchResult> | ReturnType<typeof decodeSearchConfigurations>,
) {
  if (result.tag === "solutions")
    return encodedSet(
      result.solutions.map((solution) =>
        encodedSet([...solution.bindings].map(([name, value]) => `${name}:${JSON.stringify(toDict(value))}`)).join("|"),
      ),
    );
  if (result.tag === "configurations")
    return encodedSet(result.configurations.map((configuration) => JSON.stringify(toDict(configuration))));
  throw new Error(`search did not decode: ${result.error.tag}`);
}

function koreSearchContent(
  result: ReturnType<typeof decodeSearchResultKore> | ReturnType<typeof decodeSearchConfigurationsKore>,
) {
  if (result.tag === "solutions")
    return encodedSet(
      result.solutions.map((solution) =>
        encodedSet(
          [...solution.bindings].map(
            ([name, value]) => `${name.replace(/^Var/u, "")}:${JSON.stringify(toDict(koreToKastPure(value)))}`,
          ),
        ).join("|"),
      ),
    );
  if (result.tag === "configurations")
    return encodedSet(
      result.configurations.map((configuration) => JSON.stringify(toDict(koreToKastPure(configuration)))),
    );
  throw new Error(`search did not decode: ${result.error.tag}`);
}

describe("search decoding", () => {
  test("accepts zero, one, nested binary and tolerated n-ary KAST disjunctions", () => {
    expect(decodeSearchResult(kapply("#Bottom", []))).toEqual({ tag: "solutions", solutions: [] });
    expect(decodeSearchResult(eq("Result", "one"))).toMatchObject({
      tag: "solutions",
      solutions: [{ bindings: new Map([["Result", kapply("one")]]) }],
    });
    const many = kapply("#Or", [eq("Result", "one"), kapply("#Or", [eq("Result", "two"), eq("Result", "three")])]);
    const decoded = decodeSearchResult(many);
    expect(decoded.tag).toBe("solutions");
    if (decoded.tag === "solutions")
      expect(decoded.solutions.map((s) => s.bindings.get("Result"))).toEqual([
        kapply("one"),
        kapply("two"),
        kapply("three"),
      ]);
    const duplicate = decodeSearchResult(kapply("#Or", [eq("Result", "one"), eq("Result", "one")]));
    if (duplicate.tag === "solutions") expect(duplicate.solutions).toHaveLength(1);
    expect(decodeSearchResult(kapply("#Top", []))).toMatchObject({ tag: "error", error: { tag: "trivial" } });
    const mismatched = decodeSearchResult(
      kapply("#Or", [eq("Result", "one"), kapply(klabel("#Or", [ksort("S")]), [eq("Result", "two")])]),
    );
    expect(mismatched).toMatchObject({ tag: "error", error: { tag: "unrecognised" } });
    expect(decodeSearchResult(kapply("#Or", []))).toMatchObject({ tag: "error", error: { tag: "unrecognised" } });
    expect(decodeSearchResult(kapply(klabel("#Or", [ksort("S"), ksort("T")]), [eq("Result", "one")]))).toMatchObject({
      tag: "error",
      error: { tag: "unrecognised" },
    });
  });

  test("keeps explicit no-pattern mode separate", () => {
    const configuration = kapply("<generatedTop>", []);
    expect(decodeSearchConfigurations(configuration)).toEqual({
      tag: "configurations",
      configurations: [configuration],
    });
    expect(decodeSearchResult(configuration)).toMatchObject({ tag: "error", error: { tag: "unrecognised" } });
  });

  test("KORE accepts unary/flat disjunctions and binding conjunctions", () => {
    const parsed = new KoreParser(
      "\\or{SortK{}}(\\equals{SortK{}, SortK{}}(X : SortK{}, a{}()),\\equals{SortK{}, SortK{}}(X : SortK{}, b{}()))",
    ).pattern();
    const decoded = decodeSearchResultKore(parsed);
    expect(decoded.tag).toBe("solutions");
    if (decoded.tag === "solutions") expect(decoded.solutions).toHaveLength(2);
    const config = new KoreParser("a{}()").pattern();
    expect(decodeSearchConfigurationsKore(config)).toEqual({ tag: "configurations", configurations: [config] });
  });

  test("consumes the provenance-backed IMP++ K search bytes as opaque KAST", async () => {
    for (const [file, count] of [
      ["div.imp.search.json", 3],
      ["spawn.imp.search.json", 4],
    ] as const) {
      const envelope = JSON.parse(await readFile(join(IMP_SEARCH, file), "utf8")) as unknown;
      const decoded = decodeSearchResult(fromDict(kastTerm(envelope)));
      expect(decoded.tag).toBe("solutions");
      if (decoded.tag === "solutions") expect(decoded.solutions).toHaveLength(count);
    }
  });

  test("decodes every measured 0/1/2/3/5 × JSON/KORE × mode matrix cell", async () => {
    const decodedCounts = new Map<string, number>();

    for (const cell of SEARCH_MATRIX) {
      const path = join(SEARCH_FIXTURES, "matrix", `${cell.count}.${cell.format}.${cell.mode}`);
      const source = await readFile(path, "utf8");
      const decoded =
        cell.format === "json"
          ? cell.mode === "default"
            ? decodeSearchResult(fromDict(kastTerm(JSON.parse(source))))
            : decodeSearchConfigurations(fromDict(kastTerm(JSON.parse(source))))
          : cell.mode === "default"
            ? decodeSearchResultKore(new KoreParser(source).pattern())
            : decodeSearchConfigurationsKore(new KoreParser(source).pattern());

      if (cell.mode === "default") {
        if (decoded.tag !== "solutions") throw new Error(`default search cell did not decode: ${path}`);
        expect(decoded.solutions).toHaveLength(cell.count);
        decodedCounts.set(`${cell.count}:${cell.mode}:${cell.format}`, decoded.solutions.length);
      } else {
        if (decoded.tag !== "configurations") throw new Error(`no-pattern search cell did not decode: ${path}`);
        expect(decoded.configurations).toHaveLength(cell.count);
        decodedCounts.set(`${cell.count}:${cell.mode}:${cell.format}`, decoded.configurations.length);
      }
    }

    for (const count of [0, 1, 2, 3, 5]) {
      for (const mode of ["default", "no-pattern"] as const) {
        expect(decodedCounts.get(`${count}:${mode}:json`)).toBe(decodedCounts.get(`${count}:${mode}:kore`));
      }
    }
  });

  test("every JSON/KORE matrix pair has the same decoded content set", async () => {
    for (const count of [0, 1, 2, 3, 5]) {
      for (const mode of ["default", "no-pattern"] as const) {
        const json = JSON.parse(await readFile(join(SEARCH_FIXTURES, "matrix", `${count}.json.${mode}`), "utf8"));
        const kore = await readFile(join(SEARCH_FIXTURES, "matrix", `${count}.kore.${mode}`), "utf8");
        const jsonDecoded =
          mode === "default"
            ? decodeSearchResult(fromDict(kastTerm(json)))
            : decodeSearchConfigurations(fromDict(kastTerm(json)));
        const koreDecoded =
          mode === "default"
            ? decodeSearchResultKore(new KoreParser(kore).pattern())
            : decodeSearchConfigurationsKore(new KoreParser(kore).pattern());
        expect(koreSearchContent(koreDecoded)).toEqual(kastSearchContent(jsonDecoded));
      }
    }
  });

  test("consumes the measured multi-variable custom-pattern and backend-dedup runs", async () => {
    const custom = decodeSearchResult(
      fromDict(kastTerm(JSON.parse(await readFile(join(SEARCH_FIXTURES, "custom-pattern.json"), "utf8")))),
    );
    expect(custom.tag).toBe("solutions");
    if (custom.tag === "solutions") {
      expect(custom.solutions).toHaveLength(2);
      for (const solution of custom.solutions) {
        expect(solution.bindings.has("B")).toBe(true);
        expect(solution.bindings.has("C")).toBe(true);
      }
    }

    const deduplicated = decodeSearchResult(
      fromDict(kastTerm(JSON.parse(await readFile(join(SEARCH_FIXTURES, "dedup.json"), "utf8")))),
    );
    expect(deduplicated.tag).toBe("solutions");
    if (deduplicated.tag === "solutions") expect(deduplicated.solutions).toHaveLength(1);
  });
});

describe("frontend diagnostics", () => {
  test("exports the deliberately limited frontend exit-status facts", () => {
    expect(K_FRONTEND_EXIT_CODES).toEqual({ success: 0, failure: 1, kemException: 113, timeout: 124 });
    expect(K_NATIVE_PARSER_EXIT_CODES).toEqual({ failure: 1, stackExhaustion: 2 });
  });

  test("consumes the source-backed taxonomy corpus for every named class and protocol", async () => {
    const diagnostics = parseKDiagnostics(await readFile(join(DIAGNOSTICS, "taxonomy.out"), "utf8"));
    const innerDiagnostics = diagnostics.filter((diagnostic) => diagnostic.group === "Inner Parser");
    expect(innerDiagnostics.map((diagnostic) => diagnostic.message)).toEqual([
      "Parse error: unexpected end of file.",
      "Parse error: unexpected token '@'.",
      "Scanner error: unexpected character sequence '@'.",
      'Parsing ambiguity.\n1: syntax Exp ::= Exp "+" Exp [symbol(veryLongProductionName)]\n    1 + 2 + 3\n2: syntax Exp ::= Int [token]\n    1 + 2 + 3',
      "Invalid applyPriority attribute value: bad.",
      "Rewrite is not allowed to be an immediate child of Lblparent{}.    Use parentheses: (x)=>(y) to set the proper scope of the operations.",
      "~> is not allowed to be an immediate child of Lblparent{}.    Use parentheses: (x)~>(y) to set the proper scope of the operations.",
      "#let is not allowed to be an immediate child of Lblparent{}.    Use parentheses: #let x = y #in (z) to set the proper scope of the operations.",
      "Lblchild{} is not allowed to be an immediate child of cast.    Use parentheses: (x):Sort to set the proper scope of the operations.",
      "Priority filter exception. Cannot use Lblchild{} as an immediate child of Lblparent{}. Consider using parentheses around Lblchild{}",
      "Associativity filter exception. Cannot use Lblchild{} as an immediate left child of Lblparent{}. Consider using parentheses around Lblchild{}",
      "Associativity filter exception. Cannot use Lblchild{} as an immediate right child of Lblparent{}. Consider using parentheses around Lblchild{}",
      "Unexpected sort A for term x. Expected B.",
      "Unexpected sort A for term parsed as production f. Expected B.",
      "Unexpected sort A for variable X. Expected: B.",
      "Sort inferred as greatest lower bound of [A, B], but no such bound exists.",
      "Sort of variable inferred as least upper bound of [A, B], but candidate bounds are incomparable: [C, D].",
      "Sort of X inferred as least upper bound of [A, B], but candidate bounds are incomparable: [C, D].",
      "Unexpected sort A for term parsed as production f. Expected: B",
      "Term is not well-sorted due to monomorphization failure. Add sort annotations to produce a better error message.",
      "Overloaded term does not have a least sort. Possible sorts: [A, B]",
      "List terminator for overloaded term does not have a least sort. Possible sorts: [A, B]",
      "Duplicate record production key: field",
      "Could not find any suitable productions for label f",
      "Could not find start symbol: Missing provided to command line",
    ]);
    const inner = innerDiagnostics.map((diagnostic) => classifyKDiagnostic(diagnostic));
    expect(inner).toEqual([
      { family: "inner-parser", tag: "parse-unexpected-eof" },
      { family: "inner-parser", tag: "parse-unexpected-token" },
      { family: "inner-parser", tag: "scanner-unexpected-character" },
      { family: "inner-parser", tag: "parsing-ambiguity" },
      { family: "inner-parser", tag: "invalid-apply-priority" },
      { family: "inner-parser", tag: "rewrite-immediate-child" },
      { family: "inner-parser", tag: "ksequence-immediate-child" },
      { family: "inner-parser", tag: "let-immediate-child" },
      { family: "inner-parser", tag: "cast-immediate-child" },
      { family: "inner-parser", tag: "priority-filter" },
      { family: "inner-parser", tag: "left-associativity-filter" },
      { family: "inner-parser", tag: "right-associativity-filter" },
      { family: "inner-parser", tag: "z3-constant-sort" },
      { family: "inner-parser", tag: "z3-production-sort" },
      { family: "inner-parser", tag: "z3-localized-variable-sort" },
      { family: "inner-parser", tag: "simplesub-lattice-term" },
      { family: "inner-parser", tag: "simplesub-lattice-anonymous-variable" },
      { family: "inner-parser", tag: "simplesub-lattice-named-variable" },
      { family: "inner-parser", tag: "simplesub-constraint" },
      { family: "inner-parser", tag: "simplesub-monomorphization" },
      { family: "inner-parser", tag: "overloaded-terminator-no-least-sort" },
      { family: "inner-parser", tag: "overloaded-empty-list-terminator-no-least-sort" },
      { family: "inner-parser", tag: "duplicate-record-key" },
      { family: "inner-parser", tag: "no-suitable-production" },
      { family: "inner-parser", tag: "unknown-start-symbol" },
    ]);
    expect(diagnostics.filter((diagnostic) => diagnostic.group === "Outer Parser").map(classifyKDiagnostic)).toEqual([
      { family: "outer-parser", tag: "circular-lexical-identifiers" },
      { family: "outer-parser", tag: "unrecognized-lexical-identifiers" },
      { family: "outer-parser", tag: "named-lexical-line-anchor" },
      { family: "outer-parser", tag: "syntax" },
    ]);
    expect(diagnostics.filter((diagnostic) => diagnostic.group === "Compiler").map(classifyKDiagnostic)).toContainEqual(
      {
        family: "compiler",
        tag: "had-parsing-errors",
      },
    );
    expect(diagnostics.filter((diagnostic) => diagnostic.group === "wrapper").map(classifyKDiagnostic)).toEqual([
      { family: "wrapper", tag: "krun" },
      { family: "wrapper", tag: "kparse" },
      { family: "wrapper", tag: "kparse-gen" },
      { family: "wrapper", tag: "kore-print" },
    ]);
    expect(diagnostics.filter((diagnostic) => diagnostic.group === "native-scanner").map(classifyKDiagnostic)).toEqual([
      { family: "native", tag: "scanner" },
    ]);
    expect(diagnostics.filter((diagnostic) => diagnostic.group === "native-parser").map(classifyKDiagnostic)).toEqual([
      { family: "native", tag: "parser" },
    ]);
    expect(diagnostics.map((diagnostic) => diagnostic.group)).toEqual(
      expect.arrayContaining(["Compiler", "Outer Parser", "Inner Parser", "Internal", "Critical", "Prover"]),
    );
    const critical = diagnostics.find((diagnostic) => diagnostic.group === "Critical");
    expect(critical).toMatchObject({
      source: "definition.k",
      location: "2,3,2,7",
      snippet: "line two of the rendered source snippet",
    });
    const unknown = diagnostics.find((diagnostic) => diagnostic.message === "future diagnostic from K");
    if (unknown === undefined) throw new Error("missing unknown fixture diagnostic");
    expect(classifyKDiagnostic(unknown)).toEqual({ kind: "unknown", raw: unknown.raw });
  });

  test("class-aware ambiguity reassembly makes wrapped and unwrapped bytes equivalent", () => {
    const unwrapped = parseKDiagnostics(
      '[Error] Inner Parser: Parsing ambiguity.\n1: syntax Exp ::= Exp "+" Exp [symbol(veryLongProductionName)]\n    1 + 2 + 3',
    )[0];
    const wrapped = parseKDiagnostics(
      '[Error] Inner Parser: Parsing ambiguity.\n1: syntax Exp ::= Exp "+"\nExp [symbol(veryLongProductionName)]\n    1 + 2 + 3',
    )[0];
    if (unwrapped === undefined || wrapped === undefined) throw new Error("missing ambiguity diagnostic");
    expect(wrapped.message).toBe(unwrapped.message);
    expect(parseAmbiguity(wrapped)).toEqual(parseAmbiguity(unwrapped));
  });

  test("ordinary long JVM messages reassemble by their class grammar too", () => {
    const cases = [
      [
        'Priority filter exception. Cannot use syntax Expression ::= Expression "+" Expression [symbol(longLabel)].',
        'Priority filter exception. Cannot use syntax Expression ::= Expression "+"\nExpression [symbol(longLabel)].',
      ],
      [
        "Term is not well-sorted due to monomorphization failure. Add sort annotations to produce a better error message.",
        "Term is not well-sorted due to monomorphization failure. Add sort\nannotations to produce a better error message.",
      ],
    ] as const;
    for (const [message, wrappedMessage] of cases) {
      const direct = parseKDiagnostics(`[Error] Inner Parser: ${message}`)[0];
      const wrapped = parseKDiagnostics(`[Error] Inner Parser: ${wrappedMessage}`)[0];
      if (direct === undefined || wrapped === undefined) throw new Error("missing long diagnostic");
      expect(wrapped.message).toBe(direct.message);
      expect(classifyKDiagnostic(wrapped)).toEqual(classifyKDiagnostic(direct));
    }
  });

  test("consumes verbatim K v7.1.337 ambiguity and scanner golden bytes", async () => {
    const ambiguity = parseKDiagnostics(await readFile(join(DIAGNOSTICS, "ambiguity.stderr"), "utf8"));
    expect(ambiguity).toHaveLength(1);
    expect(ambiguity[0]?.group).toBe("Inner Parser");
    expect(classifyKDiagnostic(ambiguity[0]!)).toEqual({ family: "inner-parser", tag: "parsing-ambiguity" });
    expect(parseAmbiguity(ambiguity[0]!)).toHaveLength(2);

    const scanner = parseKDiagnostics(await readFile(join(DIAGNOSTICS, "scanner.stderr"), "utf8"));
    expect(scanner).toHaveLength(1);
    expect(classifyKDiagnostic(scanner[0]!)).toEqual({ family: "inner-parser", tag: "scanner-unexpected-character" });
    expect(scanner[0]?.source).toContain("scanner.pgm");
  });

  test("parses JVM envelopes, native scanner/parser lines, and wrapper attribution", () => {
    const [jvm, scanner, parser, wrapper] = parseKDiagnostics(
      [
        "[Error] Inner Parser: Parse error: unexpected token",
        "\tSource(foo.k)",
        "\tLocation(1,2,1,3)",
        "1:2:1:3:syntax error: unexpected @",
        "foo.pgm:1:2:1:3:syntax error, unexpected TOK",
        "[Error] krun: krun --definition x",
      ].join("\n"),
    );
    expect(jvm?.group).toBe("Inner Parser");
    expect(jvm?.source).toBe("foo.k");
    expect(scanner?.group).toBe("native-scanner");
    expect(parser?.group).toBe("native-parser");
    expect(wrapper?.group).toBe("wrapper");
    expect(wrapper?.wrapperTool).toBe("krun");
    expect(jvm === undefined ? undefined : classifyKDiagnostic(jvm)).toEqual({
      family: "inner-parser",
      tag: "parse-unexpected-token",
    });
  });

  test("extracts ambiguity alternatives and preserves unknown raw text", () => {
    const [diagnostic] = parseKDiagnostics(
      "[Error] Inner Parser: Parsing ambiguity.\n1: syntax A ::= B\n    term\n2: syntax A ::= C\n    other\n3: ",
    );
    if (diagnostic === undefined) throw new Error("missing diagnostic");
    expect(parseAmbiguity(diagnostic)).toEqual([
      { index: 1, production: "syntax A ::= B", term: "term" },
      { index: 2, production: "syntax A ::= C", term: "other" },
      { index: 3, production: "", term: null },
    ]);
    expect(classifyKDiagnostic({ ...diagnostic, message: "future output" })).toEqual({
      kind: "unknown",
      raw: diagnostic.raw,
    });
  });
});
