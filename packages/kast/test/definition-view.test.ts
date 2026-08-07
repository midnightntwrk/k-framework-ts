import { describe, expect, test } from "bun:test";
import {
  kflatmodule,
  kimport,
  knonterminal,
  kproduction,
  KDefinition,
  moduleImportClosure,
  moduleImportClosureNames,
  moduleImportSubsortEdges,
  moduleLocalProductions,
} from "../src/outer.ts";

function subsort(sup: string, sub: string) {
  return kproduction(sup, { items: [knonterminal(sub)] });
}

describe("named-module definition views", () => {
  const a = kflatmodule("A", { imports: [kimport("B")], sentences: [subsort("A", "B")] });
  const b = kflatmodule("B", { imports: [kimport("A")], sentences: [subsort("B", "C")] });
  const unused = kflatmodule("UNUSED", { sentences: [subsort("U", "V")] });
  const definition = new KDefinition("A", [a, b, unused]);

  test("an arbitrary module gets its own cycle-safe import closure", () => {
    expect(moduleImportClosureNames(definition, "B")).toEqual(["B", "A"]);
    expect(moduleImportClosure(definition, "B").map((module) => module.name)).toEqual(["B", "A"]);
    expect(definition.modules.map((module) => module.name)).toEqual(["A", "B"]);
  });

  test("local productions and direct edges remain distinct from a closure", () => {
    expect(moduleLocalProductions(definition, "A").map((production) => production.sort.name)).toEqual(["A"]);
    const edges = moduleImportSubsortEdges(definition, "A");
    expect(edges.map((edge) => `${edge.from.name}->${edge.to.name}`)).toEqual(["B->A", "C->B"]);
    expect(edges).toHaveLength(2);
  });
});
