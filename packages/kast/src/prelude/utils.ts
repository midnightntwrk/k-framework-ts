/**
 * The one-stop token constructor — pyk `prelude/utils.py`.
 */

import type { KToken } from "../inner.js";
import { bytesToken } from "./bytes.js";
import { boolToken } from "./kbool.js";
import { intToken } from "./kint.js";
import { stringToken } from "./string.js";

/**
 * The token for a host value (`prelude/utils.py:14-23`) — the single most-used
 * prelude function downstream (77 call sites in the survey).
 *
 * The mapping: `boolean` → `Bool`, `bigint` and `number` → `Int`, `string` →
 * `String`, `Uint8Array` → `Bytes`.
 *
 * pyk tests `type(x) is bool` *before* `type(x) is int` because Python's `bool`
 * is a subclass of `int` and the two checks would otherwise overlap; `typeof`
 * has no such overlap, so the order here is presentational.  pyk's exact-type
 * tests also reject a subclass (an `IntEnum`, a `numpy.int64`); `instanceof`
 * does not, so a `Buffer` is accepted as `Bytes` — which is what its bytes
 * mean anyway.
 */
export function token(x: boolean | bigint | number | string | Uint8Array): KToken {
  if (typeof x === "boolean") return boolToken(x);
  if (typeof x === "bigint" || typeof x === "number") return intToken(x);
  if (typeof x === "string") return stringToken(x);
  if (x instanceof Uint8Array) return bytesToken(x);
  throw new TypeError(`Cannot make a token of: ${String(x)}`);
}
