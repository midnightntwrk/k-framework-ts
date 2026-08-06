/**
 * A KCFG as K sentences — `KCFG.Edge.to_rule`, `KCFG.to_rules` and
 * `KCFG.to_module` (`kcfg/kcfg.py:218-246`, `288-289`, `713-735`) at K
 * **v7.1.337**.
 *
 * This is the summary→lemma direction: an explored (and usually minimized)
 * graph becomes a `KFlatModule` of `<label>-<src>-TO-<tgt>` rules that the K
 * frontend can re-parse, so a proved basic block can be *assumed* by the next
 * proof.  It is browser-safe — no filesystem, no printer, no definition
 * required — and therefore lives on the main entry point beside the graph
 * itself, with the `./show` subpath re-exporting it for
 * {@link KCFGShow.toModule}'s benefit.
 *
 * # Which successors become rules
 *
 * Only `Edge` and `MergedEdge` (`kcfg.py:720-722`).  A `Cover` is subsumption
 * pointing backwards, a `Split` is case analysis on one state rather than a
 * transition, and an `NDBranch` has several targets and so no single rewrite:
 * upstream emits nothing for any of the three, and neither does this.  A graph
 * whose only successors are splits therefore yields an empty module, which is
 * the honest answer rather than an error.
 *
 * # Five deviations from upstream
 *
 * 1. **Free functions, not methods.**  pyk hangs `to_rule` off `KCFG.Edge` and
 *    `to_rules`/`to_module` off `KCFG`.  This package models successors as
 *    immutable data values (see `successor.ts`), so rule construction — a
 *    `cterm`/`kast` concern — is expressed as functions over those values.
 * 2. **{@link edgeToRule} takes any `{ source, target }` pair.**  Upstream's
 *    receiver is an `Edge`, but `to_rule` reads only the two nodes' `CTerm`s:
 *    `depth` and `rules` are never touched.  Widening to pyk's `EdgeLike`
 *    shape is behaviour-preserving and is what makes
 *    `APRProof.as_rule`/`as_claim` (`proof/reachability.py:459-468`)
 *    expressible — those fabricate `KCFG.Edge(init, target, depth=0, rules=())`
 *    and this package's `edge()` rejects a non-positive depth
 *    (`successor.ts:8-11`).  It also subsumes `MergedEdge.to_rule`
 *    (`kcfg.py:288-289`), which upstream implements by rebuilding a throwaway
 *    depth-1 `Edge` for exactly the same reason.
 * 3. **`claim` is a second function.**  `Edge.to_rule(claim=True)` returns
 *    `KRuleLike`; a caller in TypeScript would then have to narrow a union that
 *    is statically known at the call site.  {@link edgeToClaim} is that branch,
 *    and it deliberately has neither `priority` nor `defuncWith` because
 *    `cterm_build_claim` accepts neither (`kcfg.py:241-242`).
 * 4. **`inline_cell_maps` and `minimize_rule_like` are re-exported, not
 *    re-derived.**  Both live in `@kframework-ts/kast`'s `manip` — the
 *    layering-correct home, since both are `kast/manip.py` functions — and this
 *    module and `./show` are two of their callers.  They stay visible from
 *    `@kframework-ts/kcfg` because {@link edgeToRule}'s `minimize` option and
 *    `KCFGShow.toModule`'s `parseableOutput` are what a consumer of *this*
 *    package reaches them through; the names are a pass-through, so there is
 *    exactly one implementation.
 * 5. **`kcfgToRules` returns a frozen array**, as every other collection this
 *    package hands out does.
 *
 * The upstream defaults are kept verbatim: sentence-label prefix
 * `BASIC-BLOCK`, rule priority `20`, module name `KCFG`.  `defuncWith` reaches
 * ordinary edges but **not** merged edges, because `MergedEdge.to_rule`
 * forwards only label, claim flag and priority (`kcfg.py:721`).
 */

import { CTerm, ctermBuildClaim, ctermBuildRule } from "@kframework-ts/cterm";
import {
  inlineCellMaps,
  kflatmodule,
  minimizeRuleLike,
  sortAcCollections,
  type KAtt,
  type KClaim,
  type KDefinition,
  type KFlatModule,
  type KImport,
  type KInner,
  type KRule,
} from "@kframework-ts/kast";

import type { KCFG } from "./kcfg.js";
import type { KCFGNode } from "./node.js";

//////////////////////////////
// kast helpers, forwarded  //
//////////////////////////////

/**
 * `inline_cell_maps` (`kast/manip.py:401-418`) and `minimize_rule_like`
 * (`kast/manip.py:534-560`), forwarded from `@kframework-ts/kast`.
 *
 * They are `kast/manip.py` functions and live there; they are visible from
 * here because {@link edgeToRule}'s `minimize` and `KCFGShow.toModule`'s
 * `parseableOutput` are the reasons a consumer of *this* package needs them,
 * and a caller should not have to reach for a second package to reproduce what
 * those options did.  No implementation is duplicated — see deviation 4 in the
 * module header.
 */
export { inlineCellMaps, minimizeRuleLike };

/** `Edge.to_rule._simplify_config` (`kcfg.py:228-229`). */
export function simplifyConfig(config: KInner): KInner {
  return sortAcCollections(inlineCellMaps(config));
}

//////////////////////////////
// Edge -> sentence         //
//////////////////////////////

/**
 * The part of a successor {@link edgeToRule} reads: pyk's `EdgeLike`
 * (`kcfg.py:190-196`) minus the target tuple.
 *
 * `Edge`, `MergedEdge` and `Cover` all satisfy it structurally, as does an
 * ad-hoc `{ source, target }` pair standing in for a `KCFG.Edge` upstream
 * fabricates.
 */
export interface EdgeLike {
  readonly source: KCFGNode;
  readonly target: KCFGNode;
}

/** {@link edgeToRule}'s keyword arguments (`kcfg.py:218-224`). */
export interface EdgeToRuleOptions {
  /** `priority`; left unset, `cterm_build_rule` emits no priority attribute. */
  readonly priority?: number | undefined;
  /** `defunc_with`: defunctionalize function applications against this definition. */
  readonly defuncWith?: KDefinition | undefined;
  /** `minimize` (default `false`): run {@link minimizeRuleLike} over the result. */
  readonly minimize?: boolean | undefined;
}

/** `is_ceil_condition` (`kcfg.py:226-227`). */
function isCeilCondition(kast: KInner): boolean {
  return kast.node === "KApply" && kast.label.name === "#Ceil";
}

/** `Edge.to_rule`'s per-end preparation (`kcfg.py:231-235`). */
function sentenceCterm(node: KCFGNode): CTerm {
  return new CTerm(
    simplifyConfig(node.cterm.config),
    node.cterm.constraints.filter((constraint) => !isCeilCondition(constraint)),
  );
}

/** `<label>-<source>-TO-<target>` (`kcfg.py:230`). */
export function sentenceId(edge: EdgeLike, label: string): string {
  return `${label}-${edge.source.id}-TO-${edge.target.id}`;
}

/**
 * `KCFG.Edge.to_rule` (`kcfg.py:218-246`) in its rule form.
 *
 * `#Ceil` side conditions are dropped from both ends — they are definedness
 * bookkeeping the frontend should not have to re-parse — and each
 * configuration is inlined-and-sorted first.  Source constraints become
 * `requires`, target constraints `ensures`, both by way of `ctermBuildRule`.
 */
export function edgeToRule(edge: EdgeLike, label: string, options: EdgeToRuleOptions = {}): KRule {
  const [rule] = ctermBuildRule(sentenceId(edge, label), sentenceCterm(edge.source), sentenceCterm(edge.target), {
    ...(options.priority === undefined ? {} : { priority: options.priority }),
    ...(options.defuncWith === undefined ? {} : { defuncWith: options.defuncWith }),
  });
  return options.minimize === true ? minimizeRuleLike(rule) : rule;
}

/**
 * `KCFG.Edge.to_rule(claim=True)` (`kcfg.py:218-246`) in its claim form.
 *
 * The same two constrained terms, through `cterm_build_claim` — which takes
 * neither a priority nor a definition to defunctionalize against, so neither
 * appears here.
 */
export function edgeToClaim(edge: EdgeLike, label: string, options: { readonly minimize?: boolean } = {}): KClaim {
  const [claim] = ctermBuildClaim(sentenceId(edge, label), sentenceCterm(edge.source), sentenceCterm(edge.target));
  return options.minimize === true ? minimizeRuleLike(claim) : claim;
}

//////////////////////////////
// KCFG -> module           //
//////////////////////////////

/** {@link kcfgToRules}' keyword arguments (`kcfg.py:713-718`). */
export interface KCFGToRulesOptions {
  /** `_id`, the sentence-label prefix; defaults to `BASIC-BLOCK`. */
  readonly id?: string | undefined;
  /** `priority`, defaulting to upstream's `20`. */
  readonly priority?: number | undefined;
  /** `defunc_with`; reaches ordinary edges only (`kcfg.py:720-722`). */
  readonly defuncWith?: KDefinition | undefined;
}

/** {@link kcfgToModule}'s keyword arguments (`kcfg.py:724-731`). */
export interface KCFGToModuleArguments extends KCFGToRulesOptions {
  /** `module_name`; defaults to `KCFG`. */
  readonly moduleName?: string | undefined;
  readonly imports?: Iterable<KImport> | undefined;
  /** `att`; defaults to the empty attribute set. */
  readonly att?: KAtt | undefined;
}

/**
 * `KCFG.to_rules` (`kcfg.py:713-722`): one rule per edge, then one per merged
 * edge, in that order.
 *
 * A merged edge collapses to a single sentence between its endpoints; the
 * member edges it was built from contribute nothing of their own, matching
 * `MergedEdge.to_rule`'s throwaway depth-1 `Edge` (`kcfg.py:288-289`).  Note
 * that `defuncWith` deliberately does not reach them, because upstream's
 * forwarding call omits it.
 *
 * Upstream's return type is `list[KRuleLike]` only because `to_rule` is typed
 * for both branches; `claim` is never passed here, and `APRProof.as_rules`
 * re-asserts every element is a `KRule` (`reachability.py:453-457`).  This
 * returns `KRule[]` and spares the caller the narrowing.
 */
export function kcfgToRules(cfg: KCFG, options: KCFGToRulesOptions = {}): readonly KRule[] {
  const label = options.id ?? "BASIC-BLOCK";
  const priority = options.priority ?? 20;
  const defunc = options.defuncWith === undefined ? {} : { defuncWith: options.defuncWith };
  return Object.freeze([
    ...cfg.edges().map((edge) => edgeToRule(edge, label, { priority, ...defunc })),
    ...cfg.mergedEdges().map((merged) => edgeToRule(merged, label, { priority })),
  ]);
}

/**
 * `KCFG.to_module` (`kcfg.py:724-735`): {@link kcfgToRules} as a flat module.
 *
 * The result is unrendered — no cells are hidden and nothing is minimized.
 * `KCFGShow.toModule` in the `./show` subpath is the presentation-side wrapper
 * that adds `omitCells` and `parseableOutput` (`show.py:299-317`).
 */
export function kcfgToModule(cfg: KCFG, options: KCFGToModuleArguments = {}): KFlatModule {
  return kflatmodule(options.moduleName ?? "KCFG", {
    sentences: kcfgToRules(cfg, options),
    imports: [...(options.imports ?? [])],
    ...(options.att === undefined ? {} : { att: options.att }),
  });
}
