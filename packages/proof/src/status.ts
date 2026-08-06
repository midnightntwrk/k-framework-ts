/** `ProofStatus` and the status composition over subproofs (`proof/proof.py:32-213`). */

/**
 * `ProofStatus` (`proof.py:32-35`).
 *
 * A string union rather than an enum class: the three values are the exact
 * strings pyk's `Enum` carries, so a status crosses a process boundary as
 * itself. Status is *never* serialized by either proof schema — it is always
 * derived — so this type appears only in memory and in rendered summaries.
 */
export type ProofStatus = "passed" | "failed" | "pending";

/** pyk-shaped namespace, so `ProofStatus.PASSED` reads the way the source does. */
export const ProofStatus = {
  PASSED: "passed",
  FAILED: "failed",
  PENDING: "pending",
} as const satisfies Record<string, ProofStatus>;

/**
 * Render a status the way Python's `str(ProofStatus.PASSED)` does.
 *
 * Every upstream summary line interpolates the enum member, not its value, so
 * `f'    status: {self.status}'` prints `status: ProofStatus.PASSED`. Kontrol's
 * `foundry list` golden depends on exactly that spelling, so the summaries in
 * this package reproduce it rather than printing the wire value.
 */
export function formatProofStatus(status: ProofStatus): string {
  return `ProofStatus.${status.toUpperCase()}`;
}

/** Render a boolean the way Python does, for summary lines. */
export function formatPythonBool(value: boolean): string {
  return value ? "True" : "False";
}

/** The minimal view of a proof that status composition needs. */
export interface StatusLike {
  readonly status: ProofStatus;
}

/**
 * `Proof.subproofs_status` (`proof.py:180-187`).
 *
 * Note that an empty collection is `PASSED`: `all([])` is true.
 */
export function subproofsStatus(subproofs: Iterable<StatusLike>): ProofStatus {
  const statuses = [...subproofs].map((subproof) => subproof.status);
  if (statuses.includes(ProofStatus.FAILED)) return ProofStatus.FAILED;
  if (statuses.every((status) => status === ProofStatus.PASSED)) return ProofStatus.PASSED;
  return ProofStatus.PENDING;
}

/**
 * `Proof.status` (`proof.py:193-201`).
 *
 * `admitted` short-circuits to `PASSED` **before** the subproofs are consulted,
 * so an admitted proof passes even while a subproof fails. That ordering is
 * load-bearing upstream (`admit()` means "assume this"), not an accident.
 */
export function composeStatus(admitted: boolean, ownStatus: ProofStatus, subproofs: Iterable<StatusLike>): ProofStatus {
  if (admitted) return ProofStatus.PASSED;
  const subStatus = subproofsStatus(subproofs);
  if (ownStatus === ProofStatus.FAILED || subStatus === ProofStatus.FAILED) return ProofStatus.FAILED;
  if (ownStatus === ProofStatus.PENDING || subStatus === ProofStatus.PENDING) return ProofStatus.PENDING;
  return ProofStatus.PASSED;
}
