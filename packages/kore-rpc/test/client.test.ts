/**
 * The client suite — `KoreClient` against a scriptable TCP mock, over real
 * loopback sockets.
 *
 * Wherever a real recording exists it is used. The vendored
 * `fixtures/kore-rpc-server/` corpus stores each case as its *pieces* —
 * `params.json` plus `state.json` for the request, `response.golden` for the
 * reply — and `fixtures/PROVENANCE.md:125-141` documents how `runTests.py`
 * reassembles a request from them:
 *
 * ```
 * {"jsonrpc":"2.0","id":1,"method":"execute","params":{…params.json, "state": …state.json}}
 * ```
 *
 * So the strongest assertion this suite can make is the round trip: give the
 * client the same typed arguments, and the request the mock receives must have
 * the same `params` object the fixture reconstructs — with the *id* being the
 * one thing that legitimately differs, since the corpus uses the literal `1`
 * and this client mints `"<prefix>-NNN"` strings. The goldens are replayed with
 * their id rewritten to the client's, which is exactly and only that
 * difference.
 *
 * Two things are deliberately *not* here. Byte-exact golden comparison of
 * responses is `golden.test.ts`'s job (a codec concern; this suite decodes and
 * asserts on values). And the `cancel` exchange has no upstream fixture at all
 * — the hand-authored `test/data/cancel-exchange.json` covers it, with its
 * derivation recorded in `test/data/README.md`.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import { type JsonValue, type KoreJson, decodeKoreJson, encodeKoreJsonValue } from "@kframework-ts/kore";
import {
  type ExecuteOptions,
  type Transport,
  DefaultError,
  KoreClient,
  ResponseIdMismatchError,
  UnknownModuleError,
  isCancelledError,
  isKoreRpcError,
  tcpTransport,
} from "../src/index.ts";
import { defined, jsonRecord, jsonString, parseJsonRecord, rejection } from "./helpers/assert.ts";
import {
  type MockServerOptions,
  type MockStep,
  MockServer,
  cancelNotSupportedResponse,
  cancelledResponse,
} from "./helpers/mock-server.ts";

//////////////////////////
// Fixture plumbing     //
//////////////////////////

const FIXTURES = join(import.meta.dir, "..", "fixtures");
const DATA = join(import.meta.dir, "data");

function readText(...segments: readonly string[]): string {
  return readFileSync(join(FIXTURES, ...segments), "utf8");
}

function readJson(...segments: readonly string[]): Record<string, JsonValue> {
  return parseJsonRecord(readText(...segments), segments.join("/"));
}

/** The hand-authored cancel exchange — see `test/data/README.md`. */
const CANCEL = parseJsonRecord(readFileSync(join(DATA, "cancel-exchange.json"), "utf8"), "cancel-exchange.json");

/**
 * Replay a vendored golden under the id the client actually sent.
 *
 * The corpus's requests all carry `id: 1` (`runTests.py:44-50`); nothing else
 * about the response is touched, and the assertion that the *rest* of it
 * decodes correctly is the point.
 */
function replay(golden: string, id: string): string {
  return JSON.stringify({ ...parseJsonRecord(golden, "golden"), id });
}

/**
 * A fixture state as the client will re-emit it.
 *
 * `@kframework-ts/kore` normalizes KORE-JSON's binary `\and`/`\or`/`\implies`
 * encoding (`first`/`second`) into the n-ary one (`patterns`) on the way in and
 * emits the n-ary form on the way out, so a fixture written in the binary form
 * — `simplify/and-simplify/state.json` and `get-model/satisfiable/state.json`
 * both are — does not come back byte-identical. The round trip through the
 * codec is the right expectation for "the client sent the state it was given":
 * it is the same *term*, spelled the way this package spells it.
 */
function canonicalState(json: Record<string, JsonValue>): JsonValue {
  return encodeKoreJsonValue(decodeKoreJson(json).term);
}

/** A step that answers whatever it is asked with `golden`, id rewritten. */
function replayStep(golden: string, extra: Partial<MockStep> = {}): MockStep {
  return {
    respond: (request) => replay(golden, jsonString(jsonRecord(request, "request"), "id")),
    ...extra,
  };
}

//////////////////////////
// Server lifecycle     //
//////////////////////////

const running: MockServer[] = [];
const openClients: KoreClient[] = [];

afterEach(async () => {
  for (const client of openClients.splice(0)) client.close();
  for (const server of running.splice(0)) await server.close();
});

/** A mock server plus a client wired to it, both torn down after the test. */
async function connected(
  script: readonly MockStep[],
  options: { label?: string } = {},
  serverOptions: MockServerOptions = {},
): Promise<{ server: MockServer; client: KoreClient }> {
  const server = await MockServer.start(script, serverOptions);
  running.push(server);
  const client = new KoreClient(await tcpTransport("127.0.0.1", server.port), options);
  openClients.push(client);
  return { server, client };
}

//////////////////////////
// Request ids          //
//////////////////////////

describe("request ids", () => {
  test("are `<label>-NNN`, counting from 1", async () => {
    // pyk `rpc.py:356-360`: `f'{prefix}-{self._req_id:03}'`, `_req_id` starting
    // at 1. The label is the prefix when one is given (`rpc.py:354-355`).
    const golden = readText("kore-rpc-server", "simplify", "and-simplify", "response.golden");
    const state = decodeKoreJson(readJson("kore-rpc-server", "simplify", "and-simplify", "state.json"));
    const { server, client } = await connected([replayStep(golden), replayStep(golden)], { label: "proof-1" });

    expect(client.lastRequestId).toBeUndefined();

    await client.simplify(state);
    expect(client.lastRequestId).toBe("proof-1-001");

    await client.simplify(state);
    expect(client.lastRequestId).toBe("proof-1-002");

    expect(server.received.map((request) => request["id"])).toEqual(["proof-1-001", "proof-1-002"]);
  });

  test("get a unique generated prefix when no label is given", async () => {
    const golden = readText("kore-rpc-server", "simplify", "and-simplify", "response.golden");
    const state = decodeKoreJson(readJson("kore-rpc-server", "simplify", "and-simplify", "state.json"));

    const first = await connected([replayStep(golden)]);
    const second = await connected([replayStep(golden)]);
    await first.client.simplify(state);
    await second.client.simplify(state);

    expect(first.client.lastRequestId).toMatch(/-001$/u);
    expect(second.client.lastRequestId).toMatch(/-001$/u);
    expect(first.client.lastRequestId).not.toBe(second.client.lastRequestId);
  });
});

//////////////////////////
// The five methods     //
//////////////////////////

describe("execute", () => {
  test("builds the request the fixture reconstructs, and decodes a branching result", async () => {
    const params = readJson("kore-rpc-server", "execute", "branching", "params.json");
    const stateJson = readJson("kore-rpc-server", "execute", "branching", "state.json");
    const golden = readText("kore-rpc-server", "execute", "branching", "response.golden");

    const { server, client } = await connected([replayStep(golden)]);
    const result = await client.execute(decodeKoreJson(stateJson));

    // `params.json` is `{}` for this case, so the reconstructed params are the
    // state alone — which is also the only mandatory field.
    expect(server.received[0]?.["method"]).toBe("execute");
    expect(server.received[0]?.["params"]).toEqual({ ...params, state: canonicalState(stateJson) });

    expect(result.reason).toBe("branching");
    if (result.reason !== "branching") throw new Error("unreachable");
    expect(result.depth).toBe(0);
    expect(result.nextStates).toHaveLength(2);
    // The second branch is the one carrying a substitution — see
    // `substitution.test.ts`, which decodes it.
    expect(result.nextStates[1]?.substitution).toBeDefined();
  });

  test("carries every option through, kebab-cased, as the fixture's params", async () => {
    // `execute/cut-point` is the corpus's multi-parameter case: `max-depth` and
    // `cut-point-rules` together.
    const params = readJson("kore-rpc-server", "execute", "cut-point", "params.json");
    const stateJson = readJson("kore-rpc-server", "execute", "cut-point", "state.json");
    const golden = readText("kore-rpc-server", "execute", "cut-point", "response.golden");

    const { server, client } = await connected([replayStep(golden)]);
    const options: ExecuteOptions = { maxDepth: 3, cutPointRules: ["TEST.DE", "TEST.AB"] };
    const result = await client.execute(decodeKoreJson(stateJson), options);

    expect(server.received[0]?.["params"]).toEqual({ ...params, state: canonicalState(stateJson) });

    expect(result.reason).toBe("cut-point-rule");
    if (result.reason !== "cut-point-rule") throw new Error("unreachable");
    expect(result.rule).toBe("TEST.DE");
    expect(result.nextStates.length).toBeGreaterThan(0);
  });
});

describe("implies", () => {
  test("sends `assume-defined: false` by default, and keeps the tri-state status", async () => {
    // pyk's signature is `assume_defined: bool = False` (`rpc.py:1144`), and
    // `False` survives `filter_none`, so every implies request pyk has ever
    // sent carries the field. Matching that is what makes our traffic
    // comparable with theirs.
    const antecedent = decodeKoreJson(
      readJson("kore-rpc-server", "implies", "implied-substitution", "antecedent.json"),
    );
    const consequent = decodeKoreJson(
      readJson("kore-rpc-server", "implies", "implied-substitution", "consequent.json"),
    );
    const golden = readText("kore-rpc-server", "implies", "implied-substitution", "response.golden");

    const { server, client } = await connected([replayStep(golden)]);
    const result = await client.implies(antecedent, consequent);

    const sent = jsonRecord(defined(server.received[0], "the request")["params"], "params");
    expect(sent["assume-defined"]).toBe(false);
    expect(Object.hasOwn(sent, "antecedent")).toBe(true);
    expect(Object.hasOwn(sent, "consequent")).toBe(true);

    expect(result.status).toBe("valid");
    expect(result.condition).toBeDefined();
  });

  test("omits `assume-defined` when it is explicitly undefined", async () => {
    const antecedent = decodeKoreJson(readJson("kore-rpc-server", "implies", "implied-trivial", "antecedent.json"));
    const consequent = decodeKoreJson(readJson("kore-rpc-server", "implies", "implied-trivial", "consequent.json"));
    const golden = readText("kore-rpc-server", "implies", "implied-trivial", "response.golden");

    const { server, client } = await connected([replayStep(golden)]);
    await client.implies(antecedent, consequent, { assumeDefined: undefined });

    const sent = jsonRecord(defined(server.received[0], "the request")["params"], "params");
    expect(Object.hasOwn(sent, "assume-defined")).toBe(false);
  });
});

describe("simplify", () => {
  test("round-trips the fixture pair", async () => {
    const stateJson = readJson("kore-rpc-server", "simplify", "and-simplify", "state.json");
    const golden = readText("kore-rpc-server", "simplify", "and-simplify", "response.golden");

    const { server, client } = await connected([replayStep(golden)]);
    const result = await client.simplify(decodeKoreJson(stateJson));

    expect(server.received[0]?.["params"]).toEqual({ state: canonicalState(stateJson) });
    // `runTests.py:211-221` builds simplify's params as `{"state": …}` alone.
    expect(result.state.term.tag).toBe("Not");
    expect(result.logs).toBeUndefined();
  });
});

describe("get-model", () => {
  test("decodes a satisfiable model with its substitution", async () => {
    const stateJson = readJson("kore-rpc-server", "get-model", "satisfiable", "state.json");
    const golden = readText("kore-rpc-server", "get-model", "satisfiable", "response.golden");

    const { server, client } = await connected([replayStep(golden)]);
    const result = await client.getModel(decodeKoreJson(stateJson));

    expect(server.received[0]?.["params"]).toEqual({ state: canonicalState(stateJson) });
    expect(result.satisfiable).toBe("Sat");
    if (result.satisfiable !== "Sat") throw new Error("unreachable");
    expect(result.substitution).toBeDefined();
  });

  test("decodes an unsatisfiable model", async () => {
    const stateJson = readJson("kore-rpc-server", "get-model", "not-satisfiable", "state.json");
    const golden = readText("kore-rpc-server", "get-model", "not-satisfiable", "response.golden");

    const { client } = await connected([replayStep(golden)]);
    expect((await client.getModel(decodeKoreJson(stateJson))).satisfiable).toBe("Unsat");
  });
});

describe("add-module", () => {
  test("returns the module id, and `addModuleResult` the whole record", async () => {
    // `"m" + sha256(moduleText)`, the law pinned by pyk's integration suite
    // (`tests/integration/kore/test_kore_client.py:923,947`) — here it is the
    // id the vendored golden actually came back with.
    const params = readJson("kore-rpc-server", "add-module", "add", "params.json");
    const golden = readText("kore-rpc-server", "add-module", "add", "response.golden");
    const moduleText = jsonString(params, "module");
    const expectedId = jsonString(jsonRecord(parseJsonRecord(golden, "golden")["result"], "result"), "module");

    const { server, client } = await connected([replayStep(golden), replayStep(golden)]);

    expect(await client.addModule(moduleText, { nameAsId: params["name-as-id"] === true })).toBe(expectedId);
    expect(server.received[0]?.["params"]).toEqual(params);

    const record = await client.addModuleResult(moduleText);
    expect(record.module).toBe(expectedId);
    expect(record.haskellLogEntries).toBeUndefined();
  });
});

//////////////////////////
// Failures             //
//////////////////////////

describe("error mapping", () => {
  test("maps a code-3 error to UnknownModuleError", async () => {
    // The vendored `add-module/execute/response-fail.golden`:
    // `{"code":3,"data":"NEW","message":"Could not find module"}`.
    const golden = readText("kore-rpc-server", "add-module", "execute", "response-fail.golden");
    const stateJson = readJson("kore-rpc-server", "add-module", "execute", "state.json");

    const { client } = await connected([replayStep(golden)]);

    const failure = await rejection(client.execute(decodeKoreJson(stateJson), { module: "NEW" }));

    expect(failure).toBeInstanceOf(UnknownModuleError);
    expect(isKoreRpcError(failure)).toBe(true);
    if (!(failure instanceof UnknownModuleError)) throw failure;
    expect(failure.code).toBe(3);
    expect(failure.moduleName).toBe("NEW");
    expect(failure.message).toBe("Could not find module: NEW");
  });

  test("maps a negative code to DefaultError, payload included", async () => {
    // `execute/invalid-params/state.json` is the bare string `"aaaa"` — the
    // point of that fixture is a state the *server* rejects, so it is not a
    // KORE-JSON document and cannot be sent through a typed client. The
    // response is what is under test; the request is any valid one.
    const golden = readText("kore-rpc-server", "execute", "invalid-params", "response.golden");
    const stateJson = readJson("kore-rpc-server", "execute", "branching", "state.json");

    const { client } = await connected([replayStep(golden)]);
    const failure = await rejection(client.execute(decodeKoreJson(stateJson)));

    expect(failure).toBeInstanceOf(DefaultError);
    if (!(failure instanceof DefaultError)) throw failure;
    expect(failure.code).toBe(-32602);
  });

  test("throws ResponseIdMismatchError when the echo is wrong", async () => {
    // pyk asserts here (`rpc.py:389`) — an assert that `python -O` deletes. On
    // a single-flight connection a wrong echo means the stream desynchronized.
    const stateJson = readJson("kore-rpc-server", "simplify", "and-simplify", "state.json");
    const golden = readText("kore-rpc-server", "simplify", "and-simplify", "response.golden");

    const { client } = await connected([{ respond: replay(golden, "someone-elses-001") }]);
    const failure = await rejection(client.simplify(decodeKoreJson(stateJson)));

    expect(failure).toBeInstanceOf(ResponseIdMismatchError);
    if (!(failure instanceof ResponseIdMismatchError)) throw failure;
    expect(failure.received).toBe("someone-elses-001");
    expect(failure.expected).toMatch(/-001$/u);
  });

  test("reports the error member ahead of an id mismatch", async () => {
    // A `-32700` comes back with `id: null` because the server never got far
    // enough to read one (the `smoke/` corpus has the only vendored example).
    // Checking the id first would hide the parse error behind a mismatch; pyk
    // checks in this order too (`rpc.py:386-390`).
    const stateJson = readJson("kore-rpc-server", "simplify", "and-simplify", "state.json");
    const { client } = await connected([
      { respond: '{"jsonrpc":"2.0","id":null,"error":{"code":-32700,"message":"Parse error"}}' },
    ]);

    const failure = await rejection(client.simplify(decodeKoreJson(stateJson)));

    expect(failure).toBeInstanceOf(DefaultError);
    if (!(failure instanceof DefaultError)) throw failure;
    expect(failure.code).toBe(-32700);
  });
});

//////////////////////////
// Cancel               //
//////////////////////////

describe("cancel", () => {
  test("rejects the pending call and leaves the connection usable", async () => {
    // The critical semantic (`Server.hs:112-134`): the cancel gets no reply,
    // the *interrupted* request is answered with -32000, and the socket
    // survives — so the very next request on the same client works. A client
    // that treated -32000 as fatal, or a transport that tore the socket down,
    // would pass the first half of this test and fail the second.
    const stateJson = readJson("kore-rpc-server", "execute", "branching", "state.json");
    const simplifyState = readJson("kore-rpc-server", "simplify", "and-simplify", "state.json");
    const simplifyGolden = readText("kore-rpc-server", "simplify", "and-simplify", "response.golden");

    const { server, client } = await connected(
      [
        {
          respond: () => {
            throw new Error("the delayed step is only ever answered by its cancel");
          },
          delayMs: 5_000,
          onCancel: JSON.stringify(CANCEL["cancelled"]),
        },
        replayStep(simplifyGolden),
      ],
      { label: "proof-1" },
    );

    const pending = client.execute(decodeKoreJson(stateJson), { maxDepth: 1000 });
    await Bun.sleep(30);
    client.interrupt();

    const failure = await rejection(pending);

    expect(isKoreRpcError(failure)).toBe(true);
    if (!isKoreRpcError(failure)) throw failure;
    expect(isCancelledError(failure)).toBe(true);
    expect(failure.code).toBe(-32000);
    expect(failure.message).toContain("Request cancelled");

    // The connection survived: the next call goes through on the same socket.
    const result = await client.simplify(decodeKoreJson(simplifyState));
    expect(result.state.term.tag).toBe("Not");
    expect(client.lastRequestId).toBe("proof-1-002");
    server.check();
  });

  test("sends exactly the cancel notification pyk sends", async () => {
    // Shape from `rpc.py:342-353`, transcribed into
    // `test/data/cancel-exchange.json`; the id is the last request's with
    // `-cancel` appended, and the params are `{}`.
    const stateJson = readJson("kore-rpc-server", "execute", "branching", "state.json");
    const { server, client } = await connected(
      [
        // `cancelledResponse` builds `Server.hs:134`'s object directly; the
        // test above uses the hand-authored fixture's copy of the same thing,
        // so both spellings are exercised and are asserted to agree below.
        { respond: "", delayMs: 5_000, onCancel: cancelledResponse("proof-1-001") },
      ],
      { label: "proof-1" },
    );

    const pending = client.execute(decodeKoreJson(stateJson));
    await Bun.sleep(30);
    client.interrupt();
    await rejection(pending);

    const cancel = server.received.find((request) => request["method"] === "cancel");
    expect(cancel).toEqual(jsonRecord(CANCEL["cancel"], "the fixture's cancel"));
    // The two spellings of the -32000 answer agree.
    expect(parseJsonRecord(cancelledResponse("proof-1-001"), "cancelledResponse")).toEqual(
      jsonRecord(CANCEL["cancelled"], "the fixture's cancelled response"),
    );
  });

  test("a server that ANSWERS the cancel does not desynchronize the connection", async () => {
    // `kore-rpc-dev` (`dev-tools/kore-rpc-dev/Server.hs:113`) and the booster
    // proxy (`Proxy.hs:340`) reply `-32601 Cancel not supported`, addressed to
    // the *cancel's* id, and then answer the interrupted request as usual. Two
    // lines arrive for one pending call. Handing the first of them to that call
    // makes every later response one off forever; the transport absorbs it
    // instead (`transport.ts`, deviation 5).
    const stateJson = readJson("kore-rpc-server", "execute", "branching", "state.json");
    const simplifyState = readJson("kore-rpc-server", "simplify", "and-simplify", "state.json");
    const simplifyGolden = readText("kore-rpc-server", "simplify", "and-simplify", "response.golden");

    const { server, client } = await connected(
      [
        {
          respond: () => {
            throw new Error("the delayed step is only ever answered by its cancel");
          },
          delayMs: 5_000,
          onCancel: cancelledResponse("proof-1-001"),
        },
        replayStep(simplifyGolden),
      ],
      { label: "proof-1" },
      { onStrayCancel: (cancel) => cancelNotSupportedResponse(cancel["id"]) },
    );

    const pending = client.execute(decodeKoreJson(stateJson), { maxDepth: 1000 });
    await Bun.sleep(30);
    client.interrupt();

    // The pending call gets the -32000 addressed to *it*, not the -32601
    // addressed to the cancel.
    const failure = await rejection(pending);
    expect(isKoreRpcError(failure)).toBe(true);
    if (!isKoreRpcError(failure)) throw failure;
    expect(failure.code).toBe(-32000);
    expect(isCancelledError(failure)).toBe(true);

    // And the next call is answered with its own id, not the previous one's.
    const result = await client.simplify(decodeKoreJson(simplifyState));
    expect(result.state.term.tag).toBe("Not");
    expect(client.lastRequestId).toBe("proof-1-002");
    server.check();
  });

  test("a cancel answered with nothing in flight leaves the next request working", async () => {
    const simplifyState = readJson("kore-rpc-server", "simplify", "and-simplify", "state.json");
    const simplifyGolden = readText("kore-rpc-server", "simplify", "and-simplify", "response.golden");

    const { server, client } = await connected(
      [replayStep(simplifyGolden)],
      { label: "proof-1" },
      { onStrayCancel: (cancel) => cancelNotSupportedResponse(cancel["id"]) },
    );

    // Nothing pending: the -32601 arrives at a transport with no request in
    // flight and must not poison the next request.
    client.interrupt();
    await Bun.sleep(30);

    const result = await client.simplify(decodeKoreJson(simplifyState));
    expect(result.state.term.tag).toBe("Not");
    server.check();
  });

  test("uses the bare `cancel` id before any request has been sent", () => {
    // `f'{self._last_request_id}-cancel' if … else 'cancel'` (`rpc.py:346`).
    const sent: string[] = [];
    const client = new KoreClient({
      request: () => Promise.reject(new Error("not used")),
      interrupt: (payload) => {
        sent.push(payload);
      },
      close: () => {},
    } satisfies Transport);

    client.interrupt();
    expect(parseJsonRecord(defined(sent[0], "the cancel payload"), "cancel")).toEqual({
      jsonrpc: "2.0",
      id: "cancel",
      method: "cancel",
      params: {},
    });
  });
});

//////////////////////////
// The transport seam   //
//////////////////////////

describe("the transport seam", () => {
  test("close delegates, and every method goes through `request`", async () => {
    // The whole client is testable with no socket at all, which is the point of
    // injecting the transport rather than baking in a host and a port.
    const sent: string[] = [];
    let closed = 0;
    const golden = readText("kore-rpc-server", "simplify", "and-simplify", "response.golden");

    const client = new KoreClient(
      {
        request: (payload) => {
          sent.push(payload);
          return Promise.resolve(replay(golden, jsonString(parseJsonRecord(payload, "request"), "id")));
        },
        interrupt: () => {},
        close: () => {
          closed += 1;
        },
      } satisfies Transport,
      { label: "inline" },
    );

    const state: KoreJson = decodeKoreJson(readJson("kore-rpc-server", "simplify", "and-simplify", "state.json"));
    await client.simplify(state);
    client.close();

    expect(sent).toHaveLength(1);
    expect(parseJsonRecord(defined(sent[0], "the request"), "request")).toMatchObject({
      jsonrpc: "2.0",
      id: "inline-001",
      method: "simplify",
    });
    expect(closed).toBe(1);
  });
});
