import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Atts, EMPTY_ATT, KAtt, attEntry } from "../src/att.ts";
import { ProductionIndex, type AttributionFailure, type ProductionRef } from "../src/attribution.ts";
import { kas, kapply, klabel, krewrite, ksequence, ksort, ktoken, kvariable, type KInner } from "../src/inner.ts";
import {
  kflatmodule,
  kimport,
  knonterminal,
  kproduction,
  KDefinition,
  readKastDefinitionFromJson,
  type KProduction,
} from "../src/outer.ts";

function subsort(sup: string, sub: string): KProduction {
  return kproduction(sup, { items: [knonterminal(sub)] });
}
function symbol(
  sort: string,
  label: string,
  args: readonly string[] = [],
  options: { readonly params?: readonly string[]; readonly att?: KAtt } = {},
): KProduction {
  return kproduction(sort, {
    items: args.map((arg) => knonterminal(arg)),
    klabel: klabel(label),
    params: options.params ?? [],
    att: options.att ?? EMPTY_ATT,
  });
}
function index(definition: KDefinition, module = "MAIN"): ProductionIndex {
  const built = ProductionIndex.forModule(definition, module);
  if (built instanceof ProductionIndex) return built;
  throw new TypeError(`Could not build index: ${built.kind}`);
}

function used(value: ReadonlySet<ProductionRef> | AttributionFailure): ReadonlySet<ProductionRef> {
  if ("kind" in value) throw new TypeError(`Could not attribute term: ${value.kind}`);
  return value;
}

describe("ProductionIndex", () => {
  test("resolves labels and direct edges over imports but measures the named module only", () => {
    const imported = kflatmodule("IMPORTED", { sentences: [subsort("A", "B"), symbol("B", "imported")] });
    const main = kflatmodule("MAIN", { imports: [kimport("IMPORTED")], sentences: [symbol("A", "root", ["A"])] });
    const built = index(new KDefinition("MAIN", [main, imported]));
    expect(built.measured.map((ref) => (ref.kind === "label" ? ref.klabel : ref.kind))).toEqual(["root"]);
    const result = used(built.productionsUsed(kapply("root", [kapply("imported")]), ksort("A")));
    expect([...result].map((ref) => ref.kind).toSorted((left, right) => left.localeCompare(right))).toEqual([
      "label",
      "label",
      "subsort",
    ]);
  });

  test("returns exact paths for equal, imported, cyclic, and diamond direct-edge graphs", () => {
    const equal = index(new KDefinition("MAIN", [kflatmodule("MAIN")]));
    expect(equal.subsortPath(ksort("A"), ksort("A"))).toEqual([]);
    const imported = index(
      new KDefinition("MAIN", [
        kflatmodule("MAIN", { imports: [kimport("IMPORTED")] }),
        kflatmodule("IMPORTED", { sentences: [subsort("A", "B")] }),
      ]),
    );
    const importedPath = imported.subsortPath(ksort("B"), ksort("A"));
    expect(Array.isArray(importedPath)).toBe(true);
    if (Array.isArray(importedPath)) expect(importedPath.map((edge) => edge.kind)).toEqual(["subsort"]);
    const cyclic = index(
      new KDefinition("MAIN", [kflatmodule("MAIN", { sentences: [subsort("A", "B"), subsort("B", "A")] })]),
    );
    expect(cyclic.subsortPath(ksort("A"), ksort("Missing"))).toMatchObject({ kind: "no-subsort-path" });
    const diamond = index(
      new KDefinition("MAIN", [
        kflatmodule("MAIN", {
          sentences: [subsort("A", "B"), subsort("A", "C"), subsort("B", "D"), subsort("C", "D")],
        }),
      ]),
    );
    expect(diamond.subsortPath(ksort("D"), ksort("A"))).toMatchObject({ kind: "ambiguous-subsort" });
    const unique = index(
      new KDefinition("MAIN", [kflatmodule("MAIN", { sentences: [subsort("A", "B"), subsort("B", "D")] })]),
    );
    const path = unique.subsortPath(ksort("D"), ksort("A"));
    expect(Array.isArray(path)).toBe(true);
    if (Array.isArray(path)) expect(path).toHaveLength(2);
    expect(unique.subsortPath(ksort("D"), ksort("Missing"))).toMatchObject({ kind: "no-subsort-path" });
  });

  test("accepts structurally equal labels, rejects distinct duplicates, and excludes unclassified productions", () => {
    expect(
      ProductionIndex.forModule(
        new KDefinition("MAIN", [
          kflatmodule("MAIN", { imports: [kimport("IMPORTED")], sentences: [symbol("A", "same")] }),
          kflatmodule("IMPORTED", { sentences: [symbol("A", "same")] }),
        ]),
        "MAIN",
      ),
    ).toBeInstanceOf(ProductionIndex);
    const distinct = ProductionIndex.forModule(
      new KDefinition("MAIN", [kflatmodule("MAIN", { sentences: [symbol("A", "same"), symbol("B", "same")] })]),
      "MAIN",
    );
    expect(distinct).toMatchObject({ kind: "duplicate-label", klabel: "same" });
    const excluded = index(
      new KDefinition("MAIN", [
        kflatmodule("MAIN", {
          sentences: [kproduction("A"), kproduction("Token", { att: new KAtt([attEntry(Atts.TOKEN, null)]) })],
        }),
      ]),
    );
    expect(excluded.excluded.map((entry) => entry.reason)).toEqual(["unclassified", "token"]);
  });

  test("reports remaining construction failures and all walk refusals", () => {
    expect(ProductionIndex.forModule(new KDefinition("MAIN", [kflatmodule("MAIN")]), "MISSING")).toMatchObject({
      kind: "no-module",
    });
    const built = index(new KDefinition("MAIN", [kflatmodule("MAIN", { sentences: [symbol("A", "f", ["A"])] })]));
    expect(built.productionsUsed(kapply("missing"), ksort("A"))).toMatchObject({ kind: "unknown-label" });
    expect(built.productionsUsed(kapply("f", [ktoken("x", "A"), ktoken("y", "A")]), ksort("A"))).toMatchObject({
      kind: "arity-mismatch",
    });
    expect(built.productionsUsed(kvariable("X", "A"), ksort("A"))).toMatchObject({ kind: "unsupported-node" });
    expect(built.productionsUsed(kas(ktoken("x", "A"), kvariable("X", "A")), ksort("A"))).toMatchObject({
      kind: "unsupported-node",
    });
    expect(built.productionsUsed(krewrite(ktoken("x", "A"), ktoken("y", "A")), ksort("A"))).toMatchObject({
      kind: "unsupported-node",
    });
  });

  test("substitutes params, handles KSequence, excludes generated injections, and is depth-safe", () => {
    const parameter = ksort("S");
    const functionAtt = new KAtt([attEntry(Atts.FUNCTION, null)]);
    const built = index(
      new KDefinition("MAIN", [
        kflatmodule("MAIN", {
          sentences: [
            subsort("KItem", "Int"),
            symbol("S", "id", ["S"], { params: ["S"] }),
            symbol("K", "seq", ["K"]),
            symbol("A", "function", [], { att: functionAtt }),
          ],
        }),
      ]),
    );
    expect(built.excluded.map((entry) => entry.reason)).toEqual(["generated-injection", "function"]);
    expect(
      built.productionsUsed(kapply(klabel("id", [parameter]), [ktoken("x", parameter)]), parameter) instanceof Set,
    ).toBe(true);
    const sequence = used(built.productionsUsed(kapply("seq", [ksequence([ktoken("1", "Int")])]), ksort("K")));
    expect([...sequence].some((ref) => ref.kind === "subsort")).toBe(true);
    let deep: KInner = ktoken("z", "A");
    for (let i = 0; i < 20_000; i++) deep = kapply("wrap", [deep]);
    const deepIndex = index(
      new KDefinition("MAIN", [kflatmodule("MAIN", { sentences: [symbol("A", "wrap", ["A"])] })]),
    );
    expect(deepIndex.productionsUsed(deep, ksort("A")) instanceof Set).toBe(true);
  });

  test("constructs an index for every module reachable from every checked-in compiled definition's main module", () => {
    const fixtures = [
      ["kompiled", "fixtures", "generated", "imp-llvm-kompiled", "compiled.json"],
      ["kompiled", "fixtures", "generated", "imp-haskell-kompiled", "compiled.json"],
      ["wasm-fixtures", "fixtures", "wasm-haskell-kompiled", "compiled.json"],
      ["evm-fixtures", "fixtures", "evm-haskell-kompiled", "compiled.json"],
      ["mir-fixtures", "fixtures", "mir-haskell-kompiled", "compiled.json"],
      ["kcovr", "fixtures", "compiled", "compiled.json"],
    ] as const;
    for (const fixture of fixtures) {
      const definition = readKastDefinitionFromJson(
        readFileSync(join(import.meta.dir, "..", "..", ...fixture), "utf8"),
      );
      for (const module of definition.modules) {
        expect(ProductionIndex.forModule(definition, module.name)).toBeInstanceOf(ProductionIndex);
      }
    }
  });
});
