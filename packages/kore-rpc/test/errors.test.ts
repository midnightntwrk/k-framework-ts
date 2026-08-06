/**
 * The error taxonomy suite.
 *
 * Three groups:
 *
 * 1. **`ERROR_TEST_DATA`** — all six rows of
 *    `k/pyk/src/tests/unit/kore/test_client.py:318-390`, each asserting both
 *    the typed class and pyk's exact message string. The one row whose message
 *    cannot match is `default-error`, and the reason is spelled out on it.
 * 2. **The drift shapes** between upstream's own artifacts: code 2 as an array
 *    (its actual type, `Error.hs:74` `[ErrorWithTermAndContext]`, which pyk
 *    would crash on), code 1 as a bare string, `-32002` as a bare string,
 *    code 4 with no `context`.
 * 3. **Every code**, positive and negative, mapped to a class.
 */

import { describe, expect, test } from "bun:test";
import { type JsonValue, encodeKoreJsonValue } from "@kframework-ts/kore";
import { intDv } from "@kframework-ts/kore/prelude";
import {
  type JsonRpcErrorObject,
  type KoreRpcError,
  AbortedError,
  BACKEND_ERROR_CODES,
  BACKEND_ERROR_MESSAGES,
  DefaultError,
  DuplicateModuleError,
  ImplicationError,
  InvalidModuleError,
  JSON_RPC_INTERNAL_ERROR,
  JSON_RPC_INVALID_PARAMS,
  JSON_RPC_INVALID_REQUEST,
  JSON_RPC_METHOD_NOT_FOUND,
  JSON_RPC_PARSE_ERROR,
  KORE_RPC_CANCEL_UNSUPPORTED_IN_BATCH,
  KORE_RPC_REQUEST_CANCELLED,
  KORE_RPC_RUNTIME_ERROR,
  KORE_RPC_SERVER_ERROR,
  KORE_RPC_UNSUPPORTED_OPTION,
  MultipleStatesError,
  ParseError,
  PatternError,
  SmtSolverError,
  UnknownModuleError,
  decodeErrorObject,
  decodeKoreRpcError,
  isCancelledError,
  isKoreRpcError,
  koreJson,
  koreRpcError,
} from "../src/index.ts";

//////////////////////////
// pyk's ERROR_TEST_DATA//
//////////////////////////

/**
 * `toBeInstanceOf` that also narrows, so the assertions below need no casts.
 */
function expectInstance<T>(value: unknown, ctor: abstract new (...args: never[]) => T): T {
  expect(value).toBeInstanceOf(ctor);
  if (!(value instanceof ctor)) throw new TypeError(`expected an instance of ${ctor.name}`);
  return value;
}

interface ErrorRow {
  readonly id: string;
  readonly error: JsonRpcErrorObject;
  readonly check: (actual: KoreRpcError) => void;
  readonly message: string;
}

/** `ERROR_TEST_DATA` (`test_client.py:318-390`). */
const ERROR_ROWS: readonly ErrorRow[] = [
  {
    // test_client.py:319-324
    id: "parse-error",
    error: { code: 1, message: "foo", data: ':21:286: unexpected token TokenIdent "hasDomainValues"' },
    check: (actual) => {
      const error = expectInstance(actual, ParseError);
      expect(error.error).toBe(':21:286: unexpected token TokenIdent "hasDomainValues"');
    },
    message: 'Could not parse pattern: :21:286: unexpected token TokenIdent "hasDomainValues"',
  },
  {
    // test_client.py:325-348
    id: "pattern-error",
    error: {
      code: 2,
      message: "foo",
      data: {
        error: "Sort 'IntSort' not defined.",
        context: ["\\top (<unknown location>)", "sort 'IntSort' (<unknown location>)", "(<unknown location>)"],
      },
    },
    check: (actual) => {
      const patternError = expectInstance(actual, PatternError);
      expect(patternError.error).toBe("Sort 'IntSort' not defined.");
      expect(patternError.context).toEqual([
        "\\top (<unknown location>)",
        "sort 'IntSort' (<unknown location>)",
        "(<unknown location>)",
      ]);
      expect(patternError.details).toHaveLength(1);
    },
    message:
      "Could not verify pattern: Sort 'IntSort' not defined. Context: \\top (<unknown location>) ;; sort 'IntSort' (<unknown location>) ;; (<unknown location>)",
  },
  {
    // test_client.py:349-354
    id: "module-error",
    error: { code: 3, message: "foo", data: "MODULE-NAME" },
    check: (actual) => {
      expect(expectInstance(actual, UnknownModuleError).moduleName).toBe("MODULE-NAME");
    },
    message: "Could not find module: MODULE-NAME",
  },
  {
    // test_client.py:355-370
    id: "implication-error",
    error: {
      code: 4,
      message: "foo",
      data: {
        error: "The check implication step expects the antecedent term to be function-like.",
        context: ["/* Sfa */ \\mu{}( Config@A:SortK{}, /* Sfa */ Config@A:SortK{} )"],
      },
    },
    check: (actual) => {
      expect(expectInstance(actual, ImplicationError).context).toEqual([
        "/* Sfa */ \\mu{}( Config@A:SortK{}, /* Sfa */ Config@A:SortK{} )",
      ]);
    },
    message:
      "Implication check error: The check implication step expects the antecedent term to be function-like. Context: /* Sfa */ \\mu{}( Config@A:SortK{}, /* Sfa */ Config@A:SortK{} )",
  },
  {
    // test_client.py:371-383
    id: "smt-solver-error",
    error: {
      code: 5,
      message: "foo",
      data: { error: "Failed to decide predicate.", term: encodeKoreJsonValue(intDv(0)) },
    },
    check: (actual) => {
      expect(expectInstance(actual, SmtSolverError).term).toEqual(koreJson(intDv(0)));
    },
    // pyk renders the term with its own unparser (`pattern.text`); ours agrees
    // byte for byte, which is what makes this row meaningful.
    message: 'SMT solver error: Failed to decide predicate. Pattern: \\dv{SortInt{}}("0")',
  },
  {
    // test_client.py:384-389.  pyk's expected string is
    //   "foo | code: 100 | data: {'bar': 1, 'baz': [2, 3]}"
    // — Python's `repr` of the dict.  We print JSON as JSON; see `errors.ts`.
    id: "default-error",
    error: { code: 100, message: "foo", data: { bar: 1, baz: [2, 3] } },
    check: (actual) => {
      expect(actual).toBeInstanceOf(DefaultError);
      expect(actual.code).toBe(100);
      expect(actual.data).toEqual({ bar: 1, baz: [2, 3] });
    },
    message: 'foo | code: 100 | data: {"bar":1,"baz":[2,3]}',
  },
];

describe("ERROR_TEST_DATA (test_client.py:318-419)", () => {
  for (const row of ERROR_ROWS) {
    test(row.id, () => {
      const actual = koreRpcError(row.error);
      row.check(actual);
      expect(actual.message).toBe(row.message);
      expect(actual).toBeInstanceOf(Error);
      expect(isKoreRpcError(actual)).toBe(true);
      // The raw payload always survives, whatever the class made of it.
      expect(actual.data).toEqual(row.error.data);
    });
  }
});

//////////////////////////
// The drift shapes     //
//////////////////////////

describe("data-shape drift (plan §2.1)", () => {
  test("code 2 is an ARRAY upstream — the shape pyk would crash on", () => {
    // `CouldNotVerifyPattern [ErrorWithTermAndContext]` (Error.hs:74).
    const error = koreRpcError({
      code: 2,
      message: BACKEND_ERROR_MESSAGES[2] ?? "",
      data: [{ error: "first", context: ["a", "b"] }, { error: "second" }],
    });
    const patternError = expectInstance(error, PatternError);
    expect(patternError.details).toHaveLength(2);
    expect(patternError.details[0]).toEqual({ error: "first", context: ["a", "b"] });
    expect(patternError.details[1]).toEqual({ error: "second" });
    // The convenience accessors read the first complaint, which is what pyk's
    // single-detail shape corresponds to.
    expect(patternError.error).toBe("first");
    expect(patternError.context).toEqual(["a", "b"]);
    expect(patternError.message).toBe("Could not verify pattern: first Context: a ;; b ;; second Context: ");
  });

  test("code 1 accepts an object as well as a bare string", () => {
    const fromString = koreRpcError({ code: 1, message: "m", data: "boom" });
    expect(expectInstance(fromString, ParseError).error).toBe("boom");

    const fromObject = koreRpcError({
      code: 1,
      message: "m",
      data: { error: "boom", context: ["ctx"], term: encodeKoreJsonValue(intDv(0)) },
    });
    const parseError = expectInstance(fromObject, ParseError);
    expect(parseError.error).toBe("boom");
    expect(parseError.context).toEqual(["ctx"]);
    expect(parseError.term).toEqual(koreJson(intDv(0)));
    expect(parseError.message).toBe("Could not parse pattern: boom");
  });

  test("code 4 without a context does not throw (pyk's err.data['context'] would)", () => {
    const error = koreRpcError({ code: 4, message: "m", data: { error: "no context here" } });
    expect(expectInstance(error, ImplicationError).context).toEqual([]);
    expect(error.message).toBe("Implication check error: no context here Context: ");
  });

  test("code 5 without a decodable term degrades instead of throwing", () => {
    const error = koreRpcError({ code: 5, message: "m", data: { error: "solver died", term: { nonsense: true } } });
    expect(expectInstance(error, SmtSolverError).term).toBeUndefined();
    expect(error.message).toBe("SMT solver error: solver died Pattern: <unavailable>");
    // Nothing is lost: the raw payload is still there.
    expect(error.data).toEqual({ error: "solver died", term: { nonsense: true } });
  });

  test("-32002 accepts both its shapes: {error, context?} and a bare value", () => {
    const structured = koreRpcError({
      code: KORE_RPC_RUNTIME_ERROR,
      message: "Runtime error",
      data: { error: "boom", context: "Main.hs:12" },
    });
    expect(structured).toBeInstanceOf(DefaultError);
    expect(structured.message).toBe('Runtime error | code: -32002 | data: {"error":"boom","context":"Main.hs:12"}');

    const bare = koreRpcError({ code: KORE_RPC_RUNTIME_ERROR, message: "Runtime error", data: "Wrong result type" });
    expect(bare.message).toBe('Runtime error | code: -32002 | data: "Wrong result type"');
  });

  test("code 8's empty context collapses to absent, as in pyk", () => {
    const withContext = koreRpcError({ code: 8, message: "m", data: { error: "bad", context: ["c1"] } });
    expect(withContext.message).toBe("Could not verify module: bad Context: c1");
    const withoutContext = koreRpcError({ code: 8, message: "m", data: { error: "bad", context: [] } });
    expect(withoutContext.message).toBe("Could not verify module: bad");
    expect(expectInstance(withoutContext, InvalidModuleError).context).toBeUndefined();
  });
});

//////////////////////////
// Every code           //
//////////////////////////

describe("every code maps to a class", () => {
  const detail = { error: "e", context: ["c"] };

  const CASES: readonly [number, JsonValue, abstract new (...args: never[]) => KoreRpcError][] = [
    [BACKEND_ERROR_CODES.couldNotParsePattern, "s", ParseError],
    [BACKEND_ERROR_CODES.couldNotVerifyPattern, [detail], PatternError],
    [BACKEND_ERROR_CODES.couldNotFindModule, "M", UnknownModuleError],
    [BACKEND_ERROR_CODES.implicationCheckError, detail, ImplicationError],
    [BACKEND_ERROR_CODES.smtSolverError, { error: "e", term: encodeKoreJsonValue(intDv(0)) }, SmtSolverError],
    [BACKEND_ERROR_CODES.aborted, "gave up", AbortedError],
    [BACKEND_ERROR_CODES.multipleStates, "two states", MultipleStatesError],
    [BACKEND_ERROR_CODES.invalidModule, detail, InvalidModuleError],
    [BACKEND_ERROR_CODES.duplicateModuleName, "M", DuplicateModuleError],
  ];

  for (const [code, data, ctor] of CASES) {
    test(`code ${code} → ${ctor.name}`, () => {
      const error = koreRpcError({ code, message: BACKEND_ERROR_MESSAGES[code] ?? "", data });
      expect(error).toBeInstanceOf(ctor);
      expect(error.code).toBe(code);
    });
  }

  test("codes 6 and 7 are typed here where pyk falls through to DefaultError", () => {
    expect(koreRpcError({ code: 6, message: "Aborted", data: "why" }).message).toBe("Aborted: why");
    expect(koreRpcError({ code: 7, message: "Multiple states", data: "why" }).message).toBe("Multiple states: why");
  });

  const NEGATIVE: readonly number[] = [
    JSON_RPC_PARSE_ERROR,
    JSON_RPC_INVALID_REQUEST,
    JSON_RPC_METHOD_NOT_FOUND,
    JSON_RPC_INVALID_PARAMS,
    JSON_RPC_INTERNAL_ERROR,
    KORE_RPC_REQUEST_CANCELLED,
    KORE_RPC_CANCEL_UNSUPPORTED_IN_BATCH,
    KORE_RPC_RUNTIME_ERROR,
    KORE_RPC_UNSUPPORTED_OPTION,
    KORE_RPC_SERVER_ERROR,
  ];

  for (const code of NEGATIVE) {
    test(`negative code ${code} → DefaultError`, () => {
      const error = koreRpcError({ code, message: "m" });
      expect(error).toBeInstanceOf(DefaultError);
      expect(error.code).toBe(code);
      expect(error.message).toBe(`m | code: ${code}`);
      expect(error.data).toBeUndefined();
    });
  }

  test("the code constants are the ones upstream writes", () => {
    expect([
      JSON_RPC_PARSE_ERROR,
      JSON_RPC_INVALID_REQUEST,
      JSON_RPC_METHOD_NOT_FOUND,
      JSON_RPC_INVALID_PARAMS,
      JSON_RPC_INTERNAL_ERROR,
      KORE_RPC_REQUEST_CANCELLED,
      KORE_RPC_CANCEL_UNSUPPORTED_IN_BATCH,
      KORE_RPC_RUNTIME_ERROR,
      KORE_RPC_UNSUPPORTED_OPTION,
      KORE_RPC_SERVER_ERROR,
    ]).toEqual([-32700, -32600, -32601, -32602, -32603, -32000, -32001, -32002, -32003, -32032]);
  });

  test("the positional table is 1..9 in Error.hs:72-81 order", () => {
    expect(Object.values(BACKEND_ERROR_CODES)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(BACKEND_ERROR_MESSAGES[5]).toBe("Smt solver error");
    expect(BACKEND_ERROR_MESSAGES[2]).toBe("Could not verify pattern");
  });

  test("-32000 is recognizable as a cancellation", () => {
    expect(isCancelledError(koreRpcError({ code: KORE_RPC_REQUEST_CANCELLED, message: "Request cancelled" }))).toBe(
      true,
    );
    expect(isCancelledError(koreRpcError({ code: 3, message: "m", data: "M" }))).toBe(false);
  });
});

//////////////////////////
// The error object     //
//////////////////////////

describe("decodeErrorObject", () => {
  test("code and message are required and typed", () => {
    expect(() => decodeErrorObject({ message: "m" })).toThrow("Expected an integer error code, got nothing");
    expect(() => decodeErrorObject({ code: "1", message: "m" })).toThrow('Expected an integer error code, got "1"');
    expect(() => decodeErrorObject({ code: 1 })).toThrow("Expected a string, got nothing (at error.message)");
  });

  test("an explicit null data (Error.hs:36,38 send one) reads as absent", () => {
    expect(decodeErrorObject({ code: -32601, message: "Not implemented", data: null })).toEqual({
      code: -32601,
      message: "Not implemented",
    });
  });

  test("decodeKoreRpcError is decode-then-map", () => {
    const error = decodeKoreRpcError({ code: 9, message: "Duplicate module name", data: "M" });
    expect(error).toBeInstanceOf(DuplicateModuleError);
    expect(error.message).toBe("Duplicate module name: M");
  });
});

//////////////////////////
// Message size         //
//////////////////////////

describe("DefaultError keeps its message bounded", () => {
  // `internal.ts`'s stated invariant is that a 4 MB configuration never lands
  // in an exception string, and `DefaultError` was the one place that inlined
  // `JSON.stringify(data)` whole. `-32002` really does carry a whole state.
  const huge: JsonValue = { state: "y".repeat(4_000_000) };

  test("a 4 MB data payload does not become a 4 MB Error.message", () => {
    const error = new DefaultError("Aborted", -32002, huge);
    expect(error.message.length).toBeLessThan(1_000);
    expect(error.message.startsWith("Aborted | code: -32002 | data: ")).toBe(true);
    // The truncation is announced rather than silent, and says where the rest is.
    expect(error.message).toContain("in full on .data");
  });

  test("the full payload is still on `.data`, untouched", () => {
    const error = new DefaultError("Aborted", -32002, huge);
    expect(error.data).toEqual(huge);
  });

  test("a small payload is rendered whole, as pyk does", () => {
    expect(new DefaultError("Nope", -32000, { bar: 1 }).message).toBe('Nope | code: -32000 | data: {"bar":1}');
  });

  test("no data means no tail at all", () => {
    expect(new DefaultError("Nope", -32000).message).toBe("Nope | code: -32000");
  });
});
