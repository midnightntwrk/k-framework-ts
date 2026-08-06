import { describe, expect, test } from "bun:test";
import { Subst, kapply, ktoken, kvariable } from "@kframework-ts/kast";
import { mlEqualsTrue } from "@kframework-ts/kast/prelude/ml";

import { CSubst, csubstEq } from "../src/csubst.ts";
import { CTerm, ctermEq } from "../src/cterm.ts";

const config = (term: ReturnType<typeof kvariable>) => kapply("<generatedTop>", [kapply("<k>", [term])]);

describe("CTerm and CSubst persistence", () => {
  test("round-trips pyk-compatible dictionaries", () => {
    const x = kvariable("X", "Int");
    const constraint = mlEqualsTrue(kapply("_>=Int_", [x, ktoken("0", "Int")]));
    const state = new CTerm(config(x), [constraint]);
    const csubst = new CSubst(new Subst({ X: ktoken("1", "Int") }), [constraint]);
    expect(ctermEq(CTerm.fromDict(state.toDict()), state)).toBe(true);
    expect(csubstEq(CSubst.fromDict(csubst.toDict()), csubst)).toBe(true);
    expect(Object.keys(state.toDict())).toEqual(["config", "constraints"]);
    expect(Object.keys(csubst.toDict())).toEqual(["subst", "constraints"]);
  });

  test("rejects malformed outer dictionaries", () => {
    const validConfig = new CTerm(config(kvariable("X"))).toDict().config;
    expect(() => CTerm.fromDict(null)).toThrow("object");
    expect(() => CTerm.fromDict({ constraints: [] })).toThrow("config");
    expect(() => CTerm.fromDict({ config: validConfig, constraints: {} })).toThrow("array");
    expect(() => CSubst.fromDict(null)).toThrow("object");
    expect(() => CSubst.fromDict({ constraints: [] })).toThrow("subst");
    expect(() => CSubst.fromDict({ subst: {}, constraints: {} })).toThrow("array");
  });
});
