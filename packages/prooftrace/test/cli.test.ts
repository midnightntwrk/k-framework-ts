/**
 * The `prooftrace` command, driven entirely through its injected seams: the
 * filesystem for `read`, the fetcher and submodule resolver for `check-k`.
 *
 * `read` runs over the real checked-in fixtures — the point of that subcommand
 * is producing a consumer's trace file, and a test that fed it synthetic bytes
 * would not check the thing that matters.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { exitCodeFor, main, render, type FileSystem } from "../src/cli.ts";
import type { ProofTraceSourceFetcher, ProofTraceSourcesReport } from "../src/ksources.ts";
import { K_RELEASE, LLVM_BACKEND_RELEASE } from "../src/version.ts";
import { FIXTURES } from "./support.ts";

/** The real fixtures, behind the seam. */
const FS: FileSystem = {
  readBytes: (path) => readFileSync(join(FIXTURES, "hints", path)),
  readText: (path) => readFileSync(join(FIXTURES, "hints", path), "utf8"),
};

interface Run {
  readonly code: number;
  readonly out: string;
  readonly err: string;
}

async function run(argv: readonly string[], deps: Parameters<typeof main>[3] = {}): Promise<Run> {
  let out = "";
  let err = "";
  const code = await main(
    argv,
    (text) => {
      out += text;
    },
    (text) => {
      err += text;
    },
    { fs: FS, ...deps },
  );
  return { code, out, err };
}

describe("prooftrace read", () => {
  test("decodes a hint stream to JSONL with a definition's attribution", async () => {
    const { code, out } = await run(["read", "add-rewrite.header", "add-rewrite.hints", "add-rewrite.definition.kore"]);
    expect(code).toBe(0);
    const lines = out.trimEnd().split("\n");
    expect(lines.length).toBe(9);
    const first: unknown = JSON.parse(lines[0]!);
    expect(first).toMatchObject({ label: "ADD-REWRITE.state-next", origin: "llvm", index: 0 });
    // The CLI does not render substitutions; that needs `compiled.json` too.
    expect(first).toMatchObject({ substitution: null });
  });

  test("without a definition the records still carry the step sequence", async () => {
    const { code, out } = await run(["read", "add-rewrite.header", "add-rewrite.hints"]);
    expect(code).toBe(0);
    const records = out.trimEnd().split("\n");
    expect(records.length).toBe(9);
    // Without a definition, nothing resolves — which is still a usable diff.
    for (const line of records) expect(line).toInclude('"resolved":false,"label":null');
  });

  test("--depth all reaches the equations inside a requires clause", async () => {
    const shallow = await run(["read", "guarded.header", "guarded-big.hints", "guarded.definition.kore"]);
    const deep = await run([
      "read",
      "guarded.header",
      "guarded-big.hints",
      "guarded.definition.kore",
      "--depth",
      "all",
    ]);
    expect(deep.out.length).toBeGreaterThan(shallow.out.length);
    expect(deep.out).toInclude("GUARDED.depth-s");
    expect(shallow.out).not.toInclude("GUARDED.depth-s");
  });

  test("--no-failures drops the rejected rule attempts", async () => {
    const withFailures = await run(["read", "guarded.header", "guarded-big.hints", "guarded.definition.kore"]);
    const without = await run([
      "read",
      "guarded.header",
      "guarded-big.hints",
      "guarded.definition.kore",
      "--no-failures",
    ]);
    expect(withFailures.out).toInclude('"outcome":"failure"');
    expect(without.out).not.toInclude('"outcome":"failure"');
  });

  test("--pre-trace and --depth compose", async () => {
    const { code, out } = await run([
      "read",
      "add-rewrite.header",
      "add-rewrite.hints",
      "add-rewrite.definition.kore",
      "--pre-trace",
      "--depth",
      "all",
    ]);
    expect(code).toBe(0);
    expect(out.trimEnd().split("\n").length).toBeGreaterThan(9);
  });

  test("a malformed stream reports the byte, and exits 1", async () => {
    const { code, err } = await run(["read", "add-rewrite.hints", "add-rewrite.header"]);
    expect(code).toBe(1);
    expect(err).toMatch(/bad magic number \(at byte 0\)/);
  });

  test("wrong arity, an unknown option and a bad --depth are all usage errors", async () => {
    for (const argv of [
      ["read", "only-one"],
      ["read", "a", "b", "c", "d"],
      ["read", "a", "b", "--nope"],
      ["read", "a", "b", "--depth"],
      ["read", "a", "b", "--depth", "-1"],
    ]) {
      const { code, err } = await run(argv);
      expect(code).toBe(2);
      expect(err).toInclude("prooftrace <command>");
    }
  });
});

// Serving nothing is the only body a hermetic test can give: the manifest's
// recorded digests are of real upstream files, so "unchanged" is not reachable
// offline. What is under test here is the wiring — which release reaches which
// repo, and how a verdict becomes an exit code.
const servingNothing: ProofTraceSourceFetcher = () => Promise.resolve(undefined);

describe("prooftrace check-k", () => {
  test("resolves the llvm-backend release from the K tag's submodule pin", async () => {
    const asked: string[] = [];
    const { out } = await run(["check-k", "v9.9.9"], {
      fetcher: (repo, path, release) => {
        asked.push(`${repo}@${release}`);
        return Promise.resolve(undefined);
      },
      resolveSubmodule: () => Promise.resolve("deadbeef"),
    });
    expect(out).toInclude("llvm-backend pinned by K v9.9.9: deadbeef");
    expect(asked).toContain("runtimeverification/llvm-backend@deadbeef");
    expect(asked).toContain("runtimeverification/k@v9.9.9");
  });

  test("an explicit second release skips the resolver entirely", async () => {
    let resolved = false;
    const { out } = await run(["check-k", "v9.9.9", "v0.0.1"], {
      fetcher: servingNothing,
      resolveSubmodule: () => {
        resolved = true;
        return Promise.resolve("nope");
      },
    });
    expect(resolved).toBe(false);
    expect(out).not.toInclude("pinned by K");
  });

  test("everything missing is 'could not locate', exit 3", async () => {
    const { code, out } = await run(["check-k", "v9.9.9", "v0.0.1"], { fetcher: servingNothing });
    expect(code).toBe(3);
    expect(out).toInclude("format: a path moved");
  });

  test("a moved submodule path is exit 3, not a verdict", async () => {
    const { code, err } = await run(["check-k", "v9.9.9"], {
      fetcher: servingNothing,
      resolveSubmodule: () => Promise.resolve(undefined),
    });
    expect(code).toBe(3);
    expect(err).toInclude(LLVM_BACKEND_RELEASE);
  });

  test("a fetcher failure is 'could not run', exit 2", async () => {
    const { code, err } = await run(["check-k", "v9.9.9", "v0.0.1"], {
      fetcher: () => Promise.reject(new Error("offline")),
    });
    expect(code).toBe(2);
    expect(err).toInclude("offline");
  });

  test("takes exactly one or two releases", async () => {
    expect((await run(["check-k"])).code).toBe(2);
    expect((await run(["check-k", "a", "b", "c"])).code).toBe(2);
  });
});

describe("the command itself", () => {
  test("no arguments prints the usage and exits 2", async () => {
    const { code, err } = await run([]);
    expect(code).toBe(2);
    expect(err).toInclude(K_RELEASE);
  });

  test("--help exits 0", async () => {
    for (const flag of ["--help", "-h", "help"]) {
      const { code, out } = await run([flag]);
      expect(code).toBe(0);
      expect(out).toInclude("prooftrace read");
    }
  });

  test("an unknown command is named", async () => {
    const { code, err } = await run(["parse"]);
    expect(code).toBe(2);
    expect(err).toInclude("unknown command: parse");
  });
});

describe("render and exitCodeFor", () => {
  test("the exit code reflects the format tier only", () => {
    expect(exitCodeFor("unchanged")).toBe(0);
    expect(exitCodeFor("changed")).toBe(1);
    expect(exitCodeFor("could-not-locate")).toBe(3);
  });

  test("every file gets a line, and each tier gets a summary", () => {
    const report: ProofTraceSourcesReport = {
      releases: { k: "v1", llvmBackend: "v2" },
      recordedAt: { k: K_RELEASE, llvmBackend: LLVM_BACKEND_RELEASE },
      verdicts: { format: "changed", ordinal: "unchanged", api: "could-not-locate" },
      files: [
        {
          repo: "runtimeverification/llvm-backend",
          path: "docs/proof-trace.md",
          tier: "format",
          status: "changed",
          expected: "a".repeat(64),
          actual: "b".repeat(64),
          why: "",
        },
        {
          repo: "runtimeverification/llvm-backend",
          path: "lib/ast/definition.cpp",
          tier: "ordinal",
          status: "unchanged",
          expected: "c".repeat(64),
          why: "",
        },
        {
          repo: "runtimeverification/k",
          path: "pyk/src/pyk/kllvm/hints/prooftrace.py",
          tier: "api",
          status: "missing",
          expected: "d".repeat(64),
          why: "",
        },
      ],
    };
    const text = render(report);
    expect(text).toInclude("DIFF  runtimeverification/llvm-backend:docs/proof-trace.md");
    expect(text).toInclude("ok    runtimeverification/llvm-backend:lib/ast/definition.cpp");
    expect(text).toInclude("GONE  runtimeverification/k:pyk/src/pyk/kllvm/hints/prooftrace.py");
    expect(text).toInclude("no such path at v1");
    expect(text).toInclude("format: CHANGED");
    expect(text).toInclude("ordinal (advisory): unchanged.");
  });
});
