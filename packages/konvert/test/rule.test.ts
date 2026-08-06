/**
 * `rule.ts`'s contract, beyond the 13 axiom goldens `simple-proofs.test.ts`
 * already pins: the attribute massaging's edges, and `kflatmoduleToKore`.
 *
 * `kflatmoduleToKore` has no upstream test at all — its only consumer is
 * `cterm/symbolic.py:395`, the kore-rpc `add-module` request — so everything
 * here is derived from `_kast_to_kore.py:325-332` directly.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  attEntry,
  attKey,
  Atts,
  ANY_TYPE,
  KAtt,
  kapply,
  kflatmodule,
  kimport,
  krewrite,
  krule,
  ksequence,
  ksort,
  kvariable,
  letKRule,
  readKastDefinitionFromJson,
} from "@kframework-ts/kast";
import { koreText } from "@kframework-ts/kore";

import { kflatmoduleToKore, kruleToKore } from "../src/rule.ts";

/** Index into an array whose bounds the test has already established. */
function at<T>(xs: readonly T[], i: number): T {
  const x = xs[i];
  if (x === undefined) throw new RangeError(`Index ${i} is out of range (length ${xs.length})`);
  return x;
}

const DEFINITION = readKastDefinitionFromJson(
  readFileSync(join(import.meta.dir, "..", "fixtures", "definitions", "simple-proofs.compiled.json"), "utf8"),
);

/** A minimal well-sorted rewrite rule over `simple-proofs`'s configuration. */
function fooToBar(att: KAtt = new KAtt()): ReturnType<typeof krule> {
  return krule(
    krewrite(
      kapply("<generatedTop>", [
        kapply("<k>", [ksequence([kapply("foo_SIMPLE-PROOFS_KItem")])]),
        kapply("<state>", [kapply(".Map", [])]),
        kvariable("Counter", ksort("GeneratedCounterCell")),
      ]),
      kapply("<generatedTop>", [
        kapply("<k>", [ksequence([kapply("bar_SIMPLE-PROOFS_KItem")])]),
        kapply("<state>", [kapply(".Map", [])]),
        kvariable("Counter", ksort("GeneratedCounterCell")),
      ]),
    ),
    { att },
  );
}

/** The attribute list of an axiom, as written. */
function attrsOf(rule: ReturnType<typeof krule>): string {
  const text = koreText(kruleToKore(DEFINITION, rule));
  return text.slice(text.lastIndexOf(" ["));
}

describe("rule attribute massaging", () => {
  test("no priority and no owise defaults to priority(50)", () => {
    expect(attrsOf(fooToBar())).toBe(' [priority{}("50")]');
  });

  /**
   * `owise` becomes `priority(200)` **and the `owise` is dropped** — the two
   * say the same thing and only one of them is a KORE attribute.
   */
  test("owise becomes priority(200) and disappears", () => {
    const attrs = attrsOf(fooToBar(new KAtt([attEntry(Atts.OWISE, null)])));
    expect(attrs).toBe(' [priority{}("200")]');
    expect(attrs).not.toContain("owise");
  });

  /**
   * The `owise` discard is guarded by the *priority* test, not by `owise`'s own
   * presence (`_kast_to_kore.py:310-313`), so a rule carrying **both** keeps its
   * `owise` — and then raises, because `owise` is not one of the six
   * translatable attributes. This is pyk's behaviour exactly. K itself rejects
   * the combination, so the shape never reaches here from a real definition;
   * it is asserted so that "fix" is a decision and not an accident.
   */
  test("an explicit priority leaves owise in place, which then raises", () => {
    expect(() =>
      kruleToKore(DEFINITION, fooToBar(new KAtt([attEntry(Atts.OWISE, null), attEntry(Atts.PRIORITY, 17)]))),
    ).toThrow("Do not know how to convert AttEntry to Kore: owise");
  });

  /**
   * A `simplification` with no explicit priority keeps none: the backend orders
   * simplifications by its own rules, so defaulting one would be a lie.
   */
  test("a simplification gets no default priority", () => {
    expect(attrsOf(fooToBar(new KAtt([attEntry(Atts.SIMPLIFICATION, null)])))).toBe(' [simplification{}("")]');
  });

  /** The four provenance attributes are dropped before anything else happens. */
  test("production, UNIQUE_ID, source and location are dropped", () => {
    const att = new KAtt([
      attEntry(Atts.UNIQUE_ID, "abcdef"),
      attEntry(Atts.SOURCE, "/tmp/x.k"),
      attEntry(Atts.LOCATION, [1, 2, 3, 4] as const),
      attEntry(Atts.LABEL, "X.y"),
    ]);
    expect(attrsOf(fooToBar(att))).toBe(' [label{}("X.y"), priority{}("50")]');
  });

  /**
   * Entries are sorted by key **name**, `String.compareTo` order — plain
   * `<`/`>` in JavaScript, never `localeCompare`.
   */
  test("entries are sorted by key name", () => {
    const att = new KAtt([attEntry(Atts.PRIORITY, 3), attEntry(Atts.SMTLEMMA, null), attEntry(Atts.LABEL, "Z")]);
    expect(attrsOf(fooToBar(att))).toBe(' [label{}("Z"), priority{}("3"), smt-lemma{}()]');
  });

  /**
   * Only six attribute kinds are translatable. An attribute that reached KORE
   * without a defined meaning would be silently ignored by the backend, which
   * is worse than a refusal.
   */
  test("an untranslatable attribute raises", () => {
    const att = new KAtt([attEntry(attKey("total", ANY_TYPE), null)]);
    expect(() => kruleToKore(DEFINITION, fooToBar(att))).toThrow("Do not know how to convert AttEntry to Kore");
  });

  test("a symbolic/concrete variable not in the rule raises", () => {
    const att = new KAtt([attEntry(Atts.SIMPLIFICATION, null), attEntry(Atts.SYMBOLIC, "Nope")]);
    expect(() => kruleToKore(DEFINITION, fooToBar(att))).toThrow("Variable in symbolic not present in rule");
  });

  test('a nullary concrete is concrete{}(), not concrete{}("")', () => {
    const att = new KAtt([attEntry(Atts.SIMPLIFICATION, null), attEntry(Atts.CONCRETE, null)]);
    expect(attrsOf(fooToBar(att))).toBe(' [concrete{}(), simplification{}("")]');
  });

  /**
   * A named `concrete` variable is emitted with the sort **inference** gave it,
   * which is why the lookup goes through the sorted rule's variable occurrences
   * rather than through the attribute text.
   */
  test("a named concrete variable carries its inferred sort", () => {
    const rule = letKRule(fooToBar(), {
      body: krewrite(
        kapply("<generatedTop>", [
          kapply("<k>", [ksequence([kapply("pred1", [kvariable("N")])])]),
          kapply("<state>", [kapply(".Map", [])]),
          kvariable("Counter", ksort("GeneratedCounterCell")),
        ]),
        kapply("<generatedTop>", [
          kapply("<k>", [ksequence([])]),
          kapply("<state>", [kapply(".Map", [])]),
          kvariable("Counter", ksort("GeneratedCounterCell")),
        ]),
      ),
      att: new KAtt([attEntry(Atts.SIMPLIFICATION, null), attEntry(Atts.CONCRETE, "N")]),
    });
    expect(attrsOf(rule)).toBe(' [concrete{}(VarN : SortInt{}), simplification{}("")]');
  });
});

describe("kflatmoduleToKore", () => {
  test("imports come first, then one axiom per rule", () => {
    const module = kflatmodule("MY-MODULE", {
      imports: [kimport("SIMPLE-PROOFS"), kimport("OTHER")],
      sentences: [fooToBar(), fooToBar(new KAtt([attEntry(Atts.LABEL, "second")]))],
    });
    const kore = kflatmoduleToKore(DEFINITION, module);

    expect(kore.name).toBe("MY-MODULE");
    expect(kore.sentences.map((s) => s.tag)).toEqual(["Import", "Import", "Axiom", "Axiom"]);
    expect(koreText(at(kore.sentences, 0))).toBe("import SIMPLE-PROOFS []");
  });

  test("an import's visibility is dropped — KORE has no notion of it", () => {
    const module = kflatmodule("M", { imports: [kimport("SIMPLE-PROOFS", false)] });
    expect(koreText(at(kflatmoduleToKore(DEFINITION, module).sentences, 0))).toBe("import SIMPLE-PROOFS []");
  });

  /** This is the kore-rpc `add-module` payload: rules and nothing else. */
  test("a non-rule sentence raises", () => {
    const module = kflatmodule("M", { sentences: [{ ...fooToBar(), node: "KClaim" }] });
    expect(() => kflatmoduleToKore(DEFINITION, module)).toThrow("Cannot convert sentence to Kore");
  });
});

describe("an empty-KSequence RHS is a term, not a falsy value", () => {
  /**
   * `mlAnd` is `@kframework-ts/kast`'s `buildAssoc`, and pyk's `build_assoc`
   * (`kast/inner.py:912-932`) ends `return res or unit`. `KSequence.__len__`
   * makes `KSequence([])` **falsy** in Python, so a single `.K` operand is
   * replaced by the unit: pyk's `mlAnd([.K], Int)` is `#Top{Int}`, and the
   * rule below converts under pyk to a function equation whose right-hand side
   * is `\top{SortInt{}}()` — an axiom asserting that `simpleFunc()` equals
   * *anything*.
   *
   * `@kframework-ts/kast` tests `=== null`, keeps the `.K`, and the injection
   * guard then refuses it — because the rule is ill-sorted to begin with. `.K`
   * is at sort `K` and `mybytes` returns `KItem`; K's own frontend rejects
   * that, so no `kompile` output contains such a rule, and the only question is
   * what to do with input that should not exist. The refusal names both sorts
   * and is exactly the message the `kast`-CLI fallback catches; pyk's `\top` is
   * silent nonsense. The throw is kept, and pinned here.
   */
  test.each([
    ["mybytes", "KItem"],
    ["simpleFunc", "Int"],
  ])("a .K right-hand side of %s is refused, where pyk emits \\top", (label, sort) => {
    const rule = krule(krewrite(kapply(label), ksequence([])));
    expect(() => kruleToKore(DEFINITION, rule)).toThrow(`Sort K is not a subsort of ${sort}: KApply(dotk, 0 args)`);
  });

  /**
   * The same shape at sort `K` needs no injection and converts, which is what
   * makes the cases above a sorting error rather than a limitation: the `.K`
   * survives into the axiom as `dotk{}()`, where pyk would have replaced it
   * with `\top{SortK{}}()`.
   */
  test("a .K right-hand side at sort K converts, keeping the dotk", () => {
    const rule = krule(krewrite(kapply("project:K", [kvariable("X", ksort("K"))]), ksequence([])));
    const text = koreText(kruleToKore(DEFINITION, rule));
    // The equation's right-hand side is `\and{SortK{}}(<rhs>, <ensures>)`, and
    // `<rhs>` is the `dotk{}()`. pyk would have `\top{SortK{}}()` in that first
    // position — indistinguishable from the empty-ensures `\top` beside it.
    expect(text).toContain("\\and{SortK{}}(dotk{}(), \\top{SortK{}}())");
  });
});
