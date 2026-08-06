/**
 * The **proof-hint event stream** — `HINT`, a version, and then the grammar in
 * `llvm-backend docs/proof-trace.md` §Grammar.
 *
 * Normative sources (`runtimeverification/llvm-backend` at `v0.1.140`):
 *
 * - `docs/proof-trace.md` — the BNF and the two instrumentation modes;
 * - `include/kllvm/binary/ProofTraceParser.h:29-38` (the ten sentinels),
 *   `:346-760` (`proof_trace_parser`, transcribed here function for function),
 *   and `:306-344` (`llvm_event_type`, `llvm_rewrite_trace`);
 * - `include/runtime/proof_trace_writer.h:100-260` — the *writer*, which is the
 *   tie-breaker whenever the doc and the reader disagree.
 *
 * The pyk counterpart, `pyk/src/pyk/kllvm/hints/prooftrace.py`, is a thin
 * wrapper over C++ bindings (`_kllvm.prooftrace`) and therefore transcribes
 * *nothing* of the format — it is read here only for the shape of the public
 * API (`LLVMRewriteTrace.pre_trace` / `.initial_config` / `.trace`,
 * `LLVMRewriteTraceIterator`), which this module reproduces.
 *
 * # Version 13, exactly
 *
 * `proof_trace_parser::expected_version = 13U` (`ProofTraceParser.h:348`) and
 * the reference refuses anything else (`:399-401`).  So does this.
 *
 * # Where the doc is out of date
 *
 * `docs/proof-trace.md:22-24` says KORE terms are "delimit[ed] with 64-bit
 * sentinel values of `0xffffffffffffffff` at the beginning".  They are not: a
 * term begins with its own four-byte `\x7FKR2` magic (`:362-368`), and
 * `0xff…ff` is the *config* sentinel, which introduces a configuration event
 * that then contains a term.  The doc's own BNF has it right (`config ::=
 * WORD(0xFF) kore_term`); the prose above it does not.  Reported in `README.md`.
 *
 * # Two modes, one parser
 *
 * `--llvm-proof-hint-instrumentation` writes rule, side-condition, function,
 * hook and function-exit events plus the initial and final configurations.
 * `--llvm-proof-hint-instrumentation-slow` additionally writes a configuration
 * after every rewrite and the KORE arguments of function events
 * (`proof-trace.md:8-10`).  Nothing in the framing distinguishes them, and
 * nothing here needs to: the trace is a flat sequence of events either way, and
 * a caller that cares can look for {@link ConfigEvent}s in
 * {@link ProofTrace.trace}.
 */

import type { Pattern } from "@kframework-ts/kore";

import { readBinaryKoreTerm, BINARY_KORE_TERM_MAGIC } from "./binary.js";
import { ByteCursor } from "./cursor.js";
import { ProofTraceError, ProofTraceVersionError } from "./errors.js";
import type { KoreHeader } from "./header.js";

/** The hint-format version this package implements (`ProofTraceParser.h:348`). */
export const PROOF_TRACE_VERSION = 13;

/**
 * The ten one-byte sentinel values, each written eight times
 * (`ProofTraceParser.h:29-38`).
 *
 * Exported because a caller staring at `xxd` output needs the table, and
 * because the test that pins them against the header is the cheapest possible
 * guard on a silent renumbering.
 */
export const SENTINELS = Object.freeze({
  /** `config ::= WORD(0xFF) kore_term` */
  config: 0xff,
  /** `function ::= WORD(0xDD) name location arg*` … */
  functionEnter: 0xdd,
  /** … `WORD(0x11)` */
  functionEnd: 0x11,
  /** `hook ::= WORD(0xAA) name symbol_name location arg*` … */
  hook: 0xaa,
  /** … `WORD(0xBB) kore_term` */
  hookResult: 0xbb,
  /** `rule ::= WORD(0x22) ordinal arity variable*` */
  rule: 0x22,
  /** `side_cond_entry ::= WORD(0xEE) ordinal arity variable*` */
  sideConditionEnter: 0xee,
  /** `side_cond_exit ::= WORD(0x33) ordinal boolean_result` */
  sideConditionExit: 0x33,
  /** `pattern_matching_failure ::= WORD(0x44) function_name` */
  patternMatchingFailure: 0x44,
  /** `function_exit ::= WORD(0x55) ordinal boolean_result` */
  functionExit: 0x55,
} as const);

/** `HINT`, `PTRC`, `CHNK` — `parse_header` (`ProofTraceParser.h:374-404`). */
export type ProofTraceKind = "hint" | "pre-trace" | "chunk";

const MAGICS: readonly (readonly [ProofTraceKind, readonly number[]])[] = Object.freeze([
  ["hint", Object.freeze([0x48, 0x49, 0x4e, 0x54])], // "HINT"
  ["pre-trace", Object.freeze([0x50, 0x54, 0x52, 0x43])], // "PTRC"
  ["chunk", Object.freeze([0x43, 0x48, 0x4e, 0x4b])], // "CHNK"
]);

/**
 * Which of `llvm_rewrite_trace`'s three sections an event came from —
 * `llvm_event_type` (`ProofTraceParser.h:306`).
 *
 * `pre-trace` events are configuration *initialization*: the hooks and function
 * applications that build the initial cell from `$PGM` and friends
 * (`proof-trace.md:74-75`).  They are rewrite steps of the definition and they
 * carry real ordinals, but they are not steps of the program being traced, so
 * `records.ts` drops them by default.
 */
export type ProofTracePhase = "pre-trace" | "initial-config" | "trace";

/** One `variable ::= name kore_term` binding (`proof-trace.md:58`). */
export interface ProofTraceBinding {
  /** The KORE variable name as the backend spells it — `VarN`, `Var'Unds'DotVar0`. */
  readonly name: string;
  readonly term: Pattern;
  /** The backend's own `pattern_len`; see {@link import('./binary.js').BinaryKoreTerm.patternLength}. */
  readonly patternLength: number;
}

/** A rewrite rule fired: `rule ::= WORD(0x22) ordinal arity variable*`. */
export interface RuleEvent {
  readonly tag: "rule";
  /** Index of the axiom in `definition.kore`; see `ordinals.ts`. */
  readonly ordinal: number;
  /** The matching substitution, **in wire order** — this is R4. */
  readonly substitution: readonly ProofTraceBinding[];
}

/** A rule's `requires` clause is about to be evaluated: `WORD(0xEE) ordinal arity variable*`. */
export interface SideConditionEnterEvent {
  readonly tag: "side-condition-enter";
  readonly ordinal: number;
  /** The candidate substitution — present whether or not the condition holds. */
  readonly substitution: readonly ProofTraceBinding[];
}

/** The verdict on that clause: `WORD(0x33) ordinal boolean_result`. */
export interface SideConditionExitEvent {
  readonly tag: "side-condition-exit";
  readonly ordinal: number;
  /** `true` when the rule may fire; a `false` here is a rule *attempt*. */
  readonly result: boolean;
}

/** A function application was entered: `WORD(0xDD) name location arg* WORD(0x11)`. */
export interface FunctionEnterEvent {
  readonly tag: "function";
  /** The KORE symbol id of the function, e.g. `Lblproject'Coln'KItem{}`. */
  readonly name: string;
  /** `0:1:1` — the path from the enclosing term to this redex (`proof-trace.md:78-79`). */
  readonly relativePosition: string;
  /** The arguments — **empty in normal instrumentation** (`proof-trace.md:47`). */
  readonly args: readonly ProofTraceArgument[];
}

/** A function application returned: `WORD(0x55) ordinal boolean_result`. */
export interface FunctionExitEvent {
  readonly tag: "function-exit";
  /** The ordinal of the equation that produced the result. */
  readonly ordinal: number;
  /** The `boolean_result` slot, which the writer uses for "was a tail call" (`ProofTraceParser.h:179`). */
  readonly isTail: boolean;
}

/** A hooked builtin ran: `WORD(0xAA) name symbol_name location arg* WORD(0xBB) kore_term`. */
export interface HookEvent {
  readonly tag: "hook";
  /** The `hook(...)` attribute value, e.g. `INT.add`. */
  readonly name: string;
  /** The KORE symbol the hook implements, e.g. `Lbl'UndsPlus'Int'Unds'{}`. */
  readonly symbolName: string;
  readonly relativePosition: string;
  /** The hook's arguments — present in **both** modes, unlike a function's. */
  readonly args: readonly ProofTraceArgument[];
  /** What the hook returned. */
  readonly result: Pattern;
  readonly resultLength: number;
}

/** A function's decision tree fell through: `WORD(0x44) function_name` (`Decision.cpp:931`). */
export interface PatternMatchingFailureEvent {
  readonly tag: "pattern-matching-failure";
  readonly functionName: string;
}

/** A whole configuration: `config ::= WORD(0xFF) kore_term`. */
export interface ConfigEvent {
  readonly tag: "config";
  readonly term: Pattern;
  readonly patternLength: number;
}

/** One argument of a function or hook event — always a term (`parse_argument`, `:647-660`). */
export interface ProofTraceArgument {
  readonly term: Pattern;
  readonly patternLength: number;
}

/** Everything `parse_step_event` can return (`ProofTraceParser.h:662-686`). */
export type ProofTraceStepEvent =
  | RuleEvent
  | SideConditionEnterEvent
  | SideConditionExitEvent
  | FunctionEnterEvent
  | FunctionExitEvent
  | HookEvent
  | PatternMatchingFailureEvent;

/** A step event or a configuration — `llvm_event` (`ProofTraceParser.h:274-304`). */
export type ProofTraceEvent = ProofTraceStepEvent | ConfigEvent;

/** An event tagged with the section it came from — `annotated_llvm_event` (`:308-311`). */
export interface AnnotatedProofTraceEvent {
  readonly phase: ProofTracePhase;
  readonly event: ProofTraceEvent;
}

/** A whole parsed trace — `llvm_rewrite_trace` (`ProofTraceParser.h:313-344`). */
export interface ProofTrace {
  /** Always {@link PROOF_TRACE_VERSION}; carried because the reference carries it. */
  readonly version: number;
  /** Which of the three magics the stream opened with. */
  readonly kind: ProofTraceKind;
  /** Events before the initial configuration — configuration initialization. */
  readonly preTrace: readonly ProofTraceEvent[];
  /** The initial configuration; `undefined` only for a `CHNK` stream, which has no header section. */
  readonly initialConfig: ConfigEvent | undefined;
  /** Everything after it, ending with the final configuration. */
  readonly trace: readonly ProofTraceEvent[];
}

/**
 * Parse a whole hint stream — `parse_trace` (`ProofTraceParser.h:711-747`).
 *
 * An empty trace is a legitimate result and not an error: an interpreter whose
 * *input* fails to parse still writes the eight-byte header and exits, so an
 * `HINT` file of exactly `"HINT" 0d000000` parses to `preTrace: []`,
 * `initialConfig: undefined`, `trace: []`.  That is R10's "may produce an empty
 * trace; may not produce a missing one", satisfied by the backend itself.
 *
 * @throws {ProofTraceVersionError} when the stream declares a version other
 *   than {@link PROOF_TRACE_VERSION}.
 * @throws {ProofTraceError} on any malformed event.
 */
export function parseProofTrace(bytes: Uint8Array, header: KoreHeader): ProofTrace {
  const cursor = new ByteCursor(bytes);
  const { kind, version } = parseTraceHeader(cursor);

  const preTrace: ProofTraceEvent[] = [];
  let initialConfig: ConfigEvent | undefined;

  if (kind === "hint" || kind === "pre-trace") {
    // `while (has_word() && peek_word() != config_sentinel)` (`:720`).
    while (cursor.hasWord() && cursor.peekSentinel() !== SENTINELS.config) {
      preTrace.push(parseEvent(cursor, header));
    }
    // The reference *requires* a config here and fails without one (`:728-731`).
    // A stream that stopped early — the empty trace above — has nothing left,
    // and reporting that as a parse failure would turn R10 into an exception.
    if (!cursor.eof()) initialConfig = parseConfig(cursor, header);
  }

  const trace: ProofTraceEvent[] = [];
  while (!cursor.eof()) trace.push(parseEvent(cursor, header));

  return Object.freeze({
    version,
    kind,
    preTrace: Object.freeze(preTrace),
    initialConfig,
    trace: Object.freeze(trace),
  });
}

/**
 * The same stream, one event at a time — `llvm_rewrite_trace_iterator`
 * (`ProofTraceParser.h:762-780`), which pyk exposes as
 * `LLVMRewriteTraceIterator`.
 *
 * The whole buffer still has to be in memory (this package does not read
 * files), so the saving is in the *events*, not the bytes: a caller projecting
 * a 200 MB trace to a few thousand JSONL records never materialises the
 * intermediate array of every configuration it skipped.  {@link parseProofTrace}
 * is this generator with the array built for you.
 */
export function* proofTraceEvents(bytes: Uint8Array, header: KoreHeader): Generator<AnnotatedProofTraceEvent> {
  const cursor = new ByteCursor(bytes);
  const { kind } = parseTraceHeader(cursor);

  if (kind === "hint" || kind === "pre-trace") {
    while (cursor.hasWord() && cursor.peekSentinel() !== SENTINELS.config) {
      yield { phase: "pre-trace", event: parseEvent(cursor, header) };
    }
    if (!cursor.eof()) yield { phase: "initial-config", event: parseConfig(cursor, header) };
  }

  while (!cursor.eof()) yield { phase: "trace", event: parseEvent(cursor, header) };
}

/** `parse_header` (`ProofTraceParser.h:374-404`). */
function parseTraceHeader(cursor: ByteCursor): { kind: ProofTraceKind; version: number } {
  const magicOffset = cursor.offset;
  const found = MAGICS.find(([, magic]) => cursor.startsWith(magic));
  if (found === undefined) {
    throw new ProofTraceError("Not a proof-hint stream: expected the magic HINT, PTRC or CHNK", magicOffset);
  }
  const [kind, magic] = found;
  cursor.expectMagic(magic, "proof-hint stream");

  const versionOffset = cursor.offset;
  const version = cursor.readUint32();
  if (version !== PROOF_TRACE_VERSION) {
    throw new ProofTraceVersionError("hints", PROOF_TRACE_VERSION, version, versionOffset);
  }
  return { kind, version };
}

/** `parse_event` (`ProofTraceParser.h:688-709`). */
function parseEvent(cursor: ByteCursor, header: KoreHeader): ProofTraceEvent {
  if (!cursor.hasWord()) {
    throw new ProofTraceError("Truncated event: fewer than eight bytes of sentinel left", cursor.offset);
  }
  if (cursor.peekSentinel() === SENTINELS.config) return parseConfig(cursor, header);
  return parseStepEvent(cursor, header);
}

/** `parse_config` (`:500-512`). */
function parseConfig(cursor: ByteCursor, header: KoreHeader): ConfigEvent {
  cursor.expectSentinel(SENTINELS.config, "config");
  const { pattern, patternLength } = readBinaryKoreTerm(cursor, header);
  return Object.freeze({ tag: "config", term: pattern, patternLength });
}

/** `parse_step_event`'s `switch` (`:662-686`). */
function parseStepEvent(cursor: ByteCursor, header: KoreHeader): ProofTraceStepEvent {
  const offset = cursor.offset;
  switch (cursor.peekSentinel()) {
    case SENTINELS.hook:
      return parseHook(cursor, header);
    case SENTINELS.functionEnter:
      return parseFunction(cursor, header);
    case SENTINELS.rule:
      return parseRule(cursor, header);
    case SENTINELS.sideConditionEnter:
      return parseSideConditionEnter(cursor, header);
    case SENTINELS.sideConditionExit:
      return parseSideConditionExit(cursor);
    case SENTINELS.patternMatchingFailure:
      return parsePatternMatchingFailure(cursor);
    case SENTINELS.functionExit:
      return parseFunctionExit(cursor);
    // `undefined` is "the next eight bytes are not a sentinel word at all",
    // which the reference reaches as `default: return nullptr` (`:684`).
    case undefined:
    default:
      throw new ProofTraceError("Unknown event sentinel", offset);
  }
}

/** `parse_rule` (`:514-558`), minus the ordinal→label join, which is `ordinals.ts`. */
function parseRule(cursor: ByteCursor, header: KoreHeader): RuleEvent {
  cursor.expectSentinel(SENTINELS.rule, "rule");
  const ordinal = cursor.readUint64();
  const arity = cursor.readUint64();
  return Object.freeze({ tag: "rule", ordinal, substitution: parseBindings(cursor, header, arity) });
}

/** `parse_side_condition` (`:560-585`). */
function parseSideConditionEnter(cursor: ByteCursor, header: KoreHeader): SideConditionEnterEvent {
  cursor.expectSentinel(SENTINELS.sideConditionEnter, "side-condition entry");
  const ordinal = cursor.readUint64();
  const arity = cursor.readUint64();
  return Object.freeze({
    tag: "side-condition-enter",
    ordinal,
    substitution: parseBindings(cursor, header, arity),
  });
}

/** `parse_side_condition_end` (`:587-608`). */
function parseSideConditionExit(cursor: ByteCursor): SideConditionExitEvent {
  cursor.expectSentinel(SENTINELS.sideConditionExit, "side-condition exit");
  const ordinal = cursor.readUint64();
  return Object.freeze({ tag: "side-condition-exit", ordinal, result: cursor.readBool() });
}

/** `parse_function_exit` (`:626-645`). */
function parseFunctionExit(cursor: ByteCursor): FunctionExitEvent {
  cursor.expectSentinel(SENTINELS.functionExit, "function exit");
  const ordinal = cursor.readUint64();
  return Object.freeze({ tag: "function-exit", ordinal, isTail: cursor.readBool() });
}

/** `parse_pattern_matching_failure` (`:610-624`). */
function parsePatternMatchingFailure(cursor: ByteCursor): PatternMatchingFailureEvent {
  cursor.expectSentinel(SENTINELS.patternMatchingFailure, "pattern-matching failure");
  return Object.freeze({ tag: "pattern-matching-failure", functionName: cursor.readCString() });
}

/** `parse_function` (`:468-498`). */
function parseFunction(cursor: ByteCursor, header: KoreHeader): FunctionEnterEvent {
  cursor.expectSentinel(SENTINELS.functionEnter, "function entry");
  const name = cursor.readCString();
  const relativePosition = cursor.readCString();
  const args = parseArguments(cursor, header, SENTINELS.functionEnd, "function end");
  return Object.freeze({ tag: "function", name, relativePosition, args });
}

/** `parse_hook` (`:424-466`). */
function parseHook(cursor: ByteCursor, header: KoreHeader): HookEvent {
  cursor.expectSentinel(SENTINELS.hook, "hook");
  const name = cursor.readCString();
  const symbolName = cursor.readCString();
  const relativePosition = cursor.readCString();
  const args = parseArguments(cursor, header, SENTINELS.hookResult, "hook result");
  const { pattern, patternLength } = readBinaryKoreTerm(cursor, header);
  return Object.freeze({
    tag: "hook",
    name,
    symbolName,
    relativePosition,
    args,
    result: pattern,
    resultLength: patternLength,
  });
}

/**
 * The `arg*` loop shared by `parse_hook` (`:446-452`) and `parse_function`
 * (`:485-491`), which consumes the terminator on the way out.
 *
 * Both loop while the next word is *not* the terminator — including when fewer
 * than eight bytes remain, which is `!buffer.has_word() ||` in the reference.
 * `parse_argument` then requires the next byte to be `\x7F` (`:648`), so a
 * truncated tail fails there rather than looping; that check is the
 * `peekByte()` guard below, and it is what turns "the terminator is missing"
 * into a message instead of a hang.
 */
function parseArguments(
  cursor: ByteCursor,
  header: KoreHeader,
  terminator: number,
  what: string,
): readonly ProofTraceArgument[] {
  const args: ProofTraceArgument[] = [];
  while (cursor.peekSentinel() !== terminator) {
    if (cursor.peekByte() !== BINARY_KORE_TERM_MAGIC[0]) {
      throw new ProofTraceError(`Expected an argument term or the ${what} sentinel`, cursor.offset);
    }
    const { pattern, patternLength } = readBinaryKoreTerm(cursor, header);
    args.push(Object.freeze({ term: pattern, patternLength }));
  }
  cursor.expectSentinel(terminator, what);
  return Object.freeze(args);
}

/** `parse_variable` (`:406-422`), `arity` times. */
function parseBindings(cursor: ByteCursor, header: KoreHeader, arity: number): readonly ProofTraceBinding[] {
  const bindings: ProofTraceBinding[] = [];
  for (let index = 0; index < arity; index += 1) {
    const name = cursor.readCString();
    const { pattern, patternLength } = readBinaryKoreTerm(cursor, header);
    bindings.push(Object.freeze({ name, term: pattern, patternLength }));
  }
  return Object.freeze(bindings);
}
