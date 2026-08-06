/**
 * Rule lookup and de-instrumentation — `coverage.py:16-43`, transcribed.
 *
 * A hit log names rules by hash; a human wants the rule.  {@link getRuleById}
 * is the join, and {@link stripCoverageLogger} undoes the one thing
 * `kompile --coverage` did to the rule on the way in, so that what is printed is
 * the rule the author wrote rather than the rule the instrumentation left
 * behind.  Together they are the whole of `pyk coverage`
 * (`__main__.py:403-413`) minus the two minimization passes kast declares out of
 * scope (see `cli.ts`).
 *
 * ## What the instrumentation actually looks like
 *
 * `GenerateCoverage.gen` (`GenerateCoverage.java:49-79`) rewrites every rule
 * that has a `Source` and is not a macro into
 *
 * ```
 * KRewrite(lhs, KApply("sideEffect:" + topSort,
 *                      KApply("#logToFile", <coverage.txt path>, <uid> + "\n"),
 *                      rhs))
 * ```
 *
 * — an **arity-2** `sideEffect:<Sort>` application whose first argument is the
 * logging call and whose second is the rule's real right-hand side.  That is
 * verified, not inferred: all 168 rules of `fixtures/compiled/compiled.json` (a
 * real `kompile --coverage` build) carry exactly that shape across 8 distinct
 * sorts, and none carries pyk's (`fixtures/PROVENANCE.md`, "the instrumented
 * shape").
 *
 * ## Deliberate deviations
 *
 * 1. **Both instrumentation shapes are stripped** (plan §4 deviations).  pyk
 *    matches only a `project:`-labelled application wrapping a **2-item
 *    `KSequence`** (`coverage.py:39-42`) — the shape K emitted before the
 *    `sideEffect` rework — so on any definition built by a current `kompile` it
 *    silently returns the rule *with* the logger still in it, which is exactly
 *    the case `pyk coverage` exists to serve.  {@link stripCoverageLogger}
 *    handles the current shape first, then pyk's, and leaves anything else
 *    alone.  Neither branch can fire spuriously on the other's input: the label
 *    prefixes are disjoint.
 * 2. **The current shape is matched on `#logToFile`, not on `sideEffect:`
 *    alone.**  `sideEffect` is an ordinary `K-IO` function that a semantics may
 *    use in its own right-hand sides, so matching the label prefix by itself
 *    would silently delete a user's side effect.  Requiring the first argument
 *    to be a `#logToFile` application costs one comparison and makes a false
 *    positive impossible in practice.
 * 3. **{@link getRuleById} scans `definition.rules`**, which is
 *    `modules.flatMap(moduleRules)` (`outer.ts`) — the same sentences in the
 *    same order as pyk's nested loop over `definition.modules` /
 *    `module.sentences` (`coverage.py:26-30`), filtered to `KRule` the same
 *    way.  It is memoised on the definition, so the `kcovr rules` loop is one
 *    scan rather than one per hit; pyk re-walks the whole definition for every
 *    id in the coverage file.
 * 4. **The failure is a {@link RuleNotFoundError}**, whose first line is pyk's
 *    `ValueError` text verbatim (`coverage.py:31`) with a second line saying
 *    what to do about it.
 */

import { Atts, type KDefinition, type KInner, type KRule, krewrite, letKRule } from "@kframework-ts/kast";

import { RuleNotFoundError } from "./errors.js";
import type { RuleId } from "./hits.js";

/**
 * The label prefix `GenerateCoverage.java:66-67` builds the wrapper from —
 * `"sideEffect:" + inj.topSort(body)`, so the full label carries the rule's top
 * sort (`sideEffect:GeneratedTopCell`, `sideEffect:Bool`, …) and cannot be
 * matched exactly.
 */
export const SIDE_EFFECT_LABEL_PREFIX = "sideEffect:";

/**
 * The hook that does the writing (`GenerateCoverage.java:69`, implemented at
 * `io.cpp:560` and **only** by the LLVM backend).
 *
 * Requiring it is what distinguishes coverage instrumentation from a semantics'
 * own use of `sideEffect` — see deviation 2 in the module header.
 */
export const LOG_TO_FILE_LABEL = "#logToFile";

/**
 * The label prefix pyk's `strip_coverage_logger` looks for
 * (`coverage.py:39`) — the *obsolete* instrumentation shape, kept because a
 * definition compiled by an older K still has it and because dropping it would
 * be a regression against pyk on the inputs pyk does handle.
 */
export const PROJECT_LABEL_PREFIX = "project:";

/**
 * Find a rule by the `UNIQUE_ID` a hit log names it with — `get_rule_by_id`
 * (`coverage.py:16-31`).
 *
 * Linear, first match wins, `KRule` sentences only: a `KClaim` or a `KContext`
 * carrying the same attribute would not be a rule anyone can have applied.  The
 * comparison is on the **full** 64-hex id, never on pyk's 12-character prefix
 * spelling (`ktool/kprint.py:235`) — that is `@kframework-ts/kompiled`'s
 * `lookupRule`'s business, and mixing the two here would make a 12-character
 * argument mean something different from a 64-character one.
 *
 * @throws {RuleNotFoundError} no rule in the definition's import closure
 *   carries that id.
 */
export function getRuleById(definition: KDefinition, ruleId: RuleId): KRule {
  for (const rule of definition.rules) {
    if (rule.att.get(Atts.UNIQUE_ID) === ruleId) return rule;
  }
  throw new RuleNotFoundError(ruleId);
}

/**
 * Remove the coverage logger `kompile --coverage` wrapped around a rule's
 * right-hand side — `strip_coverage_logger` (`coverage.py:34-43`), for **both**
 * instrumentation shapes.
 *
 * ```
 * rule LHS => sideEffect:S(#logToFile(…), RHS)   ⇒   rule LHS => RHS   (current)
 * rule LHS => project:S(RHS0 ~> RHS)             ⇒   rule LHS => RHS   (pyk's)
 * ```
 *
 * A rule whose body is not a `KRewrite`, or whose right-hand side matches
 * neither shape, is returned **unchanged** — including the identity of the
 * object, since `letKRule` is not called on that path.  That is deliberate: this
 * runs over every rule a caller pretty-prints, most of which (on an
 * uninstrumented definition) are not instrumented at all, and "leave it alone"
 * is the right answer for all of them.
 *
 * Only the top-level right-hand side is examined, exactly as upstream: the
 * instrumentation is applied once per rule at the root (`GenerateCoverage.java:76`),
 * so there is nothing nested to find and a traversal would only risk mangling a
 * semantics' own `sideEffect` call.
 */
export function stripCoverageLogger(rule: KRule): KRule {
  const body = rule.body;
  if (body.node !== "KRewrite") return rule;

  const stripped = stripLoggerFromRhs(body.rhs);
  return stripped === undefined ? rule : letKRule(rule, { body: krewrite(body.lhs, stripped) });
}

/**
 * The right-hand side with its logger removed, or `undefined` when there is no
 * logger to remove.
 *
 * `undefined` rather than "the term unchanged" so that {@link stripCoverageLogger}
 * can tell "stripped to something identical" (impossible, but the type should
 * not have to argue it) from "nothing matched".
 */
function stripLoggerFromRhs(rhs: KInner): KInner | undefined {
  if (rhs.node !== "KApply") return undefined;

  // The current shape (`GenerateCoverage.java:66-78`): an arity-2
  // `sideEffect:<Sort>` whose first argument is the `#logToFile` call.
  if (rhs.label.name.startsWith(SIDE_EFFECT_LABEL_PREFIX) && rhs.args.length === 2) {
    const [logger, realRhs] = rhs.args;
    if (logger?.node === "KApply" && logger.label.name === LOG_TO_FILE_LABEL && realRhs !== undefined) {
      return realRhs;
    }
  }

  // pyk's shape (`coverage.py:39-42`): a `project:`-labelled application whose
  // *first argument* is a two-item `KSequence`, of which the second item is the
  // real right-hand side.  Note that pyk checks neither the application's arity
  // nor what the first sequence item is, and neither does this.
  if (rhs.label.name.startsWith(PROJECT_LABEL_PREFIX)) {
    const sequence = rhs.args[0];
    if (sequence?.node === "KSequence" && sequence.items.length === 2) return sequence.items[1];
  }

  return undefined;
}
