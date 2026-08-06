/**
 * The kompile argv golden table.
 *
 * Everything here is pure — no K, no filesystem, no network.  That is the point
 * of the module split: `kompileBaseArgs`/`kompileArgs`/`kompileCallArgs` build
 * a `string[]`, so the flag *order* is a testable artifact rather than a
 * property you discover when a build behaves oddly.
 *
 * # Where the goldens come from
 *
 * The two `_build_arg_list` cases below use
 * `c952e77850^:pyk/src/tests/unit/ktool/test_kompile.py` as their option-order
 * oracle. Current pyk uses `Kompile.__call__` and per-backend `args()` instead;
 * each field below notes where current pyk emits it. Everything after these
 * cases is new: upstream has no coverage of any other `KompileArgs` field, of
 * the call-level flags, or of the LLVM backend beyond `--llvm-kompile-type`.
 *
 * # What "pinned" means here
 *
 * The full-matrix tests below spell out an entire argv, in order.  A change to
 * any emission position fails them, deliberately: a build script that recorded
 * an argv is entitled to get the same one back, and this file is the record.
 */

import { describe, expect, test } from "bun:test";

import { caught } from "./caught.ts";
import {
  buildKompileArgv,
  KompileArgumentError,
  kompileArgs,
  kompileBaseArgs,
  kompileCallArgs,
  sortIncludeDirs,
  type KompileSpec,
} from "../src/kompile.ts";

//////////////////////////////
// Recovered upstream cases //
//////////////////////////////

describe("the recovered upstream goldens (test_kompile.py at c952e77850^)", () => {
  test("test_all_args_1 — the haskell case", () => {
    // Upstream's expectation, with three deltas, all of them current-pyk
    // behaviour rather than choices of ours:
    //
    //   * `--output-definition` moved to the **end**: it is emitted by
    //     `Kompile.__call__` (`:303`), after the spec's own flags, where
    //     `_build_arg_list` put it second.
    //   * `--backend` moved to **after** the shared flags: every backend
    //     `args()` starts with `self.base_args.args()` (`:378`).
    //   * `--post-process` is `echo "hello"` and not `'echo "hello"'`.  pyk
    //     `shlex.quote`s it into an argv no shell will read (`:620`), so the
    //     literal single quotes reach `kompile` as part of the value.  A
    //     recorded divergence: the value is passed through unquoted.
    const spec: KompileSpec = {
      backend: "haskell",
      mainFile: "imp.k",
      mainModule: "MAIN-MODULE",
      syntaxModule: "SYNTAX-MODULE",
      includeDirs: ["/", "/include/lib"],
      mdSelector: "k & ! nobytes & ! node",
      hookNamespaces: ["JSON", "KRYPTO", "BLOCKCHAIN"],
      emitJson: true,
      postProcess: 'echo "hello"',
      concreteRules: ["foo", "bar"],
    };

    expect(buildKompileArgv(spec, { command: ["kevm", "kompile"], outputDir: "path/to/kompiled" })).toEqual([
      "kevm",
      "kompile",
      "imp.k",
      "--main-module",
      "MAIN-MODULE",
      "--syntax-module",
      "SYNTAX-MODULE",
      "-I",
      "/",
      "-I",
      "/include/lib",
      "--md-selector",
      "k & ! nobytes & ! node",
      "--hook-namespaces",
      "JSON KRYPTO BLOCKCHAIN",
      "--emit-json",
      "--post-process",
      'echo "hello"',
      "--backend",
      "haskell",
      "--concrete-rules",
      "foo,bar",
      "--output-definition",
      "path/to/kompiled",
    ]);
  });

  test("test_all_args_2 — the llvm case", () => {
    const spec: KompileSpec = {
      backend: "llvm",
      mainFile: "imp.k",
      mainModule: "MAIN-MODULE",
      syntaxModule: "SYNTAX-MODULE",
      includeDirs: ["/", "/include/lib"],
      mdSelector: "k & ! nobytes & ! node",
      hookNamespaces: ["JSON", "KRYPTO", "BLOCKCHAIN"],
      emitJson: true,
      postProcess: 'echo "hello"',
      llvmKompileType: "c",
    };

    expect(buildKompileArgv(spec, { command: ["kevm", "kompile"], outputDir: "path/to/kompiled" })).toEqual([
      "kevm",
      "kompile",
      "imp.k",
      "--main-module",
      "MAIN-MODULE",
      "--syntax-module",
      "SYNTAX-MODULE",
      "-I",
      "/",
      "-I",
      "/include/lib",
      "--md-selector",
      "k & ! nobytes & ! node",
      "--hook-namespaces",
      "JSON KRYPTO BLOCKCHAIN",
      "--emit-json",
      "--post-process",
      'echo "hello"',
      "--backend",
      "llvm",
      "--llvm-kompile-type",
      "c",
      "--output-definition",
      "path/to/kompiled",
    ]);
  });
});

//////////////////////////////
// KompileArgs, field by    //
// field                    //
//////////////////////////////

/** The smallest possible spec.  `--emit-json` is here because pyk defaults it on. */
const MINIMAL = { backend: "llvm", mainFile: "imp.k" } as const satisfies KompileSpec;

describe("KompileArgs.args() — one field at a time", () => {
  test("the minimum is the main file and --emit-json", () => {
    // `emit_json: bool = True` (`:557`) — the opposite of `KompileOptions.java`,
    // and the reason a pyk-built directory has a `compiled.json` at all.
    expect(kompileBaseArgs({ mainFile: "imp.k" })).toEqual(["imp.k", "--emit-json"]);
  });

  test("emitJson: false is the only way to suppress it", () => {
    expect(kompileBaseArgs({ mainFile: "imp.k", emitJson: false })).toEqual(["imp.k"]);
  });

  // Five of the sixteen fields are emitted *before* `--emit-json` (`:592-608`),
  // so each row spells out the whole argv rather than a suffix — which is also
  // what pins each field's side of that boundary.
  const cases: readonly (readonly [string, Parameters<typeof kompileBaseArgs>[0], readonly string[]])[] = [
    ["mainModule", { mainFile: "f.k", mainModule: "M" }, ["f.k", "--main-module", "M", "--emit-json"]],
    ["syntaxModule", { mainFile: "f.k", syntaxModule: "S" }, ["f.k", "--syntax-module", "S", "--emit-json"]],
    ["includeDirs", { mainFile: "f.k", includeDirs: ["a", "b"] }, ["f.k", "-I", "a", "-I", "b", "--emit-json"]],
    [
      "mdSelector",
      { mainFile: "f.k", mdSelector: "k & ! node" },
      ["f.k", "--md-selector", "k & ! node", "--emit-json"],
    ],
    [
      "hookNamespaces",
      { mainFile: "f.k", hookNamespaces: ["A", "B"] },
      ["f.k", "--hook-namespaces", "A B", "--emit-json"],
    ],
    ["genBisonParser", { mainFile: "f.k", genBisonParser: true }, ["f.k", "--emit-json", "--gen-bison-parser"]],
    [
      "genGlrBisonParser",
      { mainFile: "f.k", genGlrBisonParser: true },
      ["f.k", "--emit-json", "--gen-glr-bison-parser"],
    ],
    [
      "bisonParserLibrary",
      { mainFile: "f.k", bisonParserLibrary: true },
      ["f.k", "--emit-json", "--bison-parser-library"],
    ],
    ["postProcess", { mainFile: "f.k", postProcess: "cat" }, ["f.k", "--emit-json", "--post-process", "cat"]],
    ["readOnly", { mainFile: "f.k", readOnly: true }, ["f.k", "--emit-json", "--read-only-kompiled-directory"]],
    ["coverage", { mainFile: "f.k", coverage: true }, ["f.k", "--emit-json", "--coverage"]],
    ["bisonLists", { mainFile: "f.k", bisonLists: true }, ["f.k", "--emit-json", "--bison-lists"]],
    ["outerParsedJson", { mainFile: "f.k", outerParsedJson: true }, ["f.k", "--emit-json", "--outer-parsed-json"]],
    ["topCell", { mainFile: "f.k", topCell: "G" }, ["f.k", "--emit-json", "--top-cell", "G"]],
  ];

  for (const [name, args, expected] of cases) {
    test(`${name} alone`, () => {
      expect(kompileBaseArgs(args)).toEqual([...expected]);
    });
  }

  test("every field at once, in emission order (`:589-637`)", () => {
    expect(
      kompileBaseArgs({
        mainFile: "imp.k",
        mainModule: "IMP",
        syntaxModule: "IMP-SYNTAX",
        includeDirs: ["/z", "/a"],
        mdSelector: "k",
        hookNamespaces: ["JSON", "KRYPTO"],
        emitJson: true,
        genBisonParser: true,
        genGlrBisonParser: true,
        bisonParserLibrary: true,
        postProcess: "cat",
        readOnly: true,
        coverage: true,
        bisonLists: true,
        outerParsedJson: true,
        topCell: "GeneratedTopCell",
      }),
    ).toEqual([
      "imp.k",
      "--main-module",
      "IMP",
      "--syntax-module",
      "IMP-SYNTAX",
      "-I",
      "/a",
      "-I",
      "/z",
      "--md-selector",
      "k",
      "--hook-namespaces",
      "JSON KRYPTO",
      "--emit-json",
      "--gen-bison-parser",
      "--gen-glr-bison-parser",
      "--bison-parser-library",
      "--post-process",
      "cat",
      "--read-only-kompiled-directory",
      "--coverage",
      "--bison-lists",
      "--outer-parsed-json",
      "--top-cell",
      "GeneratedTopCell",
    ]);
  });

  test("a false flag and an empty string emit nothing — pyk gates on truthiness", () => {
    expect(
      kompileBaseArgs({
        mainFile: "f.k",
        mainModule: "",
        syntaxModule: "",
        includeDirs: [],
        mdSelector: "",
        hookNamespaces: [],
        genBisonParser: false,
        readOnly: false,
        topCell: "",
      }),
    ).toEqual(["f.k", "--emit-json"]);
  });
});

describe("include directories", () => {
  test("are sorted, not kept in caller order (`:569`)", () => {
    expect(sortIncludeDirs(["c", "a", "b"])).toEqual(["a", "b", "c"]);
    expect(kompileBaseArgs({ mainFile: "f.k", emitJson: false, includeDirs: ["/z", "/a", "/m"] })).toEqual([
      "f.k",
      "-I",
      "/a",
      "-I",
      "/m",
      "-I",
      "/z",
    ]);
  });

  test("get one flag each, unlike --hook-namespaces and --concrete-rules", () => {
    // Three ways to spell a list, all three live in one argv.  This is the
    // distinction most easily "tidied" into a bug.
    const argv = kompileArgs({
      backend: "haskell",
      mainFile: "f.k",
      emitJson: false,
      includeDirs: ["a", "b"],
      hookNamespaces: ["X", "Y"],
      concreteRules: ["r1", "r2"],
    });
    expect(argv).toEqual([
      "f.k",
      "-I",
      "a",
      "-I",
      "b",
      "--hook-namespaces",
      "X Y",
      "--backend",
      "haskell",
      "--concrete-rules",
      "r1,r2",
    ]);
  });

  test("the sort is over strings, not pathlib parts", () => {
    // `Path('/a/b') < Path('/a.c')` in Python (part-wise: `'a' < 'a.c'`), and
    // the reverse here (`'.' < '/'`).  Documented divergence; only `-I` order
    // is observable and `kompile` treats `-I` as a set.
    expect(sortIncludeDirs(["/a/b", "/a.c"])).toEqual(["/a.c", "/a/b"]);
  });
});

//////////////////////////////
// Per-backend flags        //
//////////////////////////////

/** The LLVM spec at one optimisation level, and nothing else set. */
const atOptLevel = (optLevel: number): string[] =>
  kompileArgs({ backend: "llvm", mainFile: "f.k", emitJson: false, optLevel });

/** The LLVM spec at one `--iterated-threshold`, and nothing else set. */
const atThreshold = (iteratedThreshold: string): string[] =>
  kompileArgs({ backend: "llvm", mainFile: "f.k", emitJson: false, iteratedThreshold });

describe("backend flags", () => {
  test("maude takes nothing of its own (`:402-406`)", () => {
    expect(kompileArgs({ backend: "maude", mainFile: "f.k", emitJson: false })).toEqual(["f.k", "--backend", "maude"]);
  });

  test("haskell: --concrete-rules is comma-joined into one element", () => {
    expect(
      kompileArgs({ backend: "haskell", mainFile: "f.k", emitJson: false, concreteRules: ["a", "b", "c"] }),
    ).toEqual(["f.k", "--backend", "haskell", "--concrete-rules", "a,b,c"]);
  });

  test("haskell: haskellBinary defaults true, and only its negation has a flag", () => {
    expect(kompileArgs({ backend: "haskell", mainFile: "f.k", emitJson: false })).toEqual([
      "f.k",
      "--backend",
      "haskell",
    ]);
    expect(kompileArgs({ backend: "haskell", mainFile: "f.k", emitJson: false, haskellBinary: true })).toEqual([
      "f.k",
      "--backend",
      "haskell",
    ]);
    expect(kompileArgs({ backend: "haskell", mainFile: "f.k", emitJson: false, haskellBinary: false })).toEqual([
      "f.k",
      "--backend",
      "haskell",
      "--no-haskell-binary",
    ]);
  });

  test("llvm: every field at once, in emission order (`:482-525`)", () => {
    expect(
      kompileArgs({
        backend: "llvm",
        mainFile: "f.k",
        emitJson: false,
        llvmKompileType: "c",
        llvmKompileOutput: "out/lib",
        optLevel: 2,
        ccopts: ["-g", "-lm"],
        noLlvmKompile: true,
        enableSearch: true,
        enableLlvmDebug: true,
        llvmProofHintInstrumentation: true,
        llvmProofHintDebugging: true,
        llvmHiddenVisibility: true,
        llvmMutableBytes: true,
        iteratedThreshold: "1/2",
        heuristic: "gTO",
      }),
    ).toEqual([
      "f.k",
      "--backend",
      "llvm",
      "--llvm-kompile-type",
      "c",
      "--llvm-kompile-output",
      "out/lib",
      "-O2",
      "-ccopt",
      "-g",
      "-ccopt",
      "-lm",
      "--no-llvm-kompile",
      "--enable-search",
      "--enable-llvm-debug",
      "--llvm-proof-hint-instrumentation",
      "--llvm-proof-hint-debugging",
      "--llvm-hidden-visibility",
      "--llvm-mutable-bytes",
      "--iterated-threshold",
      "1/2",
      "--heuristic",
      "gTO",
    ]);
  });

  test("llvm: -O0 emits nothing, -O1..-O3 emit the flag", () => {
    // `if self.opt_level:` (`:492`) — 0 is "leave the default alone".
    expect(atOptLevel(0)).toEqual(["f.k", "--backend", "llvm"]);
    expect(atOptLevel(1)).toEqual(["f.k", "--backend", "llvm", "-O1"]);
    expect(atOptLevel(3)).toEqual(["f.k", "--backend", "llvm", "-O3"]);
  });

  test("llvm: an out-of-range optLevel throws, with the number in the message", () => {
    // pyk's message is `'Invalid optimization level: {opt_level}'` — a literal,
    // not an f-string (`:459`).  Fixed silently, per the quirk ledger.
    const error = caught(() => kompileArgs({ backend: "llvm", mainFile: "f.k", optLevel: 4 }), KompileArgumentError);
    expect(error.message).toBe("Invalid optimization level: 4");
    expect(() => kompileArgs({ backend: "llvm", mainFile: "f.k", optLevel: -1 })).toThrow(KompileArgumentError);
    expect(() => kompileArgs({ backend: "llvm", mainFile: "f.k", optLevel: 1.5 })).toThrow(KompileArgumentError);
  });

  test("llvm: iteratedThreshold is a string, and '0' is emitted where Fraction(0) is not", () => {
    // The documented consequence of dropping `fractions.Fraction`: pyk gates on
    // truthiness and `Fraction(0)` is falsy, while the string `"0"` is not.
    expect(atThreshold("1/2")).toEqual(["f.k", "--backend", "llvm", "--iterated-threshold", "1/2"]);
    expect(atThreshold("0")).toEqual(["f.k", "--backend", "llvm", "--iterated-threshold", "0"]);
    expect(atThreshold("")).toEqual(["f.k", "--backend", "llvm"]);
  });
});

//////////////////////////////
// Call-level suffix flags  //
//////////////////////////////

describe("Kompile.__call__ suffix flags (`:301-333`)", () => {
  const cases: readonly (readonly [string, Parameters<typeof kompileCallArgs>[0], readonly string[]])[] = [
    ["outputDir", { outputDir: "out" }, ["--output-definition", "out"]],
    ["tempDir", { tempDir: "tmp" }, ["--temp-dir", "tmp"]],
    ["typeInferenceMode", { typeInferenceMode: "checked" }, ["--type-inference-mode", "checked"]],
    ["warnings", { warnings: "none" }, ["--warnings", "none"]],
    ["warningsToErrors", { warningsToErrors: true }, ["--warnings-to-errors"]],
    ["noExcWrap", { noExcWrap: true }, ["--no-exc-wrap"]],
    ["debug", { debug: true }, ["--debug"]],
    ["verbose", { verbose: true }, ["--verbose"]],
    ["outerParsedJson", { outerParsedJson: true }, ["--outer-parsed-json"]],
    ["ignoreWarnings", { ignoreWarnings: ["a", "b"] }, ["-Wno", "a,b"]],
  ];

  for (const [name, options, expected] of cases) {
    test(`${name} alone`, () => {
      expect(kompileCallArgs(options)).toEqual([...expected]);
    });
  }

  test("all of them at once, in emission order", () => {
    expect(
      kompileCallArgs({
        outputDir: "out",
        tempDir: "tmp",
        typeInferenceMode: "checked",
        warnings: "all",
        warningsToErrors: true,
        noExcWrap: true,
        debug: true,
        verbose: true,
        outerParsedJson: true,
        ignoreWarnings: ["unused-var", "non-exhaustive-match"],
      }),
    ).toEqual([
      "--output-definition",
      "out",
      "--temp-dir",
      "tmp",
      "--type-inference-mode",
      "checked",
      "--warnings",
      "all",
      "--warnings-to-errors",
      "--no-exc-wrap",
      "--debug",
      "--verbose",
      "--outer-parsed-json",
      "-Wno",
      "unused-var,non-exhaustive-match",
    ]);
  });

  test("-Wno is two elements, the codes comma-joined into the second", () => {
    // Not `-Wno=a,b`, and not one element per code.  `:332-333`.
    const argv = kompileCallArgs({ ignoreWarnings: ["one", "two", "three"] });
    expect(argv).toEqual(["-Wno", "one,two,three"]);
    expect(argv).toHaveLength(2);
  });

  test("an empty ignoreWarnings emits nothing", () => {
    expect(kompileCallArgs({ ignoreWarnings: [] })).toEqual([]);
  });

  test("nothing set emits nothing", () => {
    expect(kompileCallArgs({})).toEqual([]);
  });
});

//////////////////////////////
// Composition              //
//////////////////////////////

describe("buildKompileArgv", () => {
  test("defaults the command to ['kompile'] (`:296`)", () => {
    expect(buildKompileArgv(MINIMAL)).toEqual(["kompile", "imp.k", "--emit-json", "--backend", "llvm"]);
  });

  test("a multi-word command is spread, not shell-quoted", () => {
    // `command + self.args()` (`:299`) — `['kevm', 'kompile']` is two argv
    // elements, and there is no shell anywhere to re-split a joined string.
    expect(buildKompileArgv(MINIMAL, { command: ["kevm", "kompile"] }).slice(0, 2)).toEqual(["kevm", "kompile"]);
  });

  test("--outer-parsed-json is emitted once even when both the spec and the call ask", () => {
    // The quirk ledger's first row: `:631` and `:329` can both fire.
    const argv = buildKompileArgv({ ...MINIMAL, outerParsedJson: true }, { outerParsedJson: true });
    expect(argv.filter((a) => a === "--outer-parsed-json")).toHaveLength(1);
    expect(argv).toEqual(["kompile", "imp.k", "--emit-json", "--outer-parsed-json", "--backend", "llvm"]);
  });

  test("--outer-parsed-json from the call alone lands after --verbose, not with the spec flags", () => {
    expect(buildKompileArgv(MINIMAL, { verbose: true, outerParsedJson: true })).toEqual([
      "kompile",
      "imp.k",
      "--emit-json",
      "--backend",
      "llvm",
      "--verbose",
      "--outer-parsed-json",
    ]);
  });

  test("spec flags always precede call flags", () => {
    const argv = buildKompileArgv(
      { backend: "llvm", mainFile: "imp.k", optLevel: 2 },
      { outputDir: "out", debug: true },
    );
    expect(argv.indexOf("-O2")).toBeLessThan(argv.indexOf("--output-definition"));
    expect(argv.indexOf("--output-definition")).toBeLessThan(argv.indexOf("--debug"));
  });
});
