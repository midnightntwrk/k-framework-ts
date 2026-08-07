/**
 * `src/kompiled.ts` — the artifacts, the laziness, and the error contract.
 *
 * Most of this runs against the two real fixture directories.  Where a case
 * needs a directory that no `kompile` on this machine produced (a KAST v3
 * `compiled.json`, an inline KORE definition), it is fed through a synthetic
 * {@link KompiledSource} instead of being written to disk — which is the point
 * of the class taking a source rather than a path.
 *
 * # One upstream assertion is deliberately not ported
 *
 * `pyk/src/tests/integration/test_kompile.py:71-93` asserts that a production
 * written `syntax Foo ::= "foo" [symbol(foo)] | "qux"` gets the klabels `foo`
 * and `qux_SYMBOL_Foo` — i.e. that an unnamed alternative is given a generated
 * symbol.  **Declined, not missed.**  It tests `kompile`'s *naming* pass, which
 * runs before any file this package reads exists; reproducing it needs a K
 * install and a second kompiled fixture, and what it would then exercise is the
 * Java frontend, not the reader.  Nothing here would change if K changed the
 * generated-symbol spelling tomorrow — `compiled.json` would simply say the new
 * one, and `definition.symbols` would report it.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { ksort, kvariable } from "@kframework-ts/kast";
import { isSubsort, resolveSymbol, sortApp, sortKey, subsorts } from "@kframework-ts/kore";

import {
  InvalidKompiledFileError,
  MissingCompiledJsonError,
  MissingKompiledFileError,
  UnsupportedKastVersionError,
} from "../src/errors.ts";
import { loadKompiledDefinition } from "../src/fs.ts";
import { KompiledDefinition, MACROS_MODULE_NAME, type KompiledArtifact, type KompiledSource } from "../src/kompiled.ts";
import { deriveConfigVars, parseKompiledLayout } from "../src/layout.ts";
import { caught } from "./caught.ts";
import { IMP_HASKELL, IMP_LLVM, UPSTREAM } from "./fixtures.ts";

const BLANK_LAYOUT = parseKompiledLayout({
  mainModule: "TEST",
  mainSyntaxModule: "TEST-SYNTAX",
  backend: "llvm",
  timestampMtimeMs: 0,
});

/** A {@link KompiledSource} over a `Map`, counting reads.  No filesystem at all. */
function sourceOf(artifacts: Partial<Record<KompiledArtifact, string>>): {
  readonly source: KompiledSource;
  readonly reads: string[];
} {
  const reads: string[] = [];
  return {
    reads,
    source: {
      path: "<memory>",
      layout: BLANK_LAYOUT,
      read: (artifact) => {
        reads.push(artifact);
        return artifacts[artifact];
      },
    },
  };
}

describe("laziness", () => {
  test("load reads no artifact — only the markers", () => {
    // A `load()` that eagerly parsed everything would need ~4 GB on a
    // definition that ships today; this is the structural version of that
    // claim.
    const { source, reads } = sourceOf({});
    const kompiled = new KompiledDefinition(source);
    expect(reads).toEqual([]);
    expect(kompiled.layout.mainModule).toBe("TEST");
    expect(reads).toEqual([]);
  });

  test("each artifact is read at most once, however many times it is used", () => {
    const { source, reads } = sourceOf({ "macros.kore": "// macros\n" });
    const kompiled = new KompiledDefinition(source);
    expect(kompiled.macrosKore).toBe(kompiled.macrosKore);
    expect(kompiled.text("macros.kore")).toBe("// macros\n");
    expect(reads).toEqual(["macros.kore"]);
  });

  test("an absent artifact stays absent — the negative result is cached too", () => {
    const { source, reads } = sourceOf({});
    const kompiled = new KompiledDefinition(source);
    expect(() => kompiled.macrosKore).toThrow(MissingKompiledFileError);
    expect(() => kompiled.macrosKore).toThrow(MissingKompiledFileError);
    expect(reads).toEqual(["macros.kore"]);
  });

  test("definition.kore keeps its axiom bodies unparsed after the index is built", async () => {
    // The structural form of the scale claim, not a timing one: indexing reads
    // axiom *attributes* (that is where `subsort{A,B}()` lives) and never a
    // body, so every axiom is still a `LazyAxiom` afterwards.
    const kompiled = await loadKompiledDefinition(IMP_HASKELL);
    const index = kompiled.koreDefinition;

    expect(index.axioms.length).toBe(726);
    expect(index.axioms.every((axiom) => axiom.tag === "LazyAxiom")).toBe(true);

    // …and the tables that a body would be needed for are nonetheless complete.
    expect(index.sorts.size).toBe(30);
    expect(index.symbols.size).toBe(235);
    expect(index.sortTable.image.size).toBeGreaterThan(0);
  });

  test("forceKoreAxiom parses one body on demand, and is idempotent on an Axiom", async () => {
    const kompiled = await loadKompiledDefinition(IMP_HASKELL);
    const lazy = kompiled.koreDefinition.axioms[0]!;
    expect(lazy.tag).toBe("LazyAxiom");

    const forced = kompiled.forceKoreAxiom(lazy);
    expect(forced.tag).toBe("Axiom");
    expect(forced.attrs).toEqual(lazy.attrs);
    // The array still holds the lazy one: forcing does not mutate the index.
    expect(kompiled.koreDefinition.axioms[0]!.tag).toBe("LazyAxiom");
    expect(kompiled.forceKoreAxiom(forced)).toBe(forced);
  });
});

describe("compiled.json", () => {
  test("loads, and its hash is KPrint.definition_hash (ktool/kprint.py:238-240)", async () => {
    const kompiled = await loadKompiledDefinition(IMP_HASKELL);
    expect(kompiled.definition.mainModuleName).toBe("IMP");
    expect(kompiled.definitionHash).toMatch(/^[0-9a-f]{64}$/);
    // Stable across calls, and a property of the definition rather than of the
    // file's bytes.
    expect(kompiled.definitionHash).toBe(kompiled.definition.hash);
  });

  test("llvm and haskell compiled.json differ, and must not be mixed", async () => {
    // `KoreBackend.java:458-460`
    // excludes `symbolic` modules and `HaskellBackend.java:81-84` excludes
    // `concrete` ones, so the module sets diverge from the first pipeline step
    // — and K's own README warns that mixing them "can cause the backends to
    // crash or, worse, give unsound results".  The fixture ships both so this
    // can be asserted rather than trusted.
    const haskell = await loadKompiledDefinition(IMP_HASKELL);
    const llvm = await loadKompiledDefinition(IMP_LLVM);

    expect(haskell.definition.allModules.length).toBe(67);
    expect(llvm.definition.allModules.length).toBe(61);
    expect(haskell.definitionHash).not.toBe(llvm.definitionHash);

    const haskellNames = new Set(haskell.definition.allModules.map((m) => m.name));
    const llvmNames = new Set(llvm.definition.allModules.map((m) => m.name));
    const onlyHaskell = [...haskellNames].filter((n) => !llvmNames.has(n)).toSorted();
    const onlyLlvm = [...llvmNames].filter((n) => !haskellNames.has(n)).toSorted();
    expect(onlyHaskell).toEqual([
      "BOOL-KORE",
      "BYTES-STRING-ENCODE",
      "INT-KORE",
      "INT-SYMBOLIC",
      "INT-SYMBOLIC-KORE",
      "K-EQUAL-KORE",
      "STRING-KORE",
    ]);
    expect(onlyLlvm).toEqual(["BYTES-CONCRETE"]);

    // The syntax slice, by contrast, is byte-identical between the two.
    expect(readFileSync(join(IMP_HASKELL, "syntaxDefinition.kore"), "utf8")).toBe(
      readFileSync(join(IMP_LLVM, "syntaxDefinition.kore"), "utf8"),
    );
  });

  test("allRules.txt joins to the definition through sentenceByUniqueId", async () => {
    // That join is the whole reason `allRules.txt` is worth parsing: it is a
    // `UNIQUE_ID → source location` index over the main module.
    const kompiled = await loadKompiledDefinition(IMP_HASKELL);
    const byId = kompiled.definition.sentenceByUniqueId;
    let joined = 0;
    for (const uniqueId of kompiled.layout.allRules.keys()) if (byId.has(uniqueId)) joined += 1;
    expect(joined).toBe(kompiled.layout.allRules.size);
  });
});

describe("parsed.json", () => {
  test("is optional and remains a distinct pre-compilation definition", () => {
    const absent = new KompiledDefinition(sourceOf({}).source);
    expect(absent.parsedDefinition).toBeUndefined();

    const parsed = readFileSync(join(UPSTREAM, "imp-outer-json", "imp.json"), "utf8");
    const kompiled = new KompiledDefinition(sourceOf({ "parsed.json": parsed }).source);
    expect(kompiled.parsedDefinition?.mainModuleName).toBe("IMP");
    // It cannot silently stand in for compiled.json: compiled-only operations
    // still request the compiled artifact and retain its actionable failure.
    expect(() => kompiled.definition).toThrow(MissingCompiledJsonError);
    expect(() => kompiled.configVars).toThrow(MissingCompiledJsonError);
  });

  test("keeps parsed.json's artifact name in invalid-envelope diagnostics", () => {
    const kompiled = new KompiledDefinition(sourceOf({ "parsed.json": "not json" }).source);
    const error = caught(() => kompiled.parsedDefinition, InvalidKompiledFileError);
    expect(error.file).toBe("parsed.json");
  });
});

describe("error contract", () => {
  test("no compiled.json → the message says to re-kompile with --emit-json", () => {
    // `emitJson` defaults to false in the Java frontend
    // (`KompileOptions.java:159-161`) and true in pyk
    // (`ktool/kompile.py:558`), so a plain CLI `kompile` produces a directory
    // with no `compiled.json` at all.  "ENOENT" would send people looking for
    // a file; what they need is a flag.
    const kompiled = new KompiledDefinition(sourceOf({}).source);
    const error = caught(() => kompiled.definition, MissingCompiledJsonError);
    expect(error.message).toContain("--emit-json");
    expect(error.message).toContain("compiled.json");
  });

  test("KAST v3 → the message names the version found, the version required, and the K release", () => {
    // Two K installs on the survey machine disagreed, 7.1.191 emitting v3 and
    // 7.1.337 emitting v4.  All three facts
    // have to be in the message or the reader cannot act on it.
    const v3 = JSON.stringify({
      format: "KAST",
      version: 3,
      term: { node: "KDefinition" },
    });
    const kompiled = new KompiledDefinition(sourceOf({ "compiled.json": v3 }).source);

    const error = caught(() => kompiled.definition, UnsupportedKastVersionError);
    expect(error.found).toBe(3);
    expect(error.required).toBe(4);
    expect(error.message).toContain("found 3");
    expect(error.message).toContain("version 4 required");
    expect(error.message).toContain("v7.1.320");
  });

  test("a KAST document with no version at all is still a version error", () => {
    const kompiled = new KompiledDefinition(sourceOf({ "compiled.json": '{"format":"KAST"}' }).source);
    expect(() => kompiled.definition).toThrow(UnsupportedKastVersionError);
  });

  test("a wrong-shaped file is an invalid-file error, not a version error", () => {
    // Different remedy: a wrong version is a toolchain age problem, a wrong
    // shape is a wrong file.
    for (const text of ["not json at all", "[]", '{"format":"KORE","version":1}']) {
      const kompiled = new KompiledDefinition(sourceOf({ "compiled.json": text }).source);
      expect(() => kompiled.definition).toThrow(InvalidKompiledFileError);
    }
  });

  test("missing definition.kore is a missing-file error naming the artifact", () => {
    const kompiled = new KompiledDefinition(sourceOf({}).source);
    expect(caught(() => kompiled.koreDefinition, MissingKompiledFileError).file).toBe("definition.kore");
  });
});

describe("macros.kore", () => {
  test("kompile's empty form — literally `// macros\\n` — parses to no modules", async () => {
    const kompiled = await loadKompiledDefinition(IMP_HASKELL);
    expect(kompiled.text("macros.kore")).toBe("// macros\n");
    expect(kompiled.macrosKore.moduleNames).toEqual([]);
    expect(kompiled.macrosKore.axioms).toEqual([]);
  });

  test("the llvm-backend test corpus's empty form — zero bytes — also parses", () => {
    // `fixtures/PROVENANCE.md` flags this: `unparse/ml/macros.kore` is a
    // hand-made test input, not `kompile` output, and a reader must accept
    // both spellings of "empty".
    const text = readFileSync(join(UPSTREAM, "unparse", "ml", "macros.kore"), "utf8");
    expect(text).toBe("");
    const kompiled = new KompiledDefinition(sourceOf({ "macros.kore": text }).source);
    expect(kompiled.macrosKore.moduleNames).toEqual([]);
  });

  test("the emptiness scan knows both KORE comment forms, not just `//`", () => {
    // `kompile` only ever writes `// macros\n`, so a block-comment-only file is
    // unreachable from a kompiled directory — but a scan that recognised half
    // the comment grammar would send the other half to a parser that cannot
    // accept it, which is a wrong answer rather than a narrow one.
    const EMPTY = [
      "",
      "\n\n",
      "// macros\n",
      "  // macros",
      "/* macros */\n",
      "/*\n macros\n*/",
      "/* a */ // b\n/* c */",
      "/* * / not a terminator */",
      "// no trailing newline",
    ];
    for (const text of EMPTY) {
      const kompiled = new KompiledDefinition(sourceOf({ "macros.kore": text }).source);
      expect(kompiled.macrosKore.moduleNames).toEqual([]);
    }
  });

  test("anything with a non-comment character goes to the parser", () => {
    // The scan's contract: it recognises *only* the two forms `kompile` and the
    // llvm-backend actually write, and everything else is the parser's problem.
    // What it hands the parser is a *sentence list*, so the smallest non-empty
    // input is one sentence — not a definition.
    const kompiled = new KompiledDefinition(sourceOf({ "macros.kore": "// c\nsort Foo{} []" }).source);
    expect(kompiled.macrosKore.moduleNames).toEqual([MACROS_MODULE_NAME]);
  });

  test("a whole KORE definition is rejected — `macros.kore` is never one", () => {
    // `ModuleToKORE.java:335-365` never writes `module`/`endmodule` into this
    // file, so a text that has them is
    // not a `macros.kore`, and accepting it would mean the wrapper had to guess
    // which of the two shapes it was looking at.
    const kompiled = new KompiledDefinition(sourceOf({ "macros.kore": "[]\nmodule M endmodule []" }).source);
    expect(() => kompiled.macrosKore).toThrow();
  });

  test("an unterminated block comment is a parse error, not an empty file", () => {
    // Block comments do not nest in KORE and an unterminated one is a lexical
    // error, so the scan must *not* swallow it as "all comment".
    const kompiled = new KompiledDefinition(sourceOf({ "macros.kore": "/* unterminated" }).source);
    expect(() => kompiled.macrosKore).toThrow(/unexpected end of input/);
  });
});

describe("syntaxDefinition.kore", () => {
  test("the fixture's syntax slice indexes, and is much smaller than definition.kore", async () => {
    const kompiled = await loadKompiledDefinition(IMP_HASKELL);
    expect(kompiled.syntaxKore.moduleNames).toEqual(["BASIC-K", "KSEQ", "INJ", "K", "IMP"]);
    expect(kompiled.syntaxKore.sorts.size).toBe(30);
    // The interim mitigation for the memory problem: read this when only
    // sorts, symbols or printing tables are wanted.
    expect(kompiled.text("syntaxDefinition.kore")!.length).toBeLessThan(kompiled.text("definition.kore")!.length / 4);
  });

  test("the llvm-backend's own tiny syntaxDefinition.kore parses too", () => {
    const text = readFileSync(join(UPSTREAM, "unparse", "ml", "syntaxDefinition.kore"), "utf8");
    const kompiled = new KompiledDefinition(sourceOf({ "syntaxDefinition.kore": text }).source);
    expect(kompiled.syntaxKore.sorts.size).toBeGreaterThan(0);
    expect(kompiled.syntaxKore.symbols.size).toBeGreaterThan(0);
  });
});

describe("the KORE sort table, through a loaded definition", () => {
  // `pyk/src/tests/unit/kore/test_kompiled.py`'s A<B, B<C, B<D poset is already
  // transcribed at `packages/kore/test/definition.test.ts:456-530`, where the
  // function under test lives.  What is added here is the same closure property
  // asserted through a *real* kompiled directory — which is the thing the unit
  // fixture is a model of, and the thing that would break if this package fed
  // the indexer the wrong file or the wrong parse mode.

  test("subsorts are transitively closed on a real definition", async () => {
    const kompiled = await loadKompiledDefinition(IMP_HASKELL);
    const index = kompiled.koreDefinition;
    const [int, aexp, kItem] = [sortApp("SortInt"), sortApp("SortAExp"), sortApp("SortKItem")];

    // Declared directly by a `subsort{SortInt{}, SortAExp{}}()` axiom attribute.
    expect(subsorts(index, aexp).map(sortKey)).toEqual(["SortId{}", "SortInt{}"]);
    expect(isSubsort(index, int, aexp)).toBe(true);
    // And transitively: Int < AExp < KItem, with no axiom saying Int < KItem.
    expect(isSubsort(index, aexp, kItem)).toBe(true);
    expect(isSubsort(index, int, kItem)).toBe(true);
    // Not symmetric.
    expect(isSubsort(index, kItem, int)).toBe(false);
  });

  test("test_kompile.py TestSubsortSymbol, on an inline definition", () => {
    // Upstream kompiles `syntax Foo ::= Bar [symbol(bar)]` and asserts
    // `symbol_table.resolve('Lblbar') == (SortFoo, (SortBar,))` and
    // `not sort_table.is_subsort(SortBar, SortFoo)` (`test_kompile.py:106-119`).
    // The point of the second assertion is that a *symbol* production is not a
    // subsort declaration — the two look alike in K source and are unrelated in
    // KORE.  Kompiling here would need K; the KORE it produces does not.
    const text = String.raw`
      []
      module TEST
        sort SortFoo{} []
        sort SortBar{} []
        symbol Lblbar{}(SortBar{}) : SortFoo{} [constructor{}()]
      endmodule []
    `;
    const kompiled = new KompiledDefinition(sourceOf({ "definition.kore": text }).source);
    const index = kompiled.koreDefinition;

    const signature = resolveSymbol(index, "Lblbar");
    expect(signature?.sort).toEqual(sortApp("SortFoo"));
    expect(signature?.paramSorts).toEqual([sortApp("SortBar")]);
    expect(isSubsort(index, sortApp("SortBar"), sortApp("SortFoo"))).toBe(false);
  });
});

describe("configVars, derived", () => {
  test("compiled.json reproduces what configVars.sh says — a cross-artifact oracle", async () => {
    // `CompiledDefinition.java:82-139` computed the file from the definition in
    // the first place, so re-running that computation over `compiled.json`
    // checks a KAST-level reading of the definition against what the Java
    // frontend actually wrote.  This is the strongest cross-artifact check
    // available without `konvert`.
    for (const dir of [IMP_HASKELL, IMP_LLVM]) {
      const kompiled = await loadKompiledDefinition(dir);
      const derived = deriveConfigVars(kompiled.definition);
      expect(new Set(derived.configVars)).toEqual(new Set(kompiled.layout.configVars));
      expect([...derived.configVarSorts]).toEqual([...kompiled.layout.configVarSorts]);
      expect([...derived.configVarModules]).toEqual([...kompiled.layout.configVarModules]);
    }
  });

  test("the file wins when it is present, and the derivation fills in when it is not", async () => {
    const kompiled = await loadKompiledDefinition(IMP_HASKELL);
    expect(kompiled.configVars.configVars).toEqual(["PGM"]);
    expect(kompiled.configVars).toBe(kompiled.layout);

    // The same directory with configVars.sh withheld: the getter falls back.
    const withoutFile = new KompiledDefinition({
      path: IMP_HASKELL,
      layout: parseKompiledLayout({
        mainModule: "IMP",
        mainSyntaxModule: "IMP-SYNTAX",
        backend: "haskell",
        timestampMtimeMs: 0,
      }),
      read: (artifact) =>
        artifact === "compiled.json" ? readFileSync(join(IMP_HASKELL, "compiled.json"), "utf8") : undefined,
    });
    expect(withoutFile.layout.configVars).toEqual([]);
    expect(withoutFile.configVars.configVars).toEqual(["PGM"]);
    expect([...withoutFile.configVars.configVarSorts]).toEqual([["PGM", "Pgm"]]);
  });

  test("the branch is on the file's PRESENCE, not on whether it said anything", () => {
    // A definition with no configuration variables writes a `configVars.sh`
    // that parses to three empty collections.  Branching on emptiness would
    // reach for `compiled.json` on such a directory — and throw
    // `MissingCompiledJsonError` when it is not there, which is the CLI
    // default.  Present-and-empty must be answered from the file.
    const empty = new KompiledDefinition({
      path: "<memory>",
      layout: parseKompiledLayout({
        mainModule: "TEST",
        mainSyntaxModule: "TEST-SYNTAX",
        backend: "llvm",
        timestampMtimeMs: 0,
        configVarsSh: "#!/usr/bin/env bash\n\ndeclaredConfigVars=(\n)\n",
      }),
      read: () => undefined, // no compiled.json at all
    });
    expect(empty.layout.hasConfigVarsFile).toBe(true);
    expect(empty.configVars).toBe(empty.layout);
    expect(empty.configVars.configVars).toEqual([]);
  });

  test("a configVars.sh with only declaredConfigVarModule_ lines is not discarded", () => {
    // Those lines leave `configVars` and `configVarSorts` empty by
    // construction (`CompiledDefinition.java:127-138` appends nothing to the
    // array), so an emptiness test would throw the file's only content away
    // and re-derive over `compiled.json` instead.
    const modulesOnly = new KompiledDefinition({
      path: "<memory>",
      layout: parseKompiledLayout({
        mainModule: "IMP",
        mainSyntaxModule: "IMP-SYNTAX",
        backend: "haskell",
        timestampMtimeMs: 0,
        configVarsSh: "declaredConfigVarModule_PGM='TEST-SYNTAX'\n",
      }),
      // A `compiled.json` that would derive something *different*, so the test
      // fails loudly if the derivation branch is taken.
      read: (artifact) =>
        artifact === "compiled.json" ? readFileSync(join(IMP_HASKELL, "compiled.json"), "utf8") : undefined,
    });
    expect([...modulesOnly.configVars.configVarModules]).toEqual([["PGM", "TEST-SYNTAX"]]);
    expect(modulesOnly.configVars.configVars).toEqual([]);
    expect(modulesOnly.configVars).toBe(modulesOnly.layout);
  });

  test("no configVars.sh and no compiled.json → the --emit-json diagnostic", () => {
    // The derivation branch is the only one that can throw, and this is what
    // it throws: `MissingCompiledJsonError`, not an ENOENT.
    const neither = new KompiledDefinition(sourceOf({}).source);
    expect(neither.layout.hasConfigVarsFile).toBe(false);
    expect(caught(() => neither.configVars, MissingCompiledJsonError).message).toContain("--emit-json");
  });
});

describe("koreToKast is injected, never imported", () => {
  test("absent by default, with an error that names the option", () => {
    const kompiled = new KompiledDefinition(sourceOf({}).source);
    expect(kompiled.hasKoreToKast).toBe(false);
    expect(() => kompiled.koreToKast({ tag: "String", value: "x" })).toThrow(/koreToKast/);
  });

  test("supplied, it is called with the pattern and its result returned unchanged", () => {
    // `konvert` is a sibling of this package, not a dependency: it takes an
    // in-memory `KDefinition` and so depends on `kast` + `kore` exactly as we
    // do.  This is the whole of the edge.
    const marker = kvariable("X");
    const seen: unknown[] = [];
    const kompiled = new KompiledDefinition(sourceOf({}).source, {
      koreToKast: (pattern) => {
        seen.push(pattern);
        return marker;
      },
    });
    expect(kompiled.hasKoreToKast).toBe(true);
    expect(kompiled.koreToKast({ tag: "String", value: "x" })).toBe(marker);
    expect(seen).toEqual([{ tag: "String", value: "x" }]);
  });
});

describe("refused artifacts", () => {
  test("the artifact type admits exactly the five readable artifact names", async () => {
    // `compiled.bin`, `cache.bin`, `haskellDefinition.bin`, `interpreter`,
    // `scanner` and `dt/` are refused rather than half-supported.
    // The type is the enforcement; this test
    // is the record, and it fails if `KompiledArtifact` ever grows a member.
    const kompiled = await loadKompiledDefinition(IMP_HASKELL);
    const artifacts: KompiledArtifact[] = ["compiled.json", "definition.kore", "syntaxDefinition.kore", "macros.kore"];
    for (const artifact of artifacts) expect(kompiled.text(artifact)).toBeDefined();
    expect(kompiled.text("parsed.json")).toBeUndefined();
    expect(ksort("KItem").name).toBe("KItem"); // kast is reachable; sanity.
  });
});

describe("the /core subpath has no filesystem in it", () => {
  const SRC = join(import.meta.dir, "..", "src");

  /** Every `./x.js` specifier in a source file, resolved to `src/x.ts`. */
  function localImports(file: string): readonly string[] {
    const text = readFileSync(join(SRC, file), "utf8");
    return [...text.matchAll(/from "\.\/([A-Za-z0-9_-]+)\.js"/gu)].map((m) => `${m[1]}.ts`);
  }

  /** The `node:` specifiers a file imports. */
  function nodeImports(file: string): readonly string[] {
    const text = readFileSync(join(SRC, file), "utf8");
    return [...text.matchAll(/from "(node:[a-z/]+)"/gu)].map((m) => m[1]!);
  }

  test("core.ts's transitive module graph contains no node: import", () => {
    // `index.ts` re-exports `fs.ts`, so a static import of the package root
    // pulls `node:fs` into the graph whether or not the caller ever reads a
    // directory — which undercuts the README's "build a KompiledSource
    // yourself" story for anything that does not tree-shake.  `core.ts` is the
    // same modules minus `fs.ts`, and this is the property that makes it worth
    // having.  It is asserted structurally rather than by importing, because
    // an import in this process would succeed either way.
    const seen = new Set<string>();
    const queue = ["core.ts"];
    const offenders: string[] = [];
    while (queue.length > 0) {
      const file = queue.pop()!;
      if (seen.has(file)) continue;
      seen.add(file);
      for (const spec of nodeImports(file)) offenders.push(`${file} -> ${spec}`);
      queue.push(...localImports(file));
    }

    expect(offenders).toEqual([]);
    expect(seen).toEqual(
      new Set(["core.ts", "errors.ts", "kompiled.ts", "ksources.ts", "layout.ts", "parser-artifacts.ts", "version.ts"]),
    );
    expect(seen.has("fs.ts")).toBe(false);
  });

  test("index.ts does pull node:fs — which is why the subpath exists", () => {
    expect(localImports("index.ts")).toContain("fs.ts");
    expect(nodeImports("fs.ts").length).toBeGreaterThan(0);
  });

  test("core.ts exports everything the root does except fs.ts's names", async () => {
    const core = await import("../src/core.ts");
    const root = await import("../src/index.ts");
    const fs = await import("../src/fs.ts");

    const fsNames = new Set(Object.keys(fs));
    const expected = Object.keys(root)
      .filter((name) => !fsNames.has(name))
      .toSorted();
    expect(Object.keys(core).toSorted()).toEqual(expected);
  });

  test("package.json declares the subpath, pointing at files the build emits", () => {
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion
    const pkg = JSON.parse(readFileSync(join(SRC, "..", "package.json"), "utf8")) as {
      exports: Record<string, { types: string; import: string }>;
    };
    expect(pkg.exports["./core"]).toEqual({
      types: "./dist/core.d.ts",
      import: "./dist/core.js",
    });
    // The root export includes the core API.
    expect(pkg.exports["."]).toEqual({
      types: "./dist/index.d.ts",
      import: "./dist/index.js",
    });
  });
});
