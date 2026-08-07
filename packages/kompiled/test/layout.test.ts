/**
 * `src/layout.ts` — the pure half.
 *
 * Every case here is fed a string, never a path, which is the property the
 * module exists to have.  The strings are either the real fixture bytes (read
 * once, at the top, so the *parsing* stays disk-free) or hand-written cases for
 * the shapes upstream can produce but IMP does not.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  attEntry,
  Atts,
  attKey,
  ANY_TYPE,
  KAtt,
  kapply,
  kclaim,
  KDefinition,
  kflatmodule,
  kimport,
  kproduction,
  krule,
  ktoken,
  kvariable,
} from "@kframework-ts/kast";

import {
  deriveConfigVars,
  distinctLineCount,
  duplicateRuleIds,
  lookupRule,
  parseAllRules,
  parseConfigVars,
  parseKompiledLayout,
  RULE_HASH_PREFIX_LENGTH,
} from "../src/layout.ts";
import { IMP_HASKELL, IMP_LLVM } from "./fixtures.ts";

const read = (dir: string, file: string): string => readFileSync(join(dir, file), "utf8");

describe("marker files", () => {
  test("have no trailing newline — the byte-level claim the trim exists for", () => {
    // `KompileFrontEnd.java:98-110` writes bare names, and pyk reads them
    // *unstripped* (`ktool/kompile.py:655,660`), which only works because of
    // this.  If K ever adds a newline, pyk silently breaks and this fails.
    expect(read(IMP_HASKELL, "mainModule.txt")).toBe("IMP");
    expect(read(IMP_HASKELL, "mainSyntaxModule.txt")).toBe("IMP-SYNTAX");
    expect(read(IMP_HASKELL, "backend.txt")).toBe("haskell");
    expect(read(IMP_LLVM, "backend.txt")).toBe("llvm");
  });

  test("are trimmed anyway", () => {
    // Ours deviates from pyk deliberately: an editor that added a newline
    // should not produce a module name that matches nothing.
    const layout = parseKompiledLayout({
      mainModule: "IMP\n",
      mainSyntaxModule: "  IMP-SYNTAX  ",
      backend: "haskell\r\n",
      timestampMtimeMs: 0,
    });
    expect(layout.mainModule).toBe("IMP");
    expect(layout.mainSyntaxModule).toBe("IMP-SYNTAX");
    expect(layout.backend).toBe("haskell");
  });

  test("an unknown backend reads back as itself rather than throwing", () => {
    // pyk builds a `KompileBackend` enum and raises; refusing to open a
    // directory because K grew a fifth backend would be the wrong failure.
    expect(parseKompiledLayout({ ...BLANK, backend: "wasm" }).backend).toBe("wasm");
  });
});

const BLANK = { mainModule: "M", mainSyntaxModule: "M-SYNTAX", backend: "llvm", timestampMtimeMs: 0 } as const;

describe("timestamp", () => {
  test("is seven bytes of Java serialization and is never parsed", () => {
    // `KompileFrontEnd.java:116` serializes the empty string.  There is no
    // code path in this package that opens the file; the layout takes an
    // mtime, and this asserts the *reason*.
    const bytes = readFileSync(join(IMP_HASKELL, "timestamp"));
    expect([...bytes]).toEqual([0xac, 0xed, 0x00, 0x05, 0x74, 0x00, 0x00]);
  });

  test("the layout takes the mtime it is given, not anything read from disk", () => {
    const layout = parseKompiledLayout({ ...BLANK, timestampMtimeMs: 1_700_000_000_000 });
    expect(layout.timestampMtimeMs).toBe(1_700_000_000_000);
    expect(layout.timestampMtimeNs).toBeUndefined();
  });
});

describe("configVars.sh", () => {
  const text = read(IMP_HASKELL, "configVars.sh");

  test("the real file is 82 bytes", () => {
    expect(Buffer.byteLength(text, "utf8")).toBe(82);
  });

  test("both forms IMP uses are read by regex, never by executing the script", () => {
    const parsed = parseConfigVars(text);
    expect(parsed.configVars).toEqual(["PGM"]);
    expect([...parsed.configVarSorts]).toEqual([["PGM", "Pgm"]]);
    expect([...parsed.configVarModules]).toEqual([]);
  });

  test("the llvm and haskell files agree — configVars.sh is backend-independent", () => {
    expect(read(IMP_LLVM, "configVars.sh")).toBe(text);
  });

  test("the third form — declaredConfigVarModule_ — and multiple variables", () => {
    // Synthesised in `CompiledDefinition.java:127-138`'s shape.  IMP has no
    // `cell`+`parser` production, so this is the only place the form is
    // exercised against a literal file.
    const parsed = parseConfigVars(
      [
        "#!/usr/bin/env bash",
        "",
        "declaredConfigVar_PGM='Pgm'",
        "declaredConfigVar_INPUT='List'",
        "declaredConfigVars=(",
        "    'PGM'",
        "    'INPUT'",
        ")",
        "declaredConfigVarModule_PGM='TEST-SYNTAX'",
        "",
      ].join("\n"),
    );
    expect(parsed.configVars).toEqual(["PGM", "INPUT"]);
    expect([...parsed.configVarSorts]).toEqual([
      ["PGM", "Pgm"],
      ["INPUT", "List"],
    ]);
    expect([...parsed.configVarModules]).toEqual([["PGM", "TEST-SYNTAX"]]);
  });

  test("declaredConfigVarModule_ is not mistaken for a declaredConfigVar_", () => {
    // The two prefixes are a prefix of each other; the module lines are
    // removed before the sort pass for exactly this reason.
    const parsed = parseConfigVars("declaredConfigVarModule_PGM='TEST-SYNTAX'\n");
    expect([...parsed.configVarSorts]).toEqual([]);
    expect([...parsed.configVarModules]).toEqual([["PGM", "TEST-SYNTAX"]]);
  });

  test("an absent or empty file is empty, not an error", () => {
    // It is re-derivable from `compiled.json`, so its absence must not stop a
    // load.
    const parsed = parseConfigVars("");
    expect(parsed.configVars).toEqual([]);
    expect(parsed.configVarSorts.size).toBe(0);
  });

  test("hasConfigVarsFile distinguishes an absent file from an empty one", () => {
    // The three ConfigVars fields cannot: a definition with no configuration
    // variables writes a `configVars.sh` that parses to three empty
    // collections.  `KompiledDefinition.configVars` branches on this flag and
    // not on emptiness, so the flag has to carry the distinction.
    expect(parseKompiledLayout(BLANK).hasConfigVarsFile).toBe(false);
    expect(parseKompiledLayout({ ...BLANK, configVarsSh: "" }).hasConfigVarsFile).toBe(true);
    expect(parseKompiledLayout({ ...BLANK, configVarsSh: read(IMP_HASKELL, "configVars.sh") }).hasConfigVarsFile).toBe(
      true,
    );
  });

  test("a modules-only file is present and non-empty, though configVars is empty", () => {
    // `declaredConfigVarModule_` lines leave `configVars` and `configVarSorts`
    // empty by construction, so an emptiness test would discard this file.
    const layout = parseKompiledLayout({ ...BLANK, configVarsSh: "declaredConfigVarModule_PGM='TEST-SYNTAX'\n" });
    expect(layout.hasConfigVarsFile).toBe(true);
    expect(layout.configVars).toEqual([]);
    expect(layout.configVarSorts.size).toBe(0);
    expect([...layout.configVarModules]).toEqual([["PGM", "TEST-SYNTAX"]]);
  });
});

describe("allRules.txt", () => {
  const text = read(IMP_HASKELL, "allRules.txt");
  const { allRules, allRulesByPrefix } = parseAllRules(text);

  test("has no trailing newline and every line splits on a space", () => {
    // `Kompile.java:378-380` joins with `\n` and writes no terminator.
    expect(text.endsWith("\n")).toBe(false);
    expect(text.split("\n").every((line) => line.includes(" "))).toBe(true);
    expect(text.includes("\t")).toBe(false);
  });

  test("the fixture's 170 rules all parse", () => {
    expect(allRules.size).toBe(170);
    expect(text.split("\n").length).toBe(170);
    expect(parseAllRules(text).duplicateRuleIds).toEqual([]);
  });

  test("keys are full-length sha256 hex, and the 12-char index is pyk's", () => {
    for (const [key, rule] of allRules) {
      expect(key).toMatch(/^[0-9a-f]{64}$/);
      expect(rule.uniqueId).toBe(key);
    }
    expect(allRulesByPrefix.size).toBeLessThanOrEqual(allRules.size);
    for (const key of allRulesByPrefix.keys()) expect(key.length).toBe(RULE_HASH_PREFIX_LENGTH);
  });

  test("colons survive in the path — the location splits from the right", () => {
    // Every location in this file is an absolute `/nix/store/…` path, so the
    // source must never be asserted literally (see fixtures/PROVENANCE.md).
    // What *is* assertable is the shape.
    for (const rule of allRules.values()) {
      expect(rule.location).toBe(`${rule.source}:${rule.line}:${rule.column}`);
      expect(Number.isInteger(rule.line)).toBe(true);
      expect(Number.isInteger(rule.column)).toBe(true);
      expect(rule.source.length).toBeGreaterThan(0);
    }
    // And at least one of them really does contain a colon-free path with a
    // `.md` suffix, i.e. the split is doing work rather than getting lucky.
    expect([...allRules.values()].some((rule) => rule.source.endsWith(".md"))).toBe(true);
  });

  test("a Windows drive letter would survive too", () => {
    const { allRules: rules } = parseAllRules("abcdef0123456789 C:\\k\\domains.md:12:3");
    const rule = rules.get("abcdef0123456789");
    expect(rule?.source).toBe("C:\\k\\domains.md");
    expect(rule?.line).toBe(12);
    expect(rule?.column).toBe(3);
  });

  test("a path containing spaces keeps them — the split is on the FIRST space", () => {
    const { allRules: rules } = parseAllRules("aaaaaaaaaaaa /my k files/a.md:1:2");
    expect(rules.get("aaaaaaaaaaaa")?.source).toBe("/my k files/a.md");
  });

  test("blank lines are skipped, as pyk skips them", () => {
    const { allRules: rules } = parseAllRules("\n  \naaaaaaaaaaaa /a.md:1:2\n\n");
    expect(rules.size).toBe(1);
  });

  test("keeps every row while compatibility maps remain last-write-wins and the audit includes identical repeats", () => {
    const a = "a".repeat(64);
    const b = "b".repeat(64);
    const parsed = parseAllRules(`${a} /a.k:1:1\n${a} /a.k:2:1\n${b} /b.k:3:1\n${b} /b.k:3:1`);

    expect(parsed.allRulesRows).toHaveLength(4);
    expect(parsed.allRules.get(a)?.location).toBe("/a.k:2:1");
    expect(parsed.allRules.get(b)?.location).toBe("/b.k:3:1");
    expect(
      parsed.duplicateRuleIds.map(({ ruleId, locations }) => [ruleId, locations.map(({ location }) => location)]),
    ).toEqual([
      [a, ["/a.k:1:1", "/a.k:2:1"]],
      [b, ["/b.k:3:1", "/b.k:3:1"]],
    ]);
    expect(parsed.distinctLineCount).toBe(3);
    expect(distinctLineCount(`${a} /a.k:1:1\n${a} /a.k:2:1\n${b} /b.k:3:1\n${b} /b.k:3:1`)).toBe(3);
    expect(duplicateRuleIds(`${a} /a.k:1:1\n${a} /a.k:2:1\n${b} /b.k:3:1\n${b} /b.k:3:1`)).toHaveLength(2);

    const distinctRows = `${a} /a.k:1:1\n${a} /a.k:2:1\n${b} /b.k:3:1\n${b} /b.k:4:1`;
    expect(parseAllRules(distinctRows).distinctLineCount).toBe(4);
  });

  test("a line with no location is kept, with an empty location", () => {
    // `str.partition(' ')` with no separator gives the whole line as the hash.
    const { allRules: rules } = parseAllRules("aaaaaaaaaaaa");
    expect(rules.get("aaaaaaaaaaaa")?.location).toBe("");
    expect(rules.get("aaaaaaaaaaaa")?.line).toBeNaN();
  });

  test.each([
    // location,        source (when parsed),  line, column
    ["/a.md:1:2", "/a.md", 1, 2],
    ["C:\\k\\a.md:12:3", "C:\\k\\a.md", 12, 3],
    // Malformed: the whole string stays as `source` and the numbers are NaN.
    // `Number("")` is 0, so an empty field would otherwise report line 0
    // column 0 — positions K's 1-based `Location` can never produce.
    ["a::", undefined, Number.NaN, Number.NaN],
    ["a:1:", undefined, Number.NaN, Number.NaN],
    ["a::2", undefined, Number.NaN, Number.NaN],
    ["/a.md", undefined, Number.NaN, Number.NaN],
    ["/a.md:1", undefined, Number.NaN, Number.NaN],
    ["/a.md:x:2", undefined, Number.NaN, Number.NaN],
    ["/a.md:1.5:2", undefined, Number.NaN, Number.NaN],
  ])("splits %p from the right, rejecting anything that is not two integers", (location, source, line, column) => {
    const { allRules: rules } = parseAllRules(`aaaaaaaaaaaa ${location}`);
    const rule = rules.get("aaaaaaaaaaaa");
    expect(rule?.location).toBe(location);
    expect(rule?.source).toBe(source ?? location);
    if (Number.isNaN(line)) {
      expect(rule?.line).toBeNaN();
      expect(rule?.column).toBeNaN();
    } else {
      expect(rule?.line).toBe(line);
      expect(rule?.column).toBe(column);
    }
  });

  test("llvm and haskell disagree about which rules are locatable", () => {
    // The two backends exclude different modules from the pipeline
    // (`KoreBackend.java:458-460` vs `HaskellBackend.java:81-84`), so their
    // main modules differ and so do their rule sets.  That divergence is the
    // reason the fixture ships both.
    const llvm = parseAllRules(read(IMP_LLVM, "allRules.txt")).allRules;
    expect(llvm.size).toBe(118);
    expect(llvm.size).not.toBe(allRules.size);
  });
});

describe("lookupRule", () => {
  const layout = parseKompiledLayout({
    ...BLANK,
    allRulesTxt: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef /a.md:1:2",
  });
  const full = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

  test("resolves the full hash — the kcovr.py spelling", () => {
    expect(lookupRule(layout, full)?.line).toBe(1);
  });

  test("resolves the 12-char prefix — the ktool/kprint.py spelling", () => {
    expect(lookupRule(layout, "0123456789ab")?.line).toBe(1);
  });

  test("resolves an intermediate-length prefix consistent with the entry", () => {
    expect(lookupRule(layout, "0123456789abcdef")?.line).toBe(1);
  });

  test("refuses a prefix shorter than 12 — it would be a scan, and ambiguous", () => {
    expect(lookupRule(layout, "0123456789")).toBeUndefined();
  });

  test("refuses a longer key that shares only the first 12 characters", () => {
    expect(lookupRule(layout, `0123456789abZZZZ`)).toBeUndefined();
  });
});

/**
 * `project:<Sort>(Map:lookup(ARGS, #token("$X", KConfigVar)))` — the shape
 * `CompiledDefinition.java:88-102` looks for, and the only shape it looks for.
 */
const configVarProjection = (name: string, sort: string) =>
  kapply(`project:${sort}`, [kapply("Map:lookup", [kvariable("ARGS"), ktoken(`$${name}`, "KConfigVar")])]);

/** A `cell` production carrying `parser(<att>)`, as `CompiledDefinition.java:127-138` reads it. */
const parserProduction = (att: string) =>
  kproduction("Cell", {
    klabel: "<pgm>",
    att: new KAtt([attEntry(Atts.CELL, null), attEntry(attKey("parser", ANY_TYPE), att)]),
  });

describe("deriveConfigVars", () => {
  test("finds a configuration that lives in an IMPORTED module, not the main one", () => {
    // The bug this pins: `Module.sentences` in the Scala frontend is
    // `localSentences | importedSentences` (`outer.scala:174`), and
    // `mainModule().rules()` / `.productions()` (`CompiledDefinition.java:86,124`)
    // read *that*.  Reading only the main module's own sentences would find
    // nothing here — and this is the normal layout for real semantics, where
    // the `configuration` sentence sits in the syntax module and the main
    // module only imports it.
    const inner = kflatmodule("TEST-CONFIG", {
      sentences: [krule(configVarProjection("PGM", "Pgm")), parserProduction("PGM,TEST-SYNTAX")],
    });
    const main = kflatmodule("TEST", { imports: [kimport("TEST-CONFIG")] });
    const derived = deriveConfigVars(new KDefinition("TEST", [main, inner]));

    expect(main.sentences).toEqual([]); // the main module really is empty…
    expect(derived.configVars).toEqual(["PGM"]); // …and the derivation still finds it.
    expect([...derived.configVarSorts]).toEqual([["PGM", "Pgm"]]);
    expect([...derived.configVarModules]).toEqual([["PGM", "TEST-SYNTAX"]]);
  });

  test("reaches transitively, and ignores modules the main module does not import", () => {
    // `KDefinition.modules` is the breadth-first import closure of the main
    // module, so a module that is in `allModules` but unreachable contributes
    // nothing — matching Java, where such a module is not part of
    // `mainModule().sentences` either.
    const deep = kflatmodule("DEEP", { sentences: [krule(configVarProjection("INPUT", "List"))] });
    const middle = kflatmodule("MIDDLE", { imports: [kimport("DEEP")] });
    const orphan = kflatmodule("ORPHAN", { sentences: [krule(configVarProjection("NOPE", "Int"))] });
    const main = kflatmodule("TEST", {
      imports: [kimport("MIDDLE")],
      sentences: [krule(configVarProjection("PGM", "Pgm"))],
    });
    const derived = deriveConfigVars(new KDefinition("TEST", [main, middle, deep, orphan]));

    expect(new Set(derived.configVars)).toEqual(new Set(["PGM", "INPUT"]));
    expect(derived.configVarSorts.get("NOPE")).toBeUndefined();
  });

  test("a projection to K is written out as KItem (CompiledDefinition.java:104-105)", () => {
    // The one place the *file* disagrees with the map Java keeps in memory.
    const main = kflatmodule("TEST", { sentences: [krule(configVarProjection("PGM", "K"))] });
    expect([...deriveConfigVars(new KDefinition("TEST", [main])).configVarSorts]).toEqual([["PGM", "KItem"]]);
  });

  test("claims are not rules — outer.scala:312 collects Rule, and Claim is a sibling", () => {
    const main = kflatmodule("TEST", { sentences: [kclaim(configVarProjection("PGM", "Pgm"))] });
    expect(deriveConfigVars(new KDefinition("TEST", [main])).configVars).toEqual([]);
  });

  describe("the parser attribute is two-dimensional (StringUtil.java:581-597)", () => {
    const modulesOf = (att: string) => {
      const main = kflatmodule("TEST", { sentences: [parserProduction(att)] });
      return [...deriveConfigVars(new KDefinition("TEST", [main])).configVarModules];
    };

    test.each<[string, [string, string][]]>([
      // A plain pair, and the same with the whitespace `splitOneDimensionalAtt` trims.
      ["PGM,TEST-SYNTAX", [["PGM", "TEST-SYNTAX"]]],
      ["  PGM , TEST-SYNTAX  ", [["PGM", "TEST-SYNTAX"]]],
      // Several entries, `;`-separated.
      [
        "PGM,TEST-SYNTAX;INPUT,LIST-SYNTAX",
        [
          ["PGM", "TEST-SYNTAX"],
          ["INPUT", "LIST-SYNTAX"],
        ],
      ],
      // Java's `String.split(",")` DROPS trailing empty fields, JavaScript's
      // does not — so this is a well-formed pair to Java and would be silently
      // skipped by a bare `parts.length !== 2`.
      ["PGM,TEST-SYNTAX,", [["PGM", "TEST-SYNTAX"]]],
      ["PGM,TEST-SYNTAX,,,", [["PGM", "TEST-SYNTAX"]]],
      // Each `;`-entry is trimmed before its `,`-split, as
      // `splitOneDimensionalAtt` does — so whitespace after a trailing comma
      // does not save the empty field, in the middle of a list either.
      [
        "PGM,TEST-SYNTAX, ;INPUT,LIST-SYNTAX",
        [
          ["PGM", "TEST-SYNTAX"],
          ["INPUT", "LIST-SYNTAX"],
        ],
      ],
      // Not a pair: Java raises KEMException, we skip the entry.
      ["PGM", []],
      ["PGM, ", []],
      ["PGM,A,B", []],
      ["", []],
      [",TEST-SYNTAX", []],
    ])("parser(%p)", (att, expected) => {
      expect(modulesOf(att)).toEqual(expected);
    });
  });
});
