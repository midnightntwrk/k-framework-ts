/**
 * The KORE-JSON codec suite.
 *
 * Three independent oracles, in decreasing order of authority:
 *
 * 1. **The 41 vendored golden files** (`fixtures/json/`, 68 envelopes) — bytes
 *    the reference Haskell codec itself emitted, per `fixtures/PROVENANCE.md`.
 *    Every one is decoded, re-encoded, and decoded again; the two ASTs must be
 *    equal. That is the strongest statement available without running K.
 * 2. **The vendored JSON Schema** (`fixtures/kore-schema.json`) — a machine
 *    oracle applied to what *our encoder* emits, so a field we misname is
 *    caught even where no golden exercises it. One documented repair is needed
 *    first; see {@link REPAIRED} below.
 * 3. **Named trap tests** for every field-name and shape hazard in
 *    `Types.hs`, including the ones no golden covers at all: `MultiOr`, `Mu`,
 *    `Nu`, `SVar`, the legacy two-field `And`/`Or` form, and the latin-1 option.
 *
 * The goldens are thin in places — they contain no `MultiOr`, no `SVar`, no
 * `Mu`/`Nu`, and exactly one `LeftAssoc`/`RightAssoc`/`String` each — which is
 * exactly why the third group exists.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import Ajv, { type SchemaObject } from "ajv";
import {
  KORE_JSON_FORMAT,
  KORE_JSON_VERSION,
  decodeKoreJson,
  encodeKoreJson,
  encodeKoreJsonValue,
  encodePatternJson,
  patternFromJson,
  patternToJson,
  sortFromJson,
  sortToJson,
} from "../src/json.ts";
import {
  type Pattern,
  type Sort,
  and,
  app,
  collect,
  dv,
  evar,
  koreString,
  multiOr,
  not,
  or,
  sortApp,
  sortVar,
  svar,
} from "../src/syntax.ts";

//////////////////////
// Fixtures         //
//////////////////////

const FIXTURES = join(import.meta.dir, "..", "fixtures");
const JSON_DIR = join(FIXTURES, "json");

/** Parse without laundering the result into `any`. */
function parseJson(text: string): unknown {
  return JSON.parse(text) as unknown;
}

function isArray(value: unknown): value is readonly unknown[] {
  return Array.isArray(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !isArray(value);
}

const FIXTURE_FILES = readdirSync(JSON_DIR)
  .filter((name) => name.endsWith(".json"))
  .toSorted();

/** Every envelope in one golden file, as raw parsed JSON. */
function envelopesOf(file: string): readonly unknown[] {
  const value = parseJson(readFileSync(join(JSON_DIR, file), "utf8"));
  if (!isArray(value)) throw new Error(`${file} is not a JSON array of envelopes`);
  return value;
}

/** Every envelope in every golden file, tagged with where it came from. */
const ALL_ENVELOPES: readonly { readonly file: string; readonly index: number; readonly doc: unknown }[] =
  FIXTURE_FILES.flatMap((file) => envelopesOf(file).map((doc, index) => ({ file, index, doc })));

/** The 25 pattern tags `syntax.ts` defines — the set a decode result may draw from. */
const KNOWN_TAGS: ReadonlySet<string> = new Set([
  "EVar",
  "SVar",
  "String",
  "App",
  "LeftAssoc",
  "RightAssoc",
  "MultiOr",
  "Top",
  "Bottom",
  "Not",
  "And",
  "Or",
  "Implies",
  "Iff",
  "Exists",
  "Forall",
  "Mu",
  "Nu",
  "Ceil",
  "Floor",
  "Equals",
  "In",
  "Next",
  "Rewrites",
  "DV",
]);

/** Nesting depth of a `SortApp` spine, measured with a loop. */
function sortDepth(sort: Sort): number {
  let depth = 0;
  let cur: Sort = sort;
  for (;;) {
    if (cur.tag !== "SortApp") return depth;
    const next = cur.sorts[0];
    if (next === undefined) return depth;
    depth += 1;
    cur = next;
  }
}

/** The leaf at the bottom of a `SortApp` spine. */
function innermostSort(sort: Sort): Sort {
  let cur: Sort = sort;
  for (;;) {
    if (cur.tag !== "SortApp") return cur;
    const next = cur.sorts[0];
    if (next === undefined) return cur;
    cur = next;
  }
}

/** Node count, on `syntax.ts`'s iterative `collect` — safe at any depth. */
function nodeCount(p: Pattern): number {
  let n = 0;
  collect(p, () => {
    n += 1;
  });
  return n;
}

//////////////////////
// Schema oracle    //
//////////////////////

/**
 * The vendored schema, and the same schema with its one stale branch repaired.
 *
 * `kore-schema.json:79-85` still routes `And` and `Or` to
 * `KoreJSONConnective2`, i.e. to the legacy two-field `sort`/`first`/`second`
 * shape. `Types.hs:110-117` made those two n-ary (`patterns :: [KorePattern]`)
 * and the goldens in `fixtures/json/` — produced by the reference codec — use
 * `patterns` throughout. So the vendored schema contradicts both the type it
 * documents and the fixtures shipped beside it; it is stale, not us. The test
 * `"the vendored schema predates n-ary And/Or"` below pins that claim, so if a
 * future re-vendor fixes the schema upstream, this file fails and tells us to
 * drop the repair.
 *
 * The repair is minimal and mechanical: the two `then` branches for `And`/`Or`
 * are pointed at a new `KoreJSONConnectiveN` definition that requires
 * `sort` + `patterns`. Nothing else in the 526-line schema is touched, so it
 * remains a real external oracle for the other 23 tags.
 */
const CONNECTIVE_N = "#/definitions/KoreJSONConnectiveN";

let repairedBranches = 0;

function repairAndOrBranches(node: unknown): unknown {
  if (isArray(node)) return node.map((item) => repairAndOrBranches(item));
  if (!isRecord(node)) return node;

  const cond = node["if"];
  const props = isRecord(cond) ? cond["properties"] : undefined;
  const tag = isRecord(props) ? props["tag"] : undefined;
  const constant = isRecord(tag) ? tag["const"] : undefined;
  if ((constant === "And" || constant === "Or") && isRecord(node["then"])) {
    repairedBranches += 1;
    // Rebuilt through a computed key rather than an object literal: a literal
    // `then` property makes the object a thenable, which `await` would unwrap.
    const branch: Record<string, unknown> = {};
    for (const key of Object.keys(node)) branch[key] = key === "then" ? { $ref: CONNECTIVE_N } : node[key];
    return branch;
  }

  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(node)) out[key] = repairAndOrBranches(value);
  return out;
}

/** Copy a parsed JSON object into ajv's `SchemaObject` without a type assertion. */
function toSchema(value: unknown): SchemaObject {
  if (!isRecord(value)) throw new Error("Schema root is not an object");
  const schema: SchemaObject = {};
  for (const [key, member] of Object.entries(value)) schema[key] = member;
  return schema;
}

const VENDORED = toSchema(parseJson(readFileSync(join(FIXTURES, "kore-schema.json"), "utf8")));

const REPAIRED = ((): SchemaObject => {
  const patched = toSchema(repairAndOrBranches(parseJson(readFileSync(join(FIXTURES, "kore-schema.json"), "utf8"))));
  const definitions: unknown = patched["definitions"];
  if (!isRecord(definitions)) throw new Error("Schema has no definitions");
  definitions["KoreJSONConnectiveN"] = {
    type: "object",
    properties: {
      sort: { $ref: "#/definitions/Sort" },
      patterns: { type: "array", items: { $ref: "#/definitions/KorePattern" } },
    },
    required: ["sort", "patterns"],
  };
  return patched;
})();

const validateVendored = new Ajv({ strict: false }).compile(VENDORED);
const validateRepaired = new Ajv({ strict: false }).compile(REPAIRED);

//////////////////////
// Term builders    //
//////////////////////

const S: Sort = sortVar("S");
const A: Sort = sortApp("SortA");

/** `{"tag": "SortVar", "name": "S"}` — spelled out, as a fixture would. */
const S_JSON = { tag: "SortVar", name: "S" };

function envelope(term: unknown): unknown {
  return { format: "KORE", version: 1, term };
}

//////////////////////
// 1. Goldens       //
//////////////////////

describe("golden fixtures", () => {
  test("the corpus is the 41 files PROVENANCE.md describes, holding 68 envelopes", () => {
    expect(FIXTURE_FILES.length).toBe(41);
    expect(ALL_ENVELOPES.length).toBe(68);
  });

  for (const file of FIXTURE_FILES) {
    test(`${file}: decode → encode → decode is a fixed point`, () => {
      const docs = envelopesOf(file);
      expect(docs.length).toBeGreaterThan(0);

      for (const doc of docs) {
        const first = decodeKoreJson(doc);
        expect(first.format).toBe(KORE_JSON_FORMAT);
        expect(first.version).toBe(KORE_JSON_VERSION);

        // Encode both ways, and read the *text* back: that exercises the
        // stack-based serializer, not just the value builder.
        const second = decodeKoreJson(encodeKoreJson(first.term));
        expect(second.term).toEqual(first.term);

        const third = decodeKoreJson(encodeKoreJsonValue(first.term));
        expect(third.term).toEqual(first.term);

        // And the encoding is a fixed point too, not merely round-trippable.
        expect(encodeKoreJson(second.term)).toBe(encodeKoreJson(first.term));
      }
    });
  }

  test("every decoded node carries a tag syntax.ts knows", () => {
    for (const { file, index, doc } of ALL_ENVELOPES) {
      collect(decodeKoreJson(doc).term, (p) => {
        if (!KNOWN_TAGS.has(p.tag)) throw new Error(`${file}[${index}]: unknown tag ${p.tag}`);
      });
    }
    expect(KNOWN_TAGS.size).toBe(25);
  });

  test("the goldens exercise the field-name traps we care about", () => {
    const seen = new Set<string>();
    for (const { doc } of ALL_ENVELOPES) {
      collect(decodeKoreJson(doc).term, (p) => {
        seen.add(p.tag);
      });
    }
    // What the corpus *does* cover — and, by omission, why the trap tests below
    // carry the weight for `MultiOr`, `SVar`, `Mu` and `Nu`.
    for (const tag of ["App", "DV", "String", "LeftAssoc", "RightAssoc", "And", "Or", "Exists", "Forall", "Rewrites"]) {
      expect(seen).toContain(tag);
    }
    for (const tag of ["MultiOr", "SVar", "Mu", "Nu"]) expect(seen).not.toContain(tag);
  });
});

//////////////////////
// 2. Schema oracle //
//////////////////////

describe("schema oracle", () => {
  test("every envelope our encoder emits validates against kore-schema.json", () => {
    expect(repairedBranches).toBe(2);
    for (const { file, index, doc } of ALL_ENVELOPES) {
      const emitted = encodeKoreJsonValue(decodeKoreJson(doc).term);
      if (!validateRepaired(emitted)) {
        throw new Error(`${file}[${index}] failed the schema: ${JSON.stringify(validateRepaired.errors)}`);
      }
    }
  });

  test("hand-built terms for the tags no golden covers also validate", () => {
    const terms: readonly Pattern[] = [
      multiOr("Left", S, [evar("X", S), evar("Y", S)]),
      multiOr("Right", S, [evar("X", S)]),
      svar("@X", S),
      { tag: "Mu", var: svar("@X", S), pattern: svar("@X", S) },
      { tag: "Nu", var: svar("@X", S), pattern: svar("@X", S) },
      and(S, []),
      or(S, [evar("X", S)]),
      dv(A, koreString("bar")),
      app("\\weird", [S], [evar("X", S)]),
    ];
    for (const term of terms) {
      const emitted = encodeKoreJsonValue(term);
      if (!validateRepaired(emitted)) {
        throw new Error(`${term.tag} failed the schema: ${JSON.stringify(validateRepaired.errors)}`);
      }
    }
  });

  test("the vendored schema predates n-ary And/Or (the one repair we apply)", () => {
    const nary = encodeKoreJsonValue(and(S, [evar("X", S), evar("Y", S)]));
    // Our output — and the upstream goldens' own output — is rejected by the
    // schema shipped beside them.  When this stops being true, delete
    // `repairAndOrBranches`.
    expect(validateVendored(nary)).toBe(false);
    expect(validateRepaired(nary)).toBe(true);

    // The vendored schema describes the legacy two-field shape.
    const legacy = envelope({
      tag: "And",
      sort: S_JSON,
      first: { tag: "Top", sort: S_JSON },
      second: { tag: "Bottom", sort: S_JSON },
    });
    expect(validateVendored(legacy)).toBe(true);
  });
});

//////////////////////
// 3. Envelope      //
//////////////////////

describe("envelope", () => {
  test("decodeKoreJson accepts document text and parsed values alike", () => {
    const doc = envelope({ tag: "Top", sort: S_JSON });
    const fromValue = decodeKoreJson(doc);
    const fromText = decodeKoreJson(JSON.stringify(doc));
    expect(fromText).toEqual(fromValue);
  });

  test("encodeKoreJson writes exactly format, version, term — in that order", () => {
    expect(encodeKoreJson({ tag: "Top", sort: S })).toBe(
      '{"format":"KORE","version":1,"term":{"tag":"Top","sort":{"tag":"SortVar","name":"S"}}}',
    );
  });

  test("version 2 is rejected", () => {
    expect(() => decodeKoreJson({ format: "KORE", version: 2, term: { tag: "Top", sort: S_JSON } })).toThrow(
      /Expected version 1, got 2 \(at version\)/u,
    );
  });

  test('format "KAST" is rejected', () => {
    expect(() => decodeKoreJson({ format: "KAST", version: 1, term: { tag: "Top", sort: S_JSON } })).toThrow(
      /Expected format "KORE", got "KAST" \(at format\)/u,
    );
  });

  test("a missing term is rejected rather than partially read", () => {
    expect(() => decodeKoreJson({ format: "KORE", version: 1 })).toThrow(/missing the field "term"/u);
  });

  test("an unknown envelope key is tolerated — Types.hs:27-33 derives with aeson defaults", () => {
    const doc = { format: "KORE", version: 1, term: { tag: "Top", sort: S_JSON }, extra: 42 };
    expect(decodeKoreJson(doc).term).toEqual({ tag: "Top", sort: S });
  });

  test("a non-object document is rejected", () => {
    expect(() => decodeKoreJson(7)).toThrow(/Expected an object, got 7 \(at <document>\)/u);
    expect(() => decodeKoreJson([])).toThrow(/Expected an object, got an array/u);
  });
});

//////////////////////
// 4. Traps         //
//////////////////////

describe("legacy two-field And/Or", () => {
  test("legacy first/second And decodes to a 2-ary node", () => {
    const term = patternFromJson({
      tag: "And",
      sort: S_JSON,
      first: { tag: "Top", sort: S_JSON },
      second: { tag: "Bottom", sort: S_JSON },
    });
    expect(term).toEqual(
      and(S, [
        { tag: "Top", sort: S },
        { tag: "Bottom", sort: S },
      ]),
    );
  });

  test("legacy first/second Or decodes to a 2-ary node", () => {
    const term = patternFromJson({
      tag: "Or",
      sort: S_JSON,
      first: { tag: "Top", sort: S_JSON },
      second: { tag: "Bottom", sort: S_JSON },
    });
    expect(term).toEqual(
      or(S, [
        { tag: "Top", sort: S },
        { tag: "Bottom", sort: S },
      ]),
    );
  });

  test("a legacy node re-encodes as patterns, never as first/second", () => {
    const term = patternFromJson({
      tag: "And",
      sort: S_JSON,
      first: { tag: "Top", sort: S_JSON },
      second: { tag: "Bottom", sort: S_JSON },
    });
    const text = encodePatternJson(term);
    expect(text).toContain('"patterns"');
    expect(text).not.toContain('"first"');
    expect(text).not.toContain('"second"');
  });

  test("the legacy two-field rewrite is nested-safe: an And inside an App", () => {
    const term = patternFromJson({
      tag: "App",
      name: "f",
      sorts: [],
      args: [{ tag: "Or", sort: S_JSON, first: { tag: "Top", sort: S_JSON }, second: { tag: "Bottom", sort: S_JSON } }],
    });
    expect(term).toEqual(
      app(
        "f",
        [],
        [
          or(S, [
            { tag: "Top", sort: S },
            { tag: "Bottom", sort: S },
          ]),
        ],
      ),
    );
  });

  test("patterns wins over first/second when both are present — Types.hs:256", () => {
    // `flattenAndOr` returns the object untouched as soon as `patterns` exists,
    // so the strict field check then rejects the leftover `first`/`second`.
    expect(() =>
      patternFromJson({
        tag: "And",
        sort: S_JSON,
        patterns: [],
        first: { tag: "Top", sort: S_JSON },
        second: { tag: "Top", sort: S_JSON },
      }),
    ).toThrow(/And has no field "first"/u);
  });

  test("an extra key on a legacy two-field And is dropped, not rejected — the flattenAndOr rebuild", () => {
    // Upstream quirk, transcribed: `flattenAndOr` builds a fresh object out of
    // four keys, so `rejectUnknownFields` never sees `bogus`.
    const term = patternFromJson({
      tag: "And",
      sort: S_JSON,
      first: { tag: "Top", sort: S_JSON },
      second: { tag: "Top", sort: S_JSON },
      bogus: 1,
    });
    expect(term.tag).toBe("And");
  });

  test("a legacy two-field And missing second is rejected", () => {
    expect(() => patternFromJson({ tag: "And", sort: S_JSON, first: { tag: "Top", sort: S_JSON } })).toThrow(
      /missing the field "patterns" and cannot be read as the legacy two-field shape: no "second"/u,
    );
  });
});

describe("arity is preserved", () => {
  test("0-ary And survives the round trip as 0-ary", () => {
    const doc = { tag: "And", sort: S_JSON, patterns: [] };
    const term = patternFromJson(doc);
    expect(term).toEqual(and(S, []));
    expect(patternToJson(term)).toEqual(doc);
  });

  test("1-ary Or survives the round trip as 1-ary", () => {
    const doc = { tag: "Or", sort: S_JSON, patterns: [{ tag: "Top", sort: S_JSON }] };
    const term = patternFromJson(doc);
    expect(term).toEqual(or(S, [{ tag: "Top", sort: S }]));
    expect(patternToJson(term)).toEqual(doc);
  });

  test("we do not collapse the way Json/Internal.hs:63-64 does", () => {
    // `KJAnd s [] -> KJTop s` and `KJAnd _ [p] -> p` live in the JSON→internal
    // conversion, not the codec.  A codec that collapsed would make the two
    // assertions above impossible.
    expect(patternFromJson({ tag: "And", sort: S_JSON, patterns: [] }).tag).toBe("And");
    expect(patternFromJson({ tag: "And", sort: S_JSON, patterns: [{ tag: "Top", sort: S_JSON }] }).tag).toBe("And");
  });
});

describe("field-name traps", () => {
  test("MultiOr round-trips through argss and assoc", () => {
    const doc = {
      tag: "MultiOr",
      assoc: "Left",
      sort: S_JSON,
      argss: [
        { tag: "Top", sort: S_JSON },
        { tag: "Bottom", sort: S_JSON },
      ],
    };
    const term = patternFromJson(doc);
    expect(term).toEqual(
      multiOr("Left", S, [
        { tag: "Top", sort: S },
        { tag: "Bottom", sort: S },
      ]),
    );
    expect(patternToJson(term)).toEqual(doc);
  });

  test('MultiOr assoc must be exactly "Left" or "Right"', () => {
    expect(() =>
      patternFromJson({ tag: "MultiOr", assoc: "left", sort: S_JSON, argss: [{ tag: "Top", sort: S_JSON }] }),
    ).toThrow(/Expected "Left" or "Right", got "left" \(at term.assoc\)/u);
  });

  test("MultiOr spells its list argss, not patterns — the trap this package almost fell into", () => {
    expect(() =>
      patternFromJson({ tag: "MultiOr", assoc: "Left", sort: S_JSON, patterns: [{ tag: "Top", sort: S_JSON }] }),
    ).toThrow(/MultiOr is missing the field "argss"/u);
  });

  test("MultiOr, LeftAssoc and RightAssoc reject an empty argss (NE.NonEmpty)", () => {
    expect(() => patternFromJson({ tag: "MultiOr", assoc: "Left", sort: S_JSON, argss: [] })).toThrow(
      /MultiOr requires at least one pattern in "argss" \(at term.argss\)/u,
    );
    expect(() => patternFromJson({ tag: "LeftAssoc", symbol: "f", sorts: [], argss: [] })).toThrow(/at least one/u);
    expect(() => patternFromJson({ tag: "RightAssoc", symbol: "f", sorts: [], argss: [] })).toThrow(/at least one/u);
  });

  test("a sort's children are args; an App's are sorts + args, and its symbol is name", () => {
    const doc = {
      tag: "App",
      name: "Lbl'Unds'",
      sorts: [{ tag: "SortApp", name: "SortA", args: [{ tag: "SortVar", name: "S" }] }],
      args: [{ tag: "Top", sort: S_JSON }],
    };
    const term = patternFromJson(doc);
    expect(term).toEqual(app("Lbl'Unds'", [sortApp("SortA", [S])], [{ tag: "Top", sort: S }]));
    expect(patternToJson(term)).toEqual(doc);
  });

  test("Ceil/Floor/Equals/In spell the AST's opSort argSort", () => {
    const doc = {
      tag: "Ceil",
      argSort: { tag: "SortApp", name: "SortA", args: [] },
      sort: S_JSON,
      arg: { tag: "Top", sort: S_JSON },
    };
    const term = patternFromJson(doc);
    expect(term).toEqual({ tag: "Ceil", opSort: A, sort: S, pattern: { tag: "Top", sort: S } });
    expect(patternToJson(term)).toEqual(doc);
    expect(() => patternFromJson({ ...doc, opSort: doc.argSort })).toThrow(/Ceil has no field "opSort"/u);
  });

  test("Not uses arg, Next uses dest, Rewrites uses source and dest", () => {
    const top = { tag: "Top", sort: S_JSON };
    expect(patternToJson(not(S, { tag: "Top", sort: S }))).toEqual({ tag: "Not", sort: S_JSON, arg: top });
    expect(patternToJson({ tag: "Next", sort: S, pattern: { tag: "Top", sort: S } })).toEqual({
      tag: "Next",
      sort: S_JSON,
      dest: top,
    });
    expect(
      patternToJson({ tag: "Rewrites", sort: S, left: { tag: "Top", sort: S }, right: { tag: "Bottom", sort: S } }),
    ).toEqual({ tag: "Rewrites", sort: S_JSON, source: top, dest: { tag: "Bottom", sort: S_JSON } });
  });

  test("Exists and Forall flatten the bound EVar into var + varSort", () => {
    const doc = {
      tag: "Exists",
      sort: S_JSON,
      var: "X",
      varSort: { tag: "SortApp", name: "SortA", args: [] },
      arg: { tag: "Top", sort: S_JSON },
    };
    const term = patternFromJson(doc);
    expect(term).toEqual({ tag: "Exists", sort: S, var: evar("X", A), pattern: { tag: "Top", sort: S } });
    expect(patternToJson(term)).toEqual(doc);
  });

  test("Mu and Nu carry no sort field at all — Types.hs:142-151", () => {
    const doc = {
      tag: "Mu",
      var: "@X",
      varSort: S_JSON,
      arg: { tag: "SVar", name: "@X", sort: S_JSON },
    };
    const term = patternFromJson(doc);
    expect(term).toEqual({ tag: "Mu", var: svar("@X", S), pattern: svar("@X", S) });
    expect(patternToJson(term)).toEqual(doc);
    expect(() => patternFromJson({ ...doc, sort: S_JSON })).toThrow(/Mu has no field "sort"/u);
  });

  test("DV.value is a raw string, not a nested String node", () => {
    const doc = { tag: "DV", sort: { tag: "SortApp", name: "SortA", args: [] }, value: '\\dv-ish "text"' };
    const term = patternFromJson(doc);
    expect(term).toEqual(dv(A, koreString('\\dv-ish "text"')));
    expect(patternToJson(term)).toEqual(doc);
    expect(() => patternFromJson({ ...doc, value: { tag: "String", value: "x" } })).toThrow(
      /Expected a string, got an object \(at term.value\)/u,
    );
  });

  test("String.value is a raw string too", () => {
    expect(patternFromJson({ tag: "String", value: "hi" })).toEqual(koreString("hi"));
    expect(patternToJson(koreString("hi"))).toEqual({ tag: "String", value: "hi" });
  });

  test("LeftAssoc/RightAssoc use symbol + sorts + argss", () => {
    const doc = { tag: "LeftAssoc", symbol: "foo", sorts: [S_JSON], argss: [{ tag: "Top", sort: S_JSON }] };
    const term = patternFromJson(doc);
    expect(term).toEqual({ tag: "LeftAssoc", symbol: "foo", sorts: [S], args: [{ tag: "Top", sort: S }] });
    expect(patternToJson(term)).toEqual(doc);
  });

  test("sortFromJson / sortToJson round-trip a nested sort", () => {
    const doc = {
      tag: "SortApp",
      name: "SortA",
      args: [{ tag: "SortApp", name: "SortB", args: [{ tag: "SortVar", name: "S" }] }],
    };
    const sort = sortFromJson(doc);
    expect(sort).toEqual(sortApp("SortA", [sortApp("SortB", [S])]));
    expect(sortToJson(sort)).toEqual(doc);
  });

  test("an unknown Sort tag is rejected", () => {
    expect(() => sortFromJson({ tag: "SortThing", name: "A" })).toThrow(
      /Unknown Sort tag: "SortThing" \(at sort.tag\)/u,
    );
  });
});

describe("strictness", () => {
  test("an unknown field on a tagged object is rejected — rejectUnknownFields = True", () => {
    expect(() => patternFromJson({ tag: "Top", sort: S_JSON, bogus: 1 })).toThrow(
      /Top has no field "bogus" \(at term\)/u,
    );
  });

  test("an unknown field on a sort is rejected too", () => {
    expect(() => sortFromJson({ tag: "SortVar", name: "S", args: [] })).toThrow(/SortVar has no field "args"/u);
  });

  test("a missing field is rejected, naming the field", () => {
    expect(() => patternFromJson({ tag: "Top" })).toThrow(/Top is missing the field "sort" \(at term\)/u);
  });

  test("an unknown tag is rejected", () => {
    expect(() => patternFromJson({ tag: "Nope", sort: S_JSON })).toThrow(
      /Unknown KorePattern tag: "Nope" \(at term.tag\)/u,
    );
  });

  test("a non-string tag is rejected", () => {
    expect(() => patternFromJson({ tag: 7 })).toThrow(/Expected a string tag, got 7 \(at term.tag\)/u);
  });

  test("every error carries a JSON path to the offending node", () => {
    const doc = envelope({
      tag: "And",
      sort: S_JSON,
      patterns: [
        { tag: "Top", sort: S_JSON },
        { tag: "Not", sort: S_JSON, arg: { tag: "Top", sort: { tag: "SortApp", name: "SortA", args: [7] } } },
      ],
    });
    expect(() => decodeKoreJson(doc)).toThrow(/Expected an object, got 7 \(at term.patterns.1.arg.sort.args.0\)/u);
  });

  test("the path root is configurable, for embedding in a larger document", () => {
    expect(() => patternFromJson({ tag: "Top" }, { path: "request.state.term" })).toThrow(/\(at request.state.term\)/u);
  });
});

describe("lexical checks", () => {
  test("an SVar name without @ is rejected — checkSVarName, Types.hs:343-348", () => {
    expect(() => patternFromJson({ tag: "SVar", name: "X", sort: S_JSON })).toThrow(
      /Lexical error in set variable: "X" \(at term.name\)/u,
    );
    expect(patternFromJson({ tag: "SVar", name: "@X", sort: S_JSON })).toEqual(svar("@X", S));
  });

  test("a Mu/Nu variable is checked as a set variable, not an element variable", () => {
    expect(() => patternFromJson({ tag: "Mu", var: "X", varSort: S_JSON, arg: { tag: "Top", sort: S_JSON } })).toThrow(
      /Lexical error in fixpoint expression variable: "X" \(at term.var\)/u,
    );
  });

  test("an EVar name must be an <id> — checkIdChars, Types.hs:327-340", () => {
    expect(() => patternFromJson({ tag: "EVar", name: "9X", sort: S_JSON })).toThrow(
      /Lexical error in element variable: "9X"/u,
    );
    expect(() => patternFromJson({ tag: "EVar", name: "", sort: S_JSON })).toThrow(/Lexical error/u);
    // `-` and `'` are legal after the first character.
    expect(patternFromJson({ tag: "EVar", name: "X-1'", sort: S_JSON })).toEqual(evar("X-1'", S));
  });

  test("a quantifier variable is checked as an element variable", () => {
    expect(() =>
      patternFromJson({ tag: "Forall", sort: S_JSON, var: "@X", varSort: S_JSON, arg: { tag: "Top", sort: S_JSON } }),
    ).toThrow(/Lexical error in quantifier variable: "@X"/u);
  });

  test("a symbol may start with a backslash — checkSymbolName, Types.hs:351-355", () => {
    expect(patternFromJson({ tag: "App", name: "\\and", sorts: [], args: [] })).toEqual(app("\\and", [], []));
    expect(() => patternFromJson({ tag: "App", name: "\\\\and", sorts: [], args: [] })).toThrow(
      /Lexical error in app symbol/u,
    );
    expect(() =>
      patternFromJson({ tag: "LeftAssoc", symbol: "9f", sorts: [], argss: [{ tag: "Top", sort: S_JSON }] }),
    ).toThrow(/Lexical error in left-assoc symbol: "9f"/u);
    expect(() =>
      patternFromJson({ tag: "RightAssoc", symbol: "9f", sorts: [], argss: [{ tag: "Top", sort: S_JSON }] }),
    ).toThrow(/Lexical error in right-assoc symbol: "9f"/u);
  });

  test("sort names are not checked — lexicalCheck has no Sort case", () => {
    // A documented divergence from `kore-schema.json`, which *does* constrain
    // them.  Upstream's decoder accepts this; so do we, deliberately.
    expect(sortFromJson({ tag: "SortVar", name: "9nope" })).toEqual({ tag: "SortVar", name: "9nope" });
  });
});

describe("latin-1 option", () => {
  const STRING_DOC = { tag: "String", value: "Ā" };
  const DV_DOC = { tag: "DV", sort: S_JSON, value: "Ā" };

  test("by default U+0100 is accepted in String and DV — pyk's behaviour", () => {
    expect(patternFromJson(STRING_DOC)).toEqual(koreString("Ā"));
    expect(patternFromJson(DV_DOC)).toEqual(dv(S, koreString("Ā")));
  });

  test("with { latin1: true } U+0100 is rejected in a String — checkLatin1Range", () => {
    expect(() => patternFromJson(STRING_DOC, { latin1: true })).toThrow(
      /Found non-latin1 character U\+0100 in string literal: .* \(at term.value\)/u,
    );
  });

  test("with { latin1: true } U+0100 is rejected in a DV", () => {
    expect(() => patternFromJson(DV_DOC, { latin1: true })).toThrow(
      /Found non-latin1 character U\+0100 in domain value string/u,
    );
  });

  test("with { latin1: true } U+00FF is still accepted — the bound is inclusive", () => {
    expect(patternFromJson({ tag: "String", value: "ÿ" }, { latin1: true })).toEqual(koreString("ÿ"));
  });

  test("the option reaches through the envelope", () => {
    expect(() => decodeKoreJson(envelope(DV_DOC), { latin1: true })).toThrow(/non-latin1/u);
    expect(decodeKoreJson(envelope(DV_DOC)).term.tag).toBe("DV");
  });

  test("an astral character is reported once, by code point, not as surrogates", () => {
    expect(() => patternFromJson({ tag: "String", value: "\u{1F642}" }, { latin1: true })).toThrow(/U\+1F642/u);
  });
});

describe("depth", () => {
  /** 100_000 nested `\not`, built iteratively — no test may recurse either. */
  function deepNot(depth: number): Pattern {
    let term: Pattern = { tag: "Top", sort: S };
    for (let i = 0; i < depth; i++) term = not(S, term);
    return term;
  }

  test("a 100_000-deep Not chain round-trips through value and text", () => {
    const DEPTH = 100_000;
    const term = deepNot(DEPTH);
    expect(nodeCount(term)).toBe(DEPTH + 1);

    // Value direction: our stack-based encoder and decoder only.
    const value = patternToJson(term);
    const back = patternFromJson(value);
    expect(nodeCount(back)).toBe(DEPTH + 1);

    // Text direction: our serializer (JSON.stringify would RangeError here) and
    // the host's JSON.parse, which is iterative.
    const text = encodeKoreJson(term);
    const decoded = decodeKoreJson(text);
    expect(nodeCount(decoded.term)).toBe(DEPTH + 1);

    // Deep equality without a recursive comparator: two 100_000-deep objects
    // are compared by the bytes our own writer produces.
    expect(encodeKoreJson(decoded.term)).toBe(text);
  });

  test("a 100_000-wide And is fine too", () => {
    const wide = and(
      S,
      Array.from({ length: 100_000 }, (_, i) => evar(`X${"'".repeat(i % 3)}`, S)),
    );
    const back = patternFromJson(patternToJson(wide));
    expect(nodeCount(back)).toBe(100_001);
  });

  test("a 10_000-deep sort round-trips", () => {
    let sort: Sort = S;
    for (let i = 0; i < 10_000; i++) sort = sortApp("SortA", [sort]);
    const back = sortFromJson(sortToJson(sort));
    // Measured iteratively: `toEqual` and `JSON.stringify` both recurse, and
    // both would `RangeError` on these two values long before comparing them.
    expect(sortDepth(back)).toBe(10_000);
    expect(innermostSort(back)).toEqual(S);
  });
});
