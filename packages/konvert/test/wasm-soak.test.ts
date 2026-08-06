/**
 * Corpus #10 — the definition-ful soak, **opt-in and skipped by default**.
 *
 * `mir-semantics.test.ts` soaks `koreToKastPure`: one huge real configuration,
 * no definition, so nothing that needs a sort lattice runs.  Everything that
 * *does* — `addSortInjections`, `sortVars`, `addCellMapItems`, the whole of
 * `kruleToKore` — has only ever seen `simple-proofs.k` and `cell-map.k`, two
 * hand-written test definitions of about 50 sorts each.
 *
 * This file points those functions at a real semantics: `wasm-semantics`'
 * `test.md` kompiled with the haskell backend — 1784 syntax productions, 302
 * sorts, 2062 rules, 6 overloads and 6 cell collections, none of which exists
 * in either vendored definition.
 *
 * ## Why it is opt-in rather than vendored here
 *
 * The `compiled.json` is 4.9 MB, and the **complete** directory this file wants
 * is another 6 MB of KORE on top.  `packages/wasm-fixtures` — private, never
 * published — owns the partial artifact and the build recipe for the rest, and
 * both this package and `@kframework-ts/kompiled` take it as a dev dependency
 * rather than each vendoring a copy.  Fixtures *are* read across packages here;
 * what is not duplicated is the artifact and the plumbing around it.
 *
 * The recipe lives in exactly one place —
 * `packages/wasm-fixtures/fixtures/PROVENANCE.md` — with a builder beside it:
 *
 * ```sh
 * KFRAMEWORK_TS_K_BIN=…/k-7.1.337/bin \
 * KFRAMEWORK_TS_RV_CHECKOUTS=…/runtimeverification \
 *   bun run --cwd packages/wasm-fixtures kompile-soak
 * ```
 *
 * After that `wasmSoakDir()` finds the build in its content-keyed cache with no
 * variable set; `KFRAMEWORK_TS_WASM_KOMPILED` still overrides it with a path.
 *
 * ## What is asserted, and what deliberately is not
 *
 * Not byte-equality against `definition.kore`.  That was tried and measured:
 * **0 of 1539** convertible rules match K's own axiom text, because
 * `_krule_to_kore` discards `UNIQUE_ID`, `Source`, `Location` and `Production`
 * (`_kast_to_kore.py:309`) and emits `\equals(true, true)` where
 * `ModuleToKORE` emits `\top{R}()`.  pyk is not trying to reproduce the
 * frontend and neither is this package, so an equality oracle here would be
 * asserting a falsehood.
 *
 * What is asserted instead is that the **KORE side is a fixed point** —
 * `kastToKore(koreToKast(p)) === p` for all 3561 patterns the corpus produces —
 * and the exact shape of the failure set, which is where the interesting facts
 * turned out to be.  The KAST side is *not* a fixed point (2577 of 3561), for a
 * reason worth knowing: KORE puts a sort on every variable and KAST need not,
 * so the composite adds information rather than losing it.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { type KDefinition, type KInner, Atts, readKastDefinitionFromJson } from "@kframework-ts/kast";
import { WASM_CENSUS, WASM_DEFINITION_HASH, WASM_SOAK_ENV, envDir, wasmSoakDir } from "@kframework-ts/wasm-fixtures";

import { kastToKore, koreToKast } from "../src/convert.ts";
import { kruleToKore } from "../src/rule.ts";

const SOAK_DIR = wasmSoakDir();

const DEFINITION: KDefinition | undefined =
  SOAK_DIR === undefined
    ? undefined
    : readKastDefinitionFromJson(readFileSync(join(SOAK_DIR, "compiled.json"), "utf8"));

const describeSoak = DEFINITION === undefined ? describe.skip : describe;

/**
 * `describe.skip` still *runs* its callback — only the `test`s inside it are
 * skipped — so anything expensive (or anything that dereferences
 * {@link DEFINITION}) has to be behind a thunk rather than in a `describe` body.
 * `once` is that thunk, memoised so the 3880-term sweep happens on the first
 * test that needs it and not once per test.
 */
function once<T>(build: () => T): () => T {
  let value: { readonly it: T } | undefined;
  return () => (value ??= { it: build() }).it;
}

describe("the opt-in is wired the way PROVENANCE says", () => {
  test("no soak directory means no soak, and that is not a failure", () => {
    expect(wasmSoakDir()).toBe(SOAK_DIR);
    const explicit = envDir(WASM_SOAK_ENV);
    if (explicit !== undefined) expect(SOAK_DIR).toBe(explicit);
  });
});

describeSoak("a real definition behind the conversion", () => {
  test("it is the same build as the vendored compiled.json, not whatever was lying around", () => {
    // The identity guard, and this file did not have one until
    // `packages/wasm-fixtures` gave both soaks the same constant to assert.
    // Without it the counts below were the only thing standing between this
    // suite and a directory from another K release or another `wasm-semantics`
    // commit — and counts are exactly what a near-miss build would still
    // satisfy.  `KAst.hash` is a hash of the *definition*, so the absolute
    // paths a local build bakes into `compiled.json` do not reach it and two
    // machines' correct builds agree here.
    expect(DEFINITION!.hash).toBe(WASM_DEFINITION_HASH);
  });

  test("it is the semantics the recipe names", () => {
    expect(DEFINITION!.mainModuleName).toBe(WASM_CENSUS.mainModule);
    expect(DEFINITION!.rules.length).toBe(WASM_CENSUS.rules);
    expect(DEFINITION!.overloads.size).toBe(WASM_CENSUS.overloads);
    expect(DEFINITION!.cellCollectionProductions.length).toBe(WASM_CENSUS.cellCollectionProductions);
  });
});

/** Both sides of every rewrite, plus every non-rewrite body: 3880 terms. */
const sweep = once(() => {
  const sides: KInner[] = DEFINITION!.rules.flatMap((rule) =>
    rule.body.node === "KRewrite" ? [rule.body.lhs, rule.body.rhs] : [rule.body],
  );

  const converted: { readonly term: KInner; readonly kore: ReturnType<typeof kastToKore> }[] = [];
  const failures = new Map<string, number>();
  for (const term of sides) {
    try {
      converted.push({ term, kore: kastToKore(DEFINITION!, term) });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // Group by the class of failure, not by the term it happened on.
      const key = message.replace(/:.*$/su, "");
      failures.set(key, (failures.get(key) ?? 0) + 1);
    }
  }
  return { sides, converted, failures };
});

describeSoak("kastToKore ∘ koreToKast over every rule side in a real semantics", () => {
  test("the corpus is 3880 terms and 3561 of them convert", () => {
    const { sides, converted, failures } = sweep();
    // Against `simple-proofs`' 47 and `cell-map`'s 3.  Every failure class here
    // is reachable from IMP too — they are pyk-faithful limits, not things this
    // fixture discovered — but this is the first time the *ratio* has been
    // measurable, and 8 % is a different number from "a handful of edge cases".
    expect(sides.length).toBe(3880);
    expect(converted.length).toBe(3561);
    expect([...failures.keys()].toSorted()).toEqual([
      "Could not determine sort of term",
      "Sort #Layout is not a subsort of KItem",
      "Unsupported term",
      "resolveSorts",
    ]);
  });

  test("the KORE side is a fixed point: kastToKore ∘ koreToKast is the identity on it", () => {
    // The strong assertion of this file, and it holds for **all 3561**.
    //
    // The other direction does not, and the difference is the interesting part:
    // `koreToKast(kastToKore(t))` equals `t` for only 2577 of them, because
    // KORE carries a sort on every variable and KAST does not have to — a
    // `KVariable` written without one comes back carrying the sort the lattice
    // inferred.  That is a *gain* of information, so the KAST side is the wrong
    // place to look for a fixed point and the KORE side is the right one.
    for (const { kore } of sweep().converted) {
      expect(kastToKore(DEFINITION!, koreToKast(DEFINITION!, kore))).toEqual(kore);
    }
  });

  test("the KAST side round-trips exactly wherever the term already carried its sorts", () => {
    let exact = 0;
    for (const { term, kore } of sweep().converted) {
      if (Bun.deepEquals(koreToKast(DEFINITION!, kore), term)) exact += 1;
    }
    expect(exact).toBe(2577);
  });

  test("converting the same term twice gives the same pattern", () => {
    const sample = sweep().converted.filter((_, index) => index % 200 === 0);
    for (const { term, kore } of sample) expect(kastToKore(DEFINITION!, term)).toEqual(kore);
  });
});

const ruleSweep = once(() => {
  const outcomes = new Map<string, number>();
  let axioms = 0;
  for (const rule of DEFINITION!.rules) {
    try {
      kruleToKore(DEFINITION!, rule);
      axioms += 1;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const key = message.startsWith("Do not know how to convert AttEntry to Kore")
        ? `unsupported att: ${message.slice(message.lastIndexOf(": ") + 2)}`
        : message.replace(/:.*$/su, "");
      outcomes.set(key, (outcomes.get(key) ?? 0) + 1);
    }
  }
  return { outcomes, axioms };
});

describeSoak("kruleToKore against 2062 real rules", () => {
  test("most of a real semantics is outside pyk's attribute table, and that is upstream's shape", () => {
    // `_krule_att_to_kore` (`_kast_to_kore.py:335-351`) knows six attributes —
    // `label`, `priority`, `simplification`, `symbolic`, `concrete`,
    // `smt-lemma` — and raises on everything else.  This package transcribes
    // that table exactly, so the number below is a measurement of *pyk*, and
    // it is the reason `kruleToKore` cannot be pointed at a whole semantics.
    // Recording it is the point: nothing in the IMP-scale fixtures suggests
    // that a fifth of a real definition is unreachable.
    const { outcomes, axioms } = ruleSweep();
    expect(axioms + [...outcomes.values()].reduce((a, b) => a + b, 0)).toBe(2062);
    expect(axioms).toBe(1580);
    expect(outcomes.get("unsupported att: projection")).toBe(320);
    expect(outcomes.get("unsupported att: initializer")).toBe(75);
    expect(outcomes.get("unsupported att: preserves-definedness")).toBe(20);
    // 415 of 482 failures are that table; the remainder are term-level.
    const attFailures = [...outcomes]
      .filter(([key]) => key.startsWith("unsupported att: "))
      .reduce((sum, [, count]) => sum + count, 0);
    expect(attFailures).toBe(415);
  });

  test("the rules it does convert are the ones whose attributes are all in the table", () => {
    // The converse of the count above, stated per rule: no rule is rejected for
    // an attribute the table knows.  `att.keys()` yields `AttKey` objects, so
    // the comparison is on `.name` — the string K wrote.
    const TABLE = new Set([
      Atts.LABEL.name,
      Atts.PRIORITY.name,
      Atts.SIMPLIFICATION.name,
      Atts.SYMBOLIC.name,
      Atts.CONCRETE.name,
      Atts.SMTLEMMA.name,
      // Dropped before the table is consulted (`_kast_to_kore.py:309`), plus
      // `owise`, which is rewritten into `priority(200)` there.
      Atts.PRODUCTION.name,
      Atts.UNIQUE_ID.name,
      Atts.SOURCE.name,
      Atts.LOCATION.name,
      Atts.OWISE.name,
    ]);
    let known = 0;
    let knownButFailed = 0;
    for (const rule of DEFINITION!.rules) {
      if ([...rule.att.keys()].some((key) => !TABLE.has(key.name))) continue;
      known += 1;
      try {
        kruleToKore(DEFINITION!, rule);
      } catch (error) {
        // A failure here is in the *term*, never in the attributes — so it must
        // not be an attribute-table message.
        const message = error instanceof Error ? error.message : String(error);
        expect(message).not.toContain("Do not know how to convert AttEntry to Kore");
        knownButFailed += 1;
      }
    }
    expect(known).toBe(1634);
    expect(knownButFailed).toBe(54);
    // …and the two halves account for every rule the previous test counted.
    expect(known - knownButFailed).toBe(1580);
  });
});
