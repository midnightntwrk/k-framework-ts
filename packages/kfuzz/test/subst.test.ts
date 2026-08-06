/**
 * The substitution this package fuzzes with — pyk's `substitute_vars`
 * (`kore/manip.py:60-74`), which lives in `@kframework-ts/kore` and is
 * re-exported by `src/subst.ts`.
 *
 * `kore` has its own tests for the function.  What is asserted here is the
 * contract *this* package depends on and would be broken by silently: that a
 * `Map<EVar, Pattern>` — the shape `KFuzzHandler` and `SubstFunction` see — is
 * accepted directly, and that keys carry a **sort**.  The second one is the
 * sort-collision defect the 2026-08-06 gap triage caught in `kore`, open when
 * this package was written and closed now; a regression there would make a
 * fuzzer substitute the wrong
 * variable without failing anything else.
 */

import { describe, expect, test } from "bun:test";
import { app, evar, koreText, sortApp, type EVar, type Pattern } from "@kframework-ts/kore";
import { intDv } from "@kframework-ts/kore/prelude";

import { substituteVars, variableKey, type KoreSubst } from "../src/subst.ts";

const INT = sortApp("SortInt");
const BOOL = sortApp("SortBool");
const X_INT: EVar = evar("VarX", INT);
const X_BOOL: EVar = evar("VarX", BOOL);
const Y_INT: EVar = evar("VarY", INT);

function subst(...pairs: (readonly [EVar, Pattern])[]): KoreSubst {
  return new Map(pairs);
}

describe("variableKey", () => {
  test("separates by name and sort, so one name at two sorts is two keys", () => {
    expect(variableKey(X_INT)).not.toBe(variableKey(X_BOOL));
    expect(variableKey(X_INT)).toBe(variableKey(evar("VarX", sortApp("SortInt"))));
  });
});

describe("substituteVars, over a KoreSubst", () => {
  test("a Map keyed by the caller's own EVar objects is accepted as-is", () => {
    // The template's variable node comes from a parser and is a *different*
    // object from X_INT; the lookup is structural, so it still matches.
    const template = app("Lblpair", [], [evar("VarX", sortApp("SortInt")), Y_INT]);
    const result = substituteVars(template, subst([X_INT, intDv(7)]));
    expect(koreText(result)).toBe(koreText(app("Lblpair", [], [intDv(7), Y_INT])));
  });

  test("an unbound variable is left alone", () => {
    const template = app("Lblpair", [], [X_INT, Y_INT]);
    expect(koreText(substituteVars(template, subst([X_INT, intDv(7)])))).toContain("VarY : SortInt{}");
  });

  test("a variable of a different sort is NOT replaced — B1, closed", () => {
    // pyk keys by the whole EVar dataclass, so `X : SortBool` and `X : SortInt`
    // are different variables. Substitution keys them by both name and sort.
    const template = app("Lbla", [], [X_INT]);
    expect(koreText(substituteVars(template, subst([X_BOOL, intDv(9)])))).toBe(koreText(template));
  });

  test("it descends the whole term, however deep", () => {
    const template = app("Lbla", [], [app("Lblb", [], [app("Lblc", [], [X_INT])])]);
    const result = substituteVars(template, subst([X_INT, intDv(1)]));
    expect(koreText(result)).toContain('\\dv{SortInt{}}("1")');
    expect(koreText(result)).not.toContain("VarX");
  });

  test("an empty substitution is the identity", () => {
    const template = app("Lbla", [], [X_INT]);
    expect(substituteVars(template, subst())).toBe(template);
  });

  test("several variables go in one pass, in declaration order", () => {
    const template = app("Lblpair", [], [X_INT, Y_INT]);
    const result = substituteVars(template, subst([X_INT, intDv(1)], [Y_INT, intDv(2)]));
    expect(koreText(result)).toBe(koreText(app("Lblpair", [], [intDv(1), intDv(2)])));
  });

  test("the replacement is not itself rewritten — one bottom-up pass, no fixpoint", () => {
    // pyk's `bottom_up` visits each node once, so a substitution whose value
    // mentions a bound variable leaves that mention standing.
    const template = app("Lbla", [], [X_INT]);
    const result = substituteVars(template, subst([X_INT, app("Lblwrap", [], [X_INT])]));
    expect(koreText(result)).toBe(koreText(app("Lbla", [], [app("Lblwrap", [], [X_INT])])));
  });
});
