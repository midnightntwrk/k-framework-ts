/**
 * Real Kontrol proof directories, read and classified by this package.
 *
 * This is the only cross-implementation oracle the proof-data format has:
 * bytes a released Kontrol wrote, and the `foundry list` golden it prints for
 * them. `fixtures/PROVENANCE.md` records the origin, the two directory
 * renames, and precisely which three things a round trip does not preserve.
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { APRProof, APRSummary, summaryToString } from "../src/index.ts";
import { readProofData, writeProofData } from "../src/store.ts";

import { asAprProof, isJsonObject, jsonObject, jsonObjectFile, jsonNumbers, parseJson } from "./support.ts";

const KONTROL = join(import.meta.dir, "..", "fixtures", "upstream", "kontrol");

/** Every vendored byte, hash-pinned; see `fixtures/PROVENANCE.md`. */
const HASHES: Readonly<Record<string, string>> = {
  "assert-test-setup/proof.json": "329896b3f4c61b2046fa23fa411428923d2bcf169b90931240fd55e25b60e896",
  "assert-test-setup/kcfg/kcfg.json": "e52af7869c2a624d40209c217a83d58cf87a7881b084da7b2edd4da9eb8d6e9b",
  "assert-test-setup/kcfg/nodes/1.json": "5a05a732f83ecd3bd284426163dea56d8422765b4163396299349dfa8c5c3b2d",
  "assert-test-setup/kcfg/nodes/2.json": "9222bea2754a354d401b1e9fe1d6da753dd85e2911f84b45cea83ba6f98c4482",
  "assert-test-setup/kcfg/nodes/3.json": "c57b0dfeaab99dce9d08509d6d419ea54e342a3fec26adf9993fbf5b2127b5b5",
  "assert-test-test-assert-false/proof.json": "b5bb59434cb3a5c6dd4f44c853b0837c3285c76742ee0a703d20f1a25e255877",
  "assert-test-test-assert-false/kcfg/kcfg.json": "7a83aa0ac00a000fd0eb15e009fb936a16ac022431af4778c782da801811e839",
  "assert-test-test-assert-false/kcfg/nodes/1.json": "5a05a732f83ecd3bd284426163dea56d8422765b4163396299349dfa8c5c3b2d",
  "assert-test-test-assert-false/kcfg/nodes/3.json": "b841c8cc6d02d76363a21d1a0b636bef03ddf71950aec2d75fb5732c35a594d1",
  "assert-test-test-assert-false/kcfg/nodes/4.json": "2a51d1fec4601a9589881ed2cbab832fc8d6ad1ef44945f2d323d45cf6fddf6c",
  "assert-test-test-assert-false/kcfg/nodes/5.json": "98602b1992f94776ee1c621f0e0c50c8cba8b0089d1f7349985396a7579df218",
  "assert-test-test-assert-false/kcfg/nodes/6.json": "791c30102d197942de0ee139b02b6277a8a692340d7570e07eff8a4fdbd82449",
  "foundry-list.expected": "667a5b8ca1e1da1e8ec2f135fc9edc26d2216d1fd08dff8077513f6c4d8faec9",
};

/** One `APRProof: <id>` … `Subproofs: N` block of `foundry-list.expected`. */
function expectedBlock(kontrolProofId: string): readonly string[] {
  const text = readFileSync(join(KONTROL, "foundry-list.expected"), "utf8");
  const blocks = text.split("\n\n").map((block) => block.split("\n"));
  const block = blocks.find((lines) => lines[0] === `APRProof: ${kontrolProofId}`);
  if (block === undefined) throw new Error(`No expected block for ${kontrolProofId}`);
  return block;
}

/** `kontrol-rewrite` from the pinned pyk bundle: path → sha256 of pyk's compact bytes. */
function pykRewriteHashes(id: string): Readonly<Record<string, string>> {
  const bundle = jsonObjectFile(join(import.meta.dir, "..", "fixtures", "pinned-pyk-proof.json"));
  const rewrite = jsonObject(jsonObject(bundle["cases"])["kontrol-rewrite"]);
  const files = jsonObject(rewrite["files"])[id];
  if (files === undefined) throw new Error(`No pyk rewrite hashes for ${id}`);
  const out: Record<string, string> = {};
  for (const [path, digest] of Object.entries(jsonObject(files))) {
    if (typeof digest !== "string") throw new TypeError(`Expected a digest string for ${path}`);
    out[path] = digest;
  }
  return out;
}

/** Key order and values, ignoring how the emitter spaced its separators. */
function shape(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(shape);
  if (isJsonObject(value)) return Object.entries(value).map(([key, entry]) => [key, shape(entry)]);
  return value;
}

let scratch: string;

beforeAll(async () => {
  scratch = await mkdtemp(join(tmpdir(), "kframework-ts-proof-kontrol-"));
});

afterAll(async () => {
  await rm(scratch, { recursive: true, force: true });
});

describe("vendored Kontrol proof directories", () => {
  test("are the recorded bytes", () => {
    for (const [path, expected] of Object.entries(HASHES)) {
      const digest = createHash("sha256")
        .update(readFileSync(join(KONTROL, path)))
        .digest("hex");
      expect(`${path} ${digest}`).toBe(`${path} ${expected}`);
    }
  });

  test("assert-test-setup reads, classifies, and summarises as PASSED", async () => {
    const proof = await readProofData(KONTROL, "assert-test-setup");
    expect(proof).toBeInstanceOf(APRProof);
    const apr = asAprProof(proof);

    // pyk keys a proof by its directory name and ignores `proof.json`'s `id`
    // for an APRProof; the vendored directory is renamed, so this is the
    // renamed id. The rest of the block is Kontrol's own golden.
    expect(apr.id).toBe("assert-test-setup");
    expect(apr.kcfg.nodes.map((node) => node.id)).toEqual([1, 2, 3]);
    expect(apr.init).toBe(1);
    expect(apr.target).toBe(2);
    expect([...apr.terminalIds].toSorted((a, b) => a - b)).toEqual([2, 3]);
    expect(apr.pending).toEqual([]);
    expect(apr.failing).toEqual([]);
    expect(apr.status).toBe("passed");
    expect(apr.oneLineSummary).toBe("PASSED: 3 nodes: 0 pending|1 passed|0 failing|0 vacuous|0 refuted|0 stuck");

    const summary = apr.summary.summaries[0];
    expect(summary).toBeInstanceOf(APRSummary);
    const expected = expectedBlock("test%AssertTest.setUp():0");
    expect(summary!.lines.slice(1)).toEqual(expected.slice(1));
    expect(summaryToString(apr.summary).split("\n").slice(1)).toEqual(expected.slice(1));
  });

  test("assert-test-test-assert-false reads, classifies, and summarises as FAILED", async () => {
    const proof = asAprProof(await readProofData(KONTROL, "assert-test-test-assert-false"));

    expect(proof.kcfg.nodes.map((node) => node.id)).toEqual([1, 3, 4, 5, 6]);
    expect(proof.init).toBe(1);
    expect(proof.target).toBe(5);
    expect([...proof.terminalIds].toSorted((a, b) => a - b)).toEqual([3, 5, 6]);
    // Node 6 is a terminal leaf that is neither the target nor covered by it.
    expect(proof.failing.map((node) => node.id)).toEqual([6]);
    expect(proof.pending).toEqual([]);
    expect(proof.status).toBe("failed");

    const expected = expectedBlock("test%AssertTest.test_assert_false():0");
    expect(proof.summary.summaries[0]!.lines.slice(1)).toEqual(expected.slice(1));
  });

  test.each(["assert-test-setup", "assert-test-test-assert-false"])(
    "%s rewrites byte-for-byte as pyk does, modulo Python's JSON whitespace",
    async (id) => {
      const proof = await readProofData(KONTROL, id);
      proof.proofDir = scratch;
      await writeProofData(proof);

      // `fixtures/pinned-pyk-proof.json`'s `kontrol-rewrite` case is what pyk
      // at v7.1.337 writes for these same two directories, hashed over the
      // compact rendering. Matching it means our bytes differ from pyk's only
      // by `json.dumps`' default `", "`/`": "` separators — nothing else.
      const expectedHashes = pykRewriteHashes(id);
      for (const [path, expected] of Object.entries(expectedHashes)) {
        const bytes = await readFile(join(scratch, id, path));
        const digest = createHash("sha256").update(bytes).digest("hex");
        expect(`${id}/${path} ${digest}`).toBe(`${id}/${path} ${expected}`);
      }

      // The three things that changed relative to Kontrol's own bytes, named.
      const originalProof = jsonObject(parseJson(await readFile(join(KONTROL, id, "proof.json"), "utf8")));
      const writtenProof = jsonObject(parseJson(await readFile(join(scratch, id, "proof.json"), "utf8")));
      // 1. Two keys Kontrol's writer predates.
      expect(Object.keys(originalProof)).not.toContain("execution_time");
      expect(writtenProof["execution_time"]).toBe(0);
      expect(writtenProof["loops_cache"]).toEqual({});
      // 2. `id` is the directory name, which the vendoring renamed.
      expect(writtenProof["id"]).toBe(id);
      for (const key of [
        "subproof_ids",
        "admitted",
        "type",
        "init",
        "target",
        "terminal",
        "node_refutations",
        "circularity",
        "logs",
        "bounded",
      ]) {
        expect(`${key}: ${JSON.stringify(writtenProof[key])}`).toBe(`${key}: ${JSON.stringify(originalProof[key])}`);
      }
      // 3. Empty collections current pyk drops from the store index.
      const originalIndex = jsonObject(parseJson(await readFile(join(KONTROL, id, "kcfg", "kcfg.json"), "utf8")));
      const writtenIndex = jsonObject(parseJson(await readFile(join(scratch, id, "kcfg", "kcfg.json"), "utf8")));
      for (const [key, value] of Object.entries(originalIndex)) {
        if (key in writtenIndex) {
          // `stripEmptyParams` absorbs the same `KSort.params` normalisation
          // the node files show; `covers` embeds a substitution full of sorts.
          expect(shape(stripEmptyParams(writtenIndex[key]))).toEqual(shape(stripEmptyParams(value)));
        } else {
          expect(`dropped ${key}: ${JSON.stringify(value)}`).toBe(
            `dropped ${key}: ${JSON.stringify(Array.isArray(value) ? [] : {})}`,
          );
        }
      }
      // And the node documents are Kontrol's, normalised the way pyk at this
      // release normalises them: `KSort.params` and node `attrs` made explicit.
      for (const nodeId of jsonNumbers(writtenIndex["nodes"])) {
        const before = jsonObject(
          parseJson(await readFile(join(KONTROL, id, "kcfg", "nodes", `${nodeId}.json`), "utf8")),
        );
        const after = jsonObject(
          parseJson(await readFile(join(scratch, id, "kcfg", "nodes", `${nodeId}.json`), "utf8")),
        );
        expect(after["id"]).toBe(before["id"]);
        // pyk writes node attrs into the node file (`terminal` included); only
        // the store index is restricted to `vacuous`/`stuck`.
        expect(Array.isArray(after["attrs"])).toBe(true);
        expect(shape(stripEmptyParams(after["cterm"]))).toEqual(shape(stripEmptyParams(before["cterm"])));
      }

      // And reading what we wrote yields the same proof again.
      const reread = await readProofData(scratch, id);
      expect(reread.dict).toEqual(proof.dict);
    },
  );
});

/** Drop `"params": []`, the one field the vendored node files predate. */
function stripEmptyParams(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripEmptyParams);
  if (!isJsonObject(value)) return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key, entry]) => !(key === "params" && Array.isArray(entry) && entry.length === 0))
      .map(([key, entry]) => [key, stripEmptyParams(entry)]),
  );
}
