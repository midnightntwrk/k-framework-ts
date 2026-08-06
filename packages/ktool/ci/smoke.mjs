// Consumer smoke test, run by CI against the *packed tarball* under plain Node
// — never against the workspace. The failure this guards against is specific:
// an entry point that plain Node cannot load. Node refuses to strip types under
// `node_modules`, so a package whose `exports` points at `.ts` installs fine and
// then throws on first import. Packing and importing for real is the only check
// that sees it.
//
// CI copies this file into a scratch consumer project that has installed the
// tarball, so the imports below must use the published package name. This
// package depends on six workspace packages; the smoke job packs them all and
// installs the tarballs in one `npm install`, so importing them here is also
// what proves those `dependencies` entries survive packing.
//
// This is the package that spawns K, and CI has no K — so **nothing here starts
// a process**. Every assertion below is on the pure layer: the argv builders,
// the version parser, the claim index, and the cache file's wire shape. That is
// not a compromise, it is the package's own thesis: the argv is a value you can
// test without the tool.
import assert from "node:assert/strict";
import { kclaim, kflatmodule, kflatmodulelist, krewrite, ktoken, KAtt, Atts, attEntry } from "@kframework-ts/kast";
import {
  buildKompileArgv,
  ClaimIndex,
  claimCacheFile,
  claimModuleListToDict,
  K_RELEASE,
  kompileArgs,
  korePrintArgs,
  krunArgs,
  kastArgs,
  kproveParseModulesArgs,
  llvmInterpretArgs,
  parseKVersion,
  TRANSCRIBED_FROM,
} from "@kframework-ts/ktool";
import { kompileCacheKey, kTestEnabled } from "@kframework-ts/ktool/testing";

assert.equal(K_RELEASE, "v7.1.337");
assert.ok(TRANSCRIBED_FROM.length > 0);
assert.equal(kTestEnabled(), false);
assert.equal(
  kompileCacheKey({ backend: "haskell", definition: "module TEST endmodule", mainModule: "TEST" }),
  kompileCacheKey({ backend: "haskell", definition: "\nmodule TEST endmodule\n", mainModule: "TEST" }),
);

//////////////////////////////
// kompile                  //
//////////////////////////////

// pyk defaults `--emit-json` on where the CLI defaults it off, which is the one
// flag that decides whether `@kframework-ts/kompiled` can read the result.
assert.deepEqual(buildKompileArgv({ backend: "haskell", mainFile: "imp.k", mainModule: "IMP" }, { outputDir: "out" }), [
  "kompile",
  "imp.k",
  "--main-module",
  "IMP",
  "--emit-json",
  "--backend",
  "haskell",
  "--output-definition",
  "out",
]);

// `-I` is sorted by the builder, so the argv is a function of the set.
assert.deepEqual(kompileArgs({ backend: "llvm", mainFile: "imp.k", includeDirs: ["b", "a"], emitJson: false }), [
  "imp.k",
  "-I",
  "a",
  "-I",
  "b",
  "--backend",
  "llvm",
]);

//////////////////////////////
// run / print              //
//////////////////////////////

// `--depth 0` is emitted: `depth is not None` upstream, so "take no steps" is a
// request you can make.
assert.deepEqual(krunArgs({ definitionDir: "imp-kompiled", depth: 0, output: "kore", term: true }), [
  "krun",
  "--definition",
  "imp-kompiled",
  "--output",
  "kore",
  "--depth",
  "0",
  "--term",
]);

// `-p`/`-c` are single, unescaped argv elements — there is no shell.
assert.deepEqual(krunArgs({ pmap: { PGM: "cat pgm.imp" } }), ["krun", "-pPGM=cat pgm.imp"]);

assert.deepEqual(kastArgs({ definitionDir: "d", input: "program", output: "json", sort: "AExp" }), [
  "kast",
  "--definition",
  "d",
  "--input",
  "program",
  "--output",
  "json",
  "--sort",
  "AExp",
]);

// `--output-file`, hyphenated: pyk emits `--output_file`, which `kore-print`'s
// option table does not have.
assert.deepEqual(korePrintArgs("t.kore", { definitionDir: "d", output: "pretty", outputFile: "o.txt" }), [
  "kore-print",
  "t.kore",
  "--definition",
  "d",
  "--output-file",
  "o.txt",
  "--output",
  "pretty",
]);

// The one wrapper that needs no K on PATH: a binary inside the definition, and
// three positional arguments.
assert.deepEqual(llvmInterpretArgs("imp-kompiled"), ["imp-kompiled/interpreter", "/dev/stdin", "-1", "/dev/stdout"]);

// `kprove --dry-run --emit-json-spec`, the cterm-free half of kprove.
const proveArgv = kproveParseModulesArgs("spec.k", "/tmp/out.json", { definitionDir: "d" });
assert.equal(proveArgv[0], "kprove");
assert.equal(proveArgv[1], "spec.k");
assert.ok(proveArgv.includes("--dry-run"), proveArgv.join(" "));
assert.ok(proveArgv.includes("--allow-rules"), proveArgv.join(" "));
assert.deepEqual(proveArgv.slice(-3), ["--emit-json-spec", "/tmp/out.json", "--allow-rules"]);

//////////////////////////////
// version                  //
//////////////////////////////

assert.equal(parseKVersion("v7.1.337").patch, 337);
const dev = parseKVersion("v7.1.337-12-g0123456789-dirty");
assert.equal(dev.git.ahead, 12);
assert.equal(dev.git.dirty, true);
assert.equal(dev.text, "v7.1.337-12-g0123456789-dirty");

//////////////////////////////
// claims                   //
//////////////////////////////

// A hand-made two-claim module list: `b` depends on `a`. A claim's label is its
// `label` attribute verbatim — K is what qualifies one with its module name, and
// the index resolves against that.
const claim = (label, depends) =>
  kclaim(krewrite(ktoken("0", "Int"), ktoken("1", "Int")), {
    att: new KAtt([attEntry(Atts.LABEL, label), ...(depends === undefined ? [] : [attEntry(Atts.DEPENDS, depends)])]),
  });

const moduleList = kflatmodulelist("SPEC", [kflatmodule("SPEC", { sentences: [claim("a"), claim("b", "a")] })]);
const index = ClaimIndex.fromModuleList(moduleList);

// Index order is module order, then sentence order within a module.
assert.deepEqual(index.labels(), ["a", "b"]);
// Selecting `b` pulls `a` in, breadth first; `ordered` puts the dependency first.
assert.deepEqual(index.labels({ include: ["b"] }), ["b", "a"]);
assert.deepEqual(index.labels({ include: ["b"], ordered: true }), ["a", "b"]);
// `withDepends: false` is the flag `ktool claims --no-depends` sets.
assert.deepEqual(index.labels({ include: ["b"], withDepends: false }), ["b"]);
assert.equal(index.require("b").node, "KClaim");

// The cache lands beside the spec with its LAST suffix replaced, and its wire
// shape carries no KAST envelope — that is upstream's, and it is what makes the
// file readable by both tools.
assert.equal(claimCacheFile("/a/my.spec.k"), "/a/my.spec.json");
assert.deepEqual(Object.keys(claimModuleListToDict({ moduleList, digest: "0" })).sort(), ["digest", "moduleList"]);

console.log(`@kframework-ts/ktool: packed tarball imports and runs under Node ${process.version}`);
