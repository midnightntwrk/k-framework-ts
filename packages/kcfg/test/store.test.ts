/** pyk `test_write_cfg_data` and `test_read_write_cfg_data`, adapted for async Node I/O. */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { CTerm } from "@kframework-ts/cterm";

import { KCFG } from "../src/kcfg.ts";
import { readKcfgStore, writeKcfgStore } from "../src/store.ts";

let scratch: string;

const KONTROL_FIXTURE = join(import.meta.dir, "..", "fixtures", "upstream", "kontrol", "assert-test-setup", "kcfg");
const KONTROL_FIXTURE_HASHES = {
  "kcfg.json": "e52af7869c2a624d40209c217a83d58cf87a7881b084da7b2edd4da9eb8d6e9b",
  "nodes/1.json": "5a05a732f83ecd3bd284426163dea56d8422765b4163396299349dfa8c5c3b2d",
  "nodes/2.json": "9222bea2754a354d401b1e9fe1d6da753dd85e2911f84b45cea83ba6f98c4482",
  "nodes/3.json": "c57b0dfeaab99dce9d08509d6d419ea54e342a3fec26adf9993fbf5b2127b5b5",
} as const;

beforeAll(async () => {
  scratch = await mkdtemp(join(tmpdir(), "kframework-ts-kcfg-store-"));
});

afterAll(async () => {
  await rm(scratch, { recursive: true, force: true });
});

function graph(ids: readonly number[], attrs: Readonly<Record<number, readonly string[]>> = {}): KCFG {
  const cterm = CTerm.top().toDict();
  return KCFG.fromDict({
    next: Math.max(...ids) + 2,
    nodes: ids.map((id) => ({ id, cterm, attrs: attrs[id] ?? [] })),
    ...(ids.length > 1 ? { edges: [{ source: ids[0]!, target: ids[1]!, depth: 2, rules: ["r"] }] } : {}),
  });
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function isJsonObject(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function jsonObject(text: string): Readonly<Record<string, unknown>> {
  const value: unknown = JSON.parse(text);
  if (!isJsonObject(value)) throw new Error("Expected a JSON object");
  return value;
}

async function sha256(path: string): Promise<string> {
  return createHash("sha256")
    .update(await readFile(path))
    .digest("hex");
}

describe("pyk KCFGStore split layout", () => {
  test("writes and reads an empty graph when its structural dictionary omits nodes", async () => {
    const directory = join(scratch, "empty");
    const original = new KCFG();

    await writeKcfgStore(directory, original);

    const index = jsonObject(await readFile(join(directory, "kcfg.json"), "utf8"));
    expect(index.nodes).toBeUndefined();
    expect(index.vacuous).toEqual([]);
    expect(index.stuck).toEqual([]);
    expect((await readKcfgStore(directory)).toDict()).toEqual(original.toDict());
  });

  test("writes each node before its index and reads the structural graph back", async () => {
    const directory = join(scratch, "round-trip");
    const original = graph([1, 3], { 1: ["vacuous"], 3: ["stuck"] });

    await writeKcfgStore(directory, original);

    const index = jsonObject(await readFile(join(directory, "kcfg.json"), "utf8"));
    expect(index.nodes).toEqual([1, 3]);
    expect(index.vacuous).toEqual([1]);
    expect(index.stuck).toEqual([3]);
    expect(await exists(join(directory, "nodes", "1.json"))).toBe(true);
    expect(await exists(join(directory, "nodes", "3.json"))).toBe(true);
    expect((await readKcfgStore(directory)).toDict()).toEqual(original.toDict());
  });

  test("replaces obsolete node JSON only inside the explicit store nodes directory", async () => {
    const directory = join(scratch, "obsolete-nodes");
    await writeKcfgStore(directory, graph([1, 3]));
    const unrelated = join(directory, "nodes", "keep.txt");
    await writeFile(unrelated, "not a KCFG node");

    await writeKcfgStore(directory, graph([3, 5], { 5: ["vacuous"] }));

    expect(await exists(join(directory, "nodes", "1.json"))).toBe(false);
    expect(await exists(join(directory, "nodes", "3.json"))).toBe(true);
    expect(await exists(join(directory, "nodes", "5.json"))).toBe(true);
    expect(await exists(unrelated)).toBe(true);
  });

  test("treats top-level vacuous and stuck arrays as authoritative", async () => {
    const directory = join(scratch, "authoritative-status");
    const cterm = CTerm.top().toDict();
    await mkdir(join(directory, "nodes"), { recursive: true });
    await writeFile(join(directory, "kcfg.json"), JSON.stringify({ next: 3, nodes: [2], vacuous: [2], stuck: [] }));
    await writeFile(join(directory, "nodes", "2.json"), JSON.stringify({ id: 2, cterm, attrs: ["custom", "stuck"] }));

    const loaded = await readKcfgStore(directory);
    const node = loaded.toDict().nodes?.[0];
    expect(node?.attrs).toEqual(["vacuous"]);
  });

  test("reads the hash-pinned Kontrol store topology and round-trips it structurally", async () => {
    await Promise.all(
      Object.entries(KONTROL_FIXTURE_HASHES).map(async ([relativePath, expectedHash]) => {
        expect(await sha256(join(KONTROL_FIXTURE, relativePath))).toBe(expectedHash);
      }),
    );

    const original = await readKcfgStore(KONTROL_FIXTURE);
    expect(original.next).toBe(4);
    expect(original.nodes.map((node) => node.id)).toEqual([1, 2, 3]);
    expect(original.roots.map((node) => node.id)).toEqual([1]);
    expect(original.leaves.map((node) => node.id)).toEqual([2]);
    expect(original.vacuous).toEqual([]);
    expect(original.stuck).toEqual([]);

    const edge = original.successor(1);
    expect(edge?.kind).toBe("edge");
    if (edge?.kind !== "edge") throw new Error("Kontrol fixture edge is missing");
    expect({ source: edge.source.id, target: edge.target.id, depth: edge.depth, rules: edge.rules }).toEqual({
      source: 1,
      target: 3,
      depth: 182,
      rules: [],
    });

    const cover = original.successor(3);
    expect(cover?.kind).toBe("cover");
    if (cover?.kind !== "cover") throw new Error("Kontrol fixture cover is missing");
    expect(cover.target.id).toBe(2);
    expect(cover.csubst.subst.size).toBe(83);
    expect(cover.csubst.constraints).toEqual([]);
    expect(original.covered.map((node) => node.id)).toEqual([3]);

    const directory = join(scratch, "kontrol-structural-round-trip");
    await writeKcfgStore(directory, original);
    expect((await readKcfgStore(directory)).toDict()).toEqual(original.toDict());
  });
});
