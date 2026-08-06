/**
 * The fixture vocabulary `tests/unit/test_proof.py` imports.
 *
 * `node`/`node_dicts`/`term`/`x_config`/`x_subst`/`edge_dicts` come from
 * `tests/unit/test_kcfg.py`; `minimization_test_kcfg` (with its
 * `propagate_split_constraints` step folded in) from
 * `tests/unit/kcfg/test_minimize.py`; `apr_proof`/`equality_proof` from
 * `tests/unit/test_proof.py` itself. They are replicated here rather than
 * imported from `@kframework-ts/kcfg`'s tests, which keeps this package's
 * suite independent of a sibling's test layout — the same choice the kcfg
 * package's own test files make between themselves.
 */

import { CSubst, CTerm } from "@kframework-ts/cterm";
import { kapply, kvariable, Subst, type KInner } from "@kframework-ts/kast";
import { geInt, intToken, ltInt } from "@kframework-ts/kast/prelude/kint";
import { mlEqualsTrue } from "@kframework-ts/kast/prelude/ml";
import { token } from "@kframework-ts/kast/prelude/utils";
import { KCFG, KCFGNode } from "@kframework-ts/kcfg";

import { APRProof, EqualityProof } from "../src/index.ts";
import { BOOL } from "@kframework-ts/kast/prelude/kbool";

/** `term` (`test_kcfg.py:64-71`) — over 10 is a variable. */
export function term(i: number, config?: KInner): CTerm {
  if (config !== undefined) return new CTerm(config);
  return new CTerm(kapply("<top>", [i > 10 ? kvariable(`V${i}`) : token(i)]));
}

/** `node` (`test_kcfg.py:73-74`). */
export function node(i: number, config?: KInner): KCFGNode {
  return new KCFGNode(i, term(i, config));
}

/** `node_dicts` (`test_kcfg.py:106-107`). */
export function nodeDicts(n: number, start = 1, config?: KInner): readonly unknown[] {
  return Array.from({ length: n }, (_, offset) => node(start + offset, config).toDict());
}

/** `x_config` (`test_kcfg.py:50-51`). */
export function xConfig(): KInner {
  return kapply("<top>", [kvariable("X")]);
}

/** `x_subst` (`test_kcfg.py:54-55`). */
export function xSubst(): CSubst {
  return new CSubst(new Subst({ X: kvariable("X") }));
}

/** `edge_dicts` (`test_kcfg.py:110-114`). */
export function edgeDicts(
  ...edges: readonly (readonly [number, number, number, readonly string[]])[]
): readonly unknown[] {
  return edges.map(([source, target, depth, rules]) => ({ source, target, depth, rules: [...rules] }));
}

/** Append one constraint to each named node, as `propagate_split_constraints` does. */
function constrain(graph: KCFG, ids: readonly number[], constraint: KInner): void {
  for (const id of ids) {
    const existing = graph.node(id);
    graph.replaceNode(new KCFGNode(id, existing.cterm.addConstraint(constraint), existing.attrs));
  }
}

/**
 * `minimization_test_kcfg` (`kcfg/test_minimize.py:46-75`).
 *
 * ```text
 *                                               25   /-- X >=Int 5 --> 10
 *     5    10    15    20   /-- X >=Int 0 --> 6 --> 8
 *  1 --> 2 --> 3 --> 4 --> 5                         \-- X  <Int 5 --> 11
 *                           \                    30    35     40
 *                            \-- X  <Int 0 --> 7 --> 9 --> 12 --> 13
 * ```
 *
 * Upstream builds the splits from `split_dicts(..., csubst=x_subst())` and only
 * then runs `propagate_split_constraints`, which leaves the graph momentarily
 * inconsistent: a split's `csubst` carries a constraint its target does not.
 * `@kframework-ts/kcfg` validates that correspondence when the split is
 * inserted, so the propagation is done first here and the splits are derived
 * with `createSplitByNodes`. The resulting graph — nodes, constraints,
 * substitutions, and all — is the same one.
 */
export function minimizationTestKcfg(): KCFG {
  const x = kvariable("X");
  const xGe0 = mlEqualsTrue(geInt(x, intToken(0)));
  const xLt0 = mlEqualsTrue(ltInt(x, intToken(0)));
  const xGe5 = mlEqualsTrue(geInt(x, intToken(5)));
  const xLt5 = mlEqualsTrue(ltInt(x, intToken(5)));

  const graph = KCFG.fromDict({
    next: 14,
    nodes: nodeDicts(13, 1, xConfig()),
    edges: edgeDicts(
      [1, 2, 5, ["r1"]],
      [2, 3, 10, ["r2"]],
      [3, 4, 15, ["r3"]],
      [4, 5, 20, ["r4"]],
      [6, 8, 25, ["r5"]],
      [7, 9, 30, ["r6"]],
      [9, 12, 35, ["r7"]],
      [12, 13, 40, ["r8"]],
    ),
  });
  // The order matches `propagate_split_constraints`' iteration: the split at 5
  // first, over each target's whole reachable subtree, then the split at 8.
  constrain(graph, [6, 8, 10, 11], xGe0);
  constrain(graph, [7, 9, 12, 13], xLt0);
  constrain(graph, [10], xGe5);
  constrain(graph, [11], xLt5);
  graph.createSplitByNodes(5, [6, 7]);
  graph.createSplitByNodes(8, [10, 11]);
  return graph;
}

/** `apr_proof` (`test_proof.py:31-41`). */
export function aprProof(i: number, proofDir: string, bmcDepth?: number): APRProof {
  return new APRProof(`apr_proof_${i}`, KCFG.fromDict({ nodes: nodeDicts(i) }), [], node(1).id, node(1).id, new Map(), {
    proofDir,
    ...(bmcDepth === undefined ? {} : { bmcDepth }),
  });
}

/** `equality_proof` (`test_proof.py:44-47`). */
export function equalityProof(i: number, proofDir: string): EqualityProof {
  return new EqualityProof(`equality_proof_${i}`, intToken(i), intToken(i), BOOL, { proofDir });
}
