import assert from "node:assert/strict";
import { KCFG, K_RELEASE } from "@kframework-ts/kcfg";
import * as explore from "@kframework-ts/kcfg/explore";
import * as minimize from "@kframework-ts/kcfg/minimize";
import * as store from "@kframework-ts/kcfg/store";

assert.equal(K_RELEASE, "v7.1.337");
assert.equal(typeof KCFG, "function");
assert.ok(Object.keys(minimize).length > 0);
assert.ok(Object.keys(explore).length > 0);
assert.equal(typeof store.readKcfgStore, "function");
assert.equal(typeof store.writeKcfgStore, "function");

console.log(`@kframework-ts/kcfg: packed tarball imports and runs under Node ${process.version}`);
