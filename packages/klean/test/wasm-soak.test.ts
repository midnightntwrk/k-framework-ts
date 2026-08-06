/**
 * KLean against a real semantics — **opt-in, and skipped by default**.
 *
 * Every other suite in this package generates from IMP (170 rules, 40 sorts) or
 * from `fixtures/matchers.k`, a definition written by hand to reach code paths
 * IMP cannot.  This one points `generateKleanProject` at KWasm's
 * `definition.kore`: 5 314 140 bytes, 6824 axioms, 302 sorts, 1732 symbols, real
 * `Map`/`List`/`Bytes`/`Int` hooks and 44 sort-parametric axioms.  It is the
 * first input in this repository at which "does the generator survive a real
 * semantics, and how much of one can it actually lower?" is a question with a
 * measured answer rather than an assumption.
 *
 * The bytes are not vendored.  `@kframework-ts/wasm-fixtures` — private, never
 * published — owns the partial artifact and the `kompile` recipe for the rest;
 * `wasmSoakDir()` finds a locally built complete directory in a content-keyed
 * cache, or `KFRAMEWORK_TS_WASM_KOMPILED` names one explicitly.  Without either,
 * everything below skips and `bun test` keeps its promise: no K install, no
 * network, nothing outside the repository.  The recipe lives in exactly one
 * place, `packages/wasm-fixtures/fixtures/PROVENANCE.md`:
 *
 * ```sh
 * KFRAMEWORK_TS_K_BIN=…/k-7.1.337/bin \
 * KFRAMEWORK_TS_RV_CHECKOUTS=…/runtimeverification \
 *   bun run --cwd packages/wasm-fixtures kompile-soak
 * ```
 *
 * ## What this file does *not* do
 *
 * It never runs `lake build`.  The `KLEAN_RUN_LAKE=1` opt-in in
 * `imp-conformance.test.ts` and `matcher-conformance.test.ts` stays IMP-only and
 * fixture-only on purpose: elaborating 876 KB of generated Lean — 114 inductive
 * types, 84 structures, 466 function declarations and a 201-constructor
 * `Rewrites` relation — is minutes of Lean per run for a claim this file is not
 * making.  What is claimed here is that generation *terminates, is
 * deterministic, and reports every omission*, which is checkable in under a
 * second.
 *
 * ## The two findings this file exists to record
 *
 * This soak was written expecting KWasm to finally exercise two diagnostic
 * classes that IMP leaves dead — `src/lower.ts:71` ("parametric injection sorts
 * are not supported") and `src/lower.ts:129` ("parametric domain values are not
 * supported") — and the collection-hook matchers of `src/matchers.ts:270-339`.
 * **It exercises none of them, and the reasons are structural rather than a
 * matter of corpus size.**  Both are pinned below as measurements:
 *
 * 1. *Parametric sorts never reach lowering.*  KWasm has 44 axioms with more
 *    than one sort variable.  42 carry `simplification` and the remaining 2 are
 *    `functional` totality axioms for `SortMInt{SortWidth}` — and
 *    `projectToRewrites`' `DEFINITELY_NON_RULE_ATTRIBUTES` pre-filter
 *    (`src/projection.ts:306-320`) drops every one of those attributes before an
 *    axiom is even classified, let alone lowered.  Independently: a `\dv` at a
 *    non-ground sort does not occur *anywhere* in KWasm's `definition.kore`, so
 *    `lower.ts:129` has no input to be reached by at any projection.  A
 *    definition that reaches these branches would need a parametric sort in a
 *    plain (non-`simplification`) rewrite or function rule; KWasm does not have
 *    one, and neither does any semantics whose parametric axioms all come from
 *    `domains.md`'s `#Ceil` simplifications.  That fixture has since been
 *    written — `fixtures/parametric.k` and `test/parametric-conformance.test.ts`
 *    — and it confirms this diagnosis twice over: the branches do fire there,
 *    and they fire on an *instantiated* parameterised sort (`SortMInt{Sort32{}}`,
 *    which `sortName` rejects for having sort arguments at all), never on a sort
 *    *variable*, because `kompile` monomorphizes every plain rule it emits.
 *
 * 2. *The collection-hook matchers stay fixture-only.*  All 605 retained
 *    equations together produce 12 `eq` matchers and 6 `subsort` matchers and
 *    **zero** `list`/`set`/`map`/`empty-*` matchers, and neither emitted module
 *    mentions `ListHook`, `SetHook` or `MapHook`.  KWasm's nine collection sorts
 *    are reached, but only through hook symbols that have no equations at all
 *    (`Lbl'Stop'Map`, `LblMap'Coln'lookup`, …), which are axiomatized whole; no
 *    *user-written* function in the configuration-reachable slice matches on
 *    `K |-> V M` or `ListItem(H) L`.  `fixtures/matchers.k` remains the only
 *    thing in this repository that covers `matchers.ts:270-339`, and this soak
 *    is evidence that a bigger corpus is not the way to replace it.
 */

import { describe, expect, test } from "bun:test";
import { join } from "node:path";

import { ATT_SIMPLIFICATION, classifyAxiom, collect, hasAtt, type Pattern } from "@kframework-ts/kore";
import { WASM_CENSUS, WASM_SOAK_ENV, envDir, wasmSoakDir } from "@kframework-ts/wasm-fixtures";

import { analyzeKleanDefinition } from "../src/analysis.js";
import { generateKleanProject } from "../src/generate.js";
import { functionRuleMatchers, type MatcherDefinition } from "../src/matchers.js";
import { sourceFromKoreText } from "../src/source.js";
import { structureFields, structureSymbols } from "../src/sorts.js";

const soakDir = wasmSoakDir();
const koreText = soakDir === undefined ? undefined : await Bun.file(join(soakDir, "definition.kore")).text();
const describeSoak = koreText === undefined ? describe.skip : describe;

/** The generation under test, run once and reused; a second run is compared against it below. */
const project =
  koreText === undefined
    ? undefined
    : generateKleanProject(sourceFromKoreText(koreText), { packageName: "wasm", libraryName: "Wasm" });

/** Entries of a census map, lexical by key, so an assertion can be a literal. */
function tally(census: ReadonlyMap<string, number>): readonly (readonly [string, number])[] {
  return [...census].toSorted(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
}

function diagnosticCensus(): ReadonlyMap<string, number> {
  const census = new Map<string, number>();
  for (const diagnostic of project!.diagnostics) {
    const key = `${diagnostic.severity}/${diagnostic.code}`;
    census.set(key, (census.get(key) ?? 0) + 1);
  }
  return new Map(tally(census));
}

describe("the opt-in is wired the way the other soaks are", () => {
  test("no soak directory means no soak, and that is not a failure", () => {
    // The one assertion that runs in the default suite. `wasmSoakDir` is the
    // only thing that decides, and an explicit `KFRAMEWORK_TS_WASM_KOMPILED`
    // always wins over the cache — the half of the contract that is checkable
    // without a K install.
    expect(wasmSoakDir()).toBe(soakDir);
    expect(koreText === undefined).toBe(soakDir === undefined);
    expect(project === undefined).toBe(soakDir === undefined);
    const explicit = envDir(WASM_SOAK_ENV);
    if (explicit !== undefined) expect(soakDir).toBe(explicit);
  });
});

describeSoak("generation over KWasm's definition.kore", () => {
  test("the input is the build the other soaks pin", () => {
    // Not `WASM_DEFINITION_HASH`: that is a hash of the *KAST* definition and
    // computing it needs `@kframework-ts/kast`, which this package does not
    // depend on. The KORE index census is the same guard reached through the
    // route KLean actually uses, and `packages/kompiled`'s soak asserts the
    // identical three numbers against the identical directory, so a directory
    // from another K release cannot quietly weaken this file either.
    const index = sourceFromKoreText(koreText!).index;
    expect(koreText!.length).toBe(5_314_140);
    expect(index.axioms.length).toBe(6824);
    expect(index.sorts.size).toBe(302);
    expect(index.symbols.size).toBe(1732);
    expect(index.sorts.size).toBe(WASM_CENSUS.productionSorts);
  });

  test("generation completes, emits the whole module graph, and does not throw", () => {
    expect([...project!.files.keys()]).toEqual([
      "Wasm.lean",
      "Wasm/Prelude.lean",
      "Wasm/Sorts.lean",
      "Wasm/Inj.lean",
      "Wasm/Func.lean",
      "Wasm/Rewrite.lean",
      "lakefile.toml",
      "lean-toolchain",
    ]);
    // 876 KB of Lean. Bounded rather than pinned exactly: the point is the order
    // of magnitude — this is 30x the IMP project — not the byte count, which
    // moves with every Prelude edit.
    const bytes = [...project!.files.values()].reduce((total, text) => total + text.length, 0);
    expect(bytes).toBeGreaterThan(800_000);
    expect(bytes).toBeLessThan(1_200_000);
  });

  test("generation is deterministic, byte for byte", () => {
    // Parsed again from the same text rather than reusing the source, so the
    // memoised lazy-axiom cache cannot be what makes the two runs agree.
    const again = generateKleanProject(sourceFromKoreText(koreText!), { packageName: "wasm", libraryName: "Wasm" });
    expect([...again.files.keys()]).toEqual([...project!.files.keys()]);
    for (const [name, text] of project!.files) expect(again.files.get(name)).toBe(text);
    expect(again.manifest).toEqual(project!.manifest);
    expect(again.diagnostics).toEqual(project!.diagnostics);
  });

  test("how much of KWasm KLean lowers, and how much it axiomatizes", () => {
    const manifest = project!.manifest;
    // The configuration-reachable slice, not the whole definition: 743 of 1732
    // symbols and 206 of 302 sorts survive projection from `SortGeneratedTopCell`.
    expect(manifest.emittedSorts).toHaveLength(206);
    expect(manifest.emittedSymbols).toHaveLength(743);
    // Every top-level rewrite in the definition is selected (KWasm's 2062 K
    // rules are 201 rewrites, 1383 equations, 328 `owise` equations and 87
    // simplifications once KORE has classified them), and 605 of those equations
    // are reachable from the projected functions.
    expect(manifest.emittedRewrites).toHaveLength(201);
    expect(manifest.emittedFunctionEquations).toHaveLength(605);
    // 84 axiomatized functions: 81 with no equation at all (the collection and
    // Int/Bytes hooks the Prelude leaves open) plus the 3 whose equations did
    // not lower — see the diagnostic census below.
    expect(manifest.axiomaticFunctions).toHaveLength(84);
    expect(manifest.axiomaticFunctions).toContain("Lbl'Stop'Map");
    expect(manifest.axiomaticFunctions).toContain("LblMap'Coln'lookup");
  });

  test("the emitted Lean has the shape those counts imply", () => {
    const sorts = project!.files.get("Wasm/Sorts.lean")!;
    const functions = project!.files.get("Wasm/Func.lean")!;
    const rewrites = project!.files.get("Wasm/Rewrite.lean")!;
    expect([...sorts.matchAll(/^\s*inductive /gmu)]).toHaveLength(114);
    expect([...sorts.matchAll(/^\s*structure /gmu)]).toHaveLength(84);
    expect([...functions.matchAll(/^axiom /gmu)]).toHaveLength(84);
    expect([...functions.matchAll(/^\s*def /gmu)]).toHaveLength(382);
    // 201 constructors: the `tran` transitivity constructor plus 200 of the 201
    // selected rewrites. The missing one is the single lowering failure pinned
    // in the next test.
    const constructors = [...rewrites.matchAll(/^ {2}\| (\S+)/gmu)].map((match) => match[1]);
    expect(constructors).toHaveLength(201);
    expect(new Set(constructors).size).toBe(201);
    expect(constructors[0]).toBe("tran");
  });

  test("every omission is reported, and there are exactly 21 of them", () => {
    expect([...diagnosticCensus()]).toEqual([
      ["error/unsupported-domain-value", 18],
      ["warning/axiomatic-function", 3],
    ]);

    // Two builtin token sorts `renderDomainValue` has no Lean spelling for.
    // Every one of the 21 diagnostics traces back to one of them.
    const bySort = new Map<string, number>();
    for (const diagnostic of project!.diagnostics)
      if (diagnostic.code === "unsupported-domain-value")
        bySort.set(diagnostic.message, (bySort.get(diagnostic.message) ?? 0) + 1);
    expect(tally(bySort)).toEqual([
      ["unsupported domain value sort: SortFloat", 4],
      ["unsupported domain value sort: SortWasmStringToken", 14],
    ]);

    // Three functions degrade from definition to axiom, and they are named
    // rather than counted so that a regression here is legible.
    expect(project!.diagnostics.filter((d) => d.code === "axiomatic-function").map((d) => d.symbol)).toEqual([
      "Lbl'Hash'spectestModule'Unds'WASM-TEST'Unds'ModuleDecl",
      "Lbl'Hash'zero'LParUndsRParUnds'WASM-DATA-COMMON'Unds'ValStack'Unds'ValTypes",
      "LblfloatUnOp",
    ]);

    // Exactly one *rewrite* fails to lower — rewrite diagnostics carry
    // `label`/`uid` and no `symbol`, which is how they are told apart.
    expect(project!.diagnostics.filter((d) => d.symbol === undefined)).toEqual([
      {
        severity: "error",
        code: "unsupported-domain-value",
        message: "unsupported domain value sort: SortWasmStringToken",
        label: "WASM-TEST.initSpectestModule",
        uid: "d0c12a07af75eee32de10f37489c50360610abb3375ce0f5944fd63e8a55a0a1",
      },
    ]);
  });
});

describeSoak("finding: the parametric-sort branches stay dead, and not for want of corpus", () => {
  test("no generated diagnostic comes from lower.ts:71 or lower.ts:129", () => {
    // The negative pin, and it stays negative: `fixtures/parametric.k` is where
    // those branches are exercised positively. If a future *KWasm build* ever
    // reaches them, this is the assertion that will say so, and this file's
    // header should then be rewritten rather than the expectation loosened.
    const parametric = project!.diagnostics.filter((diagnostic) => diagnostic.message.includes("parametric"));
    expect(parametric).toEqual([]);
  });

  test("the definition has no `\\dv` at a non-ground sort at all", () => {
    // `lower.ts:129` fires only for a domain value whose sort is a sort variable
    // or a sort application with arguments. KWasm has none anywhere in 6824
    // axioms, projected or not, so no rule selection could reach that branch.
    const source = sourceFromKoreText(koreText!);
    const counts = { parametricDomainValues: 0, parametricInjections: 0 };
    const visit = (node: Pattern): void => {
      if (node.tag === "DV" && (node.sort.tag !== "SortApp" || node.sort.sorts.length > 0))
        counts.parametricDomainValues += 1;
      if (
        node.tag === "App" &&
        node.symbol === "inj" &&
        node.sorts.some((sort) => sort.tag !== "SortApp" || sort.sorts.length > 0)
      )
        counts.parametricInjections += 1;
    };
    for (const lazy of source.index.axioms) collect(source.forceAxiom(lazy).pattern, visit);
    const { parametricDomainValues, parametricInjections } = counts;
    expect(parametricDomainValues).toBe(0);
    // `lower.ts:71` has exactly three candidate occurrences in the whole file,
    // and all three are inside one axiom: the sort-injection transitivity
    // simplification `inj{S1,S2}(inj{S2,S3}(X)) = inj{S1,S3}(X)`.
    expect(parametricInjections).toBe(3);
  });

  test("every sort-parametric axiom carries an attribute the projection filters first", () => {
    const source = sourceFromKoreText(koreText!);
    let simplification = 0;
    const other: string[] = [];
    for (const lazy of source.index.axioms) {
      const axiom = source.forceAxiom(lazy);
      if (axiom.vars.length <= 1) continue;
      if (hasAtt(axiom.attrs, ATT_SIMPLIFICATION)) simplification += 1;
      else other.push(classifyAxiom(axiom).kind);
    }
    // 44 sort-parametric axioms; 42 `simplification` (the `#Ceil{_, #SortParam}`
    // family from `domains.md` plus KWasm's own `#signed`/`#unsigned` ones) and
    // 2 `functional` totality axioms for the genuinely parameterised sort
    // `SortMInt{SortWidth}`. `simplification` and `functional` are both in
    // `DEFINITELY_NON_RULE_ATTRIBUTES` (`src/projection.ts:310-320`), so none of
    // the 44 is ever forced into a rewrite or an equation.
    expect(simplification).toBe(42);
    expect(other).toEqual(["functional", "functional"]);
  });
});

describeSoak("finding: the collection-hook matchers are not reached either", () => {
  test("605 retained equations produce 12 `eq` and 6 `subsort` matchers and nothing else", () => {
    const definition = analyzeKleanDefinition(sourceFromKoreText(koreText!));
    // The same `MatcherDefinition` `generateFunctions` builds
    // (`src/functions.ts:421-429`), so this census is what the emitter saw.
    const lowering: MatcherDefinition = {
      ...definition,
      structureSymbols: structureSymbols(definition),
      structures: structureFields(definition),
    };
    const census = new Map<string, number>();
    let equations = 0;
    for (const [, rules] of definition.equations) {
      for (const equation of rules) {
        equations += 1;
        for (const matcher of functionRuleMatchers(lowering, equation.rule.lhs).generations.flat())
          census.set(matcher.tag, (census.get(matcher.tag) ?? 0) + 1);
      }
    }
    expect(equations).toBe(605);
    expect(tally(census)).toEqual([
      ["eq", 12],
      ["subsort", 6],
    ]);
  });

  test("the emitted modules never mention ListHook, SetHook or MapHook", () => {
    // KWasm reaches nine collection sorts, but only through hook symbols with no
    // equations, which are axiomatized whole rather than matched on.
    const definition = analyzeKleanDefinition(sourceFromKoreText(koreText!));
    expect([...definition.collections.keys()]).toEqual([
      "SortElemInstCellMap",
      "SortFuncDefCellMap",
      "SortGlobalInstCellMap",
      "SortListInt",
      "SortListRef",
      "SortMap",
      "SortMemInstCellMap",
      "SortModuleInstCellMap",
      "SortTabInstCellMap",
    ]);
    for (const name of ["Wasm/Func.lean", "Wasm/Rewrite.lean"]) {
      const text = project!.files.get(name)!;
      for (const hook of ["ListHook", "SetHook", "MapHook"]) expect(text).not.toContain(hook);
    }
  });
});
