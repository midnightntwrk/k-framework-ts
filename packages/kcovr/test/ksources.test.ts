/* oxlint-disable unicorn/no-useless-undefined -- fetcher contract reserves undefined for a clean 404. */

import { describe, expect, test } from "bun:test";

import { InvalidKcovrGitlinkError, checkKcovrSources, type KcovrSourceFetcher } from "../src/ksources.ts";
import { IO_CPP_IDENTITY } from "../src/version.ts";

const K_TAG = "v-test";
const GITLINK = "0123456789abcdef0123456789abcdef01234567";
const GITLINK_PATH = "llvm-backend/src/main/native/llvm-backend";

function fetcher(file: KcovrSourceFetcher["file"], gitlink: KcovrSourceFetcher["gitlink"]): KcovrSourceFetcher {
  return { file, gitlink };
}

describe("the llvm-backend source identity", () => {
  test("resolves K tag → K gitlink → llvm-backend io.cpp at that exact commit", async () => {
    const calls: string[] = [];
    const report = await checkKcovrSources(
      K_TAG,
      fetcher(
        (repo, path, revision) => {
          calls.push(`file:${repo}:${path}:${revision}`);
          return Promise.resolve(new TextEncoder().encode("changed bytes"));
        },
        (repo, path, revision) => {
          calls.push(`gitlink:${repo}:${path}:${revision}`);
          return Promise.resolve(GITLINK);
        },
      ),
      [],
    );
    expect(calls).toEqual([
      `gitlink:runtimeverification/k:${GITLINK_PATH}:${K_TAG}`,
      `file:runtimeverification/llvm-backend:${IO_CPP_IDENTITY.path}:${GITLINK}`,
    ]);
    expect(report.files).toEqual([
      expect.objectContaining({
        repo: "runtimeverification/llvm-backend",
        path: IO_CPP_IDENTITY.path,
        revision: GITLINK,
        status: "changed",
        resolvedFrom: { repo: "runtimeverification/k", release: K_TAG, path: GITLINK_PATH, commit: GITLINK },
      }),
    ]);
  });

  test("reports a missing K gitlink and a missing backend file as inconclusive, with their provenance", async () => {
    const missingGitlink = await checkKcovrSources(
      K_TAG,
      fetcher(
        () => Promise.resolve(undefined),
        () => Promise.resolve(undefined),
      ),
      [],
    );
    expect(missingGitlink.files[0]).toMatchObject({
      repo: "runtimeverification/llvm-backend",
      status: "missing",
      revision: "",
      resolvedFrom: { repo: "runtimeverification/k", release: K_TAG, path: GITLINK_PATH },
    });
    expect(missingGitlink.verdicts.reference).toBe("could-not-locate");

    const missingFile = await checkKcovrSources(
      K_TAG,
      fetcher(
        () => Promise.resolve(undefined),
        () => Promise.resolve(GITLINK),
      ),
      [],
    );
    expect(missingFile.files[0]).toMatchObject({ status: "missing", revision: GITLINK });
    expect(missingFile.files[0]?.resolvedFrom).toMatchObject({ commit: GITLINK });
  });

  test("retains malformed gitlink bytes rather than silently treating them as a missing tag", async () => {
    try {
      await checkKcovrSources(
        K_TAG,
        fetcher(
          () => Promise.resolve(undefined),
          () => Promise.resolve("not-a-commit"),
        ),
        [],
      );
      throw new Error("expected an invalid gitlink error");
    } catch (error) {
      expect(error).toBeInstanceOf(InvalidKcovrGitlinkError);
    }
  });
});
