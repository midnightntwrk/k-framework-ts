/**
 * The conformance test: this package's parse, rendered in `kore-proof-trace`'s
 * own format, must be **byte-identical** to what `kore-proof-trace` printed.
 *
 * This is the strongest check available for a binary reader, and it is the one
 * that makes the rest of the suite believable.  It covers, in one diff and over
 * three real traced runs:
 *
 * - the rich header's three tables (every symbol tag in every term resolves);
 * - every binary-KORE 2.0 term in the stream, structure and domain values;
 * - all eight event kinds the fixtures exercise, their fields and their order;
 * - the ordinal → label/source/line join, over 200+ resolutions per run.
 *
 * The reference output is checked in (`fixtures/hints/*.trace.txt`) so this runs
 * with no K installed; `fixtures/PROVENANCE.md` has the exact commands that
 * produced it, and `live-k.test.ts` regenerates and re-diffs it when K is
 * available.
 */

import { describe, expect, test } from "bun:test";
import { parseDefinition } from "@kframework-ts/kore";

import { ordinalRuleIndex } from "../src/ordinals.ts";
import { renderReference, runDefinition, runHeader, runHints, runReference, type RunName } from "./support.ts";

const NAMES: readonly RunName[] = ["addRewrite", "guardedBig", "guardedSmall"];

describe("kore-proof-trace conformance", () => {
  for (const name of NAMES) {
    test(`${name} renders byte-identically to the reference tool`, () => {
      const rules = ordinalRuleIndex(parseDefinition(runDefinition(name), { lazyAxioms: true }));
      expect(renderReference(runHints(name), runHeader(name), rules)).toBe(runReference(name));
    });
  }

  test("the two-argument invocation drops the label and location brackets", () => {
    // `print_debug_info()` is false when no definition was passed
    // (`ProofTraceParser.h:65-72`), which is the only difference between the
    // two invocations — so the rendering without an index must be the
    // rendering with one, with the brackets removed.
    const withRules = renderReference(
      runHints("addRewrite"),
      runHeader("addRewrite"),
      ordinalRuleIndex(parseDefinition(runDefinition("addRewrite"), { lazyAxioms: true })),
    );
    const without = renderReference(runHints("addRewrite"), runHeader("addRewrite"), undefined);
    expect(without).toBe(withRules.replaceAll(/^(rule: \d+ \d+) \[.*] \[.*]$/gm, "$1"));
  });
});
