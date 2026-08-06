/**
 * Differential parity with pyk for every `src/prelude/` constructor.
 *
 * The expected values are pyk's own `json.dumps(term.to_dict(), sort_keys=True)`
 * at K **v7.1.337**, generated once and committed.  Each row is built twice —
 * once in Python by the script below, once in TypeScript by {@link TERMS} — so
 * a drift in a label string, a sort parameter, an escape or a fold order fails
 * here rather than in a downstream tool.
 *
 * The pyk *installed* on a machine will not do: at v7.1.174 the prelude still
 * lives at `pyk/prelude/`, and `KSort.to_dict` emits no `params`.  `$K` below is
 * a checkout of `runtimeverification/k` at the v7.1.337 tag.
 *
 * # Regenerating
 *
 * The script prints the body of {@link EXPECTED} on stdout, ready to paste:
 *
 * ```sh
 * PYTHONPATH=$K/pyk/src python3 - <<'PY'
 * import json
 *
 * from pyk.kast.inner import KApply, KToken, KVariable
 * from pyk.kast.prelude.bytes import BYTES, bytesToken, bytesToken_from_str
 * from pyk.kast.prelude.collections import (
 *     BAG,
 *     LIST,
 *     MAP,
 *     RANGEMAP,
 *     SET,
 *     list_empty,
 *     list_item,
 *     list_of,
 *     map_empty,
 *     map_item,
 *     map_of,
 *     rangemap_empty,
 *     rangemap_item,
 *     rangemap_of,
 *     set_empty,
 *     set_item,
 *     set_of,
 * )
 * from pyk.kast.prelude.k import DOTS, GENERATED_TOP_CELL, K, K_ITEM, inj
 * from pyk.kast.prelude.kbool import BOOL, FALSE, TRUE, andBool, boolToken, impliesBool, notBool, orBool
 * from pyk.kast.prelude.kint import (
 *     INT,
 *     absInt,
 *     addInt,
 *     andInt,
 *     divInt,
 *     eqInt,
 *     euclidDivInt,
 *     euclidModInt,
 *     expInt,
 *     expModInt,
 *     geInt,
 *     gtInt,
 *     intToken,
 *     leInt,
 *     lshiftInt,
 *     ltInt,
 *     maxInt,
 *     minInt,
 *     modInt,
 *     mulInt,
 *     neqInt,
 *     notInt,
 *     orInt,
 *     rshiftInt,
 *     subInt,
 *     xorInt,
 * )
 * from pyk.kast.prelude.ml import (
 *     mlAnd,
 *     mlBottom,
 *     mlCeil,
 *     mlEquals,
 *     mlEqualsFalse,
 *     mlEqualsTrue,
 *     mlExists,
 *     mlImplies,
 *     mlNot,
 *     mlOr,
 *     mlTop,
 * )
 * from pyk.kast.prelude.string import STRING, stringToken
 * from pyk.kast.prelude.utils import token
 *
 * x = KVariable('x')
 * a, b, c = KApply('a'), KApply('b'), KApply('c')
 * i1, i2, i3 = intToken(1), intToken(2), intToken(3)
 *
 * ENTRIES = [
 *     # k.py
 *     ('k/sort-K', KToken('t', K)),
 *     ('k/sort-KItem', KToken('t', K_ITEM)),
 *     ('k/sort-GeneratedTopCell', KToken('t', GENERATED_TOP_CELL)),
 *     ('k/dots', DOTS),
 *     ('k/inj', inj(INT, K_ITEM, x)),
 *     # kbool.py
 *     ('kbool/sort', KToken('t', BOOL)),
 *     ('kbool/true', TRUE),
 *     ('kbool/false', FALSE),
 *     ('kbool/bool-token-true', boolToken(True)),
 *     ('kbool/bool-token-false', boolToken(False)),
 *     ('kbool/and-0', andBool([])),
 *     ('kbool/and-1', andBool([a])),
 *     ('kbool/and-2', andBool([a, b])),
 *     ('kbool/and-3', andBool([a, b, c])),
 *     ('kbool/and-dup', andBool([a, b, a, c, b])),
 *     ('kbool/and-unit', andBool([a, TRUE, b])),
 *     ('kbool/and-all-unit', andBool([TRUE, TRUE])),
 *     ('kbool/or-0', orBool([])),
 *     ('kbool/or-1', orBool([a])),
 *     ('kbool/or-3', orBool([a, b, c])),
 *     ('kbool/or-dup', orBool([a, b, a, c, b])),
 *     ('kbool/or-unit', orBool([a, FALSE, b])),
 *     ('kbool/not', notBool(a)),
 *     ('kbool/implies', impliesBool(a, b)),
 *     # kint.py
 *     ('kint/sort', KToken('t', INT)),
 *     ('kint/token-0', intToken(0)),
 *     ('kint/token-neg', intToken(-42)),
 *     ('kint/token-big', intToken(2**256 + 1)),
 *     ('kint/lt', ltInt(i1, i2)),
 *     ('kint/le', leInt(i1, i2)),
 *     ('kint/gt', gtInt(i1, i2)),
 *     ('kint/ge', geInt(i1, i2)),
 *     ('kint/eq', eqInt(i1, i2)),
 *     ('kint/neq', neqInt(i1, i2)),
 *     ('kint/not', notInt(i1)),
 *     ('kint/exp', expInt(i1, i2)),
 *     ('kint/expmod', expModInt(i1, i2, i3)),
 *     ('kint/mul', mulInt(i1, i2)),
 *     ('kint/div', divInt(i1, i2)),
 *     ('kint/mod', modInt(i1, i2)),
 *     ('kint/euclid-div', euclidDivInt(i1, i2)),
 *     ('kint/euclid-mod', euclidModInt(i1, i2)),
 *     ('kint/add', addInt(i1, i2)),
 *     ('kint/sub', subInt(i1, i2)),
 *     ('kint/rshift', rshiftInt(i1, i2)),
 *     ('kint/lshift', lshiftInt(i1, i2)),
 *     ('kint/and', andInt(i1, i2)),
 *     ('kint/xor', xorInt(i1, i2)),
 *     ('kint/or', orInt(i1, i2)),
 *     ('kint/min', minInt(i1, i2)),
 *     ('kint/max', maxInt(i1, i2)),
 *     ('kint/abs', absInt(i1)),
 *     # ml.py
 *     ('ml/equals-default', mlEquals(x, i1)),
 *     ('ml/equals-sorted', mlEquals(x, i1, INT, K)),
 *     ('ml/equals-str-sorts', mlEquals(x, i1, 'Int', 'GeneratedTopCell')),
 *     ('ml/equals-true', mlEqualsTrue(a)),
 *     ('ml/equals-false', mlEqualsFalse(a)),
 *     ('ml/equals-true-sorted', mlEqualsTrue(a, K)),
 *     ('ml/top', mlTop()),
 *     ('ml/top-sorted', mlTop(K)),
 *     ('ml/bottom', mlBottom()),
 *     ('ml/bottom-sorted', mlBottom(K)),
 *     ('ml/not', mlNot(a)),
 *     ('ml/and-0', mlAnd([])),
 *     ('ml/and-1', mlAnd([a])),
 *     ('ml/and-2', mlAnd([a, b])),
 *     ('ml/and-3', mlAnd([a, b, c])),
 *     ('ml/and-4', mlAnd([a, b, c, x])),
 *     ('ml/and-filter-top', mlAnd([a, mlTop(), b])),
 *     ('ml/and-filter-top-other-sort', mlAnd([a, mlTop(K), b])),
 *     ('ml/and-all-top', mlAnd([mlTop(), mlTop(K)])),
 *     ('ml/and-dup', mlAnd([a, a])),
 *     ('ml/and-sorted', mlAnd([a, b], K)),
 *     ('ml/or-0', mlOr([])),
 *     ('ml/or-1', mlOr([a])),
 *     ('ml/or-2', mlOr([a, b])),
 *     ('ml/or-3', mlOr([a, b, c])),
 *     ('ml/or-4', mlOr([a, b, c, x])),
 *     ('ml/or-filter-bottom', mlOr([a, mlBottom(), b])),
 *     ('ml/or-all-bottom', mlOr([mlBottom(), mlBottom(K)])),
 *     ('ml/or-sorted', mlOr([a, b], K)),
 *     ('ml/implies', mlImplies(a, b)),
 *     ('ml/implies-sorted', mlImplies(a, b, K)),
 *     ('ml/exists', mlExists(x, a)),
 *     ('ml/exists-sorted', mlExists(x, a, INT, K)),
 *     ('ml/ceil', mlCeil(a)),
 *     ('ml/ceil-sorted', mlCeil(a, INT, K)),
 *     # string.py
 *     ('string/sort', KToken('t', STRING)),
 *     ('string/token-empty', stringToken('')),
 *     ('string/token-plain', stringToken('hello')),
 *     ('string/token-escapes', stringToken('a\tb\nc\\"d')),
 *     ('string/token-unicode', stringToken('h\xe9llo ☃ \U0001d11e')),
 *     ('string/token-control', stringToken('\x00\x01\x1f\x7f')),
 *     # bytes.py
 *     ('bytes/sort', KToken('t', BYTES)),
 *     ('bytes/token-empty', bytesToken(b'')),
 *     ('bytes/token-ascii', bytesToken(b'WASM')),
 *     ('bytes/token-binary', bytesToken(bytes([0x0, 0x41, 0xFF]))),
 *     ('bytes/token-from-str', bytesToken_from_str('foo\xaa\x01bar')),
 *     # collections.py
 *     ('collections/sort-Set', KToken('t', SET)),
 *     ('collections/sort-List', KToken('t', LIST)),
 *     ('collections/sort-Map', KToken('t', MAP)),
 *     ('collections/sort-RangeMap', KToken('t', RANGEMAP)),
 *     ('collections/sort-Bag', KToken('t', BAG)),
 *     ('collections/set-empty', set_empty()),
 *     ('collections/set-item', set_item(a)),
 *     ('collections/set-of-0', set_of([])),
 *     ('collections/set-of-1', set_of([a])),
 *     ('collections/set-of-3', set_of([a, b, c])),
 *     ('collections/set-of-dup', set_of([a, a])),
 *     ('collections/list-empty', list_empty()),
 *     ('collections/list-item', list_item(a)),
 *     ('collections/list-of-0', list_of([])),
 *     ('collections/list-of-1', list_of([a])),
 *     ('collections/list-of-3', list_of([a, b, c])),
 *     ('collections/map-empty', map_empty()),
 *     ('collections/map-item', map_item(a, b)),
 *     ('collections/map-of-0', map_of([])),
 *     ('collections/map-of-1', map_of([(a, b)])),
 *     ('collections/map-of-2', map_of([(a, b), (b, c)])),
 *     ('collections/map-of-dup-key', map_of([(a, b), (b, b), (a, c)])),
 *     ('collections/rangemap-empty', rangemap_empty()),
 *     ('collections/rangemap-item', rangemap_item((i1, i2), a)),
 *     ('collections/rangemap-of-0', rangemap_of([])),
 *     ('collections/rangemap-of-1', rangemap_of([((i1, i2), a)])),
 *     ('collections/rangemap-of-2', rangemap_of([((i1, i2), a), ((i2, i3), b)])),
 *     ('collections/rangemap-of-dup-key', rangemap_of([((i1, i2), a), ((i2, i3), b), ((i1, i2), c)])),
 *     # utils.py
 *     ('utils/token-bool', token(True)),
 *     ('utils/token-int', token(-7)),
 *     ('utils/token-big-int', token(2**64 + 1)),
 *     ('utils/token-str', token('a"b')),
 *     ('utils/token-bytes', token(bytes([0x00, 0xFF]))),
 * ]
 *
 * for name, term in ENTRIES:
 *     dumped = json.dumps(term.to_dict(), sort_keys=True)
 *     print(f'  {json.dumps(name)}: {json.dumps(dumped)},')
 * PY
 * ```
 */

import { describe, expect, test } from "bun:test";
import { canonicalJson } from "../src/eq.ts";
import { ktoken, type KInner } from "../src/inner.ts";
import { toDict } from "../src/json.ts";
import { BYTES, bytesToken, bytesTokenFromStr } from "../src/prelude/bytes.ts";
import {
  BAG,
  LIST,
  MAP,
  RANGEMAP,
  SET,
  listEmpty,
  listItem,
  listOf,
  mapEmpty,
  mapItem,
  mapOf,
  rangemapEmpty,
  rangemapItem,
  rangemapOf,
  setEmpty,
  setItem,
  setOf,
} from "../src/prelude/collections.ts";
import { DOTS, GENERATED_TOP_CELL, K, K_ITEM, inj } from "../src/prelude/k.ts";
import { BOOL, FALSE, TRUE, andBool, boolToken, impliesBool, notBool, orBool } from "../src/prelude/kbool.ts";
import {
  INT,
  absInt,
  addInt,
  andInt,
  divInt,
  eqInt,
  euclidDivInt,
  euclidModInt,
  expInt,
  expModInt,
  geInt,
  gtInt,
  intToken,
  leInt,
  lshiftInt,
  ltInt,
  maxInt,
  minInt,
  modInt,
  mulInt,
  neqInt,
  notInt,
  orInt,
  rshiftInt,
  subInt,
  xorInt,
} from "../src/prelude/kint.ts";
import {
  mlAnd,
  mlBottom,
  mlCeil,
  mlEquals,
  mlEqualsFalse,
  mlEqualsTrue,
  mlExists,
  mlImplies,
  mlNot,
  mlOr,
  mlTop,
} from "../src/prelude/ml.ts";
import { STRING, stringToken } from "../src/prelude/string.ts";
import { token } from "../src/prelude/utils.ts";
// oxlint-disable-next-line import/max-dependencies -- one test file per prelude module would fragment the story
import { a, b, c, x } from "./helpers.ts";

const i1 = intToken(1);
const i2 = intToken(2);
const i3 = intToken(3);

/** The same terms the script in the header builds, in the same order. */
const TERMS: readonly (readonly [string, KInner])[] = [
  // k.ts
  ["k/sort-K", ktoken("t", K)],
  ["k/sort-KItem", ktoken("t", K_ITEM)],
  ["k/sort-GeneratedTopCell", ktoken("t", GENERATED_TOP_CELL)],
  ["k/dots", DOTS],
  ["k/inj", inj(INT, K_ITEM, x)],
  // kbool.ts
  ["kbool/sort", ktoken("t", BOOL)],
  ["kbool/true", TRUE],
  ["kbool/false", FALSE],
  ["kbool/bool-token-true", boolToken(true)],
  ["kbool/bool-token-false", boolToken(false)],
  ["kbool/and-0", andBool([])],
  ["kbool/and-1", andBool([a])],
  ["kbool/and-2", andBool([a, b])],
  ["kbool/and-3", andBool([a, b, c])],
  ["kbool/and-dup", andBool([a, b, a, c, b])],
  ["kbool/and-unit", andBool([a, TRUE, b])],
  ["kbool/and-all-unit", andBool([TRUE, TRUE])],
  ["kbool/or-0", orBool([])],
  ["kbool/or-1", orBool([a])],
  ["kbool/or-3", orBool([a, b, c])],
  ["kbool/or-dup", orBool([a, b, a, c, b])],
  ["kbool/or-unit", orBool([a, FALSE, b])],
  ["kbool/not", notBool(a)],
  ["kbool/implies", impliesBool(a, b)],
  // kint.ts
  ["kint/sort", ktoken("t", INT)],
  ["kint/token-0", intToken(0)],
  ["kint/token-neg", intToken(-42)],
  ["kint/token-big", intToken(2n ** 256n + 1n)],
  ["kint/lt", ltInt(i1, i2)],
  ["kint/le", leInt(i1, i2)],
  ["kint/gt", gtInt(i1, i2)],
  ["kint/ge", geInt(i1, i2)],
  ["kint/eq", eqInt(i1, i2)],
  ["kint/neq", neqInt(i1, i2)],
  ["kint/not", notInt(i1)],
  ["kint/exp", expInt(i1, i2)],
  ["kint/expmod", expModInt(i1, i2, i3)],
  ["kint/mul", mulInt(i1, i2)],
  ["kint/div", divInt(i1, i2)],
  ["kint/mod", modInt(i1, i2)],
  ["kint/euclid-div", euclidDivInt(i1, i2)],
  ["kint/euclid-mod", euclidModInt(i1, i2)],
  ["kint/add", addInt(i1, i2)],
  ["kint/sub", subInt(i1, i2)],
  ["kint/rshift", rshiftInt(i1, i2)],
  ["kint/lshift", lshiftInt(i1, i2)],
  ["kint/and", andInt(i1, i2)],
  ["kint/xor", xorInt(i1, i2)],
  ["kint/or", orInt(i1, i2)],
  ["kint/min", minInt(i1, i2)],
  ["kint/max", maxInt(i1, i2)],
  ["kint/abs", absInt(i1)],
  // ml.ts
  ["ml/equals-default", mlEquals(x, i1)],
  ["ml/equals-sorted", mlEquals(x, i1, INT, K)],
  ["ml/equals-str-sorts", mlEquals(x, i1, "Int", "GeneratedTopCell")],
  ["ml/equals-true", mlEqualsTrue(a)],
  ["ml/equals-false", mlEqualsFalse(a)],
  ["ml/equals-true-sorted", mlEqualsTrue(a, K)],
  ["ml/top", mlTop()],
  ["ml/top-sorted", mlTop(K)],
  ["ml/bottom", mlBottom()],
  ["ml/bottom-sorted", mlBottom(K)],
  ["ml/not", mlNot(a)],
  ["ml/and-0", mlAnd([])],
  ["ml/and-1", mlAnd([a])],
  ["ml/and-2", mlAnd([a, b])],
  ["ml/and-3", mlAnd([a, b, c])],
  ["ml/and-4", mlAnd([a, b, c, x])],
  ["ml/and-filter-top", mlAnd([a, mlTop(), b])],
  ["ml/and-filter-top-other-sort", mlAnd([a, mlTop(K), b])],
  ["ml/and-all-top", mlAnd([mlTop(), mlTop(K)])],
  ["ml/and-dup", mlAnd([a, a])],
  ["ml/and-sorted", mlAnd([a, b], K)],
  ["ml/or-0", mlOr([])],
  ["ml/or-1", mlOr([a])],
  ["ml/or-2", mlOr([a, b])],
  ["ml/or-3", mlOr([a, b, c])],
  ["ml/or-4", mlOr([a, b, c, x])],
  ["ml/or-filter-bottom", mlOr([a, mlBottom(), b])],
  ["ml/or-all-bottom", mlOr([mlBottom(), mlBottom(K)])],
  ["ml/or-sorted", mlOr([a, b], K)],
  ["ml/implies", mlImplies(a, b)],
  ["ml/implies-sorted", mlImplies(a, b, K)],
  ["ml/exists", mlExists(x, a)],
  ["ml/exists-sorted", mlExists(x, a, INT, K)],
  ["ml/ceil", mlCeil(a)],
  ["ml/ceil-sorted", mlCeil(a, INT, K)],
  // string.ts
  ["string/sort", ktoken("t", STRING)],
  ["string/token-empty", stringToken("")],
  ["string/token-plain", stringToken("hello")],
  ["string/token-escapes", stringToken('a\tb\nc\\"d')],
  ["string/token-unicode", stringToken("héllo ☃ \u{1D11E}")],
  ["string/token-control", stringToken("\u0000\u0001\u001F\u007F")],
  // bytes.ts
  ["bytes/sort", ktoken("t", BYTES)],
  ["bytes/token-empty", bytesToken(new Uint8Array([]))],
  ["bytes/token-ascii", bytesToken(new Uint8Array([0x57, 0x41, 0x53, 0x4d]))],
  ["bytes/token-binary", bytesToken(new Uint8Array([0x00, 0x41, 0xff]))],
  ["bytes/token-from-str", bytesTokenFromStr("foo\u00AA\u0001bar")],
  // collections.ts
  ["collections/sort-Set", ktoken("t", SET)],
  ["collections/sort-List", ktoken("t", LIST)],
  ["collections/sort-Map", ktoken("t", MAP)],
  ["collections/sort-RangeMap", ktoken("t", RANGEMAP)],
  ["collections/sort-Bag", ktoken("t", BAG)],
  ["collections/set-empty", setEmpty()],
  ["collections/set-item", setItem(a)],
  ["collections/set-of-0", setOf([])],
  ["collections/set-of-1", setOf([a])],
  ["collections/set-of-3", setOf([a, b, c])],
  ["collections/set-of-dup", setOf([a, a])],
  ["collections/list-empty", listEmpty()],
  ["collections/list-item", listItem(a)],
  ["collections/list-of-0", listOf([])],
  ["collections/list-of-1", listOf([a])],
  ["collections/list-of-3", listOf([a, b, c])],
  ["collections/map-empty", mapEmpty()],
  ["collections/map-item", mapItem(a, b)],
  ["collections/map-of-0", mapOf([])],
  ["collections/map-of-1", mapOf([[a, b]])],
  [
    "collections/map-of-2",
    mapOf([
      [a, b],
      [b, c],
    ]),
  ],
  [
    "collections/map-of-dup-key",
    mapOf([
      [a, b],
      [b, b],
      [a, c],
    ]),
  ],
  ["collections/rangemap-empty", rangemapEmpty()],
  ["collections/rangemap-item", rangemapItem([i1, i2], a)],
  ["collections/rangemap-of-0", rangemapOf([])],
  ["collections/rangemap-of-1", rangemapOf([[[i1, i2], a]])],
  [
    "collections/rangemap-of-2",
    rangemapOf([
      [[i1, i2], a],
      [[i2, i3], b],
    ]),
  ],
  [
    "collections/rangemap-of-dup-key",
    rangemapOf([
      [[i1, i2], a],
      [[i2, i3], b],
      [[i1, i2], c],
    ]),
  ],
  // utils.ts
  ["utils/token-bool", token(true)],
  ["utils/token-int", token(-7)],
  ["utils/token-big-int", token(2n ** 64n + 1n)],
  ["utils/token-str", token('a"b')],
  ["utils/token-bytes", token(new Uint8Array([0x00, 0xff]))],
];

/** pyk's `json.dumps(term.to_dict(), sort_keys=True)`, verbatim. */
const EXPECTED: Readonly<Record<string, string>> = {
  "k/sort-K": '{"node": "KToken", "sort": {"name": "K", "node": "KSort", "params": []}, "token": "t"}',
  "k/sort-KItem": '{"node": "KToken", "sort": {"name": "KItem", "node": "KSort", "params": []}, "token": "t"}',
  "k/sort-GeneratedTopCell":
    '{"node": "KToken", "sort": {"name": "GeneratedTopCell", "node": "KSort", "params": []}, "token": "t"}',
  "k/dots": '{"node": "KToken", "sort": {"name": "K", "node": "KSort", "params": []}, "token": "..."}',
  "k/inj":
    '{"args": [{"name": "x", "node": "KVariable"}], "arity": 1, "label": {"name": "inj", "node": "KLabel", "params": [{"name": "Int", "node": "KSort", "params": []}, {"name": "KItem", "node": "KSort", "params": []}]}, "node": "KApply", "variable": false}',
  "kbool/sort": '{"node": "KToken", "sort": {"name": "Bool", "node": "KSort", "params": []}, "token": "t"}',
  "kbool/true": '{"node": "KToken", "sort": {"name": "Bool", "node": "KSort", "params": []}, "token": "true"}',
  "kbool/false": '{"node": "KToken", "sort": {"name": "Bool", "node": "KSort", "params": []}, "token": "false"}',
  "kbool/bool-token-true":
    '{"node": "KToken", "sort": {"name": "Bool", "node": "KSort", "params": []}, "token": "true"}',
  "kbool/bool-token-false":
    '{"node": "KToken", "sort": {"name": "Bool", "node": "KSort", "params": []}, "token": "false"}',
  "kbool/and-0": '{"node": "KToken", "sort": {"name": "Bool", "node": "KSort", "params": []}, "token": "true"}',
  "kbool/and-1":
    '{"args": [], "arity": 0, "label": {"name": "a", "node": "KLabel", "params": []}, "node": "KApply", "variable": false}',
  "kbool/and-2":
    '{"args": [{"args": [], "arity": 0, "label": {"name": "a", "node": "KLabel", "params": []}, "node": "KApply", "variable": false}, {"args": [], "arity": 0, "label": {"name": "b", "node": "KLabel", "params": []}, "node": "KApply", "variable": false}], "arity": 2, "label": {"name": "_andBool_", "node": "KLabel", "params": []}, "node": "KApply", "variable": false}',
  "kbool/and-3":
    '{"args": [{"args": [], "arity": 0, "label": {"name": "a", "node": "KLabel", "params": []}, "node": "KApply", "variable": false}, {"args": [{"args": [], "arity": 0, "label": {"name": "b", "node": "KLabel", "params": []}, "node": "KApply", "variable": false}, {"args": [], "arity": 0, "label": {"name": "c", "node": "KLabel", "params": []}, "node": "KApply", "variable": false}], "arity": 2, "label": {"name": "_andBool_", "node": "KLabel", "params": []}, "node": "KApply", "variable": false}], "arity": 2, "label": {"name": "_andBool_", "node": "KLabel", "params": []}, "node": "KApply", "variable": false}',
  "kbool/and-dup":
    '{"args": [{"args": [], "arity": 0, "label": {"name": "a", "node": "KLabel", "params": []}, "node": "KApply", "variable": false}, {"args": [{"args": [], "arity": 0, "label": {"name": "b", "node": "KLabel", "params": []}, "node": "KApply", "variable": false}, {"args": [], "arity": 0, "label": {"name": "c", "node": "KLabel", "params": []}, "node": "KApply", "variable": false}], "arity": 2, "label": {"name": "_andBool_", "node": "KLabel", "params": []}, "node": "KApply", "variable": false}], "arity": 2, "label": {"name": "_andBool_", "node": "KLabel", "params": []}, "node": "KApply", "variable": false}',
  "kbool/and-unit":
    '{"args": [{"args": [], "arity": 0, "label": {"name": "a", "node": "KLabel", "params": []}, "node": "KApply", "variable": false}, {"args": [], "arity": 0, "label": {"name": "b", "node": "KLabel", "params": []}, "node": "KApply", "variable": false}], "arity": 2, "label": {"name": "_andBool_", "node": "KLabel", "params": []}, "node": "KApply", "variable": false}',
  "kbool/and-all-unit": '{"node": "KToken", "sort": {"name": "Bool", "node": "KSort", "params": []}, "token": "true"}',
  "kbool/or-0": '{"node": "KToken", "sort": {"name": "Bool", "node": "KSort", "params": []}, "token": "false"}',
  "kbool/or-1":
    '{"args": [], "arity": 0, "label": {"name": "a", "node": "KLabel", "params": []}, "node": "KApply", "variable": false}',
  "kbool/or-3":
    '{"args": [{"args": [], "arity": 0, "label": {"name": "a", "node": "KLabel", "params": []}, "node": "KApply", "variable": false}, {"args": [{"args": [], "arity": 0, "label": {"name": "b", "node": "KLabel", "params": []}, "node": "KApply", "variable": false}, {"args": [], "arity": 0, "label": {"name": "c", "node": "KLabel", "params": []}, "node": "KApply", "variable": false}], "arity": 2, "label": {"name": "_orBool_", "node": "KLabel", "params": []}, "node": "KApply", "variable": false}], "arity": 2, "label": {"name": "_orBool_", "node": "KLabel", "params": []}, "node": "KApply", "variable": false}',
  "kbool/or-dup":
    '{"args": [{"args": [], "arity": 0, "label": {"name": "a", "node": "KLabel", "params": []}, "node": "KApply", "variable": false}, {"args": [{"args": [], "arity": 0, "label": {"name": "b", "node": "KLabel", "params": []}, "node": "KApply", "variable": false}, {"args": [], "arity": 0, "label": {"name": "c", "node": "KLabel", "params": []}, "node": "KApply", "variable": false}], "arity": 2, "label": {"name": "_orBool_", "node": "KLabel", "params": []}, "node": "KApply", "variable": false}], "arity": 2, "label": {"name": "_orBool_", "node": "KLabel", "params": []}, "node": "KApply", "variable": false}',
  "kbool/or-unit":
    '{"args": [{"args": [], "arity": 0, "label": {"name": "a", "node": "KLabel", "params": []}, "node": "KApply", "variable": false}, {"args": [], "arity": 0, "label": {"name": "b", "node": "KLabel", "params": []}, "node": "KApply", "variable": false}], "arity": 2, "label": {"name": "_orBool_", "node": "KLabel", "params": []}, "node": "KApply", "variable": false}',
  "kbool/not":
    '{"args": [{"args": [], "arity": 0, "label": {"name": "a", "node": "KLabel", "params": []}, "node": "KApply", "variable": false}], "arity": 1, "label": {"name": "notBool_", "node": "KLabel", "params": []}, "node": "KApply", "variable": false}',
  "kbool/implies":
    '{"args": [{"args": [], "arity": 0, "label": {"name": "a", "node": "KLabel", "params": []}, "node": "KApply", "variable": false}, {"args": [], "arity": 0, "label": {"name": "b", "node": "KLabel", "params": []}, "node": "KApply", "variable": false}], "arity": 2, "label": {"name": "_impliesBool_", "node": "KLabel", "params": []}, "node": "KApply", "variable": false}',
  "kint/sort": '{"node": "KToken", "sort": {"name": "Int", "node": "KSort", "params": []}, "token": "t"}',
  "kint/token-0": '{"node": "KToken", "sort": {"name": "Int", "node": "KSort", "params": []}, "token": "0"}',
  "kint/token-neg": '{"node": "KToken", "sort": {"name": "Int", "node": "KSort", "params": []}, "token": "-42"}',
  "kint/token-big":
    '{"node": "KToken", "sort": {"name": "Int", "node": "KSort", "params": []}, "token": "115792089237316195423570985008687907853269984665640564039457584007913129639937"}',
  "kint/lt":
    '{"args": [{"node": "KToken", "sort": {"name": "Int", "node": "KSort", "params": []}, "token": "1"}, {"node": "KToken", "sort": {"name": "Int", "node": "KSort", "params": []}, "token": "2"}], "arity": 2, "label": {"name": "_<Int_", "node": "KLabel", "params": []}, "node": "KApply", "variable": false}',
  "kint/le":
    '{"args": [{"node": "KToken", "sort": {"name": "Int", "node": "KSort", "params": []}, "token": "1"}, {"node": "KToken", "sort": {"name": "Int", "node": "KSort", "params": []}, "token": "2"}], "arity": 2, "label": {"name": "_<=Int_", "node": "KLabel", "params": []}, "node": "KApply", "variable": false}',
  "kint/gt":
    '{"args": [{"node": "KToken", "sort": {"name": "Int", "node": "KSort", "params": []}, "token": "1"}, {"node": "KToken", "sort": {"name": "Int", "node": "KSort", "params": []}, "token": "2"}], "arity": 2, "label": {"name": "_>Int_", "node": "KLabel", "params": []}, "node": "KApply", "variable": false}',
  "kint/ge":
    '{"args": [{"node": "KToken", "sort": {"name": "Int", "node": "KSort", "params": []}, "token": "1"}, {"node": "KToken", "sort": {"name": "Int", "node": "KSort", "params": []}, "token": "2"}], "arity": 2, "label": {"name": "_>=Int_", "node": "KLabel", "params": []}, "node": "KApply", "variable": false}',
  "kint/eq":
    '{"args": [{"node": "KToken", "sort": {"name": "Int", "node": "KSort", "params": []}, "token": "1"}, {"node": "KToken", "sort": {"name": "Int", "node": "KSort", "params": []}, "token": "2"}], "arity": 2, "label": {"name": "_==Int_", "node": "KLabel", "params": []}, "node": "KApply", "variable": false}',
  "kint/neq":
    '{"args": [{"node": "KToken", "sort": {"name": "Int", "node": "KSort", "params": []}, "token": "1"}, {"node": "KToken", "sort": {"name": "Int", "node": "KSort", "params": []}, "token": "2"}], "arity": 2, "label": {"name": "_=/=Int_", "node": "KLabel", "params": []}, "node": "KApply", "variable": false}',
  "kint/not":
    '{"args": [{"node": "KToken", "sort": {"name": "Int", "node": "KSort", "params": []}, "token": "1"}], "arity": 1, "label": {"name": "~Int_", "node": "KLabel", "params": []}, "node": "KApply", "variable": false}',
  "kint/exp":
    '{"args": [{"node": "KToken", "sort": {"name": "Int", "node": "KSort", "params": []}, "token": "1"}, {"node": "KToken", "sort": {"name": "Int", "node": "KSort", "params": []}, "token": "2"}], "arity": 2, "label": {"name": "_^Int_", "node": "KLabel", "params": []}, "node": "KApply", "variable": false}',
  "kint/expmod":
    '{"args": [{"node": "KToken", "sort": {"name": "Int", "node": "KSort", "params": []}, "token": "1"}, {"node": "KToken", "sort": {"name": "Int", "node": "KSort", "params": []}, "token": "2"}, {"node": "KToken", "sort": {"name": "Int", "node": "KSort", "params": []}, "token": "3"}], "arity": 3, "label": {"name": "_^%Int__", "node": "KLabel", "params": []}, "node": "KApply", "variable": false}',
  "kint/mul":
    '{"args": [{"node": "KToken", "sort": {"name": "Int", "node": "KSort", "params": []}, "token": "1"}, {"node": "KToken", "sort": {"name": "Int", "node": "KSort", "params": []}, "token": "2"}], "arity": 2, "label": {"name": "_*Int_", "node": "KLabel", "params": []}, "node": "KApply", "variable": false}',
  "kint/div":
    '{"args": [{"node": "KToken", "sort": {"name": "Int", "node": "KSort", "params": []}, "token": "1"}, {"node": "KToken", "sort": {"name": "Int", "node": "KSort", "params": []}, "token": "2"}], "arity": 2, "label": {"name": "_/Int_", "node": "KLabel", "params": []}, "node": "KApply", "variable": false}',
  "kint/mod":
    '{"args": [{"node": "KToken", "sort": {"name": "Int", "node": "KSort", "params": []}, "token": "1"}, {"node": "KToken", "sort": {"name": "Int", "node": "KSort", "params": []}, "token": "2"}], "arity": 2, "label": {"name": "_%Int_", "node": "KLabel", "params": []}, "node": "KApply", "variable": false}',
  "kint/euclid-div":
    '{"args": [{"node": "KToken", "sort": {"name": "Int", "node": "KSort", "params": []}, "token": "1"}, {"node": "KToken", "sort": {"name": "Int", "node": "KSort", "params": []}, "token": "2"}], "arity": 2, "label": {"name": "_divInt_", "node": "KLabel", "params": []}, "node": "KApply", "variable": false}',
  "kint/euclid-mod":
    '{"args": [{"node": "KToken", "sort": {"name": "Int", "node": "KSort", "params": []}, "token": "1"}, {"node": "KToken", "sort": {"name": "Int", "node": "KSort", "params": []}, "token": "2"}], "arity": 2, "label": {"name": "_modInt_", "node": "KLabel", "params": []}, "node": "KApply", "variable": false}',
  "kint/add":
    '{"args": [{"node": "KToken", "sort": {"name": "Int", "node": "KSort", "params": []}, "token": "1"}, {"node": "KToken", "sort": {"name": "Int", "node": "KSort", "params": []}, "token": "2"}], "arity": 2, "label": {"name": "_+Int_", "node": "KLabel", "params": []}, "node": "KApply", "variable": false}',
  "kint/sub":
    '{"args": [{"node": "KToken", "sort": {"name": "Int", "node": "KSort", "params": []}, "token": "1"}, {"node": "KToken", "sort": {"name": "Int", "node": "KSort", "params": []}, "token": "2"}], "arity": 2, "label": {"name": "_-Int_", "node": "KLabel", "params": []}, "node": "KApply", "variable": false}',
  "kint/rshift":
    '{"args": [{"node": "KToken", "sort": {"name": "Int", "node": "KSort", "params": []}, "token": "1"}, {"node": "KToken", "sort": {"name": "Int", "node": "KSort", "params": []}, "token": "2"}], "arity": 2, "label": {"name": "_>>Int_", "node": "KLabel", "params": []}, "node": "KApply", "variable": false}',
  "kint/lshift":
    '{"args": [{"node": "KToken", "sort": {"name": "Int", "node": "KSort", "params": []}, "token": "1"}, {"node": "KToken", "sort": {"name": "Int", "node": "KSort", "params": []}, "token": "2"}], "arity": 2, "label": {"name": "_<<Int_", "node": "KLabel", "params": []}, "node": "KApply", "variable": false}',
  "kint/and":
    '{"args": [{"node": "KToken", "sort": {"name": "Int", "node": "KSort", "params": []}, "token": "1"}, {"node": "KToken", "sort": {"name": "Int", "node": "KSort", "params": []}, "token": "2"}], "arity": 2, "label": {"name": "_&Int_", "node": "KLabel", "params": []}, "node": "KApply", "variable": false}',
  "kint/xor":
    '{"args": [{"node": "KToken", "sort": {"name": "Int", "node": "KSort", "params": []}, "token": "1"}, {"node": "KToken", "sort": {"name": "Int", "node": "KSort", "params": []}, "token": "2"}], "arity": 2, "label": {"name": "_xorInt_", "node": "KLabel", "params": []}, "node": "KApply", "variable": false}',
  "kint/or":
    '{"args": [{"node": "KToken", "sort": {"name": "Int", "node": "KSort", "params": []}, "token": "1"}, {"node": "KToken", "sort": {"name": "Int", "node": "KSort", "params": []}, "token": "2"}], "arity": 2, "label": {"name": "_|Int_", "node": "KLabel", "params": []}, "node": "KApply", "variable": false}',
  "kint/min":
    '{"args": [{"node": "KToken", "sort": {"name": "Int", "node": "KSort", "params": []}, "token": "1"}, {"node": "KToken", "sort": {"name": "Int", "node": "KSort", "params": []}, "token": "2"}], "arity": 2, "label": {"name": "minInt", "node": "KLabel", "params": []}, "node": "KApply", "variable": false}',
  "kint/max":
    '{"args": [{"node": "KToken", "sort": {"name": "Int", "node": "KSort", "params": []}, "token": "1"}, {"node": "KToken", "sort": {"name": "Int", "node": "KSort", "params": []}, "token": "2"}], "arity": 2, "label": {"name": "maxInt", "node": "KLabel", "params": []}, "node": "KApply", "variable": false}',
  "kint/abs":
    '{"args": [{"node": "KToken", "sort": {"name": "Int", "node": "KSort", "params": []}, "token": "1"}], "arity": 1, "label": {"name": "absInt", "node": "KLabel", "params": []}, "node": "KApply", "variable": false}',
  "ml/equals-default":
    '{"args": [{"name": "x", "node": "KVariable"}, {"node": "KToken", "sort": {"name": "Int", "node": "KSort", "params": []}, "token": "1"}], "arity": 2, "label": {"name": "#Equals", "node": "KLabel", "params": [{"name": "K", "node": "KSort", "params": []}, {"name": "GeneratedTopCell", "node": "KSort", "params": []}]}, "node": "KApply", "variable": false}',
  "ml/equals-sorted":
    '{"args": [{"name": "x", "node": "KVariable"}, {"node": "KToken", "sort": {"name": "Int", "node": "KSort", "params": []}, "token": "1"}], "arity": 2, "label": {"name": "#Equals", "node": "KLabel", "params": [{"name": "Int", "node": "KSort", "params": []}, {"name": "K", "node": "KSort", "params": []}]}, "node": "KApply", "variable": false}',
  "ml/equals-str-sorts":
    '{"args": [{"name": "x", "node": "KVariable"}, {"node": "KToken", "sort": {"name": "Int", "node": "KSort", "params": []}, "token": "1"}], "arity": 2, "label": {"name": "#Equals", "node": "KLabel", "params": [{"name": "Int", "node": "KSort", "params": []}, {"name": "GeneratedTopCell", "node": "KSort", "params": []}]}, "node": "KApply", "variable": false}',
  "ml/equals-true":
    '{"args": [{"node": "KToken", "sort": {"name": "Bool", "node": "KSort", "params": []}, "token": "true"}, {"args": [], "arity": 0, "label": {"name": "a", "node": "KLabel", "params": []}, "node": "KApply", "variable": false}], "arity": 2, "label": {"name": "#Equals", "node": "KLabel", "params": [{"name": "Bool", "node": "KSort", "params": []}, {"name": "GeneratedTopCell", "node": "KSort", "params": []}]}, "node": "KApply", "variable": false}',
  "ml/equals-false":
    '{"args": [{"node": "KToken", "sort": {"name": "Bool", "node": "KSort", "params": []}, "token": "false"}, {"args": [], "arity": 0, "label": {"name": "a", "node": "KLabel", "params": []}, "node": "KApply", "variable": false}], "arity": 2, "label": {"name": "#Equals", "node": "KLabel", "params": [{"name": "Bool", "node": "KSort", "params": []}, {"name": "GeneratedTopCell", "node": "KSort", "params": []}]}, "node": "KApply", "variable": false}',
  "ml/equals-true-sorted":
    '{"args": [{"node": "KToken", "sort": {"name": "Bool", "node": "KSort", "params": []}, "token": "true"}, {"args": [], "arity": 0, "label": {"name": "a", "node": "KLabel", "params": []}, "node": "KApply", "variable": false}], "arity": 2, "label": {"name": "#Equals", "node": "KLabel", "params": [{"name": "Bool", "node": "KSort", "params": []}, {"name": "K", "node": "KSort", "params": []}]}, "node": "KApply", "variable": false}',
  "ml/top":
    '{"args": [], "arity": 0, "label": {"name": "#Top", "node": "KLabel", "params": [{"name": "GeneratedTopCell", "node": "KSort", "params": []}]}, "node": "KApply", "variable": false}',
  "ml/top-sorted":
    '{"args": [], "arity": 0, "label": {"name": "#Top", "node": "KLabel", "params": [{"name": "K", "node": "KSort", "params": []}]}, "node": "KApply", "variable": false}',
  "ml/bottom":
    '{"args": [], "arity": 0, "label": {"name": "#Bottom", "node": "KLabel", "params": [{"name": "GeneratedTopCell", "node": "KSort", "params": []}]}, "node": "KApply", "variable": false}',
  "ml/bottom-sorted":
    '{"args": [], "arity": 0, "label": {"name": "#Bottom", "node": "KLabel", "params": [{"name": "K", "node": "KSort", "params": []}]}, "node": "KApply", "variable": false}',
  "ml/not":
    '{"args": [{"args": [], "arity": 0, "label": {"name": "a", "node": "KLabel", "params": []}, "node": "KApply", "variable": false}], "arity": 1, "label": {"name": "#Not", "node": "KLabel", "params": [{"name": "GeneratedTopCell", "node": "KSort", "params": []}]}, "node": "KApply", "variable": false}',
  "ml/and-0":
    '{"args": [], "arity": 0, "label": {"name": "#Top", "node": "KLabel", "params": [{"name": "GeneratedTopCell", "node": "KSort", "params": []}]}, "node": "KApply", "variable": false}',
  "ml/and-1":
    '{"args": [], "arity": 0, "label": {"name": "a", "node": "KLabel", "params": []}, "node": "KApply", "variable": false}',
  "ml/and-2":
    '{"args": [{"args": [], "arity": 0, "label": {"name": "a", "node": "KLabel", "params": []}, "node": "KApply", "variable": false}, {"args": [], "arity": 0, "label": {"name": "b", "node": "KLabel", "params": []}, "node": "KApply", "variable": false}], "arity": 2, "label": {"name": "#And", "node": "KLabel", "params": [{"name": "GeneratedTopCell", "node": "KSort", "params": []}]}, "node": "KApply", "variable": false}',
  "ml/and-3":
    '{"args": [{"args": [], "arity": 0, "label": {"name": "a", "node": "KLabel", "params": []}, "node": "KApply", "variable": false}, {"args": [{"args": [], "arity": 0, "label": {"name": "b", "node": "KLabel", "params": []}, "node": "KApply", "variable": false}, {"args": [], "arity": 0, "label": {"name": "c", "node": "KLabel", "params": []}, "node": "KApply", "variable": false}], "arity": 2, "label": {"name": "#And", "node": "KLabel", "params": [{"name": "GeneratedTopCell", "node": "KSort", "params": []}]}, "node": "KApply", "variable": false}], "arity": 2, "label": {"name": "#And", "node": "KLabel", "params": [{"name": "GeneratedTopCell", "node": "KSort", "params": []}]}, "node": "KApply", "variable": false}',
  "ml/and-4":
    '{"args": [{"args": [], "arity": 0, "label": {"name": "a", "node": "KLabel", "params": []}, "node": "KApply", "variable": false}, {"args": [{"args": [], "arity": 0, "label": {"name": "b", "node": "KLabel", "params": []}, "node": "KApply", "variable": false}, {"args": [{"args": [], "arity": 0, "label": {"name": "c", "node": "KLabel", "params": []}, "node": "KApply", "variable": false}, {"name": "x", "node": "KVariable"}], "arity": 2, "label": {"name": "#And", "node": "KLabel", "params": [{"name": "GeneratedTopCell", "node": "KSort", "params": []}]}, "node": "KApply", "variable": false}], "arity": 2, "label": {"name": "#And", "node": "KLabel", "params": [{"name": "GeneratedTopCell", "node": "KSort", "params": []}]}, "node": "KApply", "variable": false}], "arity": 2, "label": {"name": "#And", "node": "KLabel", "params": [{"name": "GeneratedTopCell", "node": "KSort", "params": []}]}, "node": "KApply", "variable": false}',
  "ml/and-filter-top":
    '{"args": [{"args": [], "arity": 0, "label": {"name": "a", "node": "KLabel", "params": []}, "node": "KApply", "variable": false}, {"args": [], "arity": 0, "label": {"name": "b", "node": "KLabel", "params": []}, "node": "KApply", "variable": false}], "arity": 2, "label": {"name": "#And", "node": "KLabel", "params": [{"name": "GeneratedTopCell", "node": "KSort", "params": []}]}, "node": "KApply", "variable": false}',
  "ml/and-filter-top-other-sort":
    '{"args": [{"args": [], "arity": 0, "label": {"name": "a", "node": "KLabel", "params": []}, "node": "KApply", "variable": false}, {"args": [], "arity": 0, "label": {"name": "b", "node": "KLabel", "params": []}, "node": "KApply", "variable": false}], "arity": 2, "label": {"name": "#And", "node": "KLabel", "params": [{"name": "GeneratedTopCell", "node": "KSort", "params": []}]}, "node": "KApply", "variable": false}',
  "ml/and-all-top":
    '{"args": [], "arity": 0, "label": {"name": "#Top", "node": "KLabel", "params": [{"name": "GeneratedTopCell", "node": "KSort", "params": []}]}, "node": "KApply", "variable": false}',
  "ml/and-dup":
    '{"args": [{"args": [], "arity": 0, "label": {"name": "a", "node": "KLabel", "params": []}, "node": "KApply", "variable": false}, {"args": [], "arity": 0, "label": {"name": "a", "node": "KLabel", "params": []}, "node": "KApply", "variable": false}], "arity": 2, "label": {"name": "#And", "node": "KLabel", "params": [{"name": "GeneratedTopCell", "node": "KSort", "params": []}]}, "node": "KApply", "variable": false}',
  "ml/and-sorted":
    '{"args": [{"args": [], "arity": 0, "label": {"name": "a", "node": "KLabel", "params": []}, "node": "KApply", "variable": false}, {"args": [], "arity": 0, "label": {"name": "b", "node": "KLabel", "params": []}, "node": "KApply", "variable": false}], "arity": 2, "label": {"name": "#And", "node": "KLabel", "params": [{"name": "K", "node": "KSort", "params": []}]}, "node": "KApply", "variable": false}',
  "ml/or-0":
    '{"args": [], "arity": 0, "label": {"name": "#Bottom", "node": "KLabel", "params": [{"name": "GeneratedTopCell", "node": "KSort", "params": []}]}, "node": "KApply", "variable": false}',
  "ml/or-1":
    '{"args": [], "arity": 0, "label": {"name": "a", "node": "KLabel", "params": []}, "node": "KApply", "variable": false}',
  "ml/or-2":
    '{"args": [{"args": [], "arity": 0, "label": {"name": "a", "node": "KLabel", "params": []}, "node": "KApply", "variable": false}, {"args": [], "arity": 0, "label": {"name": "b", "node": "KLabel", "params": []}, "node": "KApply", "variable": false}], "arity": 2, "label": {"name": "#Or", "node": "KLabel", "params": [{"name": "GeneratedTopCell", "node": "KSort", "params": []}]}, "node": "KApply", "variable": false}',
  "ml/or-3":
    '{"args": [{"args": [], "arity": 0, "label": {"name": "a", "node": "KLabel", "params": []}, "node": "KApply", "variable": false}, {"args": [{"args": [], "arity": 0, "label": {"name": "b", "node": "KLabel", "params": []}, "node": "KApply", "variable": false}, {"args": [], "arity": 0, "label": {"name": "c", "node": "KLabel", "params": []}, "node": "KApply", "variable": false}], "arity": 2, "label": {"name": "#Or", "node": "KLabel", "params": [{"name": "GeneratedTopCell", "node": "KSort", "params": []}]}, "node": "KApply", "variable": false}], "arity": 2, "label": {"name": "#Or", "node": "KLabel", "params": [{"name": "GeneratedTopCell", "node": "KSort", "params": []}]}, "node": "KApply", "variable": false}',
  "ml/or-4":
    '{"args": [{"args": [], "arity": 0, "label": {"name": "a", "node": "KLabel", "params": []}, "node": "KApply", "variable": false}, {"args": [{"args": [], "arity": 0, "label": {"name": "b", "node": "KLabel", "params": []}, "node": "KApply", "variable": false}, {"args": [{"args": [], "arity": 0, "label": {"name": "c", "node": "KLabel", "params": []}, "node": "KApply", "variable": false}, {"name": "x", "node": "KVariable"}], "arity": 2, "label": {"name": "#Or", "node": "KLabel", "params": [{"name": "GeneratedTopCell", "node": "KSort", "params": []}]}, "node": "KApply", "variable": false}], "arity": 2, "label": {"name": "#Or", "node": "KLabel", "params": [{"name": "GeneratedTopCell", "node": "KSort", "params": []}]}, "node": "KApply", "variable": false}], "arity": 2, "label": {"name": "#Or", "node": "KLabel", "params": [{"name": "GeneratedTopCell", "node": "KSort", "params": []}]}, "node": "KApply", "variable": false}',
  "ml/or-filter-bottom":
    '{"args": [{"args": [], "arity": 0, "label": {"name": "a", "node": "KLabel", "params": []}, "node": "KApply", "variable": false}, {"args": [], "arity": 0, "label": {"name": "b", "node": "KLabel", "params": []}, "node": "KApply", "variable": false}], "arity": 2, "label": {"name": "#Or", "node": "KLabel", "params": [{"name": "GeneratedTopCell", "node": "KSort", "params": []}]}, "node": "KApply", "variable": false}',
  "ml/or-all-bottom":
    '{"args": [], "arity": 0, "label": {"name": "#Bottom", "node": "KLabel", "params": [{"name": "GeneratedTopCell", "node": "KSort", "params": []}]}, "node": "KApply", "variable": false}',
  "ml/or-sorted":
    '{"args": [{"args": [], "arity": 0, "label": {"name": "a", "node": "KLabel", "params": []}, "node": "KApply", "variable": false}, {"args": [], "arity": 0, "label": {"name": "b", "node": "KLabel", "params": []}, "node": "KApply", "variable": false}], "arity": 2, "label": {"name": "#Or", "node": "KLabel", "params": [{"name": "K", "node": "KSort", "params": []}]}, "node": "KApply", "variable": false}',
  "ml/implies":
    '{"args": [{"args": [], "arity": 0, "label": {"name": "a", "node": "KLabel", "params": []}, "node": "KApply", "variable": false}, {"args": [], "arity": 0, "label": {"name": "b", "node": "KLabel", "params": []}, "node": "KApply", "variable": false}], "arity": 2, "label": {"name": "#Implies", "node": "KLabel", "params": [{"name": "GeneratedTopCell", "node": "KSort", "params": []}]}, "node": "KApply", "variable": false}',
  "ml/implies-sorted":
    '{"args": [{"args": [], "arity": 0, "label": {"name": "a", "node": "KLabel", "params": []}, "node": "KApply", "variable": false}, {"args": [], "arity": 0, "label": {"name": "b", "node": "KLabel", "params": []}, "node": "KApply", "variable": false}], "arity": 2, "label": {"name": "#Implies", "node": "KLabel", "params": [{"name": "K", "node": "KSort", "params": []}]}, "node": "KApply", "variable": false}',
  "ml/exists":
    '{"args": [{"name": "x", "node": "KVariable"}, {"args": [], "arity": 0, "label": {"name": "a", "node": "KLabel", "params": []}, "node": "KApply", "variable": false}], "arity": 2, "label": {"name": "#Exists", "node": "KLabel", "params": [{"name": "KItem", "node": "KSort", "params": []}, {"name": "GeneratedTopCell", "node": "KSort", "params": []}]}, "node": "KApply", "variable": false}',
  "ml/exists-sorted":
    '{"args": [{"name": "x", "node": "KVariable"}, {"args": [], "arity": 0, "label": {"name": "a", "node": "KLabel", "params": []}, "node": "KApply", "variable": false}], "arity": 2, "label": {"name": "#Exists", "node": "KLabel", "params": [{"name": "Int", "node": "KSort", "params": []}, {"name": "K", "node": "KSort", "params": []}]}, "node": "KApply", "variable": false}',
  "ml/ceil":
    '{"args": [{"args": [], "arity": 0, "label": {"name": "a", "node": "KLabel", "params": []}, "node": "KApply", "variable": false}], "arity": 1, "label": {"name": "#Ceil", "node": "KLabel", "params": [{"name": "GeneratedTopCell", "node": "KSort", "params": []}, {"name": "GeneratedTopCell", "node": "KSort", "params": []}]}, "node": "KApply", "variable": false}',
  "ml/ceil-sorted":
    '{"args": [{"args": [], "arity": 0, "label": {"name": "a", "node": "KLabel", "params": []}, "node": "KApply", "variable": false}], "arity": 1, "label": {"name": "#Ceil", "node": "KLabel", "params": [{"name": "Int", "node": "KSort", "params": []}, {"name": "K", "node": "KSort", "params": []}]}, "node": "KApply", "variable": false}',
  "string/sort": '{"node": "KToken", "sort": {"name": "String", "node": "KSort", "params": []}, "token": "t"}',
  "string/token-empty":
    '{"node": "KToken", "sort": {"name": "String", "node": "KSort", "params": []}, "token": "\\"\\""}',
  "string/token-plain":
    '{"node": "KToken", "sort": {"name": "String", "node": "KSort", "params": []}, "token": "\\"hello\\""}',
  "string/token-escapes":
    '{"node": "KToken", "sort": {"name": "String", "node": "KSort", "params": []}, "token": "\\"a\\\\tb\\\\nc\\\\\\\\\\\\\\"d\\""}',
  "string/token-unicode":
    '{"node": "KToken", "sort": {"name": "String", "node": "KSort", "params": []}, "token": "\\"h\\\\xe9llo \\\\u2603 \\\\U0001d11e\\""}',
  "string/token-control":
    '{"node": "KToken", "sort": {"name": "String", "node": "KSort", "params": []}, "token": "\\"\\\\x00\\\\x01\\\\x1f\\\\x7f\\""}',
  "bytes/sort": '{"node": "KToken", "sort": {"name": "Bytes", "node": "KSort", "params": []}, "token": "t"}',
  "bytes/token-empty":
    '{"node": "KToken", "sort": {"name": "Bytes", "node": "KSort", "params": []}, "token": "b\\"\\""}',
  "bytes/token-ascii":
    '{"node": "KToken", "sort": {"name": "Bytes", "node": "KSort", "params": []}, "token": "b\\"WASM\\""}',
  "bytes/token-binary":
    '{"node": "KToken", "sort": {"name": "Bytes", "node": "KSort", "params": []}, "token": "b\\"\\\\x00A\\\\xff\\""}',
  "bytes/token-from-str":
    '{"node": "KToken", "sort": {"name": "Bytes", "node": "KSort", "params": []}, "token": "b\\"foo\\\\xaa\\\\x01bar\\""}',
  "collections/sort-Set": '{"node": "KToken", "sort": {"name": "Set", "node": "KSort", "params": []}, "token": "t"}',
  "collections/sort-List": '{"node": "KToken", "sort": {"name": "List", "node": "KSort", "params": []}, "token": "t"}',
  "collections/sort-Map": '{"node": "KToken", "sort": {"name": "Map", "node": "KSort", "params": []}, "token": "t"}',
  "collections/sort-RangeMap":
    '{"node": "KToken", "sort": {"name": "RangeMap", "node": "KSort", "params": []}, "token": "t"}',
  "collections/sort-Bag": '{"node": "KToken", "sort": {"name": "Bag", "node": "KSort", "params": []}, "token": "t"}',
  "collections/set-empty":
    '{"args": [], "arity": 0, "label": {"name": ".Set", "node": "KLabel", "params": []}, "node": "KApply", "variable": false}',
  "collections/set-item":
    '{"args": [{"args": [], "arity": 0, "label": {"name": "a", "node": "KLabel", "params": []}, "node": "KApply", "variable": false}], "arity": 1, "label": {"name": "SetItem", "node": "KLabel", "params": []}, "node": "KApply", "variable": false}',
  "collections/set-of-0":
    '{"args": [], "arity": 0, "label": {"name": ".Set", "node": "KLabel", "params": []}, "node": "KApply", "variable": false}',
  "collections/set-of-1":
    '{"args": [{"args": [], "arity": 0, "label": {"name": "a", "node": "KLabel", "params": []}, "node": "KApply", "variable": false}], "arity": 1, "label": {"name": "SetItem", "node": "KLabel", "params": []}, "node": "KApply", "variable": false}',
  "collections/set-of-3":
    '{"args": [{"args": [{"args": [], "arity": 0, "label": {"name": "a", "node": "KLabel", "params": []}, "node": "KApply", "variable": false}], "arity": 1, "label": {"name": "SetItem", "node": "KLabel", "params": []}, "node": "KApply", "variable": false}, {"args": [{"args": [{"args": [], "arity": 0, "label": {"name": "b", "node": "KLabel", "params": []}, "node": "KApply", "variable": false}], "arity": 1, "label": {"name": "SetItem", "node": "KLabel", "params": []}, "node": "KApply", "variable": false}, {"args": [{"args": [], "arity": 0, "label": {"name": "c", "node": "KLabel", "params": []}, "node": "KApply", "variable": false}], "arity": 1, "label": {"name": "SetItem", "node": "KLabel", "params": []}, "node": "KApply", "variable": false}], "arity": 2, "label": {"name": "_Set_", "node": "KLabel", "params": []}, "node": "KApply", "variable": false}], "arity": 2, "label": {"name": "_Set_", "node": "KLabel", "params": []}, "node": "KApply", "variable": false}',
  "collections/set-of-dup":
    '{"args": [{"args": [{"args": [], "arity": 0, "label": {"name": "a", "node": "KLabel", "params": []}, "node": "KApply", "variable": false}], "arity": 1, "label": {"name": "SetItem", "node": "KLabel", "params": []}, "node": "KApply", "variable": false}, {"args": [{"args": [], "arity": 0, "label": {"name": "a", "node": "KLabel", "params": []}, "node": "KApply", "variable": false}], "arity": 1, "label": {"name": "SetItem", "node": "KLabel", "params": []}, "node": "KApply", "variable": false}], "arity": 2, "label": {"name": "_Set_", "node": "KLabel", "params": []}, "node": "KApply", "variable": false}',
  "collections/list-empty":
    '{"args": [], "arity": 0, "label": {"name": ".List", "node": "KLabel", "params": []}, "node": "KApply", "variable": false}',
  "collections/list-item":
    '{"args": [{"args": [], "arity": 0, "label": {"name": "a", "node": "KLabel", "params": []}, "node": "KApply", "variable": false}], "arity": 1, "label": {"name": "ListItem", "node": "KLabel", "params": []}, "node": "KApply", "variable": false}',
  "collections/list-of-0":
    '{"args": [], "arity": 0, "label": {"name": ".List", "node": "KLabel", "params": []}, "node": "KApply", "variable": false}',
  "collections/list-of-1":
    '{"args": [{"args": [], "arity": 0, "label": {"name": "a", "node": "KLabel", "params": []}, "node": "KApply", "variable": false}], "arity": 1, "label": {"name": "ListItem", "node": "KLabel", "params": []}, "node": "KApply", "variable": false}',
  "collections/list-of-3":
    '{"args": [{"args": [{"args": [], "arity": 0, "label": {"name": "a", "node": "KLabel", "params": []}, "node": "KApply", "variable": false}], "arity": 1, "label": {"name": "ListItem", "node": "KLabel", "params": []}, "node": "KApply", "variable": false}, {"args": [{"args": [{"args": [], "arity": 0, "label": {"name": "b", "node": "KLabel", "params": []}, "node": "KApply", "variable": false}], "arity": 1, "label": {"name": "ListItem", "node": "KLabel", "params": []}, "node": "KApply", "variable": false}, {"args": [{"args": [], "arity": 0, "label": {"name": "c", "node": "KLabel", "params": []}, "node": "KApply", "variable": false}], "arity": 1, "label": {"name": "ListItem", "node": "KLabel", "params": []}, "node": "KApply", "variable": false}], "arity": 2, "label": {"name": "_List_", "node": "KLabel", "params": []}, "node": "KApply", "variable": false}], "arity": 2, "label": {"name": "_List_", "node": "KLabel", "params": []}, "node": "KApply", "variable": false}',
  "collections/map-empty":
    '{"args": [], "arity": 0, "label": {"name": ".Map", "node": "KLabel", "params": []}, "node": "KApply", "variable": false}',
  "collections/map-item":
    '{"args": [{"args": [], "arity": 0, "label": {"name": "a", "node": "KLabel", "params": []}, "node": "KApply", "variable": false}, {"args": [], "arity": 0, "label": {"name": "b", "node": "KLabel", "params": []}, "node": "KApply", "variable": false}], "arity": 2, "label": {"name": "_|->_", "node": "KLabel", "params": []}, "node": "KApply", "variable": false}',
  "collections/map-of-0":
    '{"args": [], "arity": 0, "label": {"name": ".Map", "node": "KLabel", "params": []}, "node": "KApply", "variable": false}',
  "collections/map-of-1":
    '{"args": [{"args": [], "arity": 0, "label": {"name": "a", "node": "KLabel", "params": []}, "node": "KApply", "variable": false}, {"args": [], "arity": 0, "label": {"name": "b", "node": "KLabel", "params": []}, "node": "KApply", "variable": false}], "arity": 2, "label": {"name": "_|->_", "node": "KLabel", "params": []}, "node": "KApply", "variable": false}',
  "collections/map-of-2":
    '{"args": [{"args": [{"args": [], "arity": 0, "label": {"name": "a", "node": "KLabel", "params": []}, "node": "KApply", "variable": false}, {"args": [], "arity": 0, "label": {"name": "b", "node": "KLabel", "params": []}, "node": "KApply", "variable": false}], "arity": 2, "label": {"name": "_|->_", "node": "KLabel", "params": []}, "node": "KApply", "variable": false}, {"args": [{"args": [], "arity": 0, "label": {"name": "b", "node": "KLabel", "params": []}, "node": "KApply", "variable": false}, {"args": [], "arity": 0, "label": {"name": "c", "node": "KLabel", "params": []}, "node": "KApply", "variable": false}], "arity": 2, "label": {"name": "_|->_", "node": "KLabel", "params": []}, "node": "KApply", "variable": false}], "arity": 2, "label": {"name": "_Map_", "node": "KLabel", "params": []}, "node": "KApply", "variable": false}',
  "collections/map-of-dup-key":
    '{"args": [{"args": [{"args": [], "arity": 0, "label": {"name": "a", "node": "KLabel", "params": []}, "node": "KApply", "variable": false}, {"args": [], "arity": 0, "label": {"name": "c", "node": "KLabel", "params": []}, "node": "KApply", "variable": false}], "arity": 2, "label": {"name": "_|->_", "node": "KLabel", "params": []}, "node": "KApply", "variable": false}, {"args": [{"args": [], "arity": 0, "label": {"name": "b", "node": "KLabel", "params": []}, "node": "KApply", "variable": false}, {"args": [], "arity": 0, "label": {"name": "b", "node": "KLabel", "params": []}, "node": "KApply", "variable": false}], "arity": 2, "label": {"name": "_|->_", "node": "KLabel", "params": []}, "node": "KApply", "variable": false}], "arity": 2, "label": {"name": "_Map_", "node": "KLabel", "params": []}, "node": "KApply", "variable": false}',
  "collections/rangemap-empty":
    '{"args": [], "arity": 0, "label": {"name": ".RangeMap", "node": "KLabel", "params": []}, "node": "KApply", "variable": false}',
  "collections/rangemap-item":
    '{"args": [{"args": [{"node": "KToken", "sort": {"name": "Int", "node": "KSort", "params": []}, "token": "1"}, {"node": "KToken", "sort": {"name": "Int", "node": "KSort", "params": []}, "token": "2"}], "arity": 2, "label": {"name": "RangeMap:Range", "node": "KLabel", "params": []}, "node": "KApply", "variable": false}, {"args": [], "arity": 0, "label": {"name": "a", "node": "KLabel", "params": []}, "node": "KApply", "variable": false}], "arity": 2, "label": {"name": "_r|->_", "node": "KLabel", "params": []}, "node": "KApply", "variable": false}',
  "collections/rangemap-of-0":
    '{"args": [], "arity": 0, "label": {"name": ".RangeMap", "node": "KLabel", "params": []}, "node": "KApply", "variable": false}',
  "collections/rangemap-of-1":
    '{"args": [{"args": [{"node": "KToken", "sort": {"name": "Int", "node": "KSort", "params": []}, "token": "1"}, {"node": "KToken", "sort": {"name": "Int", "node": "KSort", "params": []}, "token": "2"}], "arity": 2, "label": {"name": "RangeMap:Range", "node": "KLabel", "params": []}, "node": "KApply", "variable": false}, {"args": [], "arity": 0, "label": {"name": "a", "node": "KLabel", "params": []}, "node": "KApply", "variable": false}], "arity": 2, "label": {"name": "_r|->_", "node": "KLabel", "params": []}, "node": "KApply", "variable": false}',
  "collections/rangemap-of-2":
    '{"args": [{"args": [{"args": [{"node": "KToken", "sort": {"name": "Int", "node": "KSort", "params": []}, "token": "1"}, {"node": "KToken", "sort": {"name": "Int", "node": "KSort", "params": []}, "token": "2"}], "arity": 2, "label": {"name": "RangeMap:Range", "node": "KLabel", "params": []}, "node": "KApply", "variable": false}, {"args": [], "arity": 0, "label": {"name": "a", "node": "KLabel", "params": []}, "node": "KApply", "variable": false}], "arity": 2, "label": {"name": "_r|->_", "node": "KLabel", "params": []}, "node": "KApply", "variable": false}, {"args": [{"args": [{"node": "KToken", "sort": {"name": "Int", "node": "KSort", "params": []}, "token": "2"}, {"node": "KToken", "sort": {"name": "Int", "node": "KSort", "params": []}, "token": "3"}], "arity": 2, "label": {"name": "RangeMap:Range", "node": "KLabel", "params": []}, "node": "KApply", "variable": false}, {"args": [], "arity": 0, "label": {"name": "b", "node": "KLabel", "params": []}, "node": "KApply", "variable": false}], "arity": 2, "label": {"name": "_r|->_", "node": "KLabel", "params": []}, "node": "KApply", "variable": false}], "arity": 2, "label": {"name": "_RangeMap_", "node": "KLabel", "params": []}, "node": "KApply", "variable": false}',
  "collections/rangemap-of-dup-key":
    '{"args": [{"args": [{"args": [{"node": "KToken", "sort": {"name": "Int", "node": "KSort", "params": []}, "token": "1"}, {"node": "KToken", "sort": {"name": "Int", "node": "KSort", "params": []}, "token": "2"}], "arity": 2, "label": {"name": "RangeMap:Range", "node": "KLabel", "params": []}, "node": "KApply", "variable": false}, {"args": [], "arity": 0, "label": {"name": "c", "node": "KLabel", "params": []}, "node": "KApply", "variable": false}], "arity": 2, "label": {"name": "_r|->_", "node": "KLabel", "params": []}, "node": "KApply", "variable": false}, {"args": [{"args": [{"node": "KToken", "sort": {"name": "Int", "node": "KSort", "params": []}, "token": "2"}, {"node": "KToken", "sort": {"name": "Int", "node": "KSort", "params": []}, "token": "3"}], "arity": 2, "label": {"name": "RangeMap:Range", "node": "KLabel", "params": []}, "node": "KApply", "variable": false}, {"args": [], "arity": 0, "label": {"name": "b", "node": "KLabel", "params": []}, "node": "KApply", "variable": false}], "arity": 2, "label": {"name": "_r|->_", "node": "KLabel", "params": []}, "node": "KApply", "variable": false}], "arity": 2, "label": {"name": "_RangeMap_", "node": "KLabel", "params": []}, "node": "KApply", "variable": false}',
  "utils/token-bool": '{"node": "KToken", "sort": {"name": "Bool", "node": "KSort", "params": []}, "token": "true"}',
  "utils/token-int": '{"node": "KToken", "sort": {"name": "Int", "node": "KSort", "params": []}, "token": "-7"}',
  "utils/token-big-int":
    '{"node": "KToken", "sort": {"name": "Int", "node": "KSort", "params": []}, "token": "18446744073709551617"}',
  "utils/token-str":
    '{"node": "KToken", "sort": {"name": "String", "node": "KSort", "params": []}, "token": "\\"a\\\\\\"b\\""}',
  "utils/token-bytes":
    '{"node": "KToken", "sort": {"name": "Bytes", "node": "KSort", "params": []}, "token": "b\\"\\\\x00\\\\xff\\""}',
};

describe("prelude parity with pyk 7.1.337", () => {
  test("the table covers every generated row, and nothing else", () => {
    expect(TERMS.map(([id]) => id).toSorted()).toEqual(Object.keys(EXPECTED).toSorted());
  });

  for (const [id, term] of TERMS) {
    test(id, () => {
      const expected = EXPECTED[id];
      if (expected === undefined) throw new Error(`No pyk output committed for ${id}`);
      expect(canonicalJson(toDict(term))).toBe(expected);
    });
  }
});
