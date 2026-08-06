/**
 * The byte-exact tier: `fixtures/kore-rpc-server`, plus the two smaller
 * corpora that are compared structurally, `fixtures/smoke` and
 * `fixtures/pyk-rpc`.
 *
 * Three oracles, in increasing strength, all applied to every case:
 *
 * 1. **Bytes.** `emitOrdered(JSON.parse(golden)) === golden`, for all 40
 *    `kore-rpc-server` goldens. These are what a real server wrote onto a
 *    socket (`jsonRpcServer` with `confIndent = Spaces 0`,
 *    `confTrailingNewline = True`), so this pins `keyorder.ts`'s transcription
 *    of `PrettyJson.keyOrder` — the one thing about this protocol that
 *    `JSON.stringify` cannot reproduce.
 * 2. **Types.** The golden decodes through `decodeResponse` and then through
 *    `decodeResult`/`decodeKoreRpcError` into the right *variant* — the right
 *    halt reason, implication status, satisfiability or typed error class. The
 *    expectations in {@link GOLDEN_EXPECTATIONS} were read out of the fixtures,
 *    not guessed, and the table is asserted to be total: an unlisted golden is
 *    a failure, so a new fixture cannot be silently ignored.
 * 3. **Round trips.** Re-encoding the decoded value reproduces the original
 *    JSON structurally, in both directions — requests through
 *    `encodeRequest`/`encode*Params`, results through `encode*Result`.
 *
 * Requests for this corpus are **not on disk**; `runTests.py` builds them from
 * the pieces and this file reproduces that construction exactly (see
 * {@link reconstructRequest} and `fixtures/PROVENANCE.md` §"Requests are NOT
 * stored").
 *
 * # Counted skips
 *
 * Exactly one fixture is deliberately not exercised as a request input:
 *
 * - `kore-rpc-server/simplify/list-matching/params.json` — inert upstream. The
 *   simplify loop (`runTests.py:211-221`) builds `{"state": …}` and never
 *   reads a `params.json`, so feeding it in would test a request that no
 *   client has ever sent. It is still asserted to be the empty object, so it
 *   cannot change under us unnoticed. See {@link INERT_FIXTURES}.
 *
 * Nothing else is skipped; every other file under `kore-rpc-server/`,
 * `smoke/` and `pyk-rpc/` that is not a `README.md` is read by some assertion
 * below, and {@link test} "every fixture file is accounted for" enforces it.
 */

import { createHash } from "node:crypto";
import { describe, expect, test } from "bun:test";
import type { JsonValue } from "@kframework-ts/kore";
import { decodeResponse, decodeResult, encodeRequest } from "../src/codec.ts";
import {
  type KoreRpcError,
  DefaultError,
  ImplicationError,
  SmtSolverError,
  UnknownModuleError,
  decodeErrorObject,
  decodeKoreRpcError,
} from "../src/errors.ts";
import { emitOrdered } from "../src/keyorder.ts";
import type { HaltReason, ImpliesStatus, KoreRpcMethod, SatResult } from "../src/types.ts";
import {
  decodeRequestEnvelope,
  encodeResultFor,
  expectRoundTrip,
  fixturePath,
  listDirs,
  listFiles,
  readFixture,
  readFixtureJson,
  stripTrailingNewline,
} from "./fixtures.ts";
import { defined, jsonMember, jsonMemberOrAbsent, jsonRecord, jsonString, parseJson } from "./helpers/assert.ts";

//////////////////////////////
// The kore-rpc-server tier //
//////////////////////////////

const SERVER = "kore-rpc-server";

/** The four single-request methods; `add-module` is a session and is tested separately. */
const SERVER_METHODS = ["execute", "implies", "simplify", "get-model"] as const;

/** One `<method>/<case>` directory of the byte-exact corpus. */
interface ServerCase {
  readonly method: (typeof SERVER_METHODS)[number];
  readonly name: string;
  /** `execute/branching`, i.e. the key both the tables below use. */
  readonly id: string;
  readonly files: readonly string[];
}

const SERVER_CASES: readonly ServerCase[] = SERVER_METHODS.flatMap((method) =>
  listDirs(SERVER, method).map((name) => ({
    method,
    name,
    id: `${method}/${name}`,
    files: listFiles(SERVER, method, name),
  })),
);

/**
 * Fixtures read by an assertion but never fed to the codec as a request, with
 * the reason. See the file header; this is the whole skip list.
 */
const INERT_FIXTURES: Readonly<Record<string, string>> = {
  "simplify/list-matching/params.json": "the simplify loop (runTests.py:211-221) never reads a params.json",
};

/**
 * Cases whose *request* is deliberately not protocol-valid, and the params
 * member that makes it so. Each golden is the server's `-32602` complaint about
 * exactly that member, so the decoder is required to reject it in the same
 * place rather than to shrug.
 */
const INVALID_REQUESTS: Readonly<Record<string, string>> = {
  "execute/invalid-params": "state",
  "implies/invalid-antecedent": "antecedent",
  "implies/invalid-consequent": "consequent",
  "simplify/invalid-state": "state",
};

/**
 * Reconstruct a request the way `runTests.py` does — `fixtures/PROVENANCE.md`
 * §"Requests are NOT stored", table at lines 131-136.
 *
 * `execute` merges `params.json` and then overwrites `state`; `implies` takes
 * the two term files and has no `params.json` at all; `simplify` and
 * `get-model` take `{"state": …}` and nothing else.
 */
function reconstructRequest(method: KoreRpcMethod, dir: readonly string[]): JsonValue {
  const params: Record<string, JsonValue> =
    method === "implies"
      ? {
          antecedent: readFixtureJson(...dir, "antecedent.json"),
          consequent: readFixtureJson(...dir, "consequent.json"),
        }
      : {
          ...(method === "execute" ? jsonRecord(readFixtureJson(...dir, "params.json"), "params.json") : {}),
          state: readFixtureJson(...dir, "state.json"),
        };
  return { jsonrpc: "2.0", id: 1, method, params };
}

describe("kore-rpc-server: requests reconstruct and round-trip", () => {
  test.each(SERVER_CASES.map((c) => [c.id, c] as const))("%s", (_id, testCase) => {
    const request = reconstructRequest(testCase.method, [SERVER, testCase.method, testCase.name]);
    const invalidMember = INVALID_REQUESTS[testCase.id];

    if (invalidMember !== undefined) {
      // Not a skip: the assertion is that the decoder refuses, and refuses
      // about the right member.
      expect(() => decodeRequestEnvelope(request)).toThrow(new RegExp(`params\\.${invalidMember}`));
      return;
    }

    const { id, request: decoded } = decodeRequestEnvelope(request);
    expect(id).toBe(1);
    expect(decoded.method).toBe(testCase.method);
    expectRoundTrip(encodeRequest(id, decoded), request);
  });

  test("simplify/list-matching/params.json is the inert file PROVENANCE describes", () => {
    expect(Object.keys(INERT_FIXTURES)).toHaveLength(1);
    expect(readFixtureJson(SERVER, "simplify", "list-matching", "params.json")).toEqual({});
  });
});

//////////////////////
// Golden decoding  //
//////////////////////

/** What a `result` golden must decode to. Every field present is asserted. */
interface ResultExpectation {
  readonly kind: "result";
  readonly reason?: HaltReason;
  readonly depth?: number;
  readonly rule?: string;
  readonly nextStates?: number;
  readonly logs?: number;
  readonly status?: ImpliesStatus;
  readonly condition?: boolean;
  readonly satisfiable?: SatResult;
  readonly substitution?: boolean;
  readonly module?: string;
}

/** What an `error` golden must decode to: the code, the class, and the payload detail. */
interface ErrorExpectation {
  readonly kind: "error";
  readonly code: number;
  readonly ctor: abstract new (...args: never[]) => KoreRpcError;
  readonly message: string;
  /** Length of `data.context`, for the codes that carry one. */
  readonly context?: number;
  /** `data` when it is a bare string (codes 3/6/7/9). */
  readonly data?: string;
}

type GoldenExpectation = ResultExpectation | ErrorExpectation;

const RESULT = (fields: Omit<ResultExpectation, "kind">): ResultExpectation => ({ kind: "result", ...fields });

/**
 * Every golden in the corpus and what it says, keyed `<method>/<case>/<file>`.
 *
 * Read out of the fixtures (see the file header). The `-32602 Invalid params`
 * responses have no dedicated class upstream or here — pyk falls through to
 * `DefaultError` for every negative code and so do we — so the class assertion
 * on those is `DefaultError`, which is the actual contract, not a placeholder.
 */
const GOLDEN_EXPECTATIONS: Readonly<Record<string, GoldenExpectation>> = {
  // execute
  "execute/branching/response.golden": RESULT({ reason: "branching", depth: 0, nextStates: 2 }),
  "execute/branching-prune-unsat-remainder/response.golden": RESULT({ reason: "branching", depth: 0, nextStates: 2 }),
  "execute/cut-point/response.golden": RESULT({ reason: "cut-point-rule", depth: 1, rule: "TEST.DE", nextStates: 1 }),
  "execute/depth-limit/response.golden": RESULT({ reason: "depth-bound", depth: 2 }),
  "execute/invalid-params/response.golden": {
    kind: "error",
    code: -32602,
    ctor: DefaultError,
    message: "Invalid params",
  },
  "execute/list-matching/response.golden": RESULT({ reason: "stuck", depth: 1 }),
  "execute/logs/response.golden": RESULT({ reason: "terminal-rule", depth: 2, rule: "TEST.DE", logs: 2 }),
  "execute/terminal-rule/response.golden": RESULT({ reason: "terminal-rule", depth: 2, rule: "TEST.DE" }),
  "execute/vacuous/response.golden": RESULT({ reason: "vacuous", depth: 0 }),
  "execute/zero-steps/response.golden": RESULT({ reason: "depth-bound", depth: 0 }),

  // implies
  "implies/implied-substitution/response.golden": RESULT({ status: "valid", condition: true }),
  "implies/implied-trivial/response.golden": RESULT({ status: "valid", condition: true }),
  "implies/invalid-antecedent/response.golden": {
    kind: "error",
    code: -32602,
    ctor: DefaultError,
    message: "Invalid params",
  },
  "implies/invalid-consequent/response.golden": {
    kind: "error",
    code: -32602,
    ctor: DefaultError,
    message: "Invalid params",
  },
  "implies/invalid-free-vars-rhs/response.golden": {
    kind: "error",
    code: 4,
    ctor: ImplicationError,
    message: "Implication check error",
    context: 3,
  },
  "implies/invalid-name-capture/response.golden": {
    kind: "error",
    code: 4,
    ctor: ImplicationError,
    message: "Implication check error",
    context: 3,
  },
  "implies/invalid-non-singleton-lhs/response.golden": {
    kind: "error",
    code: 4,
    ctor: ImplicationError,
    message: "Implication check error",
    context: 1,
  },
  "implies/invalid-non-singleton-rhs/response.golden": {
    kind: "error",
    code: 4,
    ctor: ImplicationError,
    message: "Implication check error",
    context: 1,
  },
  "implies/invalid-not-function-like/response.golden": {
    kind: "error",
    code: 4,
    ctor: ImplicationError,
    message: "Implication check error",
    context: 1,
  },
  "implies/invalid-sort-mismatch/response.golden": {
    kind: "error",
    code: 4,
    ctor: ImplicationError,
    message: "Implication check error",
    context: 2,
  },
  "implies/not-implied/response.golden": RESULT({ status: "invalid", condition: false }),
  "implies/not-implied-stuck/response.golden": RESULT({ status: "invalid", condition: true }),

  // simplify
  "simplify/and-simplify/response.golden": RESULT({}),
  "simplify/and-simplify-bottom/response.golden": RESULT({}),
  "simplify/invalid-state/response.golden": {
    kind: "error",
    code: -32602,
    ctor: DefaultError,
    message: "Invalid params",
  },
  "simplify/list-matching/response.golden": RESULT({}),
  "simplify/not-not-simplify/response.golden": RESULT({}),
  "simplify/smt-error/response.golden": {
    kind: "error",
    code: 5,
    ctor: SmtSolverError,
    message: "Smt solver error",
  },

  // get-model — PROVENANCE §3: only `satisfiable` is authoritative here, the
  // substitution is whatever the solver returned that day. `substitution: true`
  // below therefore asserts only *presence*, never a value.
  "get-model/issue-3616-a/response.golden": RESULT({ satisfiable: "Sat", substitution: true }),
  "get-model/issue-3616-b/response.golden": RESULT({ satisfiable: "Sat", substitution: true }),
  "get-model/no-predicate/response.golden": RESULT({ satisfiable: "Unknown" }),
  "get-model/not-satisfiable/response.golden": RESULT({ satisfiable: "Unsat" }),
  "get-model/not-satisfiable-vars/response.golden": RESULT({ satisfiable: "Unsat" }),
  "get-model/satisfiable/response.golden": RESULT({ satisfiable: "Sat", substitution: true }),
  "get-model/trivial/response.golden": RESULT({ satisfiable: "Sat", substitution: false }),
  "get-model/unknown/response.golden": RESULT({ satisfiable: "Unknown" }),

  // add-module — the six-step session, driven again below.
  "add-module/add/response.golden": RESULT({
    module: "m8e723e34b156f187e7cce8658dbb513244788a1ab81c1f496b909b1a2d1cc0c3",
  }),
  "add-module/execute/response-defaultmodule.golden": RESULT({ reason: "stuck", depth: 1 }),
  "add-module/execute/response-fail.golden": {
    kind: "error",
    code: 3,
    ctor: UnknownModuleError,
    message: "Could not find module",
    data: "NEW",
  },
  "add-module/execute/response-success.golden": RESULT({ reason: "stuck", depth: 3 }),
};

/** A golden as it sits in the corpus: its key, its method, and its absolute path. */
interface Golden {
  readonly key: string;
  readonly method: KoreRpcMethod;
  readonly segments: readonly string[];
}

const GOLDENS: readonly Golden[] = [
  ...SERVER_CASES.flatMap((c) =>
    c.files
      .filter((f) => f.endsWith(".golden"))
      .map((f) => ({ key: `${c.id}/${f}`, method: c.method, segments: [SERVER, c.method, c.name, f] })),
  ),
  ...(["add", "execute"] as const).flatMap((sub) => {
    const method: KoreRpcMethod = sub === "add" ? "add-module" : "execute";
    return listFiles(SERVER, "add-module", sub)
      .filter((f) => f.endsWith(".golden"))
      .map((f) => ({ key: `add-module/${sub}/${f}`, method, segments: [SERVER, "add-module", sub, f] }));
  }),
];

/** Read a golden and split it into the exact bytes and the parsed value. */
function readGolden(golden: Golden): { readonly line: string; readonly json: JsonValue } {
  const raw = readFixture(...golden.segments);
  expect(raw.endsWith("\n")).toBe(true);
  const line = stripTrailingNewline(raw);
  expect(line).not.toContain("\n");
  return { line, json: parseJson(line) };
}

describe("kore-rpc-server: goldens are byte-exact under emitOrdered", () => {
  test.each(GOLDENS.map((g) => [g.key, g] as const))("%s", (_key, golden) => {
    const { line, json } = readGolden(golden);
    expect(emitOrdered(json)).toBe(line);
  });

  test("the expectation table covers every golden exactly", () => {
    expect(GOLDENS.map((g) => g.key).toSorted()).toEqual(Object.keys(GOLDEN_EXPECTATIONS).toSorted());
    expect(GOLDENS).toHaveLength(40);
  });
});

/**
 * Assert a decoded `result` against its expectation, and that re-encoding it
 * reproduces the golden's `result` member structurally.
 */
function checkResult(method: KoreRpcMethod, json: JsonValue, expectation: ResultExpectation): void {
  const response = decodeResponse(json);
  if (response.kind !== "result") throw new Error("expected a result response");
  expect(response.id).toBe(1);

  const original = jsonMember(json, "result", "the golden");

  // Decoded per method with a *literal*, so each arm holds that method's own
  // result type. The five result types share no discriminant, so narrowing the
  // union with an `as` would be asserting the very thing under test; asking the
  // decoder for the method the golden's directory names is the assertion.
  switch (method) {
    case "execute": {
      const execute = decodeResult("execute", response.result);
      if (expectation.reason !== undefined) expect(execute.reason).toBe(expectation.reason);
      if (expectation.depth !== undefined) expect(execute.depth).toBe(expectation.depth);
      if (expectation.rule !== undefined) {
        expect(execute.reason === "cut-point-rule" || execute.reason === "terminal-rule").toBe(true);
        if (execute.reason === "cut-point-rule" || execute.reason === "terminal-rule") {
          expect(execute.rule).toBe(expectation.rule);
        }
      }
      if (expectation.nextStates !== undefined) {
        expect(execute.reason === "branching" || execute.reason === "cut-point-rule").toBe(true);
        if (execute.reason === "branching" || execute.reason === "cut-point-rule") {
          expect(execute.nextStates).toHaveLength(expectation.nextStates);
        }
      }
      if (expectation.logs !== undefined) expect(execute.logs ?? []).toHaveLength(expectation.logs);
      // No vendored golden carries a result-level field its reason does not
      // own, so `codec.ts`'s carry-through takes its absence path everywhere in
      // this corpus. Asserted rather than assumed: the round-trip below would
      // pass either way, and the claim being made is that these are real
      // servers' bytes and real servers do not do that.
      expect(execute.offReasonFields).toBeUndefined();
      expectRoundTrip(encodeResultFor("execute", execute), original);
      break;
    }
    case "implies": {
      const implies = decodeResult("implies", response.result);
      if (expectation.status !== undefined) expect(implies.status).toBe(expectation.status);
      if (expectation.condition !== undefined) expect(implies.condition !== undefined).toBe(expectation.condition);
      expectRoundTrip(encodeResultFor("implies", implies), original);
      break;
    }
    case "get-model": {
      const model = decodeResult("get-model", response.result);
      if (expectation.satisfiable !== undefined) expect(model.satisfiable).toBe(expectation.satisfiable);
      if (expectation.substitution !== undefined) {
        const present = model.satisfiable === "Sat" && model.substitution !== undefined;
        expect(present).toBe(expectation.substitution);
      }
      expectRoundTrip(encodeResultFor("get-model", model), original);
      break;
    }
    case "add-module": {
      const added = decodeResult("add-module", response.result);
      if (expectation.module !== undefined) expect(added.module).toBe(expectation.module);
      expectRoundTrip(encodeResultFor("add-module", added), original);
      break;
    }
    case "simplify": {
      const simplified = decodeResult("simplify", response.result);
      expectRoundTrip(encodeResultFor("simplify", simplified), original);
      break;
    }
  }
}

/** Assert a decoded `error` against its expectation, through both error entry points. */
function checkError(json: JsonValue, expectation: ErrorExpectation): void {
  const response = decodeResponse(json);
  if (response.kind !== "error") throw new Error("expected an error response");

  expect(response.error.code).toBe(expectation.code);
  expect(response.error.message).toBe(expectation.message);

  const raw = jsonMember(json, "error", "the golden");
  expect(decodeErrorObject(raw)).toEqual(response.error);

  const typed = decodeKoreRpcError(raw);
  expect(typed).toBeInstanceOf(expectation.ctor);
  expect(typed.code).toBe(expectation.code);
  // `data` survives undecoded on every typed error, which is what makes an
  // unrecognised payload shape lossless.
  expect(typed.data).toEqual(jsonMemberOrAbsent(raw, "data", "the golden's error object"));

  if (expectation.context !== undefined) {
    expect(typed).toBeInstanceOf(ImplicationError);
    if (typed instanceof ImplicationError) expect(typed.context).toHaveLength(expectation.context);
  }
  if (expectation.data !== undefined) {
    expect(typed).toBeInstanceOf(UnknownModuleError);
    if (typed instanceof UnknownModuleError) expect(typed.moduleName).toBe(expectation.data);
  }
}

describe("kore-rpc-server: goldens decode to the right typed value and re-encode", () => {
  test.each(GOLDENS.map((g) => [g.key, g] as const))("%s", (key, golden) => {
    const { json } = readGolden(golden);
    const expectation = GOLDEN_EXPECTATIONS[key];
    if (expectation === undefined) throw new Error(`no expectation for ${key}`);
    if (expectation.kind === "result") checkResult(golden.method, json, expectation);
    else checkError(json, expectation);
  });

  test("the SMT solver error carries the offending term", () => {
    const { json } = readGolden({
      key: "simplify/smt-error/response.golden",
      method: "simplify",
      segments: [SERVER, "simplify", "smt-error", "response.golden"],
    });
    const typed = decodeKoreRpcError(jsonMember(json, "error", "the smt-error golden"));
    expect(typed).toBeInstanceOf(SmtSolverError);
    if (typed instanceof SmtSolverError) {
      expect(typed.term).toBeDefined();
      // The solver's own words, verbatim; the class prepends `SMT solver
      // error:` and appends the unparsed pattern (`rpc.py:476-486`).
      expect(typed.error).toBe("(incomplete (theory arithmetic))");
      expect(typed.message).toStartWith("SMT solver error: (incomplete (theory arithmetic)) Pattern: ");
      expect(typed.message).toContain("\\and{SortBool{}}");
    }
  });
});

//////////////////////////
// The add-module session //
//////////////////////////

/**
 * `add-module/` is the corpus's only stateful session: six requests on one
 * socket, in a fixed order, prepared once and reused
 * (`runTests.py:225-244,246-298`). Nothing about it can be checked against a
 * live server here, so what is asserted is that the recorded artifacts are
 * *mutually consistent* — that requests 1/5 and 2/6 really are the same
 * request, that re-adding is idempotent, and that the module id obeys the
 * `"m" + sha256(moduleText)` law.
 */
describe("kore-rpc-server: the add-module session", () => {
  const addParams = jsonRecord(readFixtureJson(SERVER, "add-module", "add", "params.json"), "add/params.json");
  const executeParams = jsonRecord(
    readFixtureJson(SERVER, "add-module", "execute", "params.json"),
    "execute/params.json",
  );
  const state = readFixtureJson(SERVER, "add-module", "execute", "state.json");

  const withModule: JsonValue = {
    jsonrpc: "2.0",
    id: 1,
    method: "execute",
    params: { ...executeParams, state },
  };
  const defaultModule: JsonValue = { jsonrpc: "2.0", id: 1, method: "execute", params: { state } };
  const addModule: JsonValue = { jsonrpc: "2.0", id: 1, method: "add-module", params: addParams };

  /** The session, exactly as PROVENANCE's table at lines 162-169 records it. */
  const SESSION: readonly (readonly [JsonValue, string])[] = [
    [withModule, "execute/response-fail.golden"],
    [defaultModule, "execute/response-defaultmodule.golden"],
    [addModule, "add/response.golden"],
    [addModule, "add/response.golden"],
    [withModule, "execute/response-success.golden"],
    [defaultModule, "execute/response-defaultmodule.golden"],
  ];

  test("the session is six steps and requests 1/5, 2/6 and 3/4 are identical", () => {
    expect(SESSION).toHaveLength(6);
    const step = (n: number) => emitOrdered(defined(SESSION[n - 1], `session step ${n}`)[0]);
    expect(step(1)).toBe(step(5));
    expect(step(2)).toBe(step(6));
    expect(step(3)).toBe(step(4));
    // …and the two execute requests differ only by the `module` param.
    expect(step(1)).not.toBe(step(2));
    expect(executeParams).toEqual({ module: "NEW" });
  });

  test.each(SESSION.map((s, i) => [i + 1, s[0], s[1]] as const))("step %i sends a decodable request", (_i, request) => {
    const { id, request: decoded } = decodeRequestEnvelope(request);
    expectRoundTrip(encodeRequest(id, decoded), request);
  });

  test("the same request 1 gets two different answers, before and after the add", () => {
    const fail = readFixture(SERVER, "add-module", "execute", "response-fail.golden");
    const success = readFixture(SERVER, "add-module", "execute", "response-success.golden");
    expect(fail).not.toBe(success);

    // Before: `Could not find module: NEW`.
    const failed = decodeKoreRpcError(jsonMember(parseJson(fail), "error", "response-fail.golden"));
    expect(failed).toBeInstanceOf(UnknownModuleError);
    expect(failed.code).toBe(3);

    // After: a successful execution that runs three more steps, d → e → f.
    const done = decodeResult("execute", decodeResponseResult(success));
    expect(done.reason).toBe("stuck");
    expect(done.depth).toBe(3);

    // And the default module is unaffected: still stuck at d after one step.
    const dflt = decodeResult(
      "execute",
      decodeResponseResult(readFixture(SERVER, "add-module", "execute", "response-defaultmodule.golden")),
    );
    expect(dflt.reason).toBe("stuck");
    expect(dflt.depth).toBe(1);
    expect(emitOrdered(encodeResultFor("execute", done))).not.toBe(emitOrdered(encodeResultFor("execute", dflt)));
  });

  test('the module id is "m" + sha256(module text) — the add-module id law', () => {
    expect(typeof addParams["module"]).toBe("string");
    const moduleText = jsonString(addParams, "module");
    const digest = createHash("sha256").update(moduleText, "utf8").digest("hex");

    const added = decodeResult(
      "add-module",
      decodeResponseResult(readFixture(SERVER, "add-module", "add", "response.golden")),
    );
    expect(added.module).toBe(`m${digest}`);
    expect(added.module).toMatch(/^m[0-9a-f]{64}$/);

    // Requests 3 and 4 are the same bytes and check against the same golden,
    // so idempotence is exactly "both steps see this id".
    expect(SESSION[2]?.[1]).toBe(SESSION[3]?.[1]);
    // `name-as-id` is set, and the id is still the hash rather than "NEW":
    // `name-as-id` only makes the *name* usable as an alias.
    expect(addParams["name-as-id"]).toBe(true);
  });
});

/** The `result` member of a golden's text, for the tests that only want it. */
function decodeResponseResult(text: string): JsonValue {
  const response = decodeResponse(stripTrailingNewline(text));
  if (response.kind !== "result") throw new Error("expected a result response");
  return response.result;
}

//////////////////////
// smoke/           //
//////////////////////

describe("smoke: the krpc happy path and the only parse error", () => {
  test("plus-request.json is a full execute envelope that round-trips", () => {
    const raw = readFixtureJson("smoke", "plus-request.json");
    const { id, request } = decodeRequestEnvelope(raw);
    expect(id).toBe(1);
    expect(request.method).toBe("execute");
    if (request.method === "execute") {
      // The whole params object is just the state: no depth limit, no rules.
      expect(request.params.maxDepth).toBeUndefined();
      expect(request.params.module).toBeUndefined();
    }
    expectRoundTrip(encodeRequest(id, request), raw);
  });

  test("plus-response.json is a stuck result at depth 6", () => {
    const raw = readFixtureJson("smoke", "plus-response.json");
    const response = decodeResponse(raw);
    expect(response.kind).toBe("result");
    if (response.kind !== "result") return;
    expect(response.id).toBe(1);

    const result = decodeResult("execute", response.result);
    expect(result.reason).toBe("stuck");
    expect(result.depth).toBe(6);
    expect(result.state.substitution).toBeUndefined();
    expectRoundTrip(encodeResultFor("execute", result), response.result);
  });

  test("rubbish-request.json is not JSON at all", () => {
    const text = readFixture("smoke", "rubbish-request.json");
    expect(text).toBe("rubbish\n");
    expect(() => {
      JSON.parse(text);
    }).toThrow();
  });

  test("rubbish-response.json is the corpus's only -32700, with its data preserved", () => {
    const raw = readFixtureJson("smoke", "rubbish-response.json");
    const response = decodeResponse(raw);
    expect(response.kind).toBe("error");
    if (response.kind !== "error") return;

    // No id to echo on a parse error: the server sends `null`.
    expect(response.id).toBeNull();
    expect(response.error.code).toBe(-32700);
    expect(response.error.message).toBe("Parse error");
    expect(response.error.data).toBe("rubbish\n");

    const typed = decodeKoreRpcError(jsonMember(raw, "error", "rubbish-response.json"));
    expect(typed).toBeInstanceOf(DefaultError);
    expect(typed.code).toBe(-32700);
    expect(typed.data).toBe("rubbish\n");
    // Round-trips: the request that caused it is recoverable from the error.
    expect(typed.data).toBe(readFixture("smoke", "rubbish-request.json"));
  });

  test("every smoke fixture is accounted for", () => {
    expect(listFiles("smoke")).toEqual([
      "plus-request.json",
      "plus-response.json",
      "rubbish-request.json",
      "rubbish-response.json",
    ]);
  });
});

//////////////////////
// pyk-rpc/         //
//////////////////////

/**
 * The halt reason each `pyk-rpc/print` response filename declares. These are
 * upstream's own names for the five `execute` outcomes pyk's `rpc-print` is
 * tested against; the assertion is that the filename and the payload agree.
 */
const PYK_REASONS: Readonly<Record<string, HaltReason>> = {
  branching: "branching",
  "cut-point-rule": "cut-point-rule",
  "depth-bound": "depth-bound",
  stuck: "stuck",
  "terminal-rule": "terminal-rule",
};

interface PykFixture {
  readonly key: string;
  readonly segments: readonly string[];
  readonly method: KoreRpcMethod;
  readonly role: "request" | "response";
  readonly reason?: HaltReason;
}

/** Classify every `pyk-rpc` file from its name; an unrecognised name is a failure. */
function pykFixtures(): readonly PykFixture[] {
  const out: PykFixture[] = [];
  for (const dir of ["print", "kast"] as const) {
    for (const file of listFiles("pyk-rpc", dir)) {
      // The *prefix* names the method, not any later occurrence:
      // `imp-simplify-request-from-execute-response.json.golden` is a
      // **simplify** request derived from an execute response.
      const method: KoreRpcMethod = file.startsWith("imp-execute-") ? "execute" : "simplify";
      const key = `${dir}/${file}`;
      const segments = ["pyk-rpc", dir, file];

      // `*.json.golden` are `pyk rpc-kast`'s derived requests; `*-request.json`
      // are the inputs; everything else in these two directories is a response.
      if (file.endsWith("-request.json") || file.endsWith(".json.golden")) {
        out.push({ key, segments, method, role: "request" });
        continue;
      }
      if (!file.endsWith("-response.json")) throw new Error(`unclassifiable pyk-rpc fixture: ${key}`);

      const middle = file.replace(/^imp-(execute|simplify)-/, "").replace(/-response\.json$/, "");
      const reason = PYK_REASONS[middle];
      if (method === "execute" && reason === undefined) throw new Error(`no reason in the name of ${key}`);
      out.push({ key, segments, method, role: "response", ...(reason === undefined ? {} : { reason }) });
    }
  }
  return out;
}

const PYK_FIXTURES = pykFixtures();

describe("pyk-rpc: rpc-print and rpc-kast corpora", () => {
  test.each(PYK_FIXTURES.filter((f) => f.role === "request").map((f) => [f.key, f] as const))(
    "%s decodes as a typed request and re-encodes",
    (_key, fixture) => {
      const raw = readFixtureJson(...fixture.segments);
      const { id, request } = decodeRequestEnvelope(raw);
      expect(request.method).toBe(fixture.method);
      // Compared structurally: these are minified, and PROVENANCE (lines
      // 85-90) records that upstream compares them with `json.loads(…) ==
      // json.loads(…)` too.
      expectRoundTrip(encodeRequest(id, request), raw);
    },
  );

  test.each(PYK_FIXTURES.filter((f) => f.role === "response").map((f) => [f.key, f] as const))(
    "%s decodes to the reason its filename says",
    (_key, fixture) => {
      const raw = readFixtureJson(...fixture.segments);
      const response = decodeResponse(raw);
      if (response.kind !== "result") throw new Error("expected a result response");

      if (fixture.method === "execute") {
        const result = decodeResult("execute", response.result);
        expect(result.reason).toBe(defined(fixture.reason, `the halt reason in ${fixture.key}`));
        // As in `checkResult`: nothing pyk ever recorded carries an off-reason
        // field either.
        expect(result.offReasonFields).toBeUndefined();
        expectRoundTrip(encodeResultFor("execute", result), response.result);
      } else {
        const result = decodeResult("simplify", response.result);
        expect(result.state.format).toBe("KORE");
        expectRoundTrip(encodeResultFor("simplify", result), response.result);
      }
    },
  );

  test("every pyk-rpc fixture is accounted for, and all five reasons appear", () => {
    expect(PYK_FIXTURES).toHaveLength(13);
    expect(listFiles("pyk-rpc", "print")).toHaveLength(8);
    expect(listFiles("pyk-rpc", "kast")).toHaveLength(5);

    const reasons = new Set(PYK_FIXTURES.flatMap((f) => (f.reason === undefined ? [] : [f.reason])));
    expect(reasons.size).toBe(5);
    for (const reason of Object.values(PYK_REASONS)) expect(reasons.has(reason)).toBe(true);
  });

  test("the two rpc-kast goldens are derived requests, not responses", () => {
    // `pyk rpc-kast <reference-request> <input-response>` substitutes the
    // response's term into the reference request's params
    // (`test_pyk.py:147-188`), so the golden must carry the *response's* state.
    const responseJson = readFixtureJson("pyk-rpc", "kast", "imp-execute-depth-bound-response.json");
    const response = decodeResponse(responseJson);
    if (response.kind !== "result") throw new Error("expected a result response");
    // `.state` is an `ExecuteState`, whose `.term` is a KORE-JSON envelope;
    // the pattern itself is one level further in.
    const pattern = decodeResult("execute", response.result).state.term.term;

    const derived = [
      "imp-execute-request-from-execute-response.json.golden",
      "imp-simplify-request-from-execute-response.json.golden",
    ];
    for (const file of derived) {
      const { request } = decodeRequestEnvelope(readFixtureJson("pyk-rpc", "kast", file));
      if (request.method !== "execute" && request.method !== "simplify")
        throw new Error(`unexpected method in ${file}`);
      expect(request.params.state.term).toEqual(pattern);
    }
  });
});

//////////////////////
// Coverage         //
//////////////////////

test("every kore-rpc-server fixture file is accounted for", () => {
  // Files this suite reads, by role. `README.md` is documentation and
  // `state.kore` is the textual-KORE source of `execute/zero-steps/state.json`
  // (PROVENANCE's "Deviation note"), neither of which is protocol traffic.
  const seen = new Set<string>();
  const add = (...segments: readonly string[]) => seen.add(segments.join("/"));

  for (const testCase of SERVER_CASES) {
    for (const file of testCase.files) add(SERVER, testCase.method, testCase.name, file);
  }
  for (const sub of ["add", "execute"] as const) {
    for (const file of listFiles(SERVER, "add-module", sub)) add(SERVER, "add-module", sub, file);
  }
  add(SERVER, "README.md");

  // 131 vendored files (PROVENANCE's table), every one enumerated here.
  expect(seen.size).toBe(131);

  // And the corpus's shape has not drifted: 36 single-request cases (10
  // execute, 12 implies, 6 simplify, 8 get-model) plus the two add-module
  // directories.
  expect(SERVER_CASES).toHaveLength(36);
  expect(fixturePath(SERVER)).toContain("fixtures");
});
