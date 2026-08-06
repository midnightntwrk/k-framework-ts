/**
 * The kore-rpc error taxonomy — the JSON-RPC `error` object, the frozen
 * positional code table, and a typed exception hierarchy over both.
 *
 * Transcribed from `haskell-backend/kore-rpc-types/src/Kore/JsonRpc/Error.hs`
 * (the whole file), the framing constants of
 * `kore-rpc-types/src/Kore/JsonRpc/Server.hs:36-38,134`, and
 * `booster/tools/booster/Proxy.hs:93-94`; the class hierarchy and every message
 * string mirror pyk's `KoreClientError` family
 * (`k/pyk/src/pyk/kore/rpc.py:402-500`) and its dispatch table
 * (`rpc.py:1074-1092`).
 *
 * # The codes 1–9 are positions, not names
 *
 * `backendError` (`Error.hs:107-110`) does not look a code up: it *counts*.
 * `constructorCodeAndName` walks the `Generic` representation of
 * `JsonRpcBackendError` and returns the 1-based index of the constructor that
 * matched (`Error.hs:87-105`), so `CouldNotParsePattern` is 1 because it is
 * written first. The comment above the type (`Error.hs:67-71`) says so
 * explicitly — "Do NOT re-order the constructors in this type" — which is what
 * makes it safe to transcribe as the literal table below rather than as a
 * derivation.
 *
 * The `message` string is derived the same way, from the constructor *name*:
 * `toSentence . fromHumps` (`Error.hs:26-31,108`) splits `SmtSolverError` into
 * `Smt solver error` — first word's case kept, the rest lowercased. Hence
 * `"Smt solver error"` and not `"SMT solver error"`; the sentence-cased form is
 * what a server actually puts on the wire.
 *
 * # `data` shapes drift, so decoding tolerates
 *
 * `JsonRpcBackendError` derives `SumUntaggedValue` (`Error.hs:85`), so the
 * `data` member is the constructor's payload with no tag wrapper — a bare
 * string for 3/6/7/9, an object for 1/4/5/8, and an *array* of objects for 2
 * (`CouldNotVerifyPattern [ErrorWithTermAndContext]`, `Error.hs:74`).
 *
 * pyk gets two of these wrong and would raise `TypeError` on real traffic:
 * `rpc.py:1081` reads code 2's data as `err.data['error']`, i.e. as a single
 * object, and `rpc.py:1085` reads code 4's `context` with `[...]` rather than
 * `.get`, so a context-less implication error crashes the client. This module
 * accepts every shape either server can produce and normalizes: code 1 accepts
 * an object *or* a bare string (the legacy kore server sends the string —
 * `test_client.py:321` pins it), code 2 accepts an array *or* a single object,
 * and every `context` is optional everywhere. Nothing is lost when a shape is
 * unrecognized: {@link KoreRpcError.data} always holds the raw payload.
 *
 * # Everything is an `Error`, and `aborted` is not one of them
 *
 * These classes are for the JSON-RPC `error` member only. `reason: "aborted"`,
 * `reason: "timeout"` and `reason: "vacuous"` arrive in the `result` member and
 * are *successful* executions with an unhelpful verdict; see `types.ts`.
 * (Error code 6, `Aborted`, is a different thing: the legacy kore server turns
 * booster's abort *reason* into this error.)
 */

import { type JsonValue, type KoreJson, decodeKoreJson, koreText } from "@kframework-ts/kore";
import { asJson, asObject, asString, describe, isArray, isRecord, rpcError } from "./internal.js";

//////////////////////
// The error object //
//////////////////////

/**
 * A JSON-RPC 2.0 `error` member, as it appears on the wire.
 *
 * `data` is optional in JSON-RPC and omitted by the two upstream constructors
 * that pass `Null` (`Error.hs:36,38`) — note that those send an explicit
 * `null`, not an absent key, which is why {@link decodeErrorObject} maps `null`
 * to absent rather than preserving it.
 */
export interface JsonRpcErrorObject {
  readonly code: number;
  readonly message: string;
  readonly data?: JsonValue;
}

/**
 * The `{error, context?, term?}` payload of codes 1, 2, 4, 5 and 8 —
 * `ErrorWithTermAndContext` (`Error.hs:46-56`).
 *
 * `term` is a KORE-JSON envelope upstream. It is decoded when it can be, and
 * left absent when it cannot: a malformed term inside an *error* payload must
 * not turn into a second, unrelated exception thrown from the error path. The
 * undecoded bytes remain in {@link KoreRpcError.data}.
 */
export interface ErrorDetail {
  readonly error: string;
  readonly context?: readonly string[];
  readonly term?: KoreJson;
}

//////////////////////
// The code tables  //
//////////////////////

/**
 * The 1-based constructor index of every `JsonRpcBackendError`
 * (`Error.hs:72-82`), frozen upstream by the comment at `Error.hs:67-71`.
 */
export const BACKEND_ERROR_CODES = {
  couldNotParsePattern: 1,
  couldNotVerifyPattern: 2,
  couldNotFindModule: 3,
  implicationCheckError: 4,
  smtSolverError: 5,
  aborted: 6,
  multipleStates: 7,
  invalidModule: 8,
  duplicateModuleName: 9,
} as const;

/**
 * The `message` each backend code carries, as `toSentence . fromHumps` renders
 * the constructor name (`Error.hs:26-31,108`).
 *
 * A client must never *match* on these — the code is the identity — but a
 * mock server has to emit them, and a reader wants to see them written down
 * next to the codes they belong to.
 */
export const BACKEND_ERROR_MESSAGES: Readonly<Record<number, string>> = {
  1: "Could not parse pattern",
  2: "Could not verify pattern",
  3: "Could not find module",
  4: "Implication check error",
  5: "Smt solver error",
  6: "Aborted",
  7: "Multiple states",
  8: "Invalid module",
  9: "Duplicate module name",
};

/** JSON-RPC 2.0's own parse error. The `krpc-test` smoke fixture is the only one upstream. */
export const JSON_RPC_PARSE_ERROR = -32700;

/** JSON-RPC 2.0 invalid request. */
export const JSON_RPC_INVALID_REQUEST = -32600;

/**
 * JSON-RPC 2.0 method-not-found. kore-rpc reuses it for two of its own
 * conditions: `"Not implemented"` (`Error.hs:38`) and `"Cancel not supported"`
 * (`dev-tools/kore-rpc-dev/Server.hs:113`, `booster/tools/booster/Proxy.hs:340`
 * — the dev servers have no cancel worker).
 */
export const JSON_RPC_METHOD_NOT_FOUND = -32601;

/** JSON-RPC 2.0 invalid params. The backend echoes the offending params as `data`. */
export const JSON_RPC_INVALID_PARAMS = -32602;

/** JSON-RPC 2.0 internal error. */
export const JSON_RPC_INTERNAL_ERROR = -32603;

/**
 * `"Request cancelled"` (`Server.hs:134`) — what the *pending* request rejects
 * with after a `cancel` notification is written onto the same socket. Not an
 * error the caller caused.
 */
export const KORE_RPC_REQUEST_CANCELLED = -32000;

/** `"Cancel request unsupported in batch mode"` (`Error.hs:36`). */
export const KORE_RPC_CANCEL_UNSUPPORTED_IN_BATCH = -32001;

/**
 * `"Runtime error"` (`Error.hs:41`). `data` is `{error, context?}` from the
 * two common handlers (`Error.hs:115-122`), but the proxy also raises it with
 * a bare value for `"Wrong result type"` (`Proxy.hs:429`) — so both shapes
 * occur.
 */
export const KORE_RPC_RUNTIME_ERROR = -32002;

/**
 * `"Unsupported option"` (`Error.hs:42`) — how a booster rejects a parameter
 * only the legacy kore server implements, `step-timeout` above all.
 */
export const KORE_RPC_UNSUPPORTED_OPTION = -32003;

/**
 * `"Server error: <detail>"` (`Proxy.hs:93-94`).
 *
 * Declared and exported by the proxy and, at v0.1.155, called from nowhere —
 * `serverError` has exactly one reference in the whole tree, its own export
 * list. Transcribed so that a client which one day meets it has a name for it.
 */
export const KORE_RPC_SERVER_ERROR = -32032;

//////////////////////
// The exceptions   //
//////////////////////

/**
 * Base of the typed hierarchy — pyk's `KoreClientError` (`rpc.py:402-405`),
 * plus the two things pyk's version drops on the floor: the numeric `code` and
 * the raw `data`.
 *
 * Abstract in spirit rather than in TypeScript: the constructor is `protected`,
 * so the only way to get one is through a subclass or through
 * {@link koreRpcError}.
 */
export abstract class KoreRpcError extends Error {
  /** The JSON-RPC `code`, verbatim. */
  readonly code: number;

  /** The JSON-RPC `data` member, undecoded. Absent when the server sent none. */
  readonly data: JsonValue | undefined;

  protected constructor(message: string, code: number, data: JsonValue | undefined) {
    super(message);
    this.code = code;
    this.data = data;
  }
}

/** Whether a caught value is one of this package's typed RPC errors. */
export function isKoreRpcError(value: unknown): value is KoreRpcError {
  return value instanceof KoreRpcError;
}

/** `Could not parse pattern` (code 1) — pyk `ParseError` (`rpc.py:408-416`). */
export class ParseError extends KoreRpcError {
  override readonly name = "ParseError";
  readonly error: string;
  readonly context: readonly string[] | undefined;
  readonly term: KoreJson | undefined;

  constructor(detail: ErrorDetail, data?: JsonValue) {
    super(`Could not parse pattern: ${detail.error}`, BACKEND_ERROR_CODES.couldNotParsePattern, data);
    this.error = detail.error;
    this.context = detail.context;
    this.term = detail.term;
  }
}

/**
 * `Could not verify pattern` (code 2) — pyk `PatternError` (`rpc.py:419-429`).
 *
 * Upstream's payload is a *list* of details (`Error.hs:74`), one per verifier
 * complaint. {@link details} is that list; {@link error} and {@link context}
 * are the first entry, which is what pyk's single-detail shape corresponds to
 * and what its message format prints.
 */
export class PatternError extends KoreRpcError {
  override readonly name = "PatternError";
  readonly details: readonly ErrorDetail[];

  constructor(details: readonly ErrorDetail[], data?: JsonValue) {
    super(`Could not verify pattern: ${describeDetails(details)}`, BACKEND_ERROR_CODES.couldNotVerifyPattern, data);
    this.details = details;
  }

  /** The first complaint's message — pyk's `error`. */
  get error(): string {
    return this.details[0]?.error ?? "";
  }

  /** The first complaint's context — pyk's `context`. */
  get context(): readonly string[] {
    return this.details[0]?.context ?? [];
  }
}

/** `Could not find module` (code 3) — pyk `UnknownModuleError` (`rpc.py:432-439`). */
export class UnknownModuleError extends KoreRpcError {
  override readonly name = "UnknownModuleError";
  readonly moduleName: string;

  constructor(moduleName: string, data?: JsonValue) {
    super(`Could not find module: ${moduleName}`, BACKEND_ERROR_CODES.couldNotFindModule, data);
    this.moduleName = moduleName;
  }
}

/** `Implication check error` (code 4) — pyk `ImplicationError` (`rpc.py:463-473`). */
export class ImplicationError extends KoreRpcError {
  override readonly name = "ImplicationError";
  readonly error: string;
  readonly context: readonly string[];
  readonly term: KoreJson | undefined;

  constructor(detail: ErrorDetail, data?: JsonValue) {
    const context = detail.context ?? [];
    super(
      `Implication check error: ${detail.error}${contextSuffix(context)}`,
      BACKEND_ERROR_CODES.implicationCheckError,
      data,
    );
    this.error = detail.error;
    this.context = context;
    this.term = detail.term;
  }
}

/**
 * `Smt solver error` (code 5) — pyk `SmtSolverError` (`rpc.py:476-486`).
 *
 * pyk's message renders the offending pattern as textual KORE
 * (`f'… Pattern: {self.pattern.text}'`); {@link koreText} is the same
 * unparser, so the strings match byte for byte. When the payload's term could
 * not be decoded the message says so rather than inventing one.
 */
export class SmtSolverError extends KoreRpcError {
  override readonly name = "SmtSolverError";
  readonly error: string;
  readonly term: KoreJson | undefined;

  constructor(detail: ErrorDetail, data?: JsonValue) {
    const rendered = detail.term === undefined ? "<unavailable>" : koreText(detail.term.term);
    super(`SMT solver error: ${detail.error} Pattern: ${rendered}`, BACKEND_ERROR_CODES.smtSolverError, data);
    this.error = detail.error;
    this.term = detail.term;
  }
}

/**
 * `Aborted` (code 6) — the legacy kore server's rendering of an abort that a
 * booster would have reported as `reason: "aborted"` in a *successful* result.
 *
 * pyk has no class for this and falls through to `DefaultError`
 * (`rpc.py:1074-1092`); a deliberate deviation, since a caller that wants to
 * retry on kore needs to tell an abort from an arbitrary failure.
 */
export class AbortedError extends KoreRpcError {
  override readonly name = "AbortedError";
  readonly reason: string;

  constructor(reason: string, data?: JsonValue) {
    super(`Aborted: ${reason}`, BACKEND_ERROR_CODES.aborted, data);
    this.reason = reason;
  }
}

/**
 * `Multiple states` (code 7) — a `simplify`/`get-model` request whose state
 * simplified to a disjunction.
 *
 * As with {@link AbortedError}, pyk has no class for it.
 */
export class MultipleStatesError extends KoreRpcError {
  override readonly name = "MultipleStatesError";
  readonly detail: string;

  constructor(detail: string, data?: JsonValue) {
    super(`Multiple states: ${detail}`, BACKEND_ERROR_CODES.multipleStates, data);
    this.detail = detail;
  }
}

/**
 * `Invalid module` (code 8) — pyk `InvalidModuleError` (`rpc.py:442-452`).
 *
 * pyk's message says `Could not verify module`, which is neither the wire
 * message nor the constructor name; it is kept, since the point of these
 * strings is to match the reference client's bug reports.
 */
export class InvalidModuleError extends KoreRpcError {
  override readonly name = "InvalidModuleError";
  readonly error: string;
  readonly context: readonly string[] | undefined;

  constructor(detail: ErrorDetail, data?: JsonValue) {
    const context = detail.context !== undefined && detail.context.length > 0 ? detail.context : undefined;
    super(
      `Could not verify module: ${detail.error}${context === undefined ? "" : ` Context: ${context.join(" ;; ")}`}`,
      BACKEND_ERROR_CODES.invalidModule,
      data,
    );
    this.error = detail.error;
    this.context = context;
  }
}

/** `Duplicate module name` (code 9) — pyk `DuplicateModuleError` (`rpc.py:455-460`). */
export class DuplicateModuleError extends KoreRpcError {
  override readonly name = "DuplicateModuleError";
  readonly moduleName: string;

  constructor(moduleName: string, data?: JsonValue) {
    super(`Duplicate module name: ${moduleName}`, BACKEND_ERROR_CODES.duplicateModuleName, data);
    this.moduleName = moduleName;
  }
}

/**
 * How much of a {@link DefaultError}'s `data` is rendered into its message.
 *
 * `internal.ts`'s stated invariant is that "a 4 MB configuration never lands in
 * an exception string", and `data` on an unrecognized error is the one payload
 * with no shape at all: `-32002` carries the whole aborted state, and a server
 * is free to put anything in any other code's. The full value is on
 * {@link KoreRpcError.data} either way, so the message only has to identify it.
 */
const DATA_EXCERPT_CHARS = 512;

/** The `| data: …` tail, bounded. */
function dataSuffix(data: JsonValue | undefined): string {
  if (data === undefined) return "";
  const rendered = JSON.stringify(data);
  if (rendered === undefined) return " | data: <unrenderable>";
  const excerpt =
    rendered.length > DATA_EXCERPT_CHARS
      ? `${rendered.slice(0, DATA_EXCERPT_CHARS)}… (${rendered.length} chars, in full on .data)`
      : rendered;
  return ` | data: ${excerpt}`;
}

/**
 * Anything with no dedicated class — pyk `DefaultError` (`rpc.py:489-500`),
 * including every negative code.
 *
 * pyk renders the payload with Python's `repr`; we use `JSON.stringify`, so
 * the tail of the message reads `| data: {"bar":1}` where pyk reads
 * `| data: {'bar': 1}`. There is no way to have both, and a JSON payload
 * printed as JSON is the more useful of the two.
 *
 * **Truncated**, unlike pyk's, at {@link DATA_EXCERPT_CHARS}: pyk inlines the
 * whole `repr`, which on a `-32002` from a real proof is a multi-megabyte
 * `Error.message` that every log line, every `toString` and every stack dump
 * then carries. The complete value is `.data`.
 */
export class DefaultError extends KoreRpcError {
  override readonly name = "DefaultError";

  constructor(message: string, code: number, data?: JsonValue) {
    super(`${message} | code: ${code}${dataSuffix(data)}`, code, data);
  }
}

//////////////////////
// Message helpers  //
//////////////////////

/** pyk's ` Context: a ;; b` tail (`rpc.py:427`, `471`), empty context included. */
function contextSuffix(context: readonly string[]): string {
  return ` Context: ${context.join(" ;; ")}`;
}

/** The message body of a {@link PatternError}: pyk's format for one detail, `;;`-joined for many. */
function describeDetails(details: readonly ErrorDetail[]): string {
  return details.map((d) => `${d.error}${contextSuffix(d.context ?? [])}`).join(" ;; ");
}

//////////////////////
// Decoding         //
//////////////////////

/**
 * Read a JSON-RPC `error` member.
 *
 * Strict about the two required members (`code` must be a number, `message` a
 * string); `data` is taken verbatim, whatever it is, and an explicit `null`
 * becomes absent — the two upstream constructors that carry no payload emit
 * `Null` (`Error.hs:36,38`) rather than omitting the key.
 */
export function decodeErrorObject(value: unknown, path = "error"): JsonRpcErrorObject {
  const obj = asObject(value, path);
  const code = obj["code"];
  if (typeof code !== "number" || !Number.isInteger(code)) {
    throw rpcError(`Expected an integer error code, got ${describe(code)}`, `${path}.code`);
  }
  const message = asString(obj["message"], `${path}.message`);
  const raw = obj["data"];
  if (raw === undefined || raw === null) return { code, message };
  return { code, message, data: asJson(raw, `${path}.data`) };
}

/** Read one `ErrorWithTermAndContext`, tolerating a bare string for `error`. */
function readDetail(value: JsonValue | undefined): ErrorDetail {
  // Code 1's payload is a bare string on the legacy kore server
  // (`test_client.py:321`) and an object on the booster.
  if (typeof value === "string") return { error: value };
  if (!isRecord(value)) return { error: value === undefined ? "" : JSON.stringify(value) };

  const error = typeof value["error"] === "string" ? value["error"] : JSON.stringify(value["error"] ?? null);
  const rawContext = value["context"];
  const context = isArray(rawContext)
    ? rawContext.map((item) => (typeof item === "string" ? item : JSON.stringify(item)))
    : undefined;
  const term = decodeTermOrUndefined(value["term"]);

  return {
    error,
    ...(context === undefined ? {} : { context }),
    ...(term === undefined ? {} : { term }),
  };
}

/**
 * A `term` inside an error payload: decoded when possible, dropped when not.
 *
 * Deliberately swallowing: the alternative is that a client handling a
 * `Could not parse pattern` reports a KORE-JSON decode failure instead, and
 * loses the actual complaint. The raw bytes survive in `KoreRpcError.data`.
 */
function decodeTermOrUndefined(value: unknown): KoreJson | undefined {
  if (!isRecord(value)) return undefined;
  try {
    return decodeKoreJson(value);
  } catch {
    return undefined;
  }
}

/** The list of details behind code 2, which is an array upstream but is often written as one object. */
function readDetails(value: JsonValue | undefined): readonly ErrorDetail[] {
  if (isArray(value)) return value.map((item) => readDetail(item));
  return [readDetail(value)];
}

/** A payload that upstream declares as a bare `Text` (codes 3, 6, 7, 9). */
function readText(value: JsonValue | undefined): string {
  if (typeof value === "string") return value;
  if (isRecord(value) && typeof value["error"] === "string") return value["error"];
  return value === undefined ? "" : JSON.stringify(value);
}

/**
 * Turn a decoded JSON-RPC `error` member into the typed exception for its code
 * — pyk `KoreClient._error` (`rpc.py:1074-1092`), extended with codes 6 and 7
 * and with the shape tolerance the header describes.
 *
 * Returns the error rather than throwing it, so a caller can attach a cause or
 * decide not to raise at all (a `-32000` after a deliberate `interrupt()` is
 * not an exceptional condition).
 */
export function koreRpcError(error: JsonRpcErrorObject): KoreRpcError {
  const { code, message, data } = error;
  switch (code) {
    case BACKEND_ERROR_CODES.couldNotParsePattern:
      return new ParseError(readDetail(data), data);
    case BACKEND_ERROR_CODES.couldNotVerifyPattern:
      return new PatternError(readDetails(data), data);
    case BACKEND_ERROR_CODES.couldNotFindModule:
      return new UnknownModuleError(readText(data), data);
    case BACKEND_ERROR_CODES.implicationCheckError:
      return new ImplicationError(readDetail(data), data);
    case BACKEND_ERROR_CODES.smtSolverError:
      return new SmtSolverError(readDetail(data), data);
    case BACKEND_ERROR_CODES.aborted:
      return new AbortedError(readText(data), data);
    case BACKEND_ERROR_CODES.multipleStates:
      return new MultipleStatesError(readText(data), data);
    case BACKEND_ERROR_CODES.invalidModule:
      return new InvalidModuleError(readDetail(data), data);
    case BACKEND_ERROR_CODES.duplicateModuleName:
      return new DuplicateModuleError(readText(data), data);
    default:
      return new DefaultError(message, code, data);
  }
}

/** Read a JSON-RPC `error` member and map it to its typed exception in one step. */
export function decodeKoreRpcError(value: unknown, path = "error"): KoreRpcError {
  return koreRpcError(decodeErrorObject(value, path));
}

/** Whether this error is the `-32000` a `cancel` notification produces (`Server.hs:134`). */
export function isCancelledError(error: KoreRpcError): boolean {
  return error.code === KORE_RPC_REQUEST_CANCELLED;
}
