/**
 * The **trace assembler**: an `execute` response's rewrite log joined against a
 * definition index, projected to attributable, deterministic, machine-readable
 * records.
 *
 * This has no pyk counterpart — pyk's only consumer of the `logs` family is
 * `KCFGExplore._extract_rule_labels` (`kcfg/explore.py:66-77`), which resolves
 * a rule id to `LABEL:source` and throws the rest away.  This module is
 * the kore-rpc implementation described in `docs/execution-traces.md`: an
 * `execute` response and a definition index become deterministic JSONL with
 * rule identity, location, module, and any substitution the server supplies.
 *
 * # What a live server actually emits (measured, K v7.1.337 / hb v0.1.155)
 *
 * The `logs` type is much wider than any emission.  Measured against both
 * servers on a concrete run:
 *
 * - **Every entry is `{"tag":"rewrite","result":{"tag":"success","rule-id":
 *   "<64 hex>"},"origin":"booster"|"kore-rpc"}`.** One per rewrite step, in
 *   execution order, byte-identical across repeated runs.
 * - **`substitution` and `rewritten-term` are never populated.** Not a
 *   configuration matter and not a version matter: both servers construct the
 *   record with them hard-coded to `Nothing` —
 *   `booster/library/Booster/JsonRpc.hs:658-669` and
 *   `kore/src/Kore/JsonRpc.hs:198-212`.  {@link TraceEntry.substitution} is
 *   therefore `null` on every entry a v0.1.155 server produces.  It is
 *   implemented anyway because the *type* is the contract
 *   (`Kore/JsonRpc/Types/Log.hs:32-36`), the field survives
 *   `logEntryEraseTerms` selection upstream, and an LLVM proof-hint reader
 *   would fill exactly this slot.
 * - **Rule ids are 64-character `LongId`s**, so the join is by whole id.  The
 *   7-character `ShortId` abbreviation `parseUniqueId` distinguishes is a
 *   *context-log* (`haskell-log-entries`) convention and does not reach here;
 *   no prefix matching is needed or offered.
 * - **A branching step contributes no entry.** Booster returns `Nothing` for
 *   `RewriteBranchingStep` (`Booster/JsonRpc.hs:670`); the branch's rule ids
 *   arrive on `next-states[].rule-id` instead, which is
 *   `CTermNextState.ruleId`, not a log entry.  A trace is therefore the run's
 *   *deterministic* steps; the caller stitches branch points in from the
 *   response it already holds.
 * - **Kore substitutes the literal `"UNKNOWN"`** for a missing id
 *   (`Kore/JsonRpc.hs:205`), which is why {@link TraceEntry.resolved} exists
 *   rather than the join being assumed total.
 *
 * # Determinism
 *
 * {@link traceToJsonl} is byte-identical for byte-identical input: fixed key
 * order per record, substitution keys sorted, no timestamps, no host paths
 * beyond the ones the definition itself carries, and a trailing newline on
 * every line including the last.
 *
 * # Layering: why the assembler is here and the corpus runner is not
 *
 * The join needs a definition and a KORE→KAST decoder and nothing else, both
 * of which a {@link CTermSymbolic} already holds — so this sits beside it, one
 * layer below `@kframework-ts/kcfg`, which deliberately keeps backend logs
 * opaque (`kcfg/src/explore.ts`, `KCFGNodeLogs`).  §3 item 3's corpus runner —
 * spawn a server per definition, run N programs, write a file per program — is
 * *not* here and will not be: this package starts no processes and touches no
 * filesystem.  Spawning belongs to `@kframework-ts/kore-rpc/server`, writing to
 * the caller; what a runner needs from this package is
 * {@link assembleTrace} plus {@link traceToJsonl}.
 */

import {
  Atts,
  moduleSentenceByUniqueId,
  sentenceLabel,
  Subst,
  kastTermToDict,
  type JsonObject,
  type KDefinition,
  type KInner,
  type KSentence,
  type Location,
} from "@kframework-ts/kast";
import {
  attLocation,
  attSource,
  attString,
  ATT_LABEL,
  ATT_UNIQUE_ID,
  type App,
  type KoreJson,
  type LazyKoreDefinitionIndex,
} from "@kframework-ts/kore";
import type { LogEntry, LogOrigin } from "@kframework-ts/kore-rpc";

import type { CTermSymbolic } from "./symbolic.js";

//////////////////////////////
// The definition index     //
//////////////////////////////

/**
 * Everything a rule id resolves to.  `null`, never `undefined`, so a record
 * survives `JSON.stringify` with every key present — R7's readers should not
 * have to distinguish "absent" from "unknown".
 */
export interface TraceRuleIdentity {
  /** `label` if the rule declared one, else the frontend's unique id. */
  readonly label: string;
  /** The `.k` file the rule was written in, unwrapped from `Source(…)`. */
  readonly source: string | null;
  /** `[startLine, startColumn, endLine, endColumn]`, all 1-based. */
  readonly location: Location | null;
  /** The module that declares the rule. */
  readonly module: string | null;
}

/** A rule id → {@link TraceRuleIdentity} join table. */
export type TraceRuleIndex = ReadonlyMap<string, TraceRuleIdentity>;

/**
 * Build the join table from a KAST definition — `compiled.json`'s side.
 *
 * Over `allModules`, exactly as `KDefinition.sentence_by_unique_id`
 * (`kast/outer.py:1186-1197`) is: a definition's *unimported* modules still
 * declare rules a backend can fire.  First declaration of an id wins, matching
 * that property's collision policy; upstream logs the collision at `DEBUG` and
 * this package has no logger, so it is silent here too.
 *
 * This is the index to prefer: a {@link CTermSymbolic} already holds the
 * `KDefinition`, so the whole join costs no I/O and no second parse.
 * {@link traceRuleIndexFromKore} exists for a caller that has only
 * `definition.kore`.
 */
export function traceRuleIndexFromKast(definition: KDefinition): TraceRuleIndex {
  const index = new Map<string, TraceRuleIdentity>();
  for (const module of definition.allModules) {
    for (const [uniqueId, sentence] of moduleSentenceByUniqueId(module)) {
      if (index.has(uniqueId)) continue;
      index.set(uniqueId, kastIdentity(sentence, module.name));
    }
  }
  return index;
}

function kastIdentity(sentence: KSentence, module: string): TraceRuleIdentity {
  // `sentenceLabel` falls back to the unique id and can only throw when both
  // are absent — and this sentence reached us *keyed by* its unique id.
  const location = sentence.att.get(Atts.LOCATION);
  const source = sentence.att.get(Atts.SOURCE);
  return Object.freeze({
    label: sentenceLabel(sentence),
    source: source ?? null,
    location: location ?? null,
    module,
  });
}

/**
 * Build the join table from a parsed `definition.kore` — the backend's own
 * side, and the one `docs/execution-traces.md` R3 names.
 *
 * Reads `UNIQUE'Unds'ID`, `label`, `Source(…)` and `Location(…)` straight off
 * each axiom's attributes (`@kframework-ts/kore`'s `attString`/`attSource`/
 * `attLocation`), so it needs no axiom *bodies* and works on a definition
 * parsed with `lazyAxioms`.  Claims are indexed too: a claim carries a unique
 * id and a backend executing a spec module can report one.
 *
 * The two indexes agree on `label`, `source` and `location` for every rule of a
 * `kompile`d definition — verified against `simple-proofs.k` at v7.1.337, where
 * both spell the label module-qualified (`SIMPLE-PROOFS.c.e`) even though the
 * `.k` source writes `rule [c.e]:`.  The qualification is the frontend's and is
 * preserved rather than stripped: the raw value is what a reader can grep the
 * other artifact for.
 */
export function traceRuleIndexFromKore(index: LazyKoreDefinitionIndex): TraceRuleIndex {
  const result = new Map<string, TraceRuleIdentity>();
  for (const module of index.definition.modules) {
    for (const sentence of module.sentences) {
      // A definition parsed with `lazyAxioms` (the fast path this function's
      // header recommends) tags its axioms `LazyAxiom`; attributes are still
      // eagerly parsed, which is all this index reads.
      if (sentence.tag !== "Axiom" && sentence.tag !== "LazyAxiom" && sentence.tag !== "Claim") continue;
      const uniqueId = attString(sentence.attrs, ATT_UNIQUE_ID);
      if (uniqueId === undefined || result.has(uniqueId)) continue;
      result.set(uniqueId, koreIdentity(sentence.attrs, uniqueId, module.name));
    }
  }
  return result;
}

function koreIdentity(attrs: readonly App[], uniqueId: string, module: string): TraceRuleIdentity {
  const span = attLocation(attrs);
  return Object.freeze({
    // The same fallback `KSentence.label` uses (`kast/outer.py:186-197`).
    label: attString(attrs, ATT_LABEL) ?? uniqueId,
    source: attSource(attrs) ?? null,
    location:
      span === undefined ? null : ([span.startLine, span.startColumn, span.endLine, span.endColumn] as Location),
    module,
  });
}

//////////////////////////////
// The trace records        //
//////////////////////////////

/**
 * One rewrite step, fully attributed.
 *
 * Field order is the record's JSON key order and is fixed; see
 * {@link traceToJsonl}.
 */
export interface TraceEntry {
  /** Position in the response's `logs` array, counting rewrite entries only — R5. */
  readonly index: number;
  /** `success` when the step was taken, `failure` when it was attempted and abandoned. */
  readonly outcome: "success" | "failure";
  /** `rule-id`; `null` only for a `failure` that failed before choosing a rule. */
  readonly ruleId: string | null;
  /** Whether {@link ruleId} was found in the index.  `false` also for `"UNKNOWN"`. */
  readonly resolved: boolean;
  readonly label: string | null;
  readonly source: string | null;
  readonly location: Location | null;
  readonly module: string | null;
  /** Which server took the step. */
  readonly origin: LogOrigin;
  /** The backend's one-line explanation, on a `failure` entry only. */
  readonly reason: string | null;
  /**
   * The rule's matching substitution as `{variableName: <KAST v4 document>}` —
   * R4.
   *
   * **`null` on every entry any v0.1.155 server produces**, because both
   * servers hard-code the field to `Nothing`; see the module header.  Non-null
   * requires both a server that fills it and a {@link TraceContext.toKast}
   * decoder to project it.
   */
  readonly substitution: Readonly<Record<string, JsonObject>> | null;
}

/** The join's two inputs: the index, and (for R4) a KORE→KAST decoder. */
export interface TraceContext {
  readonly rules: TraceRuleIndex;
  /**
   * Projects a log entry's `substitution` pattern to KAST.  Omit it and
   * {@link TraceEntry.substitution} stays `null` even when a server fills the
   * field; `@kframework-ts/konvert`'s `koreToKast` bound to the definition is
   * the intended value, and {@link traceContext} supplies exactly that.
   */
  readonly toKast?: (kore: KoreJson) => KInner;
}

/**
 * The {@link TraceContext} implied by a live adapter: its definition's KAST
 * index, and its own codec as the decoder.
 *
 * This is the one-liner a corpus runner wants — the index is memoized by the
 * caller holding onto the returned object, since building it walks every
 * sentence of every module.
 */
export function traceContext(symbolic: CTermSymbolic): TraceContext {
  return Object.freeze({
    rules: traceRuleIndexFromKast(symbolic.definition),
    toKast: (kore: KoreJson): KInner => symbolic.codec.koreToKast(symbolic.definition, kore.term),
  });
}

/**
 * Join a response's `logs` against the index — the assembler proper.
 *
 * Only `rewrite` entries become records.  `simplification`, `fallback` and
 * `processing-time` are not rewrite steps of the run being traced, and no
 * v0.1.155 server emits them at all (`kore-rpc/src/logs.ts` header); an
 * unrecognized tag is likewise skipped rather than guessed at.
 *
 * `undefined` logs — what a response carries when the request did not ask for
 * rewrite logging — assemble to the empty trace, not an error.  R10's empty
 * trace for a run that never reached the backend is the same value.
 */
export function assembleTrace(logs: readonly LogEntry[] | undefined, context: TraceContext): readonly TraceEntry[] {
  if (logs === undefined) return EMPTY_TRACE;
  const entries: TraceEntry[] = [];
  for (const log of logs) {
    if (log.tag !== "rewrite") continue;
    entries.push(traceEntry(entries.length, log.result, log.origin, context));
  }
  return Object.freeze(entries);
}

const EMPTY_TRACE: readonly TraceEntry[] = Object.freeze([]);

function traceEntry(
  index: number,
  result: Extract<LogEntry, { tag: "rewrite" }>["result"],
  origin: LogOrigin,
  context: TraceContext,
): TraceEntry {
  const ruleId = result.tag === "success" ? result.ruleId : (result.ruleId ?? null);
  const identity = ruleId === null ? undefined : context.rules.get(ruleId);
  const substitution =
    result.tag === "success" && result.substitution !== undefined && context.toKast !== undefined
      ? substitutionRecord(context.toKast(result.substitution))
      : null;
  return Object.freeze({
    index,
    outcome: result.tag,
    ruleId,
    resolved: identity !== undefined,
    label: identity?.label ?? null,
    source: identity?.source ?? null,
    location: identity?.location ?? null,
    module: identity?.module ?? null,
    origin,
    reason: result.tag === "failure" ? result.reason : null,
    substitution,
  });
}

/**
 * `\and`-of-`\equals`, already decoded to KAST, flattened to
 * `{name: <KAST v4 document>}` with the keys sorted.
 *
 * `Subst.fromPred` is the same reader `CTermSymbolic.getModel` uses on a
 * model, so a substitution in a trace and a substitution in a model are the
 * same interpretation of the same wire shape.  A pattern it rejects — anything
 * that is not a conjunction of variable equalities — yields `null` rather than
 * throwing: a diagnostic must not cost the caller the trace.
 */
function substitutionRecord(pred: KInner): Readonly<Record<string, JsonObject>> | null {
  let subst: Subst;
  try {
    subst = Subst.fromPred(pred);
  } catch {
    return null;
  }
  const record: Record<string, JsonObject> = {};
  for (const name of [...subst.keys()].toSorted()) record[name] = kastTermToDict(subst.get(name)!);
  return Object.freeze(record);
}

//////////////////////////////
// Projections              //
//////////////////////////////

/**
 * JSON Lines — R7's machine-readable projection, and R6's byte-identical one.
 *
 * One object per line, keys in {@link TraceEntry} declaration order (which
 * `JSON.stringify` preserves because {@link traceEntry} builds the literal in
 * that order), no spaces, and a trailing `\n` on the last line so appending or
 * concatenating two traces cannot merge two records.  The empty trace is the
 * empty string.
 */
export function traceToJsonl(entries: readonly TraceEntry[]): string {
  return entries.map((entry) => JSON.stringify(entry) + "\n").join("");
}

/**
 * How many times each rule fired, keyed by rule id.
 *
 * This is the coverage question `kompile --coverage` answers with a file — one
 * `UNIQUE_ID` per line (`GenerateCoverage.java:70-75`) — computed instead from
 * the response the caller already has, per run, with no shared file and no
 * `K_LOG_DIR`.  It also answers `kore_exec_covr`'s "which rules never fire"
 * for *semantic* rules: subtract the keys here from
 * {@link TraceRuleIndex.keys}.  It does **not** subsume `kore_exec_covr` for
 * *simplification* rules, which fire inside the backend's evaluator and never
 * appear in a `rewrite` log entry.
 *
 * Only successful steps are counted; a `failure` entry is an attempt, not a
 * firing.  Insertion order is first-fire order, so the map is as deterministic
 * as the trace.
 */
export function traceRuleCounts(entries: readonly TraceEntry[]): ReadonlyMap<string, number> {
  const counts = new Map<string, number>();
  for (const entry of entries) {
    if (entry.outcome !== "success" || entry.ruleId === null) continue;
    counts.set(entry.ruleId, (counts.get(entry.ruleId) ?? 0) + 1);
  }
  return counts;
}

/**
 * `filter` with a name — R8's client-side filtering.
 *
 * Filtering is only ever client-side: the server's cost is the whole log
 * either way (reply §2 R8).  `index` is **not** renumbered, so a filtered
 * trace still says where each step sat in the run.
 */
export function filterTrace(
  entries: readonly TraceEntry[],
  predicate: (entry: TraceEntry) => boolean,
): readonly TraceEntry[] {
  return Object.freeze(entries.filter(predicate));
}
