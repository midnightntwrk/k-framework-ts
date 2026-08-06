/**
 * The four `regression-new` KORE→KAST goldens.
 *
 * These are the only **third-party** oracles this package has for the reverse
 * direction — everything else in it is either a pyk table or a pyk-derived
 * expectation.  The inputs are committed `.kore` files from
 * `k/k-distribution/tests/regression-new/`; the expected side is what the K
 * v7.1.337 `kast --input kore --output json` binary produced from them, i.e.
 * `KoreToK.scala`'s output, re-derived locally because upstream's committed
 * expectation is *pretty-printed K* and this repository has no pretty-printer.
 * `fixtures/PROVENANCE.md` records every invocation.
 *
 * | dir                          | what it pins                                                        |
 * | ---------------------------- | ------------------------------------------------------------------- |
 * | `issue-2356-koreDecode`      | all five KORE-table overrides (`^ - _ < > &`), plus kseq/dotk/inj    |
 * | `kast-kore-input`            | ML patterns and variables — including the only committed `@X` fixture |
 * | `poly-unparsing`             | `\ceil` and a label carrying sort parameters                        |
 * | `issue-1682-korePrettyPrint` | `inj` erasure and `Lbl` stripping                                    |
 *
 * All four run against {@link koreToKastPure}: none of them needs a definition,
 * which is the pure tier's whole claim.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { fromDict, type KInner, kastTerm } from "@kframework-ts/kast";
import { parsePattern } from "@kframework-ts/kore";

import { koreToKastPure } from "../src/pure.ts";

const FIXTURES = join(import.meta.dir, "..", "fixtures");

function koreInput(dir: string, name: string): string {
  return readFileSync(join(FIXTURES, "upstream", "regression-new", dir, name), "utf8");
}

function expectedKast(dir: string, name: string): KInner {
  const doc: unknown = JSON.parse(
    readFileSync(join(FIXTURES, "derived", "regression-new", dir, `${name}.json`), "utf8"),
  );
  return fromDict(kastTerm(doc));
}

/** Every `<dir>, <file>` pair `fixtures/derived/regression-new/` carries. */
const GOLDENS: readonly (readonly [string, string])[] = [
  ["issue-2356-koreDecode", "result.kore.kast"],
  ["kast-kore-input", "kast-in1.kast"],
  ["kast-kore-input", "kast-in2.kast"],
  ["kast-kore-input", "kast-in3.kast"],
  ["poly-unparsing", "test1.kore.kast"],
  ["issue-1682-korePrettyPrint", "2.kast"],
];

describe("regression-new KORE→KAST goldens", () => {
  for (const [dir, name] of GOLDENS) {
    test(`${dir}/${name}`, () => {
      expect(koreToKastPure(parsePattern(koreInput(dir, name)))).toEqual(expectedKast(dir, name));
    });
  }
});

/**
 * What each golden is *for*, asserted individually so that a regression names
 * itself instead of showing up as one opaque deep-equality failure.
 */
describe("what the goldens pin", () => {
  test("issue-2356: all five KORE-table overrides survive a round trip", () => {
    const kast = koreToKastPure(parsePattern(koreInput("issue-2356-koreDecode", "result.kore.kast")));
    const labels: string[] = [];
    const stack: KInner[] = [kast];
    for (let term = stack.pop(); term !== undefined; term = stack.pop()) {
      if (term.node === "KApply") {
        labels.push(term.label.name);
        stack.push(...term.args);
      } else if (term.node === "KSequence") {
        stack.push(...term.items);
      }
    }
    // `^ - _ < > &` are the five characters whose KORE mnemonics differ from
    // the default table (`Xor-`, and the `-LT-`/`-GT-`/`-AT-` family), which is
    // what makes this the strongest demangling fixture in the ecosystem.
    expect(labels).toContain("#fail_TEST-SYNTAX_Exp");
    expect(labels).toContain("?_0_TEST-SYNTAX_Exp");
    expect(labels).toContain("_V_9_TEST-SYNTAX_Exp");
    expect(labels).toContain("^-_<>&_TEST-SYNTAX_Exp");
  });

  /**
   * The one committed set-variable fixture in the K repository, and the reason
   * `pure.ts` deviates from pyk on `@`: pyk would produce the *element*
   * variable `Var'-AT-'X`.
   */
  test("kast-in3: the set variable survives as @X", () => {
    const kast = koreToKastPure(parsePattern(koreInput("kast-kore-input", "kast-in3.kast")));
    expect(kast.node).toBe("KApply");
    const arg = kast.node === "KApply" ? kast.args[0] : undefined;
    expect(arg?.node).toBe("KVariable");
    expect(arg?.node === "KVariable" ? arg.name : undefined).toBe("@X");
  });

  /**
   * `@VarX` — what `ModuleToKORE.java:2313-2318` and this package's own
   * `kvariableToKore` emit — decodes to the same `@X` the bare `@X` spelling
   * does. The fixture only carries the bare spelling, so this is the half of
   * the contract no committed fixture covers.
   */
  test("the @Var spelling decodes to the same variable", () => {
    expect(koreToKastPure(parsePattern("@VarX:SortInt{}"))).toEqual(koreToKastPure(parsePattern("@X:SortInt{}")));
  });

  /**
   * The fixture for the general parametric-label mechanism. pyk hardcodes
   * `Lblite` and would raise `Unsupported polymorphic operator` on anything
   * else; here the parameters are simply kept, and `#Ceil` — an ML pattern, not
   * even an `App` — carries two of them.
   */
  test("poly-unparsing: a label carries its sort parameters", () => {
    const kast = koreToKastPure(parsePattern(koreInput("poly-unparsing", "test1.kore.kast")));
    expect(kast.node).toBe("KApply");
    if (kast.node !== "KApply") return;
    expect(kast.label.name).toBe("#Ceil");
    expect(kast.label.params.map((p) => p.name)).toEqual(["Int", "GeneratedTopCell"]);
  });

  test("issue-1682: inj is erased and Lbl is stripped", () => {
    const kast = koreToKastPure(parsePattern(koreInput("issue-1682-korePrettyPrint", "2.kast")));
    expect(kast.node).toBe("KApply");
    expect(kast.node === "KApply" ? kast.label.name : undefined).toBe("pred1");
  });
});

/**
 * The cheapest available check that the derivation recipe in
 * `fixtures/PROVENANCE.md` is the right one: `issue-1682-korePrettyPrint`'s
 * `Makefile` sets no `--output`, so `kast` defaults to textual KAST and its
 * committed `2.kast.out` **is** the expected KAST.  Ours matches it byte for
 * byte, which means the other three derivations — whose upstream expectation is
 * pretty-printed K and therefore uncheckable — were produced the same way.
 */
test("the one directly-committed KAST golden matches the derivation", () => {
  const upstream = readFileSync(
    join(FIXTURES, "upstream", "regression-new", "issue-1682-korePrettyPrint", "2.kast.out"),
    "utf8",
  );
  const derived = readFileSync(
    join(FIXTURES, "derived", "regression-new", "issue-1682-korePrettyPrint", "2.kast.kast"),
    "utf8",
  );
  expect(derived).toBe(upstream);
});
