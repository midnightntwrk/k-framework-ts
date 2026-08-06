/**
 * The implies family's step protocol and `ImpliesProver`, on a fake backend.
 *
 * `pyk/src/tests/integration/proof/test_implies_proof.py` is the upstream
 * oracle and needs a running backend; its five pure-logic rows are ported in
 * `test/live-k.test.ts`. Everything the prover decides *without* asking the
 * backend — the status gate, the two vacuous short-circuits, the dummy
 * configuration, the universal/existential binding — is decided here, with no
 * K installation.
 */

import { CSubst, CTerm } from "@kframework-ts/cterm";
import {
  attEntry,
  Atts,
  kapply,
  KAtt,
  KDefinition,
  kflatmodule,
  knonterminal,
  kproduction,
  ksort,
  kterminal,
  kvariable,
  Subst,
  type KInner,
} from "@kframework-ts/kast";
import { BOOL } from "@kframework-ts/kast/prelude/kbool";
import { GENERATED_TOP_CELL, K } from "@kframework-ts/kast/prelude/k";
import { mlAnd, mlBottom, mlEqualsTrue, mlTop } from "@kframework-ts/kast/prelude/ml";
import { describe, expect, test } from "bun:test";

import { EqualityProof, ImpliesProof, ProofStatus, RefutationProof } from "../src/index.ts";
import { advanceProof, ImpliesProver, type ImpliesSymbolic, type ImpliesSymbolicImpliesOptions } from "../src/prove.ts";

//////////////////////////
// Fixtures             //
//////////////////////////

const GENERATED_TOP_CELL_SORT = ksort("GeneratedTopCell");
const K_CELL_SORT = ksort("KCell");

/** A cell production as a kompiled definition carries it: `cell` + `cellName`. */
function cellProd(sort: ReturnType<typeof ksort>, cellName: string, children: readonly ReturnType<typeof ksort>[]) {
  return kproduction(sort, {
    items: [kterminal(`<${cellName}>`), ...children.map((child) => knonterminal(child)), kterminal(`</${cellName}>`)],
    klabel: `<${cellName}>`,
    att: new KAtt([attEntry(Atts.CELL, null), attEntry(Atts.CELL_NAME, cellName)]),
  });
}

/** Enough of a definition for `emptyConfig(GeneratedTopCell)` — nothing more. */
const DEFINITION = new KDefinition("MAIN", [
  kflatmodule("MAIN", {
    sentences: [cellProd(GENERATED_TOP_CELL_SORT, "generatedTop", [K_CELL_SORT]), cellProd(K_CELL_SORT, "k", [K])],
  }),
]);

const DUMMY_CONFIG = DEFINITION.emptyConfig(GENERATED_TOP_CELL);

const p = mlEqualsTrue(kapply("p", [kvariable("X")]));
const q = mlEqualsTrue(kapply("q", [kvariable("X")]));

interface ImpliesScript {
  /** Applied to each side before it is returned; identity by default. */
  readonly simplify?: (kast: KInner) => KInner;
  readonly csubst?: CSubst;
}

class FakeImpliesSymbolic implements ImpliesSymbolic {
  readonly definition = DEFINITION;
  readonly simplifyCalls: KInner[] = [];
  readonly impliesCalls: {
    antecedent: CTerm;
    consequent: CTerm;
    options: ImpliesSymbolicImpliesOptions | undefined;
  }[] = [];
  readonly #script: ImpliesScript;

  constructor(script: ImpliesScript = {}) {
    this.#script = script;
  }

  kastSimplify(kast: KInner): Promise<{ readonly kast: KInner }> {
    this.simplifyCalls.push(kast);
    return Promise.resolve({ kast: this.#script.simplify?.(kast) ?? kast });
  }

  implies(
    antecedent: CTerm,
    consequent: CTerm,
    options?: ImpliesSymbolicImpliesOptions,
  ): Promise<{ readonly csubst?: CSubst | undefined }> {
    this.impliesCalls.push({ antecedent, consequent, options });
    return Promise.resolve(this.#script.csubst === undefined ? {} : { csubst: this.#script.csubst });
  }
}

function only<T>(values: readonly T[]): T {
  expect(values).toHaveLength(1);
  return values[0]!;
}

//////////////////////////
// The step protocol    //
//////////////////////////

describe("ImpliesProof.getSteps", () => {
  test("emits exactly one self-contained step while either side is unsimplified", () => {
    const proof = new ImpliesProof("impl", p, q, { bindUniversally: true });
    const step = only(proof.getSteps());
    expect(step.proofId).toBe("impl");
    expect(step.proofType).toBe("ImpliesProof");
    expect(step.antecedent).toBe(p);
    expect(step.consequent).toBe(q);
    expect(step.bindUniversally).toBe(true);
    expect(step.status).toBe(ProofStatus.PENDING);
    // The step is data, not a handle on the proof (`implies.py:31-33`).
    expect(Object.values(step)).not.toContain(proof);
  });

  test("stops once both sides are simplified", () => {
    const proof = new ImpliesProof("impl", p, q, { simplifiedAntecedent: p, simplifiedConsequent: q });
    expect(proof.getSteps()).toEqual([]);
    expect(proof.canProgress).toBe(false);
  });

  test("an admitted proof still offers a step, carrying its non-pending status", () => {
    const proof = new ImpliesProof("admitted", p, q, { admitted: true });
    expect(only(proof.getSteps()).status).toBe(ProofStatus.PASSED);
  });
});

describe("ImpliesProof.commit", () => {
  test("a witness passes the proof and its absence fails it", () => {
    const passing = new ImpliesProof("pass", p, q);
    passing.commit({ csubst: new CSubst(new Subst()), simplifiedAntecedent: p, simplifiedConsequent: q });
    expect(passing.status).toBe(ProofStatus.PASSED);
    expect(passing.canProgress).toBe(false);

    const failing = new ImpliesProof("fail", p, q);
    failing.commit({ csubst: undefined, simplifiedAntecedent: p, simplifiedConsequent: q });
    expect(failing.status).toBe(ProofStatus.FAILED);
  });
});

//////////////////////////
// ImpliesProver        //
//////////////////////////

describe("ImpliesProver.stepProof", () => {
  test("checks the implication with a shared dummy configuration and universal binding", async () => {
    const symbolic = new FakeImpliesSymbolic({ csubst: new CSubst(new Subst()) });
    const proof = new RefutationProof("refute", [kapply("c")], kapply("d"));
    const results = await new ImpliesProver(symbolic).stepProof(only(proof.getSteps()));

    const call = only(symbolic.impliesCalls);
    expect(call.antecedent.config).toBe(DUMMY_CONFIG);
    expect(call.consequent.config).toBe(DUMMY_CONFIG);
    expect(call.antecedent.constraints).toEqual(new CTerm(DUMMY_CONFIG, [proof.antecedent]).constraints);
    expect(call.consequent.constraints).toEqual(new CTerm(DUMMY_CONFIG, [proof.consequent]).constraints);
    // `bind_universally=True` is hardcoded by both implies-family subclasses.
    expect(call.options).toEqual({ bindRhs: "forall", assumeDefined: false });

    proof.commit(only(results));
    expect(proof.status).toBe(ProofStatus.PASSED);
    expect(symbolic.simplifyCalls).toHaveLength(2);
  });

  test("binds existentially when the proof does not bind universally", async () => {
    const symbolic = new FakeImpliesSymbolic();
    const proof = new ImpliesProof("existential", p, q);
    await new ImpliesProver(symbolic, { assumeDefined: true }).stepProof(only(proof.getSteps()));
    expect(only(symbolic.impliesCalls).options).toEqual({ bindRhs: "exists", assumeDefined: true });
  });

  test("an antecedent that simplifies to #Bottom passes without asking the backend", async () => {
    const symbolic = new FakeImpliesSymbolic({ simplify: (kast) => (kast === p ? mlBottom() : kast) });
    const proof = new ImpliesProof("vacuous-antecedent", p, q);
    const results = await new ImpliesProver(symbolic).stepProof(only(proof.getSteps()));

    expect(symbolic.impliesCalls).toHaveLength(0);
    const result = only(results);
    expect(result.csubst).toEqual(new CSubst(new Subst()));
    proof.commit(result);
    expect(proof.status).toBe(ProofStatus.PASSED);
  });

  test("a consequent that simplifies to #Top passes without asking the backend", async () => {
    const symbolic = new FakeImpliesSymbolic({ simplify: (kast) => (kast === q ? mlTop() : kast) });
    const proof = new ImpliesProof("vacuous-consequent", p, q);
    const results = await new ImpliesProver(symbolic).stepProof(only(proof.getSteps()));

    expect(symbolic.impliesCalls).toHaveLength(0);
    expect(only(results).csubst).toEqual(new CSubst(new Subst()));
  });

  test("no witness means a failed proof", async () => {
    const symbolic = new FakeImpliesSymbolic();
    const proof = new ImpliesProof("invalid", p, q);
    proof.commit(only(await new ImpliesProver(symbolic).stepProof(only(proof.getSteps()))));
    expect(proof.status).toBe(ProofStatus.FAILED);
  });

  test("the status gate suppresses the step entirely", async () => {
    const symbolic = new FakeImpliesSymbolic({ csubst: new CSubst(new Subst()) });
    const proof = new ImpliesProof("admitted", p, q, { admitted: true });
    const results = await new ImpliesProver(symbolic).stepProof(only(proof.getSteps()));

    // `if step.proof.status is not ProofStatus.PENDING: return []` — nothing is
    // simplified, nothing is asked, and nothing is committed.
    expect(results).toEqual([]);
    expect(symbolic.simplifyCalls).toHaveLength(0);
    expect(symbolic.impliesCalls).toHaveLength(0);
  });
});

describe("advanceProof over an implies-family proof", () => {
  test("drives an EqualityProof to PASSED in a single iteration", async () => {
    const symbolic = new FakeImpliesSymbolic({ csubst: new CSubst(new Subst()) });
    const proof = new EqualityProof("eq", kapply("lhs"), kapply("rhs"), BOOL, { constraints: [p] });
    await advanceProof(new ImpliesProver(symbolic), proof);

    expect(proof.status).toBe(ProofStatus.PASSED);
    expect(proof.simplifiedConstraints).toEqual(mlAnd([p]));
    expect(proof.simplifiedEquality).toBe(proof.consequent);
    // One step, then `getSteps()` is empty and the loop ends.
    expect(symbolic.impliesCalls).toHaveLength(1);
  });

  test("an admitted proof takes its one no-op step and stays PASSED", async () => {
    const symbolic = new FakeImpliesSymbolic();
    const proof = new ImpliesProof("admitted", p, q, { admitted: true });
    await advanceProof(new ImpliesProver(symbolic), proof, { maxIterations: 4 });

    expect(proof.status).toBe(ProofStatus.PASSED);
    expect(proof.canProgress).toBe(true);
    expect(symbolic.impliesCalls).toHaveLength(0);
  });
});
