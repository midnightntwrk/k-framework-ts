/**
 * The kore-rpc wire types — every request parameter object and every result
 * object of the five payload methods.
 *
 * Transcribed from `haskell-backend/kore-rpc-types/src/Kore/JsonRpc/Types.hs`
 * (the whole file) and `Types/Depth.hs`, cross-checked against the reference
 * client (`k/pyk/src/pyk/kore/rpc.py`) and its unit-test oracle
 * (`k/pyk/src/tests/unit/kore/test_client.py`). The prose specification at
 * `haskell-backend/docs/2022-07-18-JSON-RPC-Server-API.md` is **stale** and
 * disagrees with the code in two places that would break a client written from
 * it — it says `implies` returns `valid: bool` (it returns a tri-state
 * `status`) and that `get-model` returns `valid` (it returns `satisfiable`).
 * `Types.hs` is the authority throughout.
 *
 * # Two mechanical rules generate every field name
 *
 * Each record derives `CustomJSON '[OmitNothingFields, FieldLabelModifier
 * '[CamelToKebab, StripPrefix "_"]]`, which means:
 *
 * 1. **Kebab-case.** `maxDepth` is `max-depth`, `logSuccessfulRewrites` is
 *    `log-successful-rewrites`, `haskellLogEntries` is `haskell-log-entries`.
 * 2. **`_module` is `module`.** The leading underscore only exists because
 *    `module` is a Haskell keyword; `StripPrefix "_"` removes it.
 *
 * Two enums escape the kebab rule and must be spelled by hand: `SatResult`
 * derives `CustomJSON '[]` with *no* tag modifier (`Types.hs:227-234`), so its
 * values are the capitalized constructor names `Sat` / `Unsat` / `Unknown`.
 * (`--fallback-on`'s `Branching|Stuck|Aborted` is the other, but that is a CLI
 * flag, not a wire value.)
 *
 * `OmitNothingFields` is the third rule and the one a hand-written encoder
 * gets wrong: an absent optional is an **absent key**, never `null`. Every
 * optional below is spelled `field?: T` and never `field: T | null`, and
 * `codec.ts` has no path that writes a null.
 *
 * # Sole derivation quirk
 *
 * `AddModuleRequest` (`Types.hs:82-90`) is the one record without
 * `OmitNothingFields`. It makes no observable difference — its only optionals
 * are `name-as-id` and `haskell-logging`, and aeson's encoder for a `Maybe`
 * field without that option writes `null` rather than omitting — so a
 * *server* would emit nulls there. As a client we always omit, which is what
 * pyk does (`filter_none`, `rpc.py:1200-1210`) and what the server's own
 * decoder accepts either way.
 *
 * # Types this module deliberately does not define
 *
 * `LogEntry` and `LogLine` live in `logs.ts`; the error taxonomy lives in
 * `errors.ts`. Both are re-exported by the barrel.
 */

import { type JsonValue, type KoreJson, type Pattern, KORE_JSON_FORMAT, KORE_JSON_VERSION } from "@kframework-ts/kore";
import type { LogEntry, LogLine } from "./logs.js";

//////////////////////
// Envelopes        //
//////////////////////

/**
 * Wrap a pattern in the KORE-JSON envelope every term-valued field of this
 * protocol expects — `{"format":"KORE","version":1,"term":…}`.
 *
 * `@kframework-ts/kore` has the envelope *type* and both codecs but no
 * constructor, because nothing in that package ever needs to build one; here
 * every request does, so this is the factory. It is the exact counterpart of
 * pyk's `KoreClient._state` (`rpc.py:1094-1100`), which is a static method for
 * the same reason.
 */
export function koreJson(term: Pattern): KoreJson {
  return { format: KORE_JSON_FORMAT, version: KORE_JSON_VERSION, term };
}

//////////////////////
// Framing          //
//////////////////////

/**
 * `V2` (`Server.hs:99`) — the only JSON-RPC version kore-rpc speaks.
 */
export const JSONRPC_VERSION = "2.0";

/**
 * Responses are `\n`-terminated, one single-line document each
 * (`Server.hs:91-98`: `confIndent = Spaces 0, confTrailingNewline = True`).
 *
 * This is the *response* framing only; requests need no delimiter, since the
 * server decodes them from a stream. The terminator lives here rather than in
 * a transport because it is a fact about the protocol, and the transport is a
 * separate module that has not been written yet.
 */
export const RESPONSE_TERMINATOR = "\n";

/** The five payload methods (`Types.hs:107-114`), in `parseParams` order. */
export const KORE_RPC_METHODS = ["execute", "implies", "simplify", "add-module", "get-model"] as const;

/** One of {@link KORE_RPC_METHODS}. */
export type KoreRpcMethod = (typeof KORE_RPC_METHODS)[number];

/**
 * `cancel` (`Types.hs:113`) — not a payload method.
 *
 * It is a side-channel notification written onto a socket that already has a
 * request in flight; the server answers it with nothing at all and rejects the
 * *pending* call with `-32000` instead (`Server.hs:121-134`).
 */
export const CANCEL_METHOD = "cancel";

/** A JSON-RPC request id. kore-rpc never inspects it; it echoes it. */
export type RequestId = string | number;

//////////////////////
// Depth            //
//////////////////////

/**
 * `Depth` (`Types/Depth.hs:6`) — a `newtype` over `Natural`, i.e. an unbounded
 * **non-negative** integer.
 *
 * An alias for `number`, so it is documentation rather than enforcement at the
 * type level; `codec.ts` does enforce it, rejecting a negative or fractional
 * `depth` exactly as aeson's `FromJSON Natural` does.
 */
export type Depth = number;

//////////////////////
// execute          //
//////////////////////

/**
 * `execute` request parameters — `ExecuteRequest` (`Types.hs:39-56`), in field
 * order.
 *
 * Notes on the ones whose behaviour is not obvious from the name:
 *
 * - `stepTimeout` is **milliseconds** and is kore-only; a booster rejects it
 *   with `-32003 Unsupported option` (`Booster/JsonRpc.hs:111`, the error
 *   constructor at `Error.hs:42`). It is a plain `Maybe Int` upstream
 *   (`Types.hs:46`) and not a `Depth`, so a negative value is a *decodable*
 *   request, which is why `codec.ts` reads it with `asInt`.
 * - `movingAverageStepTimeout` makes the timeout adaptive rather than fixed.
 *   Booster-incompatible for the same reason and in the same place: it is
 *   rejected with `-32003 Unsupported option` too
 *   (`Booster/JsonRpc.hs:112-113`), one guard below `step-timeout`'s.
 * - `assumeStateDefined` skips the definedness check on the incoming state.
 * - `logFailedRewrites` is ignored by the legacy kore server.
 * - `boosterOnly` suppresses the proxy's escalation to kore, which is the only
 *   way `status: "indeterminate"` and `reason: "aborted"` reach a client.
 * - `haskellLogging` selects which context-log capture groups come back in
 *   `haskell-log-entries`; the names are the CamelCase constructor names of
 *   `CLContext` (`ContextLog.hs:170-181`), e.g. `"Proxy"`, `"Rewrite"`.
 */
export interface ExecuteParams {
  readonly state: KoreJson;
  readonly maxDepth?: Depth;
  /** `_module` upstream — the module to execute in, defaulting to the server's. */
  readonly module?: string;
  readonly cutPointRules?: readonly string[];
  readonly terminalRules?: readonly string[];
  readonly movingAverageStepTimeout?: boolean;
  /** Milliseconds. */
  readonly stepTimeout?: number;
  readonly assumeStateDefined?: boolean;
  readonly logSuccessfulRewrites?: boolean;
  readonly logFailedRewrites?: boolean;
  readonly boosterOnly?: boolean;
  readonly haskellLogging?: readonly string[];
}

/**
 * One configuration in an `execute` result — `ExecuteState`
 * (`Types.hs:116-127`).
 *
 * `substitution` and `ruleSubstitution` are **KORE patterns, not JSON maps**:
 * a right-nested `\and` of `\equals(Var, Val)` over `SortGeneratedTopCell`.
 * Flattening them into a variable→term map is `substitution.ts`'s job (a later
 * module); the wire type keeps the pattern.
 */
export interface ExecuteState {
  readonly term: KoreJson;
  readonly predicate?: KoreJson;
  readonly substitution?: KoreJson;
  readonly ruleSubstitution?: KoreJson;
  readonly rulePredicate?: KoreJson;
  readonly ruleId?: string;
}

/**
 * `HaltReason` (`Types.hs:129-141`) — why execution stopped, kebab-cased.
 *
 * Exhaustive and closed: eight values, no others. Two are server-specific —
 * `timeout` is kore-only (a booster has no `step-timeout` to exceed) and
 * `aborted` is booster-only (kore turns the same condition into error code 6).
 */
export type HaltReason =
  | "branching"
  | "stuck"
  | "vacuous"
  | "depth-bound"
  | "cut-point-rule"
  | "terminal-rule"
  | "aborted"
  | "timeout";

/** Every {@link HaltReason}, in `Types.hs:129-137` declaration order. */
export const HALT_REASONS: readonly HaltReason[] = [
  "branching",
  "stuck",
  "vacuous",
  "depth-bound",
  "cut-point-rule",
  "terminal-rule",
  "aborted",
  "timeout",
];

/**
 * The three **result-level** `Maybe` fields of `ExecuteResult`
 * (`Types.hs:147-150`), by wire name: `next-states`, `rule` and
 * `unknown-predicate`.
 *
 * Upstream is one flat record, so aeson decodes and re-encodes all three
 * regardless of the `reason` beside them — a `rule` on a `stuck` result is
 * unusual but valid wire data, and a server is free to emit it. The union
 * below keeps the per-reason invariants (that is the whole point of it), so
 * the fields a reason does *not* own have nowhere typed to go; they go here.
 */
export type OffReasonKey = "next-states" | "rule" | "unknown-predicate";

/**
 * The off-reason fields a result carried, raw and keyed by wire name — see
 * {@link OffReasonKey}.
 *
 * The values are unparsed {@link JsonValue}s on purpose. They are not fields
 * this reason has an interpretation for, so decoding them into an
 * `ExecuteState[]` or a `KoreJson` would be inventing a meaning; carrying the
 * bytes through is the whole contract, and it is the only thing that makes
 * decode→encode identity for a record aeson would round-trip.
 *
 * `K` is the set of keys the *variant* admits, which is exactly the three
 * minus the ones its reason owns: a {@link BranchingResult} can carry a
 * stray `rule`, and cannot carry a `next-states`, because it has a typed one.
 */
export type OffReasonFields<K extends OffReasonKey = OffReasonKey> = { readonly [F in K]?: JsonValue };

/**
 * What every `execute` result carries — `ExecuteResult`'s non-optional fields
 * plus the two log bundles (`Types.hs:143-156`).
 *
 * `logs` and `haskellLogEntries` are optional rather than defaulted-to-empty,
 * unlike pyk (which substitutes `()`); the difference between "the server sent
 * no logs" and "the server sent an empty log array" is information, and a
 * decoder that erases it cannot round-trip.
 *
 * `offReasonFields` is the same argument applied to the three fields the
 * union's discrimination hides — see {@link OffReasonFields}. It is absent
 * whenever the result carried none of them, which is every result any real
 * server has been observed to send.
 */
interface ExecuteResultBase<Off extends OffReasonKey> {
  readonly depth: Depth;
  readonly state: ExecuteState;
  readonly logs?: readonly LogEntry[];
  readonly haskellLogEntries?: readonly LogLine[];
  readonly offReasonFields?: OffReasonFields<Off>;
}

/**
 * `reason: "branching"` — pyk `BranchingResult` (`rpc.py:799-821`).
 *
 * Note that `kore-rpc-booster` rewrites this reason after simplifying the
 * branches: if every next-state is ⊥ the result becomes `stuck`, and if
 * exactly one survives the proxy silently continues executing instead of
 * returning (`booster/tools/booster/Proxy.hs:456-698`). A `branching` result
 * from the proxy therefore always has at least two live branches.
 */
export interface BranchingResult extends ExecuteResultBase<"rule" | "unknown-predicate"> {
  readonly reason: "branching";
  readonly nextStates: readonly ExecuteState[];
}

/** `reason: "stuck"` — pyk `StuckResult` (`rpc.py:725-748`). No `rule`, no `next-states`. */
export interface StuckResult extends ExecuteResultBase<OffReasonKey> {
  readonly reason: "stuck";
}

/** `reason: "vacuous"` — pyk `VacuousResult` (`rpc.py:875-896`). A *success*, not an error. */
export interface VacuousResult extends ExecuteResultBase<OffReasonKey> {
  readonly reason: "vacuous";
}

/** `reason: "depth-bound"` — pyk `DepthBoundResult` (`rpc.py:751-772`). `max-depth` was reached. */
export interface DepthBoundResult extends ExecuteResultBase<OffReasonKey> {
  readonly reason: "depth-bound";
}

/** `reason: "cut-point-rule"` — pyk `CutPointResult` (`rpc.py:824-847`). Both `rule` and `next-states`. */
export interface CutPointResult extends ExecuteResultBase<"unknown-predicate"> {
  readonly reason: "cut-point-rule";
  readonly nextStates: readonly ExecuteState[];
  readonly rule: string;
}

/** `reason: "terminal-rule"` — pyk `TerminalResult` (`rpc.py:850-872`). `rule`, no `next-states`. */
export interface TerminalResult extends ExecuteResultBase<"next-states" | "unknown-predicate"> {
  readonly reason: "terminal-rule";
  readonly rule: string;
}

/**
 * `reason: "aborted"` — pyk `AbortedResult` (`rpc.py:899-922`). Booster-only.
 *
 * The one reason that carries `unknown-predicate`, and a *success*: the caller
 * decides whether to escalate to kore, not the transport.
 */
export interface AbortedResult extends ExecuteResultBase<"next-states" | "rule"> {
  readonly reason: "aborted";
  readonly unknownPredicate?: KoreJson;
}

/** `reason: "timeout"` — pyk `TimeoutResult` (`rpc.py:775-796`). kore-only; `step-timeout` elapsed. */
export interface TimeoutResult extends ExecuteResultBase<OffReasonKey> {
  readonly reason: "timeout";
}

/**
 * `ExecuteResult` (`Types.hs:143-156`) as a discriminated union on `reason`.
 *
 * Upstream is one flat record whose `nextStates`/`rule`/`unknownPredicate` are
 * all `Maybe`; the per-reason invariants live only in the two server
 * implementations and in pyk's eight result classes (`rpc.py:693-922`), which
 * this union transcribes. Narrowing on `reason` therefore gives exactly the
 * fields that reason can carry — `result.rule` is available on
 * `cut-point-rule` and `terminal-rule`, and does not typecheck elsewhere.
 *
 * The one thing the union owes the flat record it narrows is that nothing is
 * *lost*: a `Maybe` field a reason does not own is still legal wire data, so
 * it is carried raw in {@link OffReasonFields} rather than dropped, and
 * decode→encode is identity for every `ExecuteResult` JSON `Types.hs` admits.
 */
export type ExecuteResult =
  | BranchingResult
  | StuckResult
  | VacuousResult
  | DepthBoundResult
  | CutPointResult
  | TerminalResult
  | AbortedResult
  | TimeoutResult;

//////////////////////
// implies          //
//////////////////////

/**
 * `implies` request parameters — `ImpliesRequest` (`Types.hs:58-69`).
 *
 * `assumeDefined` is **not** a semantic flag despite the name: it is a proxy
 * routing switch that asks for the booster to be tried first; booster's own
 * `runImplies` never reads it. pyk sends it explicitly on every call, as
 * `False` (`rpc.py:1144`, sent at `:1153`), which is why `impliesParams` in `codec.ts` defaults
 * it to `false` rather than omitting it — a request that matches pyk's bytes
 * is a request an upstream bug report can be filed about.
 */
export interface ImpliesParams {
  readonly antecedent: KoreJson;
  readonly consequent: KoreJson;
  readonly module?: string;
  readonly assumeDefined?: boolean;
  readonly boosterOnly?: boolean;
  readonly haskellLogging?: readonly string[];
}

/**
 * `ImpliesStatus` (`Types.hs:167-184`) — the tri-state verdict.
 *
 * `indeterminate` is booster's "could not decide" (an unevaluated function
 * blocking unification, with the SMT ladder failing to settle the
 * obligations); kore checks are always decisive and never produce it, and the
 * proxy escalates it away on every path except `booster-only`.
 *
 * pyk collapses the three to `valid: bool` (`rpc.py:948-965`, `valid=dct['status']
 * == 'valid'`). This package keeps the tri-state: a caller deciding whether to
 * *escalate* needs to tell "proved false" from "gave up", and one bit cannot.
 */
export type ImpliesStatus = "valid" | "invalid" | "indeterminate";

/** Every {@link ImpliesStatus}, in `Types.hs:168-180` declaration order. */
export const IMPLIES_STATUSES: readonly ImpliesStatus[] = ["valid", "invalid", "indeterminate"];

/**
 * `Condition` (`Types.hs:158-165`) — the witness of a valid implication.
 *
 * Both members are **required inside** the condition even though the condition
 * itself is optional. Both are KORE patterns; `substitution` has the
 * `\and`-of-`\equals` shape described on {@link ExecuteState}.
 */
export interface Condition {
  readonly substitution: KoreJson;
  readonly predicate: KoreJson;
}

/**
 * `ImpliesResult` (`Types.hs:186-196`).
 *
 * `logs` is in the type but neither backend ever fills it for `implies` —
 * both hard-code `Nothing` — despite the spec document's examples showing it.
 */
export interface ImpliesResult {
  readonly implication: KoreJson;
  readonly status: ImpliesStatus;
  readonly condition?: Condition;
  readonly logs?: readonly LogEntry[];
  readonly haskellLogEntries?: readonly LogLine[];
}

//////////////////////
// simplify         //
//////////////////////

/** `simplify` request parameters — `SimplifyRequest` (`Types.hs:71-80`). */
export interface SimplifyParams {
  readonly state: KoreJson;
  readonly module?: string;
  readonly boosterOnly?: boolean;
  readonly haskellLogging?: readonly string[];
}

/** `SimplifyResult` (`Types.hs:198-206`). As with `implies`, `logs` is never emitted. */
export interface SimplifyResult {
  readonly state: KoreJson;
  readonly logs?: readonly LogEntry[];
  readonly haskellLogEntries?: readonly LogLine[];
}

//////////////////////
// add-module       //
//////////////////////

/**
 * `add-module` request parameters — `AddModuleRequest` (`Types.hs:82-90`).
 *
 * `module` is **textual KORE**, a string — not a KORE-JSON envelope and not a
 * parsed module. It is the one term-shaped field in the whole protocol that is
 * not JSON, because KORE-JSON has no encoding for a module (there is only a
 * pattern encoding).
 *
 * `nameAsId` asks the server to key the module by its declared name instead of
 * by the content hash it returns.
 */
export interface AddModuleParams {
  readonly module: string;
  readonly nameAsId?: boolean;
  readonly haskellLogging?: readonly string[];
}

/**
 * `AddModuleResult` (`Types.hs:208-215`).
 *
 * `module` is the id the module was filed under: `"m" + sha256(moduleText)`
 * unless `name-as-id` was set. That law is pinned by pyk's integration suite
 * (`tests/integration/kore/test_kore_client.py:923,947`) and is worth
 * asserting in any consumer that caches modules.
 */
export interface AddModuleResult {
  readonly module: string;
  readonly haskellLogEntries?: readonly LogLine[];
}

//////////////////////
// get-model        //
//////////////////////

/** `get-model` request parameters — `GetModelRequest` (`Types.hs:92-101`). */
export interface GetModelParams {
  readonly state: KoreJson;
  readonly module?: string;
  readonly boosterOnly?: boolean;
  readonly haskellLogging?: readonly string[];
}

/**
 * `SatResult` (`Types.hs:227-234`) — **capitalized**, uniquely in this
 * protocol, because it derives `CustomJSON '[]` with no
 * `ConstructorTagModifier` at all.
 */
export type SatResult = "Sat" | "Unsat" | "Unknown";

/** Every {@link SatResult}, in `Types.hs:227-230` declaration order. */
export const SAT_RESULTS: readonly SatResult[] = ["Sat", "Unsat", "Unknown"];

/**
 * `satisfiable: "Sat"` — pyk `SatResult` (the class, `rpc.py:1002-1006`).
 *
 * `substitution` is present only when the model is both satisfiable and
 * non-trivial; a `Sat` with no substitution means "satisfied by anything".
 */
export interface SatModelResult {
  readonly satisfiable: "Sat";
  readonly substitution?: KoreJson;
  readonly haskellLogEntries?: readonly LogLine[];
}

/** `satisfiable: "Unsat"` — pyk `UnsatResult` (`rpc.py:996-999`). Never carries a substitution. */
export interface UnsatModelResult {
  readonly satisfiable: "Unsat";
  readonly haskellLogEntries?: readonly LogLine[];
}

/** `satisfiable: "Unknown"` — pyk `UnknownResult` (`rpc.py:990-993`). The solver gave up. */
export interface UnknownModelResult {
  readonly satisfiable: "Unknown";
  readonly haskellLogEntries?: readonly LogLine[];
}

/**
 * `GetModelResult` (`Types.hs:217-225`) as a discriminated union on
 * `satisfiable`, mirroring pyk's three classes: only `Sat` can carry a
 * substitution.
 */
export type GetModelResult = SatModelResult | UnsatModelResult | UnknownModelResult;

//////////////////////
// Method dispatch  //
//////////////////////

/** Which parameter object each method takes — `APIPayload … 'Req` (`Types.hs:256-266`). */
export interface KoreRpcParamsByMethod {
  readonly execute: ExecuteParams;
  readonly implies: ImpliesParams;
  readonly simplify: SimplifyParams;
  readonly "add-module": AddModuleParams;
  readonly "get-model": GetModelParams;
}

/** Which result each method returns — `APIPayload … 'Res` (`Types.hs:256-266`). */
export interface KoreRpcResultByMethod {
  readonly execute: ExecuteResult;
  readonly implies: ImpliesResult;
  readonly simplify: SimplifyResult;
  readonly "add-module": AddModuleResult;
  readonly "get-model": GetModelResult;
}

/**
 * A request as a value: the method plus its parameters — `API 'Req`
 * (`Types.hs:268-274`), including the payload-less `cancel`.
 */
export type KoreRpcRequest =
  | { readonly method: "execute"; readonly params: ExecuteParams }
  | { readonly method: "implies"; readonly params: ImpliesParams }
  | { readonly method: "simplify"; readonly params: SimplifyParams }
  | { readonly method: "add-module"; readonly params: AddModuleParams }
  | { readonly method: "get-model"; readonly params: GetModelParams }
  | { readonly method: typeof CANCEL_METHOD };
