/**
 * {@link KoreClient} — the five payload methods as five async methods, over an
 * injected {@link Transport}.
 *
 * Transcribed from pyk's `JsonRpcClient` (`k/pyk/src/pyk/kore/rpc.py:293-399`,
 * the id discipline and the response checks) and `KoreClient`
 * (`rpc.py:1024-1215`, the per-method wrappers and the error wrapping). Every
 * byte this class puts on the wire is built by `codec.ts`; every byte it reads
 * is read by `codec.ts` and `errors.ts`. What is left over — and what this
 * module is — is exactly the bookkeeping those two deliberately refuse to do:
 * *which* id this response should have carried, and *which* method's result
 * decoder to hand the `result` member to.
 *
 * # The transport is injected
 *
 * pyk's client owns a host and a port and builds its own socket
 * (`rpc.py:308-314`). This one takes a {@link Transport}, so the same client
 * drives a real TCP connection, a mock server in a test, or a bridge in a
 * runtime with no `node:net` at all. `tcpTransport(host, port)` is the real
 * one:
 *
 * ```ts
 * const client = new KoreClient(await tcpTransport("localhost", 41011));
 * try {
 *   const result = await client.execute(koreJson(pattern), { maxDepth: 100 });
 * } finally {
 *   client.close();
 * }
 * ```
 *
 * # Requests go out with `JSON.stringify`
 *
 * Not with `keyorder.ts`'s byte-exact emitter. Key order in a *request* is not
 * observable — the server decodes into a record and never compares bytes — and
 * pyk uses plain `json.dumps` (`rpc.py:365`), so a request built here is
 * already as comparable to pyk's traffic as it can be. `emitOrdered` exists for
 * the *response* side, where a vendored golden pins the bytes; spending it on
 * requests would buy nothing and cost a full re-serialization of a
 * multi-megabyte state.
 *
 * # Deliberate non-features
 *
 * - **No request timeout.** The protocol has none, and a timeout that merely
 *   abandons a promise leaves the server computing and the socket
 *   unsynchronized. Race the promise yourself and call {@link
 *   KoreClient.interrupt} on expiry — pyk's own pattern, and the reason
 *   `interrupt` is a public method rather than an internal detail.
 * - **No reconnection.** A kore-rpc connection is *stateful*: every module
 *   filed with `add-module` lives in that server's session, and every later
 *   `execute` naming it depends on it. A transport that silently reconnected
 *   would hand back a connection whose module table is empty, and the failure
 *   would surface much later as a `Could not find module` from a module the
 *   caller knows it added. Reconnection is the caller's decision because
 *   replaying the `add-module` calls is the caller's job.
 * - **No batching.** The server supports batch requests and rejects a `cancel`
 *   inside one (`-32001`, `Error.hs:36`); pyk never batches, no consumer
 *   batches, and a batch on a single-worker connection buys no parallelism.
 * - **No `dispatch` routing.** pyk's `JsonRpcClientFacade` can send different
 *   methods to different servers; both real consumers pass `None`.
 * - **No malformed-request asserts.** pyk raises `AssertionError` on four
 *   error codes it treats as "we built a bad request": `-32700`/`-32600`
 *   (`assert … , 'Malformed JSON-RPC request'`, `rpc.py:398`) and
 *   `-32601`/`-32602` (`'Malformed Kore-RPC request'`, `rpc.py:1075`). Neither
 *   is transcribed, for two reasons. They are `assert`s, so `python -O` deletes
 *   them and pyk's own behaviour on those codes is build-dependent; and what
 *   they replace a typed error with is a bare `AssertionError` carrying a
 *   string. Here all four decode to a {@link errors!DefaultError} with the
 *   server's code, message and `data` intact — strictly more information, and
 *   `error.code === -32601` is the same test one line shorter.
 */

import type { JsonValue, KoreJson } from "@kframework-ts/kore";
import {
  type ImpliesOptions,
  decodeAddModuleResult,
  decodeExecuteResult,
  decodeGetModelResult,
  decodeImpliesResult,
  decodeResponse,
  decodeSimplifyResult,
  encodeRequest,
  impliesParams,
} from "./codec.js";
import { koreRpcError } from "./errors.js";
import type { Transport } from "./transport.js";
import {
  type AddModuleParams,
  type AddModuleResult,
  type ExecuteParams,
  type ExecuteResult,
  type GetModelParams,
  type GetModelResult,
  type ImpliesResult,
  type KoreRpcRequest,
  type RequestId,
  type SimplifyParams,
  type SimplifyResult,
  CANCEL_METHOD,
} from "./types.js";

//////////////////////
// Option aliases   //
//////////////////////

/** Everything {@link KoreClient.execute} takes besides the state. */
export type ExecuteOptions = Omit<ExecuteParams, "state">;

/** Everything {@link KoreClient.simplify} takes besides the state. */
export type SimplifyOptions = Omit<SimplifyParams, "state">;

/** Everything {@link KoreClient.getModel} takes besides the state. */
export type GetModelOptions = Omit<GetModelParams, "state">;

/** Everything {@link KoreClient.addModule} takes besides the module text. */
export type AddModuleOptions = Omit<AddModuleParams, "module">;

export type { ImpliesOptions };

/** Options for {@link KoreClient}. */
export interface KoreClientOptions {
  /**
   * The prefix every request id gets — pyk's `client_label` ContextVar
   * (`rpc.py:49`, read at `rpc.py:354-355`).
   *
   * Its purpose is server-side: booster writes a `{request: …}` context onto
   * every line of `kore.jsonl`, so a label naming the proof or claim being
   * discharged makes the server's own log self-identifying. Omitted, the
   * client seeds a short unique prefix of its own — pyk uses `id(self)`, the
   * object's address, for exactly the same "unique per live client" property.
   *
   * An explicit option rather than an ambient `AsyncLocalStorage`: pyk needs
   * the ContextVar because its label is set once per proof and read by client
   * objects it does not own, and it documents that the value does *not*
   * propagate into thread pools. A per-client option has neither problem.
   */
  readonly label?: string;
}

//////////////////////
// Failures         //
//////////////////////

/**
 * A response whose `id` is not the one its request carried.
 *
 * pyk asserts (`rpc.py:389`), which vanishes under `python -O`. On a
 * single-flight connection this can only mean the stream has desynchronized —
 * a response has been attributed to the wrong request — so it is a hard error
 * and the connection should be considered unusable.
 */
export class ResponseIdMismatchError extends Error {
  override readonly name = "ResponseIdMismatchError";

  /** The id the request went out with. */
  readonly expected: RequestId;

  /** The id that came back. `null` when the response carried none. */
  readonly received: RequestId | null;

  constructor(expected: RequestId, received: RequestId | null) {
    super(
      `Expected the response to echo id ${JSON.stringify(expected)}, got ${
        received === null ? "null" : JSON.stringify(received)
      }`,
    );
    this.expected = expected;
    this.received = received;
  }
}

//////////////////////
// Request ids      //
//////////////////////

/** Distinguishes the default prefixes of two clients in one process. */
let clientSeq = 0;

/**
 * The default id prefix — pyk's `str(id(self))` (`rpc.py:355`).
 *
 * A process-local counter makes it unique among this process's clients; the
 * random tail makes it unique against another process's logs, which is what
 * the address in pyk's version accidentally provided.
 */
function defaultPrefix(): string {
  clientSeq += 1;
  return `kore-rpc-${clientSeq.toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

//////////////////////
// The client       //
//////////////////////

/**
 * A kore-rpc client: five methods, one connection, one request at a time.
 *
 * Read the module header for what this class deliberately does *not* do (no
 * timeout, no reconnection, no batching) — those are the decisions most likely
 * to be mistaken for omissions.
 */
export class KoreClient {
  private readonly transport: Transport;
  private readonly prefix: string;
  private counter = 1;
  private last: string | undefined;

  constructor(transport: Transport, options: KoreClientOptions = {}) {
    this.transport = transport;
    this.prefix = options.label ?? defaultPrefix();
  }

  /**
   * The id of the most recent request, or `undefined` before the first one —
   * pyk's `last_request_id` (`rpc.py:316-319`).
   *
   * Snapshot it right after a call to key per-request data (the server's log
   * lines, a bug-report directory) to that exact request. It is also what
   * {@link interrupt} builds its cancel id from.
   */
  get lastRequestId(): string | undefined {
    return this.last;
  }

  /** `execute` — pyk `KoreClient.execute` (`rpc.py:1099-1136`). */
  async execute(state: KoreJson, options: ExecuteOptions = {}): Promise<ExecuteResult> {
    return decodeExecuteResult(await this.send({ method: "execute", params: { ...options, state } }));
  }

  /**
   * `implies` — pyk `KoreClient.implies` (`rpc.py:1138-1160`).
   *
   * `assumeDefined` defaults to `false` and is therefore **sent**, matching
   * pyk byte for byte; pass `assumeDefined: undefined` to omit it instead. The
   * defaulting lives in `codec.ts`'s `impliesParams`, which this delegates to.
   */
  async implies(antecedent: KoreJson, consequent: KoreJson, options: ImpliesOptions = {}): Promise<ImpliesResult> {
    const params = impliesParams(antecedent, consequent, options);
    return decodeImpliesResult(await this.send({ method: "implies", params }));
  }

  /** `simplify` — pyk `KoreClient.simplify` (`rpc.py:1162-1181`). */
  async simplify(state: KoreJson, options: SimplifyOptions = {}): Promise<SimplifyResult> {
    return decodeSimplifyResult(await this.send({ method: "simplify", params: { ...options, state } }));
  }

  /**
   * `get-model` — pyk `KoreClient.get_model` (`rpc.py:1183-1196`).
   *
   * `boosterOnly` is offered here though pyk's signature has no such parameter;
   * `GetModelRequest` does have the field (`Types.hs:95`).
   */
  async getModel(state: KoreJson, options: GetModelOptions = {}): Promise<GetModelResult> {
    return decodeGetModelResult(await this.send({ method: "get-model", params: { ...options, state } }));
  }

  /**
   * `add-module`, returning the **module id** — pyk `KoreClient.add_module`
   * (`rpc.py:1198-1211`), which returns `result['module']` and drops the rest.
   *
   * That id is `"m" + sha256(moduleText)` unless `nameAsId` was set, a law
   * worth asserting in any consumer that caches modules
   * (`tests/integration/kore/test_kore_client.py:923,947`).
   *
   * The id is what every caller wants, so it is what the obvious name returns;
   * {@link addModuleResult} is the same call keeping the whole record, for the
   * one caller that asked for `haskellLogging` and wants the log lines back.
   * Two methods rather than one returning a record, because
   * `(await client.addModule(text)).module` reads like a mistake and
   * `await client.addModule(text)` reads like the protocol.
   */
  async addModule(moduleText: string, options: AddModuleOptions = {}): Promise<string> {
    return (await this.addModuleResult(moduleText, options)).module;
  }

  /** `add-module`, keeping `haskell-log-entries` — see {@link addModule}. */
  async addModuleResult(moduleText: string, options: AddModuleOptions = {}): Promise<AddModuleResult> {
    return decodeAddModuleResult(await this.send({ method: "add-module", params: { ...options, module: moduleText } }));
  }

  /**
   * Ask the server to abandon the request currently in flight — pyk's
   * `interrupt` (`rpc.py:342-353`).
   *
   * Fire and forget: a `cancel` gets no reply of its own. What settles is the
   * *pending* call, normally by rejecting with the `-32000` error
   * (`isCancelledError` tells that one from a real failure), and the connection
   * stays usable — the next request on the same client works. Safe to call
   * with nothing in flight, and before the first request, in which case the
   * cancel id is the bare `"cancel"`, exactly as pyk's f-string produces.
   */
  interrupt(): void {
    const id = this.last === undefined ? CANCEL_METHOD : `${this.last}-cancel`;
    this.transport.interrupt(JSON.stringify(encodeRequest(id, { method: CANCEL_METHOD })));
  }

  /** Release the connection. Any in-flight call rejects. */
  close(): void {
    this.transport.close();
  }

  //////////////////////
  // Internals        //
  //////////////////////

  /**
   * One round trip: build, send, read, check — everything but the decoding.
   *
   * Which decoder the `result` member wants is knowledge each public method
   * already has, so it applies its own rather than being dispatched to through
   * a `method`-keyed table; that keeps this function non-generic and every
   * result type inferred rather than asserted.
   *
   * The check order is pyk's (`rpc.py:386-390`): the `error` member first, the
   * id second. It matters for `-32700`, the one error a server answers with
   * `id: null` because it never got far enough to read one — checking the id
   * first would report a mismatch and hide the parse error that caused it.
   */
  private async send(request: KoreRpcRequest): Promise<JsonValue> {
    const id = this.nextRequestId();
    const response = decodeResponse(await this.transport.request(JSON.stringify(encodeRequest(id, request))));

    if (response.kind === "error") throw koreRpcError(response.error);
    if (response.id !== id) throw new ResponseIdMismatchError(id, response.id);

    return response.result;
  }

  /** `"<prefix>-NNN"`, counting from 1 — pyk `rpc.py:356-360`. */
  private nextRequestId(): string {
    const id = `${this.prefix}-${String(this.counter).padStart(3, "0")}`;
    this.counter += 1;
    this.last = id;
    return id;
  }
}
