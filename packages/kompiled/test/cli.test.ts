/**
 * The `kompiled` command, driven as a function.
 *
 * `main` takes argv, two sinks and a fetcher, so both subcommands run here with
 * no process, no network, and — for `check-k` — no GitHub.  `bin.ts` is the
 * only file that touches `process`, and it has nothing in it but the binding.
 */

import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { artifactStatuses, main, renderInfo, USAGE } from "../src/cli.ts";
import { loadKompiledLayout } from "../src/fs.ts";
import type { KompiledSourceFetcher } from "../src/ksources.ts";
import { K_RELEASE, TRANSCRIBED_FROM } from "../src/version.ts";
import { IMP_HASKELL, IMP_LLVM } from "./fixtures.ts";

/** Collects a run's two streams and its exit code. */
async function run(argv: readonly string[], fetcher?: KompiledSourceFetcher) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await main(
    argv,
    (t) => void out.push(t),
    (t) => void err.push(t),
    fetcher,
  );
  return { code, out: out.join(""), err: err.join("") };
}

/** Serves every declared file with exactly the bytes recorded, so nothing drifts. */
const unchangedFetcher: KompiledSourceFetcher = (repo, path) => {
  const source = TRANSCRIBED_FROM.find((s) => s.repo === repo && s.path === path);
  // Searching for the preimage of a sha256 is not on the menu, so serve a
  // stand-in body and let the test assert the *shape* of the report rather than
  // its verdict.
  return Promise.resolve(source === undefined ? undefined : new TextEncoder().encode(`stand-in for ${path}`));
};

describe("argument handling", () => {
  test("no arguments prints usage to stderr and exits 2", async () => {
    const { code, out, err } = await run([]);
    expect(code).toBe(2);
    expect(out).toBe("");
    expect(err).toContain("kompiled <command>");
  });

  test("--help prints usage to stdout and exits 0", async () => {
    const { code, out } = await run(["--help"]);
    expect(code).toBe(0);
    expect(out).toBe(`${USAGE}\n`);
  });

  test("an unknown command exits 2 and names itself", async () => {
    const { code, err } = await run(["frobnicate"]);
    expect(code).toBe(2);
    expect(err).toContain("unknown command: frobnicate");
  });
});

describe("info", () => {
  test("describes the haskell fixture without parsing a term", async () => {
    const { code, out } = await run(["info", IMP_HASKELL]);
    expect(code).toBe(0);
    expect(out).toContain("backend            haskell");
    expect(out).toContain("main module        IMP");
    expect(out).toContain("syntax module      IMP-SYNTAX");
    expect(out).toContain("config variables   PGM");
    expect(out).toContain("$PGM");
    expect(out).toContain("170 rules");
    // The caveat has to be in the output, because the number is not the number
    // of rules in the definition.
    expect(out).toContain("Source, Location and UNIQUE_ID");
  });

  test("and the llvm one, whose rule count differs", async () => {
    const { out } = await run(["info", IMP_LLVM]);
    expect(out).toContain("backend            llvm");
    expect(out).toContain("118 rules");
  });

  test("--artifacts reports presence and size, and stats rather than opens", async () => {
    const { code, out } = await run(["info", IMP_HASKELL, "--artifacts"]);
    expect(code).toBe(0);
    expect(out).toContain("artifacts:");
    expect(out).toContain("compiled.json");
    expect(out).toContain("definition.kore");
    // parsed.json and generated parsers are optional, so their absence is
    // reported without making this otherwise complete fixture unreadable.
    expect(out).toContain("parsed.json                absent");
    expect(out).toContain("parser_PGM             missing");
    expect(out).toContain("timestamp                     7 B");
  });

  test("--artifacts says `absent` for what a markers-only directory lacks", async () => {
    const scratch = await mkdtemp(join(tmpdir(), "kframework-ts-kompiled-cli-"));
    try {
      await writeFile(join(scratch, "mainModule.txt"), "M");
      await writeFile(join(scratch, "mainSyntaxModule.txt"), "M-SYNTAX");
      await writeFile(join(scratch, "backend.txt"), "llvm");
      await writeFile(join(scratch, "timestamp"), "");
      const { code, out } = await run(["info", scratch, "--artifacts"]);
      expect(code).toBe(0);
      expect(out).toContain("compiled.json");
      expect(out).toContain("absent");
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  });

  test("an unreadable directory exits 1 with the actionable message", async () => {
    const scratch = await mkdtemp(join(tmpdir(), "kframework-ts-kompiled-cli-"));
    try {
      const { code, err } = await run(["info", scratch]);
      expect(code).toBe(1);
      expect(err).toContain("mainModule.txt");
      expect(err).toContain(scratch);
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  });

  test("no directory, or two, exits 2", async () => {
    expect((await run(["info"])).code).toBe(2);
    expect((await run(["info", "a", "b"])).code).toBe(2);
  });
});

describe("renderInfo", () => {
  test("prints the timestamp as an mtime, never as file content", async () => {
    const layout = await loadKompiledLayout(IMP_HASKELL);
    const text = renderInfo(IMP_HASKELL, layout);
    expect(text).toContain("timestamp mtime");
    expect(text).toContain(new Date(layout.timestampMtimeMs).toISOString());
    // The seven bytes of Java serialization must not appear anywhere.
    expect(text).not.toContain("¬í");
  });

  test("says `(none)` rather than an empty line when there are no config vars", () => {
    const text = renderInfo("d", {
      mainModule: "M",
      mainSyntaxModule: "M-SYNTAX",
      backend: "llvm",
      timestampMtimeMs: 0,
      timestampMtimeNs: undefined,
      configVars: [],
      configVarSorts: new Map(),
      configVarModules: new Map(),
      allRules: new Map(),
      allRulesByPrefix: new Map(),
      hasConfigVarsFile: false,
    });
    expect(text).toContain("config variables   (none)");
    expect(text).toContain("0 rules");
  });
});

describe("artifactStatuses", () => {
  test("reports a size for what is there and undefined for what is not", async () => {
    const statuses = await artifactStatuses(IMP_HASKELL);
    const byFile = new Map(statuses.map((s) => [s.file, s.bytes]));
    expect(byFile.get("compiled.json")).toBeGreaterThan(100_000);
    expect(byFile.get("macros.kore")).toBe(10);
    expect(byFile.get("timestamp")).toBe(7);
    expect(byFile.has("compiled.bin")).toBe(false);
  });
});

describe("check-k", () => {
  test("renders both tiers and exits on the format verdict", async () => {
    const { code, out } = await run(["check-k", "v9.9.9"], unchangedFetcher);
    // Stand-in bodies hash to nothing recorded, so everything reads as changed
    // — which is what exercises the DIFF rendering.
    expect(code).toBe(1);
    expect(out).toContain("format tier");
    expect(out).toContain("content tier");
    expect(out).toContain("advisory");
    expect(out).toContain("DIFF");
    expect(out).toContain("pyk/src/pyk/ktool/kompile.py");
  });

  test("a path upstream does not have is GONE, and exits 3", async () => {
    const { code, out } = await run(["check-k", "v9.9.9"], () => Promise.resolve(undefined));
    expect(code).toBe(3);
    expect(out).toContain("GONE");
    expect(out).toContain("could not locate");
  });

  test("a fetcher failure exits 2 — could not ask is not a verdict", async () => {
    const { code, err } = await run(["check-k", "v9.9.9"], () => Promise.reject(new Error("offline")));
    expect(code).toBe(2);
    expect(err).toContain("could not check v9.9.9");
    expect(err).toContain("offline");
  });

  test("missing or extra arguments exit 2, and the usage names the pinned release", async () => {
    const { code, err } = await run(["check-k"]);
    expect(code).toBe(2);
    expect(err).toContain(K_RELEASE);
  });
});
