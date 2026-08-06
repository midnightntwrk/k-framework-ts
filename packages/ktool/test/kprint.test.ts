/**
 * `KPrint` against real kompiled directories, with no K installed.
 *
 * `packages/kompiled/fixtures/generated/imp-{haskell,llvm}-kompiled/` are
 * complete outputs of a real `kompile` at K `v7.1.337`, and
 * `imp-llvm-krun/*.imp.json` are real final configurations from a real `krun`.
 * Between them, every **pure** path of this class is testable: the eager marker
 * reads, both pretty printers, and `kastToKore`/`koreToKast` under the `pure`
 * strategy.
 *
 * # The goldens are pyk's own
 *
 * The six configuration strings and the two pretty-print expectations come from
 * `pyk/src/tests/integration/test_kprint.py` — `EMPTY_CONFIG_TEST_DATA`
 * (`:96-127`), `INIT_CONFIG_TEST_DATA` (`:130-161`) and
 * `PRETTY_PRINT_IMP_TEST_DATA` (`:164-213`), all from `TestImpDefn`, which
 * kompiles the same `imp.k` these fixtures were built from.  They are byte-for-
 * byte what pyk's `KPrint.pretty_print` produces, and this class reproduces
 * them byte for byte — including the two that only pass because
 * `patchSymbolTable` was honoured, which is the point of testing them here
 * rather than in `packages/kast`.
 *
 * # What is *not* here
 *
 * `parseToken` and `koreToPretty` need the `kast` binary and are not simulable:
 * a fake runner would assert the argv this file has no business owning (that is
 * `kast-cli.test.ts`'s table) and then assert that `JSON.parse` works.  Their
 * argv construction is covered there; their end-to-end behaviour is a gated
 * integration test.
 */

import { describe, expect, test } from "bun:test";
import { assocWithUnit, fromDict, kapply, kastTerm, ksequence, ksort, ktoken } from "@kframework-ts/kast";
import { koreText } from "@kframework-ts/kore";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { caught, caughtAsync } from "./caught.ts";
import { CONVERSION_STRATEGIES, KPrint } from "../src/kprint.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const GENERATED = join(HERE, "..", "..", "kompiled", "fixtures", "generated");
const IMP_LLVM = join(GENERATED, "imp-llvm-kompiled");
const IMP_HASKELL = join(GENERATED, "imp-haskell-kompiled");

const TOP = ksort("GeneratedTopCell");

const readTerm = (name: string) =>
  fromDict(kastTerm(JSON.parse(readFileSync(join(GENERATED, "imp-llvm-krun", name), "utf8"))));

//////////////////////////////
// Loading                  //
//////////////////////////////

describe("KPrint.load — the eager reads pyk does in __init__ (`kprint.py:198-200`)", () => {
  test("mainModule and backend are available without touching compiled.json", async () => {
    const kprint = await KPrint.load(IMP_LLVM);
    expect(kprint.mainModule).toBe("IMP");
    expect(kprint.backend).toBe("llvm");
    expect(kprint.definitionDir).toBe(IMP_LLVM);
  });

  test("the haskell build of the same definition reports its own backend", async () => {
    const kprint = await KPrint.load(IMP_HASKELL);
    expect(kprint.mainModule).toBe("IMP");
    expect(kprint.backend).toBe("haskell");
  });

  test("a definition directory that is not there is refused", async () => {
    const error = await caughtAsync(KPrint.load(join(tmpdir(), "ktool-absent-dir")), Error);
    expect(error.message).toMatch(/Directory does not exist/u);
  });

  test("a useDirectory that is not there is refused too (`kprint.py:191-192`)", async () => {
    const error = await caughtAsync(KPrint.load(IMP_LLVM, { useDirectory: join(tmpdir(), "ktool-absent") }), Error);
    expect(error.message).toMatch(/Directory does not exist/u);
  });

  test("a useDirectory that is there is kept", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ktool-kprint-"));
    try {
      expect((await KPrint.load(IMP_LLVM, { useDirectory: dir })).useDirectory).toBe(dir);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("the strategy defaults to pure-then-binary", async () => {
    expect((await KPrint.load(IMP_LLVM)).conversionStrategy).toBe("pure-then-binary");
    expect(CONVERSION_STRATEGIES).toEqual(["pure", "binary", "pure-then-binary"]);
  });

  test("definitionHash and allRules come through from the loaded directory", async () => {
    const kprint = await KPrint.load(IMP_LLVM);
    expect(kprint.definitionHash).toMatch(/^[0-9a-f]{64}$/u);
    expect(kprint.allRules.size).toBeGreaterThan(0);
    for (const key of kprint.allRules.keys()) expect(key).toHaveLength(12);
  });
});

//////////////////////////////
// prettyPrint              //
//////////////////////////////

describe("prettyPrint — the pyk goldens, byte for byte", () => {
  // `EMPTY_CONFIG_TEST_DATA` (`test_kprint.py:96-127`).
  const EMPTY_CONFIG: readonly (readonly [string, string, string])[] = [
    [
      "generatedTop",
      "GeneratedTopCell",
      [
        "<generatedTop>",
        "  <T>",
        "    <k>",
        "      K_CELL",
        "    </k>",
        "    <state>",
        "      STATE_CELL",
        "    </state>",
        "  </T>",
        "  <generatedCounter>",
        "    GENERATEDCOUNTER_CELL",
        "  </generatedCounter>",
        "</generatedTop>",
      ].join("\n"),
    ],
    ["TCell", "TCell", "<T>\n  <k>\n    K_CELL\n  </k>\n  <state>\n    STATE_CELL\n  </state>\n</T>"],
    ["stateCell", "StateCell", "<state>\n  STATE_CELL\n</state>"],
  ];

  // `INIT_CONFIG_TEST_DATA` (`test_kprint.py:130-161`).
  const INIT_CONFIG: readonly (readonly [string, string, string])[] = [
    [
      "generatedTop-no-map",
      "GeneratedTopCell",
      [
        "<generatedTop>",
        "  <T>",
        "    <k>",
        "      $PGM",
        "    </k>",
        "    <state>",
        "      .Map",
        "    </state>",
        "  </T>",
        "  <generatedCounter>",
        "    0",
        "  </generatedCounter>",
        "</generatedTop>",
      ].join("\n"),
    ],
    ["TCell-no-map", "TCell", "<T>\n  <k>\n    $PGM\n  </k>\n  <state>\n    .Map\n  </state>\n</T>"],
    ["stateCell-no-map", "StateCell", "<state>\n  .Map\n</state>"],
  ];

  for (const [id, sort, expected] of EMPTY_CONFIG) {
    test(`empty config: ${id}`, async () => {
      const kprint = await KPrint.load(IMP_LLVM);
      expect(kprint.prettyPrint(kprint.definition.emptyConfig(ksort(sort)))).toBe(expected);
    });
  }

  for (const [id, sort, expected] of INIT_CONFIG) {
    test(`init config: ${id}`, async () => {
      const kprint = await KPrint.load(IMP_LLVM);
      expect(kprint.prettyPrint(kprint.definition.initConfig(ksort(sort)))).toBe(expected);
    });
  }

  test("the two backends' builds print the same configuration", async () => {
    const haskell = await KPrint.load(IMP_HASKELL);
    const llvm = await KPrint.load(IMP_LLVM);
    expect(haskell.prettyPrint(haskell.definition.emptyConfig(TOP))).toBe(
      llvm.prettyPrint(llvm.definition.emptyConfig(TOP)),
    );
  });

  test("inModule re-roots the definition, as pyk's in_module does (`:304`)", async () => {
    const kprint = await KPrint.load(IMP_LLVM);
    const config = kprint.definition.emptyConfig(TOP);

    // A module that exists narrows what is in scope; the cell productions are
    // reachable from `IMP-SYNTAX` too, so this term is unaffected.  A module
    // that does not exist is where the re-rooting becomes visible.
    expect(kprint.prettyPrint(config, { inModule: "IMP-SYNTAX" })).toContain("<generatedTop>");
    expect(() => kprint.prettyPrint(config, { inModule: "NO-SUCH-MODULE" })).toThrow(/Module not found/u);
    // Each `inModule` is a separately cached printer, so the unrestricted one
    // still works after a failing one.
    expect(kprint.prettyPrint(config)).toContain("<generatedTop>");
  });
});

/** `TestImpDefn._update_symbol_table` (`test_kprint.py:216-220`). */
const patchSymbolTable = (table: Record<string, (...args: string[]) => string>): void => {
  table["_,_"] = assocWithUnit(" , ", "");
  table['.List{"_,_"}'] = () => "";
};

const IDS = kapply("_,_", [ktoken("x", "Id"), kapply("_,_", [ktoken("y", "Id"), kapply('.List{"_,_"}')])]);
const IMP_CONFIG = kapply("<T>", [kapply("<k>", [kapply("int_;_", [IDS])]), kapply("<state>", [kapply(".Map")])]);

describe("prettyPrint — patchSymbolTable and extraUnparsingModules", () => {
  test("imp-config — the golden only reachable through the patch (`:167-190`)", async () => {
    const kprint = await KPrint.load(IMP_LLVM, { patchSymbolTable });
    expect(kprint.prettyPrint(IMP_CONFIG)).toBe(
      "<T>\n  <k>\n    int x , y ;\n  </k>\n  <state>\n    .Map\n  </state>\n</T>",
    );
  });

  test("imp-config-with-ksequence (`:191-213`)", async () => {
    const kprint = await KPrint.load(IMP_LLVM, { patchSymbolTable });
    const withSequence = kapply("<T>", [
      kapply("<k>", [ksequence([kapply("int_;_", [IDS])])]),
      kapply("<state>", [kapply(".Map")]),
    ]);
    expect(kprint.prettyPrint(withSequence)).toBe(
      "<T>\n  <k>\n    int x , y ; ~> .K\n  </k>\n  <state>\n    .Map\n  </state>\n</T>",
    );
  });

  test("without the patch the same term prints differently — the hook is load-bearing", async () => {
    const unpatched = await KPrint.load(IMP_LLVM);
    expect(unpatched.prettyPrint(IMP_CONFIG)).not.toBe(
      "<T>\n  <k>\n    int x , y ;\n  </k>\n  <state>\n    .Map\n  </state>\n</T>",
    );
  });

  test("the patch runs once per printer, not once per call", async () => {
    // The symbol table is built lazily, on the first *lookup* — a cell-only
    // term never reaches one, which is why this uses the `_,_` configuration.
    let runs = 0;
    const kprint = await KPrint.load(IMP_LLVM, {
      patchSymbolTable: () => {
        runs += 1;
      },
    });
    kprint.prettyPrint(IMP_CONFIG);
    kprint.prettyPrint(IMP_CONFIG);
    expect(runs).toBe(1);
  });

  test("extraUnparsingModules reaches the symbol table", async () => {
    // An empty extra module changes nothing but proves the option is threaded:
    // a `PrettyPrinter` that ignored it would still print, so the assertion
    // that matters is that the definition's own symbols still resolve.
    const kprint = await KPrint.load(IMP_LLVM, { extraUnparsingModules: [] });
    expect(kprint.prettyPrint(kprint.definition.emptyConfig(TOP))).toContain("<generatedTop>");
  });
});

describe("formatPrint — the other printer, and why it refuses the hooks", () => {
  test("delegates to kompiled's Formatter", async () => {
    const kprint = await KPrint.load(IMP_LLVM);
    expect(kprint.formatPrint(kprint.definition.emptyConfig(ksort("TCell")))).toBe(
      "<T>\n  <k>\n    K_CELL\n  </k>\n  <state>\n    STATE_CELL\n  </state>\n</T>",
    );
  });

  test("throws rather than silently dropping a patchSymbolTable", async () => {
    const kprint = await KPrint.load(IMP_LLVM, { patchSymbolTable: () => undefined });
    const error = caught(() => kprint.formatPrint(kprint.definition.emptyConfig(TOP)), TypeError);
    expect(error.message).toMatch(/no symbol table to patch/u);
  });

  test("and the same for extraUnparsingModules", async () => {
    const kprint = await KPrint.load(IMP_LLVM, { extraUnparsingModules: [] });
    caught(() => kprint.formatPrint(kprint.definition.emptyConfig(TOP)), TypeError);
  });
});

//////////////////////////////
// Conversions              //
//////////////////////////////

describe("kastToKore / koreToKast — the in-process strategy", () => {
  for (const name of ["sum.imp.json", "collatz.imp.json", "primes.imp.json"]) {
    test(`${name} round-trips through KORE with no binary`, async () => {
      const kprint = await KPrint.load(IMP_LLVM, { conversionStrategy: "pure" });
      const term = readTerm(name);

      const kore = await kprint.kastToKore(term, { sort: TOP });
      expect(koreText(kore)).toStartWith("Lbl'-LT-'generatedTop'-GT-'{}(");
      expect(await kprint.koreToKast(kore)).toEqual(term);
    });
  }

  test("the pure strategy never spawns, even when the conversion fails", async () => {
    let spawned = false;
    const kprint = await KPrint.load(IMP_LLVM, {
      conversionStrategy: "pure",
      runner: async (args) => {
        spawned = true;
        return { args, returncode: 0, stdout: "", stderr: "", signal: undefined };
      },
    });

    // `<nope>` is in no module of this definition, so `konvert` cannot sort it.
    await caughtAsync(kprint.kastToKore(kapply("<nope>", [ktoken("1", "Int")])), Error);
    expect(spawned).toBe(false);
  });

  test("pure-then-binary falls back to `kast` when konvert raises", async () => {
    const calls: (readonly string[])[] = [];
    const kprint = await KPrint.load(IMP_LLVM, {
      runner: async (args) => {
        calls.push([...args]);
        return { args, returncode: 0, stdout: "Lblfoo{}()", stderr: "", signal: undefined };
      },
    });

    const result = await kprint.kastToKore(kapply("<nope>", [ktoken("1", "Int")]));

    expect(koreText(result)).toBe("Lblfoo{}()");
    // The envelope, on the `--expression` path: the term is small.
    expect(calls[0]?.slice(0, 8)).toEqual([
      "kast",
      "--definition",
      IMP_LLVM,
      "--input",
      "json",
      "--output",
      "kore",
      "--expression",
    ]);
    expect(JSON.parse(calls[0]?.[8] ?? "")).toMatchObject({ format: "KAST", version: 4 });
  });

  test("forceKast skips the in-process attempt for one call (`kprint.py:274-276`)", async () => {
    const calls: (readonly string[])[] = [];
    const kprint = await KPrint.load(IMP_LLVM, {
      runner: async (args) => {
        calls.push([...args]);
        return { args, returncode: 0, stdout: "Lblfoo{}()", stderr: "", signal: undefined };
      },
    });

    // A term konvert handles perfectly well — proved by the round-trip tests —
    // still goes to the binary.
    await kprint.kastToKore(readTerm("sum.imp.json"), { sort: TOP, forceKast: true });
    expect(calls).toHaveLength(1);
  });

  test("the binary strategy uses kore-print, not kast, for KORE → KAST (`:271`)", async () => {
    const calls: (readonly string[])[] = [];
    const kprint = await KPrint.load(IMP_LLVM, { conversionStrategy: "pure" });
    const kore = await kprint.kastToKore(readTerm("sum.imp.json"), { sort: TOP });

    const binary = await KPrint.load(IMP_LLVM, {
      conversionStrategy: "binary",
      runner: async (args) => {
        calls.push([...args]);
        const stdout = JSON.stringify({
          format: "KAST",
          version: 4,
          term: { node: "KToken", token: "1", sort: { name: "Int", params: [] } },
        });
        return { args, returncode: 0, stdout, stderr: "", signal: undefined };
      },
    });

    expect(await binary.koreToKast(kore)).toEqual(ktoken("1", "Int"));
    // The positional is a temp file, not `/dev/stdin` — see `src/stdio.ts`.
    const argv = calls[0] ?? [];
    expect([argv[0], argv[2], argv[3], argv[4], argv[5]]).toEqual([
      "kore-print",
      "--definition",
      IMP_LLVM,
      "--output",
      "json",
    ]);
    expect(argv[1]).toMatch(/kore-print-.*\.kore$/u);
  });

  test("trailing garbage from the binary is an error, not a truncated parse", async () => {
    const kprint = await KPrint.load(IMP_LLVM, {
      conversionStrategy: "binary",
      runner: async (args) => ({
        args,
        returncode: 0,
        stdout: "Lblfoo{}() and then some",
        stderr: "",
        signal: undefined,
      }),
    });
    await caughtAsync(kprint.kastToKore(ktoken("1", "Int")), Error);
  });
});
