/**
 * `src/claim-index.ts` against the de-facto upstream suite.
 *
 * `claim_index.py` has **no direct test anywhere in pyk**.  Its real test is
 * `PYKT/integration/kprove/test_get_claims.py`, which drives `ClaimIndex`
 * through `KProve.get_claims` and therefore needs a kompiled definition and a
 * `kprove` binary.  We pre-generated its module list once (see
 * `fixtures/PROVENANCE.md`) so the whole table runs here as a pure test with no
 * K installed and no process started.
 *
 * The table below is `GET_CLAIMS_SPEC_DATA` (`test_get_claims.py:20-65`)
 * transcribed row for row, plus the two standalone cases at `:99-105`.  One row
 * is marked `skip` upstream (`:17,81-82`) and is kept here as an explicit
 * **documented divergence from intent** — see `simple-dep-in-submodule-2`.
 */

import { describe, expect, test } from "bun:test";
import {
  Atts,
  attEntry,
  claimDependencies,
  kclaim,
  KAtt,
  kflatmodule,
  kflatmodulelist,
  kvariable,
} from "@kframework-ts/kast";
import type { KClaim, KFlatModuleList } from "@kframework-ts/kast";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { caught } from "./caught.ts";
import { ClaimIndex, ClaimIndexError, resolveClaimDepends, staticOrder } from "../src/claim-index.ts";
import { decodeModuleList } from "../src/parse-modules.ts";

//////////////////////////////
// Fixtures                 //
//////////////////////////////

const FIXTURES = join(import.meta.dir, "..", "fixtures", "generated");

function moduleList(name: string): KFlatModuleList {
  return decodeModuleList(readFileSync(join(FIXTURES, name), "utf8"));
}

/** `kprove --spec-module MULTI-CLAIM-SPEC --dry-run --emit-json-spec`. */
const SPEC = moduleList("multi-claim-spec.modulelist.json");
/** The same, for the module whose one claim depends on a label that does not exist. */
const BROKEN = moduleList("multi-claim-broken-spec.modulelist.json");

/** `{claim.label: claim.dependencies}` — `test_get_claims.py:93`. */
function graphOf(index: ClaimIndex, labels: readonly string[]): Record<string, string[]> {
  const result: Record<string, string[]> = {};
  for (const label of labels) result[label] = [...claimDependencies(index.require(label))];
  return result;
}

/** A claim carrying `label`, and `depends` when one is given. */
function claimWith(label: string, depends?: readonly string[]): KClaim {
  const entries = [attEntry(Atts.LABEL, label)];
  if (depends !== undefined) entries.push(attEntry(Atts.DEPENDS, depends.join(",")));
  return kclaim(kvariable("X"), { att: new KAtt(entries) });
}

//////////////////////////////
// The fixture itself       //
//////////////////////////////

describe("the vendored module list", () => {
  test("is the three spec modules K resolved MULTI-CLAIM-SPEC to", () => {
    expect(SPEC.mainModule).toBe("MULTI-CLAIM-SPEC");
    expect(SPEC.modules.map((module) => module.name)).toEqual([
      "MULTI-CLAIM-SPEC-DEPENDENCY-1",
      "MULTI-CLAIM-SPEC-DEPENDENCY-2",
      "MULTI-CLAIM-SPEC",
    ]);
  });

  test("indexes in module-then-sentence order", () => {
    // Insertion order is what decides every tie in `labels({ordered: true})`,
    // so it is pinned rather than left implicit.  The two hex labels are the
    // `UNIQUE_ID`s of the spec's two unlabelled claims.
    expect([...ClaimIndex.fromModuleList(SPEC).claims.keys()]).toEqual([
      "MULTI-CLAIM-SPEC-DEPENDENCY-1.dep-1.1",
      "MULTI-CLAIM-SPEC-DEPENDENCY-2.dep-2.1",
      "MULTI-CLAIM-SPEC-DEPENDENCY-2.rep-dep",
      "MULTI-CLAIM-SPEC-DEPENDENCY-2.dep-2.2",
      "5ddd2bbfcb186faba347e63f4ab5300f1faf0056075662f5e8432a0fd2e3f2bf",
      "MULTI-CLAIM-SPEC.dep",
      "MULTI-CLAIM-SPEC.rep-dep",
      "MULTI-CLAIM-SPEC.main.1",
      "MULTI-CLAIM-SPEC.main.3",
      "f5513267556f9bea2efb8bbb579cfd2aecf60509a7fa2f5996d7f434c9728d6a",
    ]);
  });
});

//////////////////////////////
// The upstream matrix      //
//////////////////////////////

/** `GET_CLAIMS_SPEC_DATA` (`test_get_claims.py:20-65`) — `null` means "raises". */
const GET_CLAIMS_SPEC_DATA: readonly (readonly [string, string[], Record<string, string[]> | null])[] = [
  ["simple-dep-in-submodule-fail", ["dep-1.1"], null],
  [
    "simple-dep-in-submodule-pass",
    ["MULTI-CLAIM-SPEC-DEPENDENCY-1.dep-1.1"],
    { "MULTI-CLAIM-SPEC-DEPENDENCY-1.dep-1.1": [] },
  ],
  // Upstream declares this row as raising and then SKIPS it
  // (`test_get_claims.py:17,81-82`), so the declaration has never been checked
  // against the code.  It is wrong: `MULTI-CLAIM-SPEC-DEPENDENCY-2.dep-2.2` is
  // a real label and its one dependency is a real label, so nothing can raise.
  // This port matches pyk's behaviour, not its test table's intent, and keeps
  // the row as a documented divergence either way.
  // The expectation below is what pyk actually does: the seed resolves exactly,
  // and the closure pulls in its dependency.
  [
    "simple-dep-in-submodule-2 (documented divergence from upstream intent)",
    ["MULTI-CLAIM-SPEC-DEPENDENCY-2.dep-2.2"],
    {
      "MULTI-CLAIM-SPEC-DEPENDENCY-2.dep-2.2": ["MULTI-CLAIM-SPEC-DEPENDENCY-1.dep-1.1"],
      "MULTI-CLAIM-SPEC-DEPENDENCY-1.dep-1.1": [],
    },
  ],
  ["no-dep-name-unqualified", ["dep"], { "MULTI-CLAIM-SPEC.dep": [] }],
  ["no-dep-name-qualified", ["MULTI-CLAIM-SPEC.dep"], { "MULTI-CLAIM-SPEC.dep": [] }],
  [
    "two-deps-one-nested",
    ["MULTI-CLAIM-SPEC.main.1"],
    {
      "MULTI-CLAIM-SPEC.main.1": ["MULTI-CLAIM-SPEC.dep", "MULTI-CLAIM-SPEC-DEPENDENCY-1.dep-1.1"],
      "MULTI-CLAIM-SPEC.dep": [],
      "MULTI-CLAIM-SPEC-DEPENDENCY-1.dep-1.1": [],
    },
  ],
  ["bad-unqualified-main-dep", ["MULTI-CLAIM-SPEC.main.4"], null],
  ["rep-dep-in-submodule", ["rep-dep"], { "MULTI-CLAIM-SPEC.rep-dep": [] }],
];

describe("test_get_claims", () => {
  for (const [testId, includeLabels, expectedGraph] of GET_CLAIMS_SPEC_DATA) {
    test(testId, () => {
      const index = ClaimIndex.fromModuleList(SPEC);

      if (expectedGraph === null) {
        expect(() => index.labels({ include: includeLabels })).toThrow(ClaimIndexError);
        return;
      }

      const actualGraph = graphOf(index, index.labels({ include: includeLabels }));

      expect(new Set(Object.keys(actualGraph))).toEqual(new Set(Object.keys(expectedGraph)));
      for (const [label, deps] of Object.entries(expectedGraph)) {
        expect(new Set(actualGraph[label])).toEqual(new Set(deps));
      }
    });
  }

  test("test_get_claims_unlabeled — every claim, and there are exactly 10", () => {
    const index = ClaimIndex.fromModuleList(SPEC);
    expect(index.labels()).toHaveLength(10);
    expect(index.size).toBe(10);
  });

  test("test_get_claims_broken — a dependency on a label that does not exist", () => {
    // The failure is in `_resolve_depends`, before validation: `non-existent-1`
    // is neither a label nor `MULTI-CLAIM-BROKEN-SPEC.non-existent-1`.
    const error = caught(() => ClaimIndex.fromModuleList(BROKEN), ClaimIndexError);
    expect(error.message).toBe("Claim label not found: non-existent-1");
  });
});

//////////////////////////////
// resolve                  //
//////////////////////////////

describe("resolve", () => {
  const index = ClaimIndex.fromModuleList(SPEC);

  test("takes an exact match first", () => {
    expect(index.resolve("MULTI-CLAIM-SPEC.dep")).toBe("MULTI-CLAIM-SPEC.dep");
  });

  test("qualifies with the MAIN module, not the declaring one", () => {
    expect(index.resolve("dep")).toBe("MULTI-CLAIM-SPEC.dep");
    // The claim exists — as `MULTI-CLAIM-SPEC-DEPENDENCY-1.dep-1.1` — but the
    // only qualifier tried is the main module, so this is not found.
    expect(caught(() => index.resolve("dep-1.1"), ClaimIndexError).message).toBe("Claim label not found: dep-1.1");
  });

  test("prefers the main module's claim when two modules use the same short name", () => {
    expect(index.resolve("rep-dep")).toBe("MULTI-CLAIM-SPEC.rep-dep");
    expect(index.hasLabel("MULTI-CLAIM-SPEC-DEPENDENCY-2.rep-dep")).toBe(true);
  });

  test("get resolves and returns undefined where require throws", () => {
    expect(index.get("dep")).toBe(index.require("MULTI-CLAIM-SPEC.dep"));
    expect(index.get("nope")).toBeUndefined();
    expect(() => index.require("nope")).toThrow(ClaimIndexError);
  });

  test("resolveAll deduplicates BEFORE resolving, so two spellings survive as two entries", () => {
    // `unique(labels)` then `map(resolve)` (`claim_index.py:121-122`) — the
    // order is upstream's and it is observable.
    expect(index.resolveAll(["dep", "dep"])).toEqual(["MULTI-CLAIM-SPEC.dep"]);
    expect(index.resolveAll(["dep", "MULTI-CLAIM-SPEC.dep"])).toEqual(["MULTI-CLAIM-SPEC.dep", "MULTI-CLAIM-SPEC.dep"]);
  });
});

//////////////////////////////
// depends resolution       //
//////////////////////////////

describe("resolveClaimDepends", () => {
  test("qualifies with the OWNING module and stores the result comma-joined", () => {
    const index = ClaimIndex.fromModuleList(SPEC);
    // `[depends(dep,MULTI-CLAIM-SPEC-DEPENDENCY-1.dep-1.1)]` in the source.
    expect(index.require("MULTI-CLAIM-SPEC.main.1").att.get(Atts.DEPENDS)).toBe(
      "MULTI-CLAIM-SPEC.dep,MULTI-CLAIM-SPEC-DEPENDENCY-1.dep-1.1",
    );
  });

  test("leaves an already-qualified label alone", () => {
    const index = ClaimIndex.fromModuleList(SPEC);
    expect(index.require("MULTI-CLAIM-SPEC-DEPENDENCY-2.dep-2.2").att.get(Atts.DEPENDS)).toBe(
      "MULTI-CLAIM-SPEC-DEPENDENCY-1.dep-1.1",
    );
  });

  test("adds no attribute to a claim that has no depends", () => {
    const index = ClaimIndex.fromModuleList(SPEC);
    expect(index.require("MULTI-CLAIM-SPEC.dep").att.has(Atts.DEPENDS)).toBe(false);
  });

  test("resolves against labels from OTHER modules too, not just the owning one", () => {
    // `labels` is computed over every module in the list before any rewriting
    // (`claim_index.py:70`), so a bare name declared elsewhere resolves as-is.
    const resolved = resolveClaimDepends(
      kflatmodulelist("A", [
        kflatmodule("A", { sentences: [claimWith("a", ["b"])] }),
        kflatmodule("B", { sentences: [claimWith("b")] }),
      ]),
    );
    expect(resolved.modules[0]?.sentences[0]?.att.get(Atts.DEPENDS)).toBe("b");
  });
});

//////////////////////////////
// labels: closure          //
//////////////////////////////

describe("labels", () => {
  const index = ClaimIndex.fromModuleList(SPEC);

  test("with no include returns every label, in index order", () => {
    expect(index.labels()).toEqual([...index.claims.keys()]);
  });

  test("closes transitively, breadth-first, with the seed first", () => {
    expect(index.labels({ include: ["MULTI-CLAIM-SPEC.main.1"] })).toEqual([
      "MULTI-CLAIM-SPEC.main.1",
      "MULTI-CLAIM-SPEC.dep",
      "MULTI-CLAIM-SPEC-DEPENDENCY-1.dep-1.1",
    ]);
  });

  test("withDepends: false returns the include list untouched", () => {
    expect(index.labels({ include: ["MULTI-CLAIM-SPEC.main.1"], withDepends: false })).toEqual([
      "MULTI-CLAIM-SPEC.main.1",
    ]);
  });

  test("exclude wins over include, with and without the closure", () => {
    expect(
      index.labels({
        include: ["MULTI-CLAIM-SPEC.main.1"],
        exclude: ["MULTI-CLAIM-SPEC.main.1"],
      }),
    ).toEqual([]);
    expect(
      index.labels({
        include: ["MULTI-CLAIM-SPEC.main.1", "MULTI-CLAIM-SPEC.dep"],
        exclude: ["MULTI-CLAIM-SPEC.dep"],
        withDepends: false,
      }),
    ).toEqual(["MULTI-CLAIM-SPEC.main.1"]);
  });

  test("an excluded label prunes the subtree BELOW it on that path", () => {
    // `MULTI-CLAIM-SPEC.dep` has no dependencies of its own, so a fixture with
    // depth is built by hand: main → mid → leaf, excluding `mid`.
    const index2 = ClaimIndex.fromModuleList(
      kflatmodulelist("M", [
        kflatmodule("M", {
          sentences: [claimWith("M.main", ["M.mid"]), claimWith("M.mid", ["M.leaf"]), claimWith("M.leaf")],
        }),
      ]),
    );
    expect(index2.labels({ include: ["M.main"] })).toEqual(["M.main", "M.mid", "M.leaf"]);
    expect(index2.labels({ include: ["M.main"], exclude: ["M.mid"] })).toEqual(["M.main"]);
  });

  test("an excluded label does NOT prune a dependency reachable another way", () => {
    // Upstream's docstring says "their dependencies are not considered ON THE
    // GIVEN PATH" (`claim_index.py:139`), and it means it.
    const index2 = ClaimIndex.fromModuleList(
      kflatmodulelist("M", [
        kflatmodule("M", {
          sentences: [
            claimWith("M.main", ["M.mid", "M.other"]),
            claimWith("M.mid", ["M.leaf"]),
            claimWith("M.other", ["M.leaf"]),
            claimWith("M.leaf"),
          ],
        }),
      ]),
    );
    expect(index2.labels({ include: ["M.main"], exclude: ["M.mid"] })).toEqual(["M.main", "M.other", "M.leaf"]);
  });

  test("unresolvable include and exclude entries both raise", () => {
    expect(() => index.labels({ include: ["nope"] })).toThrow(ClaimIndexError);
    expect(() => index.labels({ exclude: ["nope"] })).toThrow(ClaimIndexError);
  });
});

//////////////////////////////
// Topological order        //
//////////////////////////////

describe("ordered labels", () => {
  const index = ClaimIndex.fromModuleList(SPEC);

  test("puts dependencies first", () => {
    expect(index.labels({ include: ["MULTI-CLAIM-SPEC.main.1"], ordered: true })).toEqual([
      "MULTI-CLAIM-SPEC-DEPENDENCY-1.dep-1.1",
      "MULTI-CLAIM-SPEC.dep",
      "MULTI-CLAIM-SPEC.main.1",
    ]);
  });

  test("pins the whole-index order, tie-breaks included", () => {
    // Cross-checked against CPython:
    //   list(TopologicalSorter(graph).static_order())
    // over the same graph, built in the same key order.  Every dependency-free
    // claim comes out in index order first, then the three dependents.
    expect(index.labels({ ordered: true })).toEqual([
      "MULTI-CLAIM-SPEC-DEPENDENCY-1.dep-1.1",
      "MULTI-CLAIM-SPEC-DEPENDENCY-2.dep-2.1",
      "MULTI-CLAIM-SPEC-DEPENDENCY-2.rep-dep",
      "5ddd2bbfcb186faba347e63f4ab5300f1faf0056075662f5e8432a0fd2e3f2bf",
      "MULTI-CLAIM-SPEC.dep",
      "MULTI-CLAIM-SPEC.rep-dep",
      "f5513267556f9bea2efb8bbb579cfd2aecf60509a7fa2f5996d7f434c9728d6a",
      "MULTI-CLAIM-SPEC-DEPENDENCY-2.dep-2.2",
      "MULTI-CLAIM-SPEC.main.1",
      "MULTI-CLAIM-SPEC.main.3",
    ]);
  });

  test("builds the graph in INDEX order, not include order", () => {
    // Reversing the include list must not change the result: the graph is
    // `{label: deps for label, claim in self.claims.items() if label in labels}`
    // (`claim_index.py:183-187`), keyed by the index.
    const forwards = index.labels({ include: ["MULTI-CLAIM-SPEC.main.1", "MULTI-CLAIM-SPEC.main.3"], ordered: true });
    const backwards = index.labels({ include: ["MULTI-CLAIM-SPEC.main.3", "MULTI-CLAIM-SPEC.main.1"], ordered: true });
    expect(backwards).toEqual(forwards);
  });
});

describe("staticOrder", () => {
  test("discovers a predecessor at its first successor's position", () => {
    // CPython: list(TopologicalSorter({'a': ['z'], 'b': [], 'z': []}).static_order())
    //          == ['z', 'b', 'a']
    // `z` precedes `b` in the ready list because `add('a', 'z')` created its
    // node info before `add('b')` was reached — a plain "sort the roots by
    // graph key order" would have said `b, z, a`.
    expect(
      staticOrder(
        new Map([
          ["a", ["z"]],
          ["b", []],
          ["z", []],
        ]),
      ),
    ).toEqual(["z", "b", "a"]);
  });

  test("releases successors in the finishing node's add-order", () => {
    // CPython: {'x': ['r'], 'y': ['r'], 'r': []} -> ['r', 'x', 'y']
    expect(
      staticOrder(
        new Map([
          ["x", ["r"]],
          ["y", ["r"]],
          ["r", []],
        ]),
      ),
    ).toEqual(["r", "x", "y"]);
  });

  test("counts a duplicated predecessor twice, as upstream does", () => {
    // `npredecessors += len(predecessors)` and one `successors.append` each,
    // so the two cancel and the node still becomes ready exactly once.
    expect(
      staticOrder(
        new Map([
          ["a", ["b", "b"]],
          ["b", []],
        ]),
      ),
    ).toEqual(["b", "a"]);
  });

  test("reports a cycle rather than silently truncating", () => {
    const error = caught(
      () =>
        staticOrder(
          new Map([
            ["a", ["b"]],
            ["b", ["a"]],
            ["c", []],
          ]),
        ),
      ClaimIndexError,
    );
    expect(error.cycle).toEqual(["a", "b"]);
    expect(error.message).toContain("Cycle detected");
  });

  test("an empty graph is an empty order", () => {
    expect(staticOrder(new Map())).toEqual([]);
  });
});

//////////////////////////////
// Validation               //
//////////////////////////////

describe("validation", () => {
  test("rejects a key that disagrees with its claim's label", () => {
    const error = caught(() => new ClaimIndex([["wrong", claimWith("right")]]), ClaimIndexError);
    expect(error.message).toBe("Claim label mismatch, expected: wrong, found: right");
  });

  test("rejects a dependency that is not in the index", () => {
    const error = caught(() => new ClaimIndex([["a", claimWith("a", ["b"])]]), ClaimIndexError);
    expect(error.message).toBe("Invalid dependency label: b");
  });

  test("accepts a dependency that is", () => {
    const index = new ClaimIndex([
      ["a", claimWith("a", ["b"])],
      ["b", claimWith("b")],
    ]);
    expect(index.size).toBe(2);
  });
});

//////////////////////////////
// Immutability             //
//////////////////////////////

describe("the index is frozen", () => {
  const index = ClaimIndex.fromModuleList(SPEC);

  test("the instance itself is frozen", () => {
    expect(Object.isFrozen(index)).toBe(true);
  });

  test("claims is a read-only VIEW, not a Map — no mutators exist on it", () => {
    // `ReadonlyMap` is a type-level claim only; this is the runtime one, which
    // is what `FrozenDict` buys upstream.
    const view: object = index.claims;
    expect(Object.isFrozen(view)).toBe(true);
    expect("set" in view).toBe(false);
    expect("delete" in view).toBe(false);
    expect("clear" in view).toBe(false);
  });

  test("the read half of the Map protocol still works", () => {
    expect(index.claims.size).toBe(10);
    expect(index.claims.has("MULTI-CLAIM-SPEC.dep")).toBe(true);
    expect([...index.claims.values()]).toHaveLength(10);
    const seen: string[] = [];
    index.claims.forEach((_claim, label) => {
      seen.push(label);
    });
    expect(seen).toEqual([...index.claims.keys()]);
  });

  test("mutating the source map afterwards cannot invalidate the index", () => {
    const source = new Map([["a", claimWith("a")]]);
    const built = new ClaimIndex(source);
    source.set("b", claimWith("nope"));
    expect(built.size).toBe(1);
    expect(built.claims.has("b")).toBe(false);
  });
});
