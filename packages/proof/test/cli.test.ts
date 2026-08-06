import { KCFG, NodeAttr } from "@kframework-ts/kcfg";
import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  exitCodeFor,
  main,
  parseProveArgs,
  parseShowArgs,
  parseStatusArgs,
  render,
  renderVerdict,
} from "../src/cli.ts";
import { APRFailureInfo, APRProof, ProofStatus } from "../src/index.ts";
import type { ProofSourceFetcher } from "../src/ksources.ts";
import { writeProofData } from "../src/store.ts";
import { node, nodeDicts } from "./helpers.ts";

const encoder = new TextEncoder();

function serving(bodies: Record<string, string>): ProofSourceFetcher {
  return (path) => Promise.resolve(bodies[path] === undefined ? undefined : encoder.encode(bodies[path]));
}

async function run(argv: readonly string[], fetcher: ProofSourceFetcher = serving({})) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await main(
    argv,
    (text) => {
      out.push(text);
    },
    (text) => {
      err.push(text);
    },
    fetcher,
  );
  return { code, out: out.join(""), err: err.join("") };
}

describe("kproof check-k CLI", () => {
  test("has distinct contractual exit codes", () => {
    expect(exitCodeFor("unchanged")).toBe(0);
    expect(exitCodeFor("changed")).toBe(1);
    expect(exitCodeFor("could-not-locate")).toBe(3);
  });

  test("reports usage failures with exit code 2", async () => {
    expect((await run([])).code).toBe(2);
    expect((await run(["check-k"])).code).toBe(2);
    expect((await run(["nope"])).code).toBe(2);
  });

  test("renders help on stdout", async () => {
    const result = await run(["--help"]);
    expect(result.code).toBe(0);
    expect(result.out).toContain("check-k <k-release>");
    expect(result.err).toBe("");
  });

  test("does not report a fetch failure as source drift", async () => {
    const result = await run(["check-k", "v9.9.9"], () => Promise.reject(new Error("offline")));
    expect(result.code).toBe(2);
    expect(result.err).toContain("could not check v9.9.9: offline");
  });

  test("explains that a missing path is not a compatibility verdict", () => {
    const text = render({
      release: "v9.9.9",
      recordedAt: "v7.1.337",
      verdict: "could-not-locate",
      files: [],
    });
    expect(text).toContain("not a verdict about compatibility");
  });
});

/** Narrow the parser's `invocation | reason` result without an assertion. */
function proveInvocation(args: readonly string[]): ReturnType<typeof parseProveArgs> & object {
  const parsed = parseProveArgs(args);
  if (typeof parsed === "string") throw new Error(`expected an invocation, got: ${parsed}`);
  return parsed;
}

describe("kproof prove flag parsing", () => {
  const minimal = ["defn-kompiled", "spec.k"];

  test("the two positionals are required and exact", () => {
    expect(parseProveArgs([])).toContain("exactly a kompiled definition directory and a spec file");
    expect(parseProveArgs(["one"])).toContain("exactly a kompiled definition directory and a spec file");
    expect(parseProveArgs([...minimal, "extra"])).toContain("exactly a kompiled definition directory and a spec file");
  });

  test("the minimum maps onto the library's own options object", () => {
    const { options, failureInfo, quiet } = proveInvocation(minimal);
    expect(options.definitionDir).toBe("defn-kompiled");
    expect(options.specFile).toBe("spec.k");
    // Resume is the default everywhere downstream; `--reinit` is the opt-out.
    expect(options.reinit).toBe(false);
    // And so is the digest gate around it; `--no-digest` is that opt-out.
    expect(options.digest).toBe(true);
    expect(options.includeDependencies).toBe(true);
    expect(options.stepTimeout).toBeUndefined();
    expect(failureInfo).toBe(false);
    expect(quiet).toBe(false);
  });

  test("claim selection flags are repeatable and comma-separated", () => {
    const { options } = proveInvocation([
      ...minimal,
      "--labels",
      "A.one,A.two",
      "--labels",
      "A.three",
      "--exclude",
      "A.four",
      "-I",
      "inc1",
      "--include",
      "inc2",
      "--spec-module",
      "A",
      "--no-depends",
    ]);
    expect(options.claimLabels).toEqual(["A.one", "A.two", "A.three"]);
    expect(options.excludeClaimLabels).toEqual(["A.four"]);
    expect(options.includeDirs).toEqual(["inc1", "inc2"]);
    expect(options.specModuleName).toBe("A");
    expect(options.includeDependencies).toBe(false);
  });

  test("prover knobs reach the prover options they name", () => {
    const { options } = proveInvocation([
      ...minimal,
      "--max-depth",
      "4",
      "--max-iterations",
      "10",
      "--bmc-depth",
      "1",
      "--cut-point-rule",
      "IMP.while,IMP.if",
      "--terminal-rule",
      "IMP.done",
      "--fail-fast",
      "--assume-defined",
      "--counterexample-info",
      "--optimize-kcfg",
      "--initialize",
      "--maintenance-rate",
      "5",
      "--step-timeout",
      "120",
    ]);
    expect(options.maxDepth).toBe(4);
    expect(options.maxIterations).toBe(10);
    expect(options.bmcDepth).toBe(1);
    expect(options.cutPointRules).toEqual(["IMP.while", "IMP.if"]);
    expect(options.terminalRules).toEqual(["IMP.done"]);
    expect(options.failFast).toBe(true);
    expect(options.assumeDefined).toBe(true);
    expect(options.counterexampleInfo).toBe(true);
    expect(options.optimizeKcfg).toBe(true);
    expect(options.initializeProofs).toBe(true);
    expect(options.maintenanceRate).toBe(5);
    expect(options.stepTimeout).toBe(120);
  });

  test("--no-digest opens the resume gate for a proof directory written by another tool", () => {
    expect(proveInvocation([...minimal, "--no-digest"]).options.digest).toBe(false);
  });

  test("--step-timeout takes whole positive seconds", () => {
    expect(parseProveArgs([...minimal, "--step-timeout", "0"])).toContain("--step-timeout takes a positive integer");
    expect(parseProveArgs([...minimal, "--step-timeout", "1.5"])).toContain("--step-timeout takes a positive integer");
  });

  test("--max-iterations 0 is a request pyk honours, so zero is allowed there and nowhere else", () => {
    expect(proveInvocation([...minimal, "--max-iterations", "0"]).options.maxIterations).toBe(0);
    expect(parseProveArgs([...minimal, "--workers", "0"])).toContain("--workers takes a positive integer");
    expect(parseProveArgs([...minimal, "--max-depth", "x"])).toContain("--max-depth takes a positive integer");
  });

  test("server flags collect into the explore session options", () => {
    const { options } = proveInvocation([
      ...minimal,
      "--port",
      "9001",
      "--kore-rpc-command",
      "nix run kore-rpc",
      "--llvm-definition",
      "llvm-kompiled",
    ]);
    expect(options.explore).toEqual({
      port: 9001,
      koreRpcCommand: ["nix", "run", "kore-rpc"],
      llvmDefinitionDir: "llvm-kompiled",
    });
  });

  test("no server flags means no explore block at all, so withExplore's defaults stand", () => {
    expect(proveInvocation(minimal).options.explore).toBeUndefined();
  });

  test("a flag at the end with no value, and an unknown option, are named", () => {
    expect(parseProveArgs([...minimal, "--proof-dir"])).toBe("--proof-dir takes a value");
    expect(parseProveArgs([...minimal, "--nope"])).toBe("unknown option: --nope");
  });

  test("--workers selects the concurrent driver", () => {
    expect(proveInvocation([...minimal, "--workers", "4"]).options.maxWorkers).toBe(4);
  });
});

describe("kproof status", () => {
  test("takes exactly two positionals", () => {
    expect(parseStatusArgs([])).toContain("exactly a proof directory and a proof id");
    expect(parseStatusArgs(["dir"])).toContain("exactly a proof directory and a proof id");
    expect(parseStatusArgs(["dir", "id"])).toEqual({ proofDir: "dir", id: "id" });
    expect(parseStatusArgs(["--flag", "dir", "id"])).toBe("unknown option: --flag");
  });

  test("prints a stored proof's summary and exits on its status", async () => {
    const directory = await mkdtemp(join(tmpdir(), "kframework-ts-proof-cli-"));
    try {
      // One node, which is both `init` and `target`: nothing pending, so it
      // passes without a backend ever having been involved.
      const passing = new APRProof(
        "passing",
        KCFG.fromDict({ nodes: nodeDicts(1) }),
        [],
        node(1).id,
        node(1).id,
        new Map(),
        {
          proofDir: directory,
        },
      );
      expect(passing.status).toBe(ProofStatus.PASSED);
      await writeProofData(passing);

      const result = await run(["status", directory, "passing"]);
      expect(result.code).toBe(0);
      expect(result.out).toContain("passing");
      expect(result.err).toBe("");

      const missing = await run(["status", directory, "nope"]);
      expect(missing.code).toBe(1);
      expect(missing.err).not.toBe("");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

describe("renderVerdict", () => {
  test("prints the failure report under a failing proof when asked", () => {
    // Node 3 is a stuck leaf, which is what makes the proof `FAILED` — the
    // only status under which `exec_prove` prints a failure report.
    const kcfg = KCFG.fromDict({ nodes: nodeDicts(3) });
    kcfg.addAttr(3, NodeAttr.STUCK);
    const proof = new APRProof("reported", kcfg, [], node(1).id, node(2).id, new Map());
    proof.failureInfo = new APRFailureInfo({
      failingNodes: [3],
      pendingNodes: [],
      pathConditions: new Map([[3, "{ true #Equals X <=Int 0 }"]]),
      failureReasons: new Map([[3, "Matching failed."]]),
      models: new Map(),
    });
    const verdict = {
      id: proof.id,
      status: proof.status,
      passed: proof.passed,
      proof,
      error: undefined,
      resumed: false,
    };

    // `exec_prove` prints `APRFailureInfo.print()` only under `--failure-info`
    // and only for a failing proof (`__main__.py:283-287`).
    expect(renderVerdict(verdict, false)).not.toContain("Failure reason:");
    const reported = renderVerdict(verdict, true);
    expect(reported).toContain("Failure reason:");
    expect(reported).toContain("Matching failed.");
  });

  test("says so when a claim never became a proof at all", () => {
    const text = renderVerdict(
      {
        id: "SPEC.no-config",
        status: ProofStatus.FAILED,
        passed: false,
        proof: undefined,
        error: new Error("Could not find configuration"),
        resumed: false,
      },
      true,
    );
    expect(text).toContain("SPEC.no-config: no proof was built");
    expect(text).toContain("Proof crashed: Could not find configuration");
  });

  test("prints the summary, and the crash when a proof crashed", () => {
    const proof = new APRProof(
      "crashed",
      KCFG.fromDict({ nodes: nodeDicts(1) }),
      [],
      node(1).id,
      node(1).id,
      new Map(),
    );
    const text = renderVerdict(
      {
        id: proof.id,
        status: proof.status,
        passed: proof.passed,
        proof,
        error: new Error("backend died"),
        resumed: false,
      },
      false,
    );
    expect(text).toContain("crashed");
    expect(text).toContain("Proof crashed: backend died");
  });
});

describe("kproof show argument parsing", () => {
  test("takes exactly three positionals and defaults to pyk's own show settings", () => {
    const parsed = parseShowArgs(["defn-kompiled", "proofs", "SPEC.claim"]);
    expect(parsed).toEqual({
      definitionDir: "defn-kompiled",
      proofDir: "proofs",
      id: "SPEC.claim",
      // `exec_show` sets `minimize=False`, `full_printer=True` (`__main__.py:287-290`).
      minimize: false,
      fullPrinter: true,
      toModule: true,
      omitCells: [],
      nodes: [],
      nodeDeltas: [],
      // Beyond pyk, and off by default so the rendering stays `exec_show`'s.
      showRules: false,
      dot: false,
    });
    expect(parseShowArgs(["a", "b"])).toContain("takes exactly");
    expect(parseShowArgs(["a", "b", "c", "d"])).toContain("takes exactly");
  });

  test("switches flip their defaults", () => {
    const parsed = parseShowArgs([
      "d",
      "p",
      "i",
      "--minimize",
      "--no-full-printer",
      "--no-module",
      "--show-rules",
      "--dot",
    ]);
    expect(parsed).toMatchObject({
      minimize: true,
      fullPrinter: false,
      toModule: false,
      showRules: true,
      dot: true,
    });
  });

  test("--omit-cell is comma-separated and repeatable", () => {
    expect(parseShowArgs(["d", "p", "i", "--omit-cell", "<a>,<b>", "--omit-cell", "<c>"])).toMatchObject({
      omitCells: ["<a>", "<b>", "<c>"],
    });
  });

  test("node ids are integers or @aliases; anything else is a usage error", () => {
    expect(parseShowArgs(["d", "p", "i", "--node", "7", "--node", "@target"])).toMatchObject({
      nodes: [7, "@target"],
    });
    expect(parseShowArgs(["d", "p", "i", "--node-delta", "3,7"])).toMatchObject({ nodeDeltas: [[3, 7]] });
    expect(parseShowArgs(["d", "p", "i", "--node", "zero"])).toContain("--node takes");
    expect(parseShowArgs(["d", "p", "i", "--node-delta", "3"])).toContain("--node-delta takes");
    expect(parseShowArgs(["d", "p", "i", "--node-delta", "3,4,5"])).toContain("--node-delta takes");
    expect(parseShowArgs(["d", "p", "i", "--node"])).toBe("--node takes a value");
    expect(parseShowArgs(["d", "p", "i", "--wat"])).toBe("unknown option: --wat");
  });

  test("a usage error exits 2 and a missing proof exits 1", async () => {
    expect((await run(["show", "only-one"])).code).toBe(2);
    const dir = await mkdtemp(join(tmpdir(), "kframework-ts-proof-cli-show-"));
    expect((await run(["show", dir, dir, "nope"])).code).toBe(1);
  });
});
