// Consumer smoke test, run by CI against the *packed tarball* under plain Node
// — never against the workspace. The failure this guards against is specific:
// an entry point that plain Node cannot load. Node refuses to strip types under
// `node_modules`, so a package whose `exports` points at `.ts` installs fine and
// then throws on first import. Packing and importing for real is the only check
// that sees it.
//
// CI copies this file into a scratch consumer project that has installed the
// tarball, so the imports below must use the published package names. This
// package has workspace dependencies, which are on no registry; the smoke job
// packs `@kframework-ts/kast` and `@kframework-ts/kore` alongside and installs
// all three tarballs in one `npm install`, so importing them here is also what
// proves those `dependencies` entries survive packing.
import assert from "node:assert/strict";
import { ksort, ktoken, kvariable } from "@kframework-ts/kast";
import { koreText, parsePattern } from "@kframework-ts/kore";
import { K_RELEASE, kastToKorePure, koreToKastPure } from "@kframework-ts/konvert";

assert.equal(K_RELEASE, "v7.1.337");

// KAST → KORE: mangling, the `Var` prefix, and the default sort.
assert.equal(koreText(kastToKorePure(kvariable("X_Y", ksort("Int")))), "VarX'Unds'Y : SortInt{}");
assert.equal(koreText(kastToKorePure(ktoken("3", ksort("Int")))), '\\dv{SortInt{}}("3")');

// A set variable: `@` precedes the `Var` prefix, and it round-trips.
const setVar = kastToKorePure(kvariable("@X", ksort("Int")));
assert.equal(koreText(setVar), "@VarX : SortInt{}");
assert.deepEqual(koreToKastPure(setVar), kvariable("@X", ksort("Int")));

// KORE → KAST: `inj` erased, `Lbl` stripped once, sequences flattened.
const kast = koreToKastPure(parsePattern("kseq{}(inj{SortInt{}, SortKItem{}}(Lblfoo{}()), dotk{}())"));
assert.equal(kast.node, "KSequence");
assert.equal(kast.items.length, 1);
assert.equal(kast.items[0].label.name, "foo");

console.log(`@kframework-ts/konvert: packed tarball imports and runs under Node ${process.version}`);
