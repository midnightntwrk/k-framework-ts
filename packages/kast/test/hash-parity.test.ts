/**
 * Hash parity with pyk — the oracle that pins the canonical-JSON byte format.
 *
 * `hashOf` is only useful if it agrees with `KAst.hash` (`kast.py:32-35`),
 * because a pyk term hash is an identity that appears in pyk artifacts (a KCFG
 * node id is one of these strings).  Agreement rests on reproducing
 * `json.dumps(to_dict(), sort_keys=True)` byte for byte: CPython's default
 * `", "` / `": "` separators, sorted keys, and `ensure_ascii` escaping — which
 * is why the table below leans on tokens full of unicode, astral characters,
 * control characters and backslashes.  A one-byte drift in any of that shows
 * up here and nowhere else.
 *
 * # Regenerating
 *
 * The digests are pyk's own, generated once at K **v7.1.337** and committed.
 * `K` below is a checkout of `runtimeverification/k` at that tag; the pyk
 * *installed* on a machine is usually a different release and will not do — at
 * v7.1.191, for one, `KSort.to_dict` emits no `params` and every digest here
 * changes.
 *
 * ```sh
 * PYTHONPATH=$K/pyk/src python3 - <<'PY'
 * from pyk.kast.inner import KApply, KAs, KLabel, KRewrite, KSequence, KSort, KToken, KVariable
 * INT, STRING = KSort('Int'), KSort('String')
 * a, b, c = KApply('a'), KApply('b'), KApply('c')
 * x, y = KVariable('x'), KVariable('y')
 * deep = KVariable('x')
 * for _ in range(50):
 *     deep = KApply('f', [deep])
 * TERMS = [
 *     ('nullary-apply', a),
 *     ('unsorted-variable', x),
 *     ('sorted-variable', KVariable('V', INT)),
 *     ('int-token', KToken('1', INT)),
 *     ('unicode-token', KToken('"héllo ☃ \U0001d11e"', STRING)),
 *     ('escaped-token', KToken('a\tb\nc\\"d', STRING)),
 *     ('control-token', KToken('\x00\x01\x1f\x7f', STRING)),
 *     ('apply-with-args', KApply('f', [a, b, c])),
 *     ('parametric-label', KApply(KLabel('inj', [INT, KSort('KItem')]), [x])),
 *     ('empty-sequence', KSequence([])),
 *     ('sequence', KSequence([a, b, x])),
 *     ('rewrite', KRewrite(KApply('f', [x]), KApply('g', [y]))),
 *     ('as', KAs(KApply('f', [x]), y)),
 *     ('parametric-sort', KToken('t', KSort('Map', [INT, KSort('Set', [STRING])]))),
 *     ('kitchen-sink', KApply('<k>', [KSequence([KRewrite(KAs(a, x), KToken('0', INT)), KVariable('W', KSort('K'))])])),
 *     ('deep-50', deep),
 * ]
 * for name, term in TERMS:
 *     print(f'{name}\t{term.hash}')
 * PY
 * ```
 */

import { describe, expect, test } from "bun:test";
import { canonicalJson, hashOf } from "../src/eq.ts";
import { kapply, kas, klabel, krewrite, ksequence, ksort, ktoken, kvariable, type KInner } from "../src/inner.ts";
import { toDict } from "../src/json.ts";
import { INT, STRING, a, b, c, x, y } from "./helpers.ts";

function deepChain(depth: number): KInner {
  let term: KInner = kvariable("x");
  for (let i = 0; i < depth; i++) term = kapply("f", [term]);
  return term;
}

/** `[id, term, pyk's KAst.hash at v7.1.337]`. */
const PARITY_TABLE: readonly (readonly [string, KInner, string])[] = [
  ["nullary-apply", a, "a35ad30e3645026651db4ae4766743472a05e2f2dc9ab37c296f84e84f94a205"],
  ["unsorted-variable", x, "9d1dc6af5c3660eeb61cd96bbc9d71f41186bcaafa474ff7acaeef9d9ed66dd8"],
  ["sorted-variable", kvariable("V", INT), "2b0f86101ed4a2a9aa547350edaded8c00ce31c1f457c66b5caf6c7661c77bce"],
  ["int-token", ktoken("1", INT), "685356653550ef563b2209bcdf23f31bbd7bd308076ec1a8242f2bf22f1ec965"],
  [
    // A quoted String token holding a latin-1 character, a BMP character and an
    // astral one — the last is the surrogate-pair case.
    "unicode-token",
    ktoken('"héllo ☃ \u{1d11e}"', STRING),
    "9ca0c458d57542944c10531f13964d568298e2790c4adfe426cb0bdf4304d81a",
  ],
  [
    // Tab, newline, backslash and quote — the five short escapes minus \b and \f.
    "escaped-token",
    ktoken('a\tb\nc\\"d', STRING),
    "7bc8ec2745a2d49a8cb642fcf25180e03793cc6bd218cbe3b4becbd6801ab275",
  ],
  [
    // NUL, SOH, US and DEL: control characters with no short escape, plus the
    // one above `~` that `[^\ -~]` still catches.
    "control-token",
    ktoken("\u0000\u0001\u001f\u007f", STRING),
    "6a2563b9bac2b554e9baa0a627f5c4412dc99282981e729976211fd92b2c688a",
  ],
  ["apply-with-args", kapply("f", [a, b, c]), "247c020a2f7590c3687abde2edd12222cbd1c53ef9eda6ea0680fdb9a5392341"],
  [
    "parametric-label",
    kapply(klabel("inj", [INT, ksort("KItem")]), [x]),
    "19b8caf701346a7338e95abf50da653a0a8a22f7a32175da4492d628a67bb173",
  ],
  ["empty-sequence", ksequence([]), "f3bce447dc6c5c280980d08058a04a4a85ff9dabcab9c5cd0bd66dfc7d40d90b"],
  ["sequence", ksequence([a, b, x]), "4556a691cb2ef6cbd5401df27337367d455bfe6ec25732466bc7d9665d59ead5"],
  [
    "rewrite",
    krewrite(kapply("f", [x]), kapply("g", [y])),
    "71d902486666f19f4d8c3b425853cfb74bfd9a8adc5e48073543d07dd95ac6f1",
  ],
  ["as", kas(kapply("f", [x]), y), "c4bd7b789d4da4b94ef1281ac59f9cdd59bd38a9df1d0aad5c8fbff6ed6e2673"],
  [
    "parametric-sort",
    ktoken("t", ksort("Map", [INT, ksort("Set", [STRING])])),
    "9a37121e01d98bd8d47610f11a40063ebad1ce00d816930672bbf6ca9e0ce6cb",
  ],
  [
    "kitchen-sink",
    kapply("<k>", [ksequence([krewrite(kas(a, x), ktoken("0", INT)), kvariable("W", ksort("K"))])]),
    "a547b453f292842ef7dfd61c0a03256167ac071571fe8d3266ac6b00828d659b",
  ],
  ["deep-50", deepChain(50), "148337533342b5fd041b0c5c04148fd4ab6771903866a5022043aaed37c8e76d"],
];

describe("hashOf matches pyk 7.1.337", () => {
  for (const [id, term, expected] of PARITY_TABLE) {
    test(id, () => {
      expect(hashOf(term)).toBe(expected);
    });
  }
});

describe("canonical JSON", () => {
  test("uses CPython's default separators and sorts keys", () => {
    // `json.dumps` with neither `indent` nor `separators` writes `", "` and
    // `": "`; `sort_keys=True` puts `args` before `arity` ("g" sorts before
    // "i") before `label`, before `node`, before `variable`.
    expect(canonicalJson(toDict(kapply("f", [x])))).toBe(
      '{"args": [{"name": "x", "node": "KVariable"}], "arity": 1, ' +
        '"label": {"name": "f", "node": "KLabel", "params": []}, "node": "KApply", "variable": false}',
    );
  });

  test("escapes exactly what ensure_ascii escapes", () => {
    expect(canonicalJson('a\tb\nc\\"d')).toBe('"a\\tb\\nc\\\\\\"d"');
    expect(canonicalJson("\u0000\u0001\u001f\u007f")).toBe('"\\u0000\\u0001\\u001f\\u007f"');
    expect(canonicalJson("☃")).toBe('"\\u2603"');
    // An astral character becomes its surrogate pair, lowercase.
    expect(canonicalJson("\u{1d11e}")).toBe('"\\ud834\\udd1e"');
    // Space and tilde are the boundaries of the literal range.
    expect(canonicalJson(" ~")).toBe('" ~"');
  });

  test("memoises without changing the answer", () => {
    const term = kapply("f", [x]);
    expect(hashOf(term)).toBe(hashOf(term));
  });
});
