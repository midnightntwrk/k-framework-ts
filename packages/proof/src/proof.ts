/**
 * `Proof` — proof identity, subproofs, and derived status (`proof/proof.py:38-321`).
 *
 * Two deliberate departures from pyk, both consequences of keeping this entry
 * point pure:
 *
 * 1. **No generics.** Upstream's `Proof[PS, SR]` type parameters exist only so
 *    `parallel_advance_proof` can be written once; nothing downstream
 *    subclasses `Proof` or `Prover`. The step protocol arrives with the prover
 *    phase as concrete types.
 * 2. **Subproofs are supplied, not read.** `Proof.__init__` (`proof.py:74-76`)
 *    reads every `subproof_id` off disk during construction. A JavaScript
 *    constructor cannot await, so the recursive read lives in
 *    `@kframework-ts/proof/store`'s `readProofData`, which resolves the whole
 *    subproof forest and hands the objects to the constructor. Passing
 *    `subproofIds` without the matching `subproofs` is an error rather than a
 *    silent partial construction.
 *
 * Proofs use the directory store described by `store.ts`, which is the layout
 * pyk tools use across process boundaries. The hashed `<sha256(id)>.json`
 * layout and proof-object digest are outside this package's persistence
 * contract.
 */

import { BaseSummary, CompositeSummary, type ProofSummary } from "./summary.js";
import { composeStatus, ProofStatus } from "./status.js";

/** Raised when a proof is constructed or decoded inconsistently. */
export class ProofError extends Error {
  override readonly name = "ProofError";
}

/** `FailureInfo` (`proof.py:321`) — an empty marker upstream, a tag here. */
export interface FailureInfo {
  /** Rendered failure report, one entry per line. */
  print(): readonly string[];
}

/**
 * `Proof._PROOF_TYPES` (`proof.py:47`) — the deserialization whitelist.
 *
 * `ImpliesProof` is deliberately absent: a bare `ImpliesProof` written to disk
 * cannot be read back by pyk, and is not readable here either.
 */
export const PROOF_TYPES: readonly string[] = ["APRProof", "EqualityProof", "RefutationProof"];

/** Constructor options shared by every proof (`proof.py:61-67`). */
export interface ProofOptions {
  /** Directory holding *all* proofs, not this one's subdirectory. */
  readonly proofDir?: string | undefined;
  /** Already-resolved subproofs. See the module header for why these are not read here. */
  readonly subproofs?: Iterable<Proof> | undefined;
  /**
   * Ids the caller expects `subproofs` to supply. Optional; when given it is
   * checked against `subproofs`, which is how a truncated recursive read is
   * caught at the point it happens rather than at status time.
   */
  readonly subproofIds?: Iterable<string> | undefined;
  readonly admitted?: boolean | undefined;
}

/** A proof artifact: an id, a status, and a bag of subproofs. */
export abstract class Proof {
  readonly id: string;
  /** Root directory holding every proof; `undefined` for an in-memory proof. */
  proofDir: string | undefined;
  admitted: boolean;
  /** In-memory only — never serialized by either schema. */
  failureInfo: FailureInfo | undefined;

  readonly #subproofs = new Map<string, Proof>();

  protected constructor(id: string, options: ProofOptions = {}) {
    this.id = id;
    this.admitted = options.admitted ?? false;
    this.proofDir = options.proofDir;
    this.failureInfo = undefined;

    const subproofs = [...(options.subproofs ?? [])];
    const declared = options.subproofIds === undefined ? undefined : [...options.subproofIds];
    if (this.proofDir === undefined && (subproofs.length > 0 || (declared?.length ?? 0) > 0)) {
      // `proof.py:72-73`, verbatim in intent: subproofs live in the shared
      // proof directory, so without one they have nowhere to have come from.
      throw new ProofError(`Cannot read subproofs ${JSON.stringify(declared ?? [])} of proof ${id} with no proofDir`);
    }
    for (const subproof of subproofs) this.#subproofs.set(subproof.id, subproof);
    if (declared !== undefined) {
      const missing = declared.filter((subproofId) => !this.#subproofs.has(subproofId));
      if (missing.length > 0) {
        throw new ProofError(
          `Proof ${id} declares subproofs that were not supplied: ${missing.join(", ")}. ` +
            `Use readProofData from @kframework-ts/proof/store to resolve them from disk.`,
        );
      }
    }
  }

  /** The on-disk `type` discriminator; also the value written to `proof.json`. */
  abstract get proofType(): string;

  /** `Proof.own_status` (`proof.py:189-191`) — this proof alone, ignoring subproofs. */
  abstract get ownStatus(): ProofStatus;

  /** `Proof.can_progress` (`proof.py:203-205`). */
  abstract get canProgress(): boolean;

  /** The `Proof.dict` schema — see `codec.ts` for what distinguishes it from `proof.json`. */
  abstract get dict(): Readonly<Record<string, unknown>>;

  /** `Proof.subproof_ids` (`proof.py:90-92`) — insertion order, as upstream. */
  get subproofIds(): readonly string[] {
    return Object.freeze([...this.#subproofs.keys()]);
  }

  /** `Proof.subproofs` (`proof.py:175-178`). Never re-reads: this core is pure. */
  get subproofs(): readonly Proof[] {
    return Object.freeze([...this.#subproofs.values()]);
  }

  /** `Proof.add_subproof` (`proof.py:147-148`). */
  addSubproof(proof: Proof): void {
    this.#subproofs.set(proof.id, proof);
  }

  /** `Proof.remove_subproof` (`proof.py:150-151`). */
  removeSubproof(proofId: string): void {
    if (!this.#subproofs.delete(proofId)) throw new ProofError(`Proof ${this.id} has no subproof ${proofId}`);
  }

  getSubproof(proofId: string): Proof | undefined {
    return this.#subproofs.get(proofId);
  }

  /** `Proof.admit` (`proof.py:87-88`). */
  admit(): void {
    this.admitted = true;
  }

  /** `Proof.status` (`proof.py:193-201`); `admitted` short-circuits before subproofs. */
  get status(): ProofStatus {
    return composeStatus(this.admitted, this.ownStatus, this.subproofs);
  }

  get failed(): boolean {
    return this.status === ProofStatus.FAILED;
  }

  get passed(): boolean {
    return this.status === ProofStatus.PASSED;
  }

  /** `Proof.json` (`proof.py:266-268`). */
  get json(): string {
    return JSON.stringify(this.dict);
  }

  /** `Proof.summary` (`proof.py:270-282`). */
  get summary(): ProofSummary {
    return new CompositeSummary([
      new BaseSummary(this.id, this.status),
      ...this.subproofs.map((subproof) => subproof.summary),
    ]);
  }

  /** `Proof.one_line_summary` (`proof.py:284-286`) — the *name*, so `PASSED`. */
  get oneLineSummary(): string {
    return this.status.toUpperCase();
  }
}

/** The `Proof.dict` prefix every schema starts with (`proof.py:215-221`). */
export function baseProofDict(proof: Proof): Record<string, unknown> {
  return { id: proof.id, subproof_ids: [...proof.subproofIds], admitted: proof.admitted };
}
