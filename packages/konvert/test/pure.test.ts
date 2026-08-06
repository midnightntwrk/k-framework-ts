/**
 * The behavioural contract, item by item.
 *
 * There are a handful of places a transcription of `konvert` goes quietly
 * wrong, each adjudicated between pyk and the Java/Scala originals.  The
 * tables in the other files are pyk's, so they cannot by
 * construction test anything where this package deliberately *differs* from
 * pyk.  This file does: one `describe` per contract item, named after it.
 *
 * Anything already pinned by a corpus is cross-referenced rather than repeated.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  type KInner,
  flattenLabel,
  kapply,
  kas,
  klabel,
  krewrite,
  ksequence,
  ksort,
  ktoken,
  kvariable,
  readKastDefinitionFromJson,
} from "@kframework-ts/kast";
import { intToken } from "@kframework-ts/kast/prelude/kint";
import { mlAnd, mlOr } from "@kframework-ts/kast/prelude/ml";
import { evar, koreString, koreText, multiOr, or, parsePattern, sortApp, sortVar } from "@kframework-ts/kore";

import { kastToKore, replaceKsequenceByKapply, sortHooks } from "../src/convert.ts";
import {
  DEFAULT_SORT_HOOKS,
  expandAssoc,
  HOOK_BYTES,
  HOOK_STRING,
  kastToKorePure,
  koreToKastPure,
  ksortToKore,
  labelToKore,
  ML_CONN_LABELS,
  ML_PATTERN_LABELS,
  ML_PRED_LABELS,
  ML_QUANT_LABELS,
  sortToKast,
  varNameToKast,
} from "../src/pure.ts";

const DEFINITION = readKastDefinitionFromJson(
  readFileSync(join(import.meta.dir, "..", "fixtures", "definitions", "simple-proofs.compiled.json"), "utf8"),
);

/**
 * The cast a consumer would write to get past `ReadonlyMap` and mutate a table
 * the package shares. `Object.freeze` on a `Map` does not stop it, which is why
 * the tables deny the write themselves.
 */
function asMutable(map: ReadonlyMap<string, string>): Map<string, string> {
  // The unsafety is the point: this is exactly the escape hatch the frozen
  // tables have to deny at run time, because the type system cannot.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  return map as Map<string, string>;
}

/** A `depth`-deep **left**-nested `\and` over `A`…`D`, as KORE text. */
function leftNestedAnd(depth: number): string {
  return depth === 0
    ? "VarA : SortBool{}"
    : `\\and{SortBool{}}(${leftNestedAnd(depth - 1)}, Var${"ABCD"[depth] ?? "?"} : SortBool{})`;
}

describe("sort injections — the subsort guard and its message", () => {
  /**
   * `_inject` (`_kast_to_kore.py:206-220`) throws `Sort X is not a subsort of Y`,
   * and that is precisely the exception `KPrint.kast_to_kore` catches to fall
   * back to shelling out to the `kast` CLI (`ktool/kprint.py:262-289`). The
   * failure mode is part of the contract, so the message is asserted.
   *
   * Java has no such check (`AddSortInjections:123-203`) — it emits the
   * injection unconditionally — so a term that fails here is one Java would
   * convert into possibly-invalid KORE.
   */
  test("an illegal injection throws with the contract message", () => {
    expect(() => kastToKore(DEFINITION, intToken(3), { sort: ksort("Baz") })).toThrow(
      "Sort Int is not a subsort of Baz",
    );
  });

  test("a legal injection is inserted, and an identity one is not", () => {
    expect(koreText(kastToKore(DEFINITION, kapply("baz"), { sort: ksort("Bar") }))).toBe(
      "inj{SortBaz{}, SortBar{}}(Lblbaz{}())",
    );
    expect(koreText(kastToKore(DEFINITION, kapply("baz"), { sort: ksort("Baz") }))).toBe("Lblbaz{}()");
  });

  /**
   * The reason both folds and this pass are explicit stack machines: a term
   * deeper than the engine's default call stack must convert, not `RangeError`.
   * 20,000 nested applications is comfortably past it.
   */
  test("a term deeper than the call stack converts", () => {
    let kast: KInner = kvariable("X", "Int");
    for (let i = 0; i < 20_000; i++) kast = kapply("_+Int_", [kast, intToken(1)]);
    const kore = kastToKore(DEFINITION, kast, { sort: ksort("Int") });
    expect(kore.tag).toBe("App");
  });
});

describe("kseq / append / dotk — the (KItem, K) vs (K, K) split", () => {
  /**
   * `prelude.kore` is the only place in either toolchain where the two
   * signatures are declared rather than assumed:
   *
   * ```kore
   * symbol kseq{}(SortKItem{}, SortK{}) : SortK{}
   * symbol append{}(SortK{}, SortK{})   : SortK{}
   * ```
   *
   * so `append` is picked exactly when the head is already a whole sequence.
   */
  test("a K-sorted head becomes append, a KItem-sorted head becomes kseq", () => {
    const withK = replaceKsequenceByKapply(DEFINITION, ksequence([kvariable("X", "K"), intToken(1)]));
    expect(withK.node === "KApply" ? withK.label.name : undefined).toBe("append");

    const withItem = replaceKsequenceByKapply(DEFINITION, ksequence([intToken(1), intToken(2)]));
    expect(withItem.node === "KApply" ? withItem.label.name : undefined).toBe("kseq");
  });

  test("an empty sequence is dotk", () => {
    const empty = replaceKsequenceByKapply(DEFINITION, ksequence([]));
    expect(empty.node === "KApply" ? empty.label.name : undefined).toBe("dotk");
  });

  /**
   * A **last** item already at sort `K` becomes the tail unit itself rather
   * than being consed onto `dotk` — which is what makes `KSequence(X:K)`
   * convert to the bare `VarX:SortK{}`.
   */
  test("a K-sorted last item is the tail unit, not a cons cell", () => {
    expect(koreText(kastToKore(DEFINITION, ksequence([kvariable("CONT", "K")]), { sort: ksort("K") }))).toBe(
      "VarCONT : SortK{}",
    );
  });

  /**
   * The KAST constructor auto-flattens a nested `KSequence`
   * (`kast/inner.py:602-609`), which is what collapses a decoded cons chain in
   * one pass without any explicit work on the way back.
   */
  test("nested KSequences auto-flatten on the way back", () => {
    expect(koreToKastPure(parsePattern("kseq{}(VarA : SortKItem{}, kseq{}(VarB : SortKItem{}, dotk{}()))"))).toEqual(
      ksequence([kvariable("A", "KItem"), kvariable("B", "KItem")]),
    );
  });
});

describe("quantifiers — the three special cases", () => {
  /**
   * `_argument_terms` drops the bound variable, `_argument_sorts` takes the
   * *second* sort from `resolveSorts`, `_let_arguments` re-attaches it. All
   * three have to agree or the body is injected to the variable's sort.
   *
   * The `ml-exists-var-inference` row of `simple-proofs.test.ts` covers
   * `#Exists`; `#Forall`
   * has no upstream row at all, and takes the same path.
   */
  test("#Forall drops, sorts and re-attaches its bound variable", () => {
    const kast = kapply(klabel("#Forall", [ksort("Bar"), ksort("Foo")]), [
      kvariable("X"),
      kapply("foo", [kvariable("X")]),
    ]);
    expect(koreText(kastToKore(DEFINITION, kast, { sort: ksort("Foo") }))).toBe(
      "\\forall{SortFoo{}}(VarX : SortBar{}, Lblfoo{}(VarX : SortBar{}))",
    );
  });
});

describe("String/Bytes detection is by hook, not by sort name", () => {
  /**
   * Java dispatches on the sort's `hook` attribute
   * (`ModuleToKORE.java:2258-2272`, `KoreToK.scala:170`); pyk compares against
   * the literal names `String`/`Bytes`. A definition that hooks `STRING.String`
   * onto a differently-named sort converts correctly under Java and silently
   * wrongly under pyk.
   */
  test("a differently-named hooked sort is treated as a String", () => {
    const hooks = new Map([["Text", HOOK_STRING]]);
    // With the hook map, the K quoting layer is stripped: `"a\nb"` → `a<LF>b`.
    expect(kastToKorePure(ktoken('"a\\nb"', "Text"), { hooks })).toEqual(parsePattern('\\dv{SortText{}}("a\\nb")'));
    // Without it, the token text is copied verbatim, quotes and all — pyk's
    // behaviour, and the wrong answer.
    expect(kastToKorePure(ktoken('"a\\nb"', "Text"))).toEqual(parsePattern('\\dv{SortText{}}("\\"a\\\\nb\\"")'));
  });

  test("a differently-named hooked sort is treated as Bytes on the way back", () => {
    const hooks = new Map([["Blob", HOOK_BYTES]]);
    // The *sort* is the `\dv`'s own, not a hardcoded `Bytes` — `KoreToK.scala:175`
    // passes `apply(s)` through. pyk's `bytesToken_from_str` hardcodes `Bytes`.
    expect(koreToKastPure(parsePattern('\\dv{SortBlob{}}("ab")'), { hooks })).toEqual(ktoken('b"ab"', "Blob"));
  });

  /**
   * The default keeps `pure.ts` definition-free and reproduces pyk exactly:
   * the sorts literally named `String` and `Bytes`.
   */
  test("the default map is pyk's hardcoded pair", () => {
    expect([...DEFAULT_SORT_HOOKS]).toEqual([
      ["String", HOOK_STRING],
      ["Bytes", HOOK_BYTES],
    ]);
  });

  test("a real definition's hook map carries both", () => {
    const hooks = sortHooks(DEFINITION);
    expect(hooks.get("String")).toBe(HOOK_STRING);
    expect(hooks.get("Bytes")).toBe(HOOK_BYTES);
    expect(hooks.get("Int")).toBe("INT.Int");
  });
});

describe("koreToKast is more complete than pyk", () => {
  /**
   * pyk raises `Unsupported Pattern` for all four of these
   * (`_kore_to_kast.py:159-160`). `KoreToK.scala` — which is what `kore-print`
   * runs, i.e. what pyk's own CLI fallback shells out to — decodes all four, so
   * implementing them is strictly more complete and never changes an outcome
   * pyk got right.
   */
  test("\\forall decodes, symmetrically with \\exists", () => {
    expect(koreToKastPure(parsePattern("\\forall{SortFoo{}}(VarX : SortBar{}, VarX : SortBar{})"))).toEqual(
      kapply(klabel("#Forall", [ksort("Bar"), ksort("Foo")]), [kvariable("X", "Bar"), kvariable("X", "Bar")]),
    );
  });

  test("\\floor decodes, dually with \\ceil", () => {
    expect(koreToKastPure(parsePattern("\\floor{SortBool{}, SortFoo{}}(VarX : SortBool{})"))).toEqual(
      kapply(klabel("#Floor", [ksort("Bool"), ksort("Foo")]), [kvariable("X", "Bool")]),
    );
  });

  /**
   * The sides matter, not just the node kind: `KoreToK.scala:159-160` keeps the
   * KORE argument order, so the `\rewrites` lhs is the `KRewrite` lhs. Getting
   * that backwards would still produce a `KRewrite`.
   */
  test("\\rewrites decodes to a KRewrite over both sides, in order", () => {
    expect(koreToKastPure(parsePattern("\\rewrites{SortFoo{}}(Lbll{}(VarX : SortFoo{}), VarY : SortFoo{})"))).toEqual(
      krewrite(kapply("l", [kvariable("X", "Foo")]), kvariable("Y", "Foo")),
    );
  });

  /**
   * `MultiOr` is KORE-JSON's `KJMultiOr` — a `\or` cascade in every respect but
   * its spelling. pyk has no class for it and cannot read a document containing
   * one, so there is no upstream behaviour to match; the Haskell wire type says
   * it means a nest of `\or`, and that is what it decodes to. It has no textual
   * spelling, so it has to be built rather than parsed.
   */
  test("MultiOr decodes exactly as the equivalent Or does", () => {
    const disjuncts = [
      evar("VarA", sortApp("SortFoo")),
      evar("VarB", sortApp("SortFoo")),
      evar("VarC", sortApp("SortFoo")),
    ];
    const expected = mlOr([kvariable("A", "Foo"), kvariable("B", "Foo"), kvariable("C", "Foo")], ksort("Foo"));

    expect(koreToKastPure(multiOr("Right", sortApp("SortFoo"), disjuncts))).toEqual(expected);
    // The `assoc` tag is JSON-only bookkeeping about how the cascade was
    // nested; the flattened `#Or` is the same term either way.
    expect(koreToKastPure(multiOr("Left", sortApp("SortFoo"), disjuncts))).toEqual(expected);
    expect(koreToKastPure(or(sortApp("SortFoo"), disjuncts))).toEqual(expected);
  });

  test("a bare string literal decodes to a KString token", () => {
    expect(koreToKastPure(koreString("hello"))).toEqual(ktoken("hello", "KString"));
  });

  /**
   * `\iff` and `\in` keep raising: `KoreToK.scala:153-154` and `:167-168` throw
   * on exactly these two, and so does pyk. `\mu`/`\nu`/`\next` keep raising
   * because scala-kore's `Pattern` ADT has no such node, so a `kompile`d
   * definition cannot contain one and `kore-print` could not decode it either.
   */
  test.each([
    ["\\iff", "\\iff{SortBool{}}(VarX : SortBool{}, VarY : SortBool{})"],
    ["\\in", "\\in{SortBool{}, SortFoo{}}(VarX : SortBool{}, VarY : SortBool{})"],
    ["\\mu", "\\mu{}(@X : SortBool{}, VarY : SortBool{})"],
    ["\\nu", "\\nu{}(@X : SortBool{}, VarY : SortBool{})"],
    ["\\next", "\\next{SortBool{}}(VarX : SortBool{})"],
  ])("%s still raises", (_name, text) => {
    expect(() => koreToKastPure(parsePattern(text))).toThrow("Unsupported Pattern");
  });

  /**
   * `KoreToK.scala:68-69` maps a `SortVariable` to `SortK`. That is silently
   * lossy — the `R` of every function-equation axiom would become `K` — so it
   * is deliberately not copied. pyk raises; so does this.
   */
  test("a sort variable is rejected, not silently widened to K", () => {
    expect(() => sortToKast(sortVar("R"))).toThrow("Unsupported Sort");
  });
});

describe("kastToKorePure's three rejected nodes, and the asymmetry one of them creates", () => {
  /**
   * `KInner` has six arms and the fold handles three. Java encodes all six
   * (`ModuleToKORE.java:2280-2344`), but only off an `Att.SORT()` this term
   * algebra has no room for — `kseq`/`\rewrites{S}`/`\and{S}` each need a sort
   * the bare node does not carry. pyk rejects the same three
   * (`_kast_to_kore.py:390-391`), and the message names the node so a consumer
   * can tell which of the three it hit.
   */
  test.each([
    ["KSequence", ksequence([kvariable("X", "KItem")])],
    ["KRewrite", krewrite(kvariable("X", "Foo"), kvariable("Y", "Foo"))],
    ["KAs", kas(kvariable("X", "Foo"), kvariable("Y", "Foo"))],
  ])("%s is rejected by name", (node, term: KInner) => {
    expect(() => kastToKorePure(term)).toThrow(`Unsupported KInner: ${node}`);
  });

  /**
   * The two are not inverses, and `\rewrites` is the only place it shows.
   * Deviation 7 decodes it (pyk raises); the result is a `KRewrite`, which the
   * forward fold then refuses. Java is symmetric here only because its
   * `KRewrite` carries the result sort in `Att.SORT()`
   * (`ModuleToKORE.java:2325-2333`) and `@kframework-ts/kast`'s does not, so
   * `\rewrites{S}` cannot be re-emitted without asking a definition for `S`.
   *
   * This is pinned rather than fixed: see "The `\rewrites` asymmetry" in
   * `README.md`. Nothing in the package's own pipelines hits it — `kruleToKore`
   * splits a rule's `KRewrite` into a sorted lhs/rhs pair before either side
   * reaches this fold.
   */
  test("a decoded \\rewrites cannot be re-encoded", () => {
    const pattern = parsePattern("\\rewrites{SortFoo{}}(VarX : SortFoo{}, VarY : SortFoo{})");
    const kast = koreToKastPure(pattern);
    expect(kast).toEqual(krewrite(kvariable("X", "Foo"), kvariable("Y", "Foo")));
    expect(() => kastToKorePure(kast)).toThrow("Unsupported KInner: KRewrite");
  });

  /**
   * The other three arms of that round trip do close, so the asymmetry above is
   * specific to `\rewrites` and not a general property of the pure tier.
   */
  test.each([
    ["\\forall", "\\forall{SortFoo{}}(VarX : SortBar{}, VarX : SortBar{})"],
    ["\\floor", "\\floor{SortBool{}, SortFoo{}}(VarX : SortBool{})"],
    ["an application", "Lblfoo{}(VarX : SortBar{})"],
  ])("%s survives the round trip unchanged", (_name, text) => {
    const pattern = parsePattern(text);
    expect(kastToKorePure(koreToKastPure(pattern))).toEqual(pattern);
  });
});

describe("Assoc", () => {
  /**
   * `\left-assoc`/`\right-assoc` are expanded at the root and at every child
   * push (`_kore_to_kast.py:48`, `:63`), which `simple-proofs.test.ts`'s
   * `left-assoc` and `right-assoc` rows pin. This is the expansion itself, in
   * isolation.
   */
  test("expandAssoc nests left and right", () => {
    expect(
      koreText(expandAssoc(parsePattern("\\left-assoc{}(Lblf{}(VarX : SortA{}, VarY : SortA{}, VarZ : SortA{}))"))),
    ).toBe("Lblf{}(Lblf{}(VarX : SortA{}, VarY : SortA{}), VarZ : SortA{})");
    expect(
      koreText(expandAssoc(parsePattern("\\right-assoc{}(Lblf{}(VarX : SortA{}, VarY : SortA{}, VarZ : SortA{}))"))),
    ).toBe("Lblf{}(VarX : SortA{}, Lblf{}(VarY : SortA{}, VarZ : SortA{}))");
  });

  test("a single-argument assoc is its argument", () => {
    expect(koreText(expandAssoc(parsePattern("\\left-assoc{}(Lblf{}(VarX : SortA{}))")))).toBe("VarX : SortA{}");
  });

  /**
   * `Assoc.flatten` on `\and`/`\or` chains (`KoreToK.scala:137-142`), which pyk
   * does not do. For the right-nested chains a `definition.kore` actually
   * contains the two agree exactly; the observable difference is that a
   * **left**-nested conjunction normalizes to the right-nested spelling.
   */
  test("a left-nested \\and normalizes to the right-nested KAST spelling", () => {
    const left = parsePattern(
      "\\and{SortBool{}}(\\and{SortBool{}}(VarA : SortBool{}, VarB : SortBool{}), VarC : SortBool{})",
    );
    const right = parsePattern(
      "\\and{SortBool{}}(VarA : SortBool{}, \\and{SortBool{}}(VarB : SortBool{}, VarC : SortBool{}))",
    );
    expect(koreToKastPure(left)).toEqual(koreToKastPure(right));
  });

  test("a nested \\and at a different sort is not spliced", () => {
    const kast = koreToKastPure(
      parsePattern("\\and{SortFoo{}}(\\and{SortBool{}}(VarA : SortBool{}, VarB : SortBool{}), VarC : SortFoo{})"),
    );
    expect(kast.node === "KApply" ? kast.args.length : undefined).toBe(2);
  });
});

describe("mangling — sorts out, not back", () => {
  /**
   * Both references are asymmetric here: pyk slices `[4:]`,
   * `KoreToK.scala:72` does `ctr.substring(4)`. So sort names are mangled on
   * the way out (Java does, at `ModuleToKORE.java:2048-2049`) and *not*
   * unmangled on the way back. Harmless for real, alphanumeric sort names —
   * recorded because the two directions disagreeing quietly is worse than the
   * asymmetry itself.
   */
  test("a sort name is mangled on the way out", () => {
    expect(koreText(ksortToKore(ksort("#Foo")))).toBe("Sort'Hash'Foo{}");
  });

  test("a sort name is NOT unmangled on the way back", () => {
    expect(sortToKast(sortApp("Sort'Hash'Foo")).name).toBe("'Hash'Foo");
    // i.e. the round trip is not the identity for a sort whose K name needs
    // mangling. Real sort names are alphanumeric, so this never bites; it is
    // asserted so that nobody "fixes" one half without the other.
    expect(sortToKast(ksortToKore(ksort("#Foo"))).name).not.toBe("#Foo");
  });

  /** Sort *parameters* are kept, which is what the general label mechanism needs. */
  test("sort parameters survive the way back", () => {
    expect(sortToKast(sortApp("SortList", [sortApp("SortInt")]))).toEqual(ksort("List", [ksort("Int")]));
  });

  /** The four pseudo-labels carry no `Lbl` prefix and are never mangled. */
  test.each(["inj", "kseq", "dotk", "append"])("the pseudo-label %s passes through", (label) => {
    expect(labelToKore(label)).toBe(label);
  });

  /** An ML label becomes its backslash symbol, not a mangled `Lbl…`. */
  test("an ML label becomes its symbol", () => {
    expect(labelToKore("#And")).toBe("\\and");
    expect(labelToKore("#Ceil")).toBe("\\ceil");
  });
});

describe("variables — the Var prefix is checked before it is stripped", () => {
  /**
   * pyk does `unmunge(name[3:])` blind (`_kore_to_kast.py:79`), which corrupts
   * every variable not spelled `Var…`. `KoreToK.extractVarName`
   * (`KoreToK.scala:102-107`) tests the prefix first.
   */
  test("a prefixed variable is stripped and demangled", () => {
    expect(varNameToKast("VarX'Unds'Y")).toBe("X_Y");
  });

  test("an unprefixed variable keeps its whole name", () => {
    // The `R` of every function-equation axiom. pyk turns it into the empty
    // name, which is not a legal `KVariable`.
    expect(varNameToKast("R")).toBe("R");
    expect(varNameToKast("Foo")).toBe("Foo");
  });

  /**
   * Set variables. Java emits `@Var<munged>` — the `@` precedes the `Var`
   * prefix (`ModuleToKORE.java:2313-2318`) — and both that and the bare `@X`
   * spelling decode to `@X`. pyk has no handling: `@X` becomes the *element*
   * variable `Var'-AT-'X`.
   */
  test("a set variable round-trips through @Var", () => {
    const kore = kastToKorePure(kvariable("@X", "Int"));
    expect(kore.tag).toBe("SVar");
    expect(koreText(kore)).toBe("@VarX : SortInt{}");
    expect(koreToKastPure(kore)).toEqual(kvariable("@X", "Int"));
  });

  test("an unsorted variable is SortK", () => {
    expect(koreText(kastToKorePure(kvariable("X")))).toBe("VarX : SortK{}");
  });
});

describe("the label and hook tables are Maps, not object literals", () => {
  /**
   * A plain object literal inherits every `Object.prototype` member as a
   * *string key*, so `ML_PATTERN_LABELS['toString']` would answer
   * `Object.prototype.toString`. A `KApply` labelled `toString` would therefore
   * routed to the quantifier branch and rejected with `Expected two sort
   * parameters`; `constructor` reached `mlPattern` with a function as its
   * symbol; `labelToKore('__proto__')` returned `Object.prototype` itself.
   *
   * They are all ordinary K labels. pyk's tables are `dict`s and have no such
   * inheritance, so it converts every one of them correctly — this was a
   * transcription artefact of spelling a Python `dict` as a JS object.
   */
  const POLLUTING = ["toString", "constructor", "valueOf", "hasOwnProperty", "__proto__", "isPrototypeOf"];

  test.each(POLLUTING)("a KApply labelled %s round-trips as an ordinary label", (name) => {
    const kast = kapply(klabel(name), [kvariable("X", "Int")]);
    const kore = kastToKorePure(kast);

    expect(kore.tag).toBe("App");
    expect(koreToKastPure(kore)).toEqual(kast);
  });

  test.each(POLLUTING)("labelToKore(%s) is a Lbl symbol", (name) => {
    const symbol = labelToKore(name);
    expect(typeof symbol).toBe("string");
    expect(symbol.startsWith("Lbl")).toBe(true);
  });

  /** `toString` is the one whose mangling is the identity, so it is pinned exactly. */
  test("toString mangles to LbltoString, as pyk emits", () => {
    expect(labelToKore("toString")).toBe("LbltoString");
    expect(koreText(kastToKorePure(kapply(klabel("toString"))))).toBe("LbltoString{}()");
  });

  /** The real quantifier labels are unaffected by the change. */
  test("the genuine ML labels still resolve", () => {
    expect(ML_PATTERN_LABELS.get("#And")).toBe("\\and");
    expect(ML_QUANT_LABELS.get("#Exists")).toBe("\\exists");
    expect(ML_PATTERN_LABELS.get("toString")).toBeUndefined();
    expect(ML_QUANT_LABELS.get("__proto__")).toBeUndefined();
  });

  /**
   * `Object.freeze` does not freeze a `Map`'s *contents* — `set` writes an
   * internal slot that `[[IsExtensible]] === false` does not guard — so the
   * shared default table has to deny the write itself. One `.set` behind a cast
   * would otherwise change how every later conversion in the process escapes
   * tokens.
   */
  test.each([
    [
      "set",
      (m: Map<string, string>): void => {
        m.set("Int", HOOK_STRING);
      },
    ],
    [
      "delete",
      (m: Map<string, string>): void => {
        m.delete("String");
      },
    ],
    [
      "clear",
      (m: Map<string, string>): void => {
        m.clear();
      },
    ],
  ])("DEFAULT_SORT_HOOKS.%s throws", (_name, mutate) => {
    expect(() => {
      mutate(asMutable(DEFAULT_SORT_HOOKS));
    }).toThrow("Cannot mutate a frozen map");
    expect(DEFAULT_SORT_HOOKS.get("String")).toBe(HOOK_STRING);
    expect(DEFAULT_SORT_HOOKS.get("Int")).toBeUndefined();
  });

  test.each([ML_CONN_LABELS, ML_QUANT_LABELS, ML_PRED_LABELS, ML_PATTERN_LABELS])(
    "an ML label table cannot be mutated either",
    (table) => {
      expect(() => asMutable(table).set("#And", "\\or")).toThrow("Cannot mutate a frozen map");
      expect(table.get("#And") ?? "\\and").toBe("\\and");
    },
  );

  /** The wrapper is still a well-behaved `ReadonlyMap` in every other respect. */
  test("the frozen table still iterates and forEaches", () => {
    expect([...DEFAULT_SORT_HOOKS.keys()]).toEqual(["String", "Bytes"]);
    expect([...DEFAULT_SORT_HOOKS.values()]).toEqual([HOOK_STRING, HOOK_BYTES]);
    expect(DEFAULT_SORT_HOOKS.size).toBe(2);
    expect(new Map(DEFAULT_SORT_HOOKS).get("Bytes")).toBe(HOOK_BYTES);

    const seen: [string, string][] = [];
    // The map handed to the callback must be the frozen view, never the
    // mutable map behind it.
    DEFAULT_SORT_HOOKS.forEach((value, key, map) => {
      seen.push([key, value]);
      expect(map).toBe(DEFAULT_SORT_HOOKS);
    });
    expect(seen).toEqual([
      ["String", HOOK_STRING],
      ["Bytes", HOOK_BYTES],
    ]);
  });
});

describe("Assoc.flatten is total, not one level deep", () => {
  /**
   * `Assoc.flatten` (`Assoc.scala:38-47`, reached from `KoreToK.scala:137-142`)
   * recurses into every same-label child. Splicing only the immediate operands
   * left a residual nested `#And` on anything deeper than two levels, which is
   * exactly the case the flattening exists to normalize.
   */
  test("a three-deep left-nested \\and flattens completely", () => {
    const kast = koreToKastPure(parsePattern(leftNestedAnd(3)));
    // Fully flat is the right-nested spelling of four operands: the flattening
    // yields [A, B, C, D] and `mlAnd` re-nests it to the right.
    expect(kast).toEqual(
      mlAnd(
        [kvariable("A", "Bool"), kvariable("B", "Bool"), kvariable("C", "Bool"), kvariable("D", "Bool")],
        ksort("Bool"),
      ),
    );
    expect(flattenLabel("#And", kast)).toHaveLength(4);
  });

  test("a three-deep right-nested \\and is the identity, as it always was", () => {
    const right = parsePattern(
      "\\and{SortBool{}}(VarA : SortBool{}, \\and{SortBool{}}(VarB : SortBool{}, \\and{SortBool{}}(VarC : SortBool{}, VarD : SortBool{})))",
    );
    expect(flattenLabel("#And", koreToKastPure(right))).toHaveLength(4);
  });

  /**
   * The sort guard survives the recursion: a child at a different sort is a
   * leaf, and *its* children are left alone even though they are at the outer
   * sort. `Assoc.flatten` matches on the whole `KLabel`, parameters included,
   * so this is Java's behaviour and not an addition.
   */
  test("a differently-sorted \\and blocks the recursion at that node", () => {
    const kast = koreToKastPure(
      parsePattern(
        "\\and{SortFoo{}}(\\and{SortBool{}}(\\and{SortFoo{}}(VarA : SortFoo{}, VarB : SortFoo{}), VarC : SortBool{}), VarD : SortFoo{})",
      ),
    );
    // The `#And{Foo}` buried inside the `#And{Bool}` is *not* lifted out, so
    // the outer conjunction still has exactly two operands. (`flattenLabel`
    // would say four: it matches on `label.name` alone, which is precisely why
    // it cannot be `flattenMl` unaided.)
    expect(kast).toEqual(
      mlAnd(
        [
          mlAnd(
            [mlAnd([kvariable("A", "Foo"), kvariable("B", "Foo")], ksort("Foo")), kvariable("C", "Bool")],
            ksort("Bool"),
          ),
          kvariable("D", "Foo"),
        ],
        ksort("Foo"),
      ),
    );
  });

  /** \or takes the same path. */
  test("a three-deep left-nested \\or flattens completely", () => {
    const kast = koreToKastPure(
      parsePattern(
        "\\or{SortBool{}}(\\or{SortBool{}}(\\or{SortBool{}}(VarA : SortBool{}, VarB : SortBool{}), VarC : SortBool{}), VarD : SortBool{})",
      ),
    );
    expect(flattenLabel("#Or", kast)).toHaveLength(4);
  });
});

describe("the empty KSequence is a term, not a falsy value", () => {
  /**
   * `mlAnd`/`mlOr` are `@kframework-ts/kast`'s `buildAssoc`, and pyk's
   * `build_assoc` (`kast/inner.py:912-932`) writes `if not res` /
   * `return res or unit`. `KSequence.__len__` makes `KSequence([])` **falsy**
   * in Python, so pyk silently discards an empty-sequence operand.
   *
   * pyk gives `V1` for the pattern below — the `.K` disjunct simply vanishes.
   * `.K` is an ordinary term, not an absence, so the truthiness test is a bug
   * and this keeps the disjunct. Pinned so that the difference is a decision
   * on record rather than a surprise in a diff against pyk.
   */
  test("\\or with a dotk operand keeps the operand (pyk drops it)", () => {
    expect(koreToKastPure(parsePattern("\\or{SortK{}}(VarV1 : SortK{}, dotk{}())"))).toEqual(
      kapply(klabel("#Or", [ksort("K")]), [kvariable("V1", "K"), ksequence([])]),
    );
  });

  test("\\and with a dotk operand keeps it too", () => {
    expect(koreToKastPure(parsePattern("\\and{SortK{}}(VarV1 : SortK{}, dotk{}())"))).toEqual(
      kapply(klabel("#And", [ksort("K")]), [kvariable("V1", "K"), ksequence([])]),
    );
  });
});

describe("arity checks on the fixed-signature symbols", () => {
  /**
   * pyk reads these counts by destructuring — `sort1, sort2 = pattern.sorts`
   * (`_kore_to_kast.py:88`), `() = pattern.sorts` (`:92`, `:95`), and
   * `sort1, sort2 = label.params` (`_kast_to_kore.py:425`) — so a mismatch is a
   * `ValueError` there rather than a silently-ignored extra. It raises here
   * too: `inj` erases a term, and erasing one whose signature is wrong would
   * hide whatever produced it.
   */
  test.each([
    ["inj with one sort", "inj{SortInt{}}(VarX : SortInt{})", "Expected 2 sort parameters on inj, got 1"],
    [
      "inj with three sorts",
      "inj{SortInt{}, SortK{}, SortK{}}(VarX : SortInt{})",
      "Expected 2 sort parameters on inj, got 3",
    ],
    ["dotk with a sort", "dotk{SortK{}}()", "Expected 0 sort parameters on dotk, got 1"],
    ["kseq with a sort", "kseq{SortK{}}(VarX : SortKItem{}, dotk{}())", "Expected 0 sort parameters on kseq, got 1"],
    [
      "append with a sort",
      "append{SortK{}}(VarX : SortK{}, VarY : SortK{})",
      "Expected 0 sort parameters on append, got 1",
    ],
  ])("%s is rejected", (_name, text, message) => {
    expect(() => koreToKastPure(parsePattern(text))).toThrow(message);
  });

  test.each([0, 1, 3])("a quantifier with %s sort parameters is rejected", (count) => {
    const params = Array.from({ length: count }, () => ksort("Foo"));
    expect(() =>
      kastToKorePure(kapply(klabel("#Exists", params), [kvariable("X", "Foo"), kvariable("X", "Foo")])),
    ).toThrow(`Expected two sort parameters on #Exists, got ${count}`);
  });

  test("the well-formed spellings still convert", () => {
    expect(koreToKastPure(parsePattern("inj{SortInt{}, SortKItem{}}(VarX : SortInt{})"))).toEqual(
      kvariable("X", "Int"),
    );
    expect(koreToKastPure(parsePattern("dotk{}()"))).toEqual(ksequence([]));
  });
});

describe("sortHooks is memoised per definition", () => {
  /**
   * Building the map is a full module × sentence walk over the whole
   * definition, and both `kastToKore` and `koreToKast` want it on *every* call
   * — which `kruleToKore` then multiplies by the constraints in a rule and
   * `kflatmoduleToKore` by the rules in a module. On a real `compiled.json` it
   * cost more than the conversion it serves.
   *
   * A `KDefinition` is deeply frozen, so a cached map can never go stale.
   */
  test("two calls return the identical instance", () => {
    expect(sortHooks(DEFINITION)).toBe(sortHooks(DEFINITION));
  });

  test("a different definition gets a different map", () => {
    const other = readKastDefinitionFromJson(
      readFileSync(join(import.meta.dir, "..", "fixtures", "definitions", "cell-map.compiled.json"), "utf8"),
    );
    expect(sortHooks(other)).not.toBe(sortHooks(DEFINITION));
    // `cell-map` declares no `String`; its own hooks are there instead.
    expect(sortHooks(other).get("AccountCellMap")).toBe("MAP.Map");
    expect(sortHooks(DEFINITION).get("AccountCellMap")).toBeUndefined();
  });

  /**
   * The map is shared now rather than freshly built per call, so it has to
   * deny writes: a caller mutating it would be rewriting every later
   * conversion against that definition.
   */
  test("the cached map cannot be mutated", () => {
    expect(() => asMutable(sortHooks(DEFINITION)).set("Int", HOOK_STRING)).toThrow("Cannot mutate a frozen map");
    expect(sortHooks(DEFINITION).get("Int")).toBe("INT.Int");
  });
});

describe("the subsort failure names the offending term", () => {
  /**
   * `Sort X is not a subsort of Y` is the contract — it is what
   * `KPrint.kast_to_kore` matches to fall back to the `kast` CLI — so the
   * prefix is asserted separately from the diagnostic tail. pyk interpolates
   * the term (`_kast_to_kore.py:219`); a message naming only two sorts is
   * unactionable in a configuration with thousands of subterms.
   */
  test("the contract prefix is intact and the term follows it", () => {
    const attempt = (): unknown => kastToKore(DEFINITION, kapply("baz"), { sort: ksort("Int") });
    expect(attempt).toThrow(/^Sort Baz is not a subsort of Int/);
    expect(attempt).toThrow("Sort Baz is not a subsort of Int: KApply(baz, 0 args)");
  });

  test.each([
    [intToken(3), "KToken(3, Int)"],
    [kvariable("X", "Int"), "KVariable(X)"],
    [kapply("_+Int_", [intToken(1), intToken(2)]), "KApply(_+Int_, 2 args)"],
  ])("the rendering is compact and top-level only", (term, rendering) => {
    expect(() => kastToKore(DEFINITION, term, { sort: ksort("Baz") })).toThrow(`is not a subsort of Baz: ${rendering}`);
  });
});
