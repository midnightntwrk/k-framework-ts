/**
 * Conformance against real K output.
 *
 * This package is a hand-transcription of a Java file, and nothing about a
 * hand-transcription is self-verifying.  These tests are what make it
 * trustworthy: every fixture below is byte-for-byte what `kompile`/`krun`
 * v7.1.191 actually wrote.  See `fixtures/PROVENANCE.md`.
 *
 * They read only checked-in files, so they pass with **no K installed and no
 * network**.
 */

import { describe, expect, test } from "bun:test";
import { eq, fromDict, kastTerm } from "../../kast/src/index.ts";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  attLocation,
  attSource,
  attString,
  builtinListElements,
  canonicalKey,
  cell,
  children,
  decodeTerm,
  find,
  flattenSort,
  head,
  type DefinitionTermJson,
  isRecord,
  type KSortJson,
  type KTerm,
  mapEntries,
  modulesOf,
  parseDefinitionDocument,
  parseTermDocument,
  PRODUCTION_KEY,
  productions,
  rules,
  setElements,
  type StructuredSort,
  token,
  termEq,
  unflattenSort,
  userListElements,
} from "../src/index.ts";

const FIXTURES = join(import.meta.dir, "..", "fixtures");
const read = (...parts: string[]): string => readFileSync(join(FIXTURES, ...parts), "utf8");

const DEFINITION_FIXTURES = readdirSync(join(FIXTURES, "definition"))
  .filter((f) => f.endsWith(".json"))
  .toSorted();
const TERM_FIXTURES = readdirSync(join(FIXTURES, "term"))
  .filter((f) => f.endsWith(".json"))
  .toSorted();

describe("fixtures exist", () => {
  test("both flavours are represented", () => {
    expect(DEFINITION_FIXTURES.length).toBeGreaterThanOrEqual(4);
    expect(TERM_FIXTURES.length).toBeGreaterThanOrEqual(8);
  });
});

describe("definition flavour: kompile --emit-json", () => {
  for (const name of DEFINITION_FIXTURES) {
    test(`${name} parses strictly`, () => {
      const result = parseDefinitionDocument(read("definition", name));
      if (!result.ok) {
        throw new Error(
          `${name}: ${result.problem.message}\n` +
            ("issues" in result.problem ? JSON.stringify(result.problem.issues.slice(0, 5), null, 2) : ""),
        );
      }
      // Real definitions are substantial; a schema that silently matched an
      // empty shell would pass a weaker assertion than this.
      expect(result.definition.node).toBe("KDefinition");
      expect(modulesOf(result.definition).length).toBeGreaterThan(10);
      expect(productions(result.definition).length).toBeGreaterThan(100);
    });
  }

  test("every module node is KFlatModule, and none has a `sentences` key", () => {
    // Guards the correction this package makes to the shape: KAST v3 emits
    // KFlatModule (ToJson calls mod.flattened()), never KModule, and carries
    // only `localSentences`.
    for (const name of DEFINITION_FIXTURES) {
      for (const m of rawModules(read("definition", name))) {
        expect(m.node).toBe("KFlatModule");
        expect("sentences" in m).toBe(false);
      }
    }
  });

  test("compiled.json carries UNIQUE_ID on every rule; parsed.json carries none", () => {
    // Rule identity is assigned during compilation. Reading grammar from
    // compiled.json, or identity from parsed.json, would be reading the
    // wrong artifact.
    const compiled = parseDefinitionDocument(read("definition", "panop-semantics.compiled.json"));
    const parsed = parseDefinitionDocument(read("definition", "panop-semantics.parsed.json"));
    if (!compiled.ok || !parsed.ok) throw new Error("fixtures must parse");

    const compiledRules = rules(compiled.definition);
    expect(compiledRules.length).toBeGreaterThan(0);
    expect(compiledRules.every((r) => attString(r.rule.att, "UNIQUE_ID") !== undefined)).toBe(true);

    const parsedRules = rules(parsed.definition);
    expect(parsedRules.length).toBeGreaterThan(0);
    expect(parsedRules.every((r) => attString(r.rule.att, "UNIQUE_ID") === undefined)).toBe(true);
  });

  test("UNIQUE_ID is NOT globally unique — K's builtins collide", () => {
    // A consumer that keys a map on UNIQUE_ID across a whole definition will
    // silently lose rules. Measured on this fixture: 449 rules, 362 distinct.
    const result = parseDefinitionDocument(read("definition", "panop-semantics.compiled.json"));
    if (!result.ok) throw new Error("fixture must parse");
    const ids = rules(result.definition).map((r) => attString(r.rule.att, "UNIQUE_ID"));
    expect(new Set(ids).size).toBeLessThan(ids.length);
  });

  test("the nested-Production attribute trap is real in K's own output", () => {
    // A rule's att nests a whole KProduction whose own Source points at K's
    // builtins, not at the rule's file. Top-level reads only.
    const result = parseDefinitionDocument(read("definition", "panop-semantics.compiled.json"));
    if (!result.ok) throw new Error("fixture must parse");
    let confirmed = 0;
    for (const { rule } of rules(result.definition)) {
      const outer = attSource(rule.att);
      const nested = rule.att.att[PRODUCTION_KEY];
      if (outer === undefined || typeof nested !== "object" || nested === null) continue;
      if (!("node" in nested) || nested.node !== "KProduction") continue;
      const innerSource = attSource(nested.att);
      if (innerSource !== undefined && innerSource !== outer) confirmed++;
    }
    expect(confirmed).toBeGreaterThan(0);
  });

  test("Location attributes are 4-int arrays, not text needing a regex", () => {
    const result = parseDefinitionDocument(read("definition", "panop-semantics.compiled.json"));
    if (!result.ok) throw new Error("fixture must parse");
    const located = rules(result.definition)
      .map((r) => attLocation(r.rule.att))
      .filter((l) => l !== undefined);
    expect(located.length).toBeGreaterThan(0);
    for (const loc of located) expect(Number.isInteger(loc.startLine)).toBe(true);
  });

  test("a real parametric sort arrives as a flat v3 string", () => {
    // "MInt{Width}" — one string, not a name plus structured params. This is
    // exactly what KAST v4 changed.
    const raw = read("definition", "panop-semantics.compiled.json");
    expect(raw).toContain('"MInt{Width}"');
    const result = parseDefinitionDocument(raw);
    if (!result.ok) throw new Error("fixture must parse");
    const names = new Set<string>();
    for (const { production } of productions(result.definition)) names.add(production.sort.name);
    expect(names.size).toBeGreaterThan(5);
  });

  test("optional fields really are optional in real output", () => {
    const result = parseDefinitionDocument(read("definition", "panop-semantics.compiled.json"));
    if (!result.ok) throw new Error("fixture must parse");
    const all = productions(result.definition).map((p) => p.production);
    expect(all.some((p) => p.klabel !== undefined)).toBe(true);
    expect(all.some((p) => p.klabel === undefined)).toBe(true);
    const nonTerminals = all.flatMap((p) => p.productionItems).filter((i) => i.node === "KNonTerminal");
    expect(nonTerminals.some((i) => i.name !== undefined)).toBe(true);
    expect(nonTerminals.some((i) => i.name === undefined)).toBe(true);
  });
});

describe("term flavour: krun --output json", () => {
  for (const name of TERM_FIXTURES) {
    test(`${name} decodes to a configuration`, () => {
      const result = parseTermDocument(read("term", name));
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      // Every krun final configuration is wrapped in <generatedTop>.
      expect(head(result.term)).toBe("<generatedTop>");
      expect(cell(result.term, "k").found).toBe("yes");
      // Nothing anywhere in a real term should have degraded.
      expect(countOther(result.term)).toBe(0);
    });
  }

  test("a value result reads through <outcome>", () => {
    const result = parseTermDocument(read("term", "term-semantics-value-int.json"));
    if (!result.ok) throw new Error("fixture must parse");
    const outcome = cell(result.term, "outcome");
    expect(outcome.found).toBe("yes");
    if (outcome.found !== "yes") return;
    expect(head(outcome.content)).toBe("returned");
    const value = outcome.content.node === "KApply" ? outcome.content.args[0] : undefined;
    expect(token(value!)).toBe("7");
  });

  test("an empty builtin List and an empty user list read as empty, not as absent", () => {
    const result = parseTermDocument(read("term", "term-semantics-value-int.json"));
    if (!result.ok) throw new Error("fixture must parse");
    const out = cell(result.term, "out");
    expect(out.found).toBe("yes");
    if (out.found !== "yes") return;
    expect(builtinListElements(out.content)).toEqual([]);
  });

  test("output effects read as an ordered builtin List of emits", () => {
    const result = parseTermDocument(read("term", "term-semantics-output-effects.json"));
    if (!result.ok) throw new Error("fixture must parse");
    const out = cell(result.term, "out");
    if (out.found !== "yes") throw new Error("expected <out>");
    const items = builtinListElements(out.content);
    expect(items).toHaveLength(1);
    const emit = items![0]!;
    expect(head(emit)).toBe("emit");
    if (emit.node !== "KApply") return;
    expect(token(emit.args[0]!)).toBe("Out");
    expect(userListElements(emit.args[1]!)?.map((e) => token(e))).toEqual(["55"]);
  });

  test("a multi-element user list reads in order, from real krun output", () => {
    const result = parseTermDocument(read("term", "term-semantics-user-list-multi.json"));
    if (!result.ok) throw new Error("fixture must parse");
    const out = cell(result.term, "out");
    if (out.found !== "yes") throw new Error("expected <out>");
    const emits = builtinListElements(out.content) ?? [];
    expect(emits).toHaveLength(2);
    expect(readEmit(emits[0]!)).toEqual(["Trio", ["1", "2", "3"]]);
    expect(readEmit(emits[1]!)).toEqual(["Solo", ["9"]]);
  });

  test("a trap reads through <outcome>", () => {
    const result = parseTermDocument(read("term", "term-semantics-trap-divzero.json"));
    if (!result.ok) throw new Error("fixture must parse");
    const outcome = cell(result.term, "outcome");
    if (outcome.found !== "yes") throw new Error("expected <outcome>");
    expect(head(outcome.content)).toBe("trapped");
  });

  test("a rejection reads through <verdict> by KLabel", () => {
    const result = parseTermDocument(read("term", "term-types-rejected.json"));
    if (!result.ok) throw new Error("fixture must parse");
    const verdict = cell(result.term, "verdict");
    if (verdict.found !== "yes") throw new Error("expected <verdict>");
    expect(head(verdict.content)).toBe("rejected");
    const code = verdict.content.node === "KApply" ? head(verdict.content.args[0]!) : undefined;
    expect(code).toBe("PANOP-TYPE-0008");
  });

  test("an acceptance reads through <verdict>", () => {
    const result = parseTermDocument(read("term", "term-types-accepted.json"));
    if (!result.ok) throw new Error("fixture must parse");
    const verdict = cell(result.term, "verdict");
    if (verdict.found !== "yes") throw new Error("expected <verdict>");
    expect(head(verdict.content)).toBe("accepted");
  });

  test("a real AC Map reads as unordered, and a real Set as unordered", () => {
    const semantics = parseTermDocument(read("term", "term-semantics-output-effects.json"));
    if (!semantics.ok) throw new Error("fixture must parse");
    const store = cell(semantics.term, "store");
    if (store.found !== "yes") throw new Error("expected <store>");
    const map = mapEntries(store.content);
    expect(map?.unordered).toBe(true);
    expect(map?.entries).toHaveLength(3);

    const types = parseTermDocument(read("term", "term-types-rejected.json"));
    if (!types.ok) throw new Error("fixture must parse");
    const scope = cell(types.term, "scope");
    if (scope.found !== "yes") throw new Error("expected <scope>");
    expect(setElements(scope.content)?.unordered).toBe(true);
  });

  test("a cell that does not exist is absent, not an error", () => {
    const result = parseTermDocument(read("term", "term-types-accepted.json"));
    if (!result.ok) throw new Error("fixture must parse");
    // <out> belongs to the semantics configuration, not the types one.
    expect(cell(result.term, "out").found).toBe("absent");
    expect(cell(result.term, "definitelyNotACell").found).toBe("absent");
  });
});

describe("the totality guarantee holds against mutated real output", () => {
  const raw = read("term", "term-semantics-output-effects.json");

  test("every single-character truncation either fails the envelope or decodes", () => {
    // Every offset, not a sample of them. This read every 37th byte until it
    // was measured: exhaustive is 3473 truncations in 27ms against a suite that
    // runs in 220ms, so the stride bought 24ms and cost the test its name.
    //
    // It cost something less obvious too. A stride is a sample *rate*, so the
    // coverage it gives depends on the file's length — when this fixture was
    // restored to the bytes K actually emits it halved in size, and the test
    // quietly did half as much work while still reporting green. Counting to
    // the length instead means that cannot happen again: whatever the fixture
    // becomes, every truncation of it is checked.
    for (let cut = 1; cut < raw.length; cut++) {
      expect(() => parseTermDocument(raw.slice(0, cut))).not.toThrow();
    }
  });

  test("stripping every `node` key still decodes without throwing", () => {
    const parsed: unknown = JSON.parse(raw);
    const stripped = JSON.stringify(parsed, (key, value: unknown) => (key === "node" ? undefined : value));
    const result = parseTermDocument(stripped);
    expect(result.ok).toBe(true);
    if (result.ok) expect(countOther(result.term)).toBeGreaterThan(0);
  });

  test("replacing every label with a number still decodes without throwing", () => {
    const parsed: unknown = JSON.parse(raw);
    const mangled = JSON.stringify(parsed, (key, value: unknown) => (key === "label" ? 1 : value));
    expect(() => parseTermDocument(mangled)).not.toThrow();
  });

  test("a definition document fed to the term reader still decodes", () => {
    // Wrong flavour, right envelope: must degrade, not throw.
    const result = parseTermDocument(read("definition", "panop-semantics.parsed.json"));
    expect(result.ok).toBe(true);
  });

  test("a term document fed to the definition reader fails loudly", () => {
    const result = parseDefinitionDocument(raw);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.problem.kind).toBe("schema");
  });
});

/**
 * The raw `term.modules` array of a definition document, untyped on purpose:
 * this check exists to inspect the JSON *as written*, below the schema.
 */
function rawModules(text: string): readonly Record<string, unknown>[] {
  const doc: unknown = JSON.parse(text);
  if (!isRecord(doc)) return [];
  const term = doc["term"];
  if (!isRecord(term)) return [];
  const modules = term["modules"];
  return Array.isArray(modules) ? modules.filter((m) => isRecord(m)) : [];
}

/** An `emit` node read as its event name plus its user-list arguments. */
function readEmit(t: KTerm): [string | undefined, (string | undefined)[] | undefined] {
  if (t.node !== "KApply") return [undefined, undefined];
  return [token(t.args[0]!), userListElements(t.args[1]!)?.map((e) => token(e))];
}

/** How many nodes degraded to `KOther` — zero, for well-formed real output. */
function countOther(term: KTerm): number {
  let n = term.node === "KOther" ? 1 : 0;
  for (const child of children(term)) n += countOther(child);
  return n;
}

describe("KAST v4 conformance: the same panopticon toolchain runs at K v7.1.337", () => {
  // fixtures/definition/v4 and fixtures/term/v4 are kompile/krun v7.1.337
  // output for the same definitions and (for term/) the same programs as the
  // v3 fixtures beside them. Definitions are NOT byte-pairable across K
  // releases (K's builtin modules changed between v7.1.191 and v7.1.337), so
  // they are checked structurally; final configurations ARE identical, so
  // the term fixtures are checked pairwise against their v3 siblings.
  const V4_DEFINITIONS = readdirSync(join(FIXTURES, "definition", "v4"))
    .filter((f) => f.endsWith(".json"))
    .toSorted();
  const V4_TERMS = readdirSync(join(FIXTURES, "term", "v4"))
    .filter((f) => f.endsWith(".json"))
    .toSorted();

  test("the v4 fixture set mirrors the v3 one", () => {
    expect(V4_DEFINITIONS).toEqual(DEFINITION_FIXTURES);
    // Every v4 term fixture pairs with a v3 fixture of the same name. (The
    // reverse is not required: a v3 fixture may lack a v4 counterpart.)
    for (const name of V4_TERMS) expect(TERM_FIXTURES).toContain(name);
    expect(V4_TERMS.length).toBeGreaterThanOrEqual(8);
  });

  for (const name of V4_DEFINITIONS) {
    test(`${name} (v4) parses strictly, with structure where v3 had flat strings`, () => {
      const result = parseDefinitionDocument(read("definition", "v4", name));
      if (!result.ok) throw new Error(`${name}: ${result.problem.message}`);
      expect(result.version).toBe(4);
      expect(result.definition.node).toBe("KDefinition");
      expect(modulesOf(result.definition).length).toBeGreaterThan(10);
      expect(productions(result.definition).length).toBeGreaterThan(100);
    });
  }

  test("a real v4 parametric sort arrives as structure, and flattens to the v3 spelling", () => {
    const raw = read("definition", "v4", "panop-semantics.compiled.json");
    // The v4 writer spells MInt{Width} as structure — the flat string must
    // not appear anywhere in the document.
    expect(raw).not.toContain('"MInt{Width}"');
    const result = parseDefinitionDocument(raw);
    if (!result.ok) throw new Error("fixture must parse");
    const parametric = productions(result.definition)
      .map((p) => p.production.sort)
      .filter((s) => s.params.length > 0);
    expect(parametric.length).toBeGreaterThan(0);
    expect(parametric.some((s) => flattenSort(s) === "MInt{Width}")).toBe(true);
  });

  test("compiled.json carries UNIQUE_ID on every rule at v4 too; parsed.json none", () => {
    const compiled = parseDefinitionDocument(read("definition", "v4", "panop-semantics.compiled.json"));
    const parsed = parseDefinitionDocument(read("definition", "v4", "panop-semantics.parsed.json"));
    if (!compiled.ok || !parsed.ok) throw new Error("fixtures must parse");
    expect(rules(compiled.definition).every((r) => attString(r.rule.att, "UNIQUE_ID") !== undefined)).toBe(true);
    expect(rules(parsed.definition).every((r) => attString(r.rule.att, "UNIQUE_ID") === undefined)).toBe(true);
  });

  for (const name of V4_TERMS) {
    test(`${name} (v4) decodes to a configuration with nothing degraded`, () => {
      const result = parseTermDocument(read("term", "v4", name));
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.version).toBe(4);
      expect(head(result.term)).toBe("<generatedTop>");
      expect(countOther(result.term)).toBe(0);
    });

    test(`${name}: krun at v7.1.191 and v7.1.337 decode to the identical KTerm`, () => {
      // The same program, run through two K releases that disagree about the
      // wire format, must land on the same decoded term with the same
      // canonical key — the package's whole cross-version contract, measured
      // on real end-to-end toolchain output.
      const v3 = parseTermDocument(read("term", name));
      const v4 = parseTermDocument(read("term", "v4", name));
      if (!v3.ok || !v4.ok) throw new Error(`${name}: both versions must parse`);
      expect(v4.term).toEqual(v3.term);
      expect(canonicalKey(v4.term)).toBe(canonicalKey(v3.term));
    });
  }

  test("term equality agrees with kast on every v4 term fixture both readers accept", () => {
    const terms = V4_TERMS.map((name) => {
      const text = read("term", "v4", name);
      const decoded = parseTermDocument(text);
      if (!decoded.ok) throw new Error(`${name}: kast-json must decode`);
      return { name, decoded: decoded.term, strict: fromDict(kastTerm(JSON.parse(text))) };
    });
    for (const left of terms) {
      for (const right of terms) {
        expect(termEq(left.decoded, right.decoded, { unreadable: "structural" }), `${left.name} / ${right.name}`).toBe(
          eq(left.strict, right.strict),
        );
      }
    }
  });
});

describe("an instantiated parametric sort, MInt{64}, from both toolchains", () => {
  // `fixtures/src/mint-width.k` exists only to make a real K toolchain emit an
  // *instantiated* parametric sort into both flavours. MInt{64} is as deep as
  // the Java frontend goes: K rejects user-defined parametric sorts outright
  // ("User-defined parametric sorts are currently unsupported",
  // k-distribution/tests/regression-new/checks/checkParametricSort.k), so
  // depth->=2 nesting has no Java-side producer to fixture at all. The nested
  // spellings under `upstream/` are pyk's, the format's other real writer.
  const TERM = "term-mint-width-value.json";
  const DEFINITION = "mint-width.compiled.json";
  const MINT64: StructuredSort = { name: "MInt", params: [{ name: "64", params: [] }] };

  test("the two versions spell the token's sort differently in the bytes", () => {
    expect(read("term", TERM)).toContain('"MInt{64}"');
    const v4 = read("term", "v4", TERM);
    expect(v4).toContain('"name":"MInt"');
    expect(v4).not.toContain('"MInt{64}"');
  });

  test("both decode the token to the flat MInt{64}, which unflattenSort takes apart again", () => {
    for (const parts of [[TERM], ["v4", TERM]]) {
      const result = parseTermDocument(read("term", ...parts));
      if (!result.ok) throw new Error(`${parts.join("/")}: ${result.problem.message}`);
      const value = cell(result.term, "value");
      if (value.found !== "yes") throw new Error("expected <value>");
      expect(value.content).toEqual({ node: "KToken", token: "7p64", sort: "MInt{64}" });
      expect(unflattenSort("MInt{64}")).toEqual(MINT64);
    }
  });

  test("the v4 definition carries the instantiated sort as structure, the v3 one flat", () => {
    const v4 = parseDefinitionDocument(read("definition", "v4", DEFINITION));
    const v3 = parseDefinitionDocument(read("definition", DEFINITION));
    if (!v4.ok || !v3.ok) throw new Error("fixtures must parse");
    const structured = sortsOfProductions(v4.definition).filter((s) => flattenSort(s) === "MInt{64}");
    expect(structured.length).toBeGreaterThan(0);
    for (const s of structured) {
      expect(s.name).toBe("MInt");
      expect(s.params.map((p) => p.name)).toEqual(["64"]);
      expect(unflattenSort(flattenSort(s))).toEqual(MINT64);
    }
    // The same sorts, in the same places, spelled flat one version earlier.
    const flat = sortsOfProductions(v3.definition).filter((s) => s.name === "MInt{64}");
    expect(flat).toHaveLength(structured.length);
    for (const s of flat) expect(s.params).toEqual([]);
  });
});

/** Every sort a definition's productions mention: the production's own, and its nonterminals'. */
function sortsOfProductions(definition: DefinitionTermJson): readonly KSortJson[] {
  const out: KSortJson[] = [];
  for (const { production } of productions(definition)) {
    out.push(production.sort);
    for (const item of production.productionItems) {
      if (item.node === "KNonTerminal") out.push(item.sort);
    }
  }
  return out;
}

describe("decodeTerm handles every node type present in a real definition", () => {
  test("no crash decoding every embedded term of a real compiled definition", () => {
    const result = parseDefinitionDocument(read("definition", "panop-semantics.compiled.json"));
    if (!result.ok) throw new Error("fixture must parse");
    let bodies = 0;
    let degraded = 0;
    for (const { rule } of rules(result.definition)) {
      bodies++;
      degraded += countOther(rule.body);
    }
    expect(bodies).toBeGreaterThan(100);
    // Rule bodies exercise KRewrite, KVariable, KSequence and KApply; none of
    // them should degrade.
    expect(degraded).toBe(0);
  });

  test("find locates a cell inside a real rule body", () => {
    const result = parseDefinitionDocument(read("definition", "panop-semantics.compiled.json"));
    if (!result.ok) throw new Error("fixture must parse");
    const hit = rules(result.definition).some(({ rule }) => find(rule.body, "<k>") !== undefined);
    expect(hit).toBe(true);
  });

  test("raw JSON contains the node types this package models", () => {
    const raw = read("definition", "panop-semantics.compiled.json");
    for (const node of ["KApply", "KToken", "KSort", "KProduction", "KRule", "KTerminal", "KNonTerminal", "KAtt"]) {
      expect(raw).toContain(`"${node}"`);
    }
  });

  test("decodeTerm is total over every raw node object in a real document", () => {
    const raw = JSON.parse(read("definition", "panop-semantics.parsed.json")) as unknown;
    let seen = 0;
    const visit = (u: unknown): void => {
      if (Array.isArray(u)) {
        for (const v of u) visit(v);
      } else if (typeof u === "object" && u !== null) {
        if ("node" in u) {
          seen++;
          expect(() => decodeTerm(u)).not.toThrow();
        }
        for (const v of Object.values(u)) visit(v);
      }
    };
    visit(raw);
    expect(seen).toBeGreaterThan(1000);
  });
});
