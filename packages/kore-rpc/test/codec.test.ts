/**
 * The codec suite, oracled by pyk's own unit tests.
 *
 * Every row of the five call-shaped data tables in
 * `k/pyk/src/tests/unit/kore/test_client.py` (K `v7.1.337`, sha256
 * `a78496ac6471886aae94d9d2805704888eae7e93c7a2e190de61d81d7e680492`) is
 * transcribed below, with the upstream line numbers on each:
 *
 * | table                   | lines     | rows | here                      |
 * | ----------------------- | --------- | ---- | ------------------------- |
 * | `EXECUTE_TEST_DATA`     | `101-153` | 3    | {@link EXECUTE_ROWS}      |
 * | `IMPLIES_TEST_DATA`     | `176-184` | 1    | {@link IMPLIES_ROWS}      |
 * | `SIMPLIFY_TEST_DATA`    | `208-215` | 1    | {@link SIMPLIFY_ROWS}     |
 * | `GET_MODEL_TEST_DATA`   | `238-267` | 4    | {@link GET_MODEL_ROWS}    |
 * | `ADD_MODULE_TEST_DATA`  | `291-296` | 1    | {@link ADD_MODULE_ROWS}   |
 *
 * The sixth, `ERROR_TEST_DATA` (`318-390`), is in `errors.test.ts`.
 *
 * Each row asserts the same two things pyk's tests assert: that the typed
 * arguments build *exactly* that params object, and that the response dict
 * decodes to the expected typed result. pyk's helpers become
 * `@kframework-ts/kore` factories — `int_dv(1)` is `intDv(1)`, `Top(INT)` is
 * `top(INT)`, `kore(p)` is `koreJson(p)` on the typed side and
 * `encodeKoreJsonValue(p)` on the JSON side.
 *
 * # Where the expected values deliberately differ from pyk's
 *
 * - **Substitutions stay patterns.** pyk's `State.from_dict` flattens the
 *   `\and`-of-`\equals` into a `{EVar: Pattern}` map (`rpc.py:556-579`); this
 *   package keeps the wire pattern, and the flattener is a later module. So
 *   `StuckResult(State(int_dv(2), substitution={x: int_dv(3), …}))` becomes an
 *   `ExecuteState` whose `substitution` is the `\and` itself.
 * - **`implies` keeps the tri-state.** pyk's expected `ImpliesResult(True, …)`
 *   is `status: "valid"` here.
 * - **`simplify` and `add-module` keep the whole record.** pyk's test unpacks
 *   a tuple and a bare string respectively.
 * - **Absent logs stay absent.** pyk substitutes `logs=()`; an omitted `logs`
 *   decodes to no `logs` property here (see `types.ts`).
 */

import { describe, expect, test } from "bun:test";
import {
  type JsonObject,
  type Pattern,
  and,
  app,
  bottom,
  encodeKoreJsonValue,
  equals,
  evar,
  koreModule,
  koreText,
  top,
} from "@kframework-ts/kore";
import { INT, SORT_GENERATED_TOP_CELL, intDv } from "@kframework-ts/kore/prelude";
import {
  type AddModuleResult,
  type ExecuteResult,
  type GetModelResult,
  type KoreRpcMethod,
  type ImpliesResult,
  type SimplifyResult,
  decodeAddModuleParams,
  decodeAddModuleResult,
  decodeExecuteParams,
  decodeExecuteResult,
  decodeGetModelResult,
  decodeImpliesResult,
  decodeParams,
  decodeRequestEnvelope,
  decodeResponse,
  decodeResult,
  decodeSimplifyResult,
  emitOrdered,
  encodeAddModuleParams,
  encodeExecuteParams,
  encodeExecuteResult,
  encodeGetModelParams,
  encodeGetModelResult,
  encodeImpliesParams,
  encodeImpliesResult,
  encodeRequest,
  encodeSimplifyParams,
  encodeSimplifyResult,
  impliesParams,
  koreJson,
} from "../src/index.ts";
import { caught, defined } from "./helpers/assert.ts";

//////////////////////
// pyk's fixtures   //
//////////////////////

/** `test_client.py:41-43`. */
const x = evar("x", INT);
const y = evar("y", INT);
const intTop = top(INT);
const intBottom = bottom(INT);

/** `test_client.py:46-51` — the `kore()` helper, on the JSON side. */
function kore(pattern: Pattern): ReturnType<typeof encodeKoreJsonValue> {
  return encodeKoreJsonValue(pattern);
}

//////////////////////
// execute          //
//////////////////////

interface ExecuteRow {
  readonly id: string;
  readonly pattern: Pattern;
  readonly params: JsonObject;
  readonly response: JsonObject;
  readonly expected: ExecuteResult;
}

/** `EXECUTE_TEST_DATA` (`test_client.py:101-153`). */
const EXECUTE_ROWS: readonly ExecuteRow[] = [
  {
    // test_client.py:102-123
    id: "stuck, with an \\and substitution and a predicate",
    pattern: app("IntAdd", [], [intDv(1), intDv(1)]),
    params: { state: kore(app("IntAdd", [], [intDv(1), intDv(1)])) },
    response: {
      state: {
        term: kore(intDv(2)),
        substitution: kore(
          and(SORT_GENERATED_TOP_CELL, [
            equals(INT, SORT_GENERATED_TOP_CELL, x, intDv(3)),
            equals(INT, SORT_GENERATED_TOP_CELL, y, intDv(4)),
          ]),
        ),
        predicate: kore(intTop),
      },
      depth: 1,
      reason: "stuck",
    },
    expected: {
      reason: "stuck",
      depth: 1,
      state: {
        term: koreJson(intDv(2)),
        predicate: koreJson(intTop),
        substitution: koreJson(
          and(SORT_GENERATED_TOP_CELL, [
            equals(INT, SORT_GENERATED_TOP_CELL, x, intDv(3)),
            equals(INT, SORT_GENERATED_TOP_CELL, y, intDv(4)),
          ]),
        ),
      },
    },
  },
  {
    // test_client.py:124-136
    id: "vacuous, with a single-\\equals substitution",
    pattern: app("IntAdd", [], [intDv(1), intDv(1)]),
    params: { state: kore(app("IntAdd", [], [intDv(1), intDv(1)])) },
    response: {
      state: {
        term: kore(intDv(2)),
        substitution: kore(equals(INT, SORT_GENERATED_TOP_CELL, x, intDv(3))),
      },
      depth: 1,
      reason: "vacuous",
    },
    expected: {
      reason: "vacuous",
      depth: 1,
      state: {
        term: koreJson(intDv(2)),
        substitution: koreJson(equals(INT, SORT_GENERATED_TOP_CELL, x, intDv(3))),
      },
    },
  },
  {
    // test_client.py:137-152
    id: "aborted, with an unknown-predicate",
    pattern: intDv(0),
    params: { state: kore(intDv(0)) },
    response: {
      state: { term: kore(intDv(1)) },
      depth: 2,
      "unknown-predicate": kore(intDv(3)),
      reason: "aborted",
    },
    expected: {
      reason: "aborted",
      depth: 2,
      state: { term: koreJson(intDv(1)) },
      unknownPredicate: koreJson(intDv(3)),
    },
  },
];

describe("execute (test_client.py:101-173)", () => {
  for (const row of EXECUTE_ROWS) {
    test(`params: ${row.id}`, () => {
      expect(encodeExecuteParams({ state: koreJson(row.pattern) })).toEqual(row.params);
    });

    test(`result: ${row.id}`, () => {
      expect(decodeExecuteResult(row.response)).toEqual(row.expected);
    });

    test(`result round-trips: ${row.id}`, () => {
      const encoded = encodeExecuteResult(row.expected);
      expect(decodeExecuteResult(encoded)).toEqual(row.expected);
    });
  }
});

//////////////////////
// implies          //
//////////////////////

interface ImpliesRow {
  readonly id: string;
  readonly antecedent: Pattern;
  readonly consequent: Pattern;
  readonly params: JsonObject;
  readonly response: JsonObject;
  readonly expected: ImpliesResult;
}

/** `IMPLIES_TEST_DATA` (`test_client.py:176-184`). */
const IMPLIES_ROWS: readonly ImpliesRow[] = [
  {
    // test_client.py:177-183
    id: "bottom implies top, valid",
    antecedent: intBottom,
    consequent: intTop,
    // Note `assume-defined: false` — pyk's default is `False`, not `None`, so
    // `filter_none` keeps it and every real request carries it.
    params: { antecedent: kore(intBottom), consequent: kore(intTop), "assume-defined": false },
    response: { status: "valid", implication: kore(intTop) },
    expected: { implication: koreJson(intTop), status: "valid" },
  },
];

describe("implies (test_client.py:176-205)", () => {
  for (const row of IMPLIES_ROWS) {
    test(`params: ${row.id}`, () => {
      expect(encodeImpliesParams(impliesParams(koreJson(row.antecedent), koreJson(row.consequent)))).toEqual(
        row.params,
      );
    });

    test(`result: ${row.id}`, () => {
      expect(decodeImpliesResult(row.response)).toEqual(row.expected);
    });

    test(`result round-trips: ${row.id}`, () => {
      expect(decodeImpliesResult(encodeImpliesResult(row.expected))).toEqual(row.expected);
    });
  }

  test("assume-defined is omitted when explicitly undefined", () => {
    const params = impliesParams(koreJson(intBottom), koreJson(intTop), { assumeDefined: undefined });
    expect(encodeImpliesParams(params)).toEqual({ antecedent: kore(intBottom), consequent: kore(intTop) });
  });

  test("status stays tri-state where pyk collapses it", () => {
    const indeterminate = decodeImpliesResult({ status: "indeterminate", implication: kore(intTop) });
    expect(indeterminate.status).toBe("indeterminate");
    const invalid = decodeImpliesResult({ status: "invalid", implication: kore(intTop) });
    expect(invalid.status).toBe("invalid");
  });

  test("condition requires both members", () => {
    const withCondition = decodeImpliesResult({
      status: "valid",
      implication: kore(intTop),
      condition: { substitution: kore(intTop), predicate: kore(intTop) },
    });
    expect(withCondition.condition).toEqual({ substitution: koreJson(intTop), predicate: koreJson(intTop) });

    expect(() =>
      decodeImpliesResult({
        status: "valid",
        implication: kore(intTop),
        condition: { substitution: kore(intTop) },
      }),
    ).toThrow('Condition is missing the field "predicate"');
  });
});

//////////////////////
// simplify         //
//////////////////////

interface SimplifyRow {
  readonly id: string;
  readonly pattern: Pattern;
  readonly params: JsonObject;
  readonly response: JsonObject;
  readonly expected: SimplifyResult;
}

/** `SIMPLIFY_TEST_DATA` (`test_client.py:208-215`). */
const SIMPLIFY_ROWS: readonly SimplifyRow[] = [
  {
    // test_client.py:209-214
    id: "top ∧ top simplifies to top",
    pattern: and(INT, [intTop, intTop]),
    params: { state: kore(and(INT, [intTop, intTop])) },
    response: { state: kore(intTop) },
    expected: { state: koreJson(intTop) },
  },
];

describe("simplify (test_client.py:208-235)", () => {
  for (const row of SIMPLIFY_ROWS) {
    test(`params: ${row.id}`, () => {
      expect(encodeSimplifyParams({ state: koreJson(row.pattern) })).toEqual(row.params);
    });

    test(`result: ${row.id}`, () => {
      expect(decodeSimplifyResult(row.response)).toEqual(row.expected);
    });

    test(`result round-trips: ${row.id}`, () => {
      expect(decodeSimplifyResult(encodeSimplifyResult(row.expected))).toEqual(row.expected);
    });
  }
});

//////////////////////
// get-model        //
//////////////////////

interface GetModelRow {
  readonly id: string;
  readonly pattern: Pattern;
  readonly moduleName: string | undefined;
  readonly params: JsonObject;
  readonly response: JsonObject;
  readonly expected: GetModelResult;
}

/** `GET_MODEL_TEST_DATA` (`test_client.py:238-267`). */
const GET_MODEL_ROWS: readonly GetModelRow[] = [
  {
    // test_client.py:239-245
    id: "Unknown, no module",
    pattern: intDv(0),
    moduleName: undefined,
    params: { state: kore(intDv(0)) },
    response: { satisfiable: "Unknown" },
    expected: { satisfiable: "Unknown" },
  },
  {
    // test_client.py:246-252
    id: "Unknown, with a module",
    pattern: intDv(1),
    moduleName: "TEST-MODULE",
    params: { state: kore(intDv(1)), module: "TEST-MODULE" },
    response: { satisfiable: "Unknown" },
    expected: { satisfiable: "Unknown" },
  },
  {
    // test_client.py:253-259
    id: "Unsat",
    pattern: intDv(2),
    moduleName: undefined,
    params: { state: kore(intDv(2)) },
    response: { satisfiable: "Unsat" },
    expected: { satisfiable: "Unsat" },
  },
  {
    // test_client.py:260-266
    id: "Sat, with a substitution",
    pattern: intDv(3),
    moduleName: undefined,
    params: { state: kore(intDv(3)) },
    response: { satisfiable: "Sat", substitution: kore(intDv(0)) },
    expected: { satisfiable: "Sat", substitution: koreJson(intDv(0)) },
  },
];

describe("get-model (test_client.py:238-288)", () => {
  for (const row of GET_MODEL_ROWS) {
    test(`params: ${row.id}`, () => {
      expect(
        encodeGetModelParams({
          state: koreJson(row.pattern),
          ...(row.moduleName === undefined ? {} : { module: row.moduleName }),
        }),
      ).toEqual(row.params);
    });

    test(`result: ${row.id}`, () => {
      expect(decodeGetModelResult(row.response)).toEqual(row.expected);
    });

    test(`result round-trips: ${row.id}`, () => {
      expect(decodeGetModelResult(encodeGetModelResult(row.expected))).toEqual(row.expected);
    });
  }

  test("Sat / Unsat / Unknown are capitalized, uniquely in this protocol", () => {
    expect(() => decodeGetModelResult({ satisfiable: "sat" })).toThrow('Unknown satisfiability: "sat"');
  });

  test("a substitution beside Unsat is dropped, not typed", () => {
    const result = decodeGetModelResult({ satisfiable: "Unsat", substitution: kore(intDv(0)) });
    expect(result).toEqual({ satisfiable: "Unsat" });
  });
});

//////////////////////
// add-module       //
//////////////////////

interface AddModuleRow {
  readonly id: string;
  readonly moduleText: string;
  readonly params: JsonObject;
  readonly response: JsonObject;
  readonly expected: AddModuleResult;
}

/**
 * `ADD_MODULE_TEST_DATA` (`test_client.py:291-296`) plus the response literal
 * the test body pins (`test_client.py:307-308`).
 *
 * pyk passes a `Module` and takes `.text`; we unparse with `koreText` here,
 * and assert that our unparser agrees with pyk's on the empty module — the
 * `'module HELLO\nendmodule []'` literal upstream writes by hand.
 */
const ADD_MODULE_ROWS: readonly AddModuleRow[] = [
  {
    id: "an empty module",
    moduleText: koreText(koreModule("HELLO")),
    params: { module: "module HELLO\nendmodule []" },
    response: { module: "m0123456789abcdef" },
    expected: { module: "m0123456789abcdef" },
  },
];

describe("add-module (test_client.py:291-315)", () => {
  for (const row of ADD_MODULE_ROWS) {
    test(`params: ${row.id}`, () => {
      expect(encodeAddModuleParams({ module: row.moduleText })).toEqual(row.params);
    });

    test(`result: ${row.id}`, () => {
      expect(decodeAddModuleResult(row.response)).toEqual(row.expected);
    });
  }

  test("module is textual KORE, not an envelope", () => {
    const encoded = encodeAddModuleParams({ module: "module M\nendmodule []", nameAsId: true });
    expect(encoded).toEqual({ module: "module M\nendmodule []", "name-as-id": true });
  });
});

//////////////////////////
// Parameter encoding   //
//////////////////////////

describe("request parameter encoding", () => {
  test("every execute parameter, kebab-cased (Types.hs:39-52)", () => {
    const encoded = encodeExecuteParams({
      state: koreJson(intDv(0)),
      maxDepth: 4,
      module: "M",
      cutPointRules: ["a", "b"],
      terminalRules: ["c"],
      movingAverageStepTimeout: true,
      stepTimeout: 250,
      assumeStateDefined: false,
      logSuccessfulRewrites: true,
      logFailedRewrites: false,
      boosterOnly: true,
      haskellLogging: ["Proxy", "Rewrite"],
    });
    expect(encoded).toEqual({
      state: kore(intDv(0)),
      "max-depth": 4,
      module: "M",
      "cut-point-rules": ["a", "b"],
      "terminal-rules": ["c"],
      "moving-average-step-timeout": true,
      "step-timeout": 250,
      "assume-state-defined": false,
      "log-successful-rewrites": true,
      "log-failed-rewrites": false,
      "booster-only": true,
      "haskell-logging": ["Proxy", "Rewrite"],
    });
  });

  test("absent optionals are omitted, never null (OmitNothingFields)", () => {
    const encoded = encodeExecuteParams({ state: koreJson(intDv(0)) });
    expect(Object.keys(encoded)).toEqual(["state"]);
    expect(JSON.stringify(encoded)).not.toContain("null");
  });

  test("a false boolean is sent, not treated as absent", () => {
    const encoded = encodeExecuteParams({ state: koreJson(intDv(0)), boosterOnly: false });
    expect(encoded).toEqual({ state: kore(intDv(0)), "booster-only": false });
  });

  test("simplify and get-model carry booster-only and haskell-logging", () => {
    expect(
      encodeSimplifyParams({ state: koreJson(intTop), module: "M", boosterOnly: true, haskellLogging: ["Smt"] }),
    ).toEqual({ state: kore(intTop), module: "M", "booster-only": true, "haskell-logging": ["Smt"] });
    expect(encodeGetModelParams({ state: koreJson(intTop), boosterOnly: false })).toEqual({
      state: kore(intTop),
      "booster-only": false,
    });
  });
});

//////////////////////////
// Envelopes            //
//////////////////////////

describe("JSON-RPC envelopes", () => {
  test("a request is {jsonrpc, id, method, params}", () => {
    const request = encodeRequest("client-001", { method: "execute", params: { state: koreJson(intDv(0)) } });
    expect(request).toEqual({
      jsonrpc: "2.0",
      id: "client-001",
      method: "execute",
      params: { state: kore(intDv(0)) },
    });
    expect(Object.keys(request)).toEqual(["jsonrpc", "id", "method", "params"]);
  });

  test("cancel is a request in shape with an empty params (rpc.py:342-353)", () => {
    expect(encodeRequest("client-001-cancel", { method: "cancel" })).toEqual({
      jsonrpc: "2.0",
      id: "client-001-cancel",
      method: "cancel",
      params: {},
    });
  });

  test("a result response yields the id and the raw result", () => {
    const response = decodeResponse('{"jsonrpc":"2.0","id":7,"result":{"satisfiable":"Unsat"}}');
    expect(response.kind).toBe("result");
    expect(response.id).toBe(7);
    if (response.kind !== "result") throw new Error("unreachable");
    expect(decodeResult("get-model", response.result)).toEqual({ satisfiable: "Unsat" });
  });

  test("an error response yields the error object", () => {
    const response = decodeResponse({ jsonrpc: "2.0", id: "a-001", error: { code: 3, message: "x", data: "M" } });
    expect(response.kind).toBe("error");
    if (response.kind !== "error") throw new Error("unreachable");
    expect(response.error).toEqual({ code: 3, message: "x", data: "M" });
  });

  test("id echo is the caller's business: a mismatch is not an error here", () => {
    const response = decodeResponse({ jsonrpc: "2.0", id: "not-mine", result: { satisfiable: "Sat" } });
    expect(response.id).toBe("not-mine");
  });

  test("a null id (a -32700 with nothing to echo) decodes", () => {
    const response = decodeResponse({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
    expect(response.id).toBeNull();
  });

  test("neither result nor error is a decode failure", () => {
    expect(() => decodeResponse({ jsonrpc: "2.0", id: 1 })).toThrow(
      'Response has neither a "result" nor an "error" member',
    );
  });

  test("a foreign jsonrpc version is rejected", () => {
    expect(() => decodeResponse({ jsonrpc: "1.0", id: 1, result: {} })).toThrow('Expected jsonrpc "2.0"');
  });

  test("decodeResult dispatches on the method", () => {
    expect(decodeResult("simplify", { state: kore(intTop) })).toEqual({ state: koreJson(intTop) });
    expect(decodeResult("add-module", { module: "m0" })).toEqual({ module: "m0" });
  });
});

//////////////////////////
// Decode discipline    //
//////////////////////////

describe("decode discipline", () => {
  test("a missing required field names the field and the path", () => {
    expect(() => decodeExecuteResult({ reason: "stuck", depth: 0 })).toThrow(
      'ExecuteResult is missing the field "state" (at result)',
    );
    expect(() => decodeExecuteResult({ reason: "stuck", state: { term: kore(intTop) } })).toThrow(
      'ExecuteResult is missing the field "depth"',
    );
    expect(() => decodeSimplifyResult({})).toThrow('SimplifyResult is missing the field "state"');
  });

  test("depth is a Natural: negative and fractional are rejected (Depth.hs:6)", () => {
    const base = { reason: "stuck", state: { term: kore(intTop) } };
    expect(() => decodeExecuteResult({ ...base, depth: -1 })).toThrow("Expected a non-negative integer, got -1");
    expect(() => decodeExecuteResult({ ...base, depth: 1.5 })).toThrow("Expected a non-negative integer, got 1.5");
    expect(decodeExecuteResult({ ...base, depth: 0 }).depth).toBe(0);
  });

  test("an unknown halt reason is rejected — the enum is closed (Types.hs:129-141)", () => {
    expect(() => decodeExecuteResult({ reason: "exploded", depth: 0, state: { term: kore(intTop) } })).toThrow(
      'Unknown halt reason: "exploded" (at result.reason)',
    );
  });

  test("branching and cut-point-rule require next-states", () => {
    const base = { depth: 0, state: { term: kore(intTop) } };
    expect(() => decodeExecuteResult({ ...base, reason: "branching" })).toThrow(
      'branching result is missing the field "next-states"',
    );
    expect(() => decodeExecuteResult({ ...base, reason: "cut-point-rule", rule: "r" })).toThrow(
      'cut-point-rule result is missing the field "next-states"',
    );
  });

  test("cut-point-rule and terminal-rule require rule", () => {
    const base = { depth: 0, state: { term: kore(intTop) } };
    expect(() => decodeExecuteResult({ ...base, reason: "terminal-rule" })).toThrow(
      'terminal-rule result is missing the field "rule"',
    );
    expect(() =>
      decodeExecuteResult({ ...base, reason: "cut-point-rule", "next-states": [{ term: kore(intTop) }] }),
    ).toThrow('cut-point-rule result is missing the field "rule"');
  });

  test("a rule on a stuck result is carried, and an unknown key is still ignored", () => {
    // The two leniencies are different contracts. `rule` is a declared field of
    // the one flat `ExecuteResult` record (`Types.hs:143-156`), so it is valid
    // wire data this decoder must be able to re-emit; `some-future-field` is an
    // extension nobody here can claim to reproduce faithfully, and stays
    // dropped.
    const result = decodeExecuteResult({
      reason: "stuck",
      depth: 0,
      state: { term: kore(intTop) },
      rule: "carried",
      "some-future-field": 42,
    });
    expect(result).toEqual({
      reason: "stuck",
      depth: 0,
      state: { term: koreJson(intTop) },
      offReasonFields: { rule: "carried" },
    });
  });

  test("an explicit null optional reads as absent (aeson .:? semantics)", () => {
    const result = decodeExecuteResult({
      reason: "stuck",
      depth: 0,
      state: { term: kore(intTop), predicate: null, "rule-id": null },
      logs: null,
    });
    expect(result).toEqual({ reason: "stuck", depth: 0, state: { term: koreJson(intTop) } });
  });

  test("every ExecuteState field decodes and re-encodes", () => {
    const wire = {
      term: kore(intDv(0)),
      predicate: kore(intTop),
      substitution: kore(equals(INT, SORT_GENERATED_TOP_CELL, x, intDv(3))),
      "rule-substitution": kore(equals(INT, SORT_GENERATED_TOP_CELL, y, intDv(4))),
      "rule-predicate": kore(intBottom),
      "rule-id": "abc1234",
    };
    const state = decodeExecuteResult({ reason: "stuck", depth: 0, state: wire }).state;
    expect(state.ruleId).toBe("abc1234");
    expect(encodeExecuteResult({ reason: "stuck", depth: 0, state })).toEqual({
      reason: "stuck",
      depth: 0,
      state: wire,
    });
  });

  test("all eight halt reasons decode (Types.hs:129-137)", () => {
    const state = { term: kore(intTop) };
    const nextStates = [{ term: kore(intTop) }];
    const cases: readonly [ExecuteResult["reason"], JsonObject][] = [
      ["branching", { "next-states": nextStates }],
      ["stuck", {}],
      ["vacuous", {}],
      ["depth-bound", {}],
      ["cut-point-rule", { "next-states": nextStates, rule: "r" }],
      ["terminal-rule", { rule: "r" }],
      ["aborted", {}],
      ["timeout", {}],
    ];
    for (const [reason, extra] of cases) {
      const result = decodeExecuteResult({ reason, depth: 3, state, ...extra });
      expect(result.reason).toBe(reason);
      expect(result.depth).toBe(3);
    }
  });
});

//////////////////////////////
// Off-reason carry-through //
//////////////////////////////

/**
 * `ExecuteResult` is one flat record upstream (`Types.hs:143-156`) and eight
 * variants here, so the three `Maybe` fields a reason does not own —
 * `next-states`, `rule`, `unknown-predicate` — have no typed home on that
 * variant. aeson round-trips them anyway, which makes them wire data a mock
 * server built on `encodeExecuteResult` has to be able to reproduce.
 *
 * The oracle is `emitOrdered`: not "equal as values" but **byte-identical to
 * what a server would have written**, which is the only claim strong enough to
 * be worth making about a carry-through.
 */

/** `decode` then `encode` then emit, for comparison against the server's own bytes. */
function reemit(wire: JsonObject): string {
  return emitOrdered(encodeExecuteResult(decodeExecuteResult(wire)));
}

describe("off-reason fields (Types.hs:143-156)", () => {
  test("a stuck result carrying rule and unknown-predicate round-trips byte-identically", () => {
    const wire: JsonObject = {
      reason: "stuck",
      depth: 4,
      state: { term: kore(intDv(2)) },
      rule: "RULE-ID-42",
      "unknown-predicate": kore(intTop),
    };
    const result = decodeExecuteResult(wire);
    expect(result.offReasonFields).toEqual({ rule: "RULE-ID-42", "unknown-predicate": kore(intTop) });
    expect(reemit(wire)).toBe(emitOrdered(wire));
  });

  test("a branching result carrying rule round-trips, its own next-states untouched", () => {
    const wire: JsonObject = {
      reason: "branching",
      depth: 1,
      state: { term: kore(intDv(0)) },
      "next-states": [{ term: kore(intDv(1)) }, { term: kore(intDv(2)) }],
      rule: "RULE-ID-7",
    };
    const result = decodeExecuteResult(wire);
    // The typed `next-states` and the carried `rule` are different mechanisms
    // on the same result, and neither may shadow the other.
    if (result.reason !== "branching") throw new TypeError(`Expected a branching result, got ${result.reason}`);
    expect(result.nextStates).toHaveLength(2);
    expect(result.offReasonFields).toEqual({ rule: "RULE-ID-7" });
    expect(reemit(wire)).toBe(emitOrdered(wire));
  });

  test("each reason carries exactly the fields it does not own", () => {
    // All three present on every reason: what comes back is the complement of
    // what the variant has a typed field for, and nothing else.
    const all: JsonObject = {
      depth: 0,
      state: { term: kore(intTop) },
      "next-states": [{ term: kore(intTop) }],
      rule: "r",
      "unknown-predicate": kore(intBottom),
    };
    const expected: readonly [ExecuteResult["reason"], readonly string[]][] = [
      ["branching", ["rule", "unknown-predicate"]],
      ["stuck", ["next-states", "rule", "unknown-predicate"]],
      ["vacuous", ["next-states", "rule", "unknown-predicate"]],
      ["depth-bound", ["next-states", "rule", "unknown-predicate"]],
      ["cut-point-rule", ["unknown-predicate"]],
      ["terminal-rule", ["next-states", "unknown-predicate"]],
      ["aborted", ["next-states", "rule"]],
      ["timeout", ["next-states", "rule", "unknown-predicate"]],
    ];
    for (const [reason, keys] of expected) {
      const wire: JsonObject = { reason, ...all };
      expect(Object.keys(defined(decodeExecuteResult(wire).offReasonFields, `${reason}'s off-reason fields`))).toEqual([
        ...keys,
      ]);
      expect(reemit(wire)).toBe(emitOrdered(wire));
    }
  });

  test("absent stays absent — the encoder adds nothing", () => {
    // The overwhelmingly common case, and the one that must cost nothing: no
    // property on the decoded value, no key on the re-encoded object.
    const wire: JsonObject = { reason: "terminal-rule", depth: 2, state: { term: kore(intTop) }, rule: "r" };
    const result = decodeExecuteResult(wire);
    expect("offReasonFields" in result).toBe(false);
    expect(encodeExecuteResult(result)).toEqual(wire);
  });

  test("an off-reason field is carried raw, not interpreted", () => {
    // `unknown-predicate` beside `stuck` is not this reason's predicate and
    // nothing here pretends it parses as one: a value `readKoreJson` would
    // reject still round-trips, because it is bytes we are moving, not a term.
    const wire: JsonObject = {
      reason: "stuck",
      depth: 0,
      state: { term: kore(intTop) },
      "unknown-predicate": { format: "NOT-KORE", version: 99 },
    };
    expect(decodeExecuteResult(wire).offReasonFields).toEqual({
      "unknown-predicate": { format: "NOT-KORE", version: 99 },
    });
    expect(reemit(wire)).toBe(emitOrdered(wire));
  });
});

//////////////////////
// Request decoding //
//////////////////////

/**
 * The request-side decoders, which are public API and not merely the fixture
 * suites' loop-closer (`codec.ts`'s header says why).
 *
 * Breadth lives in the corpus: `golden.test.ts` reconstructs and re-encodes
 * every `kore-rpc-server` request, `structural.test.ts` reads 46 real
 * `.send` envelopes, and `classification.test.ts` asserts that a request is
 * not mistakable for a response. What is asserted here is the *contract* those
 * suites depend on, at the place it is now implemented.
 */
describe("params and envelope decoding", () => {
  test("an execute request round-trips through the typed value", () => {
    const params = { state: kore(intTop), module: "IMP", "max-depth": 4, "cut-point-rules": ["a", "b"] };
    expect(encodeExecuteParams(decodeExecuteParams(params))).toEqual(params);
  });

  test("a state that is a string is rejected, not re-parsed as JSON text", () => {
    // `decodeKoreJson` takes a string as *source text*, so without the object
    // guard this would parse rather than fail — which is exactly what
    // `kore-rpc-server/execute/invalid-params` exists to catch.
    expect(() => decodeExecuteParams({ state: "aaaa" })).toThrow(
      'Expected a KORE-JSON envelope, got "aaaa" (at params.state)',
    );
  });

  test("a missing required parameter names the record it belongs to", () => {
    expect(() => decodeExecuteParams({})).toThrow('ExecuteRequest is missing the field "state"');
    expect(() => decodeAddModuleParams({})).toThrow('AddModuleRequest is missing the field "module"');
  });

  test("an unknown parameter is ignored, and a known one of the wrong type is not", () => {
    // Lenient about extension: `classification/state-a.unformatted.execute.request`
    // carries a stray `"xdoesnot"` and must still decode.
    expect(decodeExecuteParams({ state: kore(intTop), xdoesnot: 1 })).toEqual({ state: koreJson(intTop) });
    expect(() => decodeExecuteParams({ state: kore(intTop), "max-depth": -1 })).toThrow(
      "Expected a non-negative integer, got -1 (at params.max-depth)",
    );
  });

  test("`step-timeout` is an Int, not a Natural (`Types.hs:46`)", () => {
    // `max-depth` is a `Depth`, i.e. `Natural`, and rejects a negative;
    // `step-timeout` is a plain `Maybe Int`, which aeson decodes from `-1`
    // without complaint. Reading it as a `Natural` made a request the server
    // accepts undecodable here.
    expect(decodeExecuteParams({ state: kore(intTop), "step-timeout": -1 })).toEqual({
      state: koreJson(intTop),
      stepTimeout: -1,
    });
    expect(encodeExecuteParams(decodeExecuteParams({ state: kore(intTop), "step-timeout": -1 }))).toEqual({
      state: kore(intTop),
      "step-timeout": -1,
    });
    // Still an integer, though: `Int` is not `Double`.
    expect(() => decodeExecuteParams({ state: kore(intTop), "step-timeout": 1.5 })).toThrow(
      "Expected an integer, got 1.5 (at params.step-timeout)",
    );
  });

  test("decodeParams dispatches on the method", () => {
    expect(decodeParams("simplify", { state: kore(intTop) })).toEqual({ state: koreJson(intTop) });
    expect(decodeParams("add-module", { module: "module M endmodule" })).toEqual({ module: "module M endmodule" });
  });

  test("the envelope round-trips, cancel included", () => {
    const request = encodeRequest("r-001", { method: "simplify", params: { state: koreJson(intTop) } });
    const decoded = decodeRequestEnvelope(request);
    expect(decoded.id).toBe("r-001");
    expect(encodeRequest(decoded.id, decoded.request)).toEqual(request);

    // `cancel` has no params to read, so whatever it carries is discarded.
    expect(decodeRequestEnvelope({ jsonrpc: "2.0", id: 7, method: "cancel", params: { junk: true } })).toEqual({
      id: 7,
      request: { method: "cancel" },
    });
  });

  test("the envelope is strict about what an envelope is", () => {
    const params = { state: kore(intTop) };
    expect(() => decodeRequestEnvelope({ jsonrpc: "1.0", id: 1, method: "simplify", params })).toThrow(
      "<request>.jsonrpc",
    );
    expect(() => decodeRequestEnvelope({ jsonrpc: "2.0", method: "simplify", params })).toThrow("<request>.id");
    expect(() => decodeRequestEnvelope({ jsonrpc: "2.0", id: 1, method: "frobnicate", params })).toThrow(
      'Not a kore-rpc method: "frobnicate" (at <request>.method)',
    );
    // A bare KORE-JSON term is not a request — the property
    // `classification.test.ts` turns into an oracle.
    expect(() => decodeRequestEnvelope(kore(intTop))).toThrow("<request>.id");
  });
});

//////////////////////////
// Hostile dispatch     //
//////////////////////////

/**
 * A method name the type system would refuse — the whole point of the suite
 * below, since the string comes off a socket in every case that matters.
 */
// oxlint-disable-next-line typescript/no-unsafe-type-assertion
const asMethod = (name: string): KoreRpcMethod => name as KoreRpcMethod;

/** Every member a table inheriting `Object.prototype` would hand back. */
const INHERITED = ["constructor", "toString", "valueOf", "hasOwnProperty", "__proto__"];

describe("method dispatch is keyed by data, not by the prototype chain", () => {
  // As object literals the two decoder tables inherited `Object.prototype`, so
  // `"constructor"` found `Object` and *called* it — handing back `{}` typed as
  // an `ExecuteResult` — and `"__proto__"` threw a raw `TypeError` with none of
  // this package's error shape.
  test("decodeResult rejects every inherited member with the house error", () => {
    for (const name of INHERITED) {
      const thrown = caught(() => decodeResult(asMethod(name), {}));
      expect(thrown).toBeInstanceOf(SyntaxError);
      expect(thrown.message).toMatch(/Unknown kore-rpc method for the result decoder/u);
      expect(thrown.message).toMatch(/\(at method\)/u);
      expect(thrown.message).toContain(JSON.stringify(name));
    }
  });

  test("decodeParams rejects every inherited member with the house error", () => {
    for (const name of INHERITED) {
      const thrown = caught(() => decodeParams(asMethod(name), {}));
      expect(thrown).toBeInstanceOf(SyntaxError);
      expect(thrown.message).toMatch(/Unknown kore-rpc method for the params decoder/u);
    }
  });

  test("`constructor` in particular does not silently return a value", () => {
    // The failure this replaces was silent: `decodeResult("constructor", {})`
    // returned `{}`, and the caller went on to read fields off it.
    expect(caught(() => decodeResult(asMethod("constructor"), {}))).toBeInstanceOf(SyntaxError);
  });

  test("the five real methods still dispatch", () => {
    expect(decodeResult("add-module", { module: "M" })).toEqual({ module: "M" });
    expect(decodeParams("add-module", { module: "M" })).toEqual({ module: "M" });
  });
});

//////////////////////////
// Response text        //
//////////////////////////

describe("decodeResponse on text that is not JSON", () => {
  test("is this package's SyntaxError, with a path", () => {
    const thrown = caught(() => decodeResponse('{"id":"L-001","result":'));
    expect(thrown).toBeInstanceOf(SyntaxError);
    expect(thrown.message).toMatch(/Response is not valid JSON/u);
    expect(thrown.message).toMatch(/\(at <response>\)/u);
  });

  test("the excerpt is bounded — a 4 MB line does not become a 4 MB message", () => {
    const line = `{"id":"L-001","result":"${"x".repeat(4_000_000)}`;
    const { message } = caught(() => decodeResponse(line));
    expect(message.length).toBeLessThan(500);
    // It still identifies the line (the excerpt is JSON-escaped), and says how
    // much was withheld.
    expect(message).toContain('L-001\\",\\"result');
    expect(message).toContain(String(line.length));
  });

  test("a custom path is carried through", () => {
    expect(() => decodeResponse("garbage", "line 3")).toThrow(/\(at line 3\)/u);
  });
});
