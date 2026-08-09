/**
 * The kore-rpc codec: typed values ⇄ JSON, in both directions, for all five
 * payload methods and for the JSON-RPC envelope around them.
 *
 * Transcribed from `haskell-backend/kore-rpc-types/src/Kore/JsonRpc/Types.hs`
 * (the derivations that generate every field name) against pyk's
 * `KoreClient` (`k/pyk/src/pyk/kore/rpc.py:1094-1215` for the request
 * builders, `rpc.py:694-1019` for the result readers). The pinning oracle is
 * pyk's own unit suite, `k/pyk/src/tests/unit/kore/test_client.py`, whose six
 * data tables are transcribed row for row in `test/codec.test.ts`.
 *
 * # Two different disciplines, on purpose
 *
 * **Encoding is strict.** Exactly the declared fields, kebab-cased, absent
 * optionals omitted entirely. There is no path here that emits `null` for an
 * absent value and none that emits a field the wire type does not have. This
 * matters more than it looks: the server ignores unknown request fields
 * silently (there is no capability handshake to catch a typo), so a misspelled
 * parameter is not an error — it is a parameter that quietly did nothing.
 *
 * **Decoding is strict about structure and lenient about extension.** A
 * missing `state`, a `depth` that is negative, a `reason` outside the eight,
 * an `implies` result without `status` — all decode errors, with a JSON path.
 * An *unknown key* on a known object is ignored, an unknown `logs` tag is kept
 * raw (`logs.ts`), and an unrecognized context-log frame is kept raw. The rule
 * is that a field we understand must be right, and a field we do not
 * understand must not cost the caller their result.
 *
 * # Both directions, on both halves
 *
 * A client only ever *encodes* requests and *decodes* responses, so that is the
 * asymmetry the two disciplines above are written for. All four functions exist
 * anyway, and the request-side decoders ({@link decodeExecuteParams} and
 * friends, {@link decodeRequestEnvelope}) are public API rather than a test
 * detail, because the traffic worth reading is mostly *recorded*: a pyk
 * `--bug-report` tarball, a captured session, `booster-rpc/*.send`, a mock
 * server that has to understand what it was asked. Round-tripping a recorded
 * request through the typed value it denotes is also the only way to test that
 * the encoders agree with a real client's — which is what
 * `test/golden.test.ts`, `test/structural.test.ts` and
 * `test/classification.test.ts` do with the vendored corpus.
 *
 * The request decoders follow the response decoders' discipline exactly:
 * strict about the structure and the type of every field they understand,
 * silent about fields they do not — which is what makes
 * `classification/state-a.unformatted.execute.request`, with its stray
 * `"xdoesnot"` param, decode rather than throw.
 *
 * # Every term-valued field is an envelope
 *
 * `state`, `antecedent`, `consequent`, `substitution`, `predicate`,
 * `implication`, `unknown-predicate` and the log terms are all KORE-JSON
 * documents — `{"format":"KORE","version":1,"term":…}` — never bare patterns.
 * `@kframework-ts/kore`'s `decodeKoreJson` / `encodeKoreJsonValue` are the
 * codec for that layer and are used unmodified. `add-module`'s `module` is the
 * sole exception: textual KORE in a JSON string.
 *
 * # What this module does not do
 *
 * It does not own a connection, an id counter, or a retry policy — no
 * transport, no client, no sockets. {@link encodeRequest} takes the id it is
 * given and {@link decodeResponse} hands back whatever id it read, without
 * checking that they match: which id a response belongs to is the caller's
 * bookkeeping, and on a single-flight socket (the only kind kore-rpc has) it
 * is a one-line assertion the caller is better placed to make.
 */

import {
  type JsonObject,
  type JsonValue,
  type KoreJson,
  decodeKoreJson,
  encodeKoreJsonValue,
} from "@kframework-ts/kore";
import { z } from "zod";
import { JsonRpcErrorObjectWireSchema, decodeErrorObject } from "./errors.js";
import {
  type MutableJsonObject,
  asBoolean,
  asEnum,
  asInt,
  asJson,
  asNat,
  asObject,
  asString,
  describe,
  exhausted,
  isRecord,
  optionalField,
  putOptional,
  readArray,
  requiredField,
  rpcError,
  sealObject,
} from "./internal.js";
import {
  type LogEntry,
  type LogLine,
  LogLineWireSchema,
  decodeLogEntries,
  decodeLogLines,
  encodeLogEntries,
  encodeLogLines,
} from "./logs.js";
import {
  type AddModuleParams,
  type AddModuleResult,
  type Condition,
  type ExecuteParams,
  type ExecuteResult,
  type ExecuteState,
  type GetModelParams,
  type GetModelResult,
  type HaltReason,
  type ImpliesParams,
  type ImpliesResult,
  type ImpliesStatus,
  type KoreRpcMethod,
  type KoreRpcParamsByMethod,
  type KoreRpcRequest,
  type KoreRpcResultByMethod,
  type OffReasonFields,
  type OffReasonKey,
  type RequestId,
  RequestIdSchema,
  type SatResult,
  type SimplifyParams,
  type SimplifyResult,
  CANCEL_METHOD,
  HALT_REASONS,
  IMPLIES_STATUSES,
  JSONRPC_VERSION,
  KORE_RPC_METHODS,
  SAT_RESULTS,
} from "./types.js";

//////////////////////
// KORE-JSON bridge //
//////////////////////

/** A decoded envelope back to a JSON value — `format`/`version` are constants. */
function koreJsonValue(term: KoreJson): JsonObject {
  return encodeKoreJsonValue(term.term);
}

function readKoreJson(value: unknown, path: string): KoreJson {
  return decodeKoreJson(value, { path });
}

//////////////////////
// Request encoding //
//////////////////////

/** A `Maybe [Text]` parameter: copied into a fresh mutable array for the JSON value. */
function stringList(values: readonly string[] | undefined): JsonValue | undefined {
  return values === undefined ? undefined : [...values];
}

/**
 * `execute` parameters — pyk `KoreClient.execute` (`rpc.py:1094-1136`).
 *
 * Key order below is `Types.hs:39-52` declaration order, which differs from
 * pyk's dictionary order (pyk puts `state` in the middle); order is
 * meaningless to the server, and `keyorder.ts` is what byte-exactness goes
 * through.
 */
export function encodeExecuteParams(params: ExecuteParams): JsonObject {
  const out: MutableJsonObject = { state: koreJsonValue(params.state) };
  putOptional(out, "max-depth", params.maxDepth);
  putOptional(out, "module", params.module);
  putOptional(out, "cut-point-rules", stringList(params.cutPointRules));
  putOptional(out, "terminal-rules", stringList(params.terminalRules));
  putOptional(out, "moving-average-step-timeout", params.movingAverageStepTimeout);
  putOptional(out, "step-timeout", params.stepTimeout);
  putOptional(out, "assume-state-defined", params.assumeStateDefined);
  putOptional(out, "log-successful-rewrites", params.logSuccessfulRewrites);
  putOptional(out, "log-failed-rewrites", params.logFailedRewrites);
  putOptional(out, "booster-only", params.boosterOnly);
  putOptional(out, "haskell-logging", stringList(params.haskellLogging));
  return sealObject(out);
}

/** `implies` parameters — pyk `KoreClient.implies` (`rpc.py:1138-1160`). */
export function encodeImpliesParams(params: ImpliesParams): JsonObject {
  const out: MutableJsonObject = {
    antecedent: koreJsonValue(params.antecedent),
    consequent: koreJsonValue(params.consequent),
  };
  putOptional(out, "module", params.module);
  putOptional(out, "assume-defined", params.assumeDefined);
  putOptional(out, "booster-only", params.boosterOnly);
  putOptional(out, "haskell-logging", stringList(params.haskellLogging));
  return sealObject(out);
}

/**
 * Options {@link impliesParams} accepts.
 *
 * `assumeDefined` is spelled `boolean | undefined` rather than left merely
 * optional so that passing an explicit `undefined` is legal under
 * `exactOptionalPropertyTypes`: that is the way to ask for the field to be
 * omitted, which is a different request from the default.
 */
export interface ImpliesOptions {
  readonly module?: string;
  readonly assumeDefined?: boolean | undefined;
  readonly boosterOnly?: boolean;
  readonly haskellLogging?: readonly string[];
}

/**
 * Build `implies` parameters the way pyk builds them.
 *
 * The one thing this adds over writing the object by hand: `assumeDefined`
 * defaults to `false` and is therefore always **sent**, because pyk's
 * signature is `assume_defined: bool = False` (`rpc.py:1144`) and `False` is
 * not `None`, so `filter_none` keeps it. Every `implies` request every real
 * consumer has ever sent carries `"assume-defined": false`; matching that
 * keeps our traffic comparable with theirs — which is the difference between
 * a reproducible upstream bug report and an argument about the client.
 *
 * Pass `assumeDefined: undefined` explicitly to omit the field instead.
 */
export function impliesParams(antecedent: KoreJson, consequent: KoreJson, options: ImpliesOptions = {}): ImpliesParams {
  const assumeDefined = "assumeDefined" in options ? options.assumeDefined : false;
  return {
    antecedent,
    consequent,
    ...(options.module === undefined ? {} : { module: options.module }),
    ...(assumeDefined === undefined ? {} : { assumeDefined }),
    ...(options.boosterOnly === undefined ? {} : { boosterOnly: options.boosterOnly }),
    ...(options.haskellLogging === undefined ? {} : { haskellLogging: options.haskellLogging }),
  };
}

/** `simplify` parameters — pyk `KoreClient.simplify` (`rpc.py:1162-1181`). */
export function encodeSimplifyParams(params: SimplifyParams): JsonObject {
  const out: MutableJsonObject = { state: koreJsonValue(params.state) };
  putOptional(out, "module", params.module);
  putOptional(out, "booster-only", params.boosterOnly);
  putOptional(out, "haskell-logging", stringList(params.haskellLogging));
  return sealObject(out);
}

/**
 * `add-module` parameters — pyk `KoreClient.add_module` (`rpc.py:1198-1211`).
 *
 * `module` is textual KORE. pyk passes `module.text`, i.e. it unparses a
 * `Module` for you; here the caller does that (with
 * `@kframework-ts/kore`'s `koreText`) because this package does not otherwise
 * depend on the module AST.
 */
export function encodeAddModuleParams(params: AddModuleParams): JsonObject {
  const out: MutableJsonObject = { module: params.module };
  putOptional(out, "name-as-id", params.nameAsId);
  putOptional(out, "haskell-logging", stringList(params.haskellLogging));
  return sealObject(out);
}

/**
 * `get-model` parameters — pyk `KoreClient.get_model` (`rpc.py:1183-1196`).
 *
 * pyk's signature has no `booster-only`, though `GetModelRequest` has the
 * field (`Types.hs:95`); it is included here.
 */
export function encodeGetModelParams(params: GetModelParams): JsonObject {
  const out: MutableJsonObject = { state: koreJsonValue(params.state) };
  putOptional(out, "module", params.module);
  putOptional(out, "booster-only", params.boosterOnly);
  putOptional(out, "haskell-logging", stringList(params.haskellLogging));
  return sealObject(out);
}

/** Encode the `params` member of any request, `cancel` included. */
export function encodeParams(request: KoreRpcRequest): JsonObject {
  switch (request.method) {
    case "execute":
      return encodeExecuteParams(request.params);
    case "implies":
      return encodeImpliesParams(request.params);
    case "simplify":
      return encodeSimplifyParams(request.params);
    case "add-module":
      return encodeAddModuleParams(request.params);
    case "get-model":
      return encodeGetModelParams(request.params);
    case CANCEL_METHOD:
      // `parseParams "cancel" = Just $ const $ return Cancel` (`Types.hs:113`)
      // — the payload is discarded, and pyk sends `{}` (`rpc.py:344-350`).
      return {};
    default:
      return exhausted(request);
  }
}

//////////////////////
// Request decoding //
//////////////////////

/**
 * A term-valued *parameter*.
 *
 * The object check is deliberate and load-bearing: `decodeKoreJson` treats a
 * **string** argument as JSON source text (the convention {@link decodeResponse}
 * uses too), so without it `"state": "aaaa"` would be re-parsed rather than
 * rejected — and `kore-rpc-server/execute/invalid-params` exists precisely to
 * assert that a string state is not a state.
 */
function readKoreParam(value: unknown, path: string): KoreJson {
  if (!isRecord(value)) throw rpcError(`Expected a KORE-JSON envelope, got ${describe(value)}`, path);
  return decodeKoreJson(value, { path });
}

/** A `Maybe [Text]` parameter, read back. */
function readStringList(value: unknown, path: string): readonly string[] {
  return readArray(value, path, asString);
}

/** A writable view of a params interface, so optional fields can be filled in one at a time. */
type Mutable<T> = { -readonly [K in keyof T]: T[K] };

/** `ExecuteRequest` (`Types.hs:39-56`) — the inverse of {@link encodeExecuteParams}. */
export function decodeExecuteParams(value: unknown, path = "params"): ExecuteParams {
  const obj = asObject(value, path);
  const out: Mutable<ExecuteParams> = {
    state: requiredField(obj, "state", path, "ExecuteRequest", readKoreParam),
  };
  const maxDepth = optionalField(obj, "max-depth", path, asNat);
  if (maxDepth !== undefined) out.maxDepth = maxDepth;
  const module = optionalField(obj, "module", path, asString);
  if (module !== undefined) out.module = module;
  const cutPointRules = optionalField(obj, "cut-point-rules", path, readStringList);
  if (cutPointRules !== undefined) out.cutPointRules = cutPointRules;
  const terminalRules = optionalField(obj, "terminal-rules", path, readStringList);
  if (terminalRules !== undefined) out.terminalRules = terminalRules;
  const movingAverage = optionalField(obj, "moving-average-step-timeout", path, asBoolean);
  if (movingAverage !== undefined) out.movingAverageStepTimeout = movingAverage;
  // `Maybe Int` (`Types.hs:46`), not a `Depth`: aeson's `FromJSON Int` takes a
  // negative just fine, so a request carrying `-1` is one this decoder must
  // reproduce rather than reject. Whether the server does anything sensible
  // with it is the server's business.
  const stepTimeout = optionalField(obj, "step-timeout", path, asInt);
  if (stepTimeout !== undefined) out.stepTimeout = stepTimeout;
  const assumeStateDefined = optionalField(obj, "assume-state-defined", path, asBoolean);
  if (assumeStateDefined !== undefined) out.assumeStateDefined = assumeStateDefined;
  const logSuccessfulRewrites = optionalField(obj, "log-successful-rewrites", path, asBoolean);
  if (logSuccessfulRewrites !== undefined) out.logSuccessfulRewrites = logSuccessfulRewrites;
  const logFailedRewrites = optionalField(obj, "log-failed-rewrites", path, asBoolean);
  if (logFailedRewrites !== undefined) out.logFailedRewrites = logFailedRewrites;
  const boosterOnly = optionalField(obj, "booster-only", path, asBoolean);
  if (boosterOnly !== undefined) out.boosterOnly = boosterOnly;
  const haskellLogging = optionalField(obj, "haskell-logging", path, readStringList);
  if (haskellLogging !== undefined) out.haskellLogging = haskellLogging;
  return out;
}

/** `ImpliesRequest` (`Types.hs:58-69`) — the inverse of {@link encodeImpliesParams}. */
export function decodeImpliesParams(value: unknown, path = "params"): ImpliesParams {
  const obj = asObject(value, path);
  const out: Mutable<ImpliesParams> = {
    antecedent: requiredField(obj, "antecedent", path, "ImpliesRequest", readKoreParam),
    consequent: requiredField(obj, "consequent", path, "ImpliesRequest", readKoreParam),
  };
  const module = optionalField(obj, "module", path, asString);
  if (module !== undefined) out.module = module;
  const assumeDefined = optionalField(obj, "assume-defined", path, asBoolean);
  if (assumeDefined !== undefined) out.assumeDefined = assumeDefined;
  const boosterOnly = optionalField(obj, "booster-only", path, asBoolean);
  if (boosterOnly !== undefined) out.boosterOnly = boosterOnly;
  const haskellLogging = optionalField(obj, "haskell-logging", path, readStringList);
  if (haskellLogging !== undefined) out.haskellLogging = haskellLogging;
  return out;
}

/** `SimplifyRequest` (`Types.hs:71-80`) — the inverse of {@link encodeSimplifyParams}. */
export function decodeSimplifyParams(value: unknown, path = "params"): SimplifyParams {
  const obj = asObject(value, path);
  const out: Mutable<SimplifyParams> = {
    state: requiredField(obj, "state", path, "SimplifyRequest", readKoreParam),
  };
  const module = optionalField(obj, "module", path, asString);
  if (module !== undefined) out.module = module;
  const boosterOnly = optionalField(obj, "booster-only", path, asBoolean);
  if (boosterOnly !== undefined) out.boosterOnly = boosterOnly;
  const haskellLogging = optionalField(obj, "haskell-logging", path, readStringList);
  if (haskellLogging !== undefined) out.haskellLogging = haskellLogging;
  return out;
}

/**
 * `AddModuleRequest` (`Types.hs:82-90`) — the inverse of
 * {@link encodeAddModuleParams}.
 *
 * `module` is textual KORE in a JSON string, not an envelope and not a parsed
 * module; this is the one params decoder with no term in it.
 */
export function decodeAddModuleParams(value: unknown, path = "params"): AddModuleParams {
  const obj = asObject(value, path);
  const out: Mutable<AddModuleParams> = {
    module: requiredField(obj, "module", path, "AddModuleRequest", asString),
  };
  const nameAsId = optionalField(obj, "name-as-id", path, asBoolean);
  if (nameAsId !== undefined) out.nameAsId = nameAsId;
  const haskellLogging = optionalField(obj, "haskell-logging", path, readStringList);
  if (haskellLogging !== undefined) out.haskellLogging = haskellLogging;
  return out;
}

/** `GetModelRequest` (`Types.hs:92-101`) — the inverse of {@link encodeGetModelParams}. */
export function decodeGetModelParams(value: unknown, path = "params"): GetModelParams {
  const obj = asObject(value, path);
  const out: Mutable<GetModelParams> = {
    state: requiredField(obj, "state", path, "GetModelRequest", readKoreParam),
  };
  const module = optionalField(obj, "module", path, asString);
  if (module !== undefined) out.module = module;
  const boosterOnly = optionalField(obj, "booster-only", path, asBoolean);
  if (boosterOnly !== undefined) out.boosterOnly = boosterOnly;
  const haskellLogging = optionalField(obj, "haskell-logging", path, readStringList);
  if (haskellLogging !== undefined) out.haskellLogging = haskellLogging;
  return out;
}

/** One decoder per method, typed so {@link decodeParams} needs no cast. */
type ParamsDecoders = {
  readonly [M in KoreRpcMethod]: (value: unknown, path?: string) => KoreRpcParamsByMethod[M];
};

const PARAMS_DECODERS: ParamsDecoders = nullPrototype({
  execute: decodeExecuteParams,
  implies: decodeImpliesParams,
  simplify: decodeSimplifyParams,
  "add-module": decodeAddModuleParams,
  "get-model": decodeGetModelParams,
});

/**
 * Decode a `params` member knowing which method it belongs to — the mirror of
 * {@link decodeResult}.
 *
 * `method` is typed, but the type is not the guard: these tables are indexed by
 * a string that came off a wire in every interesting case. See
 * {@link nullPrototype} and {@link dispatch}.
 */
export function decodeParams<M extends KoreRpcMethod>(
  method: M,
  value: unknown,
  path = "params",
): KoreRpcParamsByMethod[M] {
  return dispatch(PARAMS_DECODERS, method, "params decoder")(value, path);
}

/**
 * Whether a value is one of the five payload methods (`Types.hs:107-114`).
 *
 * `cancel` is deliberately **not** one: it has no params, no result and no
 * response, so every table keyed by {@link KoreRpcMethod} would need a hole for
 * it. {@link decodeRequestEnvelope} handles it separately.
 */
export function isKoreRpcMethod(value: unknown): value is KoreRpcMethod {
  return typeof value === "string" && (KORE_RPC_METHODS as readonly string[]).includes(value);
}

//////////////////////
// Request envelope //
//////////////////////

/**
 * Build a JSON-RPC 2.0 request object: `{jsonrpc, id, method, params}`.
 *
 * Key order here is the order `rpcJsonConfig` would emit
 * (`jsonrpc`, `id`, then the rest), so `emitOrdered` on the result is a no-op
 * at this level and the object reads the same whether it is stringified with
 * `JSON.stringify` or with `keyorder.ts`.
 *
 * `cancel` gets an envelope too, because that is how pyk writes it
 * (`rpc.py:342-353`) — a full request object with an id the server never
 * answers. It is a notification in behaviour and a request in shape.
 */
export function encodeRequest(id: RequestId, request: KoreRpcRequest): JsonObject {
  return {
    jsonrpc: JSONRPC_VERSION,
    id,
    method: request.method,
    params: encodeParams(request),
  };
}

/** A decoded JSON-RPC request: the id it carried, plus the typed call. */
export interface DecodedRequest {
  readonly id: RequestId;
  readonly request: KoreRpcRequest;
}

/**
 * Read a complete JSON-RPC request envelope — the inverse of
 * {@link encodeRequest}.
 *
 * Strict about the envelope (`jsonrpc` must be `"2.0"` when present, `id` must
 * be a string or a number and, unlike a *response*'s, must be there — a
 * kore-rpc request always carries one, `cancel` included) and about the params,
 * which are dispatched to the method's decoder.
 *
 * This is what a mock server, a session replayer or a reader of recorded
 * traffic wants; a *client* has no use for it, which is why nothing in
 * `client.ts` calls it.
 */
export function decodeRequestEnvelope(value: unknown, path = "<request>"): DecodedRequest {
  const obj = asObject(value, path);

  const version = obj["jsonrpc"];
  if (version !== undefined && version !== JSONRPC_VERSION) {
    throw rpcError(`Expected jsonrpc ${JSON.stringify(JSONRPC_VERSION)}, got ${describe(version)}`, `${path}.jsonrpc`);
  }

  const rawId = obj["id"];
  if (typeof rawId !== "string" && typeof rawId !== "number") {
    throw rpcError(`Expected a string or number id, got ${describe(rawId)}`, `${path}.id`);
  }
  const id: RequestId = rawId;

  const method = obj["method"];
  // `cancel` carries params on the wire (pyk sends `{}`) and the server throws
  // them away — `parseParams "cancel" = Just $ const $ return Cancel`
  // (`Types.hs:113`) — so nothing here reads them either.
  if (method === CANCEL_METHOD) return { id, request: { method: CANCEL_METHOD } };
  if (!isKoreRpcMethod(method)) {
    throw rpcError(`Not a kore-rpc method: ${describe(method)}`, `${path}.method`);
  }

  const params = obj["params"];
  const paramsPath = `${path}.params`;
  switch (method) {
    case "execute":
      return { id, request: { method, params: decodeExecuteParams(params, paramsPath) } };
    case "implies":
      return { id, request: { method, params: decodeImpliesParams(params, paramsPath) } };
    case "simplify":
      return { id, request: { method, params: decodeSimplifyParams(params, paramsPath) } };
    case "add-module":
      return { id, request: { method, params: decodeAddModuleParams(params, paramsPath) } };
    case "get-model":
      return { id, request: { method, params: decodeGetModelParams(params, paramsPath) } };
    default:
      return exhausted(method);
  }
}

//////////////////////////
// Response envelope    //
//////////////////////////

/** A response carrying a `result` member. */
export interface ResultResponse {
  readonly kind: "result";
  readonly id: RequestId | null;
  readonly result: JsonValue;
}

/** The decoded `result` branch of a JSON-RPC response envelope. */
export const ResultResponseSchema: z.ZodType<ResultResponse, ResultResponse> = z.object({
  kind: z.literal("result"),
  id: RequestIdSchema.nullable(),
  result: z.json().transform((value): JsonValue => value),
});

/** The decoded, normalized `error` branch of a JSON-RPC response envelope. */
export const ErrorResponseSchema = z.object({
  kind: z.literal("error"),
  id: RequestIdSchema.nullable(),
  error: JsonRpcErrorObjectWireSchema,
});

/** A response carrying an `error` member. */
export type ErrorResponse = z.infer<typeof ErrorResponseSchema>;

/** Exactly one of `result` / `error`, per JSON-RPC 2.0. */
export type JsonRpcResponse = ResultResponse | ErrorResponse;

const DecodedJsonRpcResponseSchema = z.union([ResultResponseSchema, ErrorResponseSchema]);

/**
 * A JSON-RPC response transformed through the established response decoder.
 *
 * The decoder deliberately retains request/response discrimination and error
 * normalization; the composed branch schemas check the normalized result.
 */
export const JsonRpcResponseSchema: z.ZodType<JsonRpcResponse> = z
  .unknown()
  .transform((value) => decodeResponse(value))
  .pipe(DecodedJsonRpcResponseSchema);

/**
 * How much of an unparseable response line goes in the error message.
 *
 * A response line is a whole configuration — megabytes of it — and the engine's
 * own `JSON.parse` failure quotes none of it, which makes the failure hard to
 * place. An excerpt this long identifies the line without turning an exception
 * string into a copy of the payload; the full line is still in the caller's
 * hand, since the caller passed it.
 */
const PARSE_EXCERPT_CHARS = 120;

/**
 * `JSON.parse`, re-thrown as this package's error with a path and an excerpt.
 *
 * The engine's bare `SyntaxError` says `Unexpected end of JSON input` and
 * nothing about *which* input, which is the one thing a caller reading a log
 * needs. `internal.ts`'s convention — a `SyntaxError` ending `(at path)`, never
 * carrying a whole payload — applies here as much as anywhere else.
 */
function parseResponseText(text: string, path: string): unknown {
  try {
    return JSON.parse(text);
  } catch (error) {
    const excerpt =
      text.length > PARSE_EXCERPT_CHARS ? `${text.slice(0, PARSE_EXCERPT_CHARS)}… (${text.length} chars)` : text;
    throw rpcError(
      `Response is not valid JSON: ${error instanceof Error ? error.message : String(error)} — ${JSON.stringify(excerpt)}`,
      path,
    );
  }
}

/**
 * Read one JSON-RPC response.
 *
 * `input` is either the response *text* (parsed here) or a value already
 * parsed, told apart by `typeof input === "string"` — the same convention
 * `@kframework-ts/kore`'s `decodeKoreJson` uses, and unambiguous because a
 * response is always an object.
 *
 * The `id` is returned, not checked. On a `-32700` parse error the server has
 * no id to echo and sends `null`, which is why the type admits it; pyk asserts
 * `data['id'] == req_id` at `rpc.py:388` and a caller of this function should
 * do the same, having the id in hand.
 *
 * The `result` member is handed back as raw JSON: which method's result it is
 * is knowledge the caller has and the envelope does not. Pass it to
 * {@link decodeExecuteResult} and friends, or to {@link decodeResult}.
 */
export function decodeResponse(input: unknown, path = "<response>"): JsonRpcResponse {
  const value: unknown = typeof input === "string" ? parseResponseText(input, path) : input;
  const obj = asObject(value, path);

  const version = obj["jsonrpc"];
  if (version !== undefined && version !== JSONRPC_VERSION) {
    throw rpcError(`Expected jsonrpc ${JSON.stringify(JSONRPC_VERSION)}, got ${describe(version)}`, `${path}.jsonrpc`);
  }

  const rawId = obj["id"];
  const id: RequestId | null =
    rawId === undefined || rawId === null
      ? null
      : typeof rawId === "string" || typeof rawId === "number"
        ? rawId
        : (() => {
            throw rpcError(`Expected a string or number id, got ${describe(rawId)}`, `${path}.id`);
          })();

  if (Object.hasOwn(obj, "error") && obj["error"] !== null) {
    return { kind: "error", id, error: decodeErrorObject(obj["error"], `${path}.error`) };
  }
  if (!Object.hasOwn(obj, "result")) {
    throw rpcError('Response has neither a "result" nor an "error" member', path);
  }
  return { kind: "result", id, result: asJson(obj["result"], `${path}.result`) };
}

//////////////////////
// execute results  //
//////////////////////

/** `ExecuteState` (`Types.hs:116-127`) — pyk `State.from_dict` (`rpc.py:538-548`). */
export function decodeExecuteState(value: unknown, path = "state"): ExecuteState {
  const obj = asObject(value, path);
  const predicate = optionalField(obj, "predicate", path, readKoreJson);
  const substitution = optionalField(obj, "substitution", path, readKoreJson);
  const ruleSubstitution = optionalField(obj, "rule-substitution", path, readKoreJson);
  const rulePredicate = optionalField(obj, "rule-predicate", path, readKoreJson);
  const ruleId = optionalField(obj, "rule-id", path, asString);
  return {
    term: requiredField(obj, "term", path, "ExecuteState", readKoreJson),
    ...(predicate === undefined ? {} : { predicate }),
    ...(substitution === undefined ? {} : { substitution }),
    ...(ruleSubstitution === undefined ? {} : { ruleSubstitution }),
    ...(rulePredicate === undefined ? {} : { rulePredicate }),
    ...(ruleId === undefined ? {} : { ruleId }),
  };
}

/** `ExecuteState` back to JSON, in `Types.hs:116-123` field order. */
export function encodeExecuteState(state: ExecuteState): JsonObject {
  const out: MutableJsonObject = { term: koreJsonValue(state.term) };
  putOptional(out, "predicate", state.predicate && koreJsonValue(state.predicate));
  putOptional(out, "substitution", state.substitution && koreJsonValue(state.substitution));
  putOptional(out, "rule-substitution", state.ruleSubstitution && koreJsonValue(state.ruleSubstitution));
  putOptional(out, "rule-predicate", state.rulePredicate && koreJsonValue(state.rulePredicate));
  putOptional(out, "rule-id", state.ruleId);
  return sealObject(out);
}

/** The two log bundles, decoded together since every result carries both. */
interface DecodedLogs {
  readonly logs?: readonly LogEntry[];
  readonly haskellLogEntries?: readonly LogLine[];
}

function decodeLogFields(obj: Readonly<Record<string, unknown>>, path: string): DecodedLogs {
  const logs = optionalField(obj, "logs", path, decodeLogEntries);
  const haskellLogEntries = optionalField(obj, "haskell-log-entries", path, decodeLogLines);
  return {
    ...(logs === undefined ? {} : { logs }),
    ...(haskellLogEntries === undefined ? {} : { haskellLogEntries }),
  };
}

function encodeLogFields(out: MutableJsonObject, logs: DecodedLogs): void {
  putOptional(out, "logs", logs.logs && [...encodeLogEntries(logs.logs)]);
  putOptional(out, "haskell-log-entries", logs.haskellLogEntries && [...encodeLogLines(logs.haskellLogEntries)]);
}

function decodeHaltReason(value: unknown, path: string): HaltReason {
  return asEnum(value, path, HALT_REASONS, "halt reason");
}

function decodeNextStates(obj: Readonly<Record<string, unknown>>, path: string, reason: HaltReason) {
  return requiredField(obj, "next-states", path, `${reason} result`, (v, p) => readArray(v, p, decodeExecuteState));
}

/**
 * The result-level `Maybe` fields this reason does not own, kept raw — see
 * {@link OffReasonFields}.
 *
 * `keys` is the three of {@link OffReasonKey} minus the ones the reason has a
 * typed home for; the generic is what makes that subtraction visible to the
 * caller instead of a comment. Nothing is allocated unless a key is actually
 * there, which is the case that never happens on real traffic.
 */
function decodeOffReasonFields<K extends OffReasonKey>(
  obj: Readonly<Record<string, unknown>>,
  path: string,
  ...keys: readonly K[]
): { readonly offReasonFields?: OffReasonFields<K> } {
  let carried: { -readonly [F in K]?: JsonValue } | undefined;
  for (const key of keys) {
    const value = optionalField(obj, key, path, asJson);
    if (value === undefined) continue;
    carried ??= {};
    carried[key] = value;
  }
  return carried === undefined ? {} : { offReasonFields: carried };
}

/**
 * `ExecuteResult` (`Types.hs:143-156`) into the discriminated union of
 * `types.ts` — pyk's eight `from_dict` classmethods (`rpc.py:694-941`),
 * including their per-reason requirements: `next-states` is mandatory on
 * `branching` and `cut-point-rule`, `rule` on `cut-point-rule` and
 * `terminal-rule`.
 *
 * Upstream is **one flat record** whose `next-states`, `rule` and
 * `unknown-predicate` are all `Maybe` (`Types.hs:143-156`), so aeson happily
 * round-trips a `rule` beside `reason: "stuck"`: unusual, but valid wire data
 * that a server may legally emit. Those fields are therefore carried through
 * raw in {@link OffReasonFields} rather than dropped, which is what makes
 * decode→encode identity for every `ExecuteResult` JSON `Types.hs` admits —
 * and what lets a mock server built on {@link encodeExecuteResult} reproduce
 * such a response.
 *
 * A genuinely **unknown** key is a different contract and keeps the old one:
 * ignored, never carried, because a future protocol extension is not something
 * this decoder can claim to re-emit faithfully (see the header's second
 * discipline).
 */
export function decodeExecuteResult(value: unknown, path = "result"): ExecuteResult {
  const obj = asObject(value, path);
  const reason = requiredField(obj, "reason", path, "ExecuteResult", decodeHaltReason);
  const base = {
    depth: requiredField(obj, "depth", path, "ExecuteResult", asNat),
    state: requiredField(obj, "state", path, "ExecuteResult", decodeExecuteState),
    ...decodeLogFields(obj, path),
  };

  switch (reason) {
    case "branching":
      return {
        reason,
        ...base,
        nextStates: decodeNextStates(obj, path, reason),
        ...decodeOffReasonFields(obj, path, "rule", "unknown-predicate"),
      };
    case "cut-point-rule":
      return {
        reason,
        ...base,
        nextStates: decodeNextStates(obj, path, reason),
        rule: requiredField(obj, "rule", path, "cut-point-rule result", asString),
        ...decodeOffReasonFields(obj, path, "unknown-predicate"),
      };
    case "terminal-rule":
      return {
        reason,
        ...base,
        rule: requiredField(obj, "rule", path, "terminal-rule result", asString),
        ...decodeOffReasonFields(obj, path, "next-states", "unknown-predicate"),
      };
    case "aborted": {
      const unknownPredicate = optionalField(obj, "unknown-predicate", path, readKoreJson);
      return {
        reason,
        ...base,
        ...(unknownPredicate === undefined ? {} : { unknownPredicate }),
        ...decodeOffReasonFields(obj, path, "next-states", "rule"),
      };
    }
    case "stuck":
    case "vacuous":
    case "depth-bound":
    case "timeout":
      return { reason, ...base, ...decodeOffReasonFields(obj, path, "next-states", "rule", "unknown-predicate") };
    default:
      return exhausted(reason);
  }
}

/**
 * `ExecuteResult` back to JSON, in `Types.hs:143-152` field order.
 *
 * Each of the three `Maybe` slots is written from whichever side owns it: the
 * typed field when this reason has one, the raw {@link OffReasonFields} entry
 * when it does not. That is the identity half of the carry-through
 * {@link decodeExecuteResult} documents, and it is why the two branches of
 * each `if` write the same wire key.
 */
export function encodeExecuteResult(result: ExecuteResult): JsonObject {
  const out: MutableJsonObject = {
    reason: result.reason,
    depth: result.depth,
    state: encodeExecuteState(result.state),
  };
  if (result.reason === "branching" || result.reason === "cut-point-rule") {
    out["next-states"] = result.nextStates.map(encodeExecuteState);
  } else {
    putOptional(out, "next-states", result.offReasonFields?.["next-states"]);
  }
  if (result.reason === "cut-point-rule" || result.reason === "terminal-rule") {
    out["rule"] = result.rule;
  } else {
    putOptional(out, "rule", result.offReasonFields?.["rule"]);
  }
  putOptional(out, "logs", result.logs && [...encodeLogEntries(result.logs)]);
  if (result.reason === "aborted") {
    putOptional(out, "unknown-predicate", result.unknownPredicate && koreJsonValue(result.unknownPredicate));
  } else {
    putOptional(out, "unknown-predicate", result.offReasonFields?.["unknown-predicate"]);
  }
  putOptional(out, "haskell-log-entries", result.haskellLogEntries && [...encodeLogLines(result.haskellLogEntries)]);
  return sealObject(out);
}

//////////////////////
// implies results  //
//////////////////////

function decodeImpliesStatus(value: unknown, path: string): ImpliesStatus {
  return asEnum(value, path, IMPLIES_STATUSES, "implies status");
}

/** `Condition` (`Types.hs:158-165`). Both members are required *inside* it. */
export function decodeCondition(value: unknown, path = "condition"): Condition {
  const obj = asObject(value, path);
  return {
    substitution: requiredField(obj, "substitution", path, "Condition", readKoreJson),
    predicate: requiredField(obj, "predicate", path, "Condition", readKoreJson),
  };
}

export function encodeCondition(condition: Condition): JsonObject {
  return {
    substitution: koreJsonValue(condition.substitution),
    predicate: koreJsonValue(condition.predicate),
  };
}

/**
 * `ImpliesResult` (`Types.hs:186-196`) — pyk `ImpliesResult.from_dict`
 * (`rpc.py:948-965`), except that `status` stays a tri-state instead of being
 * collapsed to `valid: bool`, and `condition` stays one object instead of
 * being split into two independent optionals.
 */
export function decodeImpliesResult(value: unknown, path = "result"): ImpliesResult {
  const obj = asObject(value, path);
  const condition = optionalField(obj, "condition", path, decodeCondition);
  return {
    implication: requiredField(obj, "implication", path, "ImpliesResult", readKoreJson),
    status: requiredField(obj, "status", path, "ImpliesResult", decodeImpliesStatus),
    ...(condition === undefined ? {} : { condition }),
    ...decodeLogFields(obj, path),
  };
}

export function encodeImpliesResult(result: ImpliesResult): JsonObject {
  const out: MutableJsonObject = {
    implication: koreJsonValue(result.implication),
    status: result.status,
  };
  putOptional(out, "condition", result.condition && encodeCondition(result.condition));
  encodeLogFields(out, result);
  return sealObject(out);
}

//////////////////////
// simplify results //
//////////////////////

/** `SimplifyResult` (`Types.hs:198-206`) — pyk `KoreClient.simplify` (`rpc.py:1179-1181`). */
export function decodeSimplifyResult(value: unknown, path = "result"): SimplifyResult {
  const obj = asObject(value, path);
  return {
    state: requiredField(obj, "state", path, "SimplifyResult", readKoreJson),
    ...decodeLogFields(obj, path),
  };
}

export function encodeSimplifyResult(result: SimplifyResult): JsonObject {
  const out: MutableJsonObject = { state: koreJsonValue(result.state) };
  encodeLogFields(out, result);
  return sealObject(out);
}

////////////////////////
// add-module results //
////////////////////////

/** Structural `add-module` result as returned by the JSON-RPC server. */
export const AddModuleResultWireSchema = z.object({
  module: z.string(),
  "haskell-log-entries": z.array(LogLineWireSchema).nullable().optional(),
});

/** An `add-module` result transformed through the established log decoder. */
export const AddModuleResultSchema: z.ZodType<
  AddModuleResult,
  z.input<typeof AddModuleResultWireSchema>
> = AddModuleResultWireSchema.transform((result): AddModuleResult => decodeAddModuleResult(result));

/**
 * `AddModuleResult` (`Types.hs:208-215`) — pyk returns the bare string
 * (`rpc.py:1210`), losing `haskell-log-entries`; the record is kept whole here.
 */
export function decodeAddModuleResult(value: unknown, path = "result"): AddModuleResult {
  const obj = asObject(value, path);
  const haskellLogEntries = optionalField(obj, "haskell-log-entries", path, decodeLogLines);
  return {
    module: requiredField(obj, "module", path, "AddModuleResult", asString),
    ...(haskellLogEntries === undefined ? {} : { haskellLogEntries }),
  };
}

export function encodeAddModuleResult(result: AddModuleResult): JsonObject {
  const out: MutableJsonObject = { module: result.module };
  putOptional(out, "haskell-log-entries", result.haskellLogEntries && [...encodeLogLines(result.haskellLogEntries)]);
  return sealObject(out);
}

////////////////////////
// get-model results  //
////////////////////////

function decodeSatResult(value: unknown, path: string): SatResult {
  return asEnum(value, path, SAT_RESULTS, "satisfiability");
}

/**
 * `GetModelResult` (`Types.hs:217-225`) — pyk `GetModelResult.from_dict`
 * (`rpc.py:981-1000`).
 *
 * `substitution` is read only under `Sat`, matching pyk and the type's intent;
 * a substitution alongside `Unsat` would be meaningless, and dropping it is
 * the lenient reading.
 */
export function decodeGetModelResult(value: unknown, path = "result"): GetModelResult {
  const obj = asObject(value, path);
  const satisfiable = requiredField(obj, "satisfiable", path, "GetModelResult", decodeSatResult);
  const haskellLogEntries = optionalField(obj, "haskell-log-entries", path, decodeLogLines);
  const logs = haskellLogEntries === undefined ? {} : { haskellLogEntries };

  if (satisfiable === "Sat") {
    const substitution = optionalField(obj, "substitution", path, readKoreJson);
    return { satisfiable, ...(substitution === undefined ? {} : { substitution }), ...logs };
  }
  return { satisfiable, ...logs };
}

export function encodeGetModelResult(result: GetModelResult): JsonObject {
  const out: MutableJsonObject = { satisfiable: result.satisfiable };
  if (result.satisfiable === "Sat") {
    putOptional(out, "substitution", result.substitution && koreJsonValue(result.substitution));
  }
  putOptional(out, "haskell-log-entries", result.haskellLogEntries && [...encodeLogLines(result.haskellLogEntries)]);
  return sealObject(out);
}

//////////////////////
// Method dispatch  //
//////////////////////

/**
 * Rebuild a dispatch table with **no prototype**.
 *
 * An object literal inherits from `Object.prototype`, so a lookup keyed by a
 * string that came off a wire finds `constructor`, `toString`, `valueOf` and
 * friends: `decodeResult("constructor", {})` would return `Object` and then
 * *call* it, handing the caller `{}` typed as an `ExecuteResult`. `"__proto__"`
 * is worse still — the getter throws a raw `TypeError` that is neither this
 * package's error type nor its message shape. A null-prototype table has only
 * the keys that were put in it, which is what a table keyed by wire data has to
 * be.
 */
function nullPrototype<T extends object>(table: T): T {
  const bare: object = Object.create(null);
  return Object.assign(bare, table);
}

/**
 * Look one method up in a dispatch table, or throw this package's error.
 *
 * The `M extends string` generic keeps callers honest at compile time; this
 * function is what keeps them honest at run time, when `method` came from a
 * `JSON.parse`. A table entry that is somehow not a function is treated as
 * absent for the same reason.
 */
function dispatch<T extends object, M extends keyof T & string>(table: T, method: M, what: string): T[M] {
  if (!Object.hasOwn(table, method)) {
    throw rpcError(`Unknown kore-rpc method for the ${what}: ${JSON.stringify(method)}`, "method");
  }
  const entry = table[method];
  if (typeof entry !== "function") {
    throw rpcError(`Unknown kore-rpc method for the ${what}: ${JSON.stringify(method)}`, "method");
  }
  return entry;
}

/**
 * Decode a `result` member knowing which method produced it.
 *
 * The generic is a convenience over the five named decoders; it is not doing
 * anything they do not, and the cast is safe because the table is total over
 * `KoreRpcMethod` and each entry returns that method's result type. A `method`
 * that is not one of the five — which the type system cannot promise once the
 * string came off a socket — is a {@link SyntaxError} with this package's
 * `(at method)` path, not an inherited `Object.prototype` member.
 */
export function decodeResult<M extends KoreRpcMethod>(
  method: M,
  value: unknown,
  path = "result",
): KoreRpcResultByMethod[M] {
  return dispatch(RESULT_DECODERS, method, "result decoder")(value, path);
}

/** One decoder per method, typed so {@link decodeResult} needs no cast. */
type ResultDecoders = {
  readonly [M in KoreRpcMethod]: (value: unknown, path?: string) => KoreRpcResultByMethod[M];
};

const RESULT_DECODERS: ResultDecoders = nullPrototype({
  execute: decodeExecuteResult,
  implies: decodeImpliesResult,
  simplify: decodeSimplifyResult,
  "add-module": decodeAddModuleResult,
  "get-model": decodeGetModelResult,
});
