// Consumer smoke test, run against the *packed tarball* under plain Node —
// never against the workspace. The failure this guards against is specific: an
// entry point that plain Node cannot load. Node refuses to strip types under
// `node_modules`, so a package whose `exports` points at `.ts` installs fine and
// then throws on first import. Packing and importing for real is the only check
// that sees it.
//
// CI copies this file into a scratch consumer project that has installed the
// tarball, so the imports below must use the published package names. The two
// workspace dependencies are packed and installed alongside; `fast-check` is a
// normal registry dependency and npm resolves it from `dependencies`, which is
// itself part of what this job proves.
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  fuzz,
  KFuzz,
  KFuzzArgumentError,
  KFuzzError,
  kintegers,
  K_RELEASE,
  substituteVars,
} from "@kframework-ts/kfuzz";
import { app, evar, koreText, sortApp } from "@kframework-ts/kore";
import { llvmInterpretRaw } from "@kframework-ts/ktool";

assert.equal(K_RELEASE, "v7.1.337");

const INT = sortApp("SortInt");
const VAR_X = evar("VarX", INT);
const VAR_Y = evar("VarY", INT);
const TEMPLATE = app("Lblcheck", [], [VAR_X, VAR_Y]);
const STRATEGY = [
  [VAR_X, kintegers({ minValue: 0, maxValue: 20 })],
  [VAR_Y, kintegers({ minValue: 0, maxValue: 20 })],
];

// The pure layer: substitution keyed by name *and* sort, which is where this
// package deliberately differs from `@kframework-ts/kore`'s substituteVariables.
const substituted = substituteVars(TEMPLATE, new Map([[VAR_X, app("Lblv", [], [])]]));
assert.equal(koreText(substituted), "Lblcheck{}(Lblv{}(), VarY : SortInt{})");
assert.equal(
  koreText(substituteVars(TEMPLATE, new Map([[evar("VarX", sortApp("SortBool")), app("Lblv")]]))),
  koreText(TEMPLATE),
);

// The mode exclusion is pyk's RuntimeError, message for message.
await assert.rejects(
  () => fuzz("/nonexistent", TEMPLATE, STRATEGY),
  (error) => {
    assert.ok(error instanceof KFuzzArgumentError);
    assert.equal(error.message, "Must pass one of check_func or check_exit_code, and not both!");
    return true;
  },
);

// The whole loop, against an injected interpreter: no K, no binary, no spawn.
const seen = [];
const echoing = (_dir, kore) => Promise.resolve({ returncode: 0, stdout: kore, stderr: "" });
const report = await fuzz("/nonexistent", TEMPLATE, STRATEGY, {
  checkFunc: () => {},
  interpret: (dir, kore) => {
    seen.push(kore);
    return echoing(dir, kore);
  },
  run: { seed: 20250806, numRuns: 20 },
});
assert.equal(report.numRuns, 20);
assert.equal(report.seed, 20250806);
assert.equal(seen.length, 20);
assert.ok(!seen[0].includes("VarX"), seen[0]);

// A planted violation is found, and the counterexample is a real one.
const failure = await new KFuzz("/nonexistent", { interpret: echoing })
  .fuzzWithCheck(
    TEMPLATE,
    STRATEGY,
    (pattern) => {
      const [x, y] = pattern.args.map((arg) => BigInt(arg.value.value));
      if (x > y) throw new Error(`x=${x} > y=${y}`);
    },
    { seed: 20250806, numRuns: 100 },
  )
  .then(
    () => null,
    (error) => error,
  );
assert.ok(failure instanceof KFuzzError, String(failure));
assert.equal(failure.seed, 20250806);
assert.equal(typeof failure.path, "string");
assert.ok(
  BigInt(failure.counterexample.get(VAR_X).value.value) > BigInt(failure.counterexample.get(VAR_Y).value.value),
);

// The execution path, end to end against a fake `interpreter`: `llvmInterpretRaw`
// is what a real run goes through, and it is the one call this package makes
// into a K artifact. A shell script standing in for the binary proves the wiring
// — argv, delivery, and the output coming back — without a kompiled definition.
const definitionDir = mkdtempSync(join(tmpdir(), "kfuzz-smoke-"));
const interpreterPath = join(definitionDir, "interpreter");
writeFileSync(interpreterPath, '#!/usr/bin/env bash\ncat < "$1" > "$3"\n');
chmodSync(interpreterPath, 0o755);

const interpreted = await llvmInterpretRaw(definitionDir, "Lblok{}()", { check: false });
assert.equal(interpreted.returncode, 0);
assert.equal(interpreted.stdout, "Lblok{}()");

console.log(`@kframework-ts/kfuzz: packed tarball imports and runs under Node ${process.version}`);
