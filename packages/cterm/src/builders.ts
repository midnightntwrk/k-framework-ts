/** Thin CTerm wrappers around the generic KAST rule and claim builders. */

import { buildClaim, buildRule, type KClaim, type KDefinition, type KRule, type Subst } from "@kframework-ts/kast";

import { CTerm } from "./cterm.js";

/** Options for {@link ctermBuildClaim}; names follow the pyk keyword arguments. */
export interface CTermBuildClaimOptions {
  readonly keepVars?: Iterable<string>;
  readonly keepUnsafe?: boolean;
  readonly filterUselessConstraints?: boolean;
}

/** Options for {@link ctermBuildRule}; names follow the pyk keyword arguments. */
export interface CTermBuildRuleOptions extends CTermBuildClaimOptions {
  readonly priority?: number;
  readonly defuncWith?: KDefinition;
}

/**
 * Make a frontend-parseable K claim from an initial and final constrained
 * term.  Initial constraints become `requires`; final constraints become
 * `ensures` after shared constraints are removed by `buildClaim`.
 */
export function ctermBuildClaim(
  claimId: string,
  initCterm: CTerm,
  finalCterm: CTerm,
  options: CTermBuildClaimOptions = {},
): readonly [claim: KClaim, varMap: Subst] {
  return buildClaim(claimId, initCterm.config, finalCterm.config, {
    initConstraints: initCterm.constraints,
    finalConstraints: finalCterm.constraints,
    ...(options.keepVars === undefined ? {} : { keepVars: options.keepVars }),
    ...(options.keepUnsafe === undefined ? {} : { keepUnsafe: options.keepUnsafe }),
    ...(options.filterUselessConstraints === undefined
      ? {}
      : { filterUselessConstraints: options.filterUselessConstraints }),
  });
}

/**
 * Make a frontend-parseable K rule from an initial and final constrained
 * term.  This delegates variable convention handling and optional
 * defunctionalization to the generic KAST implementation.
 */
export function ctermBuildRule(
  ruleId: string,
  initCterm: CTerm,
  finalCterm: CTerm,
  options: CTermBuildRuleOptions = {},
): readonly [rule: KRule, varMap: Subst] {
  return buildRule(ruleId, initCterm.config, finalCterm.config, {
    initConstraints: initCterm.constraints,
    finalConstraints: finalCterm.constraints,
    ...(options.priority === undefined ? {} : { priority: options.priority }),
    ...(options.keepVars === undefined ? {} : { keepVars: options.keepVars }),
    ...(options.defuncWith === undefined ? {} : { defuncWith: options.defuncWith }),
    ...(options.keepUnsafe === undefined ? {} : { keepUnsafe: options.keepUnsafe }),
    ...(options.filterUselessConstraints === undefined
      ? {}
      : { filterUselessConstraints: options.filterUselessConstraints }),
  });
}
