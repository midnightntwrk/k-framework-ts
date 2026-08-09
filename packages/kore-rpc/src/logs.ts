/**
 * The two log families a kore-rpc response can carry.
 *
 * They are unrelated formats that happen to share a response object:
 *
 * - **`logs`** — `LogEntry` (`haskell-backend/kore-rpc-types/src/Kore/JsonRpc/Types/Log.hs`,
 *   the whole file), a tagged union of rewrite-trace records, derived
 *   mechanically from Haskell records with `CamelToKebab`.
 * - **`haskell-log-entries`** — `LogLine`
 *   (`kore-rpc-types/src/Kore/JsonRpc/Types/ContextLog.hs`, the whole file),
 *   the structured stderr log, requested per-request via `haskell-logging`.
 *   Its instances are **hand-written** upstream, so nothing about it can be
 *   inferred from a deriving clause; every field below is transcribed from the
 *   explicit `parseJSON`/`toJSON` at `ContextLog.hs:126-268`.
 *
 * pyk models the first family only, and only its `rewrite` tag
 * (`k/pyk/src/pyk/kore/rpc.py:598-680`); it keeps `haskell-log-entries` as raw
 * JSON (`rpc.py:683-690`).
 *
 * # What is actually emitted
 *
 * At v0.1.155 the only `LogEntry` tag any server produces is `rewrite`. There
 * is no producer for `simplification`, `fallback` or `processing-time` — they
 * are types without call sites. All four are transcribed anyway, because the
 * *type* is the contract and a fixture corpus recorded against an older or
 * newer server contains them.
 *
 * # Deliberate deviation: an unknown tag does not throw
 *
 * pyk raises `ValueError(f'Unsupported LogEntry tag: …')` on any tag but
 * `rewrite` (`rpc.py:602-605`), which means a pyk client breaks the moment a
 * server starts emitting a tag that has been in the *type* since 2023. That is
 * the wrong failure mode for a log field: logs are diagnostics attached to a
 * result the caller asked for, and losing the result because a diagnostic was
 * unfamiliar is strictly worse than not understanding the diagnostic. An
 * unrecognized tag decodes to {@link UnknownLogEntry}, which carries the raw
 * object and re-encodes to exactly the bytes it came from. The same applies to
 * an unrecognized {@link CLContext}.
 *
 * Structure that *is* understood is still strict: a `rewrite` entry missing
 * its `result`, or a `result` whose `tag` is neither `success` nor `failure`,
 * is a decode error with a JSON path.
 */

import {
  type JsonObject,
  type JsonValue,
  type KoreJson,
  decodeKoreJson,
  encodeKoreJsonValue,
} from "@kframework-ts/kore";
import { z } from "zod";
import {
  type MutableJsonObject,
  asEnum,
  asInt,
  asJson,
  asJsonObject,
  asNat,
  asNumber,
  asObject,
  asString,
  describe,
  exhausted,
  isArray,
  isRecord,
  optionalField,
  putOptional,
  readArray,
  requiredField,
  rpcError,
  sealObject,
} from "./internal.js";

//////////////////////
// Shared           //
//////////////////////

/** A KORE-JSON envelope as a plain JSON value, for the encode side. */
function koreJsonValue(term: KoreJson): JsonObject {
  return encodeKoreJsonValue(term.term);
}

function readKoreJson(value: unknown, path: string): KoreJson {
  return decodeKoreJson(value, { path });
}

//////////////////////
// logs: LogOrigin  //
//////////////////////

/**
 * Which server emitted a log entry — `LogOrigin` (`Log.hs:23-29`), kebab-cased
 * by `ConstructorTagModifier '[CamelToKebab]`.
 *
 * `proxy` is the synthetic origin `kore-rpc-booster` stamps on the entries it
 * fabricates when it silently continues past a one-survivor branch.
 */
export type LogOrigin = "kore-rpc" | "booster" | "llvm" | "proxy";

/** Every {@link LogOrigin}, in `Log.hs:23` declaration order. */
export const LOG_ORIGINS: readonly LogOrigin[] = ["kore-rpc", "booster", "llvm", "proxy"];

//////////////////////
// logs: results    //
//////////////////////

/**
 * `Success` (`Log.hs:32-36`).
 *
 * `rule-id` is required here and optional on {@link RewriteFailure} — the
 * asymmetry is upstream's (`ruleId :: !Text` versus `_ruleId :: !(Maybe Text)`,
 * the underscore stripped by `StripPrefix "_"`), not ours: a rewrite that
 * succeeded knows which rule did it, one that failed may have failed before
 * choosing.
 */
export interface RewriteSuccess {
  readonly tag: "success";
  readonly rewrittenTerm?: KoreJson;
  readonly substitution?: KoreJson;
  readonly ruleId: string;
}

/** `Failure` (`Log.hs:37-40`). */
export interface RewriteFailure {
  readonly tag: "failure";
  readonly reason: string;
  readonly ruleId?: string;
}

/** `LogRewriteResult` (`Log.hs:31-49`). */
export type LogRewriteResult = RewriteSuccess | RewriteFailure;

//////////////////////
// logs: entries    //
//////////////////////

/** `Rewrite` (`Log.hs:52-55`) — the only tag any v0.1.155 server emits. */
export interface RewriteLogEntry {
  readonly tag: "rewrite";
  readonly result: LogRewriteResult;
  readonly origin: LogOrigin;
}

/** `Simplification` (`Log.hs:56-61`). */
export interface SimplificationLogEntry {
  readonly tag: "simplification";
  readonly originalTerm?: KoreJson;
  readonly originalTermIndex?: readonly number[];
  readonly result: LogRewriteResult;
  readonly origin: LogOrigin;
}

/**
 * `Fallback` (`Log.hs:62-78`) — a proxy handing a step it could not take to
 * the slower server behind it.
 *
 * `recovery-rule-ids` is a `NonEmpty` upstream, so an empty array is a decode
 * error rather than an empty list.
 */
export interface FallbackLogEntry {
  readonly tag: "fallback";
  /** State before the fallback. */
  readonly originalTerm?: KoreJson;
  /** State after the fallback. */
  readonly rewrittenTerm?: KoreJson;
  readonly reason: string;
  /** The rule that caused the fallback. */
  readonly fallbackRuleId: string;
  /** Rules applied during the fallback; the first is the one that caused it. */
  readonly recoveryRuleIds?: readonly string[];
  /** Depth reached in the fallback — a `Depth`, hence a non-negative integer. */
  readonly recoveryDepth: number;
  readonly origin: LogOrigin;
}

/** `ProcessingTime` (`Log.hs:79-83`) — summatory timing, by origin or overall. */
export interface ProcessingTimeLogEntry {
  readonly tag: "processing-time";
  readonly component?: LogOrigin;
  /** Seconds, as a Haskell `Double`. */
  readonly time: number;
}

/**
 * A `logs` entry whose `tag` this package does not know — the catch-all that
 * keeps an unfamiliar diagnostic from destroying a good result. See the header.
 *
 * `tag` is spelled out rather than reusing the wire tag so that narrowing on
 * {@link LogEntry} stays exhaustive; the wire tag is preserved in
 * {@link logTag}, and {@link raw} re-encodes byte-identically.
 */
export interface UnknownLogEntry {
  readonly tag: "unknown-log-entry";
  /** The `tag` the server actually sent. */
  readonly logTag: string;
  readonly raw: JsonObject;
}

/** `LogEntry` (`Log.hs:51-89`), plus this package's catch-all. */
export type LogEntry =
  | RewriteLogEntry
  | SimplificationLogEntry
  | FallbackLogEntry
  | ProcessingTimeLogEntry
  | UnknownLogEntry;

//////////////////////
// logs: decoding   //
//////////////////////

function decodeRewriteResult(value: unknown, path: string): LogRewriteResult {
  const obj = asObject(value, path);
  const tag = obj["tag"];
  if (tag === "success") {
    const rewrittenTerm = optionalField(obj, "rewritten-term", path, readKoreJson);
    const substitution = optionalField(obj, "substitution", path, readKoreJson);
    return {
      tag: "success",
      ...(rewrittenTerm === undefined ? {} : { rewrittenTerm }),
      ...(substitution === undefined ? {} : { substitution }),
      ruleId: requiredField(obj, "rule-id", path, "success", asString),
    };
  }
  if (tag === "failure") {
    const ruleId = optionalField(obj, "rule-id", path, asString);
    return {
      tag: "failure",
      reason: requiredField(obj, "reason", path, "failure", asString),
      ...(ruleId === undefined ? {} : { ruleId }),
    };
  }
  // pyk's message, near enough: `Expected {tag} as 'success'/'failure'`
  // (`rpc.py:645`).  Unlike an unknown *entry* tag this one does throw: the
  // two-constructor result type is the structure we understand, and a third
  // constructor would change what a rewrite trace means.
  throw rpcError(`Expected a "success" or "failure" rewrite result, got ${describe(tag)}`, `${path}.tag`);
}

function decodeOrigin(value: unknown, path: string): LogOrigin {
  return asEnum(value, path, LOG_ORIGINS, "log origin");
}

/** Read one `logs` entry. Unknown tags become {@link UnknownLogEntry}. */
export function decodeLogEntry(value: unknown, path = "logs"): LogEntry {
  const obj = asObject(value, path);
  const tag = obj["tag"];

  switch (tag) {
    case "rewrite":
      return {
        tag: "rewrite",
        result: requiredField(obj, "result", path, "rewrite", decodeRewriteResult),
        origin: requiredField(obj, "origin", path, "rewrite", decodeOrigin),
      };

    case "simplification": {
      const originalTerm = optionalField(obj, "original-term", path, readKoreJson);
      const originalTermIndex = optionalField(obj, "original-term-index", path, (v, p) => readArray(v, p, asInt));
      return {
        tag: "simplification",
        ...(originalTerm === undefined ? {} : { originalTerm }),
        ...(originalTermIndex === undefined ? {} : { originalTermIndex }),
        result: requiredField(obj, "result", path, "simplification", decodeRewriteResult),
        origin: requiredField(obj, "origin", path, "simplification", decodeOrigin),
      };
    }

    case "fallback": {
      const originalTerm = optionalField(obj, "original-term", path, readKoreJson);
      const rewrittenTerm = optionalField(obj, "rewritten-term", path, readKoreJson);
      const recoveryRuleIds = optionalField(obj, "recovery-rule-ids", path, (v, p) => {
        const ids = readArray(v, p, asString);
        // `NonEmpty Text` (`Log.hs:72`); aeson rejects `[]`.
        if (ids.length === 0) throw rpcError("fallback requires at least one recovery rule id", p);
        return ids;
      });
      return {
        tag: "fallback",
        ...(originalTerm === undefined ? {} : { originalTerm }),
        ...(rewrittenTerm === undefined ? {} : { rewrittenTerm }),
        reason: requiredField(obj, "reason", path, "fallback", asString),
        fallbackRuleId: requiredField(obj, "fallback-rule-id", path, "fallback", asString),
        ...(recoveryRuleIds === undefined ? {} : { recoveryRuleIds }),
        recoveryDepth: requiredField(obj, "recovery-depth", path, "fallback", asNat),
        origin: requiredField(obj, "origin", path, "fallback", decodeOrigin),
      };
    }

    case "processing-time": {
      const component = optionalField(obj, "component", path, decodeOrigin);
      return {
        tag: "processing-time",
        ...(component === undefined ? {} : { component }),
        time: requiredField(obj, "time", path, "processing-time", asNumber),
      };
    }

    default: {
      if (typeof tag !== "string") {
        throw rpcError(`Expected a string log entry tag, got ${describe(tag)}`, `${path}.tag`);
      }
      return { tag: "unknown-log-entry", logTag: tag, raw: asJsonObject(obj, path) };
    }
  }
}

/** Read a whole `logs` array. */
export function decodeLogEntries(value: unknown, path = "logs"): readonly LogEntry[] {
  return readArray(value, path, decodeLogEntry);
}

//////////////////////
// logs: encoding   //
//////////////////////

function encodeRewriteResult(result: LogRewriteResult): JsonObject {
  const out: MutableJsonObject = { tag: result.tag };
  if (result.tag === "success") {
    putOptional(out, "rewritten-term", result.rewrittenTerm && koreJsonValue(result.rewrittenTerm));
    putOptional(out, "substitution", result.substitution && koreJsonValue(result.substitution));
    out["rule-id"] = result.ruleId;
  } else {
    out["reason"] = result.reason;
    putOptional(out, "rule-id", result.ruleId);
  }
  return sealObject(out);
}

/**
 * Write one `logs` entry.
 *
 * Key order is `tag` first, then `Log.hs` declaration order — fixed, so output
 * is diffable, but not byte-identical to the Haskell server's, which orders by
 * `rpcJsonConfig`. Use `keyorder.ts`'s `emitOrdered` on the result when bytes
 * matter.
 */
export function encodeLogEntry(entry: LogEntry): JsonObject {
  switch (entry.tag) {
    case "rewrite":
      return { tag: "rewrite", result: encodeRewriteResult(entry.result), origin: entry.origin };

    case "simplification": {
      const out: MutableJsonObject = { tag: "simplification" };
      putOptional(out, "original-term", entry.originalTerm && koreJsonValue(entry.originalTerm));
      putOptional(out, "original-term-index", entry.originalTermIndex && [...entry.originalTermIndex]);
      out["result"] = encodeRewriteResult(entry.result);
      out["origin"] = entry.origin;
      return sealObject(out);
    }

    case "fallback": {
      const out: MutableJsonObject = { tag: "fallback" };
      putOptional(out, "original-term", entry.originalTerm && koreJsonValue(entry.originalTerm));
      putOptional(out, "rewritten-term", entry.rewrittenTerm && koreJsonValue(entry.rewrittenTerm));
      out["reason"] = entry.reason;
      out["fallback-rule-id"] = entry.fallbackRuleId;
      putOptional(out, "recovery-rule-ids", entry.recoveryRuleIds && [...entry.recoveryRuleIds]);
      out["recovery-depth"] = entry.recoveryDepth;
      out["origin"] = entry.origin;
      return sealObject(out);
    }

    case "processing-time": {
      const out: MutableJsonObject = { tag: "processing-time" };
      putOptional(out, "component", entry.component);
      out["time"] = entry.time;
      return sealObject(out);
    }

    case "unknown-log-entry":
      // Verbatim: we did not understand it, so we have no licence to reshape it.
      return entry.raw;
    default:
      return exhausted(entry);
  }
}

/** Write a whole `logs` array. */
export function encodeLogEntries(entries: readonly LogEntry[]): readonly JsonValue[] {
  return entries.map(encodeLogEntry);
}

//////////////////////////
// ContextLog: contexts //
//////////////////////////

/**
 * `SimpleContext` (`ContextLog.hs:24-72`) — the 30 nullary context tags, as
 * `camelTo2 '-' . drop 3` renders each constructor name.
 *
 * The three that are not a straight lowercasing are worth reading twice:
 * `CtxSMT` becomes `smt` (aeson's `camelTo2` inserts no separator inside an
 * all-caps run), `CtxLlvm` becomes `llvm`, and `CtxKoreTerm` becomes
 * `kore-term`. `CtxGetModel`/`CtxAddModule` become the method names.
 *
 * Listed in declaration order, which is also `Enum`/`Ord` order upstream.
 */
export const SIMPLE_CONTEXTS = [
  // component
  "booster",
  "kore",
  "proxy",
  // method
  "execute",
  "simplify",
  "implies",
  "get-model",
  "add-module",
  // mode/phase
  "internalise",
  "match",
  "unify",
  "definedness",
  "constraint",
  "smt",
  "llvm",
  // results
  "failure",
  "indeterminate",
  "abort",
  "success",
  "break",
  "continue",
  // information
  "kore-term",
  "detail",
  "substitution",
  "remainder",
  "depth",
  "timing",
  // standard log levels
  "error",
  "warn",
  "info",
] as const;

/** One of the 30 {@link SIMPLE_CONTEXTS}. */
export const SimpleContextSchema = z.enum(SIMPLE_CONTEXTS);
export type SimpleContext = z.infer<typeof SimpleContextSchema>;

/**
 * `UniqueId` (`ContextLog.hs:108-137`).
 *
 * On the wire it is a bare string; the three constructors are distinguished by
 * *length* — `parseUId` (`ContextLog.hs:119-124`) accepts exactly 7 characters
 * (`ShortId`), exactly 64 (`LongId`), or the literal `"UNKNOWN"`, and rejects
 * everything else. `kind` records which, so a caller can tell a truncated hash
 * from a full one without measuring.
 */
export const UniqueIdSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("short"), value: z.string() }),
  z.object({ kind: z.literal("long"), value: z.string() }),
  z.object({ kind: z.literal("unknown"), value: z.string() }),
]);
export type UniqueId = z.infer<typeof UniqueIdSchema>;

/** `parseUId` (`ContextLog.hs:119-124`). Returns `undefined` where upstream returns `Nothing`. */
export function parseUniqueId(text: string): UniqueId | undefined {
  if (text === "UNKNOWN") return { kind: "unknown", value: "UNKNOWN" };
  if (text.length === 7) return { kind: "short", value: text };
  if (text.length === 64) return { kind: "long", value: text };
  return undefined;
}

/** The five `IdContext` constructors carrying a {@link UniqueId} (`ContextLog.hs:76-81`). */
export const ID_CONTEXT_KINDS = ["rewrite", "simplification", "function", "ceil", "term"] as const;

/** The three `IdContext` constructors carrying a plain name (`ContextLog.hs:82-85`). */
export const NAME_CONTEXT_KINDS = ["hook", "request", "cached"] as const;

export const IdContextKindSchema = z.enum(ID_CONTEXT_KINDS);
export type IdContextKind = z.infer<typeof IdContextKindSchema>;
export const NameContextKindSchema = z.enum(NAME_CONTEXT_KINDS);
export type NameContextKind = z.infer<typeof NameContextKindSchema>;

/** `CLNullary` (`ContextLog.hs:149`) — a bare string on the wire. */
export interface SimpleCLContext {
  readonly tag: "simple";
  readonly context: SimpleContext;
}

/** Structural decoded nullary context frame. */
export const SimpleCLContextSchema: z.ZodType<SimpleCLContext, SimpleCLContext> = z.object({
  tag: z.literal("simple"),
  context: SimpleContextSchema,
});

/** A recognized nullary context frame, transformed from its wire string. */
export const SimpleCLContextWireSchema: z.ZodType<SimpleCLContext, SimpleContext> = SimpleContextSchema.transform(
  (context): SimpleCLContext => ({ tag: "simple" as const, context }),
).pipe(SimpleCLContextSchema);

/** `CLWithId (CtxRewrite …)` and friends — `{"rewrite": "0123abc"}`, one key. */
export interface IdCLContext {
  readonly tag: "id";
  readonly kind: IdContextKind;
  readonly id: UniqueId;
}

const UniqueIdWireSchema = z.union([z.literal("UNKNOWN"), z.string().length(7), z.string().length(64)]);

/** Structural decoded one-key id context frame. */
export const IdCLContextSchema: z.ZodType<IdCLContext, IdCLContext> = z.object({
  tag: z.literal("id"),
  kind: IdContextKindSchema,
  id: UniqueIdSchema,
});

const IdCLContextWireInputSchema = z.union([
  z.object({ rewrite: UniqueIdWireSchema }).strict(),
  z.object({ simplification: UniqueIdWireSchema }).strict(),
  z.object({ function: UniqueIdWireSchema }).strict(),
  z.object({ ceil: UniqueIdWireSchema }).strict(),
  z.object({ term: UniqueIdWireSchema }).strict(),
]);

/** A recognized one-key id context frame, transformed from its wire object. */
export const IdCLContextWireSchema: z.ZodType<
  IdCLContext,
  z.input<typeof IdCLContextWireInputSchema>
> = IdCLContextWireInputSchema.transform((frame) => {
  const [kind, value] = Object.entries(frame)[0] ?? [];
  if (typeof kind !== "string" || typeof value !== "string") throw new TypeError("invalid id context frame");
  const id = parseUniqueId(value);
  const parsedKind = IdContextKindSchema.safeParse(kind);
  if (id === undefined || !parsedKind.success) throw new TypeError("invalid id context frame");
  return { tag: "id", kind: parsedKind.data, id } satisfies IdCLContext;
}).pipe(IdCLContextSchema);

/** `CLWithId (CtxHook …)` and friends — `{"hook": "INT.add"}`, one key. */
export interface NameCLContext {
  readonly tag: "name";
  readonly kind: NameContextKind;
  readonly name: string;
}

/** Structural decoded one-key named context frame. */
export const NameCLContextSchema: z.ZodType<NameCLContext, NameCLContext> = z.object({
  tag: z.literal("name"),
  kind: NameContextKindSchema,
  name: z.string(),
});

const NameCLContextWireInputSchema = z.union([
  z.object({ hook: z.string() }).strict(),
  z.object({ request: z.string() }).strict(),
  z.object({ cached: z.string() }).strict(),
]);

/** A recognized one-key named context frame, transformed from its wire object. */
export const NameCLContextWireSchema: z.ZodType<
  NameCLContext,
  z.input<typeof NameCLContextWireInputSchema>
> = NameCLContextWireInputSchema.transform((frame) => {
  const [kind, name] = Object.entries(frame)[0] ?? [];
  const parsedKind = NameContextKindSchema.safeParse(kind);
  if (typeof name !== "string" || !parsedKind.success) {
    throw new TypeError("invalid name context frame");
  }
  return { tag: "name", kind: parsedKind.data, name } satisfies NameCLContext;
}).pipe(NameCLContextSchema);

/**
 * A context this package does not recognize, preserved verbatim.
 *
 * Upstream fails the parse (`ContextLog.hs:161-168` falls through to
 * `typeMismatch`, and an unlisted string fails the derived `SimpleContext`
 * instance). We do not, for the reason in the header: a context stack is
 * diagnostic metadata, and one unfamiliar frame must not cost the caller the
 * whole response.
 */
export interface RawCLContext {
  readonly tag: "raw";
  readonly raw: JsonValue;
}

/** The forward-compatible decoded form of an unrecognized context frame. */
export const RawCLContextSchema: z.ZodType<RawCLContext, RawCLContext> = z.object({
  tag: z.literal("raw"),
  raw: z.json().transform((value): JsonValue => value),
});

/** `CLContext` (`ContextLog.hs:148-168`), plus this package's catch-all. */
export type CLContext = SimpleCLContext | IdCLContext | NameCLContext | RawCLContext;

/** Any JSON frame is valid at the wire boundary; unfamiliar frames are retained raw. */
export const CLContextWireSchema: z.ZodType<JsonValue, JsonValue> = z.json().transform((value): JsonValue => value);

const RawCLContextWireSchema: z.ZodType<RawCLContext, JsonValue> = CLContextWireSchema.transform(
  (raw): RawCLContext => ({ tag: "raw", raw }),
).pipe(RawCLContextSchema);

/** A context frame decoded with the package's forward-compatible context reader. */
export const CLContextSchema: z.ZodType<CLContext, JsonValue> = z.union([
  SimpleCLContextWireSchema,
  IdCLContextWireSchema,
  NameCLContextWireSchema,
  RawCLContextWireSchema,
]);

function isSimpleContext(text: string): text is SimpleContext {
  return (SIMPLE_CONTEXTS as readonly string[]).includes(text);
}

/** Read one entry of a `context` array. Never throws for an unrecognized shape. */
export function decodeCLContext(value: unknown, path = "context"): CLContext {
  if (typeof value === "string") {
    return isSimpleContext(value) ? { tag: "simple", context: value } : { tag: "raw", raw: value };
  }
  if (isRecord(value)) {
    const keys = Object.keys(value);
    const key = keys[0];
    // `ObjectWithSingleField` (`ContextLog.hs:139-145`): exactly one key.
    if (keys.length === 1 && key !== undefined) {
      const payload = value[key];
      if (typeof payload === "string") {
        for (const kind of ID_CONTEXT_KINDS) {
          if (key !== kind) continue;
          const id = parseUniqueId(payload);
          // A payload that is not 7 characters, 64 characters or UNKNOWN is not
          // a `UniqueId`; upstream would fail the parse, so we keep it raw
          // rather than inventing a fourth constructor. `parseUId`
          // (`ContextLog.hs:119-124`) checks *length* and nothing else — the
          // FromJSON wrapper calls its helper `parseHex`, but no digit of it is
          // ever validated as hex, here or upstream.
          return id === undefined ? { tag: "raw", raw: asJson(value, path) } : { tag: "id", kind, id };
        }
        for (const kind of NAME_CONTEXT_KINDS) {
          if (key === kind) return { tag: "name", kind, name: payload };
        }
      }
    }
  }
  return { tag: "raw", raw: asJson(value, path) };
}

/** Write one `context` entry. */
export function encodeCLContext(context: CLContext): JsonValue {
  switch (context.tag) {
    case "simple":
      return context.context;
    case "id":
      return { [context.kind]: context.id.value };
    case "name":
      return { [context.kind]: context.name };
    case "raw":
      return context.raw;
    default:
      return exhausted(context);
  }
}

//////////////////////////
// ContextLog: messages //
//////////////////////////

/**
 * `CLMessage` (`ContextLog.hs:199-219`).
 *
 * A JSON string is text; an object, an array or `null` is a value kept as-is.
 * A number or a boolean is neither, and upstream's `typeMismatch`
 * (`ContextLog.hs:214-215`) rejects it — this is structure we understand, so
 * we reject it too.
 */
export type CLMessage =
  | { readonly tag: "text"; readonly text: string }
  | { readonly tag: "value"; readonly value: JsonValue };

const CLMessageWireSchema: z.ZodType<JsonValue, JsonValue> = z
  .union([z.string(), z.null(), z.array(z.json()), z.record(z.string(), z.json())])
  .transform((value): JsonValue => value);

const DecodedCLMessageSchema: z.ZodType<CLMessage, CLMessage> = z.union([
  z.object({ tag: z.literal("text"), text: z.string() }),
  z.object({ tag: z.literal("value"), value: z.json().transform((value): JsonValue => value) }),
]);

/** A decoded context-log message, preserving structured JSON values verbatim. */
export const CLMessageSchema: z.ZodType<CLMessage, JsonValue> = CLMessageWireSchema.transform(
  (value): CLMessage => decodeCLMessage(value),
).pipe(DecodedCLMessageSchema);

export function decodeCLMessage(value: unknown, path = "message"): CLMessage {
  if (typeof value === "string") return { tag: "text", text: value };
  if (value === null || isRecord(value) || isArray(value)) return { tag: "value", value: asJson(value, path) };
  throw rpcError(`Expected an object, array, or string message, got ${describe(value)}`, path);
}

export function encodeCLMessage(message: CLMessage): JsonValue {
  return message.tag === "text" ? message.text : message.value;
}

////////////////////////////
// ContextLog: timestamps //
////////////////////////////

/**
 * Haskell's `SystemTime` — whole seconds since the epoch plus a nanosecond
 * remainder (`ContextLog.hs:222`, via `Data.Time.Clock.System`).
 *
 * Kept as the pair rather than as a JS `Date` because `Date` has millisecond
 * resolution, and these logs time simplification steps.
 */
export const SystemTimeSchema = z.object({ seconds: z.number(), nanos: z.number() });
export type SystemTime = z.infer<typeof SystemTimeSchema>;

/**
 * `timestampFormat` (`ContextLog.hs:267-268`) — `%Y-%m-%dT%H:%M:%S%Q`, i.e.
 * ISO 8601 with no zone marker and a `%Q` fraction that is omitted entirely
 * for a whole number of seconds and carries no trailing zeros otherwise.
 *
 * **One or two digits** for every component but the year, because that is what
 * `parseTimeM` does with this format string: `%m`, `%d`, `%H`, `%M` and `%S`
 * each accept an optionally-zero-padded number, so `"2024-1-2T3:4:5"` is a
 * timestamp upstream reads and this decoder must too. `%Y` is the exception —
 * it wants at least four digits — and so is a leap second, which `%S` accepts
 * as `60` (see {@link decodeTimestamp} for what happens to it).
 */
const TIMESTAMP_PATTERN = /^(\d{4,})-(\d{1,2})-(\d{1,2})T(\d{1,2}):(\d{1,2}):(\d{1,2})(?:\.(\d+))?$/u;

/** `fromNumeric` (`ContextLog.hs:243-246`) — truncate toward zero, no leap seconds. */
function fromNumeric(n: number): SystemTime {
  const seconds = Math.trunc(n);
  return { seconds, nanos: Math.trunc(1e9 * (n - seconds)) };
}

/**
 * `parseTimestamp` (`ContextLog.hs:235-253`), in upstream's alternative order:
 * a JSON number first, then the human-readable string, then a bare digit
 * string.
 *
 * **Upstream quirk, transcribed rather than repaired:** the third branch is
 * named `fromNanos` and documented as a nanosecond timestamp, but its body is
 * `fromNumeric (fromIntegral n :: Double)` (`ContextLog.hs:250-253`) — which
 * reads the integer as *seconds* and always yields `nanos = 0`. A string
 * `"1700000000"` therefore decodes to 1700000000 seconds, not 1.7 seconds.
 * Matching the reference decoder matters more here than matching its docstring.
 */
export function decodeTimestamp(value: unknown, path = "timestamp"): SystemTime {
  // Through the house reader, so a non-finite number is the decode error it is
  // everywhere else in this package: `fromNumeric(Infinity)` would otherwise
  // hand back `{seconds: Infinity, nanos: NaN}`, which encodes to `"Invalid
  // Date"` and compares equal to nothing.
  if (typeof value === "number") return fromNumeric(asNumber(value, path));
  if (typeof value === "string") {
    const match = TIMESTAMP_PATTERN.exec(value);
    if (match !== null) {
      const [, year, month, day, hour, minute, second, fraction] = match;
      // Not `Date.UTC`, whose special two-digit-year rule maps 0-99 onto 1900-1999:
      // `Date.UTC(99, 0, 1)` is 1999, so a year-99 timestamp round-tripped to
      // 1999 and back. `setUTCFullYear` has no such rule. A `%S` of `60` — a
      // leap second, which `parseTimeM` accepts — rolls into the next minute
      // here, which is the same thing every non-leap-aware clock does with it.
      const date = new Date(0);
      date.setUTCFullYear(Number(year), Number(month) - 1, Number(day));
      date.setUTCHours(Number(hour), Number(minute), Number(second), 0);
      const millis = date.getTime();
      if (!Number.isNaN(millis)) {
        const nanos = fraction === undefined ? 0 : Number(fraction.slice(0, 9).padEnd(9, "0"));
        return { seconds: Math.trunc(millis / 1000), nanos };
      }
    }
    // The misnamed `fromNanos` branch: a bare integer, read as seconds. Also
    // through `asNumber`, since a long enough run of digits overflows to
    // `Infinity` just as `1e400` does.
    if (/^-?\d+$/u.test(value)) return fromNumeric(asNumber(Number(value), path));
    throw rpcError(`Bad timestamp: ${JSON.stringify(value)}`, path);
  }
  throw rpcError(`Expected a timestamp, got ${describe(value)}`, path);
}

/** Zero-padded decimal, for the timestamp formatter. */
function pad(n: number, width = 2): string {
  return String(n).padStart(width, "0");
}

/** `formatTime defaultTimeLocale timestampFormat` (`ContextLog.hs:256-264`). */
export function encodeTimestamp(time: SystemTime): string {
  const date = new Date(time.seconds * 1000);
  const base =
    `${pad(date.getUTCFullYear(), 4)}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}` +
    `T${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())}`;
  // `%Q`: a decimal point and the fraction, without trailing zeros; the empty
  // string for a whole number of seconds.
  const fraction = pad(time.nanos, 9).replace(/0+$/u, "");
  return fraction === "" ? base : `${base}.${fraction}`;
}

////////////////////////////
// ContextLog: LogLine    //
////////////////////////////

/**
 * `LogLine` (`ContextLog.hs:221-232`) — one entry of `haskell-log-entries`.
 *
 * `context` and `message` are read with `.:` upstream and are therefore
 * required; only `timestamp` is `.:?`. The `ToJSON` instance
 * (`ContextLog.hs:255-262`) omits `timestamp` when absent, which is why it is
 * optional here rather than nullable.
 */
export interface LogLine {
  readonly timestamp?: SystemTime;
  readonly context: readonly CLContext[];
  readonly message: CLMessage;
}

/** Structural context-log record as it appears in a JSON-RPC result. */
export const LogLineWireSchema = z.object({
  timestamp: z.union([z.string(), z.number()]).nullable().optional(),
  context: z.array(CLContextWireSchema),
  message: CLMessageWireSchema,
});

const LogLineTimestampSchema = z
  .union([z.string(), z.number()])
  .nullable()
  .optional()
  .transform((timestamp): SystemTime | undefined =>
    timestamp === undefined || timestamp === null ? undefined : decodeTimestamp(timestamp),
  )
  .pipe(z.union([SystemTimeSchema, z.undefined()]));

const DecodedLogLineSchema: z.ZodType<LogLine, z.output<typeof LogLineWireSchema>> = z
  .object({
    timestamp: LogLineTimestampSchema,
    context: z.array(CLContextSchema),
    message: CLMessageSchema,
  })
  .transform(
    (line): LogLine => ({
      ...(line.timestamp === undefined ? {} : { timestamp: line.timestamp }),
      context: line.context,
      message: line.message,
    }),
  );

/** A context-log record transformed by the established timestamp/context/message decoders. */
export const LogLineSchema: z.ZodType<LogLine, z.input<typeof LogLineWireSchema>> = LogLineWireSchema.pipe(
  DecodedLogLineSchema,
);

export function decodeLogLine(value: unknown, path = "haskell-log-entries"): LogLine {
  const obj = asObject(value, path);
  const timestamp = optionalField(obj, "timestamp", path, decodeTimestamp);
  return {
    ...(timestamp === undefined ? {} : { timestamp }),
    context: requiredField(obj, "context", path, "LogLine", (v, p) => readArray(v, p, decodeCLContext)),
    message: requiredField(obj, "message", path, "LogLine", decodeCLMessage),
  };
}

export function decodeLogLines(value: unknown, path = "haskell-log-entries"): readonly LogLine[] {
  return readArray(value, path, decodeLogLine);
}

/** Write one `LogLine`, in upstream's key order: `timestamp`, `context`, `message`. */
export function encodeLogLine(line: LogLine): JsonObject {
  const out: MutableJsonObject = {};
  putOptional(out, "timestamp", line.timestamp && encodeTimestamp(line.timestamp));
  out["context"] = line.context.map(encodeCLContext);
  out["message"] = encodeCLMessage(line.message);
  return sealObject(out);
}

export function encodeLogLines(lines: readonly LogLine[]): readonly JsonValue[] {
  return lines.map(encodeLogLine);
}
