// Consumer smoke test, run by CI against the *packed tarball* under plain Node
// — never against the workspace. The failure this guards against is specific:
// an entry point that plain Node cannot load. Node refuses to strip types under
// `node_modules`, so a package whose `exports` points at `.ts` installs fine and
// then throws on first import. Packing and importing for real is the only check
// that sees it.
//
// CI copies this file into a scratch consumer project that has installed the
// tarball, so the imports below must use the published package name. The
// prelude import additionally proves the `./prelude/*` wildcard subpath
// resolves from a tarball, which no workspace test exercises.
import assert from "node:assert/strict";
import {
  KAST_VERSION,
  KDefinition,
  K_RELEASE,
  PrettyPrinter,
  fromDict,
  hashOf,
  kapply,
  kflatmodule,
  ksort,
  kvariable,
  match,
  parseKast,
  sortToDict,
  toDict,
} from "@kframework-ts/kast";
import { intToken } from "@kframework-ts/kast/prelude/kint";

assert.equal(KAST_VERSION, 4);
assert.equal(K_RELEASE, "v7.1.337");

const term = kapply("_+Int_", [intToken(3n), intToken(4n)]);
assert.deepEqual(fromDict(toDict(term)), term);

const subst = match(kapply("_+Int_", [kvariable("X"), intToken(4n)]), term);
assert.notEqual(subst, null);
assert.equal(subst.get("X").token, "3");

assert.equal(hashOf(intToken(0n)).length, 64);
assert.deepEqual(sortToDict(ksort("Map", [ksort("Int")])).params, [{ node: "KSort", name: "Int", params: [] }]);

assert.deepEqual(
  parseKast('`_+Int_`(#token("3","Int"),X:Int)'),
  kapply("_+Int_", [intToken(3n), kvariable("X", ksort("Int"))]),
);

const defn = new KDefinition("SMOKE", [kflatmodule("SMOKE", {})]);
assert.equal(new PrettyPrinter(defn).print(term), "_+Int_ ( 3 , 4 )");

console.log(`@kframework-ts/kast: packed tarball imports and runs under Node ${process.version}`);
