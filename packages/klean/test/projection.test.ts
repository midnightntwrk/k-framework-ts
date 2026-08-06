import { describe, expect, test } from "bun:test";
import {
  ATT_SIMPLIFICATION,
  and,
  app,
  axiom,
  definition,
  koreModule,
  koreString,
  rewrites,
  sortApp,
  sortDecl,
  symbolDecl,
  koreSymbol,
  top,
  hasAtt,
} from "@kframework-ts/kore";
import { AmbiguousRuleLabelError, UnknownRuleLabelError, projectToRewrites } from "../src/projection.ts";
import { sourceFromDefinition, sourceFromKoreText } from "../src/source.ts";

const impDefinition = new URL(
  "../../kompiled/fixtures/generated/imp-haskell-kompiled/definition.kore",
  import.meta.url,
);
const IMP_LABEL = "IMP-SYNTAX._%_1-cool";

describe("KLean rewrite projection", () => {
  test("full IMP matches pyk's projection cardinalities without forcing attribute-classified non-rules", async () => {
    const source = sourceFromKoreText(await Bun.file(impDefinition).text());
    const forced = new Set<object>();
    const counted = {
      index: source.index,
      forceAxiom(sourceAxiom: (typeof source.index.axioms)[number]) {
        forced.add(sourceAxiom);
        return source.forceAxiom(sourceAxiom);
      },
    };
    const projected = projectToRewrites(counted);
    expect(projected.rewrites).toHaveLength(56);
    expect(projected.symbols.size).toBe(69);
    expect(projected.sorts.size).toBe(19);
    expect(projected.equations.size).toBe(24);
    expect([...projected.equations.values()].reduce((count, rules) => count + rules.length, 0)).toBe(9);
    expect([...projected.constructors.values()].reduce((count, constructors) => count + constructors.length, 0)).toBe(
      44,
    );
    expect(projected.collections.size).toBe(2);
    expect([...projected.subsorts.values()].reduce((count, sorts) => count + sorts.length, 0)).toBe(23);
    expect(forced.size).toBeLessThan(source.index.axioms.length);
    const simplification = source.index.axioms.find((sourceAxiom) => hasAtt(sourceAxiom.attrs, ATT_SIMPLIFICATION));
    expect(simplification).toBeDefined();
    expect(forced.has(simplification!)).toBeFalse();
  });

  test("an exact label retains its rewrite and a materially smaller dependency closure", async () => {
    const projected = projectToRewrites(sourceFromKoreText(await Bun.file(impDefinition).text()), {
      ruleLabels: [IMP_LABEL],
    });
    expect(projected.rewrites).toHaveLength(1);
    expect(projected.rewrites[0]?.rule.label).toBe(IMP_LABEL);
    expect(projected.selection.requestedLabels).toEqual([IMP_LABEL]);
    expect(projected.selection.labels).toEqual([IMP_LABEL]);
    expect(projected.selection.uids).toHaveLength(1);
    expect(projected.selection.rewriteCount).toBe(1);
    expect(projected.selection.allRewrites).toBeFalse();
    expect(projected.symbols.size).toBeGreaterThan(0);
    expect(projected.symbols.size).toBeLessThan(100);
    expect([...projected.symbols.keys()]).toEqual([...projected.symbols.keys()].toSorted());
    expect(projected.sorts.size).toBe(13);
    expect(projected.equations.size).toBe(5);
    expect([...projected.equations.values()].reduce((count, rules) => count + rules.length, 0)).toBe(4);
    expect([...projected.constructors.values()].reduce((count, constructors) => count + constructors.length, 0)).toBe(
      27,
    );
    expect([...projected.subsorts.values()].reduce((count, sorts) => count + sorts.length, 0)).toBe(15);
  });

  test("unknown labels fail as typed exact-selection errors", async () => {
    const source = sourceFromKoreText(await Bun.file(impDefinition).text());
    expect(() => projectToRewrites(source, { ruleLabels: ["does-not-exist"] })).toThrow(UnknownRuleLabelError);
  });

  test("duplicate labels fail rather than selecting an arbitrary rewrite", () => {
    const topSort = sortApp("SortGeneratedTopCell");
    const label = app("label", [], [koreString("duplicate")]);
    const configuration = app("LblTopCell");
    const rule = (): ReturnType<typeof axiom> =>
      axiom(
        [],
        rewrites(topSort, and(topSort, [configuration, top(topSort)]), and(topSort, [configuration, top(topSort)])),
        [label],
      );
    const definitionWithDuplicate = definition([
      koreModule("TEST", [
        sortDecl("SortGeneratedTopCell"),
        symbolDecl(koreSymbol("LblTopCell"), [], topSort, [app("constructor")]),
        rule(),
        rule(),
      ]),
    ]);
    expect(() =>
      projectToRewrites(sourceFromDefinition(definitionWithDuplicate), { ruleLabels: ["duplicate"] }),
    ).toThrow(AmbiguousRuleLabelError);
  });
});
