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
import { KAST_VERSIONS, K_RELEASE, KSortSchema, parseTermDocument } from "@kframework-ts/kast-json";

assert.deepEqual([...KAST_VERSIONS], [3, 4]);
assert.equal(K_RELEASE, "v7.1.337");
assert.equal(parseTermDocument("not json").ok, false);
// A v3-spelled KSort parses with `params` defaulted — the dual-version schema.
assert.deepEqual(KSortSchema.parse({ node: "KSort", name: "Int" }), { node: "KSort", name: "Int", params: [] });

console.log(`@kframework-ts/kast-json: packed tarball imports and runs under Node ${process.version}`);
