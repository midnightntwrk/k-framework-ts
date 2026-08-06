/**
 * `@kframework-ts/proof/prove` — everything that talks to a backend.
 *
 * The main entry point is the proof *artifact* layer and is browser-safe;
 * `./store` adds the filesystem; this subpath adds the prover, and therefore
 * both. Keeping the split visible in the import path is what stops a
 * pure-data consumer from accidentally depending on `node:fs`.
 *
 * ```ts
 * import { APRProof } from "@kframework-ts/proof";
 * import { APRProver, advanceProof } from "@kframework-ts/proof/prove";
 *
 * const proof = APRProof.fromClaim(definition, claim);
 * const prover = new APRProver(kcfgExplore, { executeDepth: 1 });
 * await advanceProof(prover, proof);
 * console.log(proof.status);
 * ```
 *
 * Also here: {@link concurrentAdvanceProof}, the async-pool driver; the
 * {@link withExplore} session that owns a `kore-rpc` server and its clients;
 * and {@link proveClaims}, the spec-file-to-verdicts façade the CLI's `prove`
 * command is a thin shell over.
 *
 * ```ts
 * import { proveClaims } from "@kframework-ts/proof/prove";
 *
 * const verdicts = await proveClaims({
 *   definitionDir: "imp-verification-kompiled",
 *   specFile: "imp-simple-spec.k",
 *   specModuleName: "IMP-SIMPLE-SPEC",
 *   proofDir: "proofs",
 *   maxWorkers: 4,
 * });
 * ```
 */

export * from "./digest.js";
export * from "./prover.js";
export * from "./apr-prover.js";
export * from "./implies-prover.js";
export * from "./parallel.js";
export * from "./explore.js";
export * from "./facade.js";
