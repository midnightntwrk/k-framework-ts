import { describe, expect, test } from "bun:test";
import {
  attLocation,
  attSource,
  attString,
  LOCATION_KEY,
  modulesOf,
  parseDefinitionDocument,
  PRODUCTION_KEY,
  productions,
  rules,
  SOURCE_KEY,
} from "../src/index.ts";

const sort = (name: string) => ({ node: "KSort", name });
const att = (map: Record<string, unknown> = {}) => ({ node: "KAtt", att: map });
const emptyTerm = { node: "KSequence", arity: 0, items: [] };

const rule = (map: Record<string, unknown> = {}) => ({
  node: "KRule",
  body: emptyTerm,
  requires: emptyTerm,
  ensures: emptyTerm,
  att: att(map),
});

const production = (map: Record<string, unknown> = {}) => ({
  node: "KProduction",
  productionItems: [
    { node: "KTerminal", value: "while" },
    { node: "KNonTerminal", sort: sort("Exp"), name: "cond" },
  ],
  params: [],
  sort: sort("Stmt"),
  att: att(map),
});

const module = (name: string, localSentences: unknown[]) => ({
  node: "KFlatModule",
  name,
  imports: [{ node: "KImport", name: "BOOL", isPublic: true }],
  localSentences,
  att: att(),
});

const doc = (modules: unknown[], version = 3): string =>
  JSON.stringify({
    format: "KAST",
    version,
    term: { node: "KDefinition", mainModule: "MAIN", modules, att: att() },
  });

/** A structured v4 KSort — `params` always present in real v4 output. */
const sort4 = (name: string, params: unknown[] = []) => ({ node: "KSort", name, params });

describe("parseDefinitionDocument", () => {
  test("reads a minimal definition", () => {
    const result = parseDefinitionDocument(doc([module("MAIN", [rule({ label: "MAIN.r1" }), production()])]));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(modulesOf(result.definition)).toHaveLength(1);
    expect(rules(result.definition)).toHaveLength(1);
    expect(productions(result.definition)).toHaveLength(1);
  });

  test("the module node is KFlatModule; KModule is not a KAST v3 node", () => {
    const withKModule = doc([{ ...module("MAIN", []), node: "KModule" }]);
    const result = parseDefinitionDocument(withKModule);
    expect(result.ok).toBe(false);
  });

  test("fails loudly with a path to the offending node", () => {
    const broken = doc([module("MAIN", [{ ...rule(), att: "not-an-att-block" }])]);
    const result = parseDefinitionDocument(broken);
    expect(result.ok).toBe(false);
    if (result.ok || result.problem.kind !== "schema") throw new Error("expected schema failure");
    expect(result.problem.message).toContain("modules.0.localSentences.0");
    expect(result.problem.issues.length).toBeGreaterThan(0);
  });

  test("propagates an envelope failure rather than a schema one", () => {
    const result = parseDefinitionDocument(JSON.stringify({ format: "KAST", version: 5, term: {} }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.problem.kind).toBe("wrong-version");
  });

  test("a v3 document's sorts read with params defaulted to []", () => {
    const result = parseDefinitionDocument(doc([module("MAIN", [production()])]));
    if (!result.ok) throw new Error("expected ok");
    expect(result.version).toBe(3);
    const p = productions(result.definition)[0]!.production;
    expect(p.sort).toEqual({ node: "KSort", name: "Stmt", params: [] });
  });

  test("a v4 document's structured sorts read as structure", () => {
    const p = {
      ...production(),
      sort: sort4("Map", [sort4("Int"), sort4("Id")]),
      params: [sort4("Sort")],
      productionItems: [{ node: "KNonTerminal", sort: sort4("Exp") }],
      att: { node: "KAtt", att: { predicate: sort4("MInt", [sort4("Width")]) } },
    };
    const result = parseDefinitionDocument(doc([module("MAIN", [p])], 4));
    if (!result.ok) throw new Error("expected ok");
    expect(result.version).toBe(4);
    const read = productions(result.definition)[0]!.production;
    expect(read.sort.name).toBe("Map");
    expect(read.sort.params.map((s) => s.name)).toEqual(["Int", "Id"]);
  });

  test("a v4 skeleton KSort without params fails with a path — mirroring the Java NPE cleanly", () => {
    const p = { ...production(), sort: { node: "KSort", name: "Stmt" } };
    const result = parseDefinitionDocument(doc([module("MAIN", [p])], 4));
    expect(result.ok).toBe(false);
    if (result.ok || result.problem.kind !== "v4-sort-params") throw new Error("expected v4-sort-params");
    expect(result.problem.path).toContain("modules.0.localSentences.0.sort");
    expect(result.problem.message).toContain("v4");
  });

  test("a params-less KSort inside an embedded term does NOT fail a v4 document", () => {
    // Rule bodies go through the total term decoder, whose contract is to
    // degrade, never to fail the document — the skeleton/embedded split.
    const r = { ...rule(), body: { node: "KToken", token: "1", sort: { node: "KSort", name: "Int" } } };
    const result = parseDefinitionDocument(doc([module("MAIN", [r])], 4));
    expect(result.ok).toBe(true);
  });

  test("an accept list narrows what is read", () => {
    const v4doc = doc([module("MAIN", [])], 4);
    expect(parseDefinitionDocument(v4doc, [3]).ok).toBe(false);
    expect(parseDefinitionDocument(v4doc, [4]).ok).toBe(true);
    expect(parseDefinitionDocument(doc([module("MAIN", [])]), [4]).ok).toBe(false);
  });

  test("ignores unknown keys on definition nodes", () => {
    const result = parseDefinitionDocument(
      doc([{ ...module("MAIN", [{ ...rule(), futureKey: 123 }]), anotherFutureKey: true }]),
    );
    expect(result.ok).toBe(true);
  });

  test("accepts a KFlatModuleList root, whose modules live under `term`", () => {
    const text = JSON.stringify({
      format: "KAST",
      version: 3,
      term: { node: "KFlatModuleList", mainModule: "SPEC", term: [module("SPEC", [])] },
    });
    const result = parseDefinitionDocument(text);
    expect(result.ok).toBe(true);
    if (result.ok) expect(modulesOf(result.definition)[0]?.name).toBe("SPEC");
  });

  test("a malformed rule body degrades to KOther instead of failing the document", () => {
    const result = parseDefinitionDocument(doc([module("MAIN", [{ ...rule(), body: { node: "???" } }])]));
    expect(result.ok).toBe(true);
    if (result.ok) expect(rules(result.definition)[0]?.rule.body.node).toBe("KOther");
  });

  test("models every sentence type ToJson can emit", () => {
    const sentences: unknown[] = [
      rule(),
      { ...rule(), node: "KClaim" },
      { node: "KContext", body: emptyTerm, requires: emptyTerm, att: att() },
      { node: "KConfiguration", body: emptyTerm, ensures: emptyTerm, att: att() },
      production(),
      { node: "KSyntaxPriority", priorities: [["a", "b"], ["c"]], att: att() },
      { node: "KSyntaxAssociativity", assoc: "Left", tags: ["t"], att: att() },
      { node: "KSyntaxSort", sort: sort("Exp"), params: [], att: att() },
      { node: "KSortSynonym", newSort: sort("A"), oldSort: sort("B"), att: att() },
      { node: "KSyntaxLexical", name: "Digit", regex: "[0-9]", att: att() },
      { node: "KBubble", sentenceType: "rule", contents: "X => Y", att: att() },
      { node: "badsentence" },
    ];
    const result = parseDefinitionDocument(doc([module("MAIN", sentences)]));
    expect(result.ok).toBe(true);
    if (result.ok) expect(modulesOf(result.definition)[0]?.localSentences).toHaveLength(sentences.length);
  });

  test("reads a KRegexTerminal production item", () => {
    const p = { ...production(), productionItems: [{ node: "KRegexTerminal", regex: "[a-z]+" }] };
    const result = parseDefinitionDocument(doc([module("MAIN", [p])]));
    expect(result.ok).toBe(true);
  });

  test("rejects an unknown production item rather than dropping it", () => {
    const p = { ...production(), productionItems: [{ node: "KSomethingNew" }] };
    expect(parseDefinitionDocument(doc([module("MAIN", [p])])).ok).toBe(false);
  });
});

describe("attribute access", () => {
  test("reads strings, Source and the 4-int Location array", () => {
    const result = parseDefinitionDocument(
      doc([
        module("MAIN", [
          rule({
            label: "MAIN.r1",
            UNIQUE_ID: "abc123",
            [SOURCE_KEY]: "/k/spec.md",
            [LOCATION_KEY]: [10, 3, 12, 40],
          }),
        ]),
      ]),
    );
    if (!result.ok) throw new Error("expected ok");
    const a = rules(result.definition)[0]!.rule.att;
    expect(attString(a, "label")).toBe("MAIN.r1");
    expect(attString(a, "UNIQUE_ID")).toBe("abc123");
    expect(attSource(a)).toBe("/k/spec.md");
    expect(attLocation(a)).toEqual({ startLine: 10, startColumn: 3, endLine: 12, endColumn: 40 });
  });

  test("returns undefined for a missing or wrongly-shaped attribute", () => {
    const result = parseDefinitionDocument(doc([module("MAIN", [rule({ [LOCATION_KEY]: [1, 2] })])]));
    if (!result.ok) throw new Error("expected ok");
    const a = rules(result.definition)[0]!.rule.att;
    expect(attString(a, "nope")).toBeUndefined();
    expect(attSource(a)).toBeUndefined();
    expect(attLocation(a)).toBeUndefined();
  });

  test("attribute access never recurses into a nested Production's own att", () => {
    // The documented trap: a rule's att block nests a whole KProduction that
    // carries its OWN Source/Location pointing at K's builtins. A recursive
    // "find any Source" walk silently attributes the rule to kast.md.
    const nested = production({ [SOURCE_KEY]: "/k/builtin/kast.md", [LOCATION_KEY]: [1, 1, 1, 1] });
    const result = parseDefinitionDocument(
      doc([module("MAIN", [rule({ [SOURCE_KEY]: "/my/spec.md", [PRODUCTION_KEY]: nested })])]),
    );
    if (!result.ok) throw new Error("expected ok");
    const a = rules(result.definition)[0]!.rule.att;
    expect(attSource(a)).toBe("/my/spec.md");
    // The nested production is preserved and readable, just never conflated.
    const inner = a.att[PRODUCTION_KEY];
    expect(typeof inner === "object" && inner !== null && "node" in inner).toBe(true);
  });

  test("reads KSort- and KLabel-valued attributes", () => {
    const result = parseDefinitionDocument(
      doc([
        module("MAIN", [
          production({
            predicate: sort("Exp"),
            bracketLabel: { node: "KLabel", name: "b", params: [] },
          }),
        ]),
      ]),
    );
    expect(result.ok).toBe(true);
  });

  test("rules are attributed to the module that declares them", () => {
    const result = parseDefinitionDocument(
      doc([module("A", [rule({ label: "A.r" })]), module("B", [rule({ label: "B.r" })])]),
    );
    if (!result.ok) throw new Error("expected ok");
    expect(rules(result.definition).map((r) => r.module)).toEqual(["A", "B"]);
  });
});
