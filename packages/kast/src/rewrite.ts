/**
 * `indexed_rewrite` — a hand-transcription of `pyk/kast/rewrite.py` (57 L) at
 * K **v7.1.337**.
 *
 * # What it is
 *
 * A fixpoint rewriter over a *set* of {@link KRewrite}s, indexed by the shape
 * of each rewrite's left-hand side so a term node only ever tries the rewrites
 * that could possibly match it: a `KToken` node tries the token rewrites, a
 * `KApply` node tries only the rewrites whose LHS is an application of the
 * *same label name*, and everything else tries the rest.
 *
 * # Why it is here
 *
 * `indexed_rewrite` is out of scope as a public entry point, on the
 * evidence that no downstream repo imports it.  That remains true of
 * *downstream* use, but it is not optional inside the package:
 * `KDefinition.init_config` (`outer.py:1667`) is built on it, so the outer
 * layer needs it and it is exported rather than hidden — it is public API
 * upstream and there is no reason to make it less so here.
 *
 * # Fidelity notes
 *
 * - The fixpoint is pyk's, exactly: keep applying bottom-up passes until a
 *   pass changes nothing.  Each pass applies *every* candidate rewrite at
 *   every node, in the order the rewrites were given, threading the result of
 *   one into the next (`rewrite.py:39,43,46`).
 * - `KRewrite.apply_top` — not `apply` — is what runs at each node
 *   ({@link rewriteApplyTop}): the traversal supplies the descent, so a
 *   rewrite only ever tries to match the node it was handed.
 * - Termination is the caller's problem, here as upstream: a rewrite set with
 *   a cycle loops forever.
 */

import { eq } from "./eq.js";
import { bottomUp, rewriteApplyTop, type KInner, type KRewrite } from "./inner.js";

/**
 * `indexed_rewrite` (`rewrite.py:21-57`).
 *
 * @param kast the term to rewrite
 * @param rewrites the rewrite set, applied in iteration order within a node
 * @returns the fixpoint of repeated bottom-up application
 */
export function indexedRewrite(kast: KInner, rewrites: Iterable<KRewrite>): KInner {
  // `rewrite.py:22-34`: index once, by the node kind of each LHS.
  const tokenRewrites: KRewrite[] = [];
  const applyRewrites = new Map<string, KRewrite[]>();
  const otherRewrites: KRewrite[] = [];

  for (const r of rewrites) {
    if (r.lhs.node === "KToken") {
      tokenRewrites.push(r);
    } else if (r.lhs.node === "KApply") {
      const name = r.lhs.label.name;
      const bucket = applyRewrites.get(name);
      if (bucket === undefined) applyRewrites.set(name, [r]);
      else bucket.push(r);
    } else {
      otherRewrites.push(r);
    }
  }

  /** `_apply_rewrites` (`rewrite.py:36-47`). */
  const applyAt = (term: KInner): KInner => {
    let result = term;
    if (term.node === "KToken") {
      for (const tr of tokenRewrites) result = rewriteApplyTop(tr, result);
    } else if (term.node === "KApply") {
      const bucket = applyRewrites.get(term.label.name);
      if (bucket !== undefined) {
        for (const ar of bucket) result = rewriteApplyTop(ar, result);
      }
    } else {
      for (const or of otherRewrites) result = rewriteApplyTop(or, result);
    }
    return result;
  };

  // `rewrite.py:49-57`.  pyk seeds `new_kast` with `None` so the first loop
  // test always passes; `null` plays the same role, and the loop body always
  // runs at least once, which is why the return cannot be null.
  let origKast: KInner = kast;
  let newKast: KInner | null = null;
  while (newKast === null || !eq(origKast, newKast)) {
    if (newKast === null) newKast = origKast;
    else origKast = newKast;
    newKast = bottomUp(applyAt, newKast);
  }
  return newKast;
}
