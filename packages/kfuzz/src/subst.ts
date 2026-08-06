/**
 * The substitution half of fuzzing: what a generated case *is*, and how it is
 * pushed into the template.
 *
 * The substitution itself is **not implemented here**.  `fuzz`'s default
 * `subst_func` is pyk's `substitute_vars` (`kore/manip.py:60-74`, cited at
 * `ktool/kfuzz.py:146`), and `@kframework-ts/kore` transcribes that module — so
 * this one re-exports `substituteVars` rather than carrying a second copy of it,
 * and `kore`'s manifest is what pins `manip.py`.
 *
 * # Variables are identified by name and sort
 *
 * `substituteVariables` accepts `Iterable<readonly [EVar, Pattern]>` and keys
 * each binding by the whole `EVar`, including its **sort**. A fuzzing template
 * can therefore bind `X : SortInt` and `X : SortBool` independently.
 * `subst_strategy`
 * is keyed by `EVar` upstream, users write `EVar('VarX', SortApp('SortInt'))`
 * constants at module scope, and a configuration that mentions one name at two
 * sorts is ordinary — `kompile` reuses `X0`, `VarX` and friends freely across
 * sorts.
 *
 * A `Map<EVar, Pattern>` is such an iterable, so {@link KoreSubst} passes
 * straight in.
 *
 * # Identity keys and value keys, and why {@link KoreSubst} is a `Map`
 *
 * pyk hands `handle_test`, `handle_failure` and `subst_func` a
 * `Mapping[EVar, Pattern]` — a dict keyed by the `EVar` objects the caller
 * declared.  JavaScript's `Map` keys by reference, and a caller's `VAR_X`
 * constant *is* one reference, so `subst.get(VAR_X)` works and iteration order
 * is declaration order, which is what pyk gives too.
 *
 * The template's variable nodes are a different matter: they come out of a
 * parser, so they are structurally equal to `VAR_X` and referentially distinct
 * from it.  `substituteVars` therefore re-keys the map structurally before it
 * walks, discarding the useless identity keying.  Two keying schemes for two
 * jobs, and neither is the wrong one for its job.
 */

import type { EVar, Pattern } from "@kframework-ts/kore";

/**
 * pyk's `substitute_vars` — a bottom-up replacement keyed by variable name
 * **and** sort, re-exported from `@kframework-ts/kore`.
 *
 * Re-exported rather than merely used, because a caller writing a custom
 * {@link SubstFunction} needs it (that is what upstream's `subst_on_k_cell`
 * does with the K cell, `test_fuzz.py:41-61`) and should not have to know which
 * package it lives in.  `variableKey` comes with it for the same reason: a
 * handler that indexes cases by variable needs the same key this does.
 *
 * Note it is pyk's *simple* substitution: it does not alpha-rename below
 * binders.  A kompiled configuration contains no quantifiers, which is why
 * upstream can afford that and why the limitation is documented rather than
 * fixed.
 */
export { substituteVars, variableKey } from "@kframework-ts/kore";

/**
 * One generated test case: every declared variable bound to a concrete
 * pattern.
 *
 * Keyed by the caller's own `EVar` objects, in declaration order — see the
 * module header.  This is pyk's `Mapping[EVar, Pattern]`.
 */
export type KoreSubst = ReadonlyMap<EVar, Pattern>;

/**
 * How a case is pushed into the template — pyk's `subst_func`
 * (`kfuzz.py:146,163-164`).
 *
 * The default is `substituteVars`.  Supplying another is upstream's documented
 * optimisation: `test_fuzz.py:41-61` substitutes only inside the `<k>` cell, so
 * the bottom-up walk never descends the rest of a large configuration.
 */
export type SubstFunction = (template: Pattern, subst: KoreSubst) => Pattern;
