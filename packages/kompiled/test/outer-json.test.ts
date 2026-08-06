/**
 * `fixtures/upstream/imp-outer-json/imp.json` — the only committed `KDefinition`
 * anywhere in this monorepo whose modules have **non-empty `localSentences`**.
 *
 * `packages/kast/fixtures/PROVENANCE.md:217-222` admits the gap in as many
 * words: the six `parse-outer/*.expected.json` goldens come from pyk's
 * `_ast_to_kast.py`, which cannot convert sentences, so *every module in all six
 * has an empty `localSentences`*.  They pin `KDefinition`, `KFlatModule`,
 * `KImport` and the `Location` codec, and nothing else; sentence fidelity is
 * pinned differentially instead, one node at a time, against values generated
 * from pyk.
 *
 * This file is the missing whole-definition case, and it is why the fixture was
 * vendored here rather than only at `packages/kast-json` (where the same bytes
 * live under `fixtures/upstream/v4/k-dist-imp.outer-parsed.json`, sha256
 * `214137f0…`, for the v4 *sort* shape).  It is `kompile --outer-parsed-json`
 * output for `k-distribution`'s own IMP — written by `Kompile.java:231-238` from
 * the same `ToJson.apply` that writes `compiled.json` — and it carries node
 * types nothing else here has in bulk: 218 `KBubble`, 64 `KSyntaxAssociativity`,
 * 20 `KRegexTerminal`, 802 sentences across 68 of its 89 modules.
 *
 * # The round trip is not the identity, and that is the finding
 *
 * `packages/kast/test/outer.test.ts` asserts its six goldens round-trip to
 * canonical-JSON identity.  This one does **not**, and the reason is entirely
 * upstream: pyk's readers are lossy in three places that the `parse-outer`
 * goldens are too thin to reach.  All three are asserted individually below, so
 * that "lossy, exactly here, because pyk is" cannot be confused with a bug in
 * this monorepo:
 *
 * | delta                                  | count | pyk                                              |
 * | -------------------------------------- | ----: | ------------------------------------------------ |
 * | `KRegexTerminal.precedeRegex` dropped  |    20 | `outer.py:76-92` — the class has only `regex`     |
 * | `KRegexTerminal.followRegex` dropped   |    20 | same                                              |
 * | `colors` whitespace squeezed           |     1 | `ColorsType.parse` strips spaces (`att.py:256-260`) |
 * | `requires: []` added                   |     1 | `KDefinition.to_dict` always emits it (`outer.py:1055-1062`) |
 *
 * Those 42 differences are the whole of it, and the test below proves the *whole
 * of it*: normalising exactly them makes the comparison canonical-JSON exact.
 * A forty-third would fail.
 *
 * The reader used is `readKastDefinition` — the same entry point
 * `KompiledDefinition.definition` uses — because `--outer-parsed-json` writes a
 * `parsed.json` into the kompiled directory in exactly this shape, and the only
 * reason this package does not list that artifact is that it is
 * *pre-compilation* (see `KompiledArtifact`), not that it could not be read.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { canonicalJson, KDefinition, readKastDefinition, type JsonValue } from "@kframework-ts/kast";

import { KAST_VERSION } from "../src/version.ts";
import { UPSTREAM } from "./fixtures.ts";

const PATH = join(UPSTREAM, "imp-outer-json", "imp.json");

interface Envelope {
  readonly format: string;
  readonly version: number;
  readonly term: JsonValue;
}

const readEnvelope = (): Envelope => {
  // `JSON.parse` returns `any`; the shape is checked by the assertions below.
  const parsed = JSON.parse(readFileSync(PATH, "utf8")) as unknown;
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  return parsed as Envelope;
};

/** A plain JSON object, which is all these helpers ever walk into. */
type Dict = Record<string, JsonValue>;

const isDict = (value: JsonValue): value is Dict =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** `Array.isArray` widens to `any[]`; this keeps the element type. */
const isArray = (value: JsonValue): value is JsonValue[] => Array.isArray(value);

/** Every `node` tag in a KAST document, counted. */
function countNodes(value: JsonValue): Map<string, number> {
  const counts = new Map<string, number>();
  const stack: JsonValue[] = [value];
  while (stack.length > 0) {
    const top = stack.pop();
    // `pop` on a non-empty array; the guard is for `noUncheckedIndexedAccess`.
    if (top === undefined) continue;
    if (isArray(top)) {
      stack.push(...top);
      continue;
    }
    if (!isDict(top)) continue;
    const node = top["node"];
    if (typeof node === "string") counts.set(node, (counts.get(node) ?? 0) + 1);
    stack.push(...Object.values(top));
  }
  return counts;
}

/** Every value a given key takes in a document, in traversal order. */
function collect(value: JsonValue, key: string): JsonValue[] {
  const found: JsonValue[] = [];
  const stack: JsonValue[] = [value];
  while (stack.length > 0) {
    const top = stack.pop();
    if (top === undefined) continue;
    if (isArray(top)) {
      stack.push(...top);
      continue;
    }
    if (!isDict(top)) continue;
    const here = top[key];
    if (here !== undefined) found.push(here);
    stack.push(...Object.values(top));
  }
  return found;
}

/**
 * The golden, with pyk's three known losses applied — and nothing else.
 *
 * Deliberately written as three surgical edits rather than as a general
 * "compare loosely": if a fourth loss ever appears, this function will not hide
 * it, it will make the comparison fail.
 */
function applyPykLosses(term: JsonValue): JsonValue {
  if (isArray(term)) return term.map(applyPykLosses);
  if (!isDict(term)) return term;

  if (term["node"] === "KRegexTerminal") {
    // `KRegexTerminal._from_dict` reads `regex` and nothing else.
    return { node: "KRegexTerminal", regex: term["regex"] ?? null };
  }

  const out: Dict = {};
  for (const [key, value] of Object.entries(term)) {
    out[key] = key === "colors" && typeof value === "string" ? value.replaceAll(" ", "") : applyPykLosses(value);
  }
  // `KDefinition.to_dict` emits `requires` unconditionally; `ToJson.java` omits
  // it when empty.
  if (term["node"] === "KDefinition" && !("requires" in term)) out["requires"] = [];
  return out;
}

describe("the outer-parsed IMP definition", () => {
  test("it is a KAST v4 envelope, the version this package accepts", () => {
    const envelope = readEnvelope();
    expect(envelope.format).toBe("KAST");
    expect(envelope.version).toBe(KAST_VERSION);
  });

  test("it round-trips to canonical-JSON identity modulo pyk's three losses", () => {
    const envelope = readEnvelope();
    const definition = readKastDefinition(envelope);
    expect(canonicalJson(definition.toDict())).toBe(canonicalJson(applyPykLosses(envelope.term)));
  });

  test("the bare-term form reads the same definition as the envelope form", () => {
    // `parse-outer`'s goldens are bare terms; this one is enveloped.  Both
    // readers must land on the same definition, which `KAst.hash` decides.
    const envelope = readEnvelope();
    expect(KDefinition.fromDict(envelope.term).hash).toBe(readKastDefinition(envelope).hash);
  });

  test("its modules really do have local sentences — the gap this fixture closes", () => {
    const definition = readKastDefinition(readEnvelope());
    expect(definition.allModules.length).toBe(89);
    const withSentences = definition.allModules.filter((module) => module.sentences.length > 0);
    expect(withSentences.length).toBe(68);
    expect(definition.allModules.reduce((n, module) => n + module.sentences.length, 0)).toBe(802);
  });

  test("the node types nothing else in this monorepo covers in bulk", () => {
    // `fixtures/PROVENANCE.md:240` claims these three counts as the reason the
    // fixture is vendored twice.  Pinned here so the claim cannot rot.
    const counts = countNodes(readEnvelope().term);
    expect(counts.get("KBubble")).toBe(218);
    expect(counts.get("KSyntaxAssociativity")).toBe(64);
    expect(counts.get("KRegexTerminal")).toBe(20);
    // The rest of the census, so a fixture swap is loud rather than quiet.
    expect(counts.get("KDefinition")).toBe(1);
    expect(counts.get("KFlatModule")).toBe(89);
    expect(counts.get("KImport")).toBe(181);
    expect(counts.get("KProduction")).toBe(485);
    expect(counts.get("KSyntaxPriority")).toBe(14);
    expect(counts.get("KSyntaxSort")).toBe(21);
    // Outer-parsed, so no rule has been converted yet: every one is a bubble.
    expect(counts.get("KRule")).toBeUndefined();
    expect(counts.get("KClaim")).toBeUndefined();
  });

  test("re-serialising preserves every node type and count", () => {
    // Implied by the round trip above, but asserted separately because a
    // *partial* re-serialisation — a sentence kind silently dropped on the way
    // out — is the failure this makes legible.
    const definition = readKastDefinition(readEnvelope());
    expect(Object.fromEntries(countNodes(definition.toDict()))).toEqual(
      Object.fromEntries(countNodes(readEnvelope().term)),
    );
  });
});

describe("pyk's three losses, each pinned", () => {
  test("precedeRegex and followRegex are dropped — all 20 of each", () => {
    // `KRegexTerminal` in pyk carries only `regex` (`outer.py:76-92`), so these
    // two v4 fields are read and discarded.  `ToJson.java` writes them; K's own
    // round-trip does not go through pyk, which is why nothing upstream notices.
    const golden = readEnvelope().term;
    expect(collect(golden, "precedeRegex").length).toBe(20);
    expect(collect(golden, "followRegex").length).toBe(20);

    const roundTripped = readKastDefinition(readEnvelope()).toDict();
    expect(collect(roundTripped, "precedeRegex")).toEqual([]);
    expect(collect(roundTripped, "followRegex")).toEqual([]);
    // The regexes themselves survive, all 20.
    expect(collect(roundTripped, "regex").length).toBe(20);
  });

  test("the one spaced `colors` value comes back squeezed", () => {
    // `ColorsType.parse` does `text.replace(' ', '').split(',')` and
    // `unparse` joins with `','` (`att.py:256-260`) — a normalisation, not a
    // loss of information, but a byte difference all the same.  IMP-SYNTAX has
    // three `colors` attributes and exactly one is written with spaces.
    const golden = collect(readEnvelope().term, "colors");
    expect(golden).toContain("yellow, white, white, yellow");
    const roundTripped = collect(readKastDefinition(readEnvelope()).toDict(), "colors");
    expect(roundTripped).toContain("yellow,white,white,yellow");
    expect(roundTripped).not.toContain("yellow, white, white, yellow");
    // The other two were already space-free and are untouched.
    expect(roundTripped.filter((c) => c === "yellow,white,white").length).toBe(1);
    expect(roundTripped.filter((c) => c === "yellow,pink").length).toBe(1);
  });

  test("`requires` is absent in the golden and present-and-empty on the way out", () => {
    // `KDefinition.to_dict` (`outer.py:1055-1062`) emits `requires`
    // unconditionally; `--outer-parsed-json` flattens the requires away, so
    // there are none to emit and the key appears as `[]`.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion
    const golden = readEnvelope().term as Dict;
    expect("requires" in golden).toBe(false);
    const roundTripped = readKastDefinition(readEnvelope()).toDict();
    expect(roundTripped["requires"]).toEqual([]);
  });
});
