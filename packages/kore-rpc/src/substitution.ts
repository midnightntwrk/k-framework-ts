/**
 * The `\and`-of-`\equals` encoding kore-rpc uses for substitutions, taken apart
 * and put back together.
 *
 * Transcribed from pyk's `State` (`k/pyk/src/pyk/kore/rpc.py:514-595`):
 * `_subst_to_dict` (`:556-579`) is {@link decodeSubstitution},
 * `_dict_to_subst` (`:581-586`) is {@link encodeSubstitution}, and the `kore`
 * property (`:588-595`) is {@link stateKore}.
 *
 * # What the wire carries
 *
 * `ExecuteState.substitution`, `ExecuteState.ruleSubstitution`,
 * `Condition.substitution` and `SatModelResult.substitution` are **KORE
 * patterns**, not JSON maps: a conjunction of `\equals(Var, Value)`, associated
 * in whatever direction the server happened to build it — the vendored
 * `execute/branching` golden carries a *left*-nested pair inside a two-element
 * `\and`, and a booster `get-model` carries a flat three-element one. The
 * flattener is `@kframework-ts/kore`'s `conjuncts`, which recurses through
 * `\and` at any arity and drops `\top` (its unit), so all three shapes — and
 * the empty substitution, spelled `\top{SortGeneratedTopCell{}}` — decode
 * identically. That is why `codec.ts` keeps the pattern and this module is
 * separate: the wire type is a pattern, and the map is an interpretation of it.
 *
 * # The sorts, and which one is checked against which
 *
 * A substitution entry is `\equals{S, SortGeneratedTopCell{}}(X : S, value)`.
 * Two sorts, and pyk checks them differently:
 *
 * - the **result** sort — `Equals.sort`, the second in `{S, T}` — must be
 *   `SortGeneratedTopCell{}`, always, whatever the variable's sort is;
 * - the **operand** sort — `Equals.opSort`, the first — must equal the
 *   variable's own sort, and is *not* required to be anything in particular.
 *
 * The result-sort check is `rpc.py:561-564`; the operand-sort check is
 * `:567-570`. pyk's error message for the second prints the two in
 * operand-then-key order (the message itself is `:569`), which reads backwards
 * next to its own condition; it is transcribed as written, because a message a
 * reader can grep for in pyk's source is worth more than one that reads better.
 *
 * # Deviations from pyk, all forced or deliberate
 *
 * 1. **The map is keyed by a string.** pyk's is a `FrozenDict[EVar, Pattern]`,
 *    which works because Python hashes its frozen dataclasses structurally. A
 *    JavaScript `Map` keyed by an `EVar` object would compare by reference and
 *    never hit, so the key is {@link substitutionKey} — the variable's KORE
 *    text, `X : SortInt{}`, which is exactly as discriminating (name *and*
 *    sort, both, which matters: `X : SortInt{}` and `X : SortBool{}` are two
 *    variables). The `EVar` itself is kept in the entry, because
 *    {@link encodeSubstitution} needs its sort back.
 * 2. **Failures are `SyntaxError`s with a JSON path**, this package's
 *    convention (`internal.ts`), not pyk's `ValueError`.
 * 3. **A rejected pattern is named by its tag, not its full text.** pyk
 *    interpolates `pattern.text`, and a substitution entry that is not an
 *    `\equals` could be a four-megabyte configuration; this package's rule is
 *    that containers are named by shape. Sorts and variables — bounded, and
 *    the actual information — are still printed in full.
 * 4. **One typo is repaired.** pyk's first message reads `Expected \equals as
 *    substituion entry` (`rpc.py:560`) — "substituion", missing a `t`. The
 *    messages here match pyk's wording deliberately, so that a report filed
 *    against either client is greppable in the other; this is the one place
 *    that rule is broken, because reproducing a misspelling makes the *English*
 *    ungreppable to anyone who did not already know about it. Everything else
 *    in that message is pyk's, word for word.
 */

import {
  type EVar,
  type KoreJson,
  type Pattern,
  type Sort,
  and,
  conjuncts,
  equals,
  koreText,
} from "@kframework-ts/kore";
import { SORT_GENERATED_TOP_CELL } from "@kframework-ts/kore/prelude";
import { rpcError } from "./internal.js";
import type { Condition, ExecuteState } from "./types.js";

//////////////////////
// The map          //
//////////////////////

/**
 * One binding of a decoded substitution: the variable it binds, and to what.
 *
 * The variable is carried whole rather than reconstructed from the map key —
 * see deviation (1) in the header.
 */
export interface SubstitutionEntry {
  readonly variable: EVar;
  readonly value: Pattern;
}

/**
 * A decoded substitution — pyk's `FrozenDict[EVar, Pattern]`.
 *
 * Iteration order is the order the conjuncts appeared on the wire, which is
 * what makes {@link encodeSubstitution} ∘ {@link decodeSubstitution} shape-
 * preserving for a flat `\and` (it re-associates a nested one, which pyk does
 * too).
 */
export type Substitution = ReadonlyMap<string, SubstitutionEntry>;

/**
 * The map key for a variable: its KORE text, `X : SortInt{}`.
 *
 * Both halves are load-bearing. Two variables with the same name and different
 * sorts are different variables, and a substitution binding both is not a
 * duplicate-key error.
 */
export function substitutionKey(variable: EVar): string {
  return koreText(variable);
}

/** Structural sort equality, via the one canonical rendering of a sort. */
function sameSort(left: Sort, right: Sort): boolean {
  return koreText(left) === koreText(right);
}

//////////////////////
// Decoding         //
//////////////////////

/** One conjunct into one binding — pyk's inner `extract_entry` (`rpc.py:558-571`). */
function extractEntry(pattern: Pattern, path: string): SubstitutionEntry {
  if (pattern.tag !== "Equals") {
    throw rpcError(`Expected \\equals as substitution entry, got: ${pattern.tag}`, path);
  }
  if (!sameSort(pattern.sort, SORT_GENERATED_TOP_CELL)) {
    throw rpcError(
      `Expected ${koreText(SORT_GENERATED_TOP_CELL)} as substitution entry sort, got: ${koreText(pattern.sort)}`,
      path,
    );
  }

  const variable = pattern.left;
  if (variable.tag !== "EVar") {
    throw rpcError(`Expected an element variable as substitution entry key, got: ${variable.tag}`, path);
  }
  if (!sameSort(variable.sort, pattern.opSort)) {
    // pyk `rpc.py:567-570`, operand sort first — see the header.
    throw rpcError(
      `Mismatch between substitution entry and key sort: ${koreText(pattern.opSort)} and ${koreText(variable.sort)}`,
      path,
    );
  }

  return { variable, value: pattern.right };
}

/**
 * Flatten a substitution pattern into its bindings — pyk `State._subst_to_dict`
 * (`rpc.py:556-579`).
 *
 * `\top{SortGeneratedTopCell{}}` — how both backends spell "no bindings" —
 * yields an empty map rather than an error, because `conjuncts` drops it.
 *
 * @throws {SyntaxError} if a conjunct is not an `\equals`, is not at
 *   `SortGeneratedTopCell{}`, has a non-variable left-hand side, disagrees with
 *   its own operand sort, or binds a variable a previous conjunct already
 *   bound. All five are pyk's checks, in pyk's order.
 */
export function decodeSubstitution(pattern: Pattern, path = "substitution"): Substitution {
  const result = new Map<string, SubstitutionEntry>();

  for (const conjunct of conjuncts(pattern)) {
    const entry = extractEntry(conjunct, path);
    const key = substitutionKey(entry.variable);
    const previous = result.get(key);
    if (previous !== undefined) {
      throw rpcError(
        `Duplicate substitution entry key: ${key} -> [${koreText(previous.value)}, ${koreText(entry.value)}]`,
        path,
      );
    }
    result.set(key, entry);
  }

  return result;
}

/** {@link decodeSubstitution} straight off a KORE-JSON envelope, which is how every field carries one. */
export function decodeSubstitutionJson(substitution: KoreJson, path = "substitution"): Substitution {
  return decodeSubstitution(substitution.term, path);
}

//////////////////////
// Encoding         //
//////////////////////

/**
 * Bindings back into the wire pattern — pyk `State._dict_to_subst`
 * (`rpc.py:581-586`).
 *
 * One flat n-ary `\and{SortGeneratedTopCell{}}` of
 * `\equals{varSort, SortGeneratedTopCell{}}(var, value)`, in map order. Note
 * that an empty substitution becomes `\and{SortGeneratedTopCell{}}()`, the
 * nullary conjunction, and not the `\top` a server would have sent — pyk's
 * function has the same property, and {@link decodeSubstitution} reads both.
 */
export function encodeSubstitution(substitution: Substitution): Pattern {
  return and(
    SORT_GENERATED_TOP_CELL,
    [...substitution.values()].map((entry) =>
      equals(entry.variable.sort, SORT_GENERATED_TOP_CELL, entry.variable, entry.value),
    ),
  );
}

//////////////////////
// State accessors  //
//////////////////////

/** An {@link ExecuteState}'s `substitution`, decoded; `undefined` if it carried none. */
export function stateSubstitution(state: ExecuteState): Substitution | undefined {
  return state.substitution === undefined
    ? undefined
    : decodeSubstitutionJson(state.substitution, "state.substitution");
}

/**
 * An {@link ExecuteState}'s `rule-substitution`, decoded — the match the rule
 * that fired made, as opposed to the constraints on the configuration.
 */
export function stateRuleSubstitution(state: ExecuteState): Substitution | undefined {
  return state.ruleSubstitution === undefined
    ? undefined
    : decodeSubstitutionJson(state.ruleSubstitution, "state.rule-substitution");
}

/** A {@link Condition}'s `substitution`, decoded — `implies`'s witness. */
export function conditionSubstitution(condition: Condition): Substitution {
  return decodeSubstitutionJson(condition.substitution, "condition.substitution");
}

/**
 * Reassemble a state into the single pattern it stands for — pyk's
 * `State.kore` (`rpc.py:588-595`).
 *
 * ```
 * term                                                       (neither present)
 * \and{SortGeneratedTopCell{}}(term, eq₁, …, eqₙ)            (substitution only)
 * \and{SortGeneratedTopCell{}}(term, predicate)              (predicate only)
 * \and{SortGeneratedTopCell{}}(
 *   \and{SortGeneratedTopCell{}}(term, eq₁, …, eqₙ),
 *   predicate)                                               (both)
 * ```
 *
 * Three details of that shape are pyk's and are easy to get wrong:
 *
 * - the substitution is **spliced flat** into the conjunction with the term
 *   (`(_kore,) + …ops`), so a state with two bindings is a three-element
 *   `\and`, not a term conjoined with an `\and`;
 * - the predicate is conjoined in a **second, nested** step, so with both
 *   present the result is nested and not flat;
 * - the sort is `SortGeneratedTopCell{}` at every level, hard-coded, regardless
 *   of the term's own sort.
 *
 * `ruleId`, `rulePredicate` and `ruleSubstitution` take no part: they describe
 * the rewrite that produced the state, not the state.
 *
 * @throws {SyntaxError} if the substitution does not decode — reassembly goes
 *   through the map, exactly as pyk's does, so the validations apply here too.
 */
export function stateKore(state: ExecuteState): Pattern {
  let result: Pattern = state.term.term;

  const substitution = stateSubstitution(state);
  if (substitution !== undefined) {
    const bindings = [...substitution.values()].map((entry) =>
      equals(entry.variable.sort, SORT_GENERATED_TOP_CELL, entry.variable, entry.value),
    );
    result = and(SORT_GENERATED_TOP_CELL, [result, ...bindings]);
  }

  if (state.predicate !== undefined) {
    result = and(SORT_GENERATED_TOP_CELL, [result, state.predicate.term]);
  }

  return result;
}
