/**
 * Term manipulation — a transcription of the definition-free half of
 * `pyk/kast/manip.py` (895 L) at K **v7.1.337**.
 *
 * # What is here, and what is not
 *
 * `manip.py` is two modules wearing one hat.  Most of what is below needs only
 * the term algebra and the prelude; the other half needs the outer syntax
 * layer, and is now here too, because the display layer
 * (`cterm`'s `CTermShow`, `kcfg`'s `KCFGShow`, `proof`'s `APRProofShow`) is its
 * consumer: {@link onAttributes} (`manip.py:498-511`),
 * {@link minimizeRuleLike} (`:534-560`) and {@link removeSourceMap} (`:563`),
 * together with {@link replaceRewritesWithImplies} (`:834-840`) and
 * {@link noCellRewriteToDots} (`:843-865`), which the implication-failure
 * report pairs.  `build_rule`, `build_claim` and `defunctionalize` need only
 * the existing `KDefinition` / `KAtt` APIs and are implemented below for CTerm.
 *
 * Still absent, and why: `remove_attrs` (`manip.py:567-573`) has no consumer in
 * pyk or here, and `minimize_rule` — which pyk itself deleted — has no
 * upstream to transcribe.
 *
 * The three functions at the bottom of this file arrived with the
 * pretty-printer, which is their only consumer:
 * {@link sortAssocLabel}, {@link sortAcCollections} and {@link undoAliases}.
 * Those, plus the outer-syntax half above, give this module a real edge to
 * `outer.ts` — `outer.ts` does not import this file, so there is no cycle.
 *
 * One helper is transcribed but **not exported**: `remove_semantic_casts`
 * (`manip.py:421-436`).  It is out of scope as API — nothing in the monorepo
 * calls it on its own — but {@link minimizeTerm} is defined as its composition
 * with {@link inlineCellMaps} (`manip.py:527-531`) and dropping it would change
 * that answer. `inlineCellMaps` is exported because three display-layer call
 * sites need that pass by itself.
 *
 * # One deliberate behavioural deviation
 *
 * {@link noCellRewriteToDots} does what pyk's docstring says rather than what
 * pyk's body does; upstream's is the identity function on every input.  Its
 * own doc-comment carries the argument.
 *
 * # `abstract_term_safely` hashes a Python `repr`, not JSON
 *
 * `abstract_term_safely` (`manip.py:600-611`) names its fresh variable from
 * `hash_str(k)`, and `hash_str` (`utils.py:373-376`) is sha256 over
 * **`str(x)`** — for a frozen dataclass, its generated `__repr__`.  It is *not*
 * `KAst.hash`, which hashes `to_json()` (`kast.py:32-35`); the two digests
 * differ, and pyk's own test table pins the repr one (`test_manip.py:270-276`
 * expects `K_CELL_8b13e996` for `KVariable('_Gen')`).  So {@link hashStr}
 * reproduces CPython's dataclass repr, down to `str.__repr__`'s quote choice
 * and its printability rules, rather than reusing `hashOf` from `eq.ts`.
 * `test/manip-parity.test.ts` pins it against pyk.
 *
 * # Recursion
 *
 * `inner.ts` runs every traversal on an explicit work stack and so do
 * {@link hashStr} and {@link renameGeneratedVars} here.  Two functions keep
 * pyk's recursion because the recursion is not over term *depth*:
 * `_ml_constraint_to_bool` (`manip.py:121-173`) descends the ML connective
 * nesting, and `_push_down_rewrites` (`manip.py:364-396`) descends the items of
 * one `KSequence`.
 *
 * # Deviations
 *
 * - pyk's `ValueError` becomes `TypeError`, as everywhere else in this package.
 * - `ml_pred_to_bool`'s two `_LOGGER.warning` calls (`manip.py:165,169`) are
 *   dropped; this package has no logger.
 * - `free_vars` returns a `ReadonlySet<string>` where pyk returns a
 *   `frozenset`.  Ours is ordered by first occurrence; pyk's is not ordered at
 *   all.  Every consumer in this file uses it for membership only, so the extra
 *   determinism is free.
 */

import { createHash } from "node:crypto";
import { compare, eq, eqLabel, eqSort, hashOf } from "./eq.js";
import { Atts, KAtt, attEntry } from "./att.js";
import {
  Subst,
  bottomUp,
  collect,
  flattenLabel,
  isCell,
  kapply,
  krewrite,
  ksequence,
  ksort,
  kvariable,
  keepVarsSorted,
  letKApply,
  letTerms,
  match,
  rewriteApply,
  terms,
  topDown,
  varOccurrences,
  type KInner,
  type KRewrite,
  type KSort,
  type KVariable,
} from "./inner.js";
import {
  KDefinition,
  kclaim,
  krule,
  letKClaim,
  letKFlatModule,
  letKRule,
  letSentenceAtt,
  type KClaim,
  type KFlatModule,
  type KRule,
  type KRuleLike,
  type KSentence,
} from "./outer.js";
import { DOTS, GENERATED_TOP_CELL } from "./prelude/k.js";
import { FALSE, TRUE, andBool, impliesBool, notBool, orBool } from "./prelude/kbool.js";
import { isTop, mlAnd, mlBottom, mlEquals, mlEqualsTrue, mlImplies, mlOr, mlTop } from "./prelude/ml.js";
import { reprKInner } from "./pyrepr.js";
import { indexedRewrite } from "./rewrite.js";

/** Index into an array whose bounds the caller has already established. */
function at<T>(xs: readonly T[], i: number): T {
  const x = xs[i];
  if (x === undefined) throw new RangeError(`Index ${i} is out of range (length ${xs.length})`);
  return x;
}

/**
 * `manip.py:146,151` compare against `KSort('Int')`, not the prelude's `INT`;
 * a `KVariable`'s sort may be absent, a `KToken`'s never is.
 */
function isIntSorted(sort: KSort | undefined): boolean {
  return sort !== undefined && eqSort(sort, ksort("Int"));
}

/** List membership under structural equality — Python's `in` on a `list`. */
function containsTerm(items: readonly KInner[], item: KInner): boolean {
  return items.some((other) => eq(item, other));
}

//////////////////////////////
// CPython's `repr`         //
//////////////////////////////

/** pyk's `hash_str` applied to a term (`utils.py:373-376`): sha256 of `str(x)`. */
function hashStr(term: KInner): string {
  return createHash("sha256").update(reprKInner(term), "utf8").digest("hex");
}

/** The pyk-compatible KInner dataclass repr, available through the public barrel. */
export { reprKInner } from "./pyrepr.js";

//////////////////////////////
// Variables                //
//////////////////////////////

/**
 * How many times each variable occurs (`manip.py:259-264`).
 *
 * pyk's `Counter` answers `0` for a name it does not hold; a `Map` answers
 * `undefined`, so read it as `counts.get(name) ?? 0`.
 */
export function countVars(term: KInner): Map<string, number> {
  const counter = new Map<string, number>();
  for (const [name, occurrences] of varOccurrences(term)) counter.set(name, occurrences.length);
  return counter;
}

/** The names of the variables in a term (`manip.py:267-268`). */
export function freeVars(term: KInner): ReadonlySet<string> {
  return new Set(countVars(term).keys());
}

/** Is this an anonymous variable — one whose name starts with `_` (`manip.py:589-590`)? */
export function isAnonVar(term: KInner): boolean {
  return term.node === "KVariable" && term.name.startsWith("_");
}

/** The ML connectives that make a term not term-like (`manip.py:55-65`). */
const ML_LABELS: ReadonlySet<string> = new Set([
  "#Equals",
  "#And",
  "#Or",
  "#Top",
  "#Bottom",
  "#Implies",
  "#Not",
  "#Ceil",
  "#Forall",
  "#Exists",
]);

/**
 * Is `term` free of ML connectives and of `@`-prefixed variables
 * (`manip.py:44-69`)?
 */
export function isTermLike(term: KInner): boolean {
  let nonTermFound = false;
  collect((subterm) => {
    if (subterm.node === "KVariable" && subterm.name.startsWith("@")) nonTermFound = true;
    if (subterm.node === "KApply" && ML_LABELS.has(subterm.label.name)) nonTermFound = true;
  }, term);
  return !nonTermFound;
}

//////////////////////////////
// Bool ↔ ML                //
//////////////////////////////

/**
 * A `Bool` term as an ML predicate (`manip.py:106-114`).
 *
 * The term is first split on `_andBool_`, so a conjunction becomes a
 * conjunction of `#Equals{Bool, sort}(true, _)` rather than one equation over
 * the whole conjunction; `true` and `false` become `#Top` and `#Bottom`.
 */
export function boolToMlPred(term: KInner, sort: string | KSort = GENERATED_TOP_CELL): KInner {
  const toMl = (condition: KInner): KInner => {
    if (eq(condition, TRUE)) return mlTop(sort);
    if (eq(condition, FALSE)) return mlBottom(sort);
    return mlEqualsTrue(condition, sort);
  };
  return mlAnd(
    flattenLabel("_andBool_", term).map((condition) => toMl(condition)),
    sort,
  );
}

/** Options for {@link mlPredToBool} (`manip.py:117`). */
export interface MlPredToBoolOptions {
  /** Replace a `#Ceil` or `#Exists` with a fresh variable instead of failing. */
  readonly abstractUnsafe?: boolean;
  /** Return an unconvertible predicate unchanged instead of failing. */
  readonly keepUnsafe?: boolean;
}

/**
 * An ML predicate as a `Bool` term (`manip.py:117-175`).
 *
 * Throws on anything it cannot convert, unless `keepUnsafe` returns it as it
 * stands or `abstractUnsafe` replaces it with a variable named after its hash.
 * The two options are mutually exclusive.
 */
export function mlPredToBool(term: KInner, options: MlPredToBoolOptions = {}): KInner {
  const { abstractUnsafe = false, keepUnsafe = false } = options;
  if (abstractUnsafe && keepUnsafe) {
    throw new TypeError("abstractUnsafe and keepUnsafe are mutually exclusive");
  }

  // `manip.py:121-173`.  The recursion follows the ML connective nesting, not
  // the term's depth.
  const toBool = (k: KInner): KInner => {
    if (k.node === "KApply") {
      const name = k.label.name;
      if (name === "#Top") return TRUE;
      if (name === "#Bottom") return FALSE;
      if (name === "#Not" && k.args.length === 1) return notBool(toBool(at(k.args, 0)));
      if (name === "#And") return andBool(k.args.map((arg) => toBool(arg)));
      if (name === "#Or") return orBool(k.args.map((arg) => toBool(arg)));
      if (name === "#Implies" && k.args.length === 2) {
        return impliesBool(toBool(at(k.args, 0)), toBool(at(k.args, 1)));
      }
      if (name === "#Equals") {
        // `first, second = _kast.args` (`manip.py:136`) raises before any of
        // the fallbacks below can run.
        if (k.args.length !== 2) throw new TypeError(`#Equals takes 2 arguments, got ${k.args.length}`);
        const first = at(k.args, 0);
        const second = at(k.args, 1);
        if (eq(first, TRUE)) return second;
        if (eq(first, FALSE)) return notBool(second);
        if (eq(second, TRUE)) return first;
        if (eq(second, FALSE)) return notBool(first);
        if (first.node === "KVariable" || first.node === "KToken") {
          return kapply(isIntSorted(first.sort) ? "_==Int_" : "_==K_", k.args);
        }
        if (second.node === "KVariable" || second.node === "KToken") {
          return kapply(isIntSorted(second.sort) ? "_==Int_" : "_==K_", k.args);
        }
        if (
          first.node === "KSequence" &&
          second.node === "KSequence" &&
          first.items.length === 1 &&
          second.items.length === 1
        ) {
          return kapply("_==K_", [at(first.items, 0), at(second.items, 0)]);
        }
        if (isTermLike(first) && isTermLike(second)) return kapply("_==K_", [first, second]);
      }
      if (abstractUnsafe) {
        if (name === "#Equals") return kapply("_==K_", k.args);
        // `manip.py:165,169` also log a warning; this package has no logger.
        if (name === "#Ceil") return abstractTermSafely(k, { baseName: "Ceil" });
        if (name === "#Exists") return abstractTermSafely(k, { baseName: "Exists" });
      }
      if (keepUnsafe) return k;
    }
    throw new TypeError(`Could not convert ML predicate to sort Bool: ${reprKInner(k)}`);
  };

  return toBool(term);
}

/**
 * `KRewrite`s applied left to right to simplify a `Bool` term
 * (`manip.py:183-201`).
 *
 * Four of the eighteen rules are **degenerate** and that is faithful, not a
 * transcription slip: `andBool([TRUE, X])` builds just `X` (the unit is
 * dropped, `inner.py:912-932`), so `andBool([TRUE, #REST]) => #REST` is the
 * identity rewrite `#REST => #REST`.  Same for its mirror and for the two
 * `orBool([FALSE, …])` rules.
 *
 * pyk guards with `if k is None: return None` (`manip.py:179-180`), which is
 * unreachable under its own type annotation; there is no such value here.
 */
export function simplifyBool(term: KInner): KInner {
  const lhs = kvariable("#LHS");
  const rhs = kvariable("#RHS");
  const v1 = kvariable("#V1");
  const v2 = kvariable("#V2");
  const rest = kvariable("#REST");

  const rules: readonly (readonly [KInner, KInner])[] = [
    [kapply("_==K_", [lhs, TRUE]), lhs],
    [kapply("_==K_", [TRUE, rhs]), rhs],
    [kapply("_==K_", [lhs, FALSE]), notBool(lhs)],
    [kapply("_==K_", [FALSE, rhs]), notBool(rhs)],
    [notBool(FALSE), TRUE],
    [notBool(TRUE), FALSE],
    [notBool(kapply("_==K_", [v1, v2])), kapply("_=/=K_", [v1, v2])],
    [notBool(kapply("_=/=K_", [v1, v2])), kapply("_==K_", [v1, v2])],
    [notBool(kapply("_==Int_", [v1, v2])), kapply("_=/=Int_", [v1, v2])],
    [notBool(kapply("_=/=Int_", [v1, v2])), kapply("_==Int_", [v1, v2])],
    [andBool([TRUE, rest]), rest],
    [andBool([rest, TRUE]), rest],
    [andBool([FALSE, rest]), FALSE],
    [andBool([rest, FALSE]), FALSE],
    [orBool([FALSE, rest]), rest],
    [orBool([rest, FALSE]), rest],
    [orBool([TRUE, rest]), TRUE],
    [orBool([rest, TRUE]), TRUE],
  ];

  let result = term;
  for (const [from, to] of rules) result = rewriteApply(krewrite(from, to), result);
  return result;
}

/** ML → Bool → simplify → ML (`manip.py:211-212`). */
export function normalizeMlPred(pred: KInner, options: { readonly keepUnsafe?: boolean } = {}): KInner {
  return boolToMlPred(simplifyBool(mlPredToBool(pred, { keepUnsafe: options.keepUnsafe ?? false })));
}

//////////////////////////////
// Rewrites                 //
//////////////////////////////

/** Every `KRewrite` in the term replaced by its LHS (`manip.py:215-216`). */
export function extractLhs(term: KInner): KInner {
  return topDown((subterm) => (subterm.node === "KRewrite" ? subterm.lhs : subterm), term);
}

/** Every `KRewrite` in the term replaced by its RHS (`manip.py:219-220`). */
export function extractRhs(term: KInner): KInner {
  return topDown((subterm) => (subterm.node === "KRewrite" ? subterm.rhs : subterm), term);
}

/**
 * Push `KRewrite`s as far down the term as they will go (`manip.py:363-398`).
 *
 * A rewrite of two applications of the same label and arity becomes that label
 * applied to per-argument rewrites; a rewrite of two sequences is peeled from
 * whichever end the two agree on; and a rewrite from a sequence to its own
 * trailing variable becomes a rewrite of the prefix to the empty sequence.
 */
export function pushDownRewrites(term: KInner): KInner {
  const push = (k: KInner): KInner => {
    if (k.node !== "KRewrite") return k;
    const lhs = k.lhs;
    const rhs = k.rhs;
    if (eq(lhs, rhs)) return lhs;
    if (lhs.node === "KVariable" && rhs.node === "KVariable" && lhs.name === rhs.name) return lhs;
    if (
      lhs.node === "KApply" &&
      rhs.node === "KApply" &&
      eqLabel(lhs.label, rhs.label) &&
      lhs.args.length === rhs.args.length
    ) {
      const newArgs = lhs.args.map((leftArg, i) => krewrite(leftArg, at(rhs.args, i)));
      return letKApply(lhs, { args: newArgs });
    }
    if (lhs.node === "KSequence" && rhs.node === "KSequence" && lhs.items.length > 0 && rhs.items.length > 0) {
      if (lhs.items.length === 1 && rhs.items.length === 1) {
        return krewrite(at(lhs.items, 0), at(rhs.items, 0));
      }
      if (eq(at(lhs.items, 0), at(rhs.items, 0))) {
        const lower = push(krewrite(ksequence(lhs.items.slice(1)), ksequence(rhs.items.slice(1))));
        return ksequence([at(lhs.items, 0), lower]);
      }
      if (eq(at(lhs.items, lhs.items.length - 1), at(rhs.items, rhs.items.length - 1))) {
        const lower = push(krewrite(ksequence(lhs.items.slice(0, -1)), ksequence(rhs.items.slice(0, -1))));
        return ksequence([lower, at(lhs.items, lhs.items.length - 1)]);
      }
    }
    if (lhs.node === "KSequence" && lhs.items.length > 0 && rhs.node === "KVariable") {
      const last = at(lhs.items, lhs.items.length - 1);
      if (last.node === "KVariable" && eq(last, rhs)) {
        return ksequence([krewrite(ksequence(lhs.items.slice(0, -1)), ksequence([])), rhs]);
      }
    }
    return k;
  };

  return topDown(push, term);
}

/**
 * Drop `<generatedTop>` and its counter, keeping the configuration
 * (`manip.py:576-586`).
 */
export function removeGeneratedCells(term: KInner): KInner {
  const rewrite = krewrite(kapply("<generatedTop>", [kvariable("CONFIG"), kvariable("_")]), kvariable("CONFIG"));
  return rewriteApply(rewrite, term);
}

//////////////////////////////
// Substitutions            //
//////////////////////////////

/**
 * Split a conjunction into the substitution it implies and what is left over
 * (`manip.py:223-256`).
 *
 * A conjunct `#Equals(X, t)` contributes `X |-> t` when `X` is an unbound
 * variable that does not occur in `t`; either orientation is accepted, and
 * `#Equals(true, X ==K t)` is looked through.  The `Subst` keys come out in
 * conjunct order.
 */
export function extractSubst(term: KInner): readonly [Subst, KInner] {
  const subst = new Map<string, KInner>();
  const remConjuncts: KInner[] = [];

  const extract = (term1: KInner, term2: KInner): readonly [string, KInner] | null => {
    if (
      term1.node === "KVariable" &&
      !subst.has(term1.name) &&
      !(term2.node === "KVariable" && subst.has(term2.name)) &&
      !freeVars(term2).has(term1.name)
    ) {
      return [term1.name, term2];
    }
    if (
      term2.node === "KVariable" &&
      !subst.has(term2.name) &&
      !(term1.node === "KVariable" && subst.has(term1.name)) &&
      !freeVars(term1).has(term2.name)
    ) {
      return [term2.name, term1];
    }
    if (
      eq(term1, TRUE) &&
      term2.node === "KApply" &&
      (term2.label.name === "_==K_" || term2.label.name === "_==Int_")
    ) {
      return extract(at(term2.args, 0), at(term2.args, 1));
    }
    if (
      eq(term2, TRUE) &&
      term1.node === "KApply" &&
      (term1.label.name === "_==K_" || term1.label.name === "_==Int_")
    ) {
      return extract(at(term1.args, 0), at(term1.args, 1));
    }
    return null;
  };

  for (const conjunct of flattenLabel("#And", term)) {
    if (conjunct.node === "KApply" && conjunct.label.name === "#Equals") {
      const found = extract(at(conjunct.args, 0), at(conjunct.args, 1));
      if (found === null) remConjuncts.push(conjunct);
      else subst.set(found[0], found[1]);
    } else {
      remConjuncts.push(conjunct);
    }
  }

  return [new Subst(subst), mlAnd(remConjuncts)];
}

/**
 * Solve away `#Equals(true, ?X ==K t)` constraints on existential variables
 * (`manip.py:614-624`).
 *
 * Only variables whose name starts with `?` are eliminated; the substitution
 * is applied to the state *and* to the constraints that survive.
 */
export function applyExistentialSubstitutions(
  state: KInner,
  constraints: Iterable<KInner>,
): readonly [KInner, readonly KInner[]] {
  const pattern = mlEqualsTrue(kapply("_==K_", [kvariable("#VAR"), kvariable("#VAL")]));
  const subst = new Map<string, KInner>();
  const newConstraints: KInner[] = [];

  for (const constraint of constraints) {
    const matched = match(pattern, constraint);
    const variable = matched?.get("#VAR");
    const value = matched?.get("#VAL");
    if (
      variable !== undefined &&
      variable.node === "KVariable" &&
      variable.name.startsWith("?") &&
      value !== undefined
    ) {
      subst.set(variable.name, value);
    } else {
      newConstraints.push(constraint);
    }
  }

  const substitution = new Subst(subst);
  return [substitution.apply(state), newConstraints.map((constraint) => substitution.apply(constraint))];
}

//////////////////////////////
// Configurations           //
//////////////////////////////

/** A variable name for a cell label — `<accountID>` becomes `ACCOUNTID_CELL` (`manip.py:307-309`). */
export function cellLabelToVarName(label: string): string {
  return `${label.replaceAll("-", "_").replaceAll("<", "").replaceAll(">", "").toUpperCase()}_CELL`;
}

/**
 * Split a constrained term into its configuration and its constraints
 * (`manip.py:291-304`).
 *
 * Throws when the conjunction holds no cell, or more than one.
 */
export function splitConfigAndConstraints(term: KInner): readonly [KInner, KInner] {
  const conjuncts = flattenLabel("#And", term);
  let config: KInner | undefined;
  const constraints: KInner[] = [];
  for (const conjunct of conjuncts) {
    if (isCell(conjunct)) {
      if (config !== undefined) {
        throw new TypeError(
          `Found two configurations in pattern:\n\n${reprKInner(config)}\n\nand\n\n${reprKInner(conjunct)}`,
        );
      }
      config = conjunct;
    } else {
      constraints.push(conjunct);
    }
  }
  if (config === undefined) throw new TypeError(`Could not find configuration for: ${reprKInner(term)}`);
  return [config, mlAnd(constraints, GENERATED_TOP_CELL)];
}

/**
 * Replace every leaf cell's contents with a fresh variable (`manip.py:312-332`).
 *
 * Returns the symbolic configuration and the substitution back to the original
 * contents, so `subst(symbolicConfig)` is the input again.  A cell counts as a
 * leaf when it has exactly one argument and that argument is not itself a cell.
 *
 * The substitution is a `Map` — pyk's is a `dict`, and both preserve the
 * top-down, left-to-right order the cells were met in.
 */
export function splitConfigFrom(configuration: KInner): readonly [KInner, Map<string, KInner>] {
  const initialSubstitution = new Map<string, KInner>();

  const replaceWithVar = (k: KInner): KInner => {
    if (isCell(k) && k.args.length === 1 && !isCell(at(k.args, 0))) {
      const configVar = cellLabelToVarName(k.label.name);
      initialSubstitution.set(configVar, at(k.args, 0));
      return kapply(k.label, [kvariable(configVar)]);
    }
    return k;
  };

  return [topDown(replaceWithVar, configuration), initialSubstitution];
}

/** Set one cell of a constrained term to a new value (`manip.py:593-597`). */
export function setCell(constrainedTerm: KInner, cellVariable: string, cellValue: KInner): KInner {
  const [state, constraint] = splitConfigAndConstraints(constrainedTerm);
  const [config, subst] = splitConfigFrom(state);
  subst.set(cellVariable, cellValue);
  return mlAnd([new Subst(subst).apply(config), constraint]);
}

//////////////////////////////
// Fresh variables          //
//////////////////////////////

/** Options for {@link abstractTermSafely} (`manip.py:600-602`). */
export interface AbstractTermSafelyOptions {
  readonly baseName?: string;
  readonly sort?: KSort | undefined;
  /** Names already taken; the hash is re-taken of the variable until it is fresh. */
  readonly existingVarNames?: ReadonlySet<string> | undefined;
}

/**
 * A fresh variable standing for `term`, named from its hash
 * (`manip.py:600-611`).
 *
 * The name is `${baseName}_${hash.slice(0, 8)}`, where the hash is sha256 of
 * the term's **Python `repr`** — see the module header.  On a collision with
 * `existingVarNames` the hash is re-taken of the *variable just built*, which
 * is how pyk walks a deterministic chain of candidates.
 */
export function abstractTermSafely(term: KInner, options: AbstractTermSafelyOptions = {}): KVariable {
  const { baseName = "V", sort, existingVarNames } = options;
  const fresh = (k: KInner): KVariable => kvariable(`${baseName}_${hashStr(k).slice(0, 8)}`, sort);

  let newVar = fresh(term);
  if (existingVarNames !== undefined) {
    while (existingVarNames.has(newVar.name)) newVar = fresh(newVar);
  }
  return newVar;
}

/** The prefixes `rename_generated_vars` acts on (`manip.py:652`). */
const GENERATED_PREFIXES: readonly string[] = ["_Gen", "?_Gen", "_DotVar", "?_DotVar"];

/**
 * Rename every backend-generated variable after the cell that holds it
 * (`manip.py:641-662`).
 *
 * `_Gen3` inside `<outerCell>` becomes `OUTERCELL_CELL_<hash>`; a generated
 * variable with no enclosing cell is left alone.  The set of names in play
 * grows as renaming proceeds, so a fresh name can never collide with one
 * already chosen.
 */
export function renameGeneratedVars(term: KInner): KInner {
  const vars = new Set<string>(freeVars(term));
  const cellStack: string[] = [];

  interface Frame {
    readonly term: KInner;
    readonly children: readonly KInner[];
    readonly done: KInner[];
    readonly cell: boolean;
  }

  const enter = (k: KInner): Frame => {
    const cell = isCell(k);
    if (cell) cellStack.push(cellLabelToVarName(k.label.name));
    return { term: k, children: terms(k), done: [], cell };
  };

  const stack: Frame[] = [enter(term)];
  for (;;) {
    const top = stack.pop();
    if (top === undefined) throw new RangeError("renameGeneratedVars: empty work stack");
    const next = top.children[top.done.length];
    if (next !== undefined) {
      stack.push(top, enter(next));
      continue;
    }
    if (top.cell) cellStack.pop();

    const rebuilt = letTerms(top.term, top.done);
    const cellName = cellStack.at(-1);
    let built = rebuilt;
    if (
      rebuilt.node === "KVariable" &&
      GENERATED_PREFIXES.some((prefix) => rebuilt.name.startsWith(prefix)) &&
      cellName !== undefined
    ) {
      const newVar = abstractTermSafely(rebuilt, {
        baseName: cellName,
        sort: rebuilt.sort,
        existingVarNames: vars,
      });
      vars.add(newVar.name);
      built = newVar;
    }

    const parent = stack.pop();
    if (parent === undefined) return built;
    parent.done.push(built);
    stack.push(parent);
  }
}

//////////////////////////////
// Minimization             //
//////////////////////////////

/**
 * Minimize the structural frames in a configuration (`manip.py:335-360`).
 *
 * A cell whose only content is `...` becomes `...` itself, a cell left with no
 * arguments becomes `...`, and any node that lost arguments to `...` gets one
 * `...` back at the end.
 */
export function collapseDots(term: KInner): KInner {
  return bottomUp((k: KInner): KInner => {
    if (k.node === "KApply") {
      if (isCell(k) && k.args.length === 1 && eq(at(k.args, 0), DOTS)) return DOTS;
      const newArgs = k.args.filter((arg) => !eq(arg, DOTS));
      if (isCell(k) && newArgs.length === 0) return DOTS;
      if (newArgs.length < k.args.length) newArgs.push(DOTS);
      return letKApply(k, { args: newArgs });
    }
    if (k.node === "KRewrite" && eq(k.lhs, DOTS)) return DOTS;
    return k;
  }, term);
}

/**
 * Replace variables that occur only once with `...` (`manip.py:439-462`).
 *
 * Only cell arguments are abstracted, and a name listed in `keepVars` counts
 * as one extra occurrence — which is exactly enough to save it.
 */
export function uselessVarsToDots(term: KInner, keepVars: Iterable<string> = []): KInner {
  const numOccs = countVars(term);
  for (const name of keepVars) numOccs.set(name, (numOccs.get(name) ?? 0) + 1);

  return bottomUp((k: KInner): KInner => {
    if (!isCell(k)) return k;
    const newArgs = k.args.map((arg) => (arg.node === "KVariable" && numOccs.get(arg.name) === 1 ? DOTS : arg));
    return letKApply(k, { args: newArgs });
  }, term);
}

/** Replace whole cells by `...` when their label is listed (`manip.py:465-481`). */
export function labelsToDots(term: KInner, labels: Iterable<string>): KInner {
  const wanted = new Set(labels);
  return bottomUp((k: KInner): KInner => (isCell(k) && wanted.has(k.label.name) ? DOTS : k), term);
}

/**
 * Keep only the named cells, abstracting the rest to `...` (`manip.py:484-495`).
 *
 * A cell is abstracted only once none of its arguments is a cell any more,
 * which — bottom up — collapses whole unwanted subtrees one layer at a time.
 */
export function extractCells(term: KInner, keepCells: Iterable<string>): KInner {
  const wanted = new Set(keepCells);
  return bottomUp((k: KInner): KInner => {
    if (
      isCell(k) &&
      !wanted.has(k.label.name) &&
      k.args.every((arg) => arg.node !== "KApply" || !isCell(arg) || eq(arg, DOTS))
    ) {
      return DOTS;
    }
    return k;
  }, term);
}

/**
 * Print cell-map collections as their cells rather than as `Map`s
 * (`inline_cell_maps`, `manip.py:401-418`).
 *
 * A `<…CellMapItem>` application whose **key** is a cell — the shape
 * `addCellMapItems` builds — collapses to its **value**, so that a
 * `<accounts>` cell prints as a list of `<account>` cells instead of as
 * `<acctID> |-> <account>` map entries.  Anything else is left alone, including
 * a `*CellMapItem` whose key is not a cell.
 *
 * Exported because three call sites outside {@link minimizeTerm} need exactly
 * this pass before printing: `kcfg`'s `KCFGShow`, `cterm`'s `CTermShow` and
 * `proof`'s `Edge.toRule._simplify_config` (`kcfg.py:228-229`), which is
 * `sortAcCollections ∘ inlineCellMaps`.
 */
export function inlineCellMaps(term: KInner): KInner {
  return bottomUp((k: KInner): KInner => {
    if (k.node === "KApply" && k.label.name.endsWith("CellMapItem") && isCell(at(k.args, 0))) {
      return at(k.args, 1);
    }
    return k;
  }, term);
}

/** `remove_semantic_casts` (`manip.py:421-436`), kept private — see the module header. */
function removeSemanticCasts(term: KInner): KInner {
  return bottomUp((k: KInner): KInner => {
    if (k.node === "KApply" && k.args.length === 1 && k.label.name.startsWith("#SemanticCast")) {
      return at(k.args, 0);
    }
    return k;
  }, term);
}

/**
 * Rewrite every attribute set reachable from an outer node (`on_attributes`,
 * `manip.py:498-511`).
 *
 * pyk is generic over `W: WithKAtt` and special-cases the two containers: a
 * `KFlatModule` also maps each of its sentences' attributes, and a
 * `KDefinition` recurses into every module of {@link KDefinition.allModules}.
 * Everything else is just `node.map_att(f)`.
 *
 * # Deviations
 *
 * - **Overloads instead of a type variable.**  pyk returns `W`; TypeScript
 *   cannot preserve that through a `switch` without an assertion, so the three
 *   inhabited cases are declared as overloads (the `moduleMapSentences`
 *   pattern).  A `KSentence` in, a `KSentence` out; a module in, a module out.
 * - **`att.ts`'s `mapAtt` is not used.**  It needs a `LetAtt` the caller
 *   supplies, and the whole point here is that the caller does not know which
 *   node it holds; {@link letSentenceAtt} already does that dispatch.
 *
 * pyk's `# TODO mypy bug` comment (`manip.py:502`) has no counterpart: the
 * overloads type-check as written.
 */
export function onAttributes(sentence: KSentence, f: (att: KAtt) => KAtt): KSentence;
export function onAttributes(module: KFlatModule, f: (att: KAtt) => KAtt): KFlatModule;
export function onAttributes(definition: KDefinition, f: (att: KAtt) => KAtt): KDefinition;
export function onAttributes(
  node: KSentence | KFlatModule | KDefinition,
  f: (att: KAtt) => KAtt,
): KSentence | KFlatModule | KDefinition;
export function onAttributes(
  node: KSentence | KFlatModule | KDefinition,
  f: (att: KAtt) => KAtt,
): KSentence | KFlatModule | KDefinition {
  if (node instanceof KDefinition) {
    // pyk maps the definition's own att first, then rebuilds `all_modules`;
    // one `let` does both, and `KDefinition.let` re-validates the main module.
    return node.let({ att: f(node.att), allModules: node.allModules.map((module) => onAttributes(module, f)) });
  }
  if (node.node === "KFlatModule") {
    return letKFlatModule(node, {
      att: f(node.att),
      sentences: node.sentences.map((sentence) => letSentenceAtt(sentence, f(sentence.att))),
    });
  }
  return letSentenceAtt(node, f(node.att));
}

/**
 * Minimize a term for pretty-printing (`manip.py:514-531`).
 *
 * Cell maps are inlined, semantic casts dropped, single-use variables replaced
 * by `...`, and the resulting `...`s collapsed.  `keepVars` protects names from
 * the third step.
 */
export function minimizeTerm(term: KInner, keepVars: Iterable<string> = []): KInner {
  let result = inlineCellMaps(term);
  result = removeSemanticCasts(result);
  result = uselessVarsToDots(result, keepVars);
  return collapseDots(result);
}

/**
 * Minimize a rule or a claim for pretty-printing (`minimize_rule_like`,
 * `manip.py:534-560`).
 *
 * This is what turns a semantic rule from "every cell of the configuration"
 * into "the cells this rule actually touches", and it is what `pyk coverage`
 * (`__main__.py:407`), `KCFGShow` (`kcfg/show.py:313`) and `KCFG.to_module`
 * (`kcfg.py:245`) print through.  Three passes, in pyk's order:
 *
 * 1. `requires` and `ensures` are flattened over `_andBool_` and rebuilt with
 *    {@link andBool}, which drops the `true` conjuncts, then run through
 *    {@link simplifyBool}.
 * 2. The names those two conditions still mention are added to `keepVars`, so
 *    a variable a side condition constrains is never abstracted away.
 * 3. The body is {@link minimizeTerm}'d against that set.
 *
 * A `KRule` in gives a `KRule` out and a `KClaim` a `KClaim` — pyk's
 * `RL: KRuleLike` type variable, spelled as overloads for the reason
 * {@link onAttributes} gives.  Attributes are carried across untouched;
 * stripping `Source`/`Location` is {@link removeSourceMap}'s job, and pyk's
 * callers do both.
 */
export function minimizeRuleLike(rule: KRule, keepVars?: Iterable<string>): KRule;
export function minimizeRuleLike(claim: KClaim, keepVars?: Iterable<string>): KClaim;
export function minimizeRuleLike(rule: KRuleLike, keepVars?: Iterable<string>): KRuleLike;
export function minimizeRuleLike(rule: KRuleLike, keepVars: Iterable<string> = []): KRuleLike {
  const requires = simplifyBool(andBool(flattenLabel("_andBool_", rule.requires)));
  const ensures = simplifyBool(andBool(flattenLabel("_andBool_", rule.ensures)));
  const constrainedVars = new Set<string>([...keepVars, ...freeVars(requires), ...freeVars(ensures)]);
  const body = minimizeTerm(rule.body, constrainedVars);
  const changes = { body, requires, ensures };
  return rule.node === "KRule" ? letKRule(rule, changes) : letKClaim(rule, changes);
}

/**
 * Drop `Source` and `Location` from every attribute set in a definition
 * (`remove_source_map`, `manip.py:563-564`).
 *
 * One line upstream and one here: {@link onAttributes} with
 * {@link KAtt.dropSource}.  Its visible effect is on pretty-printed sentences —
 * a rule printed from a `compiled.json` otherwise trails the absolute path of
 * the build machine — which is why `pyk coverage` applies it to the whole
 * definition before printing anything (`__main__.py:405`).
 */
export function removeSourceMap(definition: KDefinition): KDefinition {
  return onAttributes(definition, (att) => att.dropSource());
}

//////////////////////////////
// Constraints              //
//////////////////////////////

/** `utils.unique` for K terms: structural, first occurrence wins. */
function uniqueTerms(items: Iterable<KInner>): KInner[] {
  const buckets = new Map<string, KInner[]>();
  const result: KInner[] = [];
  for (const item of items) {
    const key = hashOf(item);
    const bucket = buckets.get(key);
    if (bucket?.some((seen) => eq(seen, item))) continue;
    if (bucket === undefined) buckets.set(key, [item]);
    else bucket.push(item);
    result.push(item);
  }
  return result;
}

/** `is_spurious_constraint` (`manip.py:665-671`). */
export function isSpuriousConstraint(term: KInner): boolean {
  if (
    term.node === "KApply" &&
    term.label.name === "#Equals" &&
    term.args.length >= 2 &&
    eq(at(term.args, 0), at(term.args, 1))
  ) {
    return true;
  }
  return isTop(term, { weak: true });
}

/**
 * Flatten `#And`, remove structural duplicates, and discard tautologies
 * (`normalize_constraints`, `manip.py:673-677`).
 */
export function normalizeConstraints(constraints: Iterable<KInner>): readonly KInner[] {
  const flattened: KInner[] = [];
  for (const constraint of constraints) flattened.push(...flattenLabel("#And", constraint));
  return uniqueTerms(flattened).filter((constraint) => !isSpuriousConstraint(constraint));
}

/**
 * pyk's `find_common_items` (`utils.py:248-261`), inlined for its one caller.
 *
 * Returns `(common, onlyIn1, onlyIn2)`.  `common` is built from `l1` and so
 * keeps `l1`'s duplicates; both remainders are filtered against `common`, not
 * against each other.
 */
function findCommonItems(l1: readonly KInner[], l2: readonly KInner[]): readonly [KInner[], KInner[], KInner[]] {
  const common: KInner[] = [];
  for (const item of l1) {
    if (containsTerm(l2, item)) common.push(item);
  }
  const newL1 = l1.filter((item) => !containsTerm(common, item));
  const newL2 = l2.filter((item) => !containsTerm(common, item));
  return [common, newL1, newL2];
}

/**
 * Lift the conjuncts common to both sides of a `#Or` out of it
 * (`manip.py:271-288`).
 *
 * The second `find_common_items` call is over `(r1, l1)` and its results are
 * bound in the order `(common2, r2, l2)` — the swap is pyk's and is transcribed
 * as it stands.
 */
export function propagateUpConstraints(term: KInner): KInner {
  return bottomUp((k: KInner): KInner => {
    if (k.node !== "KApply" || k.label.name !== "#Or") return k;
    const topSort = at(k.label.params, 0);
    const conjuncts1 = flattenLabel("#And", at(k.args, 0));
    const conjuncts2 = flattenLabel("#And", at(k.args, 1));
    const [common1, l1, r1] = findCommonItems(conjuncts1, conjuncts2);
    const [common2, r2, l2] = findCommonItems(r1, l1);
    const common = [...common1, ...common2];
    if (common.length === 0) return k;
    const disjunct = mlOr([mlAnd(l2, topSort), mlAnd(r2, topSort)], topSort);
    return mlAnd([disjunct, ...common], topSort);
  }, term);
}

/**
 * Keep only the constraints reachable from `initialVars` (`manip.py:680-703`).
 *
 * A constraint is kept when it mentions a variable already known to matter,
 * and its own variables then count as mattering — iterated to a fixpoint.
 * `usedVars` is a list here, as in pyk, because the loop's termination test is
 * on its *length* and pyk only dedupes at the end of each round.
 */
export function removeUselessConstraints(constraints: readonly KInner[], initialVars: Iterable<string>): KInner[] {
  const usedVars: string[] = [...initialVars];
  let prevLenUsedVars = 0;
  const newConstraints: KInner[] = [];

  while (usedVars.length > prevLenUsedVars) {
    prevLenUsedVars = usedVars.length;
    for (const constraint of constraints) {
      if (containsTerm(newConstraints, constraint)) continue;
      const newVars = freeVars(constraint);
      let touched = false;
      for (const name of newVars) {
        if (usedVars.includes(name)) touched = true;
      }
      if (!touched) continue;
      newConstraints.push(constraint);
      for (const name of newVars) usedVars.push(name);
    }
    // `used_vars = list(set(used_vars))` (`manip.py:702`), in place so the loop
    // test still reads the same array.
    const deduped = [...new Set(usedVars)];
    usedVars.length = 0;
    for (const name of deduped) usedVars.push(name);
  }

  return newConstraints;
}

//////////////////////////////
// Rule / claim construction //
//////////////////////////////

/** Options accepted by {@link buildRule}, mirroring `manip.py:748-755`. */
export interface BuildRuleOptions {
  readonly initConstraints?: Iterable<KInner>;
  readonly finalConstraints?: Iterable<KInner>;
  readonly priority?: number | undefined;
  readonly keepVars?: Iterable<string>;
  readonly defuncWith?: KDefinition | undefined;
  readonly keepUnsafe?: boolean;
  readonly filterUselessConstraints?: boolean;
}

/** Apply K frontend-safe variable naming conventions to a generated rule. */
export function buildRule(
  ruleId: string,
  initConfig: KInner,
  finalConfig: KInner,
  options: BuildRuleOptions = {},
): readonly [KRule, Subst] {
  const keepUnsafe = options.keepUnsafe ?? false;
  const keepVars = [...(options.keepVars ?? [])];
  let initConstraints = [...(options.initConstraints ?? [])].map((constraint) =>
    normalizeMlPred(constraint, { keepUnsafe }),
  );
  let finalConstraints = [...(options.finalConstraints ?? [])].map((constraint) =>
    normalizeMlPred(constraint, { keepUnsafe }),
  );
  finalConstraints = finalConstraints.filter((constraint) => !containsTerm(initConstraints, constraint));

  if (options.defuncWith !== undefined) {
    const [defunctionalized, newConstraints] = defunctionalize(options.defuncWith, initConfig);
    initConfig = defunctionalized;
    initConstraints = [...initConstraints, ...newConstraints];
  }

  const initTerm = mlAnd([initConfig, ...initConstraints]);
  const finalTerm = mlAnd([finalConfig, ...finalConstraints]);
  const lhsVars = freeVars(initTerm);
  const rhsVars = freeVars(finalTerm);
  const occurrences = varOccurrences(
    mlAnd(
      [pushDownRewrites(krewrite(initConfig, finalConfig)), ...initConstraints, ...finalConstraints],
      GENERATED_TOP_CELL,
    ),
  );
  const sortedVars = keepVarsSorted(occurrences);
  const substitution = new Map<string, KVariable>();
  const reverseSubstitution = new Map<string, KVariable>();
  for (const [name, variables] of occurrences) {
    let newName = name;
    if (variables.length === 1) newName = `_${newName}`;
    if (rhsVars.has(name) && !lhsVars.has(name)) newName = `?${newName}`;
    if (newName === name) continue;
    const variable = sortedVars.get(name);
    if (variable === undefined) throw new RangeError(`Variable occurrence missing its representative: ${name}`);
    const newVariable = kvariable(newName, variable.sort);
    substitution.set(name, newVariable);
    reverseSubstitution.set(newName, variable);
  }

  const vSubst = new Subst(substitution);
  const newInitConfig = vSubst.apply(initConfig);
  let newInitConstraints = initConstraints.map((constraint) => vSubst.apply(constraint));
  const [newFinalConfig, existentialConstraints] = applyExistentialSubstitutions(
    vSubst.apply(finalConfig),
    finalConstraints.map((constraint) => vSubst.apply(constraint)),
  );
  let newFinalConstraints = [...existentialConstraints];
  const ruleBody = pushDownRewrites(krewrite(newInitConfig, newFinalConfig));

  if (options.filterUselessConstraints ?? false) {
    const bodyVars = new Set([...freeVars(ruleBody), ...keepVars]);
    newInitConstraints = removeUselessConstraints(newInitConstraints, bodyVars);
    newFinalConstraints = removeUselessConstraints(newFinalConstraints, bodyVars);
  }

  const requires = simplifyBool(mlPredToBool(mlAnd(newInitConstraints), { keepUnsafe }));
  const ensures = simplifyBool(mlPredToBool(mlAnd(newFinalConstraints), { keepUnsafe }));
  const attEntries = [
    ...(options.priority === undefined ? [] : [attEntry(Atts.PRIORITY, String(options.priority))]),
    attEntry(Atts.LABEL, ruleId),
  ];
  return [krule(ruleBody, { requires, ensures, att: new KAtt(attEntries) }), new Subst(reverseSubstitution)];
}

/** Options accepted by {@link buildClaim}; `priority` and `defuncWith` are rule-only. */
export type BuildClaimOptions = Omit<BuildRuleOptions, "priority" | "defuncWith">;

/** `build_claim` (`manip.py:706-745`), with the same variable map as {@link buildRule}. */
export function buildClaim(
  claimId: string,
  initConfig: KInner,
  finalConfig: KInner,
  options: BuildClaimOptions = {},
): readonly [KClaim, Subst] {
  const [rule, variableMap] = buildRule(claimId, initConfig, finalConfig, options);
  return [kclaim(rule.body, { requires: rule.requires, ensures: rule.ensures, att: rule.att }), variableMap];
}

/**
 * Replace every `KRewrite` by an ML implication (`replace_rewrites_with_implies`,
 * `manip.py:834-840`).
 *
 * `lhs => rhs` becomes `lhs #Implies rhs`, bottom up, everywhere.  The consumer
 * is the failure report an implication check produces: a rewrite is a claim
 * about a *step*, and once the step has failed what the reader wants to see is
 * the entailment that did not hold.
 */
export function replaceRewritesWithImplies(term: KInner): KInner {
  return bottomUp((k: KInner): KInner => (k.node === "KRewrite" ? mlImplies(k.lhs, k.rhs) : k), term);
}

/**
 * Abstract away every cell a rewrite leaves alone (`no_cell_rewrite_to_dots`,
 * `manip.py:843-865`): a cell whose left- and right-hand sides are equal
 * becomes `<cell> ... </cell>`.
 *
 * Paired with {@link replaceRewritesWithImplies} in a failure report — the
 * cells that did not change are noise, so they collapse to `...` and only the
 * cells the step disagreed about are printed.
 *
 * # Deviation: upstream's implementation is the identity function
 *
 * pyk does **not** traverse the term.  It calls {@link splitConfigFrom} and
 * maps its inner function over the resulting *substitution*, whose values are —
 * by that function's own construction (`manip.py:322`, "arity 1 and the
 * argument is not itself a cell") — never cells.  Its `is_cell` guard therefore
 * never fires, and `subst(config)` rebuilds exactly the input.  `pyk` at
 * v7.1.337 has one test for it (`test_kcfg.py:838-871`) and that test asserts
 * `result == term`, so the no-op is pinned rather than caught.
 *
 * What is implemented here is the behaviour pyk's own docstring describes —
 * "when it finds a cell whose LHS is identical to its RHS, it replaces the
 * cell's contents with a predefined DOTS" (`manip.py:846-848`) — as a
 * {@link bottomUp} pass, which is also what `@kframework-ts/kcfg`'s
 * implication-failure printer already does with its private copy.  Bottom up
 * rather than top down so that a parent whose children have all collapsed to
 * `...` collapses in turn; on pyk's pinned input the two agree, because that
 * term's one cell does rewrite.
 */
export function noCellRewriteToDots(term: KInner): KInner {
  return bottomUp(
    (k: KInner): KInner => (isCell(k) && eq(extractLhs(k), extractRhs(k)) ? kapply(k.label, [DOTS]) : k),
    term,
  );
}

/**
 * Turn defined-function applications into equality side conditions
 * (`defunctionalize`, `manip.py:871-892`).
 */
export function defunctionalize(definition: KDefinition, term: KInner): readonly [KInner, readonly KInner[]] {
  const functionSymbols = definition.functions.flatMap((production) =>
    production.klabel === undefined ? [] : [production.klabel],
  );
  const constraints: KInner[] = [];
  const defunctionalizeOne = (subterm: KInner): KInner => {
    if (subterm.node !== "KApply" || !functionSymbols.some((symbol) => eqLabel(subterm.label, symbol))) return subterm;
    const sort = definition.sortOf(subterm);
    if (sort === undefined)
      throw new TypeError(`Could not determine sort while defunctionalizing: ${reprKInner(subterm)}`);
    const variable = abstractTermSafely(subterm, { baseName: "F", sort });
    constraints.push(mlEquals(variable, subterm, sort));
    return variable;
  };
  return [topDown(defunctionalizeOne, term), uniqueTerms(constraints)];
}

//////////////////////////////////////////////////////////////////////
// AC normalisation and alias folding — what `pretty.ts` reaches for //
//////////////////////////////////////////////////////////////////////

/**
 * Sort the arguments of an associative label (`manip.py:72-83`).
 *
 * `kast` is flattened over `label`, its elements are put in the KAst total
 * order ({@link compare}, pyk's `KAst.__lt__`), and the result is rebuilt
 * **right-nested** with the original application's label — parameters and all.
 * Anything that is not an application of `label` is returned untouched.
 *
 * A nullary application of `label` flattens to nothing and pyk's
 * `assert res is not None` fires; here that is a `TypeError`.
 */
export function sortAssocLabel(label: string, kast: KInner): KInner {
  if (kast.node !== "KApply" || kast.label.name !== label) return kast;
  // `sorted(...)` is stable, and so is `Array.prototype.toSorted` — equal
  // terms keep their relative order in both languages.
  const sorted = flattenLabel(label, kast).toSorted(compare);
  let res: KInner | undefined;
  for (let i = sorted.length - 1; i >= 0; i -= 1) {
    const term = at(sorted, i);
    res = res === undefined ? term : kapply(kast.label, [term, res]);
  }
  if (res === undefined) throw new TypeError(`Cannot sort an empty ${label}: ${reprKInner(kast)}`);
  return res;
}

/** The labels {@link sortAcCollections} normalises outright (`manip.py:89`). */
const AC_COLLECTION_LABELS: ReadonlySet<string> = new Set(["_Set_", "_Map_", "_RangeMap_"]);

/**
 * Put every AC collection in a term into the KAst total order
 * (`manip.py:86-94`).
 *
 * The three builtin collection labels are normalised, and so is every
 * cell-collection label — recognised, as upstream, by the `CellMap_` suffix
 * (`_AccountCellMap_`, …).  `List` is deliberately absent: a `List` is ordered.
 */
export function sortAcCollections(kast: KInner): KInner {
  return topDown((k: KInner): KInner => {
    if (k.node !== "KApply") return k;
    const name = k.label.name;
    if (!AC_COLLECTION_LABELS.has(name) && !name.endsWith("CellMap_")) return k;
    return sortAssocLabel(name, k);
  }, kast);
}

/**
 * Fold a term back into the aliases the definition declares
 * (`manip.py:627-639`).
 *
 * Every `alias` rule contributes its body *reversed* — `KRewrite(rhs, lhs)` —
 * and the whole set is run to a fixpoint by {@link indexedRewrite}, so an alias
 * whose expansion mentions another alias still folds (pyk's `hundred` /
 * `rangeHundred` pair does exactly that).  An alias rule whose body is not a
 * rewrite, or which carries a non-trivial `requires`/`ensures`, is an error.
 *
 * `indexed_rewrite` — not a plain `bottom_up` — is upstream's own choice
 * (`manip.py:638`), and it is what makes the fixpoint and the label indexing
 * part of the contract rather than an optimisation.
 */
export function undoAliases(definition: KDefinition, kast: KInner): KInner {
  const aliases: KRewrite[] = [];
  for (const rule of definition.aliasRules) {
    const rewrite = rule.body;
    if (rewrite.node !== "KRewrite") {
      throw new TypeError(`Expected KRewrite as alias body, found: ${reprKInner(rewrite)}`);
    }
    if (!eq(rule.requires, TRUE)) {
      throw new TypeError(`Expended empty requires clause on alias, found: ${reprKInner(rule.requires)}`);
    }
    if (!eq(rule.ensures, TRUE)) {
      throw new TypeError(`Expended empty ensures clause on alias, found: ${reprKInner(rule.ensures)}`);
    }
    aliases.push(krewrite(rewrite.rhs, rewrite.lhs));
  }
  return indexedRewrite(kast, aliases);
}
