/**
 * The implies family — `ImpliesProof`, `EqualityProof`, `RefutationProof`
 * (`proof/implies.py:42-408`).
 *
 * All three are one implication check: an ML antecedent, an ML consequent, and
 * the `CSubst` a successful check produces. The subclasses add nothing to the
 * state; they re-derive their structured view (`lhs`/`rhs`/`sort`,
 * `preConstraints`/`lastConstraint`) from those two terms every time it is
 * asked for, which is where their round-trip quirks come from.
 */

import { CSubst } from "@kframework-ts/cterm";
import {
  buildClaim,
  extractLhs,
  extractRhs,
  flattenLabel,
  fromDict as kastFromDict,
  toDict as kastToDict,
  type KApply,
  type KClaim,
  type KDefinition,
  type KInner,
  type KSort,
  type Subst,
  sentenceLabel,
} from "@kframework-ts/kast";
import { BOOL, FALSE, TRUE } from "@kframework-ts/kast/prelude/kbool";
import { GENERATED_TOP_CELL } from "@kframework-ts/kast/prelude/k";
import { mlAnd, mlEquals, mlEqualsFalse, mlEqualsTrue } from "@kframework-ts/kast/prelude/ml";

import { baseProofDict, Proof, ProofError, type ProofOptions } from "./proof.js";
import { ProofStatus } from "./status.js";
import type { ImpliesProofResult, ImpliesProofStep } from "./step.js";
import { EqualitySummary, RefutationSummary, type ProofSummary } from "./summary.js";

/**
 * The warning `EqualityProof` and `RefutationProof` log on every construction
 * (`implies.py:182-184`, `:326-328`), verbatim.
 *
 * This package has no logger, so the caveat is a value and a README section
 * rather than a line on stderr. It is not decorative: both proof kinds check
 * an implication whose soundness the haskell backend does not guarantee.
 */
export const IMPLIES_SOUNDNESS_WARNING =
  "Building an EqualityProof that has known soundness issues: " +
  "See https://github.com/runtimeverification/haskell-backend/issues/3605.";

/** Constructor options shared by the implies family (`implies.py:50-62`). */
export interface ImpliesProofOptions extends ProofOptions {
  /**
   * `bind_universally` (`implies.py:55`). Never serialized: both subclasses
   * hardcode `true` and `from_dict` does not read it, so a proof read back
   * from disk always binds universally regardless of what was written.
   */
  readonly bindUniversally?: boolean | undefined;
  readonly simplifiedAntecedent?: KInner | undefined;
  readonly simplifiedConsequent?: KInner | undefined;
  readonly csubst?: CSubst | undefined;
}

/** `ImpliesProof` (`implies.py:42-150`). */
export class ImpliesProof extends Proof {
  antecedent: KInner;
  consequent: KInner;
  bindUniversally: boolean;
  simplifiedAntecedent: KInner | undefined;
  simplifiedConsequent: KInner | undefined;
  csubst: CSubst | undefined;

  constructor(id: string, antecedent: KInner, consequent: KInner, options: ImpliesProofOptions = {}) {
    super(id, options);
    this.antecedent = antecedent;
    this.consequent = consequent;
    this.bindUniversally = options.bindUniversally ?? false;
    this.simplifiedAntecedent = options.simplifiedAntecedent;
    this.simplifiedConsequent = options.simplifiedConsequent;
    this.csubst = options.csubst;
  }

  override get proofType(): string {
    return "ImpliesProof";
  }

  /** `ImpliesProof.own_status` (`implies.py:86-94`). */
  override get ownStatus(): ProofStatus {
    if (this.admitted) return ProofStatus.PASSED;
    if (this.simplifiedAntecedent === undefined || this.simplifiedConsequent === undefined) {
      return ProofStatus.PENDING;
    }
    if (this.csubst === undefined) return ProofStatus.FAILED;
    return ProofStatus.PASSED;
  }

  /** `ImpliesProof.can_progress` (`implies.py:96-98`). */
  override get canProgress(): boolean {
    return this.simplifiedAntecedent === undefined || this.simplifiedConsequent === undefined;
  }

  /**
   * `ImpliesProof.get_steps` (`implies.py:69-72`) — at most one step, ever.
   *
   * The step carries the proof's data rather than the proof itself; see
   * {@link ImpliesProofStep} for why that diverges from upstream.
   *
   * **Hazard, inherited.** "Can progress" is *not* "is pending": an admitted
   * proof, or one whose subproof already failed, still offers this step, and
   * `ImpliesProver` then declines it without producing a result. Since only a
   * result mutates the proof, `getSteps()` goes on offering the same step
   * forever — upstream loops here too (`proof.py:597-612`). Check `status`, or
   * pass `maxIterations`, before advancing a proof that is not `PENDING`.
   */
  getSteps(): readonly ImpliesProofStep[] {
    if (!this.canProgress) return Object.freeze([]);
    return Object.freeze([
      Object.freeze({
        proofId: this.id,
        proofType: this.proofType,
        antecedent: this.antecedent,
        consequent: this.consequent,
        bindUniversally: this.bindUniversally,
        status: this.status,
      }),
    ]);
  }

  /**
   * `ImpliesProof.commit` (`implies.py:74-82`) — the only mutator.
   *
   * Upstream type-checks the result at runtime and raises `ValueError`
   * otherwise; the union type is that check here.
   */
  commit(result: ImpliesProofResult): void {
    this.csubst = result.csubst;
    this.simplifiedAntecedent = result.simplifiedAntecedent;
    this.simplifiedConsequent = result.simplifiedConsequent;
  }

  /** `ImpliesProof.dict` (`implies.py:138-150`). */
  override get dict(): Readonly<Record<string, unknown>> {
    const dct: Record<string, unknown> = baseProofDict(this);
    dct["type"] = this.proofType;
    dct["antecedent"] = kastToDict(this.antecedent);
    dct["consequent"] = kastToDict(this.consequent);
    if (this.simplifiedAntecedent !== undefined) dct["simplified_antecedent"] = kastToDict(this.simplifiedAntecedent);
    if (this.simplifiedConsequent !== undefined) dct["simplified_consequent"] = kastToDict(this.simplifiedConsequent);
    if (this.csubst !== undefined) dct["csubst"] = this.csubst.toDict();
    return dct;
  }

  /** `ImpliesProof.from_dict` (`implies.py:112-136`). */
  static fromDict(value: unknown, options: ProofOptions = {}): ImpliesProof {
    const parts = decodeImpliesDict(value);
    return new ImpliesProof(parts.id, parts.antecedent, parts.consequent, {
      ...options,
      ...parts.optional,
      admitted: parts.admitted,
      subproofIds: parts.subproofIds,
    });
  }
}

/** The shape both subclasses need out of an `ImpliesProof` dictionary. */
interface ImpliesDictParts {
  readonly id: string;
  readonly antecedent: KInner;
  readonly consequent: KInner;
  readonly admitted: boolean;
  readonly subproofIds: readonly string[];
  readonly optional: {
    readonly simplifiedAntecedent?: KInner;
    readonly simplifiedConsequent?: KInner;
    readonly csubst?: CSubst;
  };
}

function decodeImpliesDict(value: unknown): ImpliesDictParts {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ProofError("Expected an object for an ImpliesProof dictionary");
  }
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  const dct = value as Readonly<Record<string, unknown>>;
  const id = dct["id"];
  if (typeof id !== "string") throw new ProofError("ImpliesProof dictionary is missing a string id");
  const subproofIds = dct["subproof_ids"];
  if (!Array.isArray(subproofIds) || !subproofIds.every((entry) => typeof entry === "string")) {
    throw new ProofError(`ImpliesProof ${id} dictionary subproof_ids must be an array of strings`);
  }
  return {
    id,
    antecedent: kastFromDict(dct["antecedent"], `${id}.antecedent`),
    consequent: kastFromDict(dct["consequent"], `${id}.consequent`),
    admitted: dct["admitted"] === true,
    subproofIds,
    optional: {
      ...("simplified_antecedent" in dct
        ? { simplifiedAntecedent: kastFromDict(dct["simplified_antecedent"], `${id}.simplified_antecedent`) }
        : {}),
      ...("simplified_consequent" in dct
        ? { simplifiedConsequent: kastFromDict(dct["simplified_consequent"], `${id}.simplified_consequent`) }
        : {}),
      ...("csubst" in dct ? { csubst: CSubst.fromDict(dct["csubst"]) } : {}),
    },
  };
}

/** Constructor options for {@link EqualityProof} (`implies.py:154-167`). */
export interface EqualityProofOptions extends ProofOptions {
  readonly constraints?: Iterable<KInner> | undefined;
  readonly simplifiedConstraints?: KInner | undefined;
  readonly simplifiedEquality?: KInner | undefined;
  readonly csubst?: CSubst | undefined;
}

/**
 * `EqualityProof` (`implies.py:153-281`) — "LHS equals RHS under these
 * constraints", encoded as `mlAnd(constraints) #Implies (lhs #Equals rhs)`.
 *
 * See {@link IMPLIES_SOUNDNESS_WARNING}.
 */
export class EqualityProof extends ImpliesProof {
  constructor(id: string, lhsBody: KInner, rhsBody: KInner, sort: KSort, options: EqualityProofOptions = {}) {
    super(id, mlAnd(options.constraints ?? []), mlEquals(lhsBody, rhsBody, sort, GENERATED_TOP_CELL), {
      ...options,
      bindUniversally: true,
      ...(options.simplifiedConstraints === undefined ? {} : { simplifiedAntecedent: options.simplifiedConstraints }),
      ...(options.simplifiedEquality === undefined ? {} : { simplifiedConsequent: options.simplifiedEquality }),
    });
  }

  override get proofType(): string {
    return "EqualityProof";
  }

  /** `EqualityProof.equality` (`implies.py:206-209`). */
  get equality(): KApply {
    if (this.consequent.node !== "KApply") throw new ProofError(`EqualityProof ${this.id} consequent is not a KApply`);
    return this.consequent;
  }

  get lhsBody(): KInner {
    return argument(this.equality, 0, this.id);
  }

  get rhsBody(): KInner {
    return argument(this.equality, 1, this.id);
  }

  /** `EqualityProof.sort` (`implies.py:219-221`) — the `#Equals` argument sort. */
  get sort(): KSort {
    const params = this.equality.label.params;
    const sort = params[0];
    if (sort === undefined) throw new ProofError(`EqualityProof ${this.id} equality label has no argument sort`);
    return sort;
  }

  get constraint(): KInner {
    return this.antecedent;
  }

  get constraints(): readonly KInner[] {
    return flattenLabel("#And", this.constraint);
  }

  get simplifiedConstraints(): KInner | undefined {
    return this.simplifiedAntecedent;
  }

  get simplifiedEquality(): KInner | undefined {
    return this.simplifiedConsequent;
  }

  /** `EqualityProof.summary` (`implies.py:279-281`). */
  override get summary(): ProofSummary {
    return new EqualitySummary(this.id, this.status, this.admitted);
  }

  /** `EqualityProof.from_dict` (`implies.py:239-255`). */
  static override fromDict(value: unknown, options: ProofOptions = {}): EqualityProof {
    const parts = decodeImpliesDict(value);
    if (parts.consequent.node !== "KApply") {
      throw new ProofError(`EqualityProof ${parts.id} consequent is not a KApply`);
    }
    const sort = parts.consequent.label.params[0];
    if (sort === undefined) throw new ProofError(`EqualityProof ${parts.id} equality label has no argument sort`);
    return new EqualityProof(
      parts.id,
      argument(parts.consequent, 0, parts.id),
      argument(parts.consequent, 1, parts.id),
      sort,
      {
        ...options,
        constraints: flattenLabel("#And", parts.antecedent),
        ...(parts.optional.simplifiedAntecedent === undefined
          ? {}
          : { simplifiedConstraints: parts.optional.simplifiedAntecedent }),
        ...(parts.optional.simplifiedConsequent === undefined
          ? {}
          : { simplifiedEquality: parts.optional.simplifiedConsequent }),
        ...(parts.optional.csubst === undefined ? {} : { csubst: parts.optional.csubst }),
        admitted: parts.admitted,
        subproofIds: parts.subproofIds,
      },
    );
  }

  /**
   * `EqualityProof.from_claim` (`implies.py:195-204`).
   *
   * The claim must be a functional equation: a non-trivial `ensures` clause has
   * nowhere to go in this encoding and is rejected rather than dropped.
   */
  static fromClaim(claim: KClaim, defn: KDefinition, options: ProofOptions = {}): EqualityProof {
    const claimBody = defn.addSortParams(claim.body);
    const sort = defn.sortStrict(claimBody);
    const lhsBody = extractLhs(claimBody);
    const rhsBody = extractRhs(claimBody);
    // `claim.ensures is None or claim.ensures == TRUE`; the TS `KClaim` always
    // has an `ensures`, defaulting to the `true` token.
    if (!(claim.ensures.node === "KToken" && claim.ensures.token === "true")) {
      throw new ProofError(
        `Cannot convert claim to EqualityProof due to non-trival ensures clause ${JSON.stringify(kastToDict(claim.ensures))}`,
      );
    }
    const constraints = flattenLabel("_andBool_", claim.requires).map((c) => mlEquals(TRUE, c, BOOL));
    return new EqualityProof(sentenceLabel(claim), lhsBody, rhsBody, sort, { ...options, constraints });
  }
}

/** Constructor options for {@link RefutationProof} (`implies.py:300-311`). */
export interface RefutationProofOptions extends ProofOptions {
  readonly simplifiedAntecedent?: KInner | undefined;
  readonly simplifiedConsequent?: KInner | undefined;
  readonly csubst?: CSubst | undefined;
}

/**
 * `RefutationProof` (`implies.py:299-395`) — "these constraints make that last
 * branch condition false".
 *
 * See {@link IMPLIES_SOUNDNESS_WARNING}, and {@link RefutationProof.preConstraints}
 * for the round-trip asymmetry this encoding has.
 */
export class RefutationProof extends ImpliesProof {
  constructor(
    id: string,
    preConstraints: Iterable<KInner>,
    lastConstraint: KInner,
    options: RefutationProofOptions = {},
  ) {
    super(id, mlAnd([...preConstraints].map((c) => mlEqualsTrue(c))), mlEqualsFalse(lastConstraint), {
      ...options,
      bindUniversally: true,
    });
  }

  override get proofType(): string {
    return "RefutationProof";
  }

  /**
   * `RefutationProof.pre_constraints` (`implies.py:339-341`).
   *
   * This returns the `#Equals(true, _)` *wrappers* the constructor built, not
   * the raw boolean constraints it was given — and `from_dict` feeds the
   * result straight back into the constructor, which wraps them again. Every
   * disk round trip therefore adds one `#Equals(true, ·)` layer. This is
   * upstream behavior, confirmed against pyk at the pinned release and pinned
   * by a test here; it is semantically inert (`true #Equals (true #Equals c)`
   * is `c`) but structurally visible.
   */
  get preConstraints(): readonly KInner[] {
    return flattenLabel("#And", this.antecedent);
  }

  /** `RefutationProof.last_constraint` (`implies.py:343-346`). */
  get lastConstraint(): KInner {
    if (this.consequent.node !== "KApply") {
      throw new ProofError(`RefutationProof ${this.id} consequent is not a KApply`);
    }
    return argument(this.consequent, 1, this.id);
  }

  get simplifiedConstraints(): KInner | undefined {
    return this.simplifiedAntecedent;
  }

  /** `RefutationProof.summary` (`implies.py:374-376`). */
  override get summary(): ProofSummary {
    return new RefutationSummary(this.id, this.status);
  }

  /**
   * `RefutationProof.to_claim` (`implies.py:388-395`).
   *
   * The generic `build_claim`, not `cterm_build_claim`: the "configuration"
   * here is a `Bool` term, not a cell, so it never passes through a `CTerm`.
   */
  toClaim(claimId: string): readonly [claim: KClaim, varMap: Subst] {
    return buildClaim(claimId, this.lastConstraint, FALSE, { initConstraints: this.preConstraints });
  }

  /** `RefutationProof.from_dict` (`implies.py:352-366`). */
  static override fromDict(value: unknown, options: ProofOptions = {}): RefutationProof {
    const parts = decodeImpliesDict(value);
    if (parts.consequent.node !== "KApply") {
      throw new ProofError(`RefutationProof ${parts.id} consequent is not a KApply`);
    }
    return new RefutationProof(
      parts.id,
      flattenLabel("#And", parts.antecedent),
      argument(parts.consequent, 1, parts.id),
      { ...options, ...parts.optional, admitted: parts.admitted, subproofIds: parts.subproofIds },
    );
  }
}

function argument(term: KApply, index: number, id: string): KInner {
  const arg = term.args[index];
  if (arg === undefined)
    throw new ProofError(`Proof ${id}: expected at least ${index + 1} arguments on ${term.label.name}`);
  return arg;
}
