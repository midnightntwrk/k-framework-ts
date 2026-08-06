/**
 * `KCFG.from_claim` (`kcfg/kcfg.py:522-541`) — the claim→graph direction.
 *
 * The opposite direction (`KCFG.Edge.to_rule`, `KCFG.to_rules`,
 * `KCFG.to_module`) is graph-level, needs no proof, and is transcribed in
 * `@kframework-ts/kcfg`'s `./rules`; `APRProof.as_rule` / `as_claim` /
 * `as_rules` (`reachability.py:445-469`) call straight into it. In particular
 * `edgeToRule` there takes any `{ source, target }` pair rather than an `Edge`,
 * which is precisely what lets `as_rule` express upstream's fabricated
 * `KCFG.Edge(init, target, depth=0, rules=())` — this package's use case is the
 * reason that widening exists, so there is nothing left to duplicate here.
 *
 * What stays is this one function: it needs a `KDefinition` and a `KClaim`,
 * which are proof inputs rather than graph data, and upstream itself only ever
 * calls it from `APRProof.from_claim` (`reachability.py:471-483`).
 */

import { CTerm } from "@kframework-ts/cterm";
import { andBool } from "@kframework-ts/kast/prelude/kbool";
import { KCFG } from "@kframework-ts/kcfg";
import {
  boolToMlPred,
  extractLhs,
  extractRhs,
  renameGeneratedVars,
  type KClaim,
  type KDefinition,
} from "@kframework-ts/kast";

/**
 * `KCFG.from_claim` (`kcfg.py:522-541`) — a two-node graph, `lhs => rhs`.
 *
 * The `ensures` clause joins `requires` on the *target* only, which is what
 * makes the target a strictly stronger state than the source.
 */
export function kcfgFromClaim(defn: KDefinition, claim: KClaim): readonly [graph: KCFG, init: number, target: number] {
  const graph = new KCFG();
  const claimBody = renameGeneratedVars(defn.instantiateCellVars(claim.body));

  const claimLhs = CTerm.fromKast(extractLhs(claimBody)).addConstraint(boolToMlPred(claim.requires));
  const initNode = graph.createNode(claimLhs);

  const claimRhs = CTerm.fromKast(extractRhs(claimBody)).addConstraint(
    boolToMlPred(andBool([claim.requires, claim.ensures])),
  );
  const targetNode = graph.createNode(claimRhs);

  return [graph, initNode.id, targetNode.id];
}
