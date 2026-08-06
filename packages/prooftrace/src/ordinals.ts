/**
 * **Ordinal → rule identity**: turning the bare integer in a rule event into
 * `LABEL`, `Source(…)`, `Location(…)`, the module, and the `UNIQUE_ID` that the
 * kore-rpc trace path keys on.
 *
 * # The rule, and where it comes from
 *
 * An axiom's ordinal is **its zero-based position in the sequence of `axiom`
 * and `claim` declarations of `definition.kore`, in file order**.  Nothing
 * writes it into the file; it is assigned at load time, by
 * `kore_definition::preprocess`:
 *
 * ```cpp
 * unsigned next_ordinal = 0;
 * for (auto iter = axioms_.begin(); iter != axioms_.end();) {
 *   auto *axiom = *iter;
 *   axiom->ordinal_ = next_ordinal;
 *   ordinals_[next_ordinal++] = axiom;
 *   …
 * ```
 * — `llvm-backend lib/ast/definition.cpp:222-237`, where `axioms_` was filled
 * in declaration order by `kore_definition::add_module`
 * (`definition.cpp:51-71`, the `kore_axiom_declaration` arm, which covers
 * `claim` too since a claim is an axiom declaration with `is_claim` set).
 *
 * Three details of that loop matter and are reproduced:
 *
 * 1. **Non-required axioms still consume an ordinal.** `next_ordinal++` runs
 *    before the `axioms_.erase` at `:229`, so the numbering is over *every*
 *    declaration, not the ones the backend kept.
 * 2. **Aliases are expanded first** (`:218-220`) — a whole-pattern rewrite that
 *    does not add or remove declarations, so it cannot shift the numbering.
 * 3. **`insert_reserved_symbols` adds a module but no axioms** (`:77-105`), so
 *    the synthetic `K-RAW-TERM` module does not shift it either.
 *
 * # The pyk discrepancy this package had to work around
 *
 * pyk's own test resolves an ordinal by grepping for `ordinal{}("N")` in the
 * definition text (`pyk/src/tests/integration/kllvm/test_prooftrace.py:24-29`).
 * That attribute **does not exist in `definition.kore`**: `preprocess` *adds*
 * it to the in-memory axiom (`definition.cpp:233-237`), which is why the test
 * calls `definition.preprocess()` and then greps `repr(definition)` rather than
 * the file.  A reader that has only the file — which is this package's only
 * input — cannot use that path at all, and grepping the file for `ordinal{}`
 * finds nothing.  Counting declarations is the same numbering by construction,
 * and `test/reference.test.ts` checks it against `kore-proof-trace`'s own
 * resolution over three real traces.
 *
 * # Why not ask the backend
 *
 * `llvm-kompile-compute-ordinal <kompiled-dir> <line>` exists and goes the
 * *other* way (source line → ordinal), one spawn per query, and needs a
 * kompiled directory rather than a `definition.kore`.  `kore-proof-trace` will
 * resolve ordinals if handed the definition, but only as printed text.  Neither
 * is a join a program can hold, which is what a trace assembler needs.
 */

import {
  ATT_LABEL,
  ATT_UNIQUE_ID,
  attLocation,
  attSource,
  attString,
  type App,
  type LazyDefinition,
} from "@kframework-ts/kore";
import type { Location } from "@kframework-ts/kast";

/**
 * Everything an ordinal resolves to.
 *
 * The first four fields are `@kframework-ts/cterm`'s `TraceRuleIdentity`
 * verbatim (`cterm/src/trace.ts:101-110`), so the two trace paths agree field
 * for field; `ordinal` and `uniqueId` are what this path adds.  `null` rather
 * than `undefined` throughout, for the same reason cterm gives: a record must
 * survive `JSON.stringify` with every key present.
 */
export interface OrdinalRuleIdentity {
  /** `label` if the axiom declared one, else the `UNIQUE_ID`, else `axiom@<ordinal>`. */
  readonly label: string;
  /**
   * The `label{}(…)` attribute exactly as declared, or `null` when there is
   * none — before {@link label}'s fallback chain is applied.
   *
   * Carried separately because it is what `kore-proof-trace` prints between its
   * first pair of brackets (`ProofTraceParser.h:536-538`, where a missing label
   * leaves the `std::string` empty), and a conformance test against that output
   * has to be able to tell "no label" from "a label that happens to look like a
   * fallback".  A consumer wanting a name should use {@link label}.
   */
  readonly declaredLabel: string | null;
  /** The `.k` file the rule was written in, unwrapped from `Source(…)`. */
  readonly source: string | null;
  /** `[startLine, startColumn, endLine, endColumn]`, all 1-based. */
  readonly location: Location | null;
  /** The `definition.kore` module that declares the axiom. */
  readonly module: string | null;
  /** The position this identity was found at — equal to its index in the index. */
  readonly ordinal: number;
  /**
   * `UNIQUE'Unds'ID`, the 64-hex id the kore-rpc `logs` family reports.
   *
   * `null` for the many generated axioms that carry none — sort-injection
   * axioms, functional/total axioms, and the configuration-initialization
   * equations that dominate a trace's pre-trace section.  Those are precisely
   * the axioms a kore-rpc trace could never name either.
   */
  readonly uniqueId: string | null;
}

/**
 * Ordinal → identity, as a dense array: `index[n]` is the axiom with ordinal
 * `n`, and the array's length is the definition's axiom count.
 *
 * An array rather than a `Map` because the ordinals are, by construction,
 * exactly `0 … n-1` with no gaps.
 */
export type OrdinalRuleIndex = readonly OrdinalRuleIdentity[];

/**
 * Build the index from a parsed `definition.kore`.
 *
 * Takes a `LazyDefinition`, to which an eagerly parsed `Definition` is
 * assignable.  A lazy parse — `parseDefinition(text, {lazyAxioms: true})` — is
 * the one to prefer: every field here comes off an axiom's *attributes* and
 * none off its body, so on a real semantics this is the difference between
 * holding the attributes of 200 000 axioms and holding their patterns.
 *
 * **`LazyAxiom` is in the filter, and this is not cosmetic.**  A lazy parse
 * spells an axiom `{tag: "LazyAxiom"}`, not `{tag: "Axiom"}`
 * (`kore/src/parser.ts:204-224`); `claim` is never lazy and keeps its tag
 * (`:1098-1099`).  Matching only `Axiom`/`Claim` — which is what
 * `@kframework-ts/cterm`'s `traceRuleIndexFromKore` does
 * (`cterm/src/trace.ts:174`) — yields an *empty* index on a lazily parsed
 * definition rather than an error.  Missing that here would silently number
 * every ordinal wrong, which is worse.
 *
 * `sentences` is walked in declaration order within each module and the modules
 * in file order, which is `add_module`'s order (`definition.cpp:52`) and
 * therefore the ordinal order.
 */
export function ordinalRuleIndex(definition: LazyDefinition): OrdinalRuleIndex {
  const index: OrdinalRuleIdentity[] = [];
  for (const module of definition.modules) {
    for (const sentence of module.sentences) {
      if (sentence.tag !== "Axiom" && sentence.tag !== "Claim" && sentence.tag !== "LazyAxiom") continue;
      index.push(identityOf(sentence.attrs, index.length, module.name));
    }
  }
  return Object.freeze(index);
}

/**
 * `index[ordinal]`, or `undefined`.
 *
 * A separate function rather than a bare subscript so the "the trace and the
 * definition are from different kompilations" case has one place to be
 * described: an out-of-range ordinal is exactly that symptom, and it is not an
 * error here — `records.ts` reports it as `resolved: false`, which is the same
 * three-valued honesty cterm's `TraceEntry.resolved` carries for a rule id the
 * definition index does not know.
 */
export function ordinalIdentity(index: OrdinalRuleIndex, ordinal: number): OrdinalRuleIdentity | undefined {
  return index[ordinal];
}

function identityOf(attrs: readonly App[], ordinal: number, module: string): OrdinalRuleIdentity {
  const span = attLocation(attrs);
  const uniqueId = attString(attrs, ATT_UNIQUE_ID) ?? null;
  const declaredLabel = attString(attrs, ATT_LABEL) ?? null;
  return Object.freeze({
    // `attribute_set::key::Label` is what `parse_rule` reads for its `[label]`
    // column (`ProofTraceParser.h:536-538`); the fallback chain past it is
    // `KSentence.label`'s (`kast/outer.py:186-197`), extended with the ordinal
    // because an axiom can legitimately have neither.
    label: declaredLabel ?? uniqueId ?? `axiom@${String(ordinal)}`,
    declaredLabel,
    source: attSource(attrs) ?? null,
    location:
      span === undefined ? null : ([span.startLine, span.startColumn, span.endLine, span.endColumn] as Location),
    module,
    ordinal,
    uniqueId,
  });
}

/**
 * The one-line `LABEL:file:line` identity `kore-proof-trace` prints, for
 * comparing against its output.
 *
 * `get_start_line_location` (`llvm-backend include/kllvm/ast/util.h`) yields
 * `Source` and the *start line only*, and `parse_rule` joins them with `:`
 * (`ProofTraceParser.h:540-544`).  So the printed location is `file:line` with
 * no column, which is narrower than what {@link OrdinalRuleIdentity.location}
 * carries — the record keeps the full span, and this exists to reproduce the
 * tool's string exactly.
 */
export function referenceLocation(identity: OrdinalRuleIdentity): string {
  if (identity.source === null || identity.location === null) return "";
  return `${identity.source}:${String(identity.location[0])}`;
}
