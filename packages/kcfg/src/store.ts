/**
 * Node-only persistence for pyk's split KCFG layout.
 *
 * The graph document is deliberately split between `kcfg.json` (topology) and
 * one `nodes/<id>.json` file per CTerm node.  This module is not re-exported
 * from the browser-safe package entry point.
 */

import { readdir, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";

import { KCFG } from "./kcfg.js";

type JsonRecord = Record<string, unknown>;

const INDEX_FILE = "kcfg.json";
const NODES_DIRECTORY = "nodes";
const VACUOUS = "vacuous";
const STUCK = "stuck";

/** A Node-only facade around a particular pyk KCFG store directory. */
export class KCFGStore {
  readonly path: string;

  constructor(path: string) {
    this.path = resolve(path);
  }

  get kcfgPath(): string {
    return join(this.path, INDEX_FILE);
  }

  get nodesPath(): string {
    return join(this.path, NODES_DIRECTORY);
  }

  nodePath(id: number): string {
    assertNodeId(id, "node id");
    return join(this.nodesPath, `${id}.json`);
  }

  /** Read the split layout and reconstruct a normal in-memory KCFG. */
  async read(): Promise<KCFG> {
    const index = asRecord(await readJson(this.kcfgPath), this.kcfgPath);
    const nodeIds = asNodeIds(index.nodes ?? [], `${this.kcfgPath}.nodes`);
    const vacuous = asNodeIdSet(index.vacuous, `${this.kcfgPath}.vacuous`);
    const stuck = asNodeIdSet(index.stuck, `${this.kcfgPath}.stuck`);

    const nodes = await Promise.all(
      nodeIds.map(async (id) => {
        const nodePath = this.nodePath(id);
        const node = asRecord(await readJson(nodePath), nodePath);
        if (node.id !== id) {
          throw new SyntaxError(`KCFG node file ${nodePath} has id ${JSON.stringify(node.id)}, expected ${id}`);
        }

        // pyk deliberately takes status from the index, not from the node
        // record.  Arbitrary node-file attributes are therefore not part of
        // the split-store persistence contract.
        const attrs: string[] = [];
        if (vacuous.has(id)) attrs.push(VACUOUS);
        if (stuck.has(id)) attrs.push(STUCK);
        return { ...node, attrs };
      }),
    );

    const graphDict: JsonRecord = { ...index, nodes };
    delete graphDict.vacuous;
    delete graphDict.stuck;
    return KCFG.fromDict(graphDict);
  }

  /**
   * Replace this directory's persisted graph.
   *
   * Changed replacements are staged beside their destination then renamed.
   * Node files are installed before the index, so an installed index never
   * refers to a node file which has not yet been written.  Only after that
   * index is installed are obsolete `*.json` files removed from this store's
   * own `nodes/` directory.
   */
  async write(graph: KCFG): Promise<void> {
    const { index, nodes } = splitStoreDict(graph);
    await mkdir(this.nodesPath, { recursive: true });

    for (const node of nodes) {
      await writeStagedJson(this.nodePath(node.id), node);
    }

    const currentIds = new Set(nodes.map((node) => node.id));
    await writeStagedJson(this.kcfgPath, index);
    await removeObsoleteNodeFiles(this.nodesPath, currentIds);
  }
}

/** Read a pyk-compatible KCFG directory. */
export async function readKcfgStore(path: string): Promise<KCFG> {
  return new KCFGStore(path).read();
}

/** Write a pyk-compatible KCFG directory. */
export async function writeKcfgStore(path: string, graph: KCFG): Promise<void> {
  await new KCFGStore(path).write(graph);
}

interface StoredNode extends JsonRecord {
  readonly id: number;
  readonly attrs: readonly string[];
}

function splitStoreDict(graph: KCFG): { readonly index: JsonRecord; readonly nodes: readonly StoredNode[] } {
  const full = asRecord(graph.toDict(), "KCFG dictionary");
  const rawNodes = full.nodes ?? [];
  if (!Array.isArray(rawNodes)) throw new TypeError("KCFG.toDict() returned a non-array nodes field");

  const nodes = rawNodes.map((value, offset) => {
    const node = asRecord(value, `KCFG dictionary.nodes[${offset}]`);
    assertNodeId(node.id, `KCFG dictionary.nodes[${offset}].id`);
    const attrs = asStringArray(node.attrs, `KCFG dictionary.nodes[${offset}].attrs`);
    return { ...node, id: node.id, attrs };
  });

  const index: JsonRecord = { ...full };
  if (nodes.length > 0) index.nodes = nodes.map((node) => node.id);
  else delete index.nodes;
  index.vacuous = nodes.filter((node) => node.attrs.includes(VACUOUS)).map((node) => node.id);
  index.stuck = nodes.filter((node) => node.attrs.includes(STUCK)).map((node) => node.id);
  return { index, nodes };
}

async function readJson(path: string): Promise<unknown> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    throw new Error(`Could not read KCFG store file ${path}`, { cause: error });
  }
  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    throw new SyntaxError(`Invalid JSON in KCFG store file ${path}`, { cause: error });
  }
}

async function writeStagedJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const text = JSON.stringify(value);
  try {
    if ((await readFile(path, "utf8")) === text) return;
  } catch (error) {
    if (!isNotFound(error)) throw error;
  }

  const staged = join(dirname(path), `.${randomUUID()}.${basename(path)}.tmp`);
  try {
    await writeFile(staged, text, "utf8");
    await rename(staged, path);
  } catch (error) {
    await rm(staged, { force: true });
    throw error;
  }
}

function isNotFound(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

async function removeObsoleteNodeFiles(nodesDirectory: string, currentIds: ReadonlySet<number>): Promise<void> {
  for (const entry of await readdir(nodesDirectory, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const match = /^(\d+)\.json$/u.exec(entry.name);
    if (match === null) continue;
    const id = Number(match[1]);
    if (!Number.isSafeInteger(id) || id < 1 || currentIds.has(id)) continue;
    // This is intentionally a single-file unlink below the explicit store
    // directory; no caller-controlled recursive deletion is involved.
    await rm(join(nodesDirectory, entry.name), { force: true });
  }
}

function asRecord(value: unknown, where: string): JsonRecord {
  if (!isRecord(value)) {
    throw new SyntaxError(`Expected an object for ${where}`);
  }
  return { ...value };
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asNodeIds(value: unknown, where: string): readonly number[] {
  if (!Array.isArray(value)) throw new SyntaxError(`Expected an array for ${where}`);
  const ids = value.map((id, offset) => {
    assertNodeId(id, `${where}[${offset}]`);
    return id;
  });
  if (new Set(ids).size !== ids.length) throw new SyntaxError(`Duplicate node id in ${where}`);
  return ids;
}

function asNodeIdSet(value: unknown, where: string): ReadonlySet<number> {
  // pyk writes both keys even when empty.  Treating absent arrays as empty
  // keeps old hand-written stores readable without weakening their authority.
  if (value === undefined) return new Set();
  return new Set(asNodeIds(value, where));
}

function asStringArray(value: unknown, where: string): readonly string[] {
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
    throw new TypeError(`Expected an array of strings for ${where}`);
  }
  return value;
}

function assertNodeId(value: unknown, where: string): asserts value is number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw new SyntaxError(`Expected a positive safe integer for ${where}`);
  }
}
