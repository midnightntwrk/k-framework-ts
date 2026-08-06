/**
 * The parts of the façade that need no backend: `initializeAprProof` against a
 * recorded-response adapter, and the functional-claim detection that decides
 * `EqualityProof` versus `APRProof`.
 *
 * `proveClaims` itself and `withExplore` are exercised in `live-facade.test.ts`,
 * which needs a real K: everything they do beyond this is composition of
 * sibling packages that already have their own suites.
 */

import { CTerm } from "@kframework-ts/cterm";
import {
  attEntry,
  Atts,
  KAtt,
  KDefinition,
  kapply,
  kclaim,
  kflatmodule,
  klabel,
  kproduction,
  krewrite,
  ksort,
  kterminal,
  ktoken,
  kvariable,
  knonterminal,
  type KClaim,
} from "@kframework-ts/kast";
import { mlBottom, mlEqualsTrue, mlTop } from "@kframework-ts/kast/prelude/ml";
import { KCFG } from "@kframework-ts/kcfg";
import { describe, expect, test } from "bun:test";

import { APRProof } from "../src/index.ts";
import { initializeAprProof, isFunctionalClaim, type InitializeSymbolic } from "../src/prove.ts";
import { caught } from "./support.ts";
import { node } from "./helpers.ts";

//////////////////////////
// initializeAprProof   //
//////////////////////////

/** One recorded call: which method, on what, with which options. */
interface RecordedCall {
  readonly method: "assumeDefined" | "simplify";
  readonly cterm: CTerm;
  readonly options: { readonly boosterOnly?: boolean } | undefined;
}

class RecordingSymbolic implements InitializeSymbolic {
  readonly calls: RecordedCall[] = [];
  readonly #assumed: (cterm: CTerm) => CTerm;
  readonly #simplified: (cterm: CTerm) => CTerm;

  constructor(
    options: {
      readonly assumed?: (cterm: CTerm) => CTerm;
      readonly simplified?: (cterm: CTerm) => CTerm;
    } = {},
  ) {
    this.#assumed = options.assumed ?? ((cterm) => cterm);
    this.#simplified = options.simplified ?? ((cterm) => cterm);
  }

  assumeDefined(cterm: CTerm, options?: { readonly boosterOnly?: boolean }): Promise<CTerm> {
    this.calls.push({ method: "assumeDefined", cterm, options });
    return Promise.resolve(this.#assumed(cterm));
  }

  simplify(cterm: CTerm, options?: { readonly boosterOnly?: boolean }): Promise<{ readonly cterm: CTerm }> {
    this.calls.push({ method: "simplify", cterm, options });
    return Promise.resolve({ cterm: this.#simplified(cterm) });
  }
}

/** A two-node proof: node 1 is `init`, node 2 is `target`. */
function twoNodeProof(): APRProof {
  const kcfg = KCFG.fromDict({ nodes: [node(1).toDict(), node(2).toDict()] });
  return new APRProof("init-me", kcfg, [], 1, 2, new Map());
}

describe("initializeAprProof", () => {
  test("assumes the init node defined, simplifies both, and writes both back", async () => {
    const proof = twoNodeProof();
    const initBefore = proof.kcfg.node(proof.init).cterm;
    const targetBefore = proof.kcfg.node(proof.target).cterm;
    const constraint = mlEqualsTrue(kapply("_>Int_", [kvariable("X"), ktoken("0", "Int")]));

    const symbolic = new RecordingSymbolic({
      assumed: (cterm) => cterm.addConstraint(constraint),
      simplified: (cterm) => cterm,
    });
    await initializeAprProof(symbolic, proof);

    // assume_defined on init, then simplify init, then simplify target
    // (`kevm_pyk/utils.py:335-342`), in that order.
    expect(symbolic.calls.map((call) => call.method)).toEqual(["assumeDefined", "simplify", "simplify"]);
    expect(symbolic.calls[0]?.cterm).toEqual(initBefore);
    expect(symbolic.calls[2]?.cterm).toEqual(targetBefore);

    expect(proof.kcfg.node(proof.init).cterm.constraints).toEqual([constraint]);
    expect(proof.kcfg.node(proof.target).cterm).toEqual(targetBefore);
  });

  test("pins boosterOnly false on the definedness request", async () => {
    const proof = twoNodeProof();
    const symbolic = new RecordingSymbolic();
    await initializeAprProof(symbolic, proof);
    // `#Ceil` has to reach Kore, so this one request never runs Booster-only —
    // upstream pins it regardless of the run-wide setting (`utils.py:334-336`).
    expect(symbolic.calls[0]?.options).toEqual({ boosterOnly: false });
  });

  test("refuses an initial node that simplifies to #Bottom", async () => {
    const proof = twoNodeProof();
    const symbolic = new RecordingSymbolic({
      simplified: (cterm) => (cterm.config === proof.kcfg.node(2).cterm.config ? cterm : CTerm.fromKast(mlBottom())),
    });
    const error = await caught(() => initializeAprProof(symbolic, proof));
    expect(String(error)).toContain("Simplifying initial node led to #Bottom");
  });

  test("refuses a target node that simplifies to #Top, with upstream's confused message", async () => {
    const proof = twoNodeProof();
    const target = proof.kcfg.node(2).cterm.config;
    const symbolic = new RecordingSymbolic({
      simplified: (cterm) => (cterm.config === target ? CTerm.fromKast(mlTop()) : cterm),
    });
    const error = await caught(() => initializeAprProof(symbolic, proof));
    // The text says `#Bottom` while the test is for `#Top`; transcribed as
    // written (`utils.py:346-347`).
    expect(String(error)).toContain("Simplifying target node led to #Bottom");
  });
});

//////////////////////////
// isFunctionalClaim    //
//////////////////////////

function functionalDefinition(): KDefinition {
  const plus = kproduction(ksort("Int"), {
    items: [knonterminal(ksort("Int")), kterminal("+Int"), knonterminal(ksort("Int"))],
    klabel: klabel("_+Int_"),
    att: new KAtt([attEntry(Atts.FUNCTION, null)]),
  });
  const step = kproduction(ksort("Step"), {
    items: [knonterminal(ksort("Int"))],
    klabel: klabel("step"),
  });
  return new KDefinition("MAIN", [kflatmodule("MAIN", { sentences: [plus, step] })]);
}

function claimOf(body: ReturnType<typeof krewrite>): KClaim {
  return kclaim(body, { att: new KAtt([attEntry(Atts.LABEL, "spec")]) });
}

describe("isFunctionalClaim", () => {
  test("a claim whose LHS head is a function production is an EqualityProof claim", () => {
    const definition = functionalDefinition();
    const claim = claimOf(krewrite(kapply("_+Int_", [ktoken("3", "Int"), ktoken("4", "Int")]), ktoken("7", "Int")));
    expect(isFunctionalClaim(definition, claim)).toBe(true);
  });

  test("a claim whose LHS head is a constructor is an APRProof claim", () => {
    const definition = functionalDefinition();
    const claim = claimOf(krewrite(kapply("step", [ktoken("1", "Int")]), kapply("step", [ktoken("2", "Int")])));
    expect(isFunctionalClaim(definition, claim)).toBe(false);
  });

  test("a claim whose LHS is not an application at all is an APRProof claim", () => {
    const definition = functionalDefinition();
    const claim = claimOf(krewrite(kvariable("X"), ktoken("1", "Int")));
    expect(isFunctionalClaim(definition, claim)).toBe(false);
  });
});
