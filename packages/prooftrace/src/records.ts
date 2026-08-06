/**
 * The **trace-record emitter**: a hint stream joined against an ordinal index,
 * projected to the *same record* the kore-rpc path emits.
 *
 * # The contract this file exists to honour
 *
 * `@kframework-ts/cterm`'s `assembleTrace`/`traceToJsonl`
 * (`cterm/src/trace.ts:205-232`, `:347-349`) define a JSONL record with eleven
 * keys in a fixed order:
 *
 * ```text
 * index, outcome, ruleId, resolved, label, source, location, module,
 * origin, reason, substitution
 * ```
 *
 * {@link ProofTraceRecord} is that shape, key for key and order for order, so
 * the two oracle paths write **interchangeable files** and a consumer's reader
 * does not branch on which produced them.  `test/interchange.test.ts` pins it
 * by building a `TraceEntry` with cterm's own assembler and diffing the key
 * lists — cterm is a devDependency for exactly that test and for nothing else.
 *
 * The record is **replicated, not imported**, because `cterm`'s `TraceEntry` is
 * typed against `LogOrigin` (`"booster" | "kore-rpc"`), and this path is
 * neither.  `origin: "llvm"` is what distinguishes the two files, and widening
 * cterm's union to admit it would mean editing a package this one is not
 * allowed to touch — and would be wrong anyway, since `LogOrigin` is the
 * haskell-backend's own enumeration (`Kore/JsonRpc/Types/Log.hs`) and has no
 * business carrying a value no server can send.
 *
 * # What a "step" is on this path, and how it differs
 *
 * The kore-rpc `logs` array has one entry per rewrite step of the *program*.  A
 * hint stream has an event per rewrite step of the *definition*, which includes
 * every function equation the backend applied while evaluating a side condition
 * or a builtin.  Left alone, `1 / true` would produce hundreds of records where
 * kore-rpc produces eight.  So:
 *
 * - **`pre-trace` events are dropped by default.** They are configuration
 *   initialization — `LblinitGeneratedTopCell`, the `$PGM` map lookup, the
 *   projections — and they happen before the run kore-rpc would call step 0.
 *   `{ preTrace: true }` keeps them.
 * - **Events nested inside a function application are dropped by default.**
 *   A `function` event opens a scope that its matching `function exit` closes
 *   (`ProofTraceParser.h:468-498`, `:626-645`); rules that fire at depth are
 *   equations, not rewrite steps.  `{ depth: n }` or `{ depth: Infinity }`
 *   keeps them, which is how you see *inside* a `requires` clause.  A **hook**
 *   opens nothing: it carries its own result inline after `WORD(0xBB)`
 *   (`:454-464`) and has no exit event, so counting it would leave the depth
 *   permanently climbing and hide the whole trace.
 * - **A `rule` event is a `success`.** A `side-condition-enter` whose matching
 *   `side-condition-exit` says `false` is a `failure` with
 *   `reason: "side condition failed"` — the rule was attempted and abandoned,
 *   which is precisely what cterm's `outcome: "failure"` means
 *   (`cterm/src/trace.ts:210`).  A `true` exit is **not** a record: the `rule`
 *   event that follows it is.
 *
 * Everything else in a hint stream — configurations, hooks, function entries
 * and exits, pattern-matching failures — is not a rule application and
 * contributes no record.  {@link proofTraceEvents} is there for a caller who
 * wants them.
 *
 * # R4, and the one thing a caller has to supply
 *
 * The substitution is the point of this package, and it is *always populated*
 * here — no server hard-codes it away (see `docs/execution-traces.md`).
 * Rendering it as KAST JSON v4, which is what R4 asks for, needs a
 * `KDefinition` and `@kframework-ts/konvert`; {@link proofTraceContext} is the
 * one-liner that binds both, and {@link ProofTraceContext.toKast} is the seam
 * for a caller who has a different converter or wants raw KORE.  Omitting it
 * leaves `substitution` `null`, exactly as cterm does.
 */

import { kastTermToDict, type JsonObject, type KDefinition, type KInner, type Location } from "@kframework-ts/kast";
import { koreToKast } from "@kframework-ts/konvert";
import type { Pattern } from "@kframework-ts/kore";

import type { ProofTraceBinding, ProofTraceEvent, ProofTracePhase } from "./events.js";
import { parseProofTrace, proofTraceEvents } from "./events.js";
import type { KoreHeader } from "./header.js";
import type { OrdinalRuleIndex } from "./ordinals.js";

/**
 * Which oracle wrote a record.
 *
 * A single-member union rather than a bare string so that a consumer reading
 * both files can discriminate on it, and so the value is spelled once.
 */
export type ProofTraceOrigin = "llvm";

/** {@link ProofTraceOrigin}'s only inhabitant. */
export const LLVM_ORIGIN: ProofTraceOrigin = "llvm";

/**
 * One rewrite step, fully attributed — `@kframework-ts/cterm`'s `TraceEntry`
 * with `origin` widened to {@link ProofTraceOrigin}.
 *
 * Field order is the record's JSON key order and is fixed; see
 * {@link proofTraceToJsonl}.  Every difference in *meaning* from cterm's field
 * of the same name is called out below; there are three.
 */
export interface ProofTraceRecord {
  /** Position among the records this trace produced, counting from 0 — R5. */
  readonly index: number;
  /** `success` when the rule fired, `failure` when its side condition rejected it. */
  readonly outcome: "success" | "failure";
  /**
   * The axiom's `UNIQUE'Unds'ID` — the same 64-hex id a kore-rpc `rewrite` log
   * entry reports, which is what makes the two files joinable.
   *
   * **Differs from cterm:** there, `ruleId` is what the *server* sent and the
   * join key; here it is a *result* of the join, because the backend sends an
   * ordinal.  `null` when the resolved axiom declares no `UNIQUE_ID` — see
   * {@link import('./ordinals.js').OrdinalRuleIdentity.uniqueId} — which a
   * kore-rpc trace expresses as an unresolvable id.
   */
  readonly ruleId: string | null;
  /**
   * Whether the ordinal resolved to an axiom of the definition.
   *
   * **Differs from cterm:** there it means "the rule id was in the index".
   * Here `resolved: true` with `ruleId: null` is a real and common combination
   * — a generated axiom with a label but no unique id.
   */
  readonly resolved: boolean;
  readonly label: string | null;
  readonly source: string | null;
  readonly location: Location | null;
  readonly module: string | null;
  /** Always {@link LLVM_ORIGIN} — the field cterm fills with `booster`/`kore-rpc`. */
  readonly origin: ProofTraceOrigin;
  /** The one-line explanation, on a `failure` record only. */
  readonly reason: string | null;
  /**
   * The rule's matching substitution as `{variableName: <KAST v4 document>}`,
   * keys sorted — **R4, populated**.
   *
   * `null` only when no {@link ProofTraceContext.toKast} was supplied.  The
   * names are the backend's own KORE spellings (`VarN`, `Var'Unds'DotVar0`),
   * unmangled: they are what the axiom's body calls its variables, and
   * demangling would lose the correspondence.
   */
  readonly substitution: Readonly<Record<string, JsonObject>> | null;
}

/** The join's two inputs: the ordinal index, and (for R4) a KORE→KAST decoder. */
export interface ProofTraceContext {
  readonly rules: OrdinalRuleIndex;
  /**
   * Projects one substituted term to KAST.  Omit it and
   * {@link ProofTraceRecord.substitution} stays `null`;
   * {@link proofTraceContext} supplies `koreToKast` bound to a definition,
   * which is the intended value.
   */
  readonly toKast?: (term: Pattern) => KInner;
}

/** Which events become records. */
export interface ProofTraceRecordOptions {
  /**
   * Keep configuration-initialization steps.  Default `false`.
   *
   * `true` makes the trace start where the *interpreter* starts rather than
   * where the *program* does, which is what you want when the thing under test
   * is the configuration itself.
   */
  readonly preTrace?: boolean;
  /**
   * How far inside function applications to keep going.  Default `0` — only
   * top-level rewrite steps.
   *
   * `Infinity` keeps every equation the backend applied, which is what makes a
   * `requires` clause's own evaluation visible.
   */
  readonly depth?: number;
  /**
   * Record a rule attempt that its side condition rejected.  Default `true`.
   *
   * The kore-rpc path has no equivalent — no server emits a failed rewrite
   * attempt — so a caller comparing the two files step for step wants `false`.
   */
  readonly failures?: boolean;
}

/**
 * The {@link ProofTraceContext} for a definition: its ordinal index, and
 * `koreToKast` bound to its KAST twin.
 *
 * Two definitions, deliberately.  The ordinal numbering is a property of
 * `definition.kore` (the backend's own file), and the KORE→KAST conversion is a
 * property of `compiled.json` (the frontend's).  They come out of the same
 * `kompile` and a caller has both, but they are not interchangeable and
 * conflating them would hide which one a failure came from.
 */
export function proofTraceContext(rules: OrdinalRuleIndex, definition: KDefinition): ProofTraceContext {
  return Object.freeze({ rules, toKast: (term: Pattern): KInner => koreToKast(definition, term) });
}

/**
 * Parse a hint stream and project it to records — the whole pipeline.
 *
 * Streams internally ({@link proofTraceEvents}), so a large trace never
 * materialises its configurations.
 */
export function assembleProofTrace(
  bytes: Uint8Array,
  header: KoreHeader,
  context: ProofTraceContext,
  options: ProofTraceRecordOptions = {},
): readonly ProofTraceRecord[] {
  return recordsFrom(proofTraceEvents(bytes, header), context, options);
}

/**
 * The same projection over an already-parsed {@link parseProofTrace} result.
 *
 * For a caller that wants both the events and the records without paying for
 * two passes over the bytes.
 */
export function proofTraceRecords(
  trace: ReturnType<typeof parseProofTrace>,
  context: ProofTraceContext,
  options: ProofTraceRecordOptions = {},
): readonly ProofTraceRecord[] {
  const annotated: { readonly phase: ProofTracePhase; readonly event: ProofTraceEvent }[] = [];
  for (const event of trace.preTrace) annotated.push({ phase: "pre-trace", event });
  if (trace.initialConfig !== undefined) annotated.push({ phase: "initial-config", event: trace.initialConfig });
  for (const event of trace.trace) annotated.push({ phase: "trace", event });
  return recordsFrom(annotated, context, options);
}

function recordsFrom(
  events: Iterable<{ readonly phase: ProofTracePhase; readonly event: ProofTraceEvent }>,
  context: ProofTraceContext,
  options: ProofTraceRecordOptions,
): readonly ProofTraceRecord[] {
  const keepPreTrace = options.preTrace === true;
  const maxDepth = options.depth ?? 0;
  const keepFailures = options.failures !== false;

  const records: ProofTraceRecord[] = [];
  // The function scope depth: a `function` event opens one, its matching
  // `function exit` closes it.  Not reset between phases — a `function exit`
  // in the trace section can close a scope the pre-trace section opened.  A
  // `hook` is *not* a scope; see the module header.
  let depth = 0;
  // The substitution of the side condition currently being evaluated, so that a
  // `false` exit can be reported with the bindings its entry carried.
  const pending = new Map<number, { readonly bindings: readonly ProofTraceBinding[]; readonly depth: number }>();

  for (const { phase, event } of events) {
    if (event.tag === "function") {
      depth += 1;
      continue;
    }
    if (event.tag === "function-exit") {
      depth = Math.max(0, depth - 1);
      continue;
    }
    if (event.tag === "config" || event.tag === "hook" || event.tag === "pattern-matching-failure") continue;

    if (event.tag === "side-condition-enter") {
      pending.set(event.ordinal, { bindings: event.substitution, depth });
      continue;
    }

    const visible = (keepPreTrace || phase !== "pre-trace") && depth <= maxDepth;

    if (event.tag === "side-condition-exit") {
      const entry = pending.get(event.ordinal);
      pending.delete(event.ordinal);
      if (event.result || !keepFailures || entry === undefined || !visible) continue;
      records.push(record(records.length, "failure", event.ordinal, entry.bindings, "side condition failed", context));
      continue;
    }

    if (!visible) continue;
    records.push(record(records.length, "success", event.ordinal, event.substitution, null, context));
  }

  return Object.freeze(records);
}

function record(
  index: number,
  outcome: "success" | "failure",
  ordinal: number,
  bindings: readonly ProofTraceBinding[],
  reason: string | null,
  context: ProofTraceContext,
): ProofTraceRecord {
  const identity = context.rules[ordinal];
  // The literal is built in exactly the order `ProofTraceRecord` declares,
  // because `JSON.stringify` preserves insertion order and that order *is* the
  // interchange contract.
  return Object.freeze({
    index,
    outcome,
    ruleId: identity?.uniqueId ?? null,
    resolved: identity !== undefined,
    label: identity?.label ?? null,
    source: identity?.source ?? null,
    location: identity?.location ?? null,
    module: identity?.module ?? null,
    origin: LLVM_ORIGIN,
    reason,
    substitution: substitutionRecord(bindings, context.toKast),
  });
}

/**
 * `{name: <KAST v4 document>}` with the keys sorted.
 *
 * Sorting is the interchange contract (`cterm/src/trace.ts:330`) and it also
 * happens to match what the backend's own tool prints, since
 * `llvm_rewrite_event::substitution_` is a `std::map<std::string, …>`
 * (`ProofTraceParser.h:50-51`) and therefore iterates in name order.  The
 * *wire* order is whatever the decision tree bound them in, and
 * {@link import('./events.js').RuleEvent.substitution} preserves it.
 *
 * A duplicate name cannot occur — `substitution_.insert` keeps the first and
 * the backend never emits one — but if it did, the last binding would win here
 * where the first wins there.  Not worth a branch; worth a sentence.
 */
function substitutionRecord(
  bindings: readonly ProofTraceBinding[],
  toKast: ((term: Pattern) => KInner) | undefined,
): Readonly<Record<string, JsonObject>> | null {
  if (toKast === undefined) return null;
  const sorted = bindings.toSorted((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const flattened: Record<string, JsonObject> = {};
  for (const binding of sorted) flattened[binding.name] = kastTermToDict(toKast(binding.term));
  return Object.freeze(flattened);
}

/**
 * JSON Lines — R7's machine-readable projection, byte-identical for
 * byte-identical input.
 *
 * The same function as `cterm`'s `traceToJsonl` (`cterm/src/trace.ts:347-349`),
 * over the same record: one object per line, no spaces, a trailing `\n` on the
 * last line so concatenating two traces cannot merge two records, and the empty
 * trace as the empty string.
 */
export function proofTraceToJsonl(records: readonly ProofTraceRecord[]): string {
  return records.map((entry) => JSON.stringify(entry) + "\n").join("");
}

/**
 * How many times each rule fired, keyed by `UNIQUE_ID` — the coverage question,
 * answered per run.
 *
 * `cterm`'s `traceRuleCounts` (`:367-374`) keyed by the same id, so counts from
 * the two paths add up.  Records with a `null` `ruleId` are skipped, which is
 * upstream's behaviour for an unresolvable id and is also the only sensible
 * answer: they have no stable name to count under.
 */
export function proofTraceRuleCounts(records: readonly ProofTraceRecord[]): ReadonlyMap<string, number> {
  const counts = new Map<string, number>();
  for (const entry of records) {
    if (entry.outcome !== "success" || entry.ruleId === null) continue;
    counts.set(entry.ruleId, (counts.get(entry.ruleId) ?? 0) + 1);
  }
  return counts;
}

/**
 * `filter` with a name — R8's client-side filtering, and `cterm`'s
 * `filterTrace` (`:383-388`).
 *
 * `index` is **not** renumbered, so a filtered trace still says where each step
 * sat in the run.
 */
export function filterProofTrace(
  records: readonly ProofTraceRecord[],
  predicate: (record: ProofTraceRecord) => boolean,
): readonly ProofTraceRecord[] {
  return Object.freeze(records.filter(predicate));
}
