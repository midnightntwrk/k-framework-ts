/**
 * The substitution suite — pyk's `State` (`k/pyk/src/pyk/kore/rpc.py:514-595`),
 * every validation and both directions.
 *
 * Two halves. The first builds patterns with `@kframework-ts/kore`'s factories
 * and walks the five shapes a conjunction can arrive in plus the five ways an
 * entry can be malformed; the second decodes **real vendored responses** and
 * flattens their substitutions, which is what proves the shapes above are the
 * shapes servers actually send:
 *
 * | fixture | shape |
 * | --- | --- |
 * | `kore-rpc-server/execute/branching` next-state 1 `substitution` | a lone `\equals`, no `\and` at all |
 * | `kore-rpc-server/execute/branching` next-state 0 `rule-substitution` | *left*-nested: `\and(\and(eq, eq), eq)` |
 * | `booster-rpc/test-get-model/response-with-map` `substitution` | flat 3-ary `\and` |
 * | `booster-rpc/test-implies/response-X->X` `condition.substitution` | `\top` — the empty substitution |
 *
 * All four decode through the same walk, which is the argument for using
 * `conjuncts` rather than assuming a nesting direction.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { type Pattern, and, app, equals, evar, koreText, sortApp, top } from "@kframework-ts/kore";
import { INT, SORT_GENERATED_TOP_CELL, intDv } from "@kframework-ts/kore/prelude";
import {
  type ExecuteState,
  type Substitution,
  conditionSubstitution,
  decodeExecuteResult,
  decodeGetModelResult,
  decodeImpliesResult,
  decodeResponse,
  decodeSubstitution,
  encodeSubstitution,
  koreJson,
  stateKore,
  stateRuleSubstitution,
  stateSubstitution,
  substitutionKey,
} from "../src/index.ts";
import { defined } from "./helpers/assert.ts";

//////////////////////////
// Helpers              //
//////////////////////////

const FIXTURES = join(import.meta.dir, "..", "fixtures");

function readGolden(...segments: readonly string[]): unknown {
  const value: unknown = JSON.parse(readFileSync(join(FIXTURES, ...segments), "utf8"));
  return value;
}

/** `\equals{S, SortGeneratedTopCell{}}(X : S, value)` — one well-formed entry. */
function binding(name: string, sort = INT, value: Pattern = intDv(0)): Pattern {
  return equals(sort, SORT_GENERATED_TOP_CELL, evar(name, sort), value);
}

/** A substitution as plain `name : sort -> value text` pairs, for readable assertions. */
function flatten(substitution: Substitution): readonly (readonly [string, string])[] {
  return [...substitution.values()].map((entry) => [koreText(entry.variable), koreText(entry.value)] as const);
}

//////////////////////////
// The shapes           //
//////////////////////////

describe("shapes a substitution arrives in", () => {
  test("`\\top` is the empty substitution", () => {
    // `conjuncts` drops `\top` as `\and`'s unit (`manip.py:13-18`), so the
    // "no bindings" spelling both backends use needs no special case.
    expect(decodeSubstitution(top(SORT_GENERATED_TOP_CELL)).size).toBe(0);
  });

  test("a bare `\\equals` is a one-entry substitution", () => {
    // No `\and` wrapper: a single binding is sent unwrapped, as
    // `execute/branching`'s next-state shows below.
    expect(flatten(decodeSubstitution(binding("VarX")))).toEqual([["VarX : SortInt{}", '\\dv{SortInt{}}("0")']]);
  });

  test("a flat n-ary `\\and` decodes in order", () => {
    const pattern = and(SORT_GENERATED_TOP_CELL, [
      binding("VarX", INT, intDv(1)),
      binding("VarY", INT, intDv(2)),
      binding("VarZ", INT, intDv(3)),
    ]);
    expect(flatten(decodeSubstitution(pattern)).map(([name]) => name)).toEqual([
      "VarX : SortInt{}",
      "VarY : SortInt{}",
      "VarZ : SortInt{}",
    ]);
  });

  test("a right-nested chain decodes to the same thing", () => {
    const pattern = and(SORT_GENERATED_TOP_CELL, [
      binding("VarX", INT, intDv(1)),
      and(SORT_GENERATED_TOP_CELL, [binding("VarY", INT, intDv(2)), binding("VarZ", INT, intDv(3))]),
    ]);
    expect(flatten(decodeSubstitution(pattern)).map(([, value]) => value)).toEqual([
      '\\dv{SortInt{}}("1")',
      '\\dv{SortInt{}}("2")',
      '\\dv{SortInt{}}("3")',
    ]);
  });

  test("a left-nested chain decodes to the same thing", () => {
    const pattern = and(SORT_GENERATED_TOP_CELL, [
      and(SORT_GENERATED_TOP_CELL, [binding("VarX", INT, intDv(1)), binding("VarY", INT, intDv(2))]),
      binding("VarZ", INT, intDv(3)),
    ]);
    expect(flatten(decodeSubstitution(pattern)).map(([, value]) => value)).toEqual([
      '\\dv{SortInt{}}("1")',
      '\\dv{SortInt{}}("2")',
      '\\dv{SortInt{}}("3")',
    ]);
  });

  test("`\\top` conjuncts vanish from a chain", () => {
    const pattern = and(SORT_GENERATED_TOP_CELL, [
      top(SORT_GENERATED_TOP_CELL),
      binding("VarX"),
      top(SORT_GENERATED_TOP_CELL),
    ]);
    expect(decodeSubstitution(pattern).size).toBe(1);
  });
});

//////////////////////////
// The validations      //
//////////////////////////

describe("validations", () => {
  test("rejects a conjunct that is not an `\\equals`", () => {
    // pyk `rpc.py:559-560`. The offending pattern is named by its tag, not its
    // text — a conjunct could be a whole configuration.
    expect(() => decodeSubstitution(and(SORT_GENERATED_TOP_CELL, [evar("VarX", INT)]))).toThrow(
      /Expected \\equals as substitution entry, got: EVar \(at substitution\)/u,
    );
  });

  test("rejects an entry whose result sort is not SortGeneratedTopCell", () => {
    // pyk `rpc.py:561-564`: the *second* sort of `\equals{S, T}`, always
    // `SortGeneratedTopCell{}`, whatever the variable's own sort is.
    const wrong = equals(INT, sortApp("SortBool"), evar("VarX", INT), intDv(0));
    expect(() => decodeSubstitution(wrong)).toThrow(
      /Expected SortGeneratedTopCell\{\} as substitution entry sort, got: SortBool\{\}/u,
    );
  });

  test("rejects a non-variable left-hand side", () => {
    // pyk `rpc.py:565-566`.
    const wrong = equals(INT, SORT_GENERATED_TOP_CELL, intDv(1), intDv(0));
    expect(() => decodeSubstitution(wrong)).toThrow(/Expected an element variable as substitution entry key, got: DV/u);
  });

  test("rejects a key whose sort disagrees with the operand sort", () => {
    // pyk `rpc.py:567-570`, message included: it prints the operand sort first
    // and the key's sort second, which reads backwards next to its own
    // condition and is transcribed exactly as written.
    const wrong = equals(sortApp("SortBool"), SORT_GENERATED_TOP_CELL, evar("VarX", INT), intDv(0));
    expect(() => decodeSubstitution(wrong)).toThrow(
      /Mismatch between substitution entry and key sort: SortBool\{\} and SortInt\{\}/u,
    );
  });

  test("rejects a duplicate key", () => {
    // pyk `rpc.py:574-578`.
    const pattern = and(SORT_GENERATED_TOP_CELL, [binding("VarX", INT, intDv(1)), binding("VarX", INT, intDv(2))]);
    expect(() => decodeSubstitution(pattern)).toThrow(
      /Duplicate substitution entry key: VarX : SortInt\{\} -> \[\\dv\{SortInt\{\}\}\("1"\), \\dv\{SortInt\{\}\}\("2"\)\]/u,
    );
  });

  test("does not confuse two variables that share a name but not a sort", () => {
    // The map key is name *and* sort (`substitutionKey`), which is what pyk's
    // structural hash of an `EVar` gives it for free.
    const pattern = and(SORT_GENERATED_TOP_CELL, [
      binding("VarX", INT, intDv(1)),
      equals(sortApp("SortBool"), SORT_GENERATED_TOP_CELL, evar("VarX", sortApp("SortBool")), app("Lbltrue")),
    ]);
    const decoded = decodeSubstitution(pattern);
    expect(decoded.size).toBe(2);
    expect([...decoded.keys()]).toEqual(["VarX : SortInt{}", "VarX : SortBool{}"]);
  });

  test("carries the path into the message", () => {
    expect(() => decodeSubstitution(evar("VarX", INT), "state.rule-substitution")).toThrow(
      /\(at state\.rule-substitution\)$/u,
    );
  });
});

//////////////////////////
// Encoding             //
//////////////////////////

describe("encodeSubstitution", () => {
  test("rebuilds a flat `\\and` of `\\equals`, in map order", () => {
    // pyk `_dict_to_subst` (`rpc.py:581-586`): the operand sort comes from the
    // *variable*, the result sort is always SortGeneratedTopCell.
    const pattern = and(SORT_GENERATED_TOP_CELL, [binding("VarX", INT, intDv(1)), binding("VarY", INT, intDv(2))]);
    expect(koreText(encodeSubstitution(decodeSubstitution(pattern)))).toBe(koreText(pattern));
  });

  test("re-associates a nested chain into a flat one", () => {
    const nested = and(SORT_GENERATED_TOP_CELL, [
      and(SORT_GENERATED_TOP_CELL, [binding("VarX", INT, intDv(1)), binding("VarY", INT, intDv(2))]),
      binding("VarZ", INT, intDv(3)),
    ]);
    const flat = and(SORT_GENERATED_TOP_CELL, [
      binding("VarX", INT, intDv(1)),
      binding("VarY", INT, intDv(2)),
      binding("VarZ", INT, intDv(3)),
    ]);
    expect(koreText(encodeSubstitution(decodeSubstitution(nested)))).toBe(koreText(flat));
  });

  test("turns an empty substitution into a nullary `\\and`, not a `\\top`", () => {
    // pyk's function has the same property; `decodeSubstitution` reads both, so
    // the asymmetry is harmless and is recorded rather than smoothed over.
    expect(koreText(encodeSubstitution(decodeSubstitution(top(SORT_GENERATED_TOP_CELL))))).toBe(
      "\\and{SortGeneratedTopCell{}}()",
    );
  });
});

//////////////////////////
// State reassembly     //
//////////////////////////

describe("stateKore", () => {
  const term = app("Lbl'-LT-'generatedTop'-GT-'", [], [intDv(7)]);

  test("a bare term is itself", () => {
    expect(koreText(stateKore({ term: koreJson(term) }))).toBe(koreText(term));
  });

  test("splices the bindings flat alongside the term", () => {
    // pyk `rpc.py:590-592`: `(_kore,) + self._dict_to_subst(...).ops` — a
    // two-binding state is a *three*-element `\and`, not a term conjoined with
    // an `\and`.
    const state: ExecuteState = {
      term: koreJson(term),
      substitution: koreJson(
        and(SORT_GENERATED_TOP_CELL, [binding("VarX", INT, intDv(1)), binding("VarY", INT, intDv(2))]),
      ),
    };
    const expected = and(SORT_GENERATED_TOP_CELL, [
      term,
      binding("VarX", INT, intDv(1)),
      binding("VarY", INT, intDv(2)),
    ]);
    expect(koreText(stateKore(state))).toBe(koreText(expected));
  });

  test("conjoins the predicate in a second, nested step", () => {
    // pyk `rpc.py:593-594`. With both present the result is nested, not flat —
    // the one shape detail a "conjoin everything" implementation gets wrong.
    const predicate = app("LblisTrue", [], [intDv(1)]);
    const state: ExecuteState = {
      term: koreJson(term),
      substitution: koreJson(binding("VarX", INT, intDv(1))),
      predicate: koreJson(predicate),
    };
    const expected = and(SORT_GENERATED_TOP_CELL, [
      and(SORT_GENERATED_TOP_CELL, [term, binding("VarX", INT, intDv(1))]),
      predicate,
    ]);
    expect(koreText(stateKore(state))).toBe(koreText(expected));
  });

  test("a predicate with no substitution is a two-element `\\and`", () => {
    const predicate = app("LblisTrue", [], [intDv(1)]);
    const state: ExecuteState = { term: koreJson(term), predicate: koreJson(predicate) };
    expect(koreText(stateKore(state))).toBe(koreText(and(SORT_GENERATED_TOP_CELL, [term, predicate])));
  });

  test("ignores the rule-* fields entirely", () => {
    // `ruleId`, `rulePredicate` and `ruleSubstitution` describe the rewrite
    // that produced the state, not the state; pyk's `kore` reads none of them.
    const state: ExecuteState = {
      term: koreJson(term),
      ruleId: "TEST.AB",
      ruleSubstitution: koreJson(binding("RuleVarX", INT, intDv(9))),
      rulePredicate: koreJson(top(SORT_GENERATED_TOP_CELL)),
    };
    expect(koreText(stateKore(state))).toBe(koreText(term));
  });

  test("keeps the empty substitution visible as a one-element `\\and`", () => {
    // `substitution: \top` is not the same as no substitution at all: the field
    // was present, so the conjunction happens, with nothing to splice into it.
    const state: ExecuteState = { term: koreJson(term), substitution: koreJson(top(SORT_GENERATED_TOP_CELL)) };
    expect(koreText(stateKore(state))).toBe(koreText(and(SORT_GENERATED_TOP_CELL, [term])));
  });
});

//////////////////////////
// Vendored responses   //
//////////////////////////

describe("real server responses", () => {
  test("execute/branching: a lone `\\equals` substitution on the second branch", () => {
    const response = decodeResponse(readGolden("kore-rpc-server", "execute", "branching", "response.golden"));
    if (response.kind !== "result") throw new Error("expected a result response");
    const result = decodeExecuteResult(response.result);
    if (result.reason !== "branching") throw new Error("expected a branching result");

    const branch = result.nextStates[1];
    if (branch === undefined) throw new Error("expected two branches");

    // Branch 0 has a `predicate` and no `substitution`; branch 1 the reverse —
    // the same disjunction, once as a constraint and once as a binding.
    expect(stateSubstitution(defined(result.nextStates[0], "the first branch"))).toBeUndefined();
    expect(flatten(defined(stateSubstitution(branch), "the second branch's substitution"))).toEqual([
      ["VarX : SortInt{}", '\\dv{SortInt{}}("0")'],
    ]);
  });

  test("execute/branching: a left-nested three-entry rule-substitution", () => {
    const response = decodeResponse(readGolden("kore-rpc-server", "execute", "branching", "response.golden"));
    if (response.kind !== "result") throw new Error("expected a result response");
    const result = decodeExecuteResult(response.result);
    if (result.reason !== "branching") throw new Error("expected a branching result");

    const branch = result.nextStates[0];
    if (branch === undefined) throw new Error("expected a first branch");

    // `\and(\and(eq, eq), eq)` on the wire — the nesting direction the walk
    // must not depend on.
    expect(flatten(defined(stateRuleSubstitution(branch), "the branch's rule-substitution"))).toEqual([
      [
        "RuleVar'Unds'DotVar0 : SortGeneratedCounterCell{}",
        "Lbl'-LT-'generatedCounter'-GT-'{}(\\dv{SortInt{}}(\"0\"))",
      ],
      ["RuleVar'Unds'DotVar2 : SortK{}", "dotk{}()"],
      ["RuleVarX : SortInt{}", "VarX : SortInt{}"],
    ]);
  });

  test("booster get-model: a flat three-entry `\\and`", () => {
    const response = decodeResponse(readGolden("booster-rpc", "test-get-model", "response-with-map.json"));
    if (response.kind !== "result") throw new Error("expected a result response");
    const result = decodeGetModelResult(response.result);
    if (result.satisfiable !== "Sat" || result.substitution === undefined) {
      throw new Error("expected a satisfiable model with a substitution");
    }

    const decoded = decodeSubstitution(result.substitution.term);
    expect(decoded.size).toBe(3);
    expect([...decoded.keys()].map((key) => key.split(" : ")[1])).toEqual(["SortInt{}", "SortInt{}", "SortMap{}"]);
    // Every entry's operand sort is its variable's own sort — the check pyk
    // makes and the reason a `SortMap` binding is as legal as a `SortInt` one.
    for (const entry of decoded.values()) {
      expect(substitutionKey(entry.variable)).toBe(koreText(entry.variable));
    }
  });

  test("booster implies: `\\top` for an implication that needed no bindings", () => {
    const response = decodeResponse(readGolden("booster-rpc", "test-implies", "response-X->X.json"));
    if (response.kind !== "result") throw new Error("expected a result response");
    const result = decodeImpliesResult(response.result);
    if (result.condition === undefined) throw new Error("expected a condition");

    expect(conditionSubstitution(result.condition).size).toBe(0);
  });

  test("kore's get-model substitutions are NOT at SortGeneratedTopCell", () => {
    // A finding, pinned so it is not rediscovered: the legacy kore server emits
    // `get-model` substitutions at the *state's* sort —
    // `kore-rpc-server/get-model/satisfiable/response.golden` is
    // `\equals{SortInt{}, SortBool{}}(X : SortInt{}, \dv{SortInt{}}("0"))` —
    // so pyk's substitution validation rejects it. pyk never notices, because
    // `GetModelResult.from_dict` (`rpc.py:981-1000`) keeps the raw pattern and
    // never flattens it; only `State` (execute) goes through `_subst_to_dict`.
    //
    // The rule therefore is: flatten `execute` and `implies` substitutions,
    // and treat `get-model`'s as server-dependent. Booster's *are* at
    // SortGeneratedTopCell (the test above), kore's are not.
    const response = decodeResponse(readGolden("kore-rpc-server", "get-model", "satisfiable", "response.golden"));
    if (response.kind !== "result") throw new Error("expected a result response");
    const result = decodeGetModelResult(response.result);
    if (result.satisfiable !== "Sat" || result.substitution === undefined) {
      throw new Error("expected a satisfiable model with a substitution");
    }
    const substitution = result.substitution;

    expect(() => decodeSubstitution(substitution.term)).toThrow(
      /Expected SortGeneratedTopCell\{\} as substitution entry sort, got: SortBool\{\}/u,
    );
  });
});
