/**
 * `getRuleById` and `stripCoverageLogger` — `coverage.py:16-43`.
 *
 * The interesting half is `stripCoverageLogger`, and the reason is
 * `fixtures/compiled/compiled.json`: a real `kompile --coverage` build whose
 * 168 rules all carry the **current** instrumentation shape, which pyk's
 * implementation does not match.  Both shapes are exercised — the current one
 * against those 168 real rules, pyk's obsolete one against a hand-built sample,
 * since no artifact in existence still has it.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  Atts,
  attEntry,
  KAtt,
  kapply,
  kclaim,
  kflatmodule,
  krewrite,
  krule,
  ksequence,
  ktoken,
  KDefinition,
  minimizeRuleLike,
  PrettyPrinter,
  readKastDefinitionFromJson,
  removeSourceMap,
  type KInner,
  type KRule,
} from "@kframework-ts/kast";

import { RuleNotFoundError } from "../src/errors.ts";
import { getRuleById, stripCoverageLogger } from "../src/rules.ts";

const FIXTURES = join(import.meta.dir, "..", "fixtures");
const DEFINITION = readKastDefinitionFromJson(readFileSync(join(FIXTURES, "compiled", "compiled.json"), "utf8"));

/** The single id in `fixtures/cov-build/pid-small_coverage.txt`. */
const SMALL_LOG_ID = "e97963c721316ecf1c6cd3355538847ef9ebbbe480cf77efe892e8508c7031fd";

/** A rule with `id` as its `UNIQUE_ID` and `body` as its body. */
const withId = (id: string, body: KInner): KRule => krule(body, { att: new KAtt([attEntry(Atts.UNIQUE_ID, id)]) });

describe("getRuleById", () => {
  test("finds a rule by the id a hit log names it with", () => {
    const rule = getRuleById(DEFINITION, SMALL_LOG_ID);
    expect(rule.node).toBe("KRule");
    expect(rule.att.get(Atts.UNIQUE_ID)).toBe(SMALL_LOG_ID);
    expect(rule.att.get(Atts.LABEL)).toBe("PANOPTICON-SEMANTICS.outcome-returned");
  });

  test("finds every id allRules.txt names — the closure, not just the main module", () => {
    // `KDefinition.modules` is the transitive import closure, and 46 of these
    // rules live in modules a shallower walk would miss (fixtures/PROVENANCE.md).
    const ids = readFileSync(join(FIXTURES, "cov-build", "allRules.txt"), "utf8")
      .split("\n")
      .filter((line) => line !== "")
      .map((line) => line.slice(0, 64));
    expect(ids).toHaveLength(168);
    for (const id of ids) expect(getRuleById(DEFINITION, id).att.get(Atts.UNIQUE_ID)).toBe(id);
  });

  test("a miss throws with pyk's wording as the first line", () => {
    const missing = "0".repeat(64);
    expect(() => getRuleById(DEFINITION, missing)).toThrow(RuleNotFoundError);

    let message = "";
    try {
      getRuleById(DEFINITION, missing);
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    // `coverage.py:31`, verbatim; the hint follows on the next line.
    expect(message.split("\n")[0]).toBe(`Could not find rule with ID: ${missing}`);
    expect(message).toInclude("append-only");
  });

  test("a 12-hex prefix is not a match — that spelling belongs to kompiled", () => {
    expect(() => getRuleById(DEFINITION, SMALL_LOG_ID.slice(0, 12))).toThrow(RuleNotFoundError);
  });

  test("only KRule sentences count, even when a claim carries the id", () => {
    const id = "a".repeat(64);
    const claim = kclaim(kapply("<generatedTop>"), { att: new KAtt([attEntry(Atts.UNIQUE_ID, id)]) });
    const claimOnly = new KDefinition("M", [kflatmodule("M", { sentences: [claim] })]);
    expect(() => getRuleById(claimOnly, id)).toThrow(RuleNotFoundError);

    const rule = withId(id, kapply("<generatedTop>"));
    const both = new KDefinition("M", [kflatmodule("M", { sentences: [claim, rule] })]);
    expect(getRuleById(both, id)).toBe(rule);
  });
});

describe("stripCoverageLogger — the current shape", () => {
  // `GenerateCoverage.java:66-78`:
  //   KRewrite(lhs, sideEffect:<Sort>(#logToFile(<path>, <uid>), rhs))
  const instrumented = getRuleById(DEFINITION, SMALL_LOG_ID);

  test("the fixture rule really is instrumented, arity 2, before stripping", () => {
    expect(instrumented.body.node).toBe("KRewrite");
    const rhs = instrumented.body.node === "KRewrite" ? instrumented.body.rhs : undefined;
    expect(rhs?.node).toBe("KApply");
    if (rhs?.node !== "KApply") throw new Error("unreachable");
    expect(rhs.label.name).toBe("sideEffect:GeneratedTopCell");
    expect(rhs.args).toHaveLength(2);
    expect(rhs.args[0]?.node === "KApply" && rhs.args[0].label.name).toBe("#logToFile");
  });

  test("stripping leaves the rule's real right-hand side and nothing else", () => {
    const stripped = stripCoverageLogger(instrumented);
    expect(stripped.body.node).toBe("KRewrite");
    if (stripped.body.node !== "KRewrite" || instrumented.body.node !== "KRewrite") throw new Error("unreachable");

    const originalRhs = instrumented.body.rhs;
    if (originalRhs.node !== "KApply") throw new Error("unreachable");
    const realRhs = originalRhs.args[1];
    if (realRhs === undefined) throw new Error("unreachable");
    expect(stripped.body.rhs).toEqual(realRhs);
    // Left-hand side, side conditions and attributes are untouched: `rule.let(body=…)`.
    expect(stripped.body.lhs).toEqual(instrumented.body.lhs);
    expect(stripped.requires).toEqual(instrumented.requires);
    expect(stripped.ensures).toEqual(instrumented.ensures);
    expect(stripped.att.get(Atts.UNIQUE_ID)).toBe(SMALL_LOG_ID);
  });

  test("all 168 real rules strip clean — no logger survives, none is emptied", () => {
    const rules = DEFINITION.modules.flatMap((module) =>
      module.sentences.filter((sentence): sentence is KRule => sentence.node === "KRule"),
    );
    expect(rules).toHaveLength(168);
    for (const rule of rules) {
      const json = JSON.stringify(stripCoverageLogger(rule).body);
      expect(json).not.toInclude("sideEffect:");
      expect(json).not.toInclude("#logToFile");
      expect(json.length).toBeGreaterThan(0);
    }
  });
});

describe("stripCoverageLogger — pyk's obsolete shape", () => {
  // `coverage.py:39-42`: a `project:` application whose first argument is a
  // two-item KSequence.  Hand-built, because nothing emits this any more.
  const lhs = kapply("<generatedTop>", [ktoken("0", "Int")]);
  const logged = kapply("#logToFile", [ktoken('"/x/coverage.txt"', "String")]);
  const realRhs = kapply("<generatedTop>", [ktoken("1", "Int")]);

  test("the two-item KSequence's second item becomes the right-hand side", () => {
    const rule = krule(krewrite(lhs, kapply("project:GeneratedTopCell", [ksequence([logged, realRhs])])));
    expect(stripCoverageLogger(rule).body).toEqual(krewrite(lhs, realRhs));
  });

  test("a sequence of any other length is left alone, as pyk leaves it", () => {
    for (const items of [[realRhs], [logged, realRhs, realRhs]]) {
      const rule = krule(krewrite(lhs, kapply("project:GeneratedTopCell", [ksequence(items)])));
      expect(stripCoverageLogger(rule)).toBe(rule);
    }
  });
});

describe("stripCoverageLogger — what it must not touch", () => {
  const lhs = kapply("<generatedTop>", [ktoken("0", "Int")]);
  const rhs = kapply("<generatedTop>", [ktoken("1", "Int")]);
  const logToFile = kapply("#logToFile", [ktoken('"/x/coverage.txt"', "String"), ktoken('"id\\n"', "String")]);

  test("a rule whose body is not a rewrite is returned unchanged, identically", () => {
    const rule = krule(kapply("<generatedTop>"));
    expect(stripCoverageLogger(rule)).toBe(rule);
  });

  test("a plain rewrite is returned unchanged, identically", () => {
    const rule = krule(krewrite(lhs, rhs));
    expect(stripCoverageLogger(rule)).toBe(rule);
  });

  test("a semantics' own sideEffect call survives — the #logToFile guard", () => {
    // `sideEffect` is an ordinary K-IO function, so matching the label prefix
    // alone would delete a user's side effect.  Deviation 2 in `rules.ts`.
    const own = kapply("sideEffect:Int", [kapply("#write", [ktoken("1", "Int")]), rhs]);
    const rule = krule(krewrite(lhs, own));
    expect(stripCoverageLogger(rule)).toBe(rule);
  });

  test("an arity-3 sideEffect is not the instrumentation shape", () => {
    const rule = krule(krewrite(lhs, kapply("sideEffect:Int", [logToFile, rhs, rhs])));
    expect(stripCoverageLogger(rule)).toBe(rule);
  });

  test("only the top of the right-hand side is examined", () => {
    // The instrumentation is applied once, at the root
    // (`GenerateCoverage.java:76`); a nested `sideEffect:` is the semantics'.
    const nested = kapply("<generatedTop>", [kapply("sideEffect:Int", [logToFile, rhs])]);
    const rule = krule(krewrite(lhs, nested));
    expect(stripCoverageLogger(rule)).toBe(rule);
  });
});

/**
 * `minimize_rule_like` is `@kframework-ts/kast`'s, not this package's — but
 * `kcovr rules` is the only caller in the monorepo that runs it over a real
 * `kompile` output, and the README quotes the number it gets, so it is pinned
 * here next to the fixture it is a claim about.
 */
describe("minimizeRuleLike over the real definition", () => {
  test("changes 66 of the fixture's 168 rules", () => {
    const printer = new PrettyPrinter(removeSourceMap(DEFINITION));
    let changed = 0;
    for (const rule of DEFINITION.rules) {
      const stripped = stripCoverageLogger(rule);
      if (printer.print(stripped) !== printer.print(minimizeRuleLike(stripped))) changed += 1;
    }
    expect(DEFINITION.rules).toHaveLength(168);
    expect(changed).toBe(66);
  });

  test("drops the `true` conjunct a heat rule's side condition carries", () => {
    // `PANOPTICON-SYNTAX.exprAdd2-heat`.
    const heatId = "1a044eac54f99147ab39bd1fb2fa529ba7e77dd1463cd57c4cb181da25b6965b";
    const rule = minimizeRuleLike(stripCoverageLogger(getRuleById(DEFINITION, heatId)));
    // `andBool(flatten_label('_andBool_', requires))` drops it before
    // `simplify_bool` ever runs, so the survivor is the single real conjunct.
    expect(rule.requires.node).toBe("KApply");
    expect(new PrettyPrinter(DEFINITION).print(rule)).not.toInclude("andBool ( true");
  });
});
