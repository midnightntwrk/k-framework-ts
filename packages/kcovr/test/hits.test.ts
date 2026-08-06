/**
 * `createCoverMap` — `kcovr.py:197-217`, the counting half.
 *
 * The one fact this format hides is that a hit log is a **log**: the same rule
 * id appears once per application, and the number Cobertura wants is the count,
 * not the presence.  `fixtures/cov-build/pid-large_coverage.txt` is 362 lines
 * naming 31 rules, so it pins the difference by 331 to 0.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { createCoverMap, totalHits } from "../src/hits.ts";

const FIXTURES = join(import.meta.dir, "..", "fixtures");
const read = (rel: string): string => readFileSync(join(FIXTURES, rel), "utf8");

const SMALL = read("cov-build/pid-small_coverage.txt");
const MID = read("cov-build/pid-mid_coverage.txt");
const LARGE = read("cov-build/pid-large_coverage.txt");

describe("counter semantics", () => {
  test("the 362-line log counts applications, not rules", () => {
    const coverMap = createCoverMap([LARGE]);
    // 31 distinct ids…
    expect(coverMap.size).toBe(31);
    // …applied 362 times between them.  A `Set` would lose 331 of these.
    expect(totalHits(coverMap)).toBe(362);
    expect(Math.max(...coverMap.values())).toBeGreaterThan(1);
  });

  test("duplicates increment rather than overwrite", () => {
    const id = "a".repeat(64);
    expect(createCoverMap([`${id}\n${id}\n${id}\n`]).get(id)).toBe(3);
  });

  test("a rule that never fired is absent, never zero", () => {
    const coverMap = createCoverMap([`${"a".repeat(64)}\n`]);
    expect(coverMap.has("b".repeat(64))).toBe(false);
    expect([...coverMap.values()]).not.toContain(0);
  });

  test("the one-line log is the degenerate case, not an error", () => {
    const coverMap = createCoverMap([SMALL]);
    expect(coverMap.size).toBe(1);
    expect(totalHits(coverMap)).toBe(1);
  });
});

describe("line handling", () => {
  test("an empty text contributes nothing — the empty coverage.txt case", () => {
    expect(createCoverMap([""]).size).toBe(0);
    expect(read("cov-build/coverage.txt")).toBe("");
  });

  test("blank lines are skipped, where pyk would record an empty rule id", () => {
    // `for line in f: add_cover(line.strip())` (kcovr.py:207-209) has no
    // emptiness check, so upstream records `''` and then dies at `:254`.
    const id = "a".repeat(64);
    const coverMap = createCoverMap([`${id}\n\n   \n${id}\n`]);
    expect(coverMap.has("")).toBe(false);
    expect(coverMap.get(id)).toBe(2);
    expect(coverMap.size).toBe(1);
  });

  test("a trailing newline does not invent a hit", () => {
    const id = "a".repeat(64);
    expect(totalHits(createCoverMap([`${id}\n`]))).toBe(1);
    expect(totalHits(createCoverMap([id]))).toBe(1);
  });

  test("CRLF logs read the same as LF ones — `.strip()` takes both", () => {
    const id = "a".repeat(64);
    expect(createCoverMap([`${id}\r\n${id}\r\n`]).get(id)).toBe(2);
  });
});

describe("merging", () => {
  test("several logs from one directory merge into one counter", () => {
    const coverMap = createCoverMap([SMALL, MID, LARGE]);
    // PROVENANCE: the three logs together hit 40 distinct rules.
    expect(coverMap.size).toBe(40);
    expect(totalHits(coverMap)).toBe(1 + 123 + 362);
  });

  test("merging is order-independent and associative", () => {
    const one = createCoverMap([SMALL, MID, LARGE]);
    const other = createCoverMap([LARGE, SMALL, MID]);
    expect([...other.keys()].toSorted()).toEqual([...one.keys()].toSorted());
    for (const [id, count] of one) expect(other.get(id)).toBe(count);
    // Which is why "several logs" and "several definition directories" are the
    // same operation upstream (`kcovr.py:205-215`) and the same call here.
    expect(createCoverMap([`${SMALL}\n${MID}`, LARGE].values()).size).toBe(40);
  });
});
