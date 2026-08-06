/**
 * `String` tokens — pyk `prelude/string.py`.
 */

import { eqSort } from "../eq.js";
import { dequoteString, enquoteString } from "../escape.js";
import { ksort, ktoken, type KSort, type KToken } from "../inner.js";

/** `prelude/string.py:6`. */
export const STRING: KSort = ksort("String");

/**
 * A `String` token holding `pretty` — quotes included (`prelude/string.py:9-10`).
 *
 * The token *text* is the K literal: `"` + escaped body + `"`.
 */
export function stringToken(pretty: string): KToken {
  return ktoken(`"${enquoteString(pretty)}"`, STRING);
}

/**
 * The text a `String` token denotes — {@link stringToken} inverted
 * (`prelude/string.py:13-17`).
 *
 * pyk raises `ValueError` on a non-`String` sort and `assert`s the quotes; here
 * both are a `TypeError`, and the quote check additionally requires two
 * distinct quote characters — pyk's `token[0] == '"' == token[-1]` passes on
 * the one-character token `"` and then decodes it as the empty string.
 */
export function prettyString(token: KToken): string {
  if (!eqSort(token.sort, STRING)) {
    throw new TypeError(`Expected a String token, got sort ${JSON.stringify(token.sort.name)}`);
  }
  const { token: text } = token;
  if (text.length < 2 || !text.startsWith('"') || !text.endsWith('"')) {
    throw new TypeError(`Expected a quoted String token, got: ${text}`);
  }
  return dequoteString(text.slice(1, -1));
}
