/**
 * Corpus #5 — the string/bytes escaping tables.
 *
 * Transcribed from `k/pyk/src/tests/integration/test_string.py:33-41` and
 * `test_bytes.py:34-44` at K v7.1.337.  Both files are marked "integration"
 * only because they kompile a definition for their *other* cases; the two
 * konvert cases in each — `test_kast_to_kore` and `test_kore_to_kast`, both
 * carrying pyk's own `# TODO turn into unit test` — call the **pure** converters
 * and need no definition at all.  7 strings and 9 byte strings, each in both
 * directions: 32 cases, zero fixtures.
 *
 * This suite exists to pin the **two-layer strip/re-add** described in
 * `src/pure.ts`'s {@link ktokenToKore}: a KAST token carries K-level quoting, a
 * KORE `\dv` carries KORE-level quoting, and the conversion strips one and lets
 * the writer add the other.  The `\x80` vs `\xc2\x80` rows are the ones that
 * distinguish "bytes are latin-1" from "bytes are UTF-8"; if that reading is
 * ever wrong, those two rows are where it shows.
 */

import { describe, expect, test } from "bun:test";

import { bytesToken } from "@kframework-ts/kast/prelude/bytes";
import { stringToken } from "@kframework-ts/kast/prelude/string";
import { koreText } from "@kframework-ts/kore";
import { bytesDv, strDv } from "@kframework-ts/kore/prelude";

import { kastToKorePure, koreToKastPure } from "../src/pure.ts";

/** `test_string.py:33-41`. */
const STRING_DATA: readonly string[] = ["hello", "\n", "\x01", "£", "𐍈", "武天老師", "🙂"];

/**
 * `test_bytes.py:34-44`.
 *
 * Python's `b'\"' b'\\' b'\f'` is one literal by adjacent-string concatenation:
 * the three bytes `0x22 0x5c 0x0c`.
 */
const BYTES_DATA: readonly (readonly [string, Uint8Array])[] = [
  ["hello", new Uint8Array([0x68, 0x65, 0x6c, 0x6c, 0x6f])],
  ['"\\\\\\f', new Uint8Array([0x22, 0x5c, 0x0c])],
  ["\\r", new Uint8Array([0x0d])],
  ["\\n", new Uint8Array([0x0a])],
  ["\\t", new Uint8Array([0x09])],
  ["\\x00", new Uint8Array([0x00])],
  ["\\x01", new Uint8Array([0x01])],
  ["\\x80", new Uint8Array([0x80])],
  ["\\xc2\\x80", new Uint8Array([0xc2, 0x80])],
];

describe("String tokens", () => {
  for (const text of STRING_DATA) {
    test(`kastToKorePure ${JSON.stringify(text)}`, () => {
      expect(kastToKorePure(stringToken(text))).toEqual(strDv(text));
    });

    test(`koreToKastPure ${JSON.stringify(text)}`, () => {
      expect(koreToKastPure(strDv(text))).toEqual(stringToken(text));
    });
  }
});

describe("Bytes tokens", () => {
  for (const [id, value] of BYTES_DATA) {
    test(`kastToKorePure b"${id}"`, () => {
      expect(kastToKorePure(bytesToken(value))).toEqual(bytesDv(value));
    });

    test(`koreToKastPure b"${id}"`, () => {
      expect(koreToKastPure(bytesDv(value))).toEqual(bytesToken(value));
    });
  }
});

describe("the two layers are distinct", () => {
  /**
   * The point of the whole suite, stated once as an assertion rather than only
   * in prose: a byte above 0x7f is one *character* of the `\dv`'s value and two
   * *bytes* of the UTF-8 the same text would have.  `\x80` and `\xc2\x80` are
   * different byte strings and must stay different `\dv`s.
   */
  test("0x80 and 0xc2 0x80 are different domain values", () => {
    const one = kastToKorePure(bytesToken(new Uint8Array([0x80])));
    const two = kastToKorePure(bytesToken(new Uint8Array([0xc2, 0x80])));
    expect(one).not.toEqual(two);
  });

  /**
   * The K layer is stripped, not carried through: a K token spelled with an
   * escape converts to the `\dv` of the character it denotes, so the KORE text
   * is re-escaped by the KORE writer and not copied.  This is the deliberate
   * divergence from Java documented at `ktokenToKore` — Java would write
   * `\dv{SortString{}}("\x41")` here.
   */
  test("a K escape is decoded, then re-encoded by the KORE writer", () => {
    expect(koreText(kastToKorePure(stringToken("A")))).toBe('\\dv{SortString{}}("A")');
    expect(koreText(kastToKorePure(stringToken("\n")))).toBe('\\dv{SortString{}}("\\n")');
  });
});
