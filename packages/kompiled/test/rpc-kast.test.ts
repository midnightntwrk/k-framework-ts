/**
 * The `pyk-rpc-kast/` corpus — five JSON-RPC files vendored from
 * `pyk/src/tests/integration/test-data/`, and the one upstream test that uses
 * them, ported whole.
 *
 * # What `pyk rpc-kast` is
 *
 * `exec_rpc_kast` (`pyk/src/pyk/__main__.py:218-237`) turns an `execute`
 * *response* back into a request, by copying every non-`state` parameter from a
 * *reference* request and replacing `state` with the response's own:
 *
 * ```py
 * execute_result = ExecuteResult.from_dict(input_dict['result'])
 * non_state_keys = set(reference_request['params'].keys()).difference(['state'])
 * request_params = {key: reference_request['params'][key] for key in non_state_keys}
 * request_params['state'] = {'format': 'KORE', 'version': 1, 'term': execute_result.state.kore.dict}
 * ```
 *
 * `fixtures/PROVENANCE.md:257` records the corpus as "RPC KAST surgery — needs
 * no definition", and that is exactly right: there is no kompiled directory in
 * the pipeline, no symbol table, and no KAST at all despite the command's name.
 * The only algebra is `kore_term(...)` in and `Pattern.dict` out.  Both halves
 * are `@kframework-ts/kore`'s `decodeKoreJson` / `encodeKoreJsonValue`, so
 * `TestRpcKast` (`test_pyk.py:147-188`) ports **completely** — not as a
 * structural stand-in, and not gated on a future package.  Its two rows are
 * below, with upstream's own assertion (`json.loads` on both sides, i.e.
 * structural equality, key order irrelevant).
 *
 * # Why the corpus is duplicated
 *
 * Three of the five files are byte-identical to their `pyk-rpc-print/`
 * namesakes.  Both copies are kept so each directory stays exactly what
 * upstream commits, and the sha256s in `fixtures/PROVENANCE.md` show the pairs
 * (`0a3d1a03…`, `95a48f63…`, `6136af04…`).  That duplication is asserted here,
 * because a future fixture refresh that touched only one copy would otherwise
 * be silent.
 */

import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { decodeKoreJson, encodeKoreJsonValue } from "@kframework-ts/kore";

import { UPSTREAM } from "./fixtures.ts";

const CORPUS = join(UPSTREAM, "pyk-rpc-kast");
const PRINT_CORPUS = join(UPSTREAM, "pyk-rpc-print");

const read = (dir: string, name: string): unknown => JSON.parse(readFileSync(join(dir, name), "utf8")) as unknown;

/** A plain JSON object, which is all this file walks into. */
type Dict = Record<string, unknown>;

function asDict(value: unknown, what: string): Dict {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(`${what} is not a JSON object`);
  }
  // The guard establishes it is a non-array object; TypeScript has no way to
  // say "an object, indexed by string" without an assertion.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  return value as Dict;
}

/**
 * `exec_rpc_kast` (`__main__.py:218-237`), transcribed.
 *
 * `ExecuteResult.from_dict(...).state.kore` is `kore_term(state['term'])` for
 * every message in this corpus: `State.kore` (`kore/rpc.py:589-595`) only
 * conjoins a `substitution` or a `predicate` onto the term when the response
 * carries one, and none of these do — which the test below asserts rather than
 * assumes, because that assumption is the whole of the difference between this
 * transcription and upstream's.
 */
function rpcKast(referenceRequest: unknown, response: unknown): Dict {
  const reference = asDict(referenceRequest, "reference request");
  const referenceParams = asDict(reference["params"], "reference request params");
  const result = asDict(asDict(response, "response")["result"], "response result");
  const state = asDict(result["state"], "response result state");

  const params: Dict = {};
  for (const [key, value] of Object.entries(referenceParams)) {
    if (key !== "state") params[key] = value;
  }
  params["state"] = encodeKoreJsonValue(decodeKoreJson(state["term"]).term);

  return {
    jsonrpc: reference["jsonrpc"],
    id: reference["id"],
    method: reference["method"],
    params,
  };
}

/** `TestRpcKast.TEST_DATA` (`test_pyk.py:148-151`), verbatim. */
const ROWS = [
  ["imp-execute-request", "imp-execute-depth-bound-response", "imp-execute-request-from-execute-response"],
  ["imp-simplify-request", "imp-execute-depth-bound-response", "imp-simplify-request-from-execute-response"],
] as const;

describe("the corpus is intact", () => {
  test("5 files — 3 messages, 2 goldens — exactly as upstream commits them", () => {
    const files = readdirSync(CORPUS).toSorted();
    expect(files.length).toBe(5);
    expect(files.filter((f) => f.endsWith(".json.golden")).length).toBe(2);
    expect(files.filter((f) => f.endsWith(".json")).length).toBe(3);
  });

  test("the three files shared with pyk-rpc-print/ are byte-identical in both copies", () => {
    for (const name of [
      "imp-execute-request.json",
      "imp-simplify-request.json",
      "imp-execute-depth-bound-response.json",
    ]) {
      expect(readFileSync(join(CORPUS, name))).toEqual(readFileSync(join(PRINT_CORPUS, name)));
    }
  });
});

describe("pyk rpc-kast, ported whole (`test_pyk.py:147-188`)", () => {
  for (const [reference, input, output] of ROWS) {
    test(`${reference} + ${input} → ${output}`, () => {
      const actual = rpcKast(read(CORPUS, `${reference}.json`), read(CORPUS, `${input}.json`));
      // Upstream compares `json.loads(...)` on both sides — structure, not
      // bytes, so key order is irrelevant on both.
      expect(actual).toEqual(asDict(read(CORPUS, `${output}.json.golden`), "golden"));
    });
  }

  test("the response's state carries a term and nothing else, which is what makes State.kore the term", () => {
    // `State.kore` conjoins `substitution` and `predicate` onto `term` when they
    // are present (`kore/rpc.py:589-595`).  Neither is, here — so the
    // transcription above may read `state['term']` directly.  If a future
    // fixture grew one, this fails before the goldens do.
    const result = asDict(
      asDict(read(CORPUS, "imp-execute-depth-bound-response.json"), "response")["result"],
      "result",
    );
    expect(Object.keys(asDict(result["state"], "state"))).toEqual(["term"]);
  });

  test("the surgery is exactly: keep every non-state parameter, replace state", () => {
    // Stated as an invariant rather than read out of the goldens, so the
    // *shape* of `exec_rpc_kast` is pinned and not just its two outputs.
    for (const [reference, , output] of ROWS) {
      const referenceParams = asDict(asDict(read(CORPUS, `${reference}.json`), "ref")["params"], "ref params");
      const goldenParams = asDict(asDict(read(CORPUS, `${output}.json.golden`), "golden")["params"], "golden params");
      expect(Object.keys(goldenParams).toSorted()).toEqual(Object.keys(referenceParams).toSorted());
      for (const key of Object.keys(referenceParams)) {
        if (key !== "state") expect(goldenParams[key]).toEqual(referenceParams[key]);
      }
      expect(goldenParams["state"]).not.toEqual(referenceParams["state"]);
    }
  });
});

describe("the KORE-JSON codec is the whole of the algebra", () => {
  test("the response's state round-trips through decode/encode unchanged", () => {
    // The step `exec_rpc_kast` performs is `kore_term(...)` then `.dict`, so a
    // codec that were lossy anywhere in this term would show up as a golden
    // mismatch above.  Asserted directly too, because "the codec is exact on
    // this term" is the more useful failure message of the two.
    const result = asDict(
      asDict(read(CORPUS, "imp-execute-depth-bound-response.json"), "response")["result"],
      "result",
    );
    const state = asDict(result["state"], "state");
    expect(state["term"]).toEqual(encodeKoreJsonValue(decodeKoreJson(state["term"]).term));
  });

  test("the two request fixtures' own states are valid KORE-JSON too", () => {
    for (const stem of ["imp-execute-request", "imp-simplify-request"]) {
      const params = asDict(asDict(read(CORPUS, `${stem}.json`), stem)["params"], `${stem}.params`);
      expect(decodeKoreJson(params["state"]).term.tag).toBe("App");
    }
  });
});
