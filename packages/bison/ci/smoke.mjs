import assert from "node:assert/strict";

import { SUPPORTED_BISON_ADAPTER } from "@kframework-ts/bison";

assert.equal(SUPPORTED_BISON_ADAPTER, "gnu-bison-3.8.2-xml-v1");
console.log(`@kframework-ts/bison: packed tarball imports under Node ${process.version}`);
