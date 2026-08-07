# @kframework-ts/kcovr

A TypeScript implementation of **K Framework's rule coverage** — the artifacts
`kompile --coverage` leaves behind, counted, reported as Cobertura XML, and
remapped across recompiles.

> **Unofficial.** Not affiliated with, endorsed by, or supported by Runtime
> Verification, Inc. or the K Framework maintainers.

## Read this first: there is no specification, and upstream has no tests

Every other package here transcribes something that is at least exercised
upstream. This one does not. `kcovr.py`, `coverage.py` and `kprint.all_rules`
have **no test at all**, in any form. The six `regression-new/` `Makefile`s that
pass `--coverage` assert only that `kompile --coverage` exits 0 — none of those
directories contains a `.test` program, so `krun` never runs and no coverage
output is ever produced, let alone diffed. There is no golden Cobertura file, no
sample `allRules.txt`, no hit log and no kore-exec log checked into the `k`
repository, and none of the five sibling semantics repositories (KEVM, kontrol,
KWasm, KMIR, imp) uses any of it.

So the pyk implementation **is** the specification, and where pyk's four
`allRules.txt` parsers and two Cobertura generators disagree with each other,
this package had to decide. Every such decision is recorded — in
`src/version.ts` (which sha256s the six upstream files this is derived from or
checked against, at K **`v7.1.337`**), in each module's header, and in
"[Deliberate deviations](#deliberate-deviations-from-pyk)" below. Two of them
are places where pyk **crashes** on real input and this package does not.

The fixtures are the other half of that answer: a real `kompile --coverage`
build made in this workspace, a golden minted by running **pyk's own renderer**
over it, and the one upstream unit table transcribed and verified
mechanically against upstream's AST. `fixtures/PROVENANCE.md` is where all of
that is written down, and it is mandatory reading before regenerating anything.

## Install

```sh
npm install @kframework-ts/kcovr   # or: bun add / pnpm add / yarn add
```

Depends on `@kframework-ts/kast` and `@kframework-ts/kompiled`, nothing else.
ESM only, with types. Node 20+, Bun 1.3+.

## What `kompile --coverage` actually is

One mechanism, and it is **LLVM-only**. `--coverage` is a kompile-time
source-to-source rewrite (`KompileOptions.java:98-99`,
`GenerateCoverage.java:49-79`) that wraps every rule's right-hand side in a call
to the `#logToFile` hook. That hook is implemented by the LLVM backend
(`io.cpp:559`) and by nothing else — the haskell backend registers only
`IO.logString` (`IO.hs:74-76`) — so `kompile --coverage --backend haskell`
compiles happily and then never logs a thing.

```text
kompile --coverage                                     (K toolchain — out of scope)
  ├─ <def>/allRules.txt     UNIQUE_ID → file:line:col   written ALWAYS, --coverage or not
  ├─ <def>/coverage.txt     macro applications          appended at kompile AND parse time
  └─ instrumented rules     sideEffect:S(#logToFile(…), rhs)
krun / interpreter                                     (K toolchain — out of scope)
  └─ <def>/<pid>_coverage.txt   one UNIQUE_ID per application
                    │
                    ▼  this package
```

Three properties of that picture surprise people, so they are worth stating
before the API:

- **`allRules.txt` is not part of `--coverage`.** `Kompile.java:363-382` writes
  it for every build. It is a `UNIQUE_ID → source location` index of the main
  module's rules that carry `Source`, `Location` _and_ `UNIQUE_ID` — not all
  rules (168 of 559 in this package's fixture) — and its order is a scala
  `Set`'s, i.e. arbitrary. Nothing here depends on that order, and `kcovr hits`
  sorts its own output.
- **Hit logs are append-only.** Each is opened `"a+"` and flushed at `atexit`
  (`io.cpp:552,566`), so a second run against the same directory **doubles every
  count** rather than replacing it. Give each run or scan a fresh `K_LOG_DIR`;
  directory lifecycle is caller-owned, and this package deliberately has no
  reset/delete helper.
- **One process, one log.** The filename is
  `<K_LOG_DIR | dirname(path)>/<K_LOG_PREFIX><pid>_coverage.txt`
  (`io.cpp:526-557`), so a corpus scan leaves dozens of files rather than one —
  63, for the run the fixtures came from. `K_LOG_PREFIX` is absorbed by the
  glob; `K_LOG_DIR` sends the logs somewhere else entirely, and a run redirected
  that way leaves the definition directory empty, so point the reader at wherever
  they landed.

For an LLVM run, compose the coverage environment with the spawning package's
environment and preflight the directory before the spawn:

```ts
import { coverageLogEnv } from "@kframework-ts/kcovr";
import { checkCoverageLogDir, coverageLogEntries } from "@kframework-ts/kcovr/fs";

const dir = "/tmp/my-run-coverage"; // create/manage this fresh directory in the caller
await checkCoverageLogDir(dir); // existence, directory type, and writability; TOCTOU remains possible
const env = coverageLogEnv({ dir, prefix: "case-0001-" });
// Pass `env` to the existing krun/interpreter process option.
const entries = await coverageLogEntries(dir, "case-0001-"); // exact-prefix attribution
```

`coverageLogName` and `parseCoverageLogName` expose the filename grammar.
Without an expected prefix, parsing is explicitly `"heuristic"`: it reports
whether the maximal final digit run is ambiguous. For example,
`case142_coverage.txt` may be `case` + pid 142 or `case1` + pid 42.
Pass the expected prefix to the pure parser or `coverageLogEntries` for
`"exact"` attribution; mismatches remain `"unattributed"`, and the macro log
remains separately identified. A missing file alone proves neither a bad
directory nor a failed run: a timeout/abort or a run with no logged rule can
produce the same state.

## The shape of the library

```ts
import {
  createCoverMap, // hit log text → Map<UNIQUE_ID, applications>
  createRuleMap, // allRules.txt → Map<UNIQUE_ID, {source, line, column}>
  renderCoverageXml, // → a Cobertura 1.9 document
  renderCoverageReport, // …plus the unknownIds / rates diagnostics
  translateCoverage, // hits recorded against one build → another build's ids
  getRuleById, // UNIQUE_ID → the KRule
  stripCoverageLogger, // the instrumented rule → the rule its author wrote
} from "@kframework-ts/kcovr";
// The one module that needs `node:fs`, behind its own subpath:
import { readCoverageDefinitions } from "@kframework-ts/kcovr/fs";

const definitions = await readCoverageDefinitions(["./my-kompiled"]);
const xml = renderCoverageXml(definitions, ["/abs/path/semantics.md"], { timestamp: 0 });
```

Everything in the root export is a function of strings, maps and
`KDefinition`s. `@kframework-ts/kcovr/fs` is the whole of the I/O — the same
split `@kframework-ts/k-parser` uses for `./slurp` — so a consumer that has the
bytes already (a zip, a CI artifact store, an HTTP range reader) builds a
`CoverageDefinition` itself and never pulls `node:fs` into its module graph.
Paths in public signatures are `string`, never node types.

Two things in that list are deliberately stronger than pyk:

- **`renderCoverageXml` takes its `timestamp`.** `kcovr.py:92` calls
  `time.time()` inside the renderer, which is why no golden exists upstream;
  here it is a required option and only `bin.ts` reads a clock. And `<line>`
  elements are emitted in **ascending line order**, where pyk accumulates them
  into a Python `set` (`kcovr.py:231-240`) whose iteration order follows
  `PYTHONHASHSEED` — three unseeded runs over the fixtures produced three
  different sha256s. Sorting is lossless (there is exactly one `<line>` per line
  number) and it is the only reproducible choice. Together these two make the
  output byte-diffable, which is what `fixtures/synthetic/golden.cobertura.xml`
  pins.
- **`stripCoverageLogger` handles both instrumentation shapes.** The current one
  is an arity-2 `sideEffect:<Sort>(#logToFile(…), rhs)` (`GenerateCoverage.java:66-78`,
  and all 168 rules of the fixture `compiled.json` carry exactly it across 8
  sorts). pyk matches a `project:`-labelled application wrapping a two-item
  `KSequence` (`coverage.py:34-43`) — the shape K emitted before the
  `sideEffect` rework — so on a definition built by any current `kompile` pyk
  silently returns the rule with the logger still in it. Both are stripped here;
  the label prefixes are disjoint, so neither branch can fire on the other's
  input.

### Two identity spaces, and the bridge between them

`RuleId` is a full 64-lowercase-hex `UNIQUE_ID` — SHA3-256 of the normalized
sentence (`NumberSentences.java:26-54`; pyk's docstring says SHA-256, which is
wrong). It is what hit logs, `allRules.txt` and everything under `--coverage`
speak.

`LocationKey` is `` `${source}:${startLine}:${startCol}-${endLine}:${endCol}` ``
— a source _range_, and the only thing the legacy `koreExecLog` module has. No
hash appears in it anywhere.

The two never convert to each other upstream, and they are separate types here
so they cannot be crossed by accident. If you want the bridge, build it
explicitly out of `allRules.txt` and the definition's attributes:

```ts
import { Atts } from "@kframework-ts/kast";
import { createRuleMap, getRuleById, locationKey } from "@kframework-ts/kcovr";

const ruleMap = createRuleMap(definitions); // RuleId → source:line:column
const rule = getRuleById(definition, ruleId); // …and the sentence itself
const source = rule.att.get(Atts.SOURCE);
const location = rule.att.get(Atts.LOCATION);
const key = source !== undefined && location !== undefined ? locationKey(source, location) : undefined;
```

Note that the two do not carry the same information: `allRules.txt` records a
_start_ position, `Atts.LOCATION` a whole range, and the join is only as good as
the definition you do it against.

## Translation matches on `basename:line:col`, and that collides

`translateCoverage` answers "I recorded these hits against yesterday's build;
which rules are they in today's?" — src `UNIQUE_ID` → src `file:line:col` →
**`basename`**`:line:col` → dst `UNIQUE_ID` (`coverage.py:46-105`). Dropping the
directory is the entire point, since the directory is what changed.

It is not a rule identity, and the fixture proves it on real input: **168 rules
occupy 125 distinct `basename:line:col` keys**, because rules K generates from
one production (heating/cooling pairs) carry their source rule's line _and_
column. Translating that build against _itself_ is therefore not the identity —
**13 of its 39 hit `<generatedTop>` rules come back as a different rule at the
same location**, and only 19 are alone at their location. Across directories it
is worse: `a/sem.k:42:7` and `b/sem.k:42:7` are one key, and which one wins
depends on `allRules.txt` order, which is arbitrary.

This is pyk's own behaviour and it is **kept**, because narrowing the key to the
full path would make the function do nothing. What changes is that it is written
down and tested rather than discovered. Two further notes: the count is
preserved but the multiset is not (one hit in, at most one hit out, in log
order), and rules that are not `<generatedTop>`-rooted — functions,
simplifications — are dropped from the output by design (`:102-103`), because
the caller wants rewrite steps and a function rule is not a step.

## The CLI

```sh
$ npx @kframework-ts/kcovr report my-kompiled ++ /abs/semantics.md > coverage.xml
$ npx @kframework-ts/kcovr hits my-kompiled
7a3c…e1  42  /abs/semantics.md:118:5
$ npx @kframework-ts/kcovr rules my-kompiled my-kompiled/4242_coverage.txt
$ npx @kframework-ts/kcovr translate old-kompiled new-kompiled hits.txt
$ npx @kframework-ts/kcovr kore-log run.log --definition my-kompiled
$ npx @kframework-ts/kcovr check-k v7.1.400
```

When installed as a package, the executable is `kcovr-ts`; the suffix avoids
shadowing K's own `kcovr` binary on `PATH`.

`report` is `pyk-covr` parity; `rules` is `pyk coverage` parity; `kore-log` is
`kore-exec-covr` parity. `hits` — one line of
`UNIQUE_ID <TAB> applications <TAB> file:line:col`, sorted — and `translate`
have no upstream entry point at all. Exit codes are 0 success, 1 unreadable or
contradictory input, 2 usage.

Four things to know before piping any of it anywhere:

- **`rules` and `translate` need `--emit-json`.** Both read `compiled.json`,
  which `kompile` does **not** write by default (`emitJson` is `false` in the
  Java frontend and `True` in pyk). A directory that reports coverage happily
  can still be unable to pretty-print a rule; the error says so rather than
  reporting an ENOENT.
- **`rules` is `exec_coverage` line for line**, minimization included. The
  definition loses `Source`/`Location` once, before the printer is built
  (`remove_source_map`, `__main__.py:405`), and each rule is passed through
  `minimize_rule_like` (`:407`) after its coverage logger comes off — both now
  exported by `@kframework-ts/kast`. On the fixture definition that collapses
  the `true andBool …` side condition of 66 of 168 rules. The only remaining
  difference from pyk is the single trailing newline noted below.
- **`report` accepts `++` and `--`** as the separator between definition
  directories and source files. `pyk-covr` implements `++` (`kcovr.py:65`) while
  its own usage string says `--` and `bin/kcovr:20` implements `--`; `++` is
  canonical in these docs. Unlike `pyk-covr`, the separator is **required** —
  omitting it there yields a report with no classes and no error.
- **Stale ids warn instead of crashing.** A hit log that names a hash no
  `allRules.txt` knows means the log predates the last kompile (they are
  append-only). pyk raises `KeyError` (`kcovr.py:253-255`); `report` prints a
  warning to stderr, excludes those ids from the rates, and still writes the XML
  to stdout.

### `kcovr-ts check-k <k-release>`

The house drift check, with one difference from every sibling: **both tiers
decide the exit code.**

- **transcription** — the four pyk modules this package ports (`kcovr.py`,
  `coverage.py`, `kore_exec_covr/kore_exec_covr.py`,
  `kore_exec_covr/__main__.py`).
- **reference** — the two files this package is checked _against_ rather than
  ported from: `test_kore_exec_covr.py`, whose 7 inline cases are the **only**
  specification the legacy log format has, and `GenerateCoverage.java`, which
  decides the shape `stripCoverageLogger` must strip.

In `kompiled` and `kore` the second tier is advisory. Here it cannot be: there
is no other authority to consult, and a change to either file invalidates this
package's answers — a change to `GenerateCoverage.java` is precisely the failure
pyk is living in today. So `0 unchanged, 1 changed, 3 could not locate, 2 could
not ask` is computed over both. `checkKcovrSources` is exported if you would
rather call it than shell out.

`runtime/io/io.cpp`, which decides where a hit log lands and what it is called,
is checked through its submodule identity. `check-k` resolves the `llvm-backend`
gitlink recorded in the requested K release, then fetches `io.cpp` from
`runtimeverification/llvm-backend` at that exact commit; it never assumes a K
tag exists in the backend repository. The report records both repositories and
the resolved commit. The other absentee is deliberate: `Kompile.java`, which
writes `allRules.txt`, is pinned by `@kframework-ts/kompiled`'s manifest, because this package does not
parse that file — it delegates.

Per [`docs/versioning.md`](../../docs/versioning.md): coverage artifacts carry no
self-identifying version header — `allRules.txt` and the hit logs are bare lines
— so this package asserts nothing about its input's K version at runtime. The
one exception is `compiled.json`, whose envelope `@kframework-ts/kast` checks.

## Deliberate deviations from pyk

Each is tested by name and argued in the module header that owns it.

| deviation                                                                  | why                                                                                                                                                                                                            |
| -------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| No fifth `allRules.txt` parser — everything routes through `kompiled`      | `coverage.py:66-67` crashes on any path containing a space; the correct parser was already written next door                                                                                                   |
| Source root truncated to the last `/`                                      | `kcovr.py:79` uses bare `commonprefix`, which raises `ValueError` whenever the character prefix ends mid-component; `bin/kcovr:82` truncates and this matches it — byte-identical to pyk wherever pyk survives |
| Zero-denominator rates render as `1.0`                                     | `kcovr.py:86,90,125,129,161` divide unguarded, so a definition with no rules in the requested sources crashes pyk; nothing to cover means covered                                                              |
| Duplicate `UNIQUE_ID` across definition dirs throws `DuplicateRuleIdError` | pyk dies on a bare `assert` (`:193`) that names neither the id nor the files                                                                                                                                   |
| Stale hit ids become an `unknownIds` diagnostic                            | pyk raises `KeyError` (`:253-255`) and loses the whole report over a log left behind by an earlier build                                                                                                       |
| `<line>` sorted; `timestamp` injected                                      | pyk's output is `PYTHONHASHSEED`-nondeterministic and stamps the clock — neither is diffable                                                                                                                   |
| `stripCoverageLogger` strips both shapes                                   | pyk's matches only the pre-`sideEffect` shape and is silently wrong on current definitions                                                                                                                     |
| `++` and `--` both accepted                                                | `pyk-covr` implements one and documents the other; `bin/kcovr` implements the other                                                                                                                            |
| `kcovr rules` ends its output with one newline                             | pyk's last write is the pretty-printed rule itself (`__main__.py:413`), so a shell prompt lands mid-line; every byte before the newline is pyk's                                                               |

Everything else is transcribed as-is, including the things that look like bugs:
the composite space-joined key for a multi-location log line, the literal
`UNKNOWN` bucket for an empty one, the `\d*` in the log regex that accepts `[]`,
and the `availible` typo in the `kore-log` report, which is part of the output
contract until upstream fixes it.

## `koreExecLog` is legacy, and says so

`kcovr kore-log` and the `koreExecLog` module analyse **haskell-backend
kore-exec debug logs** — a completely different tool that upstream happens to
keep in the same directory. It does not read `allRules.txt`, does not know what
a `UNIQUE_ID` is, and has nothing to do with `--coverage`.

Its format is **frozen**: `kore-exec` used to print a rule's source location
after `Debug (DebugAppliedRewriteRules):`, and the current haskell-backend
prints `"applied N rewrite rules"` instead (`DebugAppliedRewriteRules.hs:69-73`).
No fixture can be regenerated, which is why the 7-case unit table is vendored as
the specification. The successor is `--log-format json` / `oneLineJson`, which
carries `rule_id` and `location` as fields rather than as a substring — that is
what anything new should read, and parsing it is deliberately not implemented
here (see below).

The module ships anyway because logs from older toolchains are real artifacts
people still have, and because `kore-exec-covr` is one of pyk's three published
entry points.

## An upstream bug worth knowing about

**`kompile --coverage` cannot compile a definition containing a sort-parametric
rule.** `GenerateCoverage.gen` computes each rule's top sort with
`inj.topSort(body)` and builds a `sideEffect:` label from `s.toString()`
(`GenerateCoverage.java:62-68`) with no guard for sort parameters and no skip for
`simplification` rules. For a rule like KWasm's

```k
rule #Ceil(setExtend(_L:ListInt, I:Int, _V:Int, _D:Int)) => {true #Equals 0 <=Int I}
    [simplification]
```

that sort is the parameter `#SortParam{Q0}`, no `sideEffect:#SortParam{Q0}`
production exists, and the build dies in "Add sort injections". It is present at
`v7.1.337`, so it is not version skew, and it is why this package has no
large-scale vendored coverage build: KWasm cannot produce one.
`fixtures/PROVENANCE.md` records the full attempt. **This has not been reported
upstream.**

## What is deliberately not here

Permanently, not "not yet":

- **The instrumentation itself.** Generating `--coverage` definitions, wrapping
  rules, implementing `#logToFile` — the K toolchain's job, three languages away.
- **Running `kompile` or `krun`.** Like every package here, `kcovr` reads
  artifacts; `fixtures/generators/` documents the commands for humans.
- **Merging the two identity spaces in the API.** `RuleId` and `LocationKey`
  stay separate types; the bridge is above, built by hand.

Open, and blocked on work or on a caller rather than on principle:

- **LLVM proof-hint traces as a coverage source**
  (`--llvm-proof-hint-instrumentation`). The modern, actively developed way to
  get per-step rule identity on LLVM — a binary format keyed by **ordinals**
  (axiom index in `definition.kore` load order, synthesized in memory,
  `definition.cpp:222-238`), which is a _third_ identity space.
  `@kframework-ts/prooftrace` reads the hint stream and resolves ordinals
  against a parsed `definition.kore` (see its README, "How an ordinal becomes a
  rule"). What stays open is this end of the bridge — turning a resolved trace into
  per-rule coverage alongside `RuleId` and `LocationKey` — and it waits on a
  caller that wants LLVM coverage, not on the format.
- **Haskell JSON logs** (`--log-format json`), the successor to what
  `koreExecLog` reads. Worth doing when something in this workspace consumes it.

## Development

```sh
bun install
bun test              # no K install, no network
bun run check:types
bun run build
```

The fixture corpus is described in full in `fixtures/PROVENANCE.md`, including
every numeric claim this README makes — `test/fixtures.test.ts` asserts them, so
a sentence here that rots fails a test.

There is no version skew to report: the pyk transcription and the toolchain that
produced every vendored byte are both K **`v7.1.337`**, and nothing in the corpus
has been edited into shape. `compiled/compiled.json` in particular is `kompile
--emit-json`'s own output with paths substituted and unreferenced sentences
dropped — KAST v4 as emitted, not lifted into it.

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
