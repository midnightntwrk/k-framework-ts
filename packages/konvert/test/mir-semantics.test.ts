/**
 * Corpus #7 — the mir-semantics soak.
 *
 * `fixtures/upstream/mir-semantics-295.json` is 377 KB of KORE-JSON vendored
 * byte-for-byte from `k/pyk/src/tests/profiling/test-data/kore-to-kast/`, where
 * upstream drives it through `_kore_to_kast` and *times* the result
 * (`profile_kore_to_kast.py:15-22`).  It carries no expected side: deriving one
 * would need the mir-semantics definition, which is a separate repository.
 *
 * So this is a soak test, and the thing being soaked is real: a whole
 * kore-rpc-sized configuration from a production semantics, nested far deeper
 * than anything else in this suite.  It answers three questions no table can:
 *
 * 1. Does the conversion survive a term this deep? — the whole reason both
 *    folds are explicit stack machines rather than recursive ones.
 * 2. Does it survive it *without a definition*? — the pure tier's claim.
 * 3. Are there pattern shapes in the wild that the tables do not reach?
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { collect, type KInner } from "@kframework-ts/kast";
import { patternFromJson } from "@kframework-ts/kore";

import { koreToKastPure } from "../src/pure.ts";

const FIXTURE = join(import.meta.dir, "..", "fixtures", "upstream", "mir-semantics-295.json");

/**
 * The file is a **bare** KORE-JSON pattern, not the `{format, version, term}`
 * envelope — `Pattern.from_dict(json_data)` upstream, so `patternFromJson` here
 * rather than `decodeKoreJson`.
 */
const PATTERN = patternFromJson(JSON.parse(readFileSync(FIXTURE, "utf8")));

describe("mir-semantics-295", () => {
  const kast = koreToKastPure(PATTERN);

  test("converts without a definition and without throwing", () => {
    expect(kast).toBeDefined();
  });

  test("the term is large and deep enough to be worth soaking", () => {
    let nodes = 0;
    collect(() => void nodes++, kast);
    expect(nodes).toBeGreaterThan(1000);
    // 43 as measured: deeper than every other fixture here, and deep enough
    // that a recursive fold over a *larger* configuration of the same shape
    // would be within sight of a default stack.
    expect(depthOf(kast)).toBeGreaterThanOrEqual(40);
  });

  test("every node is a KAST node this package can have produced", () => {
    // `koreToKastPure` emits `KToken`, `KVariable`, `KApply`, `KSequence` and —
    // only for `\rewrites` — `KRewrite`. A `KAs` is unreachable: KORE has no
    // node that decodes to one.
    const seen = new Set<string>();
    collect((term) => void seen.add(term.node), kast);
    expect([...seen].toSorted()).toEqual(["KApply", "KSequence", "KToken", "KVariable"]);
  });

  test("no injection survived and no label kept its Lbl prefix", () => {
    collect((term) => {
      if (term.node !== "KApply") return;
      expect(term.label.name).not.toBe("inj");
      expect(term.label.name.startsWith("Lbl")).toBe(false);
    }, kast);
  });

  test("no variable kept its Var prefix or an unresolved mangling", () => {
    collect((term) => {
      if (term.node !== "KVariable") return;
      expect(term.name.startsWith("Var")).toBe(false);
      // An apostrophe left in a name means a mangled run was not decoded.
      expect(term.name).not.toContain("'");
    }, kast);
  });

  test("converting twice gives the same term", () => {
    expect(koreToKastPure(PATTERN)).toEqual(kast);
  });
});

/** Iterative depth, for the same reason the converters are iterative. */
function depthOf(root: KInner): number {
  let max = 0;
  const stack: { readonly term: KInner; readonly depth: number }[] = [{ term: root, depth: 1 }];
  for (let frame = stack.pop(); frame !== undefined; frame = stack.pop()) {
    const { term, depth } = frame;
    if (depth > max) max = depth;
    const children =
      term.node === "KApply"
        ? term.args
        : term.node === "KSequence"
          ? term.items
          : term.node === "KRewrite"
            ? [term.lhs, term.rhs]
            : term.node === "KAs"
              ? [term.pattern, term.alias]
              : [];
    for (const child of children) stack.push({ term: child, depth: depth + 1 });
  }
  return max;
}
