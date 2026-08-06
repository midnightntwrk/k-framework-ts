// Consumer smoke test, run by CI against the *packed tarball* under plain Node
// — never against the workspace. The failure this guards against is specific:
// an entry point that plain Node cannot load. Node refuses to strip types under
// `node_modules`, so a package whose `exports` points at `.ts` installs fine and
// then throws on first import. Packing and importing for real is the only check
// that sees it.
//
// This package has two entry points, and they are here for different reasons:
// the root is the pure surface (no `node:fs` anywhere in its module graph), and
// `@kframework-ts/k-parser/slurp` is the filesystem half. Resolving both is what
// catches an `exports` map pointing at a file `bun run build` does not emit.
//
// CI copies this file into a scratch consumer project that has installed the
// tarball, so the imports below must use the published package name. This
// package depends on `@kframework-ts/kast`, which is on no registry; the smoke
// job packs it alongside and installs both tarballs in one `npm install`, so
// importing through it is also what proves that `dependencies` entry survives
// packing.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  KAST_SOURCES,
  K_COMMIT,
  K_RELEASE,
  OuterParser,
  TRANSCRIBED_FROM,
  checkKSources,
  selectCodeBlocks,
} from "@kframework-ts/k-parser";
import { parseOuter } from "@kframework-ts/k-parser/slurp";

assert.equal(K_RELEASE, "v7.1.337");
assert.equal(K_COMMIT, "4a46d1231473b599c699160132fd6e76a5c46406");

// The six pyk files this package transcribes: markdown, lexer, parser, surface
// AST, the KAST bridge, and the one filesystem-touching module.
assert.equal(TRANSCRIBED_FROM.length, 6);
assert.equal(KAST_SOURCES.length, 6);
assert.deepEqual(
  KAST_SOURCES.map((s) => s.path),
  TRANSCRIBED_FROM.map((s) => s.path),
);
for (const { sha256 } of KAST_SOURCES) assert.match(sha256, /^[0-9a-f]{64}$/u);

// The drift check runs offline here: its fetcher is injected, and this one says
// a missing K source path, which must report as `could-not-locate` rather
// than as a compatibility verdict.
const report = await checkKSources("v9.9.9", () => Promise.resolve(undefined));
assert.equal(report.verdict, "could-not-locate");
assert.equal(report.files.length, 6);

// The pure surface, doing its actual job: fence selection blanks everything it
// does not select (so the output is the same length as the input and every
// location still refers to the original `.md`), and the outer parser reads what
// is left.
const literate = 'Prose.\n\n```k\nmodule X\n  imports Y\nendmodule\n```\n\n```other\nrequires "no.k"\n```\n';
const selected = selectCodeBlocks(literate, "k");
assert.equal(selected.length, literate.length);
const definition = new OuterParser(selected).definition();
assert.equal(definition.modules.length, 1);
assert.equal(definition.modules[0].name, "X");
assert.equal(definition.modules[0].imports[0].moduleName, "Y");
assert.deepEqual(definition.requires, []);

// The `./slurp` half, off a real disk: `main.k` requires a file that only the
// include directory has, so this exercises resolution, the DFS visit order that
// decides module order, and the conversion to `KDefinition` — the whole
// pipeline, from the packed tarball, under plain Node.
const root = await mkdtemp(join(tmpdir(), "k-parser-smoke-"));
await mkdir(join(root, "lib"));
await writeFile(join(root, "main.k"), 'requires "base.k"\n\nmodule MAIN\n  imports BASE\n  rule x => y\nendmodule\n');
await writeFile(join(root, "lib", "base.k"), 'module BASE\n  syntax Foo ::= "foo"\nendmodule\n');

const parsed = parseOuter(join(root, "main.k"), "MAIN", { includeDirs: [join(root, "lib")] });
assert.deepEqual(
  parsed.allModules.map((module) => module.name),
  ["MAIN", "BASE"],
);
// `requires` is dropped, always (`utils.py:36-37`), and the sentence layer pyk
// never implemented is what produced these two.
assert.deepEqual(parsed.requires, []);
assert.deepEqual(
  parsed.allModules.flatMap((module) => module.sentences.map((sentence) => sentence.node)),
  ["KBubble", "KProduction"],
);

console.log(`@kframework-ts/k-parser: packed tarball imports and runs under Node ${process.version}`);
