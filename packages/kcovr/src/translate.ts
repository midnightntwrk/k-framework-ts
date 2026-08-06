/**
 * Cross-build remapping — `translate_coverage` (`coverage.py:46-105`) and
 * `translate_coverage_from_paths` (`:108-133`), transcribed.
 *
 * A hit log names rules by `UNIQUE_ID`, which is SHA3-256 of the *normalized
 * sentence* (`NumberSentences.java:26-54`).  Recompile after moving the
 * semantics to another directory and every id changes, because the id covers
 * the rule's source attribute; the rules themselves did not move a line.
 * Translation is the bridge: it maps each src id to where the src build says
 * that rule lives, matches that location against the dst build, and returns the
 * dst id.
 *
 * ```
 * src UNIQUE_ID ──allRules.txt──▶ /old/path/sem.k:42:7
 *                                      │ basename
 *                                      ▼
 *                                 sem.k:42:7 ──allRules.txt⁻¹──▶ dst UNIQUE_ID
 * ```
 *
 * ## Basename matching collides, and that is the behaviour
 *
 * The key is deliberately **not** the full path — that is the whole point, since
 * the path is what changed — so `a/sem.k:42:7` and `b/sem.k:42:7` are the same
 * key.  Two same-named files with a rule at the same line *and* column translate
 * to whichever of them `allRules.txt` lists last, and `allRules.txt` order is a
 * scala `Set`'s (`Kompile.java:365,378`), i.e. arbitrary.  This is upstream's
 * behaviour (`coverage.py:67,74`) and it is kept, because narrowing the key to
 * the full path would make the function do nothing and widening it to the
 * basename alone would make it worse.  What callers need to know:
 *
 * - **collisions are common within one file, not only across files.**  Rules
 *   that K generates from one production — heating/cooling pairs, for instance —
 *   share their source rule's `line:col` exactly.  In
 *   `fixtures/cov-build/allRules.txt`, a real build, **168 rules occupy 125
 *   distinct `basename:line:col` keys**: 21 keys are claimed by more than one
 *   rule.  Translating that build against *itself* is therefore not the
 *   identity — 13 of its 39 `<generatedTop>`-rooted hits come back as a
 *   different rule at the same location (`test/translate.test.ts` pins both
 *   halves).  Plan §5 expected self-translation to be an identity; on real
 *   input it is an identity only on the keys that are unique.
 * - **the count is preserved but the multiset is not.**  One src hit in, at most
 *   one dst hit out, in order, duplicates and all — but two hits on colliding
 *   keys can come back as the same id.
 *
 * ## Deliberate deviations
 *
 * 1. **No fifth `allRules.txt` parser** (plan §2, §4 deviations).  Both sides go
 *    through `@kframework-ts/kompiled`'s `parseAllRules`, which splits the id at
 *    the *first* space and the location from the *right*.  pyk does
 *    `line.split(' ')` and takes `[1]` (`:66,73`), which raises
 *    `ValueError: too many values to unpack` on any path containing a space —
 *    `/nix/store` paths do not, but `~/My Semantics/` does, and one is checked
 *    into this package's fixtures for exactly this test.  Fixing it is free: the
 *    correct parser was already written next door.
 * 2. **The `<generatedTop>` filter reuses `KDefinition.semanticRules`.**
 *    `coverage.py:80-89` inlines the test — body is `KApply('<generatedTop>')`,
 *    or a `KRewrite` whose left-hand side is — which is character-for-character
 *    `is_semantic` (`outer.py:1176-1182`), transcribed in `@kframework-ts/kast`
 *    as `KDefinition.semanticRules`.  Same sentences, same order, memoised on
 *    the definition.
 * 3. **The dst-id filter is a `Set`.**  pyk builds a `list` and asks `in` for
 *    every hit (`:102`), which is O(rules) per hit and turns a large corpus into
 *    a quadratic wait.  Same answers.
 * 4. **The two failures are named errors** whose first line is pyk's
 *    `ValueError` wording verbatim — see `errors.ts`.
 *
 * ## What translation deliberately drops
 *
 * Rules that are not `<generatedTop>`-rooted — functions, simplifications,
 * anything whose body is not a whole configuration — are **excluded from the
 * output** (`:102-103`), silently and by design: the caller of this function
 * wants the rewrite steps the program took, and a function rule is not a step.
 * Note that the filter is applied to the **destination** id, not the source one,
 * so a src hit on a function rule is kept if its location resolves to a
 * `<generatedTop>` rule in the dst build.  That is upstream's order of
 * operations and it is preserved.
 */

import type { KDefinition } from "@kframework-ts/kast";
import { Atts } from "@kframework-ts/kast";
import { parseAllRules } from "@kframework-ts/kompiled/core";

import type { CoverageDefinition } from "./cobertura.js";
import { UnknownSourceRuleError, UnknownTargetLocationError } from "./errors.js";
import type { RuleId } from "./hits.js";

/**
 * A rule's location with its directory removed — `sem.k:42:7`.
 *
 * The third string-keyed space in this package, and the only one that is not an
 * identity: `RuleId` names a rule, `LocationKey` (`koreExecLog.ts`) names a
 * source *range*, and this names a **position**, which several rules can share.
 */
export type BasenameLocation = string;

/**
 * `src_rule_loc.split('/')[-1]` (`coverage.py:67,74`).
 *
 * Applied to the whole `file:line:col` string, so the result keeps the line and
 * column: `"/a/b/sem.k:42:7"` → `"sem.k:42:7"`.  A location with no `/` in it is
 * already a key.
 *
 * Windows separators are not handled, and neither does upstream handle them;
 * K writes POSIX paths in `allRules.txt` even on Windows (`Kompile.java:376`
 * formats `source.source()`, which is what the frontend read).
 */
export function basenameLocation(location: string): BasenameLocation {
  return location.slice(location.lastIndexOf("/") + 1);
}

/**
 * `src_rule_map` (`coverage.py:64-68`): `UNIQUE_ID` → `basename:line:col`.
 *
 * Unlike `cobertura.ts`' `createRuleMap` this keeps entries whose location did
 * not parse — `parseAllRules` reports those with `NaN` line and column but an
 * intact `location` string, and pyk, which never parses the location at all,
 * would map them too.  A rule whose location is unparseable cannot be placed in
 * a Cobertura document, but it can still be *renamed*, which is all this does.
 */
export function sourceLocationMap(allRulesTxt: string): ReadonlyMap<RuleId, BasenameLocation> {
  const map = new Map<RuleId, BasenameLocation>();
  for (const [ruleId, location] of parseAllRules(allRulesTxt).allRules) {
    map.set(ruleId, basenameLocation(location.location));
  }
  return map;
}

/**
 * `dst_rule_map` (`coverage.py:71-75`): `basename:line:col` → `UNIQUE_ID`, the
 * inverse of {@link sourceLocationMap}.
 *
 * **Last entry wins** on a collision, as a Python dict's does, so the winner
 * follows `allRules.txt` line order — which is arbitrary (plan §4 item 11).  See
 * the module header: this is the one place in the package where an arbitrary
 * order is load-bearing, and it is upstream's.
 */
export function targetIdMap(allRulesTxt: string): ReadonlyMap<BasenameLocation, RuleId> {
  const map = new Map<BasenameLocation, RuleId>();
  for (const [ruleId, location] of parseAllRules(allRulesTxt).allRules) {
    map.set(basenameLocation(location.location), ruleId);
  }
  return map;
}

/**
 * The `UNIQUE_ID`s of the destination definition's `<generatedTop>`-rooted
 * rules — `dst_non_function_rules` (`coverage.py:80-89`).
 *
 * A rule with no `UNIQUE_ID` attribute contributes nothing (`:88`), which is
 * right: it can never be the value of a `dst_rule_map` entry either, since
 * `allRules.txt` only lists rules that have one (`Kompile.java:371`).
 */
export function semanticRuleIds(definition: KDefinition): ReadonlySet<RuleId> {
  const ids = new Set<RuleId>();
  for (const rule of definition.semanticRules) {
    const uniqueId = rule.att.get(Atts.UNIQUE_ID);
    if (typeof uniqueId === "string") ids.add(uniqueId);
  }
  return ids;
}

/**
 * Translate a hit list from one build's rule ids onto another's —
 * `translate_coverage` (`coverage.py:46-105`).
 *
 * ```ts
 * const dstHits = translateCoverage(srcAllRulesTxt, dstAllRulesTxt, dstDefinition, srcHitLog.split("\n"));
 * ```
 *
 * `srcHits` is the hit **log**, not a set: entries are processed in order,
 * duplicates included, and the result has one entry per surviving input hit —
 * so counting it with `createCoverMap` gives the destination's application
 * counts.  Blank entries are skipped (pyk strips each line, `:77`, and would
 * then fail to find `''` in `src_rule_map`; a trailing newline is not a corrupt
 * log).
 *
 * @param srcAllRulesTxt the source build's `allRules.txt`, whole.
 * @param dstAllRulesTxt the destination build's `allRules.txt`, whole.
 * @param dstDefinition the destination build's `compiled.json`, parsed.
 * @param srcHits rule ids as logged by the source build.
 * @throws {UnknownSourceRuleError} a hit is not in the source `allRules.txt`.
 * @throws {UnknownTargetLocationError} a source rule's location is not in the
 *   destination `allRules.txt`.
 */
export function translateCoverage(
  srcAllRulesTxt: string,
  dstAllRulesTxt: string,
  dstDefinition: KDefinition,
  srcHits: Iterable<string>,
): RuleId[] {
  const srcRuleMap = sourceLocationMap(srcAllRulesTxt);
  const dstRuleMap = targetIdMap(dstAllRulesTxt);
  const dstSemanticRules = semanticRuleIds(dstDefinition);

  const translated: RuleId[] = [];
  for (const rawHit of srcHits) {
    const srcRule = rawHit.trim();
    if (srcRule === "") continue;

    const srcRuleLoc = srcRuleMap.get(srcRule);
    if (srcRuleLoc === undefined) throw new UnknownSourceRuleError(srcRule);

    const dstRule = dstRuleMap.get(srcRuleLoc);
    if (dstRule === undefined) throw new UnknownTargetLocationError(srcRuleLoc, srcRule);

    // `:102` — the filter is on the *destination* id.  See the module header.
    if (dstSemanticRules.has(dstRule)) translated.push(dstRule);
  }
  return translated;
}

/**
 * {@link translateCoverage} over two {@link CoverageDefinition}s — the fs-free
 * analogue of `translate_coverage_from_paths` (`coverage.py:108-133`).
 *
 * The source definition supplies both halves of its side: its `allRulesTxt` and
 * its `coverageLogs`, which are concatenated in the order they were read
 * (`fs.ts` reads `coverage.txt` first, then each `*_coverage.txt` sorted by
 * name).  The destination supplies only `allRulesTxt`; its `compiled.json` is a
 * separate argument because a `CoverageDefinition` is text and a `KDefinition`
 * is not.
 *
 * The path-taking variant lives in `fs.ts`, which is the only module here
 * allowed to open a file.
 */
export function translateCoverageFromDefinitions(
  src: CoverageDefinition,
  dst: CoverageDefinition,
  dstDefinition: KDefinition,
): RuleId[] {
  const hits = src.coverageLogs.flatMap((text) => text.split("\n"));
  return translateCoverage(src.allRulesTxt, dst.allRulesTxt, dstDefinition, hits);
}
