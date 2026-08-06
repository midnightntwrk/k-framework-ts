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

  const subproofIds = dct["subproof_ids"];
  if (!Array.isArray(subproofIds) || !subproofIds.every((entry) => typeof entry === "string")) {
    throw new ProofError(`Proof ${id} has no subproof_ids array: ${proofPath}`);
  }
  const subproofs: Proof[] = [];
  for (const subproofId of subproofIds) {
    subproofs.push(await readProofDataInner(proofDir, subproofId, [...stack, id]));
  }
  const options = { proofDir, subproofs, subproofIds };

  if (type === "EqualityProof") return EqualityProof.fromDict(dct, options);
  if (type === "RefutationProof") return RefutationProof.fromDict(dct, options);
  return readAprProofData(proofDir, id, dct, subproofs);
}

/** `APRProof.read_proof_data` (`reachability.py:577-616`). */
async function readAprProofData(
  proofDir: string,
  id: string,
  dct: Readonly<Record<string, unknown>>,
  subproofs: readonly Proof[],
): Promise<APRProof> {
  const kcfg = await readKcfgStore(proofKcfgDir(proofDir, id));
  const nodeRefutations = new Map<number, string>();
  for (const [key, proofId] of Object.entries(requiredObject(dct, "node_refutations", id))) {
    if (typeof proofId !== "string") throw new ProofError(`Proof ${id}: node_refutations[${key}] must be a proof id`);
    nodeRefutations.set(kcfg.resolve(Number(key)), proofId);
  }
  const priorLoopsCache = new Map<number, readonly number[]>();
  for (const [key, loops] of Object.entries(optionalObject(dct["loops_cache"], `${id}.loops_cache`))) {
    if (!Array.isArray(loops) || !loops.every((entry) => typeof entry === "number")) {
      throw new ProofError(`Proof ${id}: loops_cache[${key}] must be an array of node ids`);
    }
    priorLoopsCache.set(Number(key), Object.freeze([...loops]));
  }

  return new APRProof(
    id,
    kcfg,
    numbers(required(dct, "terminal", id), `${id}.terminal`),
    integer(required(dct, "init", id), `${id}.init`),
    integer(required(dct, "target", id), `${id}.target`),
    decodeProofLogs(required(dct, "logs", id), `${id}.logs`),
    {
      proofDir,
      subproofs,
      subproofIds: strings(required(dct, "subproof_ids", id), `${id}.subproof_ids`),
      bounded: numbers(required(dct, "bounded", id), `${id}.bounded`),
      ...("bmc_depth" in dct ? { bmcDepth: integer(dct["bmc_depth"], `${id}.bmc_depth`) } : {}),
      circularity: required(dct, "circularity", id) === true,
      admitted: required(dct, "admitted", id) === true,
      execTime: "execution_time" in dct ? Number(dct["execution_time"]) : 0,
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

function required(dct: Readonly<Record<string, unknown>>, key: string, id: string): unknown {
  if (!(key in dct)) throw new ProofError(`Proof ${id} proof.json is missing ${key}`);
  return dct[key];
}

function optionalObject(value: unknown, where: string): Readonly<Record<string, unknown>> {
  if (value === undefined) return {};
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ProofError(`Expected an object for ${where}`);
  }
  // The three checks above are the entire structural guarantee this decoder needs.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  return value as Readonly<Record<string, unknown>>;
}

function requiredObject(
  dct: Readonly<Record<string, unknown>>,
  key: string,
  id: string,
): Readonly<Record<string, unknown>> {
  return optionalObject(required(dct, key, id), `${id}.${key}`);
}

function numbers(value: unknown, where: string): readonly number[] {
  if (!Array.isArray(value) || !value.every((entry) => typeof entry === "number")) {
    throw new ProofError(`Expected an array of numbers for ${where}`);
  }
  return value;
}

function strings(value: unknown, where: string): readonly string[] {
  if (!Array.isArray(value) || !value.every((entry) => typeof entry === "string")) {
    throw new ProofError(`Expected an array of strings for ${where}`);
  }
  return value;
}

function integer(value: unknown, where: string): number {
  const id = typeof value === "string" ? Number(value) : value;
  if (typeof id !== "number" || !Number.isSafeInteger(id)) throw new ProofError(`Expected an integer for ${where}`);
  return id;
}
