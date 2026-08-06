// Consumer smoke test, run against the *packed tarball* under plain Node —
// never against the workspace. The failure this guards against is specific: an
// entry point that plain Node cannot load. Node refuses to strip types under
// `node_modules`, so a package whose `exports` points at `.ts` installs fine and
// then throws on first import. Packing and importing for real is the only check
// that sees it.
//
// CI copies this file into a scratch consumer project that has installed the
// tarball, so the imports below must use the published package names. This
// package's dependencies are workspace packages; the smoke job packs them too
// and installs all the tarballs in one `npm install`, which satisfies the
// `@kframework-ts/*` names locally without touching the registry — so importing
// `@kframework-ts/kast` here is also what proves that `dependencies` entry
// survives packing.
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { kapply, krewrite, krule, ktoken } from "@kframework-ts/kast";
import { createCoverMap, K_RELEASE, renderCoverageXml, stripCoverageLogger, totalHits } from "@kframework-ts/kcovr";
// The `./fs` subpath: the one module that needs `node:fs`, kept out of the root
// export so a consumer of the pure surface never pulls it in. Resolving it here
// is what catches an `exports` map pointing at a file `bun run build` does not
// emit.
import { readCoverageDefinitions } from "@kframework-ts/kcovr/fs";

assert.equal(K_RELEASE, "v7.1.337");

// A rule id is the full 64-hex `UNIQUE_ID` (SHA3-256 of the normalized
// sentence, `NumberSentences.java:45`); nothing downstream of the shape cares.
const ruleId = (n) => n.toString(16).padStart(64, "0");

// Three rules on one source line, one of them hit: enough to exercise the
// branch-line template *and* pyk's `int(rate * 100)` truncation, since 1 of 3
// renders as 33% rather than 33.3.
const ALL_RULES = [
  `${ruleId(1)} /s/imp.md:10:1`,
  `${ruleId(2)} /s/imp.md:10:20`,
  `${ruleId(3)} /s/imp.md:10:40`,
  `${ruleId(4)} /s/imp.md:20:1`,
].join("\n");
// A hit log is a log, not a set: two lines for one rule are two applications.
const HITS = `${ruleId(1)}\n${ruleId(1)}\n`;

// The pure layer: no filesystem involved.
const coverMap = createCoverMap([HITS]);
assert.equal(coverMap.get(ruleId(1)), 2);
assert.equal(totalHits(coverMap), 2);

const xml = renderCoverageXml([{ allRulesTxt: ALL_RULES, coverageLogs: [HITS] }], ["/s/imp.md"], { timestamp: 0 });
assert.ok(xml.includes('condition-coverage="33% (1/3)"'), xml);
assert.ok(xml.includes('<line number="10" hits="2" branch="true"'), xml);
assert.ok(xml.includes('<line number="20" hits="0" branch="false"/>'), xml);
assert.ok(xml.includes('timestamp="0"'), xml);
assert.ok(xml.includes("<source>/s</source>"), xml);

// De-instrumentation, on the shape a current `kompile --coverage` really emits
// (`GenerateCoverage.java:66-78`): an arity-2 `sideEffect:<Sort>` whose first
// argument is the `#logToFile` call. pyk's own `strip_coverage_logger` does not
// match this one.
const rhs = kapply("<generatedTop>", [ktoken("1", "Int")]);
const instrumented = krule(
  krewrite(
    kapply("<generatedTop>", [ktoken("0", "Int")]),
    kapply("sideEffect:GeneratedTopCell", [
      kapply("#logToFile", [ktoken("/b/coverage.txt", "String"), ktoken(`${ruleId(1)}\n`, "String")]),
      rhs,
    ]),
  ),
);
const stripped = stripCoverageLogger(instrumented);
assert.equal(stripped.body.node, "KRewrite");
assert.deepEqual(stripped.body.rhs, rhs);

// The I/O shell: a minimal real definition directory, made and read here.
// `coverage.txt` is absent on purpose — pyk opens it unguarded and dies.
const dir = await mkdtemp(join(tmpdir(), "kcovr-smoke-"));
await writeFile(join(dir, "allRules.txt"), ALL_RULES);
await writeFile(join(dir, "4242_coverage.txt"), HITS);

const definitions = await readCoverageDefinitions([dir]);
assert.equal(definitions.length, 1);
assert.deepEqual(definitions[0].coverageLogs, [HITS]);
assert.equal(renderCoverageXml(definitions, ["/s/imp.md"], { timestamp: 0 }), xml);

console.log(`@kframework-ts/kcovr: packed tarball imports and runs under Node ${process.version}`);
