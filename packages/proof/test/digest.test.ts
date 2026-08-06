/**
 * The digest gate, against pyk's own numbers.
 *
 * `claimHash` is `hash_str(json.dumps(claim.to_dict(), sort_keys=True))`, so it
 * is checkable *exactly*: the four hashes frozen below were produced by running
 * the pinned pyk tree (`k/pyk/src`, v7.1.337) over the very dicts
 * `sentenceToDict` emits for these two claims, then applying `KClaimJob.digest`
 * (`kevm-pyk/src/kevm_pyk/__main__.py:178-182`). If `sentenceToDict`, the
 * canonical JSON, or the composition order ever drifts, these rows fail.
 *
 * ```sh
 * # what produced them
 * PYTHONPATH=<k>/pyk/src python3 - <<'PY'
 * import json
 * from pyk.kast.outer import KClaim
 * from pyk.utils import hash_str
 * claim = KClaim.from_dict(json.load(open('claim.json')))
 * print(hash_str(json.dumps(claim.to_dict(), sort_keys=True)))
 * PY
 * ```
 *
 * The digest *file* is pinned byte-for-byte too: `json.dumps(dct, indent=4)` is
 * `JSON.stringify(value, null, 4)` once an indent is in play, which is the one
 * place in this monorepo where a written JSON document matches pyk's bytes
 * without the compaction caveat.
 */

import { attEntry, Atts, KAtt, kapply, kclaim, krewrite, ktoken, type KClaim } from "@kframework-ts/kast";
import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  claimDigests,
  claimHash,
  claimUpToDate,
  DIGEST_FILE_NAME,
  digestFilePath,
  hashStr,
  updateClaimDigest,
} from "../src/prove.ts";
import { caught } from "./support.ts";

//////////////////////////
// Fixtures             //
//////////////////////////

/** `claim step(1) => step(2)`, labelled, optionally depending on another label. */
function claim(label: string, depends?: string): KClaim {
  const entries = [attEntry(Atts.LABEL, label)];
  if (depends !== undefined) entries.push(attEntry(Atts.DEPENDS, depends));
  return kclaim(krewrite(kapply("step", [ktoken("1", "Int")]), kapply("step", [ktoken("2", "Int")])), {
    att: new KAtt(entries),
  });
}

/** The same claim body with a different token, so its hash must differ. */
function changedClaim(label: string, depends?: string): KClaim {
  const entries = [attEntry(Atts.LABEL, label)];
  if (depends !== undefined) entries.push(attEntry(Atts.DEPENDS, depends));
  return kclaim(krewrite(kapply("step", [ktoken("1", "Int")]), kapply("step", [ktoken("3", "Int")])), {
    att: new KAtt(entries),
  });
}

/** pyk at v7.1.337, over the dicts `sentenceToDict` emits for the two claims above. */
const PYK = {
  depClaimHash: "9082b622e60d3efc001c25603f480655f79f67f05d9d76824289adf948dc569c",
  parentClaimHash: "003c9111d6fae92d0b0aa3c55afc8852650a0165dd795b2deee74bf49b62c648",
  depDigest: "92ea162b0dc941aaead4a999792b934bfd04ddf9f8fb34bad6fd16d026b449af",
  parentDigest: "fa6a62423c237036037fbaf8aa1ba36d93fe5100e5dd8432a073af4d7db87fda",
} as const;

async function withScratch<T>(body: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "kframework-ts-proof-digest-"));
  try {
    return await body(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

//////////////////////////
// Hashing              //
//////////////////////////

describe("claimHash", () => {
  test("is pyk's hash_str(json.dumps(claim.to_dict(), sort_keys=True))", () => {
    expect(claimHash(claim("SPEC.dep"))).toBe(PYK.depClaimHash);
    expect(claimHash(claim("SPEC.parent", "SPEC.dep"))).toBe(PYK.parentClaimHash);
  });

  test("the depends attribute is part of the hash", () => {
    expect(claimHash(claim("SPEC.parent"))).not.toBe(PYK.parentClaimHash);
  });
});

describe("claimDigests", () => {
  test("composes claim hash with dependency digests, as KClaimJob.digest", () => {
    const digests = claimDigests([claim("SPEC.dep"), claim("SPEC.parent", "SPEC.dep")]);
    expect(digests.get("SPEC.dep")).toBe(PYK.depDigest);
    expect(digests.get("SPEC.parent")).toBe(PYK.parentDigest);
    // The composition itself, spelled out: `hash_str(f'{claim_hash}{deps}')`.
    expect(hashStr(`${PYK.parentClaimHash}${PYK.depDigest}`)).toBe(PYK.parentDigest);
  });

  test("a dependency changing changes the dependent's digest and not its own hash", () => {
    const digests = claimDigests([changedClaim("SPEC.dep"), claim("SPEC.parent", "SPEC.dep")]);
    expect(claimHash(claim("SPEC.parent", "SPEC.dep"))).toBe(PYK.parentClaimHash);
    expect(digests.get("SPEC.parent")).not.toBe(PYK.parentDigest);
  });

  test("a dependency label resolves under the spec module name too", () => {
    // `labels_to_claims[f'{spec_module_name}.{claim_label}']` (`__main__.py:219`).
    const qualified = claimDigests([claim("SPEC.dep"), claim("SPEC.parent", "dep")], "SPEC");
    const bare = claimDigests([claim("dep"), claim("SPEC.parent", "dep")]);
    expect(qualified.get("SPEC.parent")).toBe(hashStr(`${claimHash(claim("SPEC.parent", "dep"))}${PYK.depDigest}`));
    // The unqualified claim is a different claim — different label, different hash.
    expect(bare.get("SPEC.parent")).not.toBe(qualified.get("SPEC.parent"));
  });

  test("dependency digests are concatenated in sorted order, so the result is deterministic", () => {
    const claims = [claim("SPEC.a"), claim("SPEC.b"), claim("SPEC.p", "SPEC.a,SPEC.b")];
    const forward = claimDigests(claims);
    const reversed = claimDigests([...claims].toReversed());
    expect(reversed.get("SPEC.p")).toBe(forward.get("SPEC.p"));
    const sorted = [forward.get("SPEC.a") ?? "", forward.get("SPEC.b") ?? ""].toSorted();
    expect(forward.get("SPEC.p")).toBe(hashStr(`${claimHash(claim("SPEC.p", "SPEC.a,SPEC.b"))}${sorted.join("")}`));
  });

  test("an unloaded dependency contributes its label instead of raising", () => {
    // Upstream's `ValueError` (`__main__.py:221`) would abort the batch; see
    // `digest.ts`'s deviation note.
    const digests = claimDigests([claim("SPEC.parent", "SPEC.missing")]);
    expect(digests.get("SPEC.parent")).toBe(hashStr(`${claimHash(claim("SPEC.parent", "SPEC.missing"))}SPEC.missing`));
    // And it is still sensitive to the claim it *can* see.
    expect(claimDigests([changedClaim("SPEC.parent", "SPEC.missing")]).get("SPEC.parent")).not.toBe(
      digests.get("SPEC.parent"),
    );
  });

  test("a dependency cycle is reported, not recursed into", async () => {
    const error = await caught(() => {
      claimDigests([claim("SPEC.a", "SPEC.b"), claim("SPEC.b", "SPEC.a")]);
      return Promise.resolve();
    });
    expect(String(error)).toContain("Cycle in claim dependencies");
  });
});

//////////////////////////
// The digest file      //
//////////////////////////

describe("the digest file", () => {
  test("lives at <proofDir>/digest", () => {
    expect(digestFilePath("/proofs")).toBe(join("/proofs", DIGEST_FILE_NAME));
  });

  test("up-to-date is false for every reason upstream gives one", async () => {
    await withScratch(async (dir) => {
      const file = digestFilePath(dir);
      // No file at all.
      expect(await claimUpToDate(file, "SPEC.dep", PYK.depDigest)).toBe(false);
      // A file with no `claims` object.
      await writeFile(file, JSON.stringify({ other: 1 }), "utf8");
      expect(await claimUpToDate(file, "SPEC.dep", PYK.depDigest)).toBe(false);
      // A `claims` object with no entry for this label.
      await writeFile(file, JSON.stringify({ claims: { "SPEC.other": PYK.depDigest } }), "utf8");
      expect(await claimUpToDate(file, "SPEC.dep", PYK.depDigest)).toBe(false);
      // An entry that does not match.
      await writeFile(file, JSON.stringify({ claims: { "SPEC.dep": PYK.parentDigest } }), "utf8");
      expect(await claimUpToDate(file, "SPEC.dep", PYK.depDigest)).toBe(false);
      // Unreadable JSON costs a re-run, not the run.
      await writeFile(file, "{not json", "utf8");
      expect(await claimUpToDate(file, "SPEC.dep", PYK.depDigest)).toBe(false);
    });
  });

  test("update then check is up to date, and the bytes are pyk's", async () => {
    await withScratch(async (dir) => {
      const file = digestFilePath(dir);
      await updateClaimDigest(file, "SPEC.dep", PYK.depDigest);
      await updateClaimDigest(file, "SPEC.parent", PYK.parentDigest);
      expect(await claimUpToDate(file, "SPEC.dep", PYK.depDigest)).toBe(true);
      expect(await claimUpToDate(file, "SPEC.parent", PYK.parentDigest)).toBe(true);
      // `json.dumps({'claims': {...}}, indent=4)`, character for character.
      expect(await readFile(file, "utf8")).toBe(
        `{\n    "claims": {\n        "SPEC.dep": "${PYK.depDigest}",\n        "SPEC.parent": "${PYK.parentDigest}"\n    }\n}`,
      );
    });
  });

  test("updating one claim preserves the others and any foreign key", async () => {
    await withScratch(async (dir) => {
      const file = digestFilePath(dir);
      await writeFile(file, JSON.stringify({ version: 3, claims: { "SPEC.other": "keep" } }), "utf8");
      await updateClaimDigest(file, "SPEC.dep", PYK.depDigest);
      const document: unknown = JSON.parse(await readFile(file, "utf8"));
      expect(document).toEqual({ version: 3, claims: { "SPEC.other": "keep", "SPEC.dep": PYK.depDigest } });
    });
  });

  test("the directory is created and the lock file is not left behind", async () => {
    await withScratch(async (dir) => {
      const file = digestFilePath(join(dir, "nested", "proofs"));
      await updateClaimDigest(file, "SPEC.dep", PYK.depDigest);
      expect(await claimUpToDate(file, "SPEC.dep", PYK.depDigest)).toBe(true);
      expect(await caught(() => readFile(`${file}.lock`, "utf8"))).toBeDefined();
    });
  });
});
