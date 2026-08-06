/**
 * `src/cli.ts` — the two parsing subcommands.
 *
 * `check-k` is tested in `ksources.test.ts`, next to the code it drives; this
 * file is the rest of the command surface: dispatch, usage errors, and the two
 * subcommands that read files.
 *
 * Both halves of the filesystem seam are exercised on purpose, for the same
 * reason `slurp.test.ts` splits: an **in-memory** {@link FileSystem} states the
 * markdown gate, the option handling and the failure paths without checking in
 * files that exist only to be read, while the **real disk** is what
 * `fixtures/parse-outer/d.k` needs, because directory-relative `require`
 * resolution and `-I` search are half of what that case is checking.
 *
 * Nothing here reaches the network: `main`'s fetcher is only consulted by
 * `check-k`, which these cases never invoke.
 */

import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { USAGE, defaultMainModule, main } from "../src/cli.ts";
import type { FileSystem } from "../src/slurp.ts";
import { PARSE_OUTER, readFixture } from "./fixtures.ts";

//////////////////////////////
// Harness                  //
//////////////////////////////

/** Captures both output streams of one `main` invocation. */
function sinks() {
  const out: string[] = [];
  const err: string[] = [];
  return {
    out,
    err,
    writeOut: (t: string) => void out.push(t),
    writeErr: (t: string) => void err.push(t),
    get stdout(): string {
      return out.join("");
    },
    get stderr(): string {
      return err.join("");
    },
  };
}

/** A {@link FileSystem} over a plain map; paths are used as written. */
function memoryFs(files: Readonly<Record<string, string>>): FileSystem {
  return {
    readFile(path: string): string {
      const text = files[path];
      if (text === undefined) throw new Error(`ENOENT: no such file or directory, open '${path}'`);
      return text;
    },
    isFile(path: string): boolean {
      return files[path] !== undefined;
    },
    resolve(path: string): string {
      return path;
    },
  };
}

/** A fetcher that fails loudly, so a test that reaches the network says so. */
const noFetcher = () => Promise.reject(new Error("the CLI tests never fetch"));

/** Runs one command line against an in-memory filesystem. */
async function run(argv: readonly string[], files: Readonly<Record<string, string>> = {}) {
  const s = sinks();
  const code = await main(argv, s.writeOut, s.writeErr, noFetcher, memoryFs(files));
  return { code, stdout: s.stdout, stderr: s.stderr };
}

//////////////////////////////
// Dispatch and usage       //
//////////////////////////////

describe("dispatch", () => {
  test("--help, -h and help all print the usage on stdout and exit 0", async () => {
    const runs = await Promise.all(["--help", "-h", "help"].map((flag) => run([flag])));
    for (const { code, stdout, stderr } of runs) {
      expect(code).toBe(0);
      expect(stdout).toBe(`${USAGE}\n`);
      expect(stderr).toBe("");
    }
  });

  test("the usage names all three subcommands", () => {
    expect(USAGE).toContain("k-parser parse <file>");
    expect(USAGE).toContain("k-parser parse-outer <file>");
    expect(USAGE).toContain("k-parser check-k <k-release>");
  });

  test("no arguments is usage on stderr, exit 2", async () => {
    const { code, stdout, stderr } = await run([]);
    expect(code).toBe(2);
    expect(stdout).toBe("");
    expect(stderr).toBe(`${USAGE}\n`);
  });

  test("an unknown command names itself, exit 2", async () => {
    const { code, stderr } = await run(["parse-inner"]);
    expect(code).toBe(2);
    expect(stderr).toContain("unknown command: parse-inner");
  });
});

describe("usage errors", () => {
  const cases = [
    { argv: ["parse"], contains: "parse takes exactly one file" },
    { argv: ["parse", "a.k", "b.k"], contains: "takes exactly one file, got a.k and b.k" },
    { argv: ["parse", "--nope", "a.k"], contains: "unknown option: --nope" },
    { argv: ["parse", "a.k", "--md-selector"], contains: "--md-selector takes a value" },
    // `-I` is `parse-outer`'s alone: `parse` never resolves a require, so
    // accepting an include directory it would ignore would be a lie.
    { argv: ["parse", "a.k", "-I", "lib"], contains: "parse has no -I option" },
    { argv: ["parse-outer"], contains: "parse-outer takes exactly one file" },
    { argv: ["parse-outer", "a.k", "--main-module"], contains: "--main-module takes a value" },
    { argv: ["parse-outer", "a.k", "-I"], contains: "-I takes a value" },
    { argv: ["parse-outer", "-x", "a.k"], contains: "unknown option: -x" },
  ] as const;

  for (const { argv, contains } of cases) {
    test(`${argv.join(" ")} → 2, "${contains}"`, async () => {
      const { code, stdout, stderr } = await run(argv);
      expect(code).toBe(2);
      expect(stdout).toBe("");
      expect(stderr).toContain(contains);
      // A usage error always prints the usage, so the fix is on screen.
      expect(stderr).toContain("k-parser <command>");
    });
  }
});

//////////////////////////////
// parse                    //
//////////////////////////////

describe("parse", () => {
  test("prints the surface AST of one .k file, source and all", async () => {
    const { code, stdout, stderr } = await run(["parse", "/a.k"], {
      "/a.k": "module A\n  imports B\n  rule x => y\nendmodule",
    });
    expect(code).toBe(0);
    expect(stderr).toBe("");
    // One line of JSON, exactly as pyk's `json.dumps` writes it.
    expect(stdout.endsWith("\n")).toBe(true);
    expect(stdout.trimEnd()).not.toContain("\n");

    expect(JSON.parse(stdout)).toEqual({
      node: "Definition",
      modules: [
        {
          node: "Module",
          source: "/a.k",
          location: [1, 1, 4, 10],
          name: "A",
          sentences: [
            {
              node: "Rule",
              source: "/a.k",
              location: [3, 8, 3, 8],
              bubble: "x => y",
              label: "",
              att: { node: "Att", items: [] },
            },
          ],
          imports: [{ node: "Import", module_name: "B", public: true }],
          att: { node: "Att", items: [] },
        },
      ],
      requires: [],
    });
  });

  test("requires are reported, never followed", async () => {
    // `missing.k` does not exist, and `parse` still succeeds — that is the
    // whole difference between this subcommand and `parse-outer`.
    const { code, stdout } = await run(["parse", "/a.k"], { "/a.k": 'requires "missing.k"\nmodule A\nendmodule' });
    expect(code).toBe(0);
    expect(JSON.parse(stdout)).toMatchObject({ requires: [{ node: "Require", path: "missing.k" }] });
  });

  test("a .md file is fence-selected; a .k file with the same bytes is not", async () => {
    const md = "prose\n\n```k\nmodule YES\nendmodule\n```\n\n```other\nmodule NO\nendmodule\n```\n";
    const selected = await run(["parse", "/a.md"], { "/a.md": md });
    expect(selected.code).toBe(0);
    expect(names(selected.stdout)).toEqual(["YES"]);

    // Gated purely on the suffix (`utils.py:74`), so the fences are just text
    // the outer lexer has to choke on.
    const notMarkdown = await run(["parse", "/a.k"], { "/a.k": md });
    expect(notMarkdown.code).toBe(1);
    expect(notMarkdown.stdout).toBe("");
  });

  test("--md-selector overrides the default of 'k'", async () => {
    const md = "```k\nmodule A\nendmodule\n```\n```foo\nmodule B\nendmodule\n```\n";
    expect(names((await run(["parse", "/a.md"], { "/a.md": md })).stdout)).toEqual(["A"]);
    expect(names((await run(["parse", "/a.md", "--md-selector", "foo"], { "/a.md": md })).stdout)).toEqual(["B"]);
    expect(names((await run(["parse", "/a.md", "--md-selector", "k | foo"], { "/a.md": md })).stdout)).toEqual([
      "A",
      "B",
    ]);
  });

  test("a parse failure is exit 1 with the KParseError message on stderr", async () => {
    const { code, stdout, stderr } = await run(["parse", "/a.k"], { "/a.k": "module A\nendmodul" });
    expect(code).toBe(1);
    expect(stdout).toBe("");
    // `source:line:col: description`, the shape `KParseError` gives when it has
    // a source — which is the point of passing the path to `OuterParser`.
    expect(stderr).toBe("/a.k:2:1: Expected KW_CLAIM, KW_CONFIG, KW_RULE, got: ID_LOWER\n");
  });

  test("a lexer failure is the same exit code, with pyk's location-only message", async () => {
    // The lexer has no `source` to interpolate (`outer_lexer.py` raises before
    // the parser is involved), so the message is `line:col:` alone — a
    // divergence from pyk in the *other* direction, which raises a
    // location-free `ValueError` there.
    const { code, stderr } = await run(["parse", "/a.k"], { "/a.k": "module A\n  syntax\nendmodule" });
    expect(code).toBe(1);
    expect(stderr).toBe("3:1: Unexpected token: endmodule\n");
  });

  test("a file that is not there is exit 1 with the filesystem's own message", async () => {
    const { code, stderr } = await run(["parse", "/nope.k"]);
    expect(code).toBe(1);
    expect(stderr).toContain("no such file or directory");
    expect(stderr).toContain("/nope.k");
  });
});

/** The module names of a `parse` dump. */
function names(stdout: string): readonly string[] {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  const parsed = JSON.parse(stdout) as { modules: readonly { name: string }[] };
  return parsed.modules.map((module) => module.name);
}

//////////////////////////////
// parse-outer              //
//////////////////////////////

/**
 * The golden term with every `Source` attribute removed.
 *
 * `parse-outer/*.expected.json` was produced with `include_source=False`
 * (`test_utils.py:22-38`), and the CLI keeps pyk's own default of `True`
 * (`utils.py:28`, and `__main__.py:433-438` passes nothing) — so the goldens are
 * the term modulo that one attribute, which the next test then checks is
 * actually there.
 */
function withoutSources(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => withoutSources(item));
  if (typeof value !== "object" || value === null) return value;
  const entries = Object.entries(value)
    .filter(([key]) => key !== "org.kframework.attributes.Source")
    .map(([key, item]) => [key, withoutSources(item)] as const);
  return Object.fromEntries(entries);
}

describe("parse-outer", () => {
  // The one case that must run on the real disk: `d.k` requires `b.k` and
  // `c.k`, both of which require `a.k`, and the module order in the output is
  // the DFS order that resolution produces.
  const dotK = join(PARSE_OUTER, "d.k");
  const golden = JSON.parse(readFixture(PARSE_OUTER, "d.k.expected.json")) as unknown;

  async function runReal(argv: readonly string[]) {
    const s = sinks();
    const code = await main(argv, s.writeOut, s.writeErr, noFetcher);
    return { code, stdout: s.stdout, stderr: s.stderr };
  }

  test("d.k matches the pyk golden, inside a KAST v4 envelope", async () => {
    const { code, stdout, stderr } = await runReal(["parse-outer", dotK, "-I", join(PARSE_OUTER, "include")]);
    expect(code).toBe(0);
    expect(stderr).toBe("");

    // oxlint-disable-next-line typescript/no-unsafe-type-assertion
    const document = JSON.parse(stdout) as { format: string; version: number; term: unknown };
    expect(document.format).toBe("KAST");
    expect(document.version).toBe(4);
    expect(withoutSources(document.term)).toEqual(golden);
  });

  test("and every module records the file it came from", async () => {
    const { stdout } = await runReal(["parse-outer", dotK]);
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion
    const document = JSON.parse(stdout) as {
      term: { modules: readonly { att: { att: Record<string, unknown> } }[] };
    };
    const sources = document.term.modules.map((module) => module.att.att["org.kframework.attributes.Source"]);
    expect(sources).toHaveLength(8);
    for (const source of sources) expect(typeof source).toBe("string");
    expect(sources.filter((source) => typeof source === "string" && source.endsWith("/d.k"))).toHaveLength(2);
  });

  test("--main-module defaults to the file's stem, upper-cased", async () => {
    const { stdout } = await runReal(["parse-outer", dotK]);
    expect(JSON.parse(stdout)).toMatchObject({ term: { mainModule: "D" } });
  });

  test("--main-module overrides it, and a name no module has fails with exit 1", async () => {
    const named = await runReal(["parse-outer", dotK, "--main-module", "B"]);
    expect(named.code).toBe(0);
    expect(JSON.parse(named.stdout)).toMatchObject({ term: { mainModule: "B" } });

    const wrong = await runReal(["parse-outer", dotK, "--main-module", "NOPE"]);
    expect(wrong.code).toBe(1);
    expect(wrong.stderr).toContain("Module not found: NOPE");
  });

  test("a require that resolves nowhere names every path searched, exit 1", async () => {
    // `include.k` requires `e.k`, which lives in `include/` — without `-I`
    // there is nowhere for it to be found.
    const { code, stdout, stderr } = await runReal(["parse-outer", join(PARSE_OUTER, "include.k")]);
    expect(code).toBe(1);
    expect(stdout).toBe("");
    expect(stderr).toBe(`e.k not found. Searched paths: ['${PARSE_OUTER}']\n`);
  });

  test("-I repeats, and the directories are searched in the order given", async () => {
    const files = {
      "/main.k": 'requires "x.k"\nmodule MAIN\n  imports ONE\nendmodule',
      "/one/x.k": "module ONE\nendmodule",
      "/two/x.k": "module TWO\nendmodule",
    };
    const first = await run(["parse-outer", "/main.k", "-I", "/one", "-I", "/two"], files);
    expect(first.code).toBe(0);
    expect(moduleNames(first.stdout)).toEqual(["MAIN", "ONE"]);

    const second = await run(["parse-outer", "/main.k", "--include", "/two", "--include", "/one"], files);
    expect(second.code).toBe(0);
    expect(moduleNames(second.stdout)).toEqual(["MAIN", "TWO"]);
  });

  test("--md-selector reaches slurping, and .md gating still applies", async () => {
    const md = "```k\nmodule A\nendmodule\n```\n```foo\nmodule B\nendmodule\n```\n";
    const selected = await run(["parse-outer", "/a.md", "--md-selector", "foo", "--main-module", "B"], { "/a.md": md });
    expect(selected.code).toBe(0);
    expect(moduleNames(selected.stdout)).toEqual(["B"]);
  });

  test("the sentence layer pyk cannot run is what makes this work at all", async () => {
    // `_ast_to_kast.py:57-60` raises on any sentence; this is the same input
    // through this package.
    const { code, stdout } = await run(["parse-outer", "/a.k"], {
      "/a.k": 'module A\n  syntax Foo ::= "foo"\n  rule foo => .K\nendmodule',
    });
    expect(code).toBe(0);
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion
    const document = JSON.parse(stdout) as {
      term: { modules: readonly { localSentences: readonly { node: string }[] }[] };
    };
    expect(document.term.modules[0]?.localSentences.map((sentence) => sentence.node)).toEqual([
      "KProduction",
      "KBubble",
    ]);
  });
});

/** The module names of a `parse-outer` document. */
function moduleNames(stdout: string): readonly string[] {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  const parsed = JSON.parse(stdout) as { term: { modules: readonly { name: string }[] } };
  return parsed.term.modules.map((module) => module.name);
}

//////////////////////////////
// defaultMainModule        //
//////////////////////////////

describe("defaultMainModule", () => {
  // `Path(...).stem.upper()` (`__main__.py:431`): the *last* suffix only, and
  // nothing at all from a name that is all suffix.
  const cases = [
    ["imp.k", "IMP"],
    ["/a/b/imp.k", "IMP"],
    ["a/b/domains.md", "DOMAINS"],
    ["a.b.k", "A.B"],
    ["no-extension", "NO-EXTENSION"],
    [".k", ".K"],
    ["C:\\semantics\\imp.k", "IMP"],
  ] as const;

  for (const [file, expected] of cases) {
    test(`${file} → ${expected}`, () => {
      expect(defaultMainModule(file)).toBe(expected);
    });
  }
});
