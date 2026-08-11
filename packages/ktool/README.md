# @kframework-ts/ktool

Runs the **K Framework binaries** from TypeScript — `kompile`, `krun`, `kast`,
`kprove`, `kore-print`, and the LLVM backend's generated `interpreter` — plus
the two pure modules that manage a spec's claims, and the three fast paths that
let a workload in a loop stop paying for a JVM: native Bison parsers, an
in-process definition cache, and kserver lifecycle management.

> **Unofficial.** Not affiliated with, endorsed by, or supported by Runtime
> Verification, Inc. or the K Framework maintainers.

A transcription of `pyk/src/pyk/ktool/` at K **`v7.1.337`** (commit
`4a46d123`), the same release every other package here is pinned to.

## Read this first: this is the only package that spawns

Every other package in this monorepo is hermetic. `kast`, `kore`, `konvert`,
`k-parser`, `kast-json`, `kcovr` and `kompiled` read bytes and return values,
and **none of them can start a process**. That is a property worth keeping — it
is what makes them testable, portable and safe to run inside a build — so the
subprocess layer lives here and only here. If you find yourself reaching for
`node:child_process` in a sibling, the code belongs in this package.

The corollary is what makes this package usable without K at all: **argv
construction is pure, and it is the bulk of the surface.** `buildKompileArgv`,
`krunArgs`, `kastArgs`, `korePrintArgs`, `llvmInterpretArgs` and
`kproveParseModulesArgs` never touch a filesystem, so a build script's flags can
be pinned against a golden with nothing installed. The spawning functions are
thin shells around them.

One layering divergence from pyk, recorded rather than hidden: `kore_print`
lives in `pyk.kore.tools` upstream, and here it is `kore-print.ts` in this
package — because `@kframework-ts/kore` is hermetic and moving it is what kept
the rule above intact.

## Install

```sh
npm install @kframework-ts/ktool   # or: bun add / pnpm add / yarn add
```

Depends on `@kframework-ts/{kast,kast-json,kore,konvert,kompiled,k-parser}`.
ESM only, with types. Node 20+, Bun 1.3+. A K installation is needed only for
the functions that spawn one — see [Guarantees](#guarantees).

## The shape of the library

| module                       | what it is                                                                                                                                |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `proc.ts`                    | `runProcess` — pyk's `run_process_2` semantics — plus `ProcessError`, `checkDirPath`/`checkFilePath`, `absOrRelTo`, `formatCommand`       |
| `bison.ts`                   | pure IELR source policy, strict conflict-as-error Bison invocation, version-bound XML automaton decoding, and evidence-rich verdicts      |
| `generated-bison.ts`         | deterministic K Bison generation with exact warning policy, retained source/process evidence, parser identity checks, and bound versions  |
| `distribution.ts`            | `getKDistribution()`, `resolveOnPath`, `kVersion`/`parseKVersion`/`tryParseKVersion`                                                      |
| `kompile.ts`                 | the enums, `KompileSpec`, argv builders, `kompile()`/`kompileDetailed()`, `boosterKompile()`, `kompileFromDict()`, `defaultDirectory()`   |
| `kore-print.ts`              | `PrintOutput`, `korePrintArgs`, `korePrint` — pyk's `kore/tools.py`, housed here so `@kframework-ts/kore` stays process-free              |
| `kparse.ts`                  | `bisonParserName`, `resolveKparseTarget`, `findBisonParser`, `kparse` — the K distribution's native-parser lookup rule                    |
| `kserver.ts`                 | `spawnKserver`, `stopKserver`, `resetKserver`, `kserverRunning`, `kserverEnv`, `KSERVER_SOCKET_ENV` — the warm-JVM lifecycle              |
| `definition-cache.ts`        | `loadKompiledDefinitionCached` — one parse of `compiled.json`/`definition.kore` per `(directory, build)`                                  |
| `stdio.ts`                   | `withStdinFile`, `withStdoutFile`, `DEV_STDIN`, `DEV_STDOUT` — why pyk's `/dev/stdin` argv cannot work from Node or Bun                   |
| `kast-cli.ts`                | `KAstInput`/`KAstOutput`, `kastArgs`, `runKast`, `genGlrParser`, `expressionKast` (the 128 KiB switch), `withTempFile`                    |
| `kprint.ts`                  | `KPrint` — composed over `@kframework-ts/kompiled`; `prettyPrint`, `formatPrint`, `parseToken`, `koreToKast`/`kastToKore`, `koreToPretty` |
| `krun.ts`                    | `KRunOutput`, `krunArgs` (pyk's own golden table), `runKrun`, `KRun`                                                                      |
| `interpreter.ts`             | `llvmInterpret`, `llvmInterpretRaw`, `llvmInterpretArgs` — the one wrapper that needs **no K on `PATH`**                                  |
| `claim-index.ts`             | `ClaimIndex` — pure: label resolution, dependency closure, topological order                                                              |
| `claim-loader.ts`            | `ClaimLoader`, `claimDigest`, `claimCacheFile` — the `<spec>.json` cache over an injected `ModuleParser`                                  |
| `parse-modules.ts`           | `parseModules`, `KproveModuleParser`, `buildKproveArgv` — the cterm-free half of `kprove`                                                 |
| `term-conversion.ts`         | `toKInner` — explicit, typed conversion from `kast-json` terms to `kast`'s `KInner` algebra                                               |
| `version.ts` / `ksources.ts` | which upstream files this is derived from, and whether they still hash to what was recorded                                               |

`index.ts` is the whole public API — there is no deep-import contract.

### Integration boundaries

`kVersion()` retains the exact `kompile --version` stdout as `banner` and its
unmodified first line as `line`, while continuing to parse only K's strict
version grammar. Use `tryParseKVersion(text)` when a build fingerprint must
preserve an unfamiliar spelling: it returns either `{ kind: "parsed" }` or
`{ kind: "unrecognized", text }` without broadening that grammar. `kVersion()`
remains the strict convenience API and throws for an unrecognised banner.

`kserverRunning()` reports K Nailgun liveness only by K's `JavaVersion` probe.
If the bundled `ng` client cannot be found, it throws `KserverError` with code
`"ng-not-found"`; it never treats a socket file or arbitrary Unix listener as
live. A listener that is not Nailgun can take the probe's five-second control
timeout before returning `false`; absent or stale sockets normally return
quickly.

`unqualifyLabel(label)` removes the text through the first `.` (`A.b.c` becomes
`b.c`) and otherwise leaves the label unchanged. It does not infer the owning
module.

`toKInner(term)` is the explicit boundary from `@kframework-ts/kast-json` to
`@kframework-ts/kast`. It iteratively converts `KApply`, `KToken`, `KSequence`,
`KVariable`, `KRewrite`, and `KAs`, including nested sort parameters. An
`InjectedKLabel` or `KOther` returns a typed refusal with its source path
rather than throwing. It accepts a missing JSON `KLabel.params` field as an
empty list; `kast.fromDict` is stricter, so use that reader when validating
adversarial JSON.

### Capture and check K's generated Bison grammar

`generateKParserGrammar` asks the supported K release for its deterministic
PGM parser and returns the exact retained `parser.y` bytes. The capture profile
uses checked type inference, treats every K warning as an error, and suppresses
only `unused-symbol`. It rejects GLR, parser-library, post-processing,
read-only, and additional-parser requests.

The function owns a unique temporary workspace and removes it after reading the
bytes. A caller can explicitly retain debugging artifacts to a fresh absolute
path; paths are not part of the normal result or the analysis handoff.

```ts
import { generateKParserGrammar } from "@kframework-ts/ktool";

const spec = {
  backend: "haskell",
  mainFile: "/src/language.k",
  mainModule: "LANGUAGE",
  syntaxModule: "LANGUAGE-SYNTAX",
  haskellBinary: false,
} as const;

const generated = await generateKParserGrammar(spec, {
  command: ["kompile"],
});

generated.source.bytes;
generated.source.sha256;
generated.kVersion;
generated.diagnostics;
```

`checkKGrammarLr1` passes those exact bytes to the independent
`@kframework-ts/bison` analyzer. Its result deliberately keeps `capture` and
`analysis` separate: a K failure is not a non-LR(1) grammar, and a successful
capture does not establish LR(1).

```ts
import { checkKGrammarLr1 } from "@kframework-ts/ktool";

const checked = await checkKGrammarLr1(spec, {
  capture: { command: ["kompile"] },
  bison: { tool: { command: ["bison"] } },
});

checked.capture.source.sha256;
checked.analysis.classification;
checked.unprovedBoundaries;
```

The classification applies only to the emitted token grammar. This operation
does not prove K-to-Bison grammar correspondence, scanner determinism,
semantic-action correctness, or generated-parser runtime correctness. See
[`@kframework-ts/bison`](../bison/README.md) for the LR(1) algorithm, verdicts,
tool support, and evidence contract.

### kompile

```ts
import { buildKompileArgv, kompile, kompileDetailed } from "@kframework-ts/ktool";

const spec = { backend: "haskell", mainFile: "imp.k", mainModule: "IMP" } as const;

// Pure — no filesystem, no process, no K required.
buildKompileArgv(spec, { outputDir: "out" });
// ["kompile", "imp.k", "--main-module", "IMP", "--emit-json",
//  "--backend", "haskell", "--output-definition", "out"]

// The spawn. Returns the definition directory, verified to exist.
const dir = await kompile(spec, { outputDir: "out" });

// The evidence-preserving sibling. With check:false, even a failed process and
// a missing output directory are returned instead of projected away.
const detailed = await kompileDetailed(spec, { outputDir: "out-2", check: false });
detailed.process.stderr;
detailed.definitionDirExists;
```

`KompileSpec` is a union discriminated on `backend`, so `concreteRules` on an
`llvm` spec is a compile error rather than pyk's runtime `ValueError`. The
dynamic door is still open: `kompileFromDict` is `Kompile.from_dict`, for a
kdist-style build plugin holding a `Record<string, unknown>`, and it throws on an
unknown key exactly as pyk does. `boosterKompile` is `_booster_kompile` — two
concurrent kompilations, LLVM into `<outputDir>/llvm-library` and Haskell into
`<outputDir>`.

The exact order emitted by `buildKompileArgv`, `kompileArgs`,
`kompileBaseArgs`, and `kompileCallArgs` is part of this package's public API.
It is a semver stability promise and changes only in a major version, so their
output is suitable for a canonical build fingerprint.

### run and interpret

```ts
import { KRun, llvmInterpret } from "@kframework-ts/ktool";

// No K on PATH: `interpreter` is a self-contained binary inside the definition.
const final = await llvmInterpret("imp-kompiled", pattern);

// With K on PATH.
const krun = await KRun.load("imp-kompiled");
const text = await krun.run(pattern, { output: "pretty" }); // returns it, does not print it
const result = await krun.runPattern(pattern); // KORE in, KORE out
const { returncode, kast } = await krun.krun("sum.imp"); // a program file
```

`llvmInterpret` and `krun.runPattern` compute the same thing on the same input:
`runPattern` forces `--term`, which means "the input is the whole
configuration", and that is what the interpreter does by construction.

### print and parse

```ts
import { KPrint, korePrint } from "@kframework-ts/ktool";
import { ksort, ktoken } from "@kframework-ts/kast";

const kprint = await KPrint.load("imp-kompiled");
kprint.mainModule; // "IMP" — read eagerly at load, as pyk reads it
kprint.prettyPrint(term); // in process: pyk's PrettyPrinter + SymbolTable
kprint.formatPrint(term); // in process: the definition's own `format` attributes
await kprint.koreToKast(pattern); // konvert, falling back to the binary

await kprint.parseToken(ktoken("3 + 4", ksort("AExp"))); // needs `kast`
await korePrint(pattern, { definitionDir: "imp-kompiled", output: "pretty" }); // needs `kore-print`
```

`runKast` and the binary fallback in `KPrint` default to the bare command
`kast`, which the operating system resolves through `PATH`. Package-manager
scripts such as `npm run` and `bun run` prepend `node_modules/.bin`; pass an
absolute `command` when the selected K installation must be deterministic.

`ConversionStrategy` makes pyk's implicit `try konvert / except / shell out`
explicit: `pure` (no process, and a conversion `konvert` cannot do throws),
`binary` (always the tool, which is what you want when checking `konvert`
against K), and `pure-then-binary` — pyk's behaviour, and the default.

### throughput: three ways to not start a JVM

```ts
import { KPrint, kparse, loadKompiledDefinitionCached, spawnKserver } from "@kframework-ts/ktool";

// 1. Native parser. `kompile --gen-glr-bison-parser` writes
//    parser_<Sort>_<Module> into the kompiled dir; this is the K distribution's
//    own lookup rule for it. ~0.8 ms, versus ~1 250 ms for `kast`.
const { kore, parser } = await kparse({ definitionDir, text: "1 + 2 + 3" });
parser !== undefined; // ⇒ no JVM ran. Byte-identical to `kast --output kore`.

// KPrint.parseToken takes this path automatically; `{ native: false }` opts out.
await kprint.parseToken(ktoken("1 + 2", ksort("Exp")));

// 2. Definition cache. N loads of one directory parse compiled.json once.
//    KPrint.load goes through it; `{ cacheDefinition: false }` opts out.
const kompiled = await loadKompiledDefinitionCached(definitionDir);

// 3. kserver. Everything with no native path (kompile, kprove) runs inside a
//    warm Nailgun JVM. Publishes KSERVER_SOCKET, which is the only channel the
//    K wrapper scripts read — so every spawn in this package picks it up.
const kserver = await spawnKserver({ socketDir: "/tmp/ks" });
try {
  /* … hundreds of kompiles … */
} finally {
  await kserver.stop();
}
```

Measured on `test/fixtures/live-k/tiny-parser.k` at K `v7.1.337`:

| operation                    | cold JVM | warm kserver | native                          |
| ---------------------------- | -------- | ------------ | ------------------------------- |
| parse a program              | 1 255 ms | 280 ms       | **0.8 ms**                      |
| `kompile --backend haskell`  | 3 900 ms | ~3 000 ms    | n/a                             |
| load + parse `compiled.json` | —        | —            | one parse, then object identity |

**None of this is transcribed from pyk, because pyk does none of it.**
`grep -r 'kserver\|nailgun\|parser_' pyk/src/` is empty of all three. The
specification is the K distribution's own shell scripts —
`bin/kparse`, `bin/{spawn,stop,reset}-kserver`, `lib/checkJava` — which are in
`TRANSCRIBED_FROM`'s **format** tier for exactly that reason, and are cited
file-and-line in each module header.

Three sharp edges, all upstream's and all documented in `src/kserver.ts`:
`KSERVER_SOCKET` names a **directory** (the socket is `<dir>/socket`); a socket
path over 104 bytes fails to bind and `spawn-kserver` reports it only into its
log file, so `spawnKserver` checks the length up front; and `stop-kserver`
exits **227** on success, so its status is ignored and the answer comes from
probing.

### claims

```ts
import { ClaimIndex, ClaimLoader, KproveModuleParser } from "@kframework-ts/ktool";

// Pure: given a KFlatModuleList from anywhere, no process and no K.
const index = ClaimIndex.fromModuleList(moduleList);
index.labels({ include: ["my-claim"], ordered: true }); // dependencies first
index.require("my-claim");

// The cached front door: parses with `kprove --dry-run` on a miss.
const loader = new ClaimLoader(new KproveModuleParser({ definitionDir: "imp-kompiled" }));
const claims = await loader.loadClaims("spec.k", { specModuleName: "MY-SPEC" });
```

`ClaimLoader` takes a `ModuleParser`, not pyk's whole `KProve`: one interface
with one method, so the cache logic is testable with no `kprove` and this module
imports nothing from `proc.ts`.

## Guarantees

**Pinned to K `v7.1.337`.** `K_RELEASE` and `K_COMMIT` are exported, and
`TRANSCRIBED_FROM` lists every upstream file this was read from with its sha256
and line count at that release — including the five K-distribution shell scripts
that are the only specification `kparse.ts` and `kserver.ts` have.

**What the argv goldens pin.** The test suite is 489 tests across 19 files and
**runs with no K installed, no network, and nothing outside the repository**
(the K-bearing `live-throughput.test.ts` registers as skipped).
What that buys, precisely:

- every flag's spelling, its value's encoding, and the **order** flags are
  emitted in, for `kompile`, `krun`, `kast`, `kore-print`, `kprove` and the
  interpreter. `krun`'s table is pyk's own unit test
  (`pyk/src/tests/unit/ktool/test_krun.py` — the only unit test in all of pyk's
  `ktool`) transcribed row for row;
- `KPrint`'s in-process paths — both pretty printers, and `konvert`-backed
  conversion — against the real `imp-{haskell,llvm}-kompiled` directories
  vendored in `@kframework-ts/kompiled`, with pyk's own `test_kprint.py`
  goldens;
- the whole of `ClaimIndex`, against `test_get_claims.py`'s table, run over a
  pre-generated `kprove --emit-json-spec` module list;
- `ClaimLoader`'s cache decision, and `parseKVersion`'s grammar;
- `kparse`'s lookup rule — the `syntaxDefinition.kore` gate, the module/sort
  defaults against a real `configVars.sh`, the `[ -x ]` test, and the
  dispatcher's two short-circuits;
- the definition cache's invalidation: object identity across loads, a new
  `timestamp` mtime forcing a reload, and a failed load not being cached;
- `kserver`'s address arithmetic and the `sun_path` pre-flight check.

**What needs a real K, and is therefore _not_ evidenced by the hermetic suite:**
that `kompile` accepts the argv we built (the `content` tier of `check-k` is the
early warning for this), `koreToPretty`, `krun` end to end, and `parseModules`'
round trip. The missing live rows are tracked in [`ROADMAP.md`](ROADMAP.md).

`test/live-throughput.test.ts` is in that lane and covers the three fast paths:
it kompiles the tiny fixture with `--gen-glr-bison-parser`, proves the native
parser and `kast --output kore` produce the **same bytes**, proves twenty parses
in a loop start zero JVMs, proves `KPrint.parseToken` agrees with itself on both
routes, and starts, probes, resets and stops a real kserver. It also calls
`korePrint` and `llvmInterpret` against real child-process pipes, pinning the
`/dev/stdin` handling in `src/stdio.ts`.

### Shared K-bearing harness

Implemented in the public `@kframework-ts/ktool/testing` subpath:
`kompileCached(spec)` and `describeKompiled(...)` mirror pyk's session-scoped
`Kompiler` fixture (`pyk/src/pyk/testing/_kompiler.py:41-95`). The cache key is
the canonical form of the kompile args, inline definitions are deduped by their
text, and `--type-inference-mode checked --warnings-to-errors` are forced on
every build. Bun has no fixture DI, so the in-process cache is module-level
rather than session-scoped. `KFRAMEWORK_TS_K_BIN` selects and exact-version
checks a K installation; `KFRAMEWORK_TS_KOMPILE_CACHE` names an optional
persistent build cache.

The first consumer is the separate `.github/workflows/k-conformance.yml` job,
which installs pinned K 7.1.337 while the existing `check` job stays K-free and
networkless. The broader ktool integration cases listed above still need their
own live scenarios. A later rung is a conformance runner over vendored test
dirs, replicating `ktest.mak`'s `CHECK='| diff -'` versus its `update-results`
`CHECK='>'` convention.

**Fixtures worth vendoring when that happens** (upstream paths, all under the
pinned K checkout; same `PROVENANCE.md`/`SHA256SUMS` discipline as
`@kframework-ts/kompiled`'s):

- `k-distribution/tests/regression-new/doubleinj/` — a 3-line definition,
  program and golden: `-cFoo=1` config vars end to end;
- `k-distribution/tests/regression-new/checks/` — 100 files, one kompile error
  each, with `.k.out` goldens: the jackpot for error-format parsing.
  `issue-4153-missing-module/` in the same suite is the smallest of them;
- `bad-flags/` from **both** the Java suite and `k/pyk/regression-new/` —
  CLI-error goldens; the pyk one doubles as a complete `pyk kompile` flag
  inventory;
- `pyk/src/tests/integration/test-data/k-files/cell-map.k` — `sortCollections`
  printing; and `k-files/{a,b,c,d}.k` — multi-file `-I` resolution;
- the inline `UNPARSING` module in
  `pyk/src/tests/integration/test_kprint.py:334-364` — alias folding and
  nonterminal-label pretty rows;
- `pyk/src/tests/integration/test_bytes.py` and `test_string.py` — escaping
  oracles for the `kast` round trip.

**What is deliberately absent.** `kfuzz` — fuzzing is a package of its own,
`@kframework-ts/kfuzz`, built on this package's `llvmInterpretRaw` and on
`substituteVars` in `@kframework-ts/kore`'s `manip.ts`; it takes fast-check as
the analogue of pyk's hypothesis (a peer dep there, so this package never grows
one). `run_proof_hint` — a bytes-mode process runner Python
needed and JavaScript does not; `--proof-hint` itself is still reachable through
`krunArgs`. `BugReport` tar interop (`pyk/utils.py:696-743`) — both of its call
sites in ktool are null-guarded upstream, so nothing is lost by leaving it to
its own module. A `kdist` equivalent — environment-variable overrides and
explicit paths — provides the required location controls, and pyk's own ktool
never imports `pyk.kdist` either. Claim proving is provided by the RPC
`proveClaims` API in `@kframework-ts/proof`; this package provides `kprove`
module parsing and claim indexing through `ClaimIndex.fromModuleList` and
`ClaimLoader.loadClaims`.

## `check-k`: is the transcription still true?

```sh
npx @kframework-ts/ktool check-k v7.1.400
```

Two tiers, reported separately, because they mean different things:

- **format** — the pyk sources this package's _behaviour_ is transcribed from
  (`ktool/{kompile,kprint,krun,claim_index,claim_loader,kprove,utils,_ktool}.py`,
  `kore/tools.py`, `utils.py`, `kbuild/utils.py`, and pyk's one `ktool` unit
  test). This tier decides the exit code: **0** unchanged, **1** changed,
  **3** could not locate a path, **2** could not ask.
- **content** — what the K binaries actually accept: `KompileOptions.java`,
  `KastOptions.java`, and the `krun` and `kore-print` shell scripts. Advisory,
  and printed without affecting the exit code. A diff here means a flag may have
  been added (nothing breaks), renamed (every argv built for it is invalid) or
  removed. A human has to look.

Two specifications rather than one is peculiar to this package: pyk decides
which flags to emit and in what order, and the Java frontend decides which flags
exist. A port has to track both, and a divergence _between_ them is a real
finding — pyk emitting a flag that K rejects is exactly what this catches.

`checkKtoolSources` is exported if you would rather call it than shell out.

## ⚠ The claim cache is not interchangeable with pyk's

`ClaimLoader` caches a parsed spec as `<spec>.json` beside it, keyed by a digest
of the parsed sources. **The two digests are computed differently on purpose.**
pyk's is `sha256(str(dict_of_parsed_outer_asts))` — the SHA-256 of Python's
`repr` of a dict whose keys are `PosixPath` objects and whose values are
`@dataclass` instances. That string is a Python implementation detail: it is not
a format, it is not documented, and no other language can produce it. So this
port defines its own (`claimDigest`, whose scheme is spelled out in the source).

- A `<spec>.json` written by pyk is a **guaranteed cache miss** here, and one
  written here is a guaranteed miss under pyk. Neither corrupts the other: a
  miss rewrites the file, so the two tools ping-pong rather than break.
- The `{moduleList, digest}` **wire shape is identical**, and `moduleList`
  decodes cleanly in either tool. Only the digest differs.
- **Do not check a `<spec>.json` into a repository both tools read**; it will
  churn.

The digest also embeds absolute paths, exactly as upstream — so moving a
checkout invalidates the cache, and the file is not portable between machines.
pyk has the same property; a spec cache is a local build artifact in both.

## The CLI

```sh
npx @kframework-ts/ktool --help
```

The command tree and help are generated by
[`@stricli/core`](https://bloomberg.github.io/stricli/). Each leaf remains a
thin shell over the library; adding a route does not require editing a monolithic
usage string.

```sh
# The argv, without running anything — the pure layer, from a shell.
$ ktool kompile imp.k --backend haskell --main-module IMP -o out --dry-run
kompile imp.k --main-module IMP --emit-json --backend haskell --output-definition out

# The spawn. kompile's own output is mirrored; the last line is the directory.
$ ktool kompile imp.k --backend llvm -o imp-kompiled

# Through <dir>/interpreter when there is one, else `krun --term`.
$ ktool run imp-kompiled final.kore --output pretty
$ ktool run imp-kompiled sum.imp --depth 10 --output kore

# `kast --input program --output json --sort AExp`, rendered how you like.
$ ktool parse imp-kompiled '3 + 4' --sort AExp --output pretty

# The labels a spec resolves to, dependencies closed over and topologically sorted.
$ ktool claims spec.k --definition imp-kompiled --ordered

# Classify an existing parser.y. JSON is pretty-printed unless --compact.
$ ktool lr1 bison parser.y --bison /opt/bison-3.8.2/bin/bison

# Generate K's deterministic PGM grammar, then classify those exact bytes.
$ ktool lr1 k language.k --main-module LANGUAGE --syntax-module LANGUAGE-SYNTAX

$ ktool check-k v7.1.400
```

Some notes on the `lr1` output format:
- Both `lr1` routes emit the same versioned JSON envelope: `{"format":"KtoolLr1Result","version":1,"operation":...}`.
- The `result` retains the complete library analysis/check aggregate.
- Exact byte fields are inline objects with `encoding: "base64"`, `data`, `byteLength`, and `sha256`;
- there is no sidecar evidence directory.
- Values that are required in memory but `undefined` are represented explicitly as `null`.
- A K diagnostic is emitted as `{ record, classification }`: `record` is the complete original parsed record (including `raw` and `rawLines`) while `classification` adds its semantic family and tag.
- Consumers can validate and type the contract with `KtoolLr1JsonSchema` and its schema-inferred `KtoolLr1Json` type.
- Contract objects are strict: unknown keys are rejected rather than silently stripped.

| route       | what it calls                                                                                                                            |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `kompile`   | `KompileSpec` + `KompileCallOptions` → `kompile()`, or `buildKompileArgv()` under `--dry-run`                                            |
| `run`       | `KPrint.load` + `llvmInterpret()` / `KRun.runPattern()` / `runKrun()`, rendered through `koreText`, `KPrint.koreToKast` or `korePrint()` |
| `parse`     | `KPrint.parseToken()`, rendered through `kastTermToDict`, `KPrint.prettyPrint` or `KPrint.kastToKore`                                    |
| `claims`    | `ClaimLoader` over `KproveModuleParser`, then `sentenceLabel` / `staticOrder`                                                            |
| `lr1 bison` | `analyzeBisonLr1File()` over the exact supplied grammar bytes                                                                            |
| `lr1 k`     | `checkKGrammarLr1()`: deterministic K parser capture followed by independent Bison analysis                                              |
| `check-k`   | `checkKtoolSources()`                                                                                                                    |

Exit codes: **0** success, **1** the operation failed (K exited non-zero, a file
could not be read, a label did not resolve), **2** could not run (usage), plus
**3** for `check-k`'s "could not locate". For both `lr1` routes, 0 means the
classification is `lr1`; every other classification exits 1 and remains
available in the JSON result. Argument errors use Stricli's generated messages
and help rather than a hand-maintained usage block.

Two CLI-only decisions worth knowing. `run --output` refuses `latex`, which the
library's `PrintOutput` carries (because pyk's does) and `kore-print` rejects —
spending a process to earn a usage error is not an improvement on saying so up
front. And `claims --ordered` sorts the _selection_, so for a `--labels` subset
its tie-breaking can differ from `ClaimIndex.labels({ordered: true})`; both are
valid topological orders, and the two coincide for the default whole-spec case.

## Things that will surprise you, because they surprise everyone

These are pyk behaviours, not ours. They are reproduced (or deliberately not)
and the reasoning is in the source, next to each transcription — the quirk
ledgers at the top of `src/kompile.ts` and `src/krun.ts` carry the full tables.
This is the short list.

- **`emitJson` defaults to `true`.** The `kompile` CLI defaults it to `false`
  (`KompileOptions.java:159-161`) and pyk defaults it to `true`
  (`ktool/kompile.py:557`). This is why a pyk-built definition has a
  `compiled.json` and a hand-built one does not — and therefore why
  `@kframework-ts/kompiled` can read the former.
- **The default output directory is relative to _your_ working directory.**
  `kompile({backend:'llvm', mainFile:'semantics/imp.k'}, {cwd:'build'})` writes
  to `build/imp-kompiled` and _returns_ `imp-kompiled`. Upstream
  (`ktool/kompile.py:356-357`) defines the same behavior. Pass `outputDir` and
  none of it applies.
- **`--post-process` is not quoted.** pyk `shlex.quote`s it into an argv that no
  shell will ever read (`:620`), so `echo "hi"` reaches `kompile` as
  `'echo "hi"'`. We pass the value through.
- **`--outer-parsed-json` is emitted once**, where upstream can emit it twice.
- **Unknown keys throw.** `kompileFromDict` raises on one, as
  `Kompile.from_dict` does — and so does `boosterKompile`, where
  `_group_args` silently drops it and builds a definition without the option you
  asked for.
- **`getKDistribution()` is lazy.** pyk's `K_DISTRIBUTION` forks a `which`
  subprocess at _import_ time; this resolves `PATH` in-process, on first ask,
  once.
- **`kore-print` gets `--output-file`, not `--output_file`.** pyk's underscore
  (`kore/tools.py:68`) is a typo the `kore-print` script's option table does not
  have, so it would print usage and exit 1. Nothing has ever passed it.
- **`KRun.run` returns the rendered text; pyk prints it.** A library that writes
  to your terminal is a library you work around.
- **`KRun.krun` honours the command you configured.** Upstream builds that one
  argv with the literal `'krun'` (`krun.py:298`) and every other with
  `self.command`.
- **`--debugger` inherits the streams instead of `execvp`.** Node cannot replace
  its own process; the child gets the real tty and its status comes back to you.
  A CLI wanting pyk's exact behaviour should finish with
  `process.exit(result.returncode)`.
- **`--depth 0` is emitted by `krunArgs` and dropped by the `kprove` builder.**
  `_build_arg_list` tests `depth is not None` (`krun.py:400`) in one and
  `if depth:` (`kprove.py:149`) in the other. Both are transcribed as written.
- **`expandMacros` flips default between entry points.** `true` for `run`,
  **`false`** for `runPattern` (`krun.py:220,269`). A caller handing over a whole
  configuration has already had its macros expanded.
- **Two pretty printers, one of which cannot take the hooks.**
  `KPrint.prettyPrint` is pyk's `pretty_print` (a `SymbolTable`, so
  `patchSymbolTable` and `extraUnparsingModules` apply). `KPrint.formatPrint` is
  the `format`-attribute printer, which has no symbol table at all; it _throws_
  rather than silently dropping your unparsers.
- **`KPrint.load(...)`, not `new KPrint(...)`.** pyk reads the marker files in
  its constructor; reading a directory here is `async`, and the eager
  `mainModule`/`backend` fields are worth an async factory.
- **`/dev/stdin` in an argv does not work here, and that is not a Bun bug.**
  pyk passes `/dev/stdin` (and `/dev/stdout`) to `kore-print` and to the LLVM
  `interpreter` and pushes the data down the pipe. Node and Bun both hand a
  spawned child a **socketpair** for piped stdio, and reopening a socket
  through `/proc/self/fd/N` is `ENXIO` — so upstream's spelling makes both
  tools fail outright (`Cannot read file: /dev/stdin`). CPython's `subprocess`
  uses a real `pipe(2)`, which is why it works upstream. `korePrint`,
  `llvmInterpretRaw` and `kparse` therefore materialise temp files and pass
  those paths; `src/stdio.ts` carries the evidence and the rejected
  alternatives. The pure argv builders still emit the `/dev/*` literals, because
  they are pyk's list — `llvmInterpretArgs` grew two optional parameters for the
  substitutes rather than changing its default.
- **`run_proof_hint` is not ported.** It exists upstream only because Python
  needed a bytes-mode process runner, and it has zero downstream users.

### Bounded runs and decoded output

Every non-interactive spawning wrapper accepts `timeoutMs`, `signal`, and
`killGraceMs`. `kserver` is the one shape with two distinct deadlines: its
top-level `spawnKserver`/`stopKserver` `timeoutMs` values bound lifecycle
readiness/shutdown waits, while `processControl` on its address controls each
short-lived Nailgun probe, reset, or shutdown child (five seconds when that
nested control leaves `timeoutMs` absent). A bounded child is put in its own
process group and is stopped by TERM, then KILL after the grace (2 seconds by
default). `timeoutMs` must be a positive finite number; `0` is rejected, while
`killGraceMs: 0` requests an immediate KILL. `CompletedProcess.cancelledBy`
distinguishes `"timeout"` from `"abort"`; with `check: true` either throws
`ProcessCancelledError`, and with `check: false` the captured partial streams
are returned. A pre-aborted signal throws `ProcessAbortError` before spawning.
The interactive `krun --debugger` route deliberately remains unbounded and
inherits the terminal.

`decodeSearchResult`/`decodeSearchConfigurations` and their `Kore` twins decode
the measured `krun --search-final` / `--search` output only when given the explicit
`--no-pattern` mode. They return a typed `trivial` or `unrecognised` outcome
instead of guessing from the term. Search result order is document order only;
compare KAST and KORE results as sets. `parseKDiagnostics` similarly parses
the JVM, shell-wrapper, and native-parser formats without running a process;
unknown diagnostic messages remain raw-preserving.
Repeated complete search substitutions are deduplicated structurally; this is
intentional and does not depend on `kast-json` equality.

Measured at K v7.1.337: LLVM search requires `kompile --enable-search`; both
`--search` and `--search-final` are official synonyms (and both are exposed so
callers preserve the argv spelling they selected). LLVM accepts `--bound` and
`--pattern`, returns rc 0 for zero solutions, and rejects `--search-all`,
`--search-one-step`, and `--search-one-or-more-steps`. Its `--statistics`
output corrupts the disjunction stream, so it must not be decoded as KORE.
The Haskell backend supports all search types, but silently ignores
`--no-pattern`. K's help text incorrectly says LLVM does not support
`--pattern` at this release. These flags, search type, and output choice remain
direct argv concerns rather than decoder options. The decoders are pure: they
neither spawn `krun` nor infer pattern mode from the result; rc 0 is not proof
that a search had solutions.

The measured backend matrix is recorded byte-for-byte in
`fixtures/search/`: LLVM requires `--enable-search`, supports only
`--search`/`--search-final`, and refuses the other search kinds; Haskell accepts
the broader search vocabulary but ignores `--no-pattern`. Search forces the
LLVM interpreter's I/O mode off for the invocation. The unsupported LLVM
command returns rc **1** and writes the external-tool bytes
`[Error] krun: Backend llvm does not support --search-all, \n--search-one-or-more-steps, or --search-one-step yet.`;
the literal space before `\n` is a byte in stderr. The escaped inline form is
used so the trailing space is not lost to Markdown rendering; it is retained in
the fixture provenance rather than rephrased as a library error.

`noExcWrap` is forwarded faithfully: `kast` receives the JVM option directly;
the `krun` and JVM-fallback `kparse` shell routes consume it before the JVM, so
it affects only their wrapper error line. Native `kparse` has no such option.

Frontend exit facts are intentionally coarse: direct JVM tools use **0** for
success/help/version, **1** for option/boot or uncaught failures, **113** for
any `KEMException` diagnostic (not specifically ambiguity), and **124** for
their timeout route. Generated native parsers use **1** for both scanner and
syntax failures and **2** for stack exhaustion. Shell wrappers may add their
own **1**/**2** setup failures or propagate a child/backend status; `krun`'s
interpreter/backend code is therefore outside this frontend taxonomy.

### K output routes (measured at v7.1.337)

`pretty` and `program` are distinct official `kore-print` routes. `pretty`
uses the definition's unparsing modules and can render a configuration as its
cell structure; `program` is the program-oriented route and is only meaningful
where K can recover the configured program view. Neither is a round-trip
promise: parsing either text again can lose variable naming, brackets,
associativity choices, formatting, and generated-label details. This package
does not repair or emulate either printer.

| requested `KRun` output                        | mechanism                                                                                                     |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `json`                                         | KORE parse, then in-process KAST conversion and KAST-v4 envelope                                              |
| `kore`                                         | KORE parse and canonical text render                                                                          |
| `pretty`, `program`, `kast`, `binary`, `latex` | `kore-print --output`; `latex` remains a stale `KRunOutput` enum member and is rejected by current kore-print |
| `none`                                         | no parse/render                                                                                               |

`--bison-lists` is a parser-generation compatibility mode, not a promise that
printed user lists reparse identically. Parametric/generated labels are an
equally important boundary: a stored compiled definition may be readable by a
consumer while its parser artifacts are absent; concrete parser names and
aliases are re-derived from the layout, never guessed from detached filenames.
The package records this as **stored vs readable vs re-derived**, rather than
claiming a universal printer or round-trip facility.

## Development

```sh
bun install
bun test              # no K install, no network
bun run check:types
bun run build
```

Fixtures are the vendored `multi-claim-spec.k` and the module lists K produced
from it, alongside the `imp-*-kompiled` directories that live in
`@kframework-ts/kompiled`. See `fixtures/PROVENANCE.md` before regenerating
anything.

## Licensing

Dual licensed under either of

- Apache License, Version 2.0 (`LICENSE-APACHE`)
- MIT license (`LICENSE-MIT`)

at your option. `MIT OR Apache-2.0` is the SPDX expression in `package.json`.

Separately, this package is a close transcription of BSD-3-Clause licensed
sources from the K Framework, and BSD-3-Clause's terms continue to govern that
transcribed material whichever of the two licenses above you take this package
under. Both required notices are carried in **`THIRD-PARTY-NOTICES.md`**, which
ships with the package.
