import { describe, expect, test } from "bun:test";
import {
  canonicalKey,
  cell,
  children,
  decodeTerm,
  find,
  findAll,
  firstArg,
  flattenSort,
  head,
  pathEq,
  type KTerm,
  parseTermDocument,
  subtermAt,
  token,
  termDifference,
  termEq,
  unflattenSort,
} from "../src/index.ts";

/** Raw JSON builders, spelled exactly as K's v3 `ToJson` emits them. */
const sort = (name: string) => ({ node: "KSort", name });
const label = (name: string, params: unknown[] = []) => ({ node: "KLabel", name, params });
const apply = (name: string, args: unknown[]) => ({
  node: "KApply",
  label: label(name),
  arity: args.length,
  args,
});
const tok = (t: string, s = "Int") => ({ node: "KToken", sort: sort(s), token: t });
const wrap = (term: unknown, version = 3): string => JSON.stringify({ format: "KAST", version, term });
const decodedTerm = (value: unknown): KTerm => decodeTerm(value);

/** A structured v4 KSort, as the v4 `ToJson` emits it — `params` always present. */
const sort4 = (name: string, params: unknown[] = []) => ({ node: "KSort", name, params });

describe("decodeTerm: the modelled node types", () => {
  test("KApply keeps its label name, sort params and args", () => {
    const term = decodeTerm({
      node: "KApply",
      label: label("<k>", [sort("Int"), sort("Map{Int,Int}")]),
      arity: 1,
      args: [tok("7")],
    });
    expect(term.node).toBe("KApply");
    if (term.node !== "KApply") return;
    expect(term.label).toBe("<k>");
    // In v3 a parametric sort is a flat string; there is no `params` on KSort.
    expect(term.params).toEqual(["Int", "Map{Int,Int}"]);
    expect(term.args).toHaveLength(1);
  });

  test("KToken keeps token text and sort", () => {
    const term = decodeTerm(tok("55", "Int"));
    expect(term).toEqual({ node: "KToken", token: "55", sort: "Int" });
  });

  test("KSequence keeps items", () => {
    const term = decodeTerm({ node: "KSequence", arity: 2, items: [tok("1"), tok("2")] });
    expect(term.node).toBe("KSequence");
    if (term.node === "KSequence") expect(term.items).toHaveLength(2);
  });

  test("KVariable carries a sort only when one was emitted", () => {
    const withSort = decodeTerm({ node: "KVariable", name: "X", sort: sort("Int") });
    expect(withSort).toEqual({ node: "KVariable", name: "X", sort: "Int" });
    const without = decodeTerm({ node: "KVariable", name: "Y" });
    expect(without).toEqual({ node: "KVariable", name: "Y", sort: undefined });
  });

  test("KRewrite, KAs and InjectedKLabel decode", () => {
    const rewrite = decodeTerm({ node: "KRewrite", lhs: tok("1"), rhs: tok("2") });
    expect(rewrite.node).toBe("KRewrite");
    const as = decodeTerm({
      node: "KAs",
      pattern: tok("1"),
      alias: { node: "KVariable", name: "V" },
    });
    expect(as.node).toBe("KAs");
    const inj = decodeTerm({ node: "InjectedKLabel", label: label("foo") });
    expect(inj).toEqual({ node: "InjectedKLabel", label: "foo", params: [] });
  });
});

describe("decodeTerm: v4 sorts land on the flat v3 spelling", () => {
  test("a v4 KToken's structured sort flattens to the identical v3 string", () => {
    const v4 = decodeTerm({ node: "KToken", token: "7", sort: sort4("Int") });
    expect(v4).toEqual({ node: "KToken", token: "7", sort: "Int" });
    const parametric = decodeTerm({
      node: "KToken",
      token: "7",
      sort: sort4("MInt", [sort4("Width")]),
    });
    expect(parametric).toEqual({ node: "KToken", token: "7", sort: "MInt{Width}" });
  });

  test("a v4 KLabel's structured sort params flatten, and equal the v3 decode", () => {
    const v3 = decodeTerm({
      node: "KApply",
      label: label("#Equals", [sort("K"), sort("Map{Int,Int}")]),
      arity: 0,
      args: [],
    });
    const v4 = decodeTerm({
      node: "KApply",
      label: label("#Equals", [sort4("K"), sort4("Map", [sort4("Int"), sort4("Int")])]),
      arity: 0,
      args: [],
    });
    expect(v4).toEqual(v3);
    expect(canonicalKey(v4)).toBe(canonicalKey(v3));
  });

  test("a v4 KVariable's structured sort flattens", () => {
    const term = decodeTerm({ node: "KVariable", name: "X", sort: sort4("Map", [sort4("Int"), sort4("Int")]) });
    expect(term).toEqual({ node: "KVariable", name: "X", sort: "Map{Int,Int}" });
  });

  test("an unreadable entry in a params array poisons the sort, not just the entry", () => {
    // Dropping only the bad entry would turn Map{Int,Int} into Map{Int} — a
    // *different sort* — so the whole node degrades instead.
    const term = decodeTerm({
      node: "KToken",
      token: "7",
      sort: { node: "KSort", name: "Map", params: [sort4("Int"), 42] },
    });
    expect(term.node).toBe("KOther");
  });

  test("a non-array params falls under the unknown-keys-are-ignored rule", () => {
    const term = decodeTerm({ node: "KToken", token: "7", sort: { node: "KSort", name: "Int", params: "junk" } });
    expect(term).toEqual({ node: "KToken", token: "7", sort: "Int" });
  });

  test("deeply nested sort params flatten without recursion", () => {
    const DEPTH = 100_000;
    let deep: unknown = sort4("Int");
    for (let i = 0; i < DEPTH; i++) deep = sort4("L", [deep]);
    const term = decodeTerm({ node: "KToken", token: "x", sort: deep });
    if (term.node !== "KToken") throw new Error("expected KToken");
    expect(term.sort.startsWith("L{L{L{")).toBe(true);
    expect(term.sort.length).toBe(DEPTH * 3 + 3); // "L{" + ... + "Int" + "}"...
  });
});

describe("flattenSort", () => {
  test("is the identity on a parameterless sort", () => {
    expect(flattenSort({ name: "Int" })).toBe("Int");
    expect(flattenSort({ name: "Int", params: [] })).toBe("Int");
  });

  test("spells one parameter as Name{P}", () => {
    expect(flattenSort({ name: "MInt", params: [{ name: "Width" }] })).toBe("MInt{Width}");
  });

  test("joins parameters with bare commas, no spaces — ADT.scala:75-79", () => {
    expect(flattenSort({ name: "Map", params: [{ name: "Int" }, { name: "Id" }] })).toBe("Map{Int,Id}");
  });

  test("recurses through nested parametric sorts", () => {
    expect(
      flattenSort({
        name: "A",
        params: [{ name: "B", params: [{ name: "C" }] }, { name: "D" }],
      }),
    ).toBe("A{B{C},D}");
  });
});

describe("unflattenSort", () => {
  /** Every spelling `flattenSort` can produce that this suite asserts against. */
  const SPELLINGS = [
    "Int",
    "MInt{Width}",
    "MInt{64}",
    "Map{Int,Int}",
    "A{B{C},D}",
    "A{B{C{D{E}}}}",
    "Map{Map{Int,Int},Set{Int}}",
    "#RuleTag",
    "Lbl'Unds'",
  ] as const;

  test("recovers the structure of the real spellings", () => {
    expect(unflattenSort("Int")).toEqual({ name: "Int", params: [] });
    expect(unflattenSort("MInt{Width}")).toEqual({
      name: "MInt",
      params: [{ name: "Width", params: [] }],
    });
    expect(unflattenSort("Map{Int,Int}")).toEqual({
      name: "Map",
      params: [
        { name: "Int", params: [] },
        { name: "Int", params: [] },
      ],
    });
    expect(unflattenSort("A{B{C},D}")).toEqual({
      name: "A",
      params: [
        { name: "B", params: [{ name: "C", params: [] }] },
        { name: "D", params: [] },
      ],
    });
  });

  test("undoes flattenSort — the structure comes back with params normalised", () => {
    const cases = [
      { sort: { name: "Int" }, normalised: { name: "Int", params: [] } },
      {
        sort: { name: "MInt", params: [{ name: "Width" }] },
        normalised: { name: "MInt", params: [{ name: "Width", params: [] }] },
      },
      {
        sort: { name: "Map", params: [{ name: "Int" }, { name: "Int" }] },
        normalised: {
          name: "Map",
          params: [
            { name: "Int", params: [] },
            { name: "Int", params: [] },
          ],
        },
      },
      {
        sort: { name: "A", params: [{ name: "B", params: [{ name: "C" }] }, { name: "D" }] },
        normalised: {
          name: "A",
          params: [
            { name: "B", params: [{ name: "C", params: [] }] },
            { name: "D", params: [] },
          ],
        },
      },
    ];
    for (const { sort: s, normalised } of cases) {
      expect(unflattenSort(flattenSort(s))).toEqual(normalised);
    }
  });

  test("flattenSort undoes it in turn, for every valid spelling", () => {
    for (const s of SPELLINGS) {
      const structured = unflattenSort(s);
      if (structured === undefined) throw new Error(`${s} should parse`);
      expect(flattenSort(structured)).toBe(s);
    }
  });

  test("a recovered sort is accepted as a SortShape without adaptation", () => {
    // StructuredSort is assignable to SortShape, so the two compose directly.
    expect(flattenSort(unflattenSort("Map{Int,Int}")!)).toBe("Map{Int,Int}");
  });

  test("a space is an ordinary name character — nothing is trimmed", () => {
    // The grammar has no whitespace of its own, because flattenSort emits
    // none. Trimming would make this something other than an exact inverse,
    // to accommodate a sort K cannot name in the first place.
    expect(unflattenSort("A{ B }")).toEqual({ name: "A", params: [{ name: " B ", params: [] }] });
    expect(flattenSort(unflattenSort("A{ B }")!)).toBe("A{ B }");
  });

  test("malformed spellings return undefined and never throw", () => {
    const malformed = [
      "", // a name is never empty
      "{}",
      "{Int}",
      "A{}", // an empty parameter list is not a spelling flattenSort produces
      "A{B}C", // trailing garbage
      "A{B}{C}",
      "A{B", // unbalanced
      "A{B{C}",
      "A}",
      "A{B}}",
      "A,B", // a comma with nothing open
      ",",
      "}",
      "{",
      "A{,B}",
      "A{B,}",
      "A{B,,C}",
      "A{B}D{E}",
    ];
    for (const flat of malformed) {
      expect(() => unflattenSort(flat)).not.toThrow();
      expect(unflattenSort(flat)).toBeUndefined();
    }
  });

  test("a spelling nested 100_000 deep round-trips without a RangeError", () => {
    // Built programmatically: no recursion anywhere, so depth is not a limit.
    const DEPTH = 100_000;
    const flat = `${"L{".repeat(DEPTH)}Int${"}".repeat(DEPTH)}`;
    const structured = unflattenSort(flat);
    if (structured === undefined) throw new Error("deep spelling should parse");
    expect(structured.name).toBe("L");
    expect(flattenSort(structured)).toBe(flat);
    let depth = 0;
    let cur = structured;
    while (cur.params.length === 1) {
      cur = cur.params[0]!;
      depth++;
    }
    expect(depth).toBe(DEPTH);
    expect(cur).toEqual({ name: "Int", params: [] });
  });
});

describe("decodeTerm: totality", () => {
  test("never throws on any of a wide range of malformed inputs", () => {
    const inputs: unknown[] = [
      undefined,
      null,
      42,
      "KApply",
      [],
      {},
      { node: 7 },
      { node: "KApply" }, // no label
      { node: "KApply", label: "not-an-object", args: [] },
      { node: "KApply", label: { node: "KLabel" }, args: [] }, // label has no name
      { node: "KToken" }, // no token
      { node: "KToken", token: 5, sort: sort("Int") },
      { node: "KToken", token: "x" }, // no sort
      { node: "KSequence" }, // no items
      { node: "KVariable" }, // no name
      { node: "KRewrite", lhs: tok("1") }, // no rhs
      { node: "KAs", pattern: tok("1") },
      { node: "TotallyUnknownNode", args: [tok("1")] },
      { node: "KApply", label: label("f"), args: "not-an-array" },
    ];
    for (const input of inputs) {
      expect(() => decodeTerm(input)).not.toThrow();
    }
  });

  test("a malformed node degrades to an inert KOther", () => {
    expect(decodeTerm({ node: "KToken" })).toEqual({ node: "KOther", args: [], items: [] });
    expect(decodeTerm(null)).toEqual({ node: "KOther", args: [], items: [] });
  });

  test("an unknown node still exposes args and items so traversal passes through it", () => {
    const term = decodeTerm({
      node: "SomeFutureNode",
      args: [apply("<verdict>", [tok("1")])],
      items: [tok("2")],
    });
    expect(term.node).toBe("KOther");
    // The modelled node *underneath* the unknown one is still reachable.
    expect(find(term, "<verdict>")).toBeDefined();
  });

  test("a KApply with a missing label degrades but keeps its args reachable", () => {
    const term = decodeTerm({ node: "KApply", args: [apply("<k>", [])] });
    expect(term.node).toBe("KOther");
    expect(find(term, "<k>")).toBeDefined();
  });

  test("arbitrarily deep input decodes fully — there is no depth limit", () => {
    // Built in memory rather than as text, so JSON.parse's own nesting limit
    // does not pre-empt the decoder.  Half a million levels is far beyond any
    // recursion budget an engine call stack could survive; the decoder is
    // iterative, so every level must come back faithful, not degraded.
    const DEPTH = 500_000;
    let deep: unknown = tok("0");
    for (let i = 0; i < DEPTH; i++) {
      deep = { node: "KApply", label: label("f"), arity: 1, args: [deep] };
    }
    let cur: KTerm = decodeTerm(deep);
    let seen = 0;
    while (cur.node === "KApply") {
      const only = cur.args[0];
      if (only === undefined) throw new Error("chain broke");
      cur = only;
      seen++;
    }
    expect(seen).toBe(DEPTH);
    expect(cur).toEqual({ node: "KToken", token: "0", sort: "Int" });
  });

  test("navigation and canonicalKey survive the same depth", () => {
    const DEPTH = 500_000;
    let deep: unknown = apply("bottom", []);
    for (let i = 0; i < DEPTH; i++) {
      deep = { node: "KApply", label: label("f"), arity: 1, args: [deep] };
    }
    const term = decodeTerm(deep);
    expect(head(find(term, "bottom")!)).toBe("bottom");
    expect(findAll(term, "f")).toHaveLength(DEPTH);
    expect(() => canonicalKey(term)).not.toThrow();
  });

  test("deep KRewrite chains decode and are searchable", () => {
    // KRewrite/KAs children are assigned by field, not by array index —
    // exercise that path at depth too.
    const DEPTH = 200_000;
    let deep: unknown = apply("bottom", []);
    for (let i = 0; i < DEPTH; i++) {
      deep = { node: "KRewrite", lhs: tok("1"), rhs: deep };
    }
    const term = decodeTerm(deep);
    expect(find(term, "bottom")).toBeDefined();
  });
});

describe("decodeTerm: unknown keys are ignored", () => {
  test("pyk's `variable` key on KApply does not prevent a read", () => {
    // pyk emits `variable`; the Java ToJson does not. A permanent difference
    // between two producers of the same KAST v3, not version skew.
    const term = decodeTerm({
      node: "KApply",
      label: label("<out>"),
      arity: 0,
      args: [],
      variable: false,
    });
    expect(head(term)).toBe("<out>");
  });

  test("arbitrary future keys are ignored on every node type", () => {
    expect(token(decodeTerm({ ...tok("3"), futureKey: 1 }))).toBe("3");
    expect(decodeTerm({ node: "KSequence", items: [], whatever: true }).node).toBe("KSequence");
  });

  test("`arity` is not trusted over the actual args array", () => {
    // Where the count and the array disagree, the array is the data.
    const term = decodeTerm({ node: "KApply", label: label("f"), arity: 99, args: [tok("1")] });
    if (term.node !== "KApply") throw new Error("expected KApply");
    expect(term.args).toHaveLength(1);
  });
});

describe("navigation", () => {
  const config = decodeTerm(
    apply("<generatedTop>", [
      apply("<panop>", [
        apply("<k>", [{ node: "KSequence", arity: 0, items: [] }]),
        apply("<verdict>", [apply("rejected", [apply("PANOP-TYPE-0008", [])])]),
      ]),
    ]),
  );

  test("find matches by KLabel, depth-first, node before children", () => {
    expect(head(find(config, "<verdict>")!)).toBe("<verdict>");
    expect(find(config, "nope")).toBeUndefined();
  });

  test("find descends into a KRewrite's lhs and rhs", () => {
    const term = decodeTerm({ node: "KRewrite", lhs: apply("<a>", []), rhs: apply("<b>", []) });
    expect(find(term, "<a>")).toBeDefined();
    expect(find(term, "<b>")).toBeDefined();
  });

  test("findAll returns every match", () => {
    const term = decodeTerm(apply("f", [apply("g", []), apply("g", [])]));
    expect(findAll(term, "g")).toHaveLength(2);
  });

  test("cell distinguishes present, absent and malformed", () => {
    expect(cell(config, "verdict").found).toBe("yes");
    expect(cell(config, "out").found).toBe("absent");
    // A cell that holds no argument is malformed, not absent — the two mean
    // different things to a caller.
    expect(cell(decodeTerm(apply("<out>", [])), "out").found).toBe("malformed");
  });

  test("cell takes a bare name, not an angle-bracketed one", () => {
    expect(cell(config, "<verdict>").found).toBe("absent");
  });

  test("head, firstArg and token return undefined off their own node type", () => {
    const t = decodeTerm(tok("1"));
    expect(head(t)).toBeUndefined();
    expect(firstArg(t)).toBeUndefined();
    expect(token(decodeTerm(apply("f", [])))).toBeUndefined();
  });

  test("children covers every arm of the union", () => {
    expect(children(decodeTerm(tok("1")))).toHaveLength(0);
    expect(children(decodeTerm({ node: "KRewrite", lhs: tok("1"), rhs: tok("2") }))).toHaveLength(2);
    expect(children(decodeTerm({ node: "KSequence", items: [tok("1")] }))).toHaveLength(1);
  });
});

describe("structural term comparison", () => {
  const structural = { unreadable: "structural" } as const;
  const distinct = { unreadable: "distinct" } as const;

  test("compares every node-local field", () => {
    const cases: readonly [KTerm, KTerm][] = [
      [decodedTerm(apply("f", [])), decodedTerm(apply("g", []))],
      [
        decodedTerm({ node: "KApply", label: label("f", [sort("Int")]), args: [] }),
        decodedTerm({ node: "KApply", label: label("f", [sort("Bool")]), args: [] }),
      ],
      [decodedTerm(apply("f", [])), decodedTerm(apply("f", [tok("1")]))],
      [decodedTerm(tok("1", "Int")), decodedTerm(tok("2", "Int"))],
      [decodedTerm(tok("1", "Int")), decodedTerm(tok("1", "Id"))],
      [decodedTerm({ node: "KSequence", items: [] }), decodedTerm({ node: "KSequence", items: [tok("1")] })],
      [decodedTerm({ node: "KVariable", name: "X" }), decodedTerm({ node: "KVariable", name: "Y" })],
      [decodedTerm({ node: "KVariable", name: "X" }), decodedTerm({ node: "KVariable", name: "X", sort: sort("") })],
      [
        decodedTerm({ node: "InjectedKLabel", label: label("f", [sort("Int")]) }),
        decodedTerm({ node: "InjectedKLabel", label: label("f", [sort("Bool")]) }),
      ],
      [
        { node: "KOther", args: [decodedTerm(tok("1"))], items: [] },
        { node: "KOther", args: [], items: [decodedTerm(tok("1"))] },
      ],
    ];
    for (const [left, right] of cases) {
      const difference = termDifference(left, right, structural);
      expect(difference?.path).toEqual([]);
      expect(termEq(left, right, structural)).toBe(false);
    }
  });

  test("reports the first difference depth-first in children order", () => {
    const left = decodedTerm(apply("f", [apply("left", [tok("1")]), apply("right", [tok("1")])]));
    const right = decodedTerm(apply("f", [apply("left", [tok("2")]), apply("right", [tok("2")])]));
    const difference = termDifference(left, right, structural);
    expect(difference?.path).toEqual([0, 0]);
    expect(subtermAt(left, difference?.path ?? [])).toBe(difference?.left);

    const rewrite = decodedTerm({ node: "KRewrite", lhs: tok("1"), rhs: tok("2") });
    const rewriteChanged = decodedTerm({ node: "KRewrite", lhs: tok("3"), rhs: tok("4") });
    expect(termDifference(rewrite, rewriteChanged, structural)?.path).toEqual([0]);

    const as = decodedTerm({ node: "KAs", pattern: tok("1"), alias: tok("2") });
    const asChanged = decodedTerm({ node: "KAs", pattern: tok("3"), alias: tok("4") });
    expect(termDifference(as, asChanged, structural)?.path).toEqual([0]);
  });

  test("makes the unreadable-node policy explicit", () => {
    const unreadable: KTerm = {
      node: "KOther",
      args: [decodedTerm(tok("1"))],
      items: [decodedTerm(tok("2"))],
    };
    expect(termEq(unreadable, unreadable, structural)).toBe(true);
    expect(termDifference(unreadable, unreadable, structural)).toBeUndefined();
    expect(termEq(unreadable, unreadable, distinct)).toBe(false);
    expect(termDifference(unreadable, unreadable, distinct)?.path).toEqual([]);

    const changed: KTerm = {
      node: "KOther",
      args: [decodedTerm(tok("1"))],
      items: [decodedTerm(tok("3"))],
    };
    expect(termDifference(unreadable, changed, structural)?.path).toEqual([1]);
  });

  test("subtermAt and pathEq are total path values", () => {
    const root = decodedTerm(apply("f", [apply("g", [tok("1")])]));
    expect(head(subtermAt(root, [0])!)).toBe("g");
    expect(token(subtermAt(root, [0, 0])!)).toBe("1");
    expect(subtermAt(root, [])).toBe(root);
    expect(subtermAt(root, [1])).toBeUndefined();
    expect(subtermAt(root, [-1])).toBeUndefined();
    expect(pathEq([0, 1], [0, 1])).toBe(true);
    expect(pathEq([0, 1], [1, 0])).toBe(false);
  });

  test("compares and addresses a 100,000-deep term without recursion", () => {
    const DEPTH = 100_000;
    let left: KTerm = { node: "KToken", token: "left", sort: "Int" };
    let right: KTerm = { node: "KToken", token: "right", sort: "Int" };
    for (let i = 0; i < DEPTH; i++) {
      left = { node: "KApply", label: "f", params: [], args: [left] };
      right = { node: "KApply", label: "f", params: [], args: [right] };
    }
    const difference = termDifference(left, right, structural);
    expect(difference).toBeDefined();
    expect(difference?.path).toHaveLength(DEPTH);
    expect(token(subtermAt(left, difference?.path ?? [])!)).toBe("left");
  });
});

describe("canonicalKey", () => {
  test("is stable and distinguishes structurally different terms", () => {
    const a = decodeTerm(apply("f", [tok("1")]));
    const b = decodeTerm(apply("f", [tok("1")]));
    const c = decodeTerm(apply("f", [tok("2")]));
    expect(canonicalKey(a)).toBe(canonicalKey(b));
    expect(canonicalKey(a)).not.toBe(canonicalKey(c));
  });

  test("distinguishes the same token text at different sorts", () => {
    expect(canonicalKey(decodeTerm(tok("1", "Int")))).not.toBe(canonicalKey(decodeTerm(tok("1", "Id"))));
  });
});

describe("parseTermDocument", () => {
  test("reads a wrapped term and reports the version", () => {
    const result = parseTermDocument(wrap(apply("<k>", [])));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(head(result.term)).toBe("<k>");
      expect(result.version).toBe(3);
    }
  });

  test("reads a v4 document to the same KTerm as its v3 equivalent", () => {
    const v3 = parseTermDocument(wrap(tok("7")));
    const v4 = parseTermDocument(wrap({ node: "KToken", token: "7", sort: sort4("Int") }, 4));
    if (!v3.ok || !v4.ok) throw new Error("both must parse");
    expect(v4.version).toBe(4);
    expect(v4.term).toEqual(v3.term);
  });

  test("an accept list narrows what is read", () => {
    const v4doc = wrap({ node: "KToken", token: "7", sort: sort4("Int") }, 4);
    expect(parseTermDocument(v4doc, [3]).ok).toBe(false);
    expect(parseTermDocument(v4doc, [4]).ok).toBe(true);
  });

  test("fails on the envelope but never on the term", () => {
    expect(parseTermDocument("not json").ok).toBe(false);
    expect(parseTermDocument(JSON.stringify({ format: "KAST", version: 5, term: {} })).ok).toBe(false);
    // Any term at all, however broken, still decodes.
    const result = parseTermDocument(wrap({ node: "???", nonsense: true }));
    expect(result.ok).toBe(true);
  });
});
