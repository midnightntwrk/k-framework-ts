/**
 * Corpus #1 — pyk's `munge`/`unmunge` table, 214 pairs, both directions.
 *
 * The oracle is `fixtures/upstream/munge-tests`, vendored byte-for-byte from
 * `k/pyk/src/tests/unit/test-data/munge-tests` and driven upstream by
 * `test_konvert.py:36-49`.  It is **read** here rather than transcribed: the
 * file is in the tree, and a data-driven read cannot silently disagree with it
 * the way a hand-copied table can.  (`@kframework-ts/kore`'s
 * `test/demangle.test.ts` transcribes the same 214 rows as literals; that copy
 * pins the table against a checked-in constant, this one pins it against the
 * bytes upstream ships.  Two independent readings of one corpus is the point.)
 *
 * # Why this corpus lives in `konvert`'s suite at all
 *
 * `konvert` ships **no mangling code**: `_utils.py`'s `munge`/`unmunge` are
 * covered by `@kframework-ts/kore`'s `mangleName`/`demangleName` as a strict
 * superset.  So this suite asserts the *contract*
 * `konvert` depends on, at the boundary where it depends on it — and then goes
 * on to record the two places where the superset is a superset, i.e. where our
 * behaviour deliberately differs from pyk's and pyk is the one that is wrong.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { demangleName, mangleName } from "@kframework-ts/kore";

import { labelToKast, labelToKore } from "../src/pure.ts";

const MUNGE_TESTS = join(import.meta.dir, "..", "fixtures", "upstream", "munge-tests");

/**
 * The file's format is three-line groups — label, symbol, blank — which is what
 * `test_konvert.py:15-33` reads.  A trailing newline leaves one empty element,
 * dropped by the length check.
 */
function readMungeTests(): readonly (readonly [string, string])[] {
  const lines = readFileSync(MUNGE_TESTS, "utf8").split("\n");
  const pairs: [string, string][] = [];
  for (let i = 0; i + 1 < lines.length; i += 3) {
    const label = lines[i];
    const symbol = lines[i + 1];
    if (label === undefined || symbol === undefined || label === "") continue;
    pairs.push([label, symbol]);
  }
  return pairs;
}

const MUNGE_TEST_DATA = readMungeTests();

describe("munge-tests, the vendored corpus", () => {
  test("the fixture holds 214 pairs", () => {
    expect(MUNGE_TEST_DATA.length).toBe(214);
  });

  describe("mangleName — pyk `munge`", () => {
    for (const [label, symbol] of MUNGE_TEST_DATA) {
      test(label, () => {
        expect(mangleName(label)).toBe(symbol);
      });
    }
  });

  describe("demangleName — pyk `unmunge`", () => {
    for (const [label, symbol] of MUNGE_TEST_DATA) {
      test(symbol, () => {
        expect(demangleName(symbol)).toBe(label);
      });
    }
  });
});

/**
 * Where we deliberately disagree with pyk.
 *
 * All 214 rows above pass under both implementations — the corpus is real
 * `kompile` labels, and real labels contain neither an unmapped character nor a
 * KORE keyword, which is exactly why pyk's two bugs have never bitten upstream.
 * These are the inputs that separate them, asserted as **our** behaviour with
 * pyk's recorded alongside.
 */
describe("deliberate divergences from pyk's munge", () => {
  /**
   * `_utils.munge` (`_utils.py:53-66`) passes any character absent from
   * `MUNGE_TABLE` straight through, so a label containing one produces a symbol
   * that is not a legal KORE identifier at all.  `StringUtil.encodeStringToAlphanumeric`
   * (`:529-559`) emits `%04x`, and `mangleName` does the same.
   */
  test("an unmapped character is escaped as %04x, not passed through", () => {
    expect(labelToKore("é")).toBe("Lbl'00e9'");
    expect(labelToKast("Lbl'00e9'")).toBe("é");
    // pyk would emit `Lblé`, which no KORE lexer accepts.
  });

  /**
   * pyk applies the `'Kywd'` suffix in `_module_to_kore.name_to_kore:144` but
   * not in `_kast_to_kore._label_to_kore:443`, so the same label mangles two
   * different ways depending on which pyk entry point you came in through.
   * `ModuleToKORE.convert(String, StringBuilder)` (`:2170-2188`) is one static
   * method used for labels, variables *and* sorts, so Java applies it
   * everywhere; so does `mangleName`.
   */
  test("a KORE keyword takes the 'Kywd' suffix in the term path too", () => {
    expect(labelToKore("axiom")).toBe("Lblaxiom'Kywd'");
    expect(labelToKore("module")).toBe("Lblmodule'Kywd'");
    // pyk's term path would emit `Lblaxiom`, which collides with the keyword.
  });

  /**
   * `Lbl` is stripped **once**.  `KoreToK.extractKLabel` (`KoreToK.scala:79-83`)
   * recurses, so a K label literally spelled `Lblah` — which mangles to
   * `LblLblah` — comes back from Java as `ah`.  pyk slices once
   * (`_kore_to_kast.py:101`) and is right; this follows pyk.
   */
  test("Lbl is stripped once, not recursively", () => {
    expect(labelToKore("Lblah")).toBe("LblLblah");
    expect(labelToKast("LblLblah")).toBe("Lblah");
    // Java's `extractKLabel` answers `ah` here.
  });

  /**
   * A symbol with no `Lbl` prefix decodes as itself rather than losing three
   * characters — `extractKLabel`'s else branch. pyk's blind `symbol[3:]` would
   * turn `kseq` into `q`; the four pseudo-labels never reach the general path
   * in either implementation, but `labelToKast` is a public function and a
   * caller can hand it anything.
   */
  test("a symbol without the Lbl prefix decodes as itself", () => {
    expect(labelToKast("dotk")).toBe("dotk");
  });
});

/**
 * Corpus #8 — `StringUtilTest.decodeKoreString`, two rows.
 *
 * Transcribed from
 * `k/k-frontend/src/test/java/org/kframework/utils/StringUtilTest.java:36-49`.
 * It is the **only** unit test in the whole Java toolchain that touches the
 * KORE encoding — neither `ModuleToKORE.convert` nor `KoreToK.scala` has one —
 * which makes these two rows free parity against the reference implementation,
 * and the reason they are worth having despite being a subset of the 214 above.
 *
 * The Java test asserts both directions, with the encoder called explicitly as
 * `encodeStringToAlphanumeric(buffer, s, asciiReadableEncodingKore, identChar, "'")`
 * — the same three arguments `ModuleToKORE.convert(String, StringBuilder)`
 * passes, i.e. the KORE table, not the default one.
 */
describe("StringUtilTest.decodeKoreString — Java's own two rows", () => {
  test("'Unds'V'Unds'9 ↔ _V_9", () => {
    expect(demangleName("'Unds'V'Unds'9")).toBe("_V_9");
    expect(mangleName("_V_9")).toBe("'Unds'V'Unds'9");
  });

  test("'QuesUnds'0 ↔ ?_0", () => {
    expect(demangleName("'QuesUnds'0")).toBe("?_0");
    expect(mangleName("?_0")).toBe("'QuesUnds'0");
  });
});
