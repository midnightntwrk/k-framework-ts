/**
 * KWasm's `definition.kore` against this package's **own** reader, writer,
 * injector and symbol table — opt-in, and skipped by default.
 *
 * Everything else in `test/` reads `fixtures/definitions/`, whose largest entry
 * is `a-to-f.definition.kore` at 94 KB.  That is enough to check the grammar and
 * it is not enough to check anything about *scale*: `lazyAxioms` was written for
 * "a real `definition.kore` is 15–71 MB" (`src/parser.ts:176-178`) and has never
 * been shown one, `src/inject.ts` has only ever walked hand-written terms, and
 * `src/symbols.ts` has only ever resolved against a 40-sort lattice.  This file
 * points all four at 5 314 140 bytes of real semantics: 6824 axioms, 302 sorts,
 * 1732 symbols, 3667 injections already in place, 12 parametric symbols, 11
 * collection sorts and 224 hooked symbols.
 *
 * ## Why the bytes are not vendored, in this package specifically
 *
 * `fixtures/PROVENANCE.md:82-84` already decided this question, for the same
 * kind of file: pyk's own 15 MB `test-data/definition.kore` is listed under
 * *deliberately not vendored* — "benchmark material, fetched on demand from the
 * checkout, never committed".  An env-gated soak that vendors nothing is that
 * policy applied rather than an exception to it; the only difference is that the
 * artifact is fetched by `kompile` instead of by `curl`, and that the recipe
 * lives in one place with a builder beside it
 * (`packages/wasm-fixtures/fixtures/PROVENANCE.md`):
 *
 * ```sh
 * KFRAMEWORK_TS_K_BIN=…/k-7.1.337/bin \
 * KFRAMEWORK_TS_RV_CHECKOUTS=…/runtimeverification \
 *   bun run --cwd packages/wasm-fixtures kompile-soak
 * ```
 *
 * After that `wasmSoakDir()` finds the build in its content-keyed cache with no
 * variable set at all; `KFRAMEWORK_TS_WASM_KOMPILED` still overrides it with an
 * explicit path.  Without either, everything below skips and `bun test` keeps
 * its promise: no K install, no network, nothing outside the repository.
 *
 * ## What this file deliberately does not repeat
 *
 * `packages/kompiled/test/wasm-soak.test.ts` reaches the same bytes through
 * `loadKompiledDefinition` and already pins: 6824 axioms all `LazyAxiom`, 302
 * sorts, 1732 symbols, that forcing **one** body preserves its attributes, the
 * `macros.kore` ↔ `definition.kore` id partition, the near-total
 * `definition.kore` → `compiled.json` join, and `syntaxDefinition.kore` as a
 * bracket-superset.  None of that is repeated here except the three census
 * numbers, which are the cross-check that both files are looking at the same
 * build (`packages/klean`'s soak makes the same argument for the same reason).
 *
 * The lazy-axiom angle *is* here, because kompiled's is a different claim:
 * it forces one body.  This file forces all 6824 and requires the result to be
 * the eager parse, which is the equivalence `parseDefinition`'s two modes assert
 * about each other and which no fixture in this repository is big enough to make
 * interesting.
 *
 * `syntaxDefinition.kore` is not read here at all: the questions it answers are
 * about the *difference* between two files, kompiled's soak asks them, and
 * asking them again through a second loader would be the duplication above.
 *
 * ## The findings, recorded as assertions
 *
 * 1. **`addInjections`' default sort is wrong for an axiom body, and pyk's is
 *    too.**  `addInjections(index, body)` wraps every one of the 6824 bodies in
 *    `inj{…, SortK{}}(…)` — 6824 injections added to a definition that has 3667
 *    — because `isSubsort` answers "everything is a subsort of `SortK{}`"
 *    unconditionally (`src/definition.ts:598-606`, pyk `kompiled.py:234-235`),
 *    *including* a sort variable, and 3432 of the bodies are sorted at the
 *    variable `R`.  Called at the body's own sort it is exactly the identity on
 *    all 6824.  Both are pinned below; neither is a divergence from pyk, and the
 *    default is documented at `src/inject.ts:96-100` — this is the first corpus
 *    at which the sharp edge is visible rather than theoretical.
 * 2. **Nothing misbehaves at scale, and the reason is not that the corpus is
 *    demanding.**  KWasm's deepest axiom body is 50 levels and its widest node
 *    has 299 children, so the iterative walkers in `parser.ts`, `syntax.ts`,
 *    `inject.ts` and `manip.ts` are *not* what this corpus proves; a recursive
 *    implementation would have survived it too.  Pinned as a measurement so the
 *    next reader does not mistake a green soak for evidence about recursion
 *    depth.  Throughput is linear-ish and unremarkable: 13.4 MB/s at 94 KB and
 *    19.4 MB/s at 5.3 MB, so nothing here is quadratic in the file size.
 * 3. **The writer does not reproduce `kompile`'s bytes, and the round trip is
 *    still a fixed point.**  `koreText` prints 3 853 018 bytes where K wrote
 *    5 314 140 — the difference is layout (45 144 fewer newlines, 298 502 fewer
 *    spaces) — and reparsing that gives back an AST equal to the first, which
 *    reprints byte for byte. This is 56× the largest focused definition fixture.
 */

import { describe, expect, test } from "bun:test";
import { join } from "node:path";

import { WASM_CENSUS, WASM_SOAK_ENV, envDir, wasmSoakDir } from "@kframework-ts/wasm-fixtures";

import {
  ATT_SYMBOL_OVERLOAD,
  attSymbols,
  classifyAxioms,
  collectionInfo,
  hasAtt,
  indexDefinition,
  subsorts,
  symbolHook,
} from "../src/definition.ts";
import { addInjections } from "../src/inject.ts";
import { forceAxiom, parseDefinition } from "../src/parser.ts";
import { SORT_K } from "../src/prelude.ts";
import { inferSort, patternSorts, resolveSymbol } from "../src/symbols.ts";
import { collect, koreText, type Pattern, patterns, sortApp } from "../src/syntax.ts";

const soakDir = wasmSoakDir();
const text = soakDir === undefined ? undefined : await Bun.file(join(soakDir, "definition.kore")).text();
/** The eager parse, made once: 165–275 ms, and every block below reuses it. */
const index = text === undefined ? undefined : indexDefinition(parseDefinition(text));
const describeSoak = index === undefined ? describe.skip : describe;

/** How many `inj{…}(…)` applications sit anywhere inside `pattern`. */
function injections(pattern: Pattern): number {
  let found = 0;
  collect(pattern, (node) => {
    if (node.tag === "App" && node.symbol === "inj") found += 1;
  });
  return found;
}

/** How many times `needle` occurs in `haystack`. */
function occurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

/** Entries of a census map, lexical by key, so an assertion can be a literal. */
function tally(census: ReadonlyMap<string, number>): readonly (readonly [string, number])[] {
  return [...census].toSorted(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
}

/** `symbol-overload{}(overloaded, overloader)` pairs, in definition order. */
function overloadPairs(): readonly (readonly string[])[] {
  return index!.axioms
    .filter((axiom) => hasAtt(axiom.attrs, ATT_SYMBOL_OVERLOAD))
    .map((axiom) => attSymbols(axiom.attrs, ATT_SYMBOL_OVERLOAD));
}

/** A symbol's signature as one readable string, or `"undefined"`. */
function signature(symbol: string, sorts: readonly ReturnType<typeof sortApp>[] = []): string {
  const resolved = resolveSymbol(index!, symbol, sorts);
  if (resolved === undefined) return "undefined";
  return `(${resolved.paramSorts.map(koreText).join(", ")}) : ${koreText(resolved.sort)}`;
}

describe("the opt-in is wired the way the other soaks are", () => {
  test("no soak directory means no soak, and that is not a failure", () => {
    // The one assertion that runs in the default suite: it pins the contract
    // that this file is inert without a build, so a future reader does not have
    // to infer it from `describe.skip`.  `wasmSoakDir` is the only thing that
    // decides, and an explicit `KFRAMEWORK_TS_WASM_KOMPILED` always wins over
    // the cache — the half of the contract checkable without a K install.
    expect(wasmSoakDir()).toBe(soakDir);
    expect(text === undefined).toBe(soakDir === undefined);
    expect(index === undefined).toBe(soakDir === undefined);
    const explicit = envDir(WASM_SOAK_ENV);
    if (explicit !== undefined) expect(soakDir).toBe(explicit);
  });
});

describeSoak("parsing definition.kore with this package's parser", () => {
  test("it parses, and the census says it is the build the other soaks pin", () => {
    // `packages/kompiled`'s soak asserts the same three numbers against the same
    // directory through its own loader, and `packages/klean`'s asserts them
    // through `sourceFromKoreText`.  Repeated here — and only these three — so a
    // directory built from another K release cannot quietly weaken this file
    // either.  `productionSorts` is the join to the *KAST* census, measured from
    // a `compiled.json` this package never reads.
    expect(text!.length).toBe(5_314_140);
    expect(index!.axioms.length).toBe(6824);
    expect(index!.sorts.size).toBe(302);
    expect(index!.symbols.size).toBe(1732);
    expect(index!.sorts.size).toBe(WASM_CENSUS.productionSorts);

    // The rest of the index, which nothing else pins: `kompile` flattens the
    // frontend's 99 modules into five — the four of `prelude.kore` plus one
    // holding all 8850 remaining sentences — and the three aliases are the LTL
    // operators `prelude.kore`'s `K` module declares, which this repository has
    // as a 1.9 KB fixture and has never seen attached to a real definition.
    expect(index!.moduleNames).toEqual(["BASIC-K", "KSEQ", "INJ", "K", "WASM-TEST"]);
    expect(index!.claims.length).toBe(0);
    expect(index!.imports.length).toBe(4);
    expect([...index!.aliases.keys()]).toEqual(["weakExistsFinally", "weakAlwaysFinally", "allPathGlobally"]);
  });

  test("classifyAxiom sorts all 6824 into the twelve kinds it knows", () => {
    // `classifyAxiom` is exercised on IMP-sized definitions elsewhere; this is
    // the shape of a real one, and it is worth writing down that the semantic
    // rules (201 rewrites, 1383 equations) are 23 % of the file — the other
    // 5240 axioms are the sort lattice and the constructor theory `kompile`
    // derives.  A sum check keeps the twelve numbers honest.
    const census = tally(classifyAxioms(index!.axioms));
    expect(census).toEqual([
      ["assoc", 11],
      ["equation", 1383],
      ["functional", 1153],
      ["idem", 1],
      ["no-confusion", 2897],
      ["no-junk", 294],
      ["overload", 10],
      ["owise", 328],
      ["rewrite", 201],
      ["simplification", 87],
      ["subsort", 437],
      ["unit", 22],
    ]);
    expect(census.reduce((sum, [, n]) => sum + n, 0)).toBe(6824);
  });

  test("the ten symbol-overload axioms flatten the KAST census's six overloaded symbols", () => {
    // A cross-artifact join available from the KORE side alone.  `WASM_CENSUS`
    // measures `KDefinition.overloads` — a map from an overloaded symbol to the
    // set of its overloaders, so six *keys* — while `ModuleToKORE` emits one
    // axiom per (key, member) pair.  Ten pairs over eight distinct symbols is
    // what those six keys unfold to, and no fixture smaller than this has an
    // overload at all (`empty` and `a-to-f` have none).
    const pairs = overloadPairs();
    expect(pairs.length).toBe(10);
    expect(new Set(pairs.map((pair) => pair[0])).size).toBe(WASM_CENSUS.overloads);
    expect(WASM_CENSUS.overloads).toBe(6);
    expect(new Set(pairs.flat()).size).toBe(8);
  });

  /**
   * A ceiling, not a benchmark.  Parse + print + reparse measures 0.5–0.8 s on
   * the machine this was written on; 20 s is ~30× that, wide enough that CI
   * noise cannot reach it and narrow enough that an accidentally quadratic
   * lexer or writer cannot hide under it.  Measured throughput for the record:
   * 13.4 MB/s at 94 KB (`a-to-f`) and 19.4 MB/s at 5.3 MB, i.e. no degradation
   * over a 56× size increase.
   */
  test("parsing, printing and reparsing 5.3 MB stays well under 20 s", () => {
    const started = performance.now();
    const printed = koreText(parseDefinition(text!));
    const reparsed = parseDefinition(printed);
    const elapsed = performance.now() - started;
    expect(reparsed.modules.length).toBe(5);
    expect(elapsed).toBeLessThan(20_000);
  });
});

describeSoak("the text round trip is a fixed point at 5.3 MB", () => {
  test("print, reparse, reprint — the AST comes back equal and the text byte-identical", () => {
    // The single highest-value assertion in this file.  `test/parser.test.ts`'s
    // `roundTrips` helper closes the parser and the writer over each other at
    // 94 KB; this is the same claim, stated the same way (`toEqual` on the AST),
    // over 56× the bytes and every construct a real semantics contains —
    // 98 726 subterms, `\left-assoc` sugar, mangled symbol names, escaped
    // `Source`/`Location` strings, sort-parametric symbols and 3667 injections.
    const printed = koreText(index!.definition);
    const reparsed = parseDefinition(printed);
    expect(reparsed).toEqual(index!.definition);
    expect(koreText(reparsed)).toBe(printed);
  });

  test("the writer's bytes are not kompile's bytes, and the difference is layout", () => {
    // Recorded rather than asserted away: `koreText` is a single-line writer,
    // `ModuleToKORE` indents.  Pinning the printed size makes an accidental
    // change to the writer's spacing visible here, where it is one number, and
    // the newline/space deltas say what the 1.46 MB actually is.
    const printed = koreText(index!.definition);
    expect(printed.length).toBe(3_853_018);
    expect(printed).not.toBe(text!);
    expect(occurrences(text!, "\n") - occurrences(printed, "\n")).toBe(45_144);
    expect(occurrences(text!, " ") - occurrences(printed, " ")).toBe(298_502);
  });
});

describeSoak("addInjections over the whole definition", () => {
  test("at each body's own sort it is exactly the identity, 6824 times", () => {
    // `kompile` emits well-sorted KORE, so the honest oracle for `addInjections`
    // at this scale is idempotence: placing an already-well-sorted body at the
    // sort it already has must change nothing.  It does not — no throw, no
    // rewrite, and not one injection added to the 3667 already there — across
    // 98 726 subterms, which is the first time this function has walked a term
    // it did not have a hand-written expectation for.
    let identical = 0;
    let before = 0;
    let after = 0;
    for (const axiom of index!.axioms) {
      const sort = inferSort(index!, axiom.pattern);
      // A throw rather than a non-null assertion: if a body ever has no
      // inferable sort, the failure should name it rather than silently fall
      // back to `addInjections`' `SortK{}` default and assert something else.
      if (sort === undefined) throw new Error(`no inferable sort: ${koreText(axiom.pattern).slice(0, 200)}`);
      const injected = addInjections(index!, axiom.pattern, sort);
      if (koreText(injected) === koreText(axiom.pattern)) identical += 1;
      before += injections(axiom.pattern);
      after += injections(injected);
    }
    expect(identical).toBe(6824);
    expect(before).toBe(3667);
    expect(after).toBe(before);
  });

  test("it is deterministic: two runs over 6824 bodies agree byte for byte", () => {
    const run = (): string =>
      index!.axioms.map((axiom) => koreText(addInjections(index!, axiom.pattern, SORT_K))).join("\n");
    expect(run()).toBe(run());
  });

  test("finding: the default sort injects every body into SortK, sort variables included", () => {
    // See finding 1 in this file's header.  `addInjections`' default is pyk's
    // (`kompiled.py:122-123`), and `isSubsort` returns true for *any* `sort2 ===
    // SortK{}` (`src/definition.ts:602-605`, pyk `kompiled.py:234-235`) — so the
    // default wraps a body whose sort is the axiom's sort *variable* `R` in
    // `inj{R, SortK{}}(…)`, which is well-formed KORE and is not what anyone
    // means by "add the injections this axiom needs".  Pinned, not fixed: the
    // reference does the same thing, and `src/inject.ts:96-100` already tells
    // callers to pass the sort they actually want.
    let rootWrapped = 0;
    let sortVarRooted = 0;
    let after = 0;
    for (const axiom of index!.axioms) {
      const injected = addInjections(index!, axiom.pattern, SORT_K);
      after += injections(injected);
      if (injected.tag === "App" && injected.symbol === "inj" && koreText(injected.sorts[1]!) === "SortK{}") {
        rootWrapped += 1;
      }
      if (inferSort(index!, axiom.pattern)?.tag === "SortVar") sortVarRooted += 1;
    }
    expect(rootWrapped).toBe(6824);
    expect(after).toBe(3667 + 6824);
    expect(sortVarRooted).toBe(3432);
  });
});

describeSoak("the symbol table at 1732 symbols", () => {
  test("resolveSymbol answers the parameterless, the parametric and the hooked", () => {
    // Spot pins, each chosen for a branch of `resolveSymbol`.  `kseq`/`dotk`:
    // the prelude, parameterless.  `inj`: the one symbol every definition
    // parametrises, and the arity check that makes a wrong sort-argument count
    // `undefined` rather than a wrong answer.  `Lblite`: a *second* parametric
    // symbol, which no fixture in `fixtures/definitions/` has — KWasm has
    // twelve, eleven of them from `domains.md`'s `MInt`/`Bytes` hooks.
    expect(signature("kseq")).toBe("(SortKItem{}, SortK{}) : SortK{}");
    expect(signature("dotk")).toBe("() : SortK{}");
    expect(signature("inj")).toBe("undefined");
    expect(signature("inj", [sortApp("SortInt"), sortApp("SortKItem")])).toBe("(SortInt{}) : SortKItem{}");
    expect(signature("Lblite", [sortApp("SortInt")])).toBe("(SortBool{}, SortInt{}, SortInt{}) : SortInt{}");
    expect([...index!.symbols.values()].filter((decl) => decl.symbol.vars.length > 0)).toHaveLength(12);
  });

  test("resolveSymbol answers both halves of a real overload pair", () => {
    // The overloading is on the *sorts*, which is the whole point and the thing
    // a 40-sort fixture cannot show: `Stmts ::= Stmt Stmts` and
    // `Instrs ::= Instr Instrs` are the same production at two points of the
    // lattice, and `symbol-overload` relates them.
    const stmts = "Lbl'UndsUndsUnds'WASM-COMMON-SYNTAX'Unds'Stmts'Unds'Stmt'Unds'Stmts";
    const instrs = "Lbl'UndsUndsUnds'WASM-COMMON-SYNTAX'Unds'Instrs'Unds'Instr'Unds'Instrs";
    expect(overloadPairs()).toContainEqual([stmts, instrs]);
    expect(signature(stmts)).toBe("(SortStmt{}, SortStmts{}) : SortStmts{}");
    expect(signature(instrs)).toBe("(SortInstr{}, SortInstrs{}) : SortInstrs{}");
  });

  test("the collection hooks resolve, all eleven of them", () => {
    // `collectionInfo` has never seen a definition with cell maps: `a-to-f` has
    // `Map`, `Set` and `List` and nothing else, while KWasm's configuration
    // generates six `…CellMap` sorts on top of the five `domains.md` ones, each
    // with its own element/concat/unit triple.
    const collections = [...index!.sorts.entries()]
      .map(([name, decl]) => [name, collectionInfo(decl)] as const)
      .filter(([, info]) => info !== undefined);
    expect(collections).toHaveLength(11);
    expect(collections.filter(([, info]) => info!.kind === "Map")).toHaveLength(7);
    expect(collections.filter(([, info]) => info!.kind === "List")).toHaveLength(3);
    expect(collections.filter(([, info]) => info!.kind === "Set")).toHaveLength(1);

    const map = index!.sorts.get("SortMap")!;
    expect(collectionInfo(map)).toEqual({
      element: "Lbl'UndsPipe'-'-GT-Unds'",
      concat: "Lbl'Unds'Map'Unds'",
      unit: "Lbl'Stop'Map",
      hook: "MAP.Map",
      kind: "Map",
    });
    // …and the three symbols that triple names all resolve, which is what makes
    // it usable rather than merely present.
    expect(signature("Lbl'UndsPipe'-'-GT-Unds'")).toBe("(SortKItem{}, SortKItem{}) : SortMap{}");
    expect(signature("Lbl'Unds'Map'Unds'")).toBe("(SortMap{}, SortMap{}) : SortMap{}");
    expect(signature("Lbl'Stop'Map")).toBe("() : SortMap{}");
    expect(signature("LblMap'Coln'lookup")).toBe("(SortMap{}, SortKItem{}) : SortKItem{}");
  });

  test("the hook census: 224 hooked symbols over nine namespaces, and 17 hooked sorts", () => {
    const namespaces = new Map<string, number>();
    let hooked = 0;
    for (const decl of index!.symbols.values()) {
      const hook = symbolHook(decl);
      if (hook === undefined) continue;
      hooked += 1;
      const namespace = hook.split(".")[0]!;
      namespaces.set(namespace, (namespaces.get(namespace) ?? 0) + 1);
    }
    expect(hooked).toBe(224);
    expect(tally(namespaces)).toEqual([
      ["BOOL", 9],
      ["BYTES", 25],
      ["FLOAT", 38],
      ["INT", 29],
      ["KEQUAL", 3],
      ["LIST", 37],
      ["MAP", 41],
      ["SET", 10],
      ["STRING", 32],
    ]);
    expect([...index!.sorts.values()].filter((decl) => decl.hooked)).toHaveLength(17);
  });

  test("the sort lattice: 298 of the 302 sorts inject into SortKItem", () => {
    // `subsorts` on the real thing, where `a-to-f` has 40 sorts.  The four sorts
    // that are *not* `KItem` subsorts are worth naming: `SortK` and `SortKItem`
    // themselves (the relation is the proper, non-reflexive one), and
    // `Sort'Hash'Layout` and `SortMInt`, the two `domains.md` sorts with no
    // `KItem` production at all.
    const below = new Set(subsorts(index!, sortApp("SortKItem")).map((sort) => koreText(sort)));
    expect(below.size).toBe(298);
    expect([...index!.sorts.keys()].filter((name) => !below.has(`${name}{}`))).toEqual([
      "SortK",
      "SortKItem",
      "Sort'Hash'Layout",
      "SortMInt",
    ]);
    // …and a leaf of the lattice, for the other direction.
    expect(subsorts(index!, sortApp("SortInt"))).toHaveLength(0);
  });

  test("patternSorts is total and parallel over all 98 726 subterms", () => {
    // pyk closes `pattern_sorts` with `assert len(sorts) == len(pattern.patterns)`
    // (`kompiled.py:330`); `src/symbols.ts` makes that the contract and answers
    // `undefined` where it cannot hold.  Over a real definition it never has to:
    // every subterm has an inferable sort and a parallel argument-sort list,
    // including the `\left-assoc` sugar and the 299-child node found below.
    let subterms = 0;
    let unanswered = 0;
    let mismatched = 0;
    let unsorted = 0;
    const visit = (node: Pattern): void => {
      subterms += 1;
      const sorts = patternSorts(index!, node);
      if (sorts === undefined) unanswered += 1;
      else if (sorts.length !== patterns(node).length) mismatched += 1;
      if (inferSort(index!, node) === undefined) unsorted += 1;
    };
    for (const axiom of index!.axioms) collect(axiom.pattern, visit);
    expect(subterms).toBe(98_726);
    expect(unanswered).toBe(0);
    expect(mismatched).toBe(0);
    expect(unsorted).toBe(0);
  });
});

describeSoak("lazyAxioms, forced all the way back to the eager parse", () => {
  test("a lazy parse of 5.3 MB leaves all 6824 bodies unread, and forcing them gives the eager parse", () => {
    // kompiled's soak forces *one* body and checks its attributes survived.
    // This is the other claim, the one `parseDefinition`'s two modes make about
    // each other: forcing every body reconstructs the eager parse exactly.  The
    // fixtures make it at 726 axioms; at 6824, over spans into a 5.3 MB string,
    // it is a check that the offsets stay right when the text is large enough
    // for an off-by-one to be somewhere other than the file's first kilobyte.
    const lazy = indexDefinition(parseDefinition(text!, { lazyAxioms: true }));
    expect(lazy.axioms).toHaveLength(6824);
    expect(lazy.axioms.every((axiom) => axiom.tag === "LazyAxiom")).toBe(true);

    let compared = 0;
    for (const [i, lazyAxiom] of lazy.axioms.entries()) {
      if (lazyAxiom.tag !== "LazyAxiom") continue;
      const eager = index!.axioms[i]!;
      const forced = forceAxiom(text!, lazyAxiom);
      expect(koreText(forced)).toBe(koreText(eager));
      compared += 1;
    }
    expect(compared).toBe(6824);
  });

  test("the lazy index and the eager index are the same tables", () => {
    // The claim `src/definition.ts:378-385` makes — indexing reads attributes,
    // never bodies, so the two parses index identically — checked where it
    // matters, on a definition whose subsort table is built from 437 axioms.
    const lazy = indexDefinition(parseDefinition(text!, { lazyAxioms: true }));
    expect([...lazy.sorts.keys()]).toEqual([...index!.sorts.keys()]);
    expect([...lazy.symbols.keys()]).toEqual([...index!.symbols.keys()]);
    expect(lazy.moduleNames).toEqual(index!.moduleNames);
    expect(subsorts(lazy, sortApp("SortKItem")).map((sort) => koreText(sort))).toEqual(
      subsorts(index!, sortApp("SortKItem")).map((sort) => koreText(sort)),
    );
  });
});

describeSoak("finding: what 5.3 MB of KWasm does not stress", () => {
  test("the deepest body is 50 levels and the widest node has 299 children", () => {
    // See finding 2 in this file's header.  Everything in this package walks
    // iteratively, and a green soak over 98 726 subterms is *not* evidence that
    // it needed to: the depth here is trivial for a recursive walker, and the
    // one dimension that is genuinely large is breadth — a 299-operand `\or`,
    // in an axiom whose only attribute is `constructor`.  If a
    // deep-term regression is ever wanted it needs a synthetic input, not a
    // bigger semantics.
    let depth = 0;
    let width = 0;
    let longestBody = 0;
    for (const axiom of index!.axioms) {
      longestBody = Math.max(longestBody, koreText(axiom.pattern).length);
      const stack: (readonly [Pattern, number])[] = [[axiom.pattern, 1]];
      for (;;) {
        const item = stack.pop();
        if (item === undefined) break;
        const [node, level] = item;
        depth = Math.max(depth, level);
        const kids = patterns(node);
        width = Math.max(width, kids.length);
        for (const kid of kids) stack.push([kid, level + 1]);
      }
    }
    expect(depth).toBe(50);
    expect(width).toBe(299);
    expect(longestBody).toBe(33_832);
  });
});
