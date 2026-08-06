/**
 * The KORE half of the KWasm fixture — **opt-in, and skipped by default**.
 *
 * `wasm-semantics.test.ts` runs against the partial directory
 * `packages/wasm-fixtures` vendors.  What that directory deliberately omits is
 * `definition.kore` (5.31 MB) and `syntaxDefinition.kore` (0.78 MB): committing
 * them would take the repo's fixture footprint from 8 MB to over 14 MB, and the
 * coverage they buy — the lazy-axiom reader at a scale IMP cannot reach — is
 * coverage anyone with a K install can reproduce in half a minute.
 *
 * So the bytes stay out and the recipe goes in — **once**, in
 * `packages/wasm-fixtures/fixtures/PROVENANCE.md`, with a builder beside it:
 *
 * ```sh
 * KFRAMEWORK_TS_K_BIN=…/k-7.1.337/bin \
 * KFRAMEWORK_TS_RV_CHECKOUTS=…/runtimeverification \
 *   bun run --cwd packages/wasm-fixtures kompile-soak
 * ```
 *
 * After that `wasmSoakDir()` finds the build in its content-keyed cache with no
 * variable set at all; `KFRAMEWORK_TS_WASM_KOMPILED` still overrides it with an
 * explicit path.  Without either, every test here skips and `bun test` stays
 * what it promises: no K install, no network, nothing outside the repository.
 *
 * The assertions are written so that a directory built from a *different* K
 * release fails loudly rather than quietly weakening: `WASM_DEFINITION_HASH` is
 * the cross-check, and `packages/konvert`'s soak asserts the same one, so the
 * two suites cannot disagree about which build they are looking at.
 */

import { describe, expect, test } from "bun:test";

import { ATT_UNIQUE_ID, attString } from "@kframework-ts/kore";
import { WASM_DEFINITION_HASH, WASM_SOAK_ENV, envDir, wasmSoakDir } from "@kframework-ts/wasm-fixtures";

import { loadKompiledDefinition } from "../src/fs.ts";
import { WASM_HASKELL } from "./fixtures.ts";

const soakDir = wasmSoakDir();
const soak = soakDir === undefined ? undefined : await loadKompiledDefinition(soakDir);
const describeSoak = soak === undefined ? describe.skip : describe;

describe("the opt-in is wired the way the README says", () => {
  test("no soak directory means no soak, and that is not a failure", () => {
    // The one assertion that runs in the default suite: it pins the contract
    // that this file is inert without one, so a future reader does not have to
    // infer it from `describe.skip`.  `wasmSoakDir` is the only thing that
    // decides, and an explicit `KFRAMEWORK_TS_WASM_KOMPILED` always wins over
    // the cache — the half of the contract checkable without a K install.
    expect(wasmSoakDir()).toBe(soakDir);
    expect(soak === undefined).toBe(soakDir === undefined);
    const explicit = envDir(WASM_SOAK_ENV);
    if (explicit !== undefined) expect(soakDir).toBe(explicit);
  });
});

describeSoak("definition.kore at 5.3 MB", () => {
  test("it is the same build as the vendored compiled.json", async () => {
    // The guard against a soak directory from another K release silently
    // passing weaker assertions: `definition_hash` is a hash of the KAST
    // definition, so if these agree the KORE file beside it is this one's.
    // Asserted against the shared constant rather than against the vendored
    // load alone, so that `packages/konvert` — which has no `kompiled` to load
    // through — can make the identical assertion.
    const vendored = await loadKompiledDefinition(WASM_HASKELL);
    expect(vendored.definitionHash).toBe(WASM_DEFINITION_HASH);
    expect(soak!.definitionHash).toBe(WASM_DEFINITION_HASH);
    expect(soak!.layout.mainModule).toBe("WASM-TEST");
  });

  test("indexing leaves every axiom body unparsed", () => {
    const index = soak!.koreDefinition;
    // IMP's definition.kore has 726 axioms; this is the number the laziness
    // claim was made for.
    expect(index.axioms.length).toBe(6824);
    expect(index.axioms.every((axiom) => axiom.tag === "LazyAxiom")).toBe(true);
    // …and the tables a body would be needed for are complete regardless.
    expect(index.sorts.size).toBe(302);
    expect(index.symbols.size).toBe(1732);
  });

  test("forcing one body gives an axiom whose attributes the index already had", () => {
    const index = soak!.koreDefinition;
    const lazy = index.axioms.find((axiom) => axiom.attrs.length > 0)!;
    const forced = soak!.forceKoreAxiom(lazy);
    expect(forced.tag).toBe("Axiom");
    expect(forced.attrs).toEqual(lazy.attrs);
    expect(soak!.forceKoreAxiom(forced)).toBe(forced);
  });

  test("every macro rule's axiom is in macros.kore and none of them is in definition.kore", () => {
    // The structural claim behind `ModuleToKORE.java:336-352`'s two-way routing,
    // checkable only when both files are present — which is exactly what the
    // vendored directory cannot do.
    const macroIds = new Set(soak!.macrosKore.axioms.map((axiom) => attString(axiom.attrs, ATT_UNIQUE_ID)));
    expect(macroIds.size).toBe(13);

    const semanticsIds = new Set(soak!.koreDefinition.axioms.map((axiom) => attString(axiom.attrs, ATT_UNIQUE_ID)));
    for (const id of macroIds) expect(semanticsIds.has(id)).toBe(false);
  });

  test("the definition.kore → compiled.json join is near-total, but not total", () => {
    // The cross-artifact join at ~2000 rules rather than IMP's 170 — and the
    // reason to run it at that scale is that IMP cannot show the interesting
    // half.  1989 of the 1996 axioms carrying a UNIQUE_ID name a sentence in
    // `compiled.json`; **seven do not**, and their ids appear nowhere in that
    // file (checked by substring, not just through the index).
    //
    // All seven carry `simplification`.  Why the frontend has them and the KAST
    // definition does not is not established here, and guessing would be worse
    // than recording the measurement: `KoreBackend.getKompiledModule` runs four
    // module transformers *after* `compiled.json` has been written, so the two
    // files are not snapshots of the same object, and this is the first fixture
    // in the repo at which that stops being invisible.
    const byId = soak!.definition.sentenceByUniqueId;
    const text = soak!.text("compiled.json")!;
    const ids = soak!.koreDefinition.axioms
      .map((axiom) => attString(axiom.attrs, ATT_UNIQUE_ID))
      .filter((id): id is string => id !== undefined);
    const unjoined = ids.filter((id) => !byId.has(id));

    expect(ids.length).toBe(1996);
    expect(unjoined.length).toBe(7);
    for (const id of unjoined) expect(text).not.toContain(id);
  });
});

describeSoak("syntaxDefinition.kore", () => {
  test("it is the syntax slice, and it holds two symbols definition.kore drops", () => {
    const full = soak!.koreDefinition;
    const syntax = soak!.syntaxKore;

    expect(syntax.sorts.size).toBe(full.sorts.size);
    // Not equal, and the difference is one-directional: the syntax file is a
    // superset by exactly the definition's **bracket** productions, which the
    // semantics has no use for and the unparser cannot do without.  IMP shows
    // the same two-symbol gap for the same reason (`(_)` at `AExp` and `BExp`),
    // so this is the general shape rather than a KWasm accident.
    expect([...full.symbols.keys()].filter((s) => !syntax.symbols.has(s))).toEqual([]);
    expect([...syntax.symbols.keys()].filter((s) => !full.symbols.has(s))).toEqual([
      "Lbl'LParUndsRParUnds'WASM-TEXT-COMMON-SYNTAX'Unds'LocalDecl'Unds'LocalDecl",
      "Lbl'LParUndsRParUnds'WASM-COMMON-SYNTAX'Unds'TypeDecl'Unds'TypeDecl",
    ]);
    expect(syntax.symbols.size - full.symbols.size).toBe(soak!.definition.brackets.size);

    // No rules, so no axioms to speak of beside the semantics file's thousands.
    expect(syntax.axioms.length).toBeLessThan(full.axioms.length / 5);

    const fullBytes = soak!.text("definition.kore")!.length;
    const syntaxBytes = soak!.text("syntaxDefinition.kore")!.length;
    expect(syntaxBytes * 4).toBeLessThan(fullBytes);
  });
});
