import assert from "node:assert/strict";
import { CSubst, CTerm, K_RELEASE } from "@kframework-ts/cterm";
import { CTermSymbolic } from "@kframework-ts/cterm/symbolic";
import { kapply, ktoken, kvariable } from "@kframework-ts/kast";

assert.equal(K_RELEASE, "v7.1.337");

const pattern = new CTerm(kapply("<generatedTop>", [kapply("<k>", [kvariable("X")])]));
const target = new CTerm(kapply("<generatedTop>", [kapply("<k>", [ktoken("1", "Int")])]));
const subst = pattern.match(target);
assert.ok(subst);
assert.equal(subst.get("X")?.node, "KToken");
assert.deepEqual(CSubst.fromDict(new CSubst(subst).toDict()).toDict(), new CSubst(subst).toDict());
assert.deepEqual(CTerm.fromDict(target.toDict()).toDict(), target.toDict());
assert.equal(typeof CTermSymbolic, "function");

console.log(`@kframework-ts/cterm: packed tarball imports and runs under Node ${process.version}`);
