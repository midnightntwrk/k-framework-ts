/**
 * Node-only persistence for pyk's proof-data directory layout.
 *
 * ```text
 * <proofDir>/
 *   <proofId>/
 *     proof.json
 *     kcfg/                 # APRProof only
 *       kcfg.json
 *       nodes/<n>.json
 *   <subproofId>/
 *     proof.json            # implies-family proofs: same layout, no kcfg/
 * ```
 *
 * This is the directory format pyk tools read and write across process
 * boundaries, and the format this package implements. The hashed
 * `<sha256(id)>.json` layout (`proof.py:94-109`) is outside this package's
 * persistence contract.
 *
 * Three behaviours are upstream's and are reproduced exactly:
 *
 * 1. **Proof ids are directory names, verbatim** (`proof.py:113`). Claim labels
 *    contain `.`, `%`, `(`, `)`, and `:` — Kontrol's are literally
 *    `test%Contract.f(uint256):0` — and nothing sanitises them.
 * 2. **`APRProof` does not write its subproofs** (`reachability.py:618-650`),
 *    while the implies family does (`proof.py:261-264` via `implies.py:100-110`).
 *    `refute_node` compensates by writing the refutation itself first.
 * 3. **A bare `ImpliesProof` cannot be read back** — the type whitelist is
 *    `{APRProof, EqualityProof, RefutationProof}` (`proof.py:47`).
 *
 * Divergence: pyk's `Proof.__init__` reads every subproof from disk during
 * construction. A JavaScript constructor cannot await, so {@link readProofData}
 * resolves the subproof forest first and hands the objects to the constructor.
 * The observable directory layout is unchanged.
 */

import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";

import type { KCFGNode, NodeIdLike } from "@kframework-ts/kcfg";
import { readKcfgStore, writeKcfgStore } from "@kframework-ts/kcfg/store";

import { APRProof } from "./apr.js";
import { EqualityProof, ImpliesProof, RefutationProof } from "./implies.js";
import { decodeProofLogs } from "./logs.js";
import { PROOF_TYPES, Proof, ProofError } from "./proof.js";
import { aprProofDataSchema, impliesProofDictSchema, type AprProofData } from "./schemas.js";

/** `Proof.proof_subdir` (`proof.py:55-59`) — where one proof's files live. */
export function proofSubdir(proofDir: string, id: string): string {
  return join(proofDir, id);
}

/** The `kcfg/` store directory belonging to one `APRProof`. */
export function proofKcfgDir(proofDir: string, id: string): string {
  return join(proofSubdir(proofDir, id), "kcfg");
}

/** `Proof.proof_data_exists` (`proof.py:111-114`). */
export async function proofDataExists(proofDir: string, id: string): Promise<boolean> {
  try {
    await readFile(join(proofSubdir(proofDir, id), "proof.json"), "utf8");
    return true;
  } catch {
    return false;
  }
}

/**
 * `Proof.read_proof_data` (`proof.py:244-259`) plus the per-type readers.
 *
 * Subproofs — and their subproofs — are read first, so the returned proof is a
 * complete forest. A cycle is reported rather than overflowing the stack;
 * upstream would recurse until Python gave up.
 */
export async function readProofData(proofDir: string, id: string): Promise<Proof> {
  return readProofDataInner(resolve(proofDir), id, []);
}

async function readProofDataInner(proofDir: string, id: string, stack: readonly string[]): Promise<Proof> {
  if (stack.includes(id)) {
    throw new ProofError(`Cycle in proof dependencies: ${[...stack, id].join(" -> ")}`);
  }
  const proofPath = join(proofSubdir(proofDir, id), "proof.json");
  const dct = await readJson(proofPath);
  const type = dct["type"];
  if (typeof type !== "string" || !PROOF_TYPES.includes(type)) {
    throw new ProofError(`Could not load Proof from file ${id}: ${proofPath}`);
  }

  if (!("subproof_ids" in dct)) {
    throw new ProofError(`Proof ${id} has no subproof_ids array: ${proofPath}`);
  }
  if (type === "APRProof") {
    const decoded = aprProofDataSchema.parse(dct);
    const subproofs = await readProofSubproofs(proofDir, decoded.subproof_ids, [...stack, id]);
    return readAprProofData(proofDir, id, decoded, subproofs);
  }

  const decoded = impliesProofDictSchema.parse(dct);
  const subproofs = await readProofSubproofs(proofDir, decoded.subproof_ids, [...stack, id]);
  const options = { proofDir, subproofs, subproofIds: decoded.subproof_ids };
  if (type === "EqualityProof") return EqualityProof.fromDict(decoded, options);
  return RefutationProof.fromDict(decoded, options);
}

async function readProofSubproofs(
  proofDir: string,
  ids: readonly string[],
  stack: readonly string[],
): Promise<Proof[]> {
  const subproofs: Proof[] = [];
  for (const subproofId of ids) subproofs.push(await readProofDataInner(proofDir, subproofId, stack));
  return subproofs;
}

/** `APRProof.read_proof_data` (`reachability.py:577-616`). */
async function readAprProofData(
  proofDir: string,
  id: string,
  dct: AprProofData,
  subproofs: readonly Proof[],
): Promise<APRProof> {
  const kcfg = await readKcfgStore(proofKcfgDir(proofDir, id));
  const nodeRefutations = new Map<number, string>();
  for (const [nodeId, proofId] of dct.node_refutations) {
    nodeRefutations.set(kcfg.resolve(nodeId), proofId);
  }
  const priorLoopsCache = new Map<number, readonly number[]>();
  for (const [nodeId, loops] of dct.loops_cache) {
    priorLoopsCache.set(nodeId, Object.freeze([...loops]));
  }

  return new APRProof(
    id,
    kcfg,
    dct.terminal,
    integer(dct.init, `${id}.init`),
    integer(dct.target, `${id}.target`),
    decodeProofLogs(dct.logs, `${id}.logs`),
    {
      proofDir,
      subproofs,
      subproofIds: dct.subproof_ids,
      bounded: dct.bounded,
      ...(dct.bmc_depth === undefined ? {} : { bmcDepth: integer(dct.bmc_depth, `${id}.bmc_depth`) }),
      circularity: dct.circularity,
      admitted: dct.admitted,
      execTime: dct.execution_time ?? 0,
      nodeRefutations,
      priorLoopsCache,
    },
  );
}

/**
 * `Proof.write_proof_data` and its overrides.
 *
 * `APRProof` writes `proof.json` and its `kcfg/` store and stops
 * (`reachability.py:618-650`); the implies family writes its subproofs first
 * (`proof.py:261-264`, `implies.py:100-110`). A proof with no `proofDir` is a
 * no-op, as upstream.
 */
export async function writeProofData(proof: Proof): Promise<void> {
  const proofDir = proof.proofDir;
  if (proofDir === undefined) return;
  if (proof instanceof ImpliesProof) {
    for (const subproof of proof.subproofs) await writeProofData(subproof);
  }
  const subdir = proofSubdir(proofDir, proof.id);
  await mkdir(subdir, { recursive: true });
  const document = proof instanceof APRProof ? proof.proofDataDict : proof.dict;
  await writeStagedJson(join(subdir, "proof.json"), document);
  if (proof instanceof APRProof) await writeKcfgStore(join(subdir, "kcfg"), proof.kcfg);
}

/**
 * `Proof.read_subproof_data` (`proof.py:139-145`) — read one subproof from the
 * shared proof directory and attach it, replacing any cached copy.
 */
export async function readSubproofData(proof: Proof, subproofId: string): Promise<Proof> {
  const proofDir = proof.proofDir;
  if (proofDir === undefined) {
    throw new ProofError(`Cannot add subproof to the proof ${proof.id} with no proofDir`);
  }
  if (!(await proofDataExists(proofDir, subproofId))) {
    throw new ProofError(`Cannot find subproof ${subproofId} in parent proof's ${proof.id} proofDir ${proofDir}`);
  }
  const subproof = await readProofData(proofDir, subproofId);
  proof.addSubproof(subproof);
  return subproof;
}

//////////////////////////
// Node refutations     //
//////////////////////////

/**
 * `APRProof.refute_node` (`reachability.py:651-663`).
 *
 * Upstream this is a method, but it writes **three** things — the refutation's
 * own proof directory, then the parent's `proof.json` — so it cannot live in
 * the browser-safe entry point. The pure half,
 * {@link APRProof.constructNodeRefutation}, does; this function is the
 * ordering around it, and the order matters: the refutation must be on disk
 * before the parent names it, because a reader resolves `subproof_ids`
 * recursively and `APRProof.write_proof_data` does *not* recurse into
 * subproofs.
 *
 * Returns `undefined` when the node cannot be refuted; see
 * {@link APRProof.constructNodeRefutation} for the four reasons.
 */
export async function refuteNode(proof: APRProof, node: KCFGNode | NodeIdLike): Promise<RefutationProof | undefined> {
  const refutation = proof.constructNodeRefutation(node);
  if (refutation === undefined) return undefined;
  await writeProofData(refutation);
  proof.nodeRefutations.set(proof.kcfg.resolve(typeof node === "object" && "id" in node ? node.id : node), refutation);
  await writeProofData(proof);
  return refutation;
}

/**
 * `APRProof.unrefute_node` (`reachability.py:665-670`).
 *
 * Drops the refutation as a subproof *and* as a node refutation, then
 * rewrites the parent. The refutation's own directory is deliberately left on
 * disk, exactly as upstream leaves it: nothing deletes proof data.
 *
 * Upstream's `remove_subproof` raises when there is no such subproof and its
 * `del` raises when the node was never refuted; both are errors here too, the
 * first one reached first.
 */
export async function unrefuteNode(proof: APRProof, node: KCFGNode | NodeIdLike): Promise<void> {
  const nodeId = proof.kcfg.resolve(typeof node === "object" && "id" in node ? node.id : node);
  proof.removeSubproof(proof.getRefutationId(nodeId));
  if (!proof.nodeRefutations.delete(nodeId)) {
    throw new ProofError(`Proof ${proof.id} has no refutation for node ${nodeId}`);
  }
  await writeProofData(proof);
}

//////////////////////////
// JSON plumbing        //
//////////////////////////

async function readJson(path: string): Promise<Readonly<Record<string, unknown>>> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    throw new ProofError(`Could not read proof file ${path}`, { cause: error });
  }
  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch (error) {
    throw new ProofError(`Invalid JSON in proof file ${path}`, { cause: error });
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ProofError(`Expected a JSON object in proof file ${path}`);
  }
  // The three checks above are the whole structural guarantee this decoder needs.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  return value as Readonly<Record<string, unknown>>;
}

/** Write through a staged sibling so a killed process cannot leave a torn file. */
async function writeStagedJson(path: string, value: unknown): Promise<void> {
  const text = JSON.stringify(value);
  const staged = join(dirname(path), `.${randomUUID()}.${basename(path)}.tmp`);
  try {
    await writeFile(staged, text, "utf8");
    await rename(staged, path);
  } catch (error) {
    await rm(staged, { force: true });
    throw error;
  }
}

function integer(value: unknown, where: string): number {
  const id = typeof value === "string" ? Number(value) : value;
  if (typeof id !== "number" || !Number.isSafeInteger(id)) throw new ProofError(`Expected an integer for ${where}`);
  return id;
}
