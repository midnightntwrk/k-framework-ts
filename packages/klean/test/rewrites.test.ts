import { describe, expect, test } from "bun:test";
import type { KleanProjection } from "../src/projection.js";

import { generateRewrites } from "../src/rewrites.js";

const topCell = { tag: "SortApp" as const, name: "SortGeneratedTopCell", sorts: [] };
const variable = (name: string) => ({ tag: "EVar" as const, name, sort: topCell });
const definition: KleanProjection = {
  rewrites: [
    {
      axiom: { tag: "Axiom", vars: [], pattern: { tag: "Top", sort: topCell }, attrs: [] },
      rule: {
        kind: "rewrite",
        sort: topCell,
        lhs: variable("VarL"),
        rhs: variable("VarR"),
        lhsAlias: undefined,
        requires: undefined,
        ensures: undefined,
        antiLeft: undefined,
        ctx: undefined,
        priority: 50,
        uid: "abcdef012345",
        label: "TEST.rule-name",
      },
    },
  ],
  equations: new Map(),
  sorts: new Map(),
  symbols: new Map(),
  subsorts: new Map(),
  constructors: new Map(),
  collections: new Map(),
  selection: { labels: ["TEST.rule-name"], uids: ["abcdef012345"], rewriteCount: 1, allRewrites: false },
  diagnostics: [],
};

describe("rewrite generation", () => {
  test("includes transitivity and a deterministic labelled constructor", () => {
    const generated = generateRewrites(definition);
    expect(generated.text).toContain("| tran {s1 s2 s3 : SortGeneratedTopCell}");
    expect(generated.text).toContain("| TEST_rule_name {L R : SortGeneratedTopCell} : Rewrites L R");
    expect(generated.diagnostics).toEqual([]);
  });
});
