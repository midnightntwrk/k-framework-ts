/**
 * Digest-gated proof resume — `KClaimJob` and `init_claim_jobs`
 * (`kevm-pyk/src/kevm_pyk/__main__.py:172-231`, used at `:290-307`, `:359`).
 *
 * Resuming a proof from `<proofDir>/<id>/` is only sound while the *claim* that
 * proof was built from has not changed. Nothing in the stored proof records
 * which claim that was, so the check has to live beside it: a `digest` file
 * mapping each claim label to a hash of the claim and of everything it depends
 * on. A run whose digest matches resumes; a run whose digest moved starts over.
 * That is the whole idempotency contract — same spec, same answer, no work; new
 * spec, no stale graph.
 *
 * # Digest-based resume
 *
 * This module hashes each claim and its dependencies, then uses the resulting
 * digest to decide whether an on-disk proof can resume. It follows
 * `kevm-pyk`'s claim-based mechanism. This is distinct from pyk's
 * `Proof.digest`/`Proof.up_to_date` pair (`proof/proof.py:116-129`): it hashes
 * the proof object and checks the hashed flat-file path, but line 125 hashes
 * Python's builtin `id` rather than `self.id`, so `up_to_date` is always
 * `False`. That mechanism is outside this package's persistence contract.
 *
 * # Fidelity
 *
 * `claimHash` is **byte-identical** to upstream's:
 * `hash_str(json.dumps(claim.to_dict(), sort_keys=True))` is exactly
 * `@kframework-ts/kast`'s `hashOfDict(sentenceToDict(claim))` — same sorted
 * keys, same `", "`/`": "` separators, same sha256 of the UTF-8 bytes. The
 * digest *file* is byte-identical too: `json.dumps(..., indent=4)` and
 * `JSON.stringify(..., null, 4)` agree once an indent is in play.
 *
 * Two deliberate deviations:
 *
 * 1. **Dependency digests are concatenated in sorted order.** Upstream joins
 *    them in `frozenset` iteration order (`__main__.py:180`), which is CPython
 *    hash order — reproducible for one interpreter build and meaningless
 *    across them. Sorting agrees with upstream for the zero- and
 *    one-dependency claims that are almost all of them, and is deterministic
 *    for the rest, which C4 requires of every artifact this repo writes.
 * 2. **The lock waits with a bound.** `SoftFileLock` blocks forever by default;
 *    an agent-driven run that blocks forever on a stale lock file is a hang
 *    with no diagnosis, so {@link DIGEST_LOCK_TIMEOUT_MS} bounds the wait and
 *    the failure names the lock file.
 *
 * A digest mismatch is never corruption: it costs a re-initialisation, which is
 * the same thing `--reinit` asks for.
 */

import { createHash } from "node:crypto";
import { mkdir, open, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { claimDependencies, hashOfDict, sentenceLabel, sentenceToDict, type KClaim } from "@kframework-ts/kast";

import { ProofError } from "./proof.js";

/** `digest_file = save_directory / 'digest'` (`kevm_pyk/__main__.py:274`). */
export const DIGEST_FILE_NAME = "digest";

/** How long {@link updateClaimDigest} and friends wait for the lock before giving up. */
export const DIGEST_LOCK_TIMEOUT_MS = 30_000;

/** The digest file belonging to a proof directory. */
export function digestFilePath(proofDir: string): string {
  return join(proofDir, DIGEST_FILE_NAME);
}

/** `hash_str` (`pyk/utils.py:373-376`) — sha256 hex of a string's UTF-8 bytes. */
export function hashStr(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/**
 * `hash_str(json.dumps(claim.to_dict(), sort_keys=True, cls=JSONEncoder))`
 * (`kevm_pyk/__main__.py:181`).
 *
 * The `JSONEncoder` upstream installs only intercepts `FrozenDict`, which a
 * `KClaim` dict does not contain at this release, so it is not modelled.
 */
export function claimHash(claim: KClaim): string {
  return hashOfDict(sentenceToDict(claim));
}

/**
 * `init_claim_jobs` + `KClaimJob.digest`
 * (`kevm_pyk/__main__.py:174-182`, `:210-231`) — every claim's digest, keyed by
 * label.
 *
 * A claim's digest is `hash_str(claimHash + concat(dependency digests))`, so a
 * change anywhere in the dependency closure re-initialises everything above it.
 * Dependency labels resolve either verbatim or under `<specModuleName>.`, as
 * upstream's two-step lookup does. A dependency cycle is reported rather than
 * recursed into; upstream would exhaust the Python stack.
 *
 * **Deviation: an unresolvable dependency label contributes the label itself**
 * where upstream raises `ValueError` (`__main__.py:221`). kevm-pyk's loader
 * always closes the selection over `depends`, so upstream cannot reach this
 * state; `proveClaims` can, because `includeDependencies: false` and an
 * explicit `claimLabels` are both supported here. Raising would turn one
 * claim's unmet dependency into a failure of the whole batch, which is exactly
 * what the façade exists not to do. Substituting the label keeps the digest
 * deterministic and still sensitive to every claim the run *did* load; it
 * simply cannot see through to text the run never read.
 */
export function claimDigests(claims: readonly KClaim[], specModuleName?: string): ReadonlyMap<string, string> {
  const byLabel = new Map<string, KClaim>();
  for (const claim of claims) byLabel.set(sentenceLabel(claim), claim);

  const digests = new Map<string, string>();

  const digestOf = (label: string, stack: readonly string[]): string => {
    const known = digests.get(label);
    if (known !== undefined) return known;
    if (stack.includes(label)) {
      throw new ProofError(`Cycle in claim dependencies: ${[...stack, label].join(" -> ")}`);
    }
    const claim =
      byLabel.get(label) ?? (specModuleName === undefined ? undefined : byLabel.get(`${specModuleName}.${label}`));
    // Not loaded, so there is no text to hash: see the deviation above.
    if (claim === undefined) return label;
    const dependencies = claimDependencies(claim)
      .map((dependency) => digestOf(dependency, [...stack, label]))
      .toSorted();
    const digest = hashStr(`${claimHash(claim)}${dependencies.join("")}`);
    digests.set(label, digest);
    return digest;
  };

  for (const label of byLabel.keys()) digestOf(label, []);
  return digests;
}

/**
 * `KClaimJob.up_to_date` (`kevm_pyk/__main__.py:184-193`).
 *
 * `false` for every reason upstream gives one: no digest file, no `claims`
 * object in it, no entry for this label, or an entry that does not match. A
 * file that is not readable JSON is treated the same way rather than raising —
 * a corrupt digest file must cost a re-run, not the run.
 */
export function claimUpToDate(digestFile: string, label: string, digest: string): Promise<boolean> {
  return withDigestLock(digestFile, async () => (await readDigestClaims(digestFile))[label] === digest);
}

/**
 * `KClaimJob.update_digest` (`kevm_pyk/__main__.py:195-206`).
 *
 * Read-modify-write under the lock, preserving any other key the file carries
 * and any other claim's entry, and `indent=4` on the way out.
 */
export async function updateClaimDigest(digestFile: string, label: string, digest: string): Promise<void> {
  await mkdir(dirname(digestFile), { recursive: true });
  await withDigestLock(digestFile, async () => {
    const document = await readDigestDocument(digestFile);
    const claims = { ...(await readDigestClaims(digestFile)), [label]: digest };
    await writeFile(digestFile, JSON.stringify({ ...document, claims }, null, 4), "utf8");
  });
}

/** The `claims` object of a digest file, or an empty one for every reason it might not be there. */
async function readDigestClaims(digestFile: string): Promise<Readonly<Record<string, string>>> {
  const claims = (await readDigestDocument(digestFile))["claims"];
  if (typeof claims !== "object" || claims === null || Array.isArray(claims)) return {};
  const out: Record<string, string> = {};
  for (const [label, digest] of Object.entries(claims)) if (typeof digest === "string") out[label] = digest;
  return out;
}

async function readDigestDocument(digestFile: string): Promise<Readonly<Record<string, unknown>>> {
  let text: string;
  try {
    text = await readFile(digestFile, "utf8");
  } catch {
    return {};
  }
  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch {
    return {};
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
  // The three checks above are the whole structural guarantee this decoder needs.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  return value as Readonly<Record<string, unknown>>;
}

/**
 * `SoftFileLock(f'{digest_file}.lock')` (`kevm_pyk/__main__.py:185`, `:198`).
 *
 * "Soft" is the filelock backend that takes the lock by *creating* a file, so
 * `open(..., 'wx')` is the same primitive; the poll interval and the bounded
 * wait are this package's, for the reason in the module header. Two separate
 * lock acquisitions — one to read, one to write — is upstream's shape too, so
 * the check-then-update window it leaves open is reproduced rather than closed.
 */
async function withDigestLock<T>(digestFile: string, body: () => Promise<T>): Promise<T> {
  const lockFile = `${digestFile}.lock`;
  const deadline = Date.now() + DIGEST_LOCK_TIMEOUT_MS;
  for (;;) {
    try {
      const handle = await open(lockFile, "wx");
      await handle.close();
      break;
    } catch (error) {
      if (Date.now() >= deadline) {
        throw new ProofError(`Timed out after ${DIGEST_LOCK_TIMEOUT_MS}ms waiting for the digest lock ${lockFile}`, {
          cause: error,
        });
      }
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 10);
      });
    }
  }
  try {
    return await body();
  } finally {
    await rm(lockFile, { force: true });
  }
}
