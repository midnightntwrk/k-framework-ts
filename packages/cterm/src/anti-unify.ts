/**
 * Constrained-term anti-unification, transcribed from
 * `pyk/cterm/cterm.py` (K 7.1.337).
 *
 * The bare-term operation intentionally knows nothing about constraints: it
 * turns the pushed-down rewrite between two terms into deterministic fresh
 * variables, then obtains the two witnesses by syntactic matching.  The
 * CTerm operation below adds the common/reachable constraints afterwards.
 */

import {
  Subst,
  abstractTermSafely,
  bottomUp,
  eq,
  krewrite,
  match,
  mlPredToBool,
  pushDownRewrites,
  removeUselessConstraints,
  type KDefinition,
  type KInner,
} from "@kframework-ts/kast";
import { andBool, orBool, TRUE } from "@kframework-ts/kast/prelude/kbool";
import { mlEqualsTrue } from "@kframework-ts/kast/prelude/ml";

import { CSubst } from "./csubst.js";
import { CTerm } from "./cterm.js";

/** The generalized term followed by substitutions recovering the two inputs. */
export type AntiUnifyResult = readonly [term: KInner, first: Subst, second: Subst];

/** The generalized constrained term followed by witnesses recovering the inputs. */
export type CTermAntiUnifyResult = readonly [cterm: CTerm, first: CSubst, second: CSubst];

/** Options shared by the term and CTerm variants. */
export interface AntiUnifyOptions {
  /**
   * Retain a Boolean disjunction recording the discarded input substitutions
   * and their non-common constraints.  Default false matches pyk.
   */
  readonly keepValues?: boolean;
  /** Definition for recovering the sort of each freshly abstracted rewrite. */
  readonly kdef?: KDefinition;
}

/** Structurally test membership; JavaScript object identity is not KAST equality. */
function contains(terms: readonly KInner[], term: KInner): boolean {
  return terms.some((candidate) => eq(candidate, term));
}

/**
 * Generalize two bare K terms.
 *
 * The resulting substitutions are a checked part of the contract:
 * `first.apply(term) === state1` and `second.apply(term) === state2` under
 * structural KAST equality.  A failure therefore indicates an internal
 * invariant violation rather than a normal "no match" outcome.
 */
export function antiUnify(
  state1: KInner,
  state2: KInner,
  options: Pick<AntiUnifyOptions, "kdef"> = {},
): AntiUnifyResult {
  const minimizedRewrite = pushDownRewrites(krewrite(state1, state2));
  const abstractedState = bottomUp((term) => {
    if (term.node !== "KRewrite") return term;
    return abstractTermSafely(term, { sort: options.kdef?.sortOf(term) });
  }, minimizedRewrite);

  const first = match(abstractedState, state1);
  const second = match(abstractedState, state2);
  if (first === null || second === null) {
    throw new TypeError("Anti-unification failed to produce a more general state");
  }
  return [abstractedState, first, second];
}

/**
 * Generalize two constrained terms and produce constrained substitutions back
 * to each input (`CTerm.anti_unify` upstream).
 */
export function ctermAntiUnify(first: CTerm, second: CTerm, options: AntiUnifyOptions = {}): CTermAntiUnifyResult {
  const [config, firstSubst, secondSubst] = antiUnify(first.config, second.config, options);
  const commonConstraints = first.constraints.filter((constraint) => contains(second.constraints, constraint));

  let generalized = new CTerm(config);
  if (options.keepValues ?? false) {
    const firstOnly = first.constraints
      .filter((constraint) => !contains(second.constraints, constraint))
      .map((constraint) => mlPredToBool(constraint));
    const secondOnly = second.constraints
      .filter((constraint) => !contains(first.constraints, constraint))
      .map((constraint) => mlPredToBool(constraint));
    const lhs = andBool([firstSubst.pred, ...firstOnly]);
    const rhs = andBool([secondSubst.pred, ...secondOnly]);
    if (!eq(lhs, TRUE) && !eq(rhs, TRUE)) generalized = generalized.addConstraint(mlEqualsTrue(orBool([lhs, rhs])));
  }

  for (const constraint of removeUselessConstraints(commonConstraints, generalized.freeVars)) {
    generalized = generalized.addConstraint(constraint);
  }

  const firstCSubst = generalized.matchWithConstraint(first);
  const secondCSubst = generalized.matchWithConstraint(second);
  if (firstCSubst === null || secondCSubst === null) {
    throw new TypeError("Anti-unification failed to produce a more general constrained state");
  }
  return [generalized, firstCSubst, secondCSubst];
}

/**
 * Generalize one or more constrained terms, retaining the input order of the
 * witnesses.  The left fold is deliberately pyk-compatible; it is not an
 * attempt to minimize the number of generated variables globally.
 */
export function ctermsAntiUnify(
  cterms: Iterable<CTerm>,
  options: AntiUnifyOptions = {},
): readonly [cterm: CTerm, substitutions: readonly CSubst[]] {
  const inputs = [...cterms];
  const initial = inputs[0];
  if (initial === undefined) throw new TypeError("Anti-unification failed, no CTerms provided");

  let generalized = initial;
  for (const cterm of inputs.slice(1)) generalized = ctermAntiUnify(generalized, cterm, options)[0];

  const substitutions = inputs.map((cterm) => {
    const csubst = generalized.matchWithConstraint(cterm);
    if (csubst === null) throw new TypeError("Anti-unification failed to produce a more general constrained state");
    return csubst;
  });
  return [generalized, substitutions];
}
