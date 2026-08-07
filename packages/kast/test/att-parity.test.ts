/**
 * Differential parity with pyk for `KAtt` — `from_dict`/`to_dict`, `parse`, and
 * `pretty` — plus the whole `Atts` registry, name by name and codec by codec.
 *
 * Every expected value below is what pyk itself prints at K **v7.1.337**,
 * generated once by the script in this header and committed.  The *inputs* are
 * written twice, once in Python and once in TypeScript, so a drift in a codec,
 * a key name, a key type or the registry's order fails here.
 *
 * The `fixture/*` rows are real attribute dicts lifted out of
 * `pyk/src/tests/unit/test-data/parse-outer/*.expected.json` (`KDefinition`
 * JSONs); everything else is hand-built to reach a codec the fixtures never
 * exercise — those fixtures only ever carry a `Location`.
 *
 * The `registry/all` row is generated on *both* sides by walking the registry
 * and picking a sample value per codec, so it fails if the two registries
 * disagree about any key at all, except `userList`: persisted K artifacts only
 * use `"*"` and `"+"`, so this package deliberately closes that one pyk
 * `AnyType` key and records the local sample below.
 *
 * pyk *installed* will not do: it is 7.1.174 there, several `Atts` keys older.
 * `$K` below is a checkout of `runtimeverification/k` at the v7.1.337 tag.
 *
 * # Regenerating
 *
 * The script prints the bodies of {@link REGISTRY}, {@link EXPECTED},
 * {@link EXPECTED_JSON_ONLY} and {@link EXPECTED_PARSE} on stdout:
 *
 * ```sh
 * PYTHONPATH=$K/pyk/src python3 - <<'PY'
 * import json
 *
 * from pyk.kast.att import (
 *     AnyType,
 *     Atts,
 *     ColorType,
 *     ColorsType,
 *     FormatType,
 *     IntType,
 *     KAtt,
 *     LocationType,
 *     NoneType,
 *     OptionalType,
 *     PathType,
 *     StrType,
 * )
 *
 *
 * def tag(t):
 *     if isinstance(t, OptionalType):
 *         return f'OptionalType[{tag(t._value_type)}]'
 *     return type(t).__name__
 *
 *
 * SAMPLE = {
 *     'NoneType': '',
 *     'AnyType': 'any-value',
 *     'IntType': '42',
 *     'StrType': 'str-value',
 *     'LocationType': [1, 2, 3, 4],
 *     'PathType': '/a/b.k',
 *     'FormatType': '%1 + %2',
 *     'ColorType': 'red',
 *     'ColorsType': 'red, blue',
 *     'OptionalType[StrType]': 'opt-value',
 * }
 *
 * ALL_KEYS = {name: SAMPLE[tag(key.type)] for name, key in Atts.keys().items()}
 * ALL_BUT_FORMAT = {k: v for k, v in ALL_KEYS.items() if k != 'format'}
 *
 * FROM_DICT = [
 *     ('empty', {}),
 *     ('fixture/a.k-a-syntax', {'org.kframework.attributes.Location': [1, 1, 2, 10]}),
 *     ('fixture/a.k-a', {'org.kframework.attributes.Location': [4, 1, 6, 10]}),
 *     ('fixture/b.k-b', {'org.kframework.attributes.Location': [6, 1, 9, 10]}),
 *     ('fixture/d.k-d', {'org.kframework.attributes.Location': [7, 1, 11, 10]}),
 *     ('fixture/include.k', {'org.kframework.attributes.Location': [3, 1, 6, 10]}),
 *     ('nullary', {'function': ''}),
 *     ('nullary-two', {'function': '', 'total': ''}),
 *     ('str', {'symbol': 'foo'}),
 *     ('str-empty', {'symbol': ''}),
 *     ('str-quotes', {'symbol': 'a"b'}),
 *     ('optional-none', {'concrete': ''}),
 *     ('optional-some', {'concrete': 'foo'}),
 *     ('optional-all', {'concrete': 'c', 'hybrid': '', 'stream': 'stdin', 'symbolic': ''}),
 *     ('int', {'index': '42'}),
 *     ('int-zero', {'index': '0'}),
 *     ('int-negative', {'index': '-1'}),
 *     ('location', {'org.kframework.attributes.Location': [12, 3, 12, 40]}),
 *     ('source', {'org.kframework.attributes.Source': '/home/k/imp.k'}),
 *     ('source-unnormalized', {'org.kframework.attributes.Source': 'a//b/./c/'}),
 *     ('source-relative', {'org.kframework.attributes.Source': './a/../b'}),
 *     ('source-empty', {'org.kframework.attributes.Source': ''}),
 *     ('source-double-slash', {'org.kframework.attributes.Source': '//srv//x'}),
 *     ('color', {'color': 'red'}),
 *     ('color-camel', {'color': 'LightSteelBlue'}),
 *     ('colors', {'colors': 'red,blue'}),
 *     ('colors-spaces', {'colors': ' red , blue ,LightGray'}),
 *     ('colors-single', {'colors': 'pink'}),
 *     ('any-string', {'label': 'foo'}),
 *     ('any-empty-string', {'label': ''}),
 *     ('unknown-key', {'my-att': 'some value'}),
 *     ('unknown-key-empty', {'my-att': ''}),
 *     ('unknown-list', {'my-att': ['a', 'b']}),
 *     ('unknown-list-single', {'my-att': ['a']}),
 *     ('unknown-list-empty', {'my-att': []}),
 *     ('unknown-list-nested', {'my-att': ['a', ['b', ['c']]]}),
 *     ('unknown-dict', {'my-att': {'a': ['b', 1], 'c': True}}),
 *     ('unknown-dict-empty', {'my-att': {}}),
 *     ('unknown-int', {'my-att': 42}),
 *     ('unknown-bool', {'my-att': [True, False, None]}),
 *     ('unknown-quotes', {'my-att': ["it's", 'a "b"', 'both \' and "']}),
 *     ('unknown-escapes', {'my-att': ['a\tb\nc\\d', '\x00\x1f\x7f']}),
 *     ('unknown-unicode', {'my-att': ['h\xe9llo \u2603 \U0001d11e', '\xad\u200b']}),
 *     ('production-like', {
 *         'symbol': 'foo',
 *         'function': '',
 *         'total': '',
 *         'klabel': 'foo',
 *         'org.kframework.attributes.Location': [1, 2, 3, 4],
 *         'org.kframework.attributes.Source': '/a/b.k',
 *     }),
 *     ('registry/all', ALL_BUT_FORMAT),
 * ]
 *
 * FROM_DICT_JSON_ONLY = [
 *     ('registry/format', {'format': '%1 + %2'}),
 *     ('format-empty', {'format': ''}),
 *     ('format-escapes', {'format': '%%%12%c%1 x'}),
 *     ('format-newline', {'format': '%n%i%d'}),
 * ]
 *
 * PARSE = [
 *     ('parse/empty', {}),
 *     ('parse/nullary', {'function': ''}),
 *     ('parse/str', {'symbol': 'foo'}),
 *     ('parse/optional-none', {'concrete': ''}),
 *     ('parse/optional-some', {'concrete': 'foo'}),
 *     ('parse/int', {'index': '42'}),
 *     ('parse/location', {'org.kframework.attributes.Location': '1,2,3,4'}),
 *     ('parse/source', {'org.kframework.attributes.Source': 'a//b/./c'}),
 *     ('parse/color', {'color': 'red'}),
 *     ('parse/colors', {'colors': 'red, blue'}),
 *     ('parse/mixed', {
 *         'symbol': 'foo',
 *         'function': '',
 *         'org.kframework.attributes.Location': '1,2,3,4',
 *         'org.kframework.attributes.Source': '/a/b.k',
 *         'index': '7',
 *         'cellName': 'k',
 *         'stream': 'stdin',
 *         'hybrid': '',
 *     }),
 * ]
 *
 *
 * def row(name, att):
 *     print(f'  {json.dumps(name)}: [')
 *     print(f'    {json.dumps(json.dumps(att.to_dict(), sort_keys=True))},')
 *     print(f'    {json.dumps(att.pretty)},')
 *     print('  ],')
 *
 *
 * print('// ---- REGISTRY ----')
 * for name, key in Atts.keys().items():
 *     print(f'  [{json.dumps(name)}, {json.dumps(tag(key.type))}],')
 *
 * print('// ---- EXPECTED (from_dict) ----')
 * for name, d in FROM_DICT:
 *     row(name, KAtt.from_dict({'att': d}))
 *
 * print('// ---- EXPECTED_JSON_ONLY (from_dict, pretty is unstable upstream) ----')
 * for name, d in FROM_DICT_JSON_ONLY:
 *     att = KAtt.from_dict({'att': d})
 *     print(f'  {json.dumps(name)}: {json.dumps(json.dumps(att.to_dict(), sort_keys=True))},')
 *
 * print('// ---- EXPECTED (parse) ----')
 * for name, d in PARSE:
 *     row(name, KAtt.parse(d))
 *
 * print('// ---- registry/all input dict ----')
 * print(json.dumps(ALL_BUT_FORMAT, indent=2, sort_keys=True))
 * PY
 * ```
 *
 * # `format` has no committed `pretty`
 *
 * `att.py:212` renders a `format` attribute by interpolating the *method*
 * `value.unparse` instead of calling it, so pyk prints
 * `format("<bound method Format.unparse of Format(tokens=(...))>")` — a string
 * containing a heap address, which is neither stable nor meaningful.
 * {@link FORMAT_TYPE} prints `format("%1 + %2")`; those rows therefore pin the
 * JSON only, and `att.test.ts` pins the TypeScript spelling of `pretty`.
 */

/* oxlint-disable unicorn/escape-case -- the tables below are pasted verbatim
   from the generator in the header, and `json.dumps` writes its `\uXXXX`
   escapes in lowercase. Rewriting them by hand would only be undone the next
   time the tables are regenerated, and the strings are identical either way. */

import { describe, expect, test } from "bun:test";
import {
  ANY_TYPE,
  Atts,
  COLORS_TYPE,
  COLOR_TYPE,
  FORMAT_TYPE,
  INT_TYPE,
  KAtt,
  LOCATION_TYPE,
  NONE_TYPE,
  PATH_TYPE,
  STR_TYPE,
  USER_LIST_TYPE,
  attKeys,
  type AttKey,
} from "../src/att.ts";
import { canonicalJson } from "../src/eq.ts";
import type { JsonObject, JsonValue } from "../src/json.ts";

////////////////////////////////////////////
// The registry, key by key                //
////////////////////////////////////////////

/** Every `Atts` entry as `[name, codec]`, in declaration order (`att.py:288-375`). */
const REGISTRY: readonly (readonly [string, string])[] = [
  ["alias", "NoneType"],
  ["alias-rec", "NoneType"],
  ["anywhere", "NoneType"],
  ["assoc", "NoneType"],
  ["avoid", "NoneType"],
  ["bracket", "NoneType"],
  ["bracketLabel", "AnyType"],
  ["circularity", "NoneType"],
  ["cell", "NoneType"],
  ["cellCollection", "NoneType"],
  ["cellFragment", "AnyType"],
  ["cellName", "StrType"],
  ["cellOptAbsent", "AnyType"],
  ["color", "ColorType"],
  ["colors", "ColorsType"],
  ["comm", "NoneType"],
  ["concat", "AnyType"],
  ["concrete", "OptionalType[StrType]"],
  ["constructor", "NoneType"],
  ["depends", "AnyType"],
  ["digest", "AnyType"],
  ["element", "AnyType"],
  ["exit", "AnyType"],
  ["format", "FormatType"],
  ["freshGenerator", "NoneType"],
  ["function", "NoneType"],
  ["functional", "NoneType"],
  ["group", "StrType"],
  ["hasDomainValues", "NoneType"],
  ["hook", "AnyType"],
  ["hybrid", "OptionalType[StrType]"],
  ["idem", "NoneType"],
  ["impure", "NoneType"],
  ["index", "IntType"],
  ["initializer", "NoneType"],
  ["injective", "NoneType"],
  ["label", "AnyType"],
  ["left", "AnyType"],
  ["org.kframework.attributes.Location", "LocationType"],
  ["macro", "NoneType"],
  ["macro-rec", "NoneType"],
  ["maincell", "NoneType"],
  ["multiplicity", "AnyType"],
  ["no-evaluators", "NoneType"],
  ["overload", "StrType"],
  ["owise", "NoneType"],
  ["predicate", "AnyType"],
  ["prefer", "NoneType"],
  ["priority", "AnyType"],
  ["priorities", "AnyType"],
  ["private", "NoneType"],
  ["org.kframework.definition.Production", "AnyType"],
  ["projection", "NoneType"],
  ["public", "NoneType"],
  ["right", "AnyType"],
  ["returnsUnit", "NoneType"],
  ["simplification", "AnyType"],
  ["seqstrict", "AnyType"],
  ["org.kframework.kore.Sort", "AnyType"],
  ["org.kframework.attributes.Source", "PathType"],
  ["stream", "OptionalType[StrType]"],
  ["smt-lemma", "NoneType"],
  ["strict", "AnyType"],
  ["symbol", "StrType"],
  ["syntaxModule", "StrType"],
  ["symbolic", "OptionalType[StrType]"],
  ["terminals", "StrType"],
  ["terminator-symbol", "AnyType"],
  ["token", "NoneType"],
  ["total", "NoneType"],
  ["trusted", "NoneType"],
  ["type", "AnyType"],
  ["unit", "StrType"],
  ["UNIQUE_ID", "AnyType"],
  ["unparseAvoid", "NoneType"],
  ["unused", "NoneType"],
  ["update", "AnyType"],
  ["userList", "UserListType"],
  ["wrapElement", "AnyType"],
];

/**
 * The tag the generator prints for a codec — `type(key.type).__name__`, with
 * `OptionalType` naming the type it wraps.
 *
 * Looking the *instance* up (rather than sniffing a field) also asserts that
 * every optional-valued key shares one `optionalType(STR_TYPE)`, the way pyk
 * shares `_STR` between its four `OptionalType(_STR)` keys.
 */
const TAGS: ReadonlyMap<unknown, string> = new Map<unknown, string>([
  [NONE_TYPE, "NoneType"],
  [ANY_TYPE, "AnyType"],
  [INT_TYPE, "IntType"],
  [STR_TYPE, "StrType"],
  [LOCATION_TYPE, "LocationType"],
  [PATH_TYPE, "PathType"],
  [FORMAT_TYPE, "FormatType"],
  [COLOR_TYPE, "ColorType"],
  [COLORS_TYPE, "ColorsType"],
  [USER_LIST_TYPE, "UserListType"],
  [Atts.CONCRETE.type, "OptionalType[StrType]"],
]);

function tagOf(key: AttKey): string {
  return TAGS.get(key.type) ?? `unknown codec for ${key.name}`;
}

/** One value per codec, matching the generator's `SAMPLE` table. */
const SAMPLE: Readonly<Record<string, JsonValue>> = {
  NoneType: "",
  AnyType: "any-value",
  IntType: "42",
  StrType: "str-value",
  LocationType: [1, 2, 3, 4],
  PathType: "/a/b.k",
  FormatType: "%1 + %2",
  ColorType: "red",
  ColorsType: "red, blue",
  UserListType: "*",
  "OptionalType[StrType]": "opt-value",
};

/** The generator's `ALL_BUT_FORMAT`, rebuilt from *this* registry. */
function registryAll(): JsonObject {
  const att: Record<string, JsonValue> = {};
  for (const [name, key] of attKeys()) {
    if (name === "format") continue;
    const sample = SAMPLE[tagOf(key)];
    if (sample === undefined) throw new Error(`No sample value for ${name}`);
    att[name] = sample;
  }
  return att;
}

////////////////////////////////////////////
// Inputs                                  //
////////////////////////////////////////////

/** `att` objects fed to {@link KAtt.fromDict}; ids match {@link EXPECTED}. */
const FROM_DICT: readonly (readonly [string, JsonObject])[] = [
  ["empty", {}],
  ["fixture/a.k-a-syntax", { "org.kframework.attributes.Location": [1, 1, 2, 10] }],
  ["fixture/a.k-a", { "org.kframework.attributes.Location": [4, 1, 6, 10] }],
  ["fixture/b.k-b", { "org.kframework.attributes.Location": [6, 1, 9, 10] }],
  ["fixture/d.k-d", { "org.kframework.attributes.Location": [7, 1, 11, 10] }],
  ["fixture/include.k", { "org.kframework.attributes.Location": [3, 1, 6, 10] }],
  ["nullary", { function: "" }],
  ["nullary-two", { function: "", total: "" }],
  ["str", { symbol: "foo" }],
  ["str-empty", { symbol: "" }],
  ["str-quotes", { symbol: 'a"b' }],
  ["optional-none", { concrete: "" }],
  ["optional-some", { concrete: "foo" }],
  ["optional-all", { concrete: "c", hybrid: "", stream: "stdin", symbolic: "" }],
  ["int", { index: "42" }],
  ["int-zero", { index: "0" }],
  ["int-negative", { index: "-1" }],
  ["location", { "org.kframework.attributes.Location": [12, 3, 12, 40] }],
  ["source", { "org.kframework.attributes.Source": "/home/k/imp.k" }],
  ["source-unnormalized", { "org.kframework.attributes.Source": "a//b/./c/" }],
  ["source-relative", { "org.kframework.attributes.Source": "./a/../b" }],
  ["source-empty", { "org.kframework.attributes.Source": "" }],
  ["source-double-slash", { "org.kframework.attributes.Source": "//srv//x" }],
  ["color", { color: "red" }],
  ["color-camel", { color: "LightSteelBlue" }],
  ["colors", { colors: "red,blue" }],
  ["colors-spaces", { colors: " red , blue ,LightGray" }],
  ["colors-single", { colors: "pink" }],
  ["any-string", { label: "foo" }],
  ["any-empty-string", { label: "" }],
  ["unknown-key", { "my-att": "some value" }],
  ["unknown-key-empty", { "my-att": "" }],
  ["unknown-list", { "my-att": ["a", "b"] }],
  ["unknown-list-single", { "my-att": ["a"] }],
  ["unknown-list-empty", { "my-att": [] }],
  ["unknown-list-nested", { "my-att": ["a", ["b", ["c"]]] }],
  ["unknown-dict", { "my-att": { a: ["b", 1], c: true } }],
  ["unknown-dict-empty", { "my-att": {} }],
  ["unknown-int", { "my-att": 42 }],
  ["unknown-bool", { "my-att": [true, false, null] }],
  ["unknown-quotes", { "my-att": ["it's", 'a "b"', "both ' and \""] }],
  ["unknown-escapes", { "my-att": ["a\tb\nc\\d", "\u0000\u001f\u007f"] }],
  ["unknown-unicode", { "my-att": ["h\u00e9llo \u2603 \u{1d11e}", "\u00ad\u200b"] }],
  [
    "production-like",
    {
      symbol: "foo",
      function: "",
      total: "",
      klabel: "foo",
      "org.kframework.attributes.Location": [1, 2, 3, 4],
      "org.kframework.attributes.Source": "/a/b.k",
    },
  ],
  ["registry/all", registryAll()],
];

/** Rows whose `pretty` upstream is the bound-method bug — JSON only. */
const FROM_DICT_JSON_ONLY: readonly (readonly [string, JsonObject])[] = [
  ["registry/format", { format: "%1 + %2" }],
  ["format-empty", { format: "" }],
  ["format-escapes", { format: "%%%12%c%1 x" }],
  ["format-newline", { format: "%n%i%d" }],
];

/** `name -> text` maps fed to {@link KAtt.parse} — K's textual attribute syntax. */
const PARSE: readonly (readonly [string, Readonly<Record<string, string>>])[] = [
  ["parse/empty", {}],
  ["parse/nullary", { function: "" }],
  ["parse/str", { symbol: "foo" }],
  ["parse/optional-none", { concrete: "" }],
  ["parse/optional-some", { concrete: "foo" }],
  ["parse/int", { index: "42" }],
  ["parse/location", { "org.kframework.attributes.Location": "1,2,3,4" }],
  ["parse/source", { "org.kframework.attributes.Source": "a//b/./c" }],
  ["parse/color", { color: "red" }],
  ["parse/colors", { colors: "red, blue" }],
  [
    "parse/mixed",
    {
      symbol: "foo",
      function: "",
      "org.kframework.attributes.Location": "1,2,3,4",
      "org.kframework.attributes.Source": "/a/b.k",
      index: "7",
      cellName: "k",
      stream: "stdin",
      hybrid: "",
    },
  ],
];

////////////////////////////////////////////
// pyk's output, committed                //
////////////////////////////////////////////

/** `[json.dumps(att.to_dict(), sort_keys=True), att.pretty]`. */
const EXPECTED: Readonly<Record<string, readonly [string, string]>> = {
  empty: ['{"att": {}, "node": "KAtt"}', ""],
  "fixture/a.k-a-syntax": [
    '{"att": {"org.kframework.attributes.Location": [1, 1, 2, 10]}, "node": "KAtt"}',
    "[org.kframework.attributes.Location(1,1,2,10)]",
  ],
  "fixture/a.k-a": [
    '{"att": {"org.kframework.attributes.Location": [4, 1, 6, 10]}, "node": "KAtt"}',
    "[org.kframework.attributes.Location(4,1,6,10)]",
  ],
  "fixture/b.k-b": [
    '{"att": {"org.kframework.attributes.Location": [6, 1, 9, 10]}, "node": "KAtt"}',
    "[org.kframework.attributes.Location(6,1,9,10)]",
  ],
  "fixture/d.k-d": [
    '{"att": {"org.kframework.attributes.Location": [7, 1, 11, 10]}, "node": "KAtt"}',
    "[org.kframework.attributes.Location(7,1,11,10)]",
  ],
  "fixture/include.k": [
    '{"att": {"org.kframework.attributes.Location": [3, 1, 6, 10]}, "node": "KAtt"}',
    "[org.kframework.attributes.Location(3,1,6,10)]",
  ],
  nullary: ['{"att": {"function": ""}, "node": "KAtt"}', "[function]"],
  "nullary-two": ['{"att": {"function": "", "total": ""}, "node": "KAtt"}', "[function, total]"],
  str: ['{"att": {"symbol": "foo"}, "node": "KAtt"}', '[symbol("foo")]'],
  "str-empty": ['{"att": {"symbol": ""}, "node": "KAtt"}', '[symbol("")]'],
  "str-quotes": ['{"att": {"symbol": "a\\"b"}, "node": "KAtt"}', '[symbol("a"b")]'],
  "optional-none": ['{"att": {"concrete": ""}, "node": "KAtt"}', "[concrete]"],
  "optional-some": ['{"att": {"concrete": "foo"}, "node": "KAtt"}', '[concrete("foo")]'],
  "optional-all": [
    '{"att": {"concrete": "c", "hybrid": "", "stream": "stdin", "symbolic": ""}, "node": "KAtt"}',
    '[concrete("c"), hybrid, stream("stdin"), symbolic]',
  ],
  int: ['{"att": {"index": "42"}, "node": "KAtt"}', "[index(42)]"],
  "int-zero": ['{"att": {"index": "0"}, "node": "KAtt"}', "[index(0)]"],
  "int-negative": ['{"att": {"index": "-1"}, "node": "KAtt"}', "[index(-1)]"],
  location: [
    '{"att": {"org.kframework.attributes.Location": [12, 3, 12, 40]}, "node": "KAtt"}',
    "[org.kframework.attributes.Location(12,3,12,40)]",
  ],
  source: [
    '{"att": {"org.kframework.attributes.Source": "/home/k/imp.k"}, "node": "KAtt"}',
    '[org.kframework.attributes.Source("/home/k/imp.k")]',
  ],
  "source-unnormalized": [
    '{"att": {"org.kframework.attributes.Source": "a/b/c"}, "node": "KAtt"}',
    '[org.kframework.attributes.Source("a/b/c")]',
  ],
  "source-relative": [
    '{"att": {"org.kframework.attributes.Source": "a/../b"}, "node": "KAtt"}',
    '[org.kframework.attributes.Source("a/../b")]',
  ],
  "source-empty": [
    '{"att": {"org.kframework.attributes.Source": "."}, "node": "KAtt"}',
    '[org.kframework.attributes.Source(".")]',
  ],
  "source-double-slash": [
    '{"att": {"org.kframework.attributes.Source": "//srv/x"}, "node": "KAtt"}',
    '[org.kframework.attributes.Source("//srv/x")]',
  ],
  color: ['{"att": {"color": "red"}, "node": "KAtt"}', "[color(red)]"],
  "color-camel": ['{"att": {"color": "LightSteelBlue"}, "node": "KAtt"}', "[color(LightSteelBlue)]"],
  colors: ['{"att": {"colors": "red,blue"}, "node": "KAtt"}', "[colors(red,blue)]"],
  "colors-spaces": ['{"att": {"colors": "red,blue,LightGray"}, "node": "KAtt"}', "[colors(red,blue,LightGray)]"],
  "colors-single": ['{"att": {"colors": "pink"}, "node": "KAtt"}', "[colors(pink)]"],
  "any-string": ['{"att": {"label": "foo"}, "node": "KAtt"}', "[label(foo)]"],
  "any-empty-string": ['{"att": {"label": ""}, "node": "KAtt"}', "[label()]"],
  "unknown-key": ['{"att": {"my-att": "some value"}, "node": "KAtt"}', "[my-att(some value)]"],
  "unknown-key-empty": ['{"att": {"my-att": ""}, "node": "KAtt"}', "[my-att()]"],
  "unknown-list": ['{"att": {"my-att": ["a", "b"]}, "node": "KAtt"}', "[my-att(('a', 'b'))]"],
  "unknown-list-single": ['{"att": {"my-att": ["a"]}, "node": "KAtt"}', "[my-att(('a',))]"],
  "unknown-list-empty": ['{"att": {"my-att": []}, "node": "KAtt"}', "[my-att(())]"],
  "unknown-list-nested": ['{"att": {"my-att": ["a", ["b", ["c"]]]}, "node": "KAtt"}', "[my-att(('a', ('b', ('c',))))]"],
  "unknown-dict": [
    '{"att": {"my-att": {"a": ["b", 1], "c": true}}, "node": "KAtt"}',
    "[my-att(FrozenDict({'a': ('b', 1), 'c': True}))]",
  ],
  "unknown-dict-empty": ['{"att": {"my-att": {}}, "node": "KAtt"}', "[my-att(FrozenDict({}))]"],
  "unknown-int": ['{"att": {"my-att": 42}, "node": "KAtt"}', "[my-att(42)]"],
  "unknown-bool": ['{"att": {"my-att": [true, false, null]}, "node": "KAtt"}', "[my-att((True, False, None))]"],
  "unknown-quotes": [
    '{"att": {"my-att": ["it\'s", "a \\"b\\"", "both \' and \\""]}, "node": "KAtt"}',
    "[my-att((\"it's\", 'a \"b\"', 'both \\' and \"'))]",
  ],
  "unknown-escapes": [
    '{"att": {"my-att": ["a\\tb\\nc\\\\d", "\\u0000\\u001f\\u007f"]}, "node": "KAtt"}',
    "[my-att(('a\\tb\\nc\\\\d', '\\x00\\x1f\\x7f'))]",
  ],
  "unknown-unicode": [
    '{"att": {"my-att": ["h\\u00e9llo \\u2603 \\ud834\\udd1e", "\\u00ad\\u200b"]}, "node": "KAtt"}',
    "[my-att(('h\u00e9llo \u2603 \ud834\udd1e', '\\xad\\u200b'))]",
  ],
  "production-like": [
    '{"att": {"function": "", "klabel": "foo", "org.kframework.attributes.Location": [1, 2, 3, 4], "org.kframework.attributes.Source": "/a/b.k", "symbol": "foo", "total": ""}, "node": "KAtt"}',
    '[symbol("foo"), function, total, klabel(foo), org.kframework.attributes.Location(1,2,3,4), org.kframework.attributes.Source("/a/b.k")]',
  ],
  "registry/all": [
    '{"att": {"UNIQUE_ID": "any-value", "alias": "", "alias-rec": "", "anywhere": "", "assoc": "", "avoid": "", "bracket": "", "bracketLabel": "any-value", "cell": "", "cellCollection": "", "cellFragment": "any-value", "cellName": "str-value", "cellOptAbsent": "any-value", "circularity": "", "color": "red", "colors": "red,blue", "comm": "", "concat": "any-value", "concrete": "opt-value", "constructor": "", "depends": "any-value", "digest": "any-value", "element": "any-value", "exit": "any-value", "freshGenerator": "", "function": "", "functional": "", "group": "str-value", "hasDomainValues": "", "hook": "any-value", "hybrid": "opt-value", "idem": "", "impure": "", "index": "42", "initializer": "", "injective": "", "label": "any-value", "left": "any-value", "macro": "", "macro-rec": "", "maincell": "", "multiplicity": "any-value", "no-evaluators": "", "org.kframework.attributes.Location": [1, 2, 3, 4], "org.kframework.attributes.Source": "/a/b.k", "org.kframework.definition.Production": "any-value", "org.kframework.kore.Sort": "any-value", "overload": "str-value", "owise": "", "predicate": "any-value", "prefer": "", "priorities": "any-value", "priority": "any-value", "private": "", "projection": "", "public": "", "returnsUnit": "", "right": "any-value", "seqstrict": "any-value", "simplification": "any-value", "smt-lemma": "", "stream": "opt-value", "strict": "any-value", "symbol": "str-value", "symbolic": "opt-value", "syntaxModule": "str-value", "terminals": "str-value", "terminator-symbol": "any-value", "token": "", "total": "", "trusted": "", "type": "any-value", "unit": "str-value", "unparseAvoid": "", "unused": "", "update": "any-value", "userList": "*", "wrapElement": "any-value"}, "node": "KAtt"}',
    '[alias, alias-rec, anywhere, assoc, avoid, bracket, bracketLabel(any-value), circularity, cell, cellCollection, cellFragment(any-value), cellName("str-value"), cellOptAbsent(any-value), color(red), colors(red,blue), comm, concat(any-value), concrete("opt-value"), constructor, depends(any-value), digest(any-value), element(any-value), exit(any-value), freshGenerator, function, functional, group("str-value"), hasDomainValues, hook(any-value), hybrid("opt-value"), idem, impure, index(42), initializer, injective, label(any-value), left(any-value), org.kframework.attributes.Location(1,2,3,4), macro, macro-rec, maincell, multiplicity(any-value), no-evaluators, overload("str-value"), owise, predicate(any-value), prefer, priority(any-value), priorities(any-value), private, org.kframework.definition.Production(any-value), projection, public, right(any-value), returnsUnit, simplification(any-value), seqstrict(any-value), org.kframework.kore.Sort(any-value), org.kframework.attributes.Source("/a/b.k"), stream("opt-value"), smt-lemma, strict(any-value), symbol("str-value"), syntaxModule("str-value"), symbolic("opt-value"), terminals("str-value"), terminator-symbol(any-value), token, total, trusted, type(any-value), unit("str-value"), UNIQUE_ID(any-value), unparseAvoid, unused, update(any-value), userList(*), wrapElement(any-value)]',
  ],
};

/** `json.dumps(att.to_dict(), sort_keys=True)` only — see the header. */
const EXPECTED_JSON_ONLY: Readonly<Record<string, string>> = {
  "registry/format": '{"att": {"format": "%1 + %2"}, "node": "KAtt"}',
  "format-empty": '{"att": {"format": ""}, "node": "KAtt"}',
  "format-escapes": '{"att": {"format": "%%%12%c%1 x"}, "node": "KAtt"}',
  "format-newline": '{"att": {"format": "%n%i%d"}, "node": "KAtt"}',
};

/** As {@link EXPECTED}, for {@link KAtt.parse}. */
const EXPECTED_PARSE: Readonly<Record<string, readonly [string, string]>> = {
  "parse/empty": ['{"att": {}, "node": "KAtt"}', ""],
  "parse/nullary": ['{"att": {"function": ""}, "node": "KAtt"}', "[function]"],
  "parse/str": ['{"att": {"symbol": "foo"}, "node": "KAtt"}', '[symbol("foo")]'],
  "parse/optional-none": ['{"att": {"concrete": ""}, "node": "KAtt"}', "[concrete]"],
  "parse/optional-some": ['{"att": {"concrete": "foo"}, "node": "KAtt"}', '[concrete("foo")]'],
  "parse/int": ['{"att": {"index": "42"}, "node": "KAtt"}', "[index(42)]"],
  "parse/location": [
    '{"att": {"org.kframework.attributes.Location": [1, 2, 3, 4]}, "node": "KAtt"}',
    "[org.kframework.attributes.Location(1,2,3,4)]",
  ],
  "parse/source": [
    '{"att": {"org.kframework.attributes.Source": "a/b/c"}, "node": "KAtt"}',
    '[org.kframework.attributes.Source("a/b/c")]',
  ],
  "parse/color": ['{"att": {"color": "red"}, "node": "KAtt"}', "[color(red)]"],
  "parse/colors": ['{"att": {"colors": "red,blue"}, "node": "KAtt"}', "[colors(red,blue)]"],
  "parse/mixed": [
    '{"att": {"cellName": "k", "function": "", "hybrid": "", "index": "7", "org.kframework.attributes.Location": [1, 2, 3, 4], "org.kframework.attributes.Source": "/a/b.k", "stream": "stdin", "symbol": "foo"}, "node": "KAtt"}',
    '[symbol("foo"), function, org.kframework.attributes.Location(1,2,3,4), org.kframework.attributes.Source("/a/b.k"), index(7), cellName("k"), stream("stdin"), hybrid]',
  ],
};

describe("att parity with pyk 7.1.337", () => {
  test("the tables cover every generated row, and nothing else", () => {
    expect(FROM_DICT.map(([id]) => id).toSorted()).toEqual(Object.keys(EXPECTED).toSorted());
    expect(FROM_DICT_JSON_ONLY.map(([id]) => id).toSorted()).toEqual(Object.keys(EXPECTED_JSON_ONLY).toSorted());
    expect(PARSE.map(([id]) => id).toSorted()).toEqual(Object.keys(EXPECTED_PARSE).toSorted());
  });

  test("the Atts registry agrees with pyk, name by name and codec by codec", () => {
    expect([...attKeys()].map(([name, key]) => [name, tagOf(key)])).toEqual(REGISTRY.map(([name, tag]) => [name, tag]));
  });

  describe("fromDict", () => {
    for (const [id, att] of FROM_DICT) {
      test(id, () => {
        const expected = EXPECTED[id];
        if (expected === undefined) throw new Error(`No pyk output committed for ${id}`);
        const value = KAtt.fromDict({ node: "KAtt", att });
        expect(canonicalJson(value.toDict())).toBe(expected[0]);
        expect(value.pretty).toBe(expected[1]);
      });
    }

    for (const [id, att] of FROM_DICT_JSON_ONLY) {
      test(id, () => {
        const expected = EXPECTED_JSON_ONLY[id];
        if (expected === undefined) throw new Error(`No pyk output committed for ${id}`);
        expect(canonicalJson(KAtt.fromDict({ node: "KAtt", att }).toDict())).toBe(expected);
      });
    }
  });

  describe("parse", () => {
    for (const [id, text] of PARSE) {
      test(id, () => {
        const expected = EXPECTED_PARSE[id];
        if (expected === undefined) throw new Error(`No pyk output committed for ${id}`);
        const value = KAtt.parse(text);
        expect(canonicalJson(value.toDict())).toBe(expected[0]);
        expect(value.pretty).toBe(expected[1]);
      });
    }
  });
});
