// Consumer smoke test, run against the *packed tarball* under plain Node —
// never against the workspace. The failure this guards against is specific: an
// entry point that plain Node cannot load. Node refuses to strip types under
// `node_modules`, so a package whose `exports` points at `.ts` installs fine and
// then throws on first import. Packing and importing for real is the only check
// that sees it.
//
// This package is also the first here to import `node:fs`, so the smoke test
// exercises a real load off disk rather than only the pure layer.
//
// CI copies this file into a scratch consumer project that has installed the
// tarball, so the import below must use the published package name. This
// package's dependencies are workspace packages; the smoke job packs them too
// and installs all the tarballs in one `npm install`, which satisfies the
// `@kframework-ts/*` names locally without touching the registry.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  findKompiledDir,
  K_RELEASE,
  KAST_VERSION,
  loadKompiledLayout,
  lookupRule,
  parseAllRules,
  parseConfigVars,
  parseKompiledLayout,
} from "@kframework-ts/kompiled";
// The `/core` subpath: the same modules minus `fs.ts`, so a consumer supplying
// its own `KompiledSource` never pulls `node:fs` in. Resolving it here is what
// catches an `exports` map pointing at a file `bun run build` does not emit.
import { KompiledDefinition, parseKompiledLayout as parseFromCore } from "@kframework-ts/kompiled/core";

assert.equal(K_RELEASE, "v7.1.337");
assert.equal(KAST_VERSION, 4);

// The pure layer: no filesystem involved.
const layout = parseKompiledLayout({
  mainModule: "IMP\n",
  mainSyntaxModule: "IMP-SYNTAX",
  backend: "haskell",
  timestampMtimeMs: 0,
  configVarsSh: "declaredConfigVar_PGM='Pgm'\ndeclaredConfigVars=(\n    'PGM'\n)\n",
  allRulesTxt: "0123456789abcdef /k/domains.md:12:3",
});
assert.equal(layout.mainModule, "IMP");
assert.deepEqual(layout.configVars, ["PGM"]);
assert.equal(layout.configVarSorts.get("PGM"), "Pgm");
assert.equal(lookupRule(layout, "0123456789ab").source, "/k/domains.md");
assert.equal(parseAllRules("").allRules.size, 0);
assert.equal(parseConfigVars("").configVars.length, 0);

// …and the same thing again through `/core`, with a hand-built source.
const coreLayout = parseFromCore({
  mainModule: "IMP",
  mainSyntaxModule: "IMP-SYNTAX",
  backend: "haskell",
  timestampMtimeMs: 0,
});
assert.equal(coreLayout.hasConfigVarsFile, false);
const inMemory = new KompiledDefinition({
  path: "<memory>",
  layout: coreLayout,
  read: (artifact) => (artifact === "macros.kore" ? "// macros\n" : undefined),
});
assert.deepEqual(inMemory.macrosKore.moduleNames, []);

// The I/O shell: a minimal real directory, made and read here.
const root = await mkdtemp(join(tmpdir(), "kompiled-smoke-"));
const dir = join(root, "smoke-kompiled");
await mkdir(dir);
await writeFile(join(dir, "mainModule.txt"), "SMOKE");
await writeFile(join(dir, "mainSyntaxModule.txt"), "SMOKE-SYNTAX");
await writeFile(join(dir, "backend.txt"), "llvm");
await writeFile(join(dir, "timestamp"), "");

assert.equal(await findKompiledDir(root), dir);
const onDisk = await loadKompiledLayout(dir);
assert.equal(onDisk.backend, "llvm");
assert.equal(onDisk.mainModule, "SMOKE");
assert.ok(onDisk.timestampMtimeMs > 0);

console.log(`@kframework-ts/kompiled: packed tarball imports and runs under Node ${process.version}`);
