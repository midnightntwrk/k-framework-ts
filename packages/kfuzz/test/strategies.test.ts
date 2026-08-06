/**
 * The domain-value arbitraries — `kintegers` (`kfuzz.py:112-135`) and the two
 * siblings this package adds.
 *
 * Every case uses `fc.sample` with a pinned seed, so the assertions are about
 * the *shape* the arbitrary produces, not about which values a particular
 * fast-check release happens to pick.
 */

import { describe, expect, test } from "bun:test";
import { koreText, type Pattern } from "@kframework-ts/kore";
import { bytesDv, BYTES } from "@kframework-ts/kore/prelude";
import * as fc from "fast-check";

import { fromDomainValues, kbools, kintegers, kstrings } from "../src/strategies.ts";

const SEED = 20250806;

function samples(arbitrary: fc.Arbitrary<Pattern>, numRuns = 200): readonly Pattern[] {
  return fc.sample(arbitrary, { seed: SEED, numRuns });
}

describe("kintegers", () => {
  test("produces \\dv{SortInt{}} domain values", () => {
    for (const pattern of samples(kintegers())) {
      expect(pattern.tag).toBe("DV");
      expect(koreText(pattern)).toMatch(/^\\dv\{SortInt\{\}\}\("-?\d+"\)$/u);
    }
  });

  test("honours both bounds, inclusively", () => {
    const values = samples(kintegers({ minValue: -3, maxValue: 5 })).map((pattern) =>
      BigInt(koreText(pattern).slice('\\dv{SortInt{}}("'.length, -2)),
    );
    for (const value of values) {
      expect(value >= -3n).toBe(true);
      expect(value <= 5n).toBe(true);
    }
    // A nine-value range over 200 draws should reach both ends.
    expect(values).toContain(-3n);
    expect(values).toContain(5n);
  });

  test("accepts bigint bounds and generates beyond 2^53", () => {
    const big = 2n ** 90n;
    const values = samples(kintegers({ minValue: big, maxValue: big + 4n }), 50);
    for (const pattern of values) expect(koreText(pattern)).toContain(String(big).slice(0, 20));
  });

  test("a non-integral number bound is a RangeError, not a truncation", () => {
    expect(() => kintegers({ maxValue: 1.5 })).toThrow(RangeError);
  });

  test("withInj wraps the value in an injection, and takes the *bare* sort name", () => {
    // `with_inj='AExp'` → `Sort{with_inj}` (`kfuzz.py:132`). Passing 'SortAExp'
    // would produce SortSortAExp — upstream's wart, kept.
    const [pattern] = samples(kintegers({ minValue: 1, maxValue: 1, withInj: "AExp" }), 1);
    expect(koreText(pattern!)).toBe('inj{SortInt{}, SortAExp{}}(\\dv{SortInt{}}("1"))');
  });

  test("without withInj there is no injection at all", () => {
    const [pattern] = samples(kintegers({ minValue: 1, maxValue: 1 }), 1);
    expect(koreText(pattern!)).toBe('\\dv{SortInt{}}("1")');
  });
});

describe("kbools and kstrings — this package's additions", () => {
  test("kbools produces the two Bool domain values and nothing else", () => {
    const texts = new Set(samples(kbools()).map((pattern) => koreText(pattern)));
    expect([...texts].toSorted()).toEqual(['\\dv{SortBool{}}("false")', '\\dv{SortBool{}}("true")']);
  });

  test("kbools injects like kintegers does", () => {
    for (const pattern of samples(kbools({ withInj: "BExp" }), 10)) {
      expect(koreText(pattern)).toMatch(/^inj\{SortBool\{\}, SortBExp\{\}\}\(/u);
    }
  });

  test("kstrings honours its length bounds and escapes through kore", () => {
    for (const pattern of samples(kstrings({ minLength: 2, maxLength: 4 }), 50)) {
      const text = koreText(pattern);
      expect(text.startsWith('\\dv{SortString{}}("')).toBe(true);
      expect(text.endsWith('")')).toBe(true);
    }
  });
});

describe("fromDomainValues", () => {
  test("lifts any arbitrary into the same shape", () => {
    const arbitrary = fromDomainValues(fc.constant(new Uint8Array([1, 2])), bytesDv, BYTES, { withInj: "Word" });
    const [pattern] = fc.sample(arbitrary, { seed: SEED, numRuns: 1 });
    expect(koreText(pattern!)).toMatch(/^inj\{SortBytes\{\}, SortWord\{\}\}\(\\dv\{SortBytes\{\}\}\(/u);
  });
});
