/**
 * `src/inspect.ts` — `rpcPrint` and `rpcKast`, against pyk's own corpus.
 *
 * `rpcKast` has a **real oracle**: `fixtures/pyk-rpc/kast/` holds pyk's two
 * `.json.golden` files, which are the output of `pyk rpc-kast <reference>
 * <response>` on the inputs beside them, and upstream compares them the way
 * this file does — `json.loads(a) == json.loads(b)`, i.e. structurally
 * (`pyk/src/tests/integration/test_pyk.py:186-188`). Matching those two files
 * is the strongest statement available that the graft is pyk's graft.
 *
 * `rpcPrint` has **no comparable oracle here and cannot have one**: pyk's eight
 * `*.pretty.golden` files are pretty-printed *K*, produced by a `KPrint` over a
 * kompiled definition, and this package has no KAST layer (deviation 1 in
 * `inspect.ts`). `fixtures/PROVENANCE.md` records that they were deliberately
 * not vendored for exactly that reason. So the assertions below are of two
 * kinds instead, both of which a wrong implementation fails:
 *
 * - the *structural* lines — method, id, depth, halt reason, stop rule,
 *   next-state count — are read straight out of the fixture and compared, so
 *   the transcription of pyk's line vocabulary is pinned;
 * - every term the printer emits is **re-parsed** with `@kframework-ts/kore`
 *   and compared against the pattern the fixture carries, which makes the
 *   rendering a round trip rather than a string nobody checked.
 */

import { readFileSync } from "node:fs";
import { describe, expect, test } from "bun:test";
import { type JsonValue, type Pattern, decodeKoreJson, parsePattern } from "@kframework-ts/kore";
import { decodeExecuteResult } from "../src/codec.ts";
import { rpcKast, rpcPrint } from "../src/inspect.ts";
import { stateKore } from "../src/substitution.ts";
import { fixturePath } from "./fixtures.ts";
import { jsonMember, jsonRecord, jsonString, parseJsonRecord } from "./helpers/assert.ts";

/** One of pyk's `rpc-print` / `rpc-kast` corpus files, parsed. */
function pykRpc(...segments: readonly string[]): Record<string, JsonValue> {
  return parseJsonRecord(readFileSync(fixturePath("pyk-rpc", ...segments), "utf8"), segments.join("/"));
}

/** A kore-rpc-server golden, which is a whole response envelope on one line. */
function serverGolden(...segments: readonly string[]): Record<string, JsonValue> {
  return parseJsonRecord(readFileSync(fixturePath("kore-rpc-server", ...segments), "utf8"), segments.join("/"));
}

/** The `result` member of a response document. */
function resultOf(document: Record<string, JsonValue>): Record<string, JsonValue> {
  return jsonRecord(jsonMember(document, "result", "the response"), "result");
}

/** The `params` member of a request document. */
function paramsOf(document: Record<string, JsonValue>): Record<string, JsonValue> {
  return jsonRecord(jsonMember(document, "params", "the request"), "params");
}

/** The lines of a `rpcPrint` result. */
function lines(text: string): readonly string[] {
  return text.split("\n");
}

/**
 * The block of text under `heading`, up to the next heading line.
 *
 * Headings are the lines this printer emits that end in `:` and carry nothing
 * after it; a KORE term never starts a line that way, so the split is
 * unambiguous.
 */
function section(text: string, heading: string): string {
  const all = lines(text);
  const start = all.indexOf(heading);
  expect(start).toBeGreaterThanOrEqual(0);
  const rest = all.slice(start + 1);
  const end = rest.findIndex((line) => /^[A-Z][^:]*:$/u.test(line) || /^Next state #\d+:$/u.test(line));
  return (end < 0 ? rest : rest.slice(0, end)).join("\n");
}

/** The oracle for a printed term: it re-parses, and to the pattern it came from. */
function expectRendersAs(rendered: string, expected: Pattern): void {
  expect(parsePattern(rendered)).toEqual(expected);
}

//////////////////////
// rpc-kast         //
//////////////////////

describe("rpcKast", () => {
  const response = pykRpc("kast", "imp-execute-depth-bound-response.json");

  test("an execute response grafted into an execute request matches pyk's golden", () => {
    const built = rpcKast(pykRpc("kast", "imp-execute-request.json"), response);
    expect(built).toEqual(pykRpc("kast", "imp-execute-request-from-execute-response.json.golden"));
  });

  test("the same response grafted into a simplify request matches pyk's golden", () => {
    // The reference request's *method* is what decides which request comes
    // out — the whole point of the command.
    const built = rpcKast(pykRpc("kast", "imp-simplify-request.json"), response);
    expect(built).toEqual(pykRpc("kast", "imp-simplify-request-from-execute-response.json.golden"));
  });

  test("the envelope comes from the reference and the state from the response", () => {
    const built = rpcKast(
      { jsonrpc: "2.0", id: 7, method: "simplify", params: { module: "IMP", state: "ignored" } },
      response,
    );
    expect(built["jsonrpc"]).toBe("2.0");
    expect(built["id"]).toBe(7);
    expect(built["method"]).toBe("simplify");
    const params = jsonRecord(built["params"], "the built params");
    expect(params["module"]).toBe("IMP");
    // The state is the response's *combined* state, in a fresh envelope.
    const combined = stateKore(decodeExecuteResult(resultOf(response)).state);
    expect(decodeKoreJson(params["state"]).term).toEqual(combined);
  });

  test("parameters come out sorted with state last, so the output is diffable", () => {
    const built = rpcKast(
      { jsonrpc: "2.0", id: 1, method: "execute", params: { module: "IMP", "max-depth": 2, "cut-point-rules": [] } },
      response,
    );
    expect(Object.keys(jsonRecord(built["params"], "the built params"))).toEqual([
      "cut-point-rules",
      "max-depth",
      "module",
      "state",
    ]);
  });

  test("a response that is not an execute response is rejected", () => {
    expect(() =>
      rpcKast({ jsonrpc: "2.0", id: 1, method: "execute", params: {} }, { result: { state: {} } }),
    ).toThrow();
  });

  test("a non-object reference request is rejected by name", () => {
    expect(() => rpcKast("nope", response)).toThrow("the reference request");
  });
});

//////////////////////
// rpc-print        //
//////////////////////

describe("rpcPrint on a request", () => {
  test("names the envelope, sorts the parameters and renders the state", () => {
    const request = pykRpc("print", "imp-execute-request.json");
    const params = paramsOf(request);
    const printed = rpcPrint(request);
    const all = lines(printed);

    expect(all[0]).toBe("JSON RPC request");
    expect(all[1]).toBe(`id: ${JSON.stringify(request["id"])}`);
    expect(all[2]).toBe("Method: execute");

    // Every non-state parameter, sorted, JSON-valued — deviations (2) and (3).
    const expected = Object.keys(params)
      .filter((key) => key !== "state")
      .toSorted()
      .map((key) => `${key}: ${JSON.stringify(params[key])}`);
    expect(all.slice(3, 3 + expected.length)).toEqual(expected);

    // A *request*'s state is the bare pattern, not a combined one.
    expectRendersAs(section(printed, "State:"), decodeKoreJson(params["state"]).term);
  });

  test("a simplify request prints the same way", () => {
    const printed = rpcPrint(pykRpc("print", "imp-simplify-request.json"));
    expect(lines(printed)[0]).toBe("JSON RPC request");
    expect(lines(printed)[2]).toBe("Method: simplify");
    expect(printed).toContain('module: "IMP"');
  });

  test("an add-module request has no state, so it is all key/value lines", () => {
    const printed = rpcPrint({
      jsonrpc: "2.0",
      id: "x-001",
      method: "add-module",
      params: { module: "module M endmodule []", "name-as-id": true },
    });
    expect(lines(printed)).toEqual([
      "JSON RPC request",
      "id: x-001",
      "Method: add-module",
      'module: "module M endmodule []"',
      "name-as-id: true",
    ]);
  });
});

describe("rpcPrint on an execute response", () => {
  /** pyk's five halt reasons, and what each one's header block must say. */
  const cases = [
    ["imp-execute-depth-bound-response.json", "depth-bound", false, 0],
    ["imp-execute-stuck-response.json", "stuck", false, 0],
    ["imp-execute-branching-response.json", "branching", false, 2],
    ["imp-execute-terminal-rule-response.json", "terminal-rule", true, 0],
    ["imp-execute-cut-point-rule-response.json", "cut-point-rule", true, 1],
  ] as const;

  for (const [file, reason, hasRule, nextStates] of cases) {
    test(`${reason}: the header block is pyk's`, () => {
      const document = pykRpc("print", file);
      const result = resultOf(document);
      const printed = rpcPrint(document);
      const all = lines(printed);

      expect(all[0]).toBe("JSON RPC Response");
      expect(all[1]).toBe(`id: ${JSON.stringify(document["id"])}`);
      expect(all[2]).toBe("Method: execute");
      expect(all[3]).toBe(`Depth: ${JSON.stringify(result["depth"])}`);
      expect(all[4]).toBe(`Stop reason: ${reason}`);
      // `Stop rule:` exists for exactly two of the eight reasons, and when it
      // does it sits between the reason and the count.
      const countLine = `Number of next states: ${String(nextStates)}`;
      expect(all[5] ?? "").toBe(hasRule ? `Stop rule: ${jsonString(result, "rule")}` : countLine);
      expect(all[hasRule ? 6 : 5]).toBe(countLine);
      for (let index = 0; index < nextStates; index += 1) {
        expect(printed).toContain(`Next state #${String(index)}:`);
      }
    });

    test(`${reason}: every term it renders re-parses to the state it came from`, () => {
      const document = pykRpc("print", file);
      const result = decodeExecuteResult(resultOf(document));
      const printed = rpcPrint(document);

      // A *response*'s state is combined — term ∧ substitution ∧ predicate.
      expectRendersAs(section(printed, "State:"), stateKore(result.state));

      const next = result.reason === "branching" || result.reason === "cut-point-rule" ? result.nextStates : [];
      next.forEach((state, index) => {
        expectRendersAs(section(printed, `Next state #${String(index)}:`), stateKore(state));
      });
    });
  }
});

describe("rpcPrint on the other response shapes", () => {
  test("simplify", () => {
    const document = pykRpc("print", "imp-simplify-response.json");
    const printed = rpcPrint(document);
    expect(lines(printed)[2]).toBe("Method: simplify");
    expectRendersAs(section(printed, "State:"), decodeKoreJson(resultOf(document)["state"]).term);
  });

  test("add-module prints the module text verbatim, because it is not KORE-JSON", () => {
    const printed = rpcPrint({ jsonrpc: "2.0", id: 1, result: { module: "m1234" } });
    expect(lines(printed)).toEqual(["JSON RPC Response", "id: 1", "Method: add-module", "Module:", "m1234"]);
  });

  test("implies — a shape pyk crashes on (deviation 4)", () => {
    const document = serverGolden("implies", "implied-substitution", "response.golden");
    const result = resultOf(document);
    const condition = jsonRecord(jsonMember(result, "condition", "result"), "condition");
    const printed = rpcPrint(document);
    expect(lines(printed)[2]).toBe("Method: implies");
    expect(printed).toContain("Status: valid");
    expectRendersAs(section(printed, "Implication:"), decodeKoreJson(result["implication"]).term);
    expectRendersAs(section(printed, "Condition substitution:"), decodeKoreJson(condition["substitution"]).term);
    expectRendersAs(section(printed, "Condition predicate:"), decodeKoreJson(condition["predicate"]).term);
  });

  test("get-model — the other shape pyk crashes on", () => {
    const document = serverGolden("get-model", "satisfiable", "response.golden");
    const printed = rpcPrint(document);
    expect(lines(printed)[2]).toBe("Method: get-model");
    expect(printed).toContain("Satisfiable: Sat");
    expectRendersAs(section(printed, "Substitution:"), decodeKoreJson(resultOf(document)["substitution"]).term);
  });

  test("an Unsat model has no substitution to print", () => {
    const printed = rpcPrint({ jsonrpc: "2.0", id: 1, result: { satisfiable: "Unsat" } });
    expect(lines(printed)).toEqual(["JSON RPC Response", "id: 1", "Method: get-model", "Satisfiable: Unsat"]);
  });

  test("an error response is reported rather than called 'neither'", () => {
    const printed = rpcPrint({
      jsonrpc: "2.0",
      id: "x-001",
      error: { code: 3, message: "Could not find module", data: "FOO" },
    });
    expect(lines(printed)).toEqual([
      "JSON RPC Response",
      "id: x-001",
      "Error: 3 Could not find module",
      "Data:",
      '"FOO"',
    ]);
  });

  test("a simplify response carrying haskell log entries is still a simplify response", () => {
    // pyk's `list(result.keys()) == ['state']` test misreads this one as an
    // execute response and dies; dispatch here is on the discriminating member.
    const document = pykRpc("print", "imp-simplify-response.json");
    const printed = rpcPrint({
      jsonrpc: "2.0",
      id: 1,
      result: { ...resultOf(document), "haskell-log-entries": [] },
    });
    expect(lines(printed)[2]).toBe("Method: simplify");
  });
});

describe("rpcPrint failures", () => {
  test("a document that is neither a request nor a response says so", () => {
    expect(() => rpcPrint({ jsonrpc: "2.0", id: 1 })).toThrow("neither a request nor a response");
  });

  test("a result whose method cannot be told lists what it saw", () => {
    expect(() => rpcPrint({ jsonrpc: "2.0", id: 1, result: { frobnicate: 1 } })).toThrow("frobnicate");
  });

  test("a non-object input is rejected", () => {
    expect(() => rpcPrint([1, 2, 3])).toThrow("the input document");
  });
});
