/**
 * Ordinal → rule identity: the numbering rule, the pyk discrepancy it exists
 * because of, and the join over two real definitions.
 *
 * `reference.test.ts` already checks every resolution in three traces against
 * `kore-proof-trace`'s own output; this file checks the *properties* of the
 * index and the cases the traces do not reach.
 */

import { describe, expect, test } from "bun:test";
import { parseDefinition } from "@kframework-ts/kore";

import { ordinalIdentity, ordinalRuleIndex, referenceLocation } from "../src/ordinals.ts";
import { runDefinition } from "./support.ts";

const ADD_REWRITE = runDefinition("addRewrite");
const GUARDED = runDefinition("guardedBig");

describe("ordinalRuleIndex", () => {
  test("has one entry per axiom-or-claim declaration, in file order", () => {
    // The numbering is `next_ordinal++` over `axioms_`
    // (`llvm-backend lib/ast/definition.cpp:222-237`), and `axioms_` is every
    // `axiom` *and* `claim` declaration in `add_module` order (`:51-71`).
    const declarations = ADD_REWRITE.split("\n").filter((line) => /^\s*(axiom|claim)\b/.test(line)).length;
    const index = ordinalRuleIndex(parseDefinition(ADD_REWRITE, { lazyAxioms: true }));
    expect(index.length).toBe(declarations);
    expect(index.length).toBe(161);
    expect(index.map((identity) => identity.ordinal)).toEqual(index.map((_, ordinal) => ordinal));
  });

  test("a lazy parse and an eager one give the same index", () => {
    // A `LazyAxiom` is tagged `"LazyAxiom"`, not `"Axiom"`, so a filter that
    // only matched the latter would return an *empty* index here rather than
    // failing — which is exactly the bug this assertion exists to catch.
    const lazy = ordinalRuleIndex(parseDefinition(ADD_REWRITE, { lazyAxioms: true }));
    const eager = ordinalRuleIndex(parseDefinition(ADD_REWRITE));
    expect(lazy.length).toBeGreaterThan(0);
    expect(lazy).toEqual(eager);
  });

  test('`ordinal{}("N")` is nowhere in definition.kore, which is why counting is the only way', () => {
    // pyk's test greps for exactly this (`test_prooftrace.py:24-29`) — but on
    // the *preprocessed in-memory* definition, where `preprocess` added it
    // (`definition.cpp:233-237`).  On disk it does not exist.
    expect(ADD_REWRITE).not.toInclude("ordinal{}(");
    expect(GUARDED).not.toInclude("ordinal{}(");
  });

  test("resolves the ordinals the reference tool reported for the doc's example", () => {
    const index = ordinalRuleIndex(parseDefinition(ADD_REWRITE, { lazyAxioms: true }));
    expect(index[108]).toMatchObject({ label: "ADD-REWRITE.state-next", module: "ADD-REWRITE" });
    expect(index[106]?.label).toBe("ADD-REWRITE.add-succ");
    expect(index[107]?.label).toBe("ADD-REWRITE.add-zero");
    expect(index[104]?.label).toBe("ADD-REWRITE.state-succ");
    // The location is the full four-number span, of which the tool prints only
    // the start line.
    expect(index[108]?.location?.[0]).toBe(18);
    expect(referenceLocation(index[108]!)).toEndWith("add-rewrite.k:18");
  });

  test("resolves the guarded semantics' rules, equations included", () => {
    const index = ordinalRuleIndex(parseDefinition(GUARDED, { lazyAxioms: true }));
    expect(index.length).toBe(230);
    expect(index[134]?.label).toBe("GUARDED.halve-small");
    expect(index[135]?.label).toBe("GUARDED.halve-big");
    // Function equations are axioms like any other and get ordinals like any
    // other, which is what makes `records.ts`'s depth option meaningful.
    expect(index[167]?.label).toBe("GUARDED.depth-s");
    expect(index[212]?.label).toBe("GUARDED.pred-s");
  });

  test("carries the UNIQUE_ID the kore-rpc path keys on, where there is one", () => {
    const index = ordinalRuleIndex(parseDefinition(ADD_REWRITE, { lazyAxioms: true }));
    expect(index[108]?.uniqueId).toMatch(/^[0-9a-f]{64}$/);
    // …and `null` where there is not: generated axioms carry no unique id, and
    // those are exactly the steps a kore-rpc trace could not name either.
    const withoutId = index.filter((identity) => identity.uniqueId === null);
    expect(withoutId.length).toBeGreaterThan(0);
    expect(index.filter((identity) => identity.uniqueId !== null).length).toBeGreaterThan(0);
  });

  test("declaredLabel is null where label falls back", () => {
    const index = ordinalRuleIndex(parseDefinition(ADD_REWRITE, { lazyAxioms: true }));
    const unlabelled = index.find((identity) => identity.declaredLabel === null);
    expect(unlabelled).toBeDefined();
    // The fallback chain is label → UNIQUE_ID → `axiom@<ordinal>`, so `label`
    // is never empty even when nothing was declared.
    expect(unlabelled?.label).not.toBe("");
    expect(index[108]?.declaredLabel).toBe("ADD-REWRITE.state-next");
  });

  test("an out-of-range ordinal is undefined, not an exception", () => {
    const index = ordinalRuleIndex(parseDefinition(ADD_REWRITE, { lazyAxioms: true }));
    expect(ordinalIdentity(index, index.length)).toBeUndefined();
    expect(ordinalIdentity(index, 0)).toBeDefined();
  });

  test("referenceLocation is empty when either half is missing", () => {
    expect(
      referenceLocation({
        label: "x",
        declaredLabel: null,
        source: null,
        location: [1, 2, 3, 4],
        module: null,
        ordinal: 0,
        uniqueId: null,
      }),
    ).toBe("");
    expect(
      referenceLocation({
        label: "x",
        declaredLabel: null,
        source: "a.k",
        location: null,
        module: null,
        ordinal: 0,
        uniqueId: null,
      }),
    ).toBe("");
  });
});
