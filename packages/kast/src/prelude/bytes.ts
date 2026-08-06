/**
 * `Bytes` tokens — pyk `prelude/bytes.py`.
 *
 * A `Bytes` token is written `b"…"`, and its body is latin-1: one character per
 * byte, anything outside `\x20`-`\x7e` escaped (`escape.ts`).  pyk carries the
 * value around as a `str` of that alphabet, which is why both a
 * `Uint8Array`-taking and a string-taking constructor exist.
 */

import { eqSort } from "../eq.js";
import { bytesDecode, bytesEncode, dequoteBytes, enquoteBytes } from "../escape.js";
import { ksort, ktoken, type KSort, type KToken } from "../inner.js";

/** `prelude/bytes.py:6`. */
export const BYTES: KSort = ksort("Bytes");

/**
 * A `Bytes` token from a latin-1 string — one character per byte
 * (`prelude/bytes.py:9-10`).
 *
 * Throws `EscapeError` if `pretty` holds a code point above U+00FF.
 */
export function bytesTokenFromStr(pretty: string): KToken {
  return ktoken(`b"${enquoteBytes(pretty)}"`, BYTES);
}

/** A `Bytes` token from bytes (`prelude/bytes.py:13-14`). */
export function bytesToken(b: Uint8Array): KToken {
  return bytesTokenFromStr(bytesDecode(b));
}

/**
 * The latin-1 string a `Bytes` token denotes (`prelude/bytes.py:17-22`).
 *
 * As in `prettyString`, pyk's `ValueError`/`assert` pair becomes a
 * `TypeError`, and the shortest accepted token is `b""`.
 */
export function prettyBytesStr(token: KToken): string {
  if (!eqSort(token.sort, BYTES)) {
    throw new TypeError(`Expected a Bytes token, got sort ${JSON.stringify(token.sort.name)}`);
  }
  const { token: text } = token;
  if (text.length < 3 || !text.startsWith('b"') || !text.endsWith('"')) {
    throw new TypeError(`Expected a quoted Bytes token, got: ${text}`);
  }
  return dequoteBytes(text.slice(2, -1));
}

/** The bytes a `Bytes` token denotes (`prelude/bytes.py:25-26`). */
export function prettyBytes(token: KToken): Uint8Array {
  return bytesEncode(prettyBytesStr(token));
}
