/**
 * Transcribed from `pyk/src/tests/unit/kast/test_count_vars.py` at K v7.1.337.
 *
 * All 14 rows.  pyk compares a `Counter` against a plain `dict`, which is a
 * value comparison in Python; `countVars` returns a `Map`, so the rows compare
 * against a record built from it.
 */

import { describe, expect, test } from "bun:test";
import type { KInner } from "../src/inner.ts";
import { countVars } from "../src/manip.ts";
import { a, b, c, f, g, h, x, y, z } from "./helpers.ts";

/** `test_count_vars.py:19`. */
const TEST_DATA: readonly (readonly [KInner, Readonly<Record<string, number>>])[] = [
  [a, {}],
  [x, { x: 1 }],
  [f(a), {}],
  [f(a, b, c), {}],
  [f(x), { x: 1 }],
  [f(f(f(x))), { x: 1 }],
  [f(x, a), { x: 1 }],
  [f(x, x), { x: 2 }],
  [f(x, y), { x: 1, y: 1 }],
  [f(x, y, z), { x: 1, y: 1, z: 1 }],
  [f(x, g(y), h(z)), { x: 1, y: 1, z: 1 }],
  [f(x, a, g(y, b), h(z, c)), { x: 1, y: 1, z: 1 }],
  [f(x, g(x, y), h(x, z)), { x: 3, y: 1, z: 1 }],
  [f(x, g(x, h(x, y, z))), { x: 3, y: 1, z: 1 }],
];

describe("countVars", () => {
  TEST_DATA.forEach(([term, expected], i) => {
    test(String(i), () => {
      expect(Object.fromEntries(countVars(term))).toEqual(expected);
    });
  });
});
