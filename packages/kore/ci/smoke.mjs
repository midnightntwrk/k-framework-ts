// Consumer smoke test, run by CI against the *packed tarball* under plain Node
// — never against the workspace. The failure this guards against is specific:
// an entry point that plain Node cannot load. Node refuses to strip types under
// `node_modules`, so a package whose `exports` points at `.ts` installs fine and
// then throws on first import. Packing and importing for real is the only check
// that sees it.
//
// CI copies this file into a scratch consumer project that has installed the
// tarball, so the import below must use the published package name.
import assert from "node:assert/strict";
import {
  decodeKoreJson,
  demangleName,
  encodeKoreJson,
  indexDefinition,
  K_RELEASE,
  KORE_JSON_VERSION,
  koreText,
  parseDefinition,
  parsePattern,
} from "@kframework-ts/kore";

assert.equal(KORE_JSON_VERSION, 1);
assert.equal(K_RELEASE, "v7.1.337");

const pattern = parsePattern('\\dv{SortInt{}}("42")');
assert.equal(koreText(pattern), '\\dv{SortInt{}}("42")');
assert.deepEqual(decodeKoreJson(encodeKoreJson(pattern)).term, pattern);
assert.throws(() => parsePattern("\\dv{"), /1:5/);
assert.equal(demangleName("Lbl'Unds'List'Unds'"), "Lbl_List_");

const definition = parseDefinition("[] module M sort Foo{} [] endmodule []");
assert.ok(indexDefinition(definition).sorts.has("Foo"));

console.log(`@kframework-ts/kore: packed tarball imports and runs under Node ${process.version}`);
