/**
 * `translateCoverage` — `coverage.py:46-105`.
 *
 * Two fixture sets, two different jobs:
 *
 * - **`synthetic/allrules-{src,dst}.txt`**, a rename-only pair, drives the
 *   mapping itself — including the two paths pyk's own parser cannot read (one
 *   with a space, one with colons), which is the deviation plan §4 records.
 * - **`cov-build/` translated against itself** drives the part no synthetic
 *   fixture can honestly model: on a real build the `basename:line:col` key is
 *   *not* unique, so self-translation is not the identity.  Both halves of that
 *   are pinned below.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  Atts,
  attEntry,
  KAtt,
  kapply,
  kflatmodule,
  krewrite,
  krule,
  ktoken,
  KDefinition,
  readKastDefinitionFromJson,
  type KRule,
} from "@kframework-ts/kast";

import { UnknownSourceRuleError, UnknownTargetLocationError } from "../src/errors.ts";
import {
  basenameLocation,
  semanticRuleIds,
  sourceLocationMap,
  targetIdMap,
  translateCoverage,
  translateCoverageFromDefinitions,
} from "../src/translate.ts";

const FIXTURES = join(import.meta.dir, "..", "fixtures");
const read = (rel: string): string => readFileSync(join(FIXTURES, rel), "utf8");
const lines = (text: string): string[] => text.split("\n").filter((line) => line !== "");

const SRC_ALL_RULES = read("synthetic/allrules-src.txt");
const DST_ALL_RULES = read("synthetic/allrules-dst.txt");

/** The ids of the synthetic pair, by the line they sit on — no hash is typed out. */
const srcId = (line: number): string => lines(SRC_ALL_RULES)[line]?.slice(0, 64) ?? "";
const dstId = (line: number): string => lines(DST_ALL_RULES)[line]?.slice(0, 64) ?? "";

const ALPHA = 0;
const SPACES = 1;
const COLONS = 2;
const NESTED_ALPHA = 3;
const BETA = 4;

/** A rule carrying `id`, either `<generatedTop>`-rooted or a function rule. */
const ruleWithId = (id: string, semantic: boolean): KRule =>
  krule(
    semantic
      ? krewrite(kapply("<generatedTop>", [ktoken("0", "Int")]), kapply("<generatedTop>", [ktoken("1", "Int")]))
      : krewrite(kapply("isFoo", [ktoken("0", "Int")]), ktoken("true", "Bool")),
    { att: new KAtt([attEntry(Atts.UNIQUE_ID, id)]) },
  );

/**
 * A definition in which the named ids are `<generatedTop>`-rooted rules and the
 * rest are function rules — the two populations `coverage.py:80-89` splits.
 */
function definitionWith(semanticIds: readonly string[], functionIds: readonly string[] = []): KDefinition {
  const sentences = [
    ...semanticIds.map((id) => ruleWithId(id, true)),
    ...functionIds.map((id) => ruleWithId(id, false)),
  ];
  return new KDefinition("SYN", [kflatmodule("SYN", { sentences })]);
}

/** Every dst id is a semantic rule — the plain rename case. */
const ALL_SEMANTIC = definitionWith([0, 1, 2, 3, 4].map((line) => dstId(line)));

describe("the rename-only synthetic pair", () => {
  test("maps each src id to the dst id at the same basename:line:col", () => {
    const hits = [ALPHA, SPACES, COLONS, NESTED_ALPHA, BETA].map((line) => srcId(line));
    const translated = translateCoverage(SRC_ALL_RULES, DST_ALL_RULES, ALL_SEMANTIC, hits);
    expect(translated).toEqual([ALPHA, SPACES, COLONS, NESTED_ALPHA, BETA].map((line) => dstId(line)));
  });

  test("a path with spaces survives — pyk's own parser crashes on this line", () => {
    // `src_rule_hash, src_rule_loc = line.split(' ')` (`coverage.py:66`) raises
    // `ValueError: too many values to unpack` on `… /fix/syn/v1/path with spaces.k:20:3`.
    // Routing through kompiled's `parseAllRules` is the fix (plan §4 deviations).
    expect(sourceLocationMap(SRC_ALL_RULES).get(srcId(SPACES))).toBe("path with spaces.k:20:3");
    expect(translateCoverage(SRC_ALL_RULES, DST_ALL_RULES, ALL_SEMANTIC, [srcId(SPACES)])).toEqual([dstId(SPACES)]);
  });

  test("a path with colons survives — the location is split from the right", () => {
    expect(sourceLocationMap(SRC_ALL_RULES).get(srcId(COLONS))).toBe("path:with:colons.k:30:7");
    expect(translateCoverage(SRC_ALL_RULES, DST_ALL_RULES, ALL_SEMANTIC, [srcId(COLONS)])).toEqual([dstId(COLONS)]);
  });

  test("the directory is dropped but the line and column are kept", () => {
    expect(basenameLocation("/fix/syn/v1/nested/alpha.k:40:9")).toBe("alpha.k:40:9");
    expect(basenameLocation("alpha.k:40:9")).toBe("alpha.k:40:9");
    // `alpha.k` appears twice in the pair, at different lines — so the two do
    // not collide, and translation keeps them apart.
    expect(targetIdMap(DST_ALL_RULES).get("alpha.k:10:5")).toBe(dstId(ALPHA));
    expect(targetIdMap(DST_ALL_RULES).get("alpha.k:40:9")).toBe(dstId(NESTED_ALPHA));
  });

  test("a hit log is a log: order and duplicates are preserved", () => {
    const hits = [srcId(BETA), srcId(ALPHA), srcId(BETA)];
    expect(translateCoverage(SRC_ALL_RULES, DST_ALL_RULES, ALL_SEMANTIC, hits)).toEqual([
      dstId(BETA),
      dstId(ALPHA),
      dstId(BETA),
    ]);
  });

  test("blank entries are skipped, so a trailing newline is not a hit", () => {
    expect(translateCoverage(SRC_ALL_RULES, DST_ALL_RULES, ALL_SEMANTIC, ["", `  ${srcId(ALPHA)}  `, ""])).toEqual([
      dstId(ALPHA),
    ]);
  });
});

describe("the <generatedTop> filter", () => {
  test("a function rule in the destination is dropped from the output", () => {
    // `:80-89` keeps only rules whose body is `<generatedTop>(…)` or a rewrite
    // rooted at one; `:102` then filters the *destination* ids by that set.
    const definition = definitionWith([dstId(ALPHA), dstId(BETA)], [dstId(SPACES)]);
    expect(semanticRuleIds(definition)).toEqual(new Set([dstId(ALPHA), dstId(BETA)]));

    const hits = [srcId(ALPHA), srcId(SPACES), srcId(BETA)];
    expect(translateCoverage(SRC_ALL_RULES, DST_ALL_RULES, definition, hits)).toEqual([dstId(ALPHA), dstId(BETA)]);
  });

  test("a rule with no UNIQUE_ID contributes nothing to the filter set", () => {
    const anonymous = krule(kapply("<generatedTop>"));
    const definition = new KDefinition("SYN", [kflatmodule("SYN", { sentences: [anonymous] })]);
    expect(semanticRuleIds(definition).size).toBe(0);
  });

  test("both spellings of a semantic rule count — bare application and rewrite", () => {
    const bare = krule(kapply("<generatedTop>", [ktoken("0", "Int")]), {
      att: new KAtt([attEntry(Atts.UNIQUE_ID, dstId(ALPHA))]),
    });
    const definition = new KDefinition("SYN", [kflatmodule("SYN", { sentences: [bare] })]);
    expect(translateCoverage(SRC_ALL_RULES, DST_ALL_RULES, definition, [srcId(ALPHA)])).toEqual([dstId(ALPHA)]);
  });
});

/** The first line of whatever `run` throws — where pyk's own wording lives. */
const firstLine = (run: () => unknown): string => {
  try {
    run();
  } catch (error) {
    return (error instanceof Error ? error.message : String(error)).split("\n")[0] ?? "";
  }
  return "";
};

describe("failures keep pyk's wording", () => {
  test("a hit the source build does not know", () => {
    const unknown = "9".repeat(64);
    expect(() => translateCoverage(SRC_ALL_RULES, DST_ALL_RULES, ALL_SEMANTIC, [unknown])).toThrow(
      UnknownSourceRuleError,
    );
    // `coverage.py:95`, verbatim.
    expect(firstLine(() => translateCoverage(SRC_ALL_RULES, DST_ALL_RULES, ALL_SEMANTIC, [unknown]))).toBe(
      `Could not find rule in src_rule_map: ${unknown}`,
    );
  });

  test("a location the destination build does not have", () => {
    // A dst allRules.txt missing the `beta.md` line: the rule moved or was deleted.
    const trimmedDst = lines(DST_ALL_RULES).slice(0, 4).join("\n");
    expect(() => translateCoverage(SRC_ALL_RULES, trimmedDst, ALL_SEMANTIC, [srcId(BETA)])).toThrow(
      UnknownTargetLocationError,
    );
    // `coverage.py:99`, verbatim.
    expect(firstLine(() => translateCoverage(SRC_ALL_RULES, trimmedDst, ALL_SEMANTIC, [srcId(BETA)]))).toBe(
      "Could not find rule location in dst_rule_map: beta.md:50:11",
    );
  });
});

describe("translateCoverageFromDefinitions", () => {
  test("takes the source hits from the source definition's own logs", () => {
    const src = { name: "src", allRulesTxt: SRC_ALL_RULES, coverageLogs: [`${srcId(ALPHA)}\n`, `${srcId(BETA)}\n`] };
    const dst = { name: "dst", allRulesTxt: DST_ALL_RULES, coverageLogs: [] };
    expect(translateCoverageFromDefinitions(src, dst, ALL_SEMANTIC)).toEqual([dstId(ALPHA), dstId(BETA)]);
  });
});

describe("self-translation on the real cov-build fixture", () => {
  const ALL = read("cov-build/allRules.txt");
  const DEFINITION = readKastDefinitionFromJson(read("compiled/compiled.json"));
  const HITS = ["small", "mid", "large"].flatMap((name) => lines(read(`cov-build/pid-${name}_coverage.txt`)));

  const srcMap = sourceLocationMap(ALL);
  const dstMap = targetIdMap(ALL);
  const semantic = semanticRuleIds(DEFINITION);

  test("the key is not unique on a real build: 168 rules, 125 keys", () => {
    // Rules K generates from one production — heating/cooling pairs — share
    // their source rule's line and column exactly.
    expect(srcMap.size).toBe(168);
    expect(dstMap.size).toBe(125);
  });

  test("every <generatedTop> hit at a unique location maps to itself", () => {
    const keyCount = new Map<string, number>();
    for (const key of srcMap.values()) keyCount.set(key, (keyCount.get(key) ?? 0) + 1);

    const unique = [...new Set(HITS)].filter((id) => semantic.has(id) && keyCount.get(srcMap.get(id) ?? "") === 1);
    // 19 of the 39 `<generatedTop>` rules that fired are alone at their
    // location.  For these — and only for these — self-translation is
    // guaranteed to be the identity rather than accidentally being it.
    expect(unique).toHaveLength(19);
    for (const id of unique) {
      expect(translateCoverage(ALL, ALL, DEFINITION, [id])).toEqual([id]);
    }
  });

  test("…while 13 of the 39 come back as a different rule at the same location", () => {
    // Plan §5 expected self-translation to be an identity on `<generatedTop>`
    // rules.  It is not, and cannot be: `basename:line:col` is not a rule
    // identity, so the dst map keeps whichever rule `allRules.txt` lists last
    // (`coverage.py:74`, a Python dict).  This is upstream's behaviour, and the
    // reason `translate.ts`' header documents the collision rather than
    // pretending the key is unique.
    const semanticHits = [...new Set(HITS)].filter((id) => semantic.has(id));
    expect(semanticHits).toHaveLength(39);

    // 26 map to themselves — the 19 alone at their location, plus 7 that happen
    // to be the last entry at a shared one — and 13 do not.
    const moved = semanticHits.filter((id) => dstMap.get(srcMap.get(id) ?? "") !== id);
    expect(semanticHits.length - moved.length).toBe(26);
    expect(moved).toHaveLength(13);
    for (const id of moved) {
      const translated = translateCoverage(ALL, ALL, DEFINITION, [id]);
      expect(translated).toEqual([dstMap.get(srcMap.get(id) ?? "") ?? ""]);
      expect(translated).not.toEqual([id]);
    }
  });

  test("one hit rule is not <generatedTop>-rooted and is dropped", () => {
    expect(new Set(HITS).size).toBe(40);
    const translated = translateCoverage(ALL, ALL, DEFINITION, HITS);
    // 486 applications in, 472 out: the 14 dropped are the applications whose
    // destination rule is a function rule.
    expect(HITS).toHaveLength(486);
    expect(translated).toHaveLength(472);
    // 39 distinct rules in, 27 out: the collisions merge.
    expect(new Set(translated).size).toBe(27);
  });
});
