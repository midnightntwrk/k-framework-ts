# @kframework-ts/kfuzz

Property fuzzing over a **K semantics**: generate concrete values, substitute
them into a KORE template, run the LLVM backend's `interpreter`, and grade what
comes back. A transcription of pyk's `ktool/kfuzz.py` at K **`v7.1.337`**, with
[`fast-check`](https://fast-check.dev) in place of `hypothesis`.

> **Unofficial.** Not affiliated with, endorsed by, or supported by Runtime
> Verification, Inc. or the K Framework maintainers.

## Install

```sh
npm install @kframework-ts/kfuzz   # or: bun add / pnpm add / yarn add
```

Depends on `@kframework-ts/kore`, `@kframework-ts/ktool` and `fast-check`.
ESM only, with types. Node 20+, Bun 1.3+.

`fast-check` is a **regular dependency**, not a peer one — unlike `zod` in
`@kframework-ts/kast-json`. The argument for a peer dependency does partly
apply: `Arbitrary<Pattern>` is in this package's public signatures, so a
consumer that resolved a _second_ copy of fast-check would be composing two
nominally distinct `Arbitrary` types. What tips it the other way is that
fast-check's arbitraries are duck-typed — `fc.tuple` calls `arb.generate(…)` and
never asks `instanceof` — so two copies degrade to a type-level annoyance rather
than the runtime `instanceof` failure zod produces. In exchange, `npm install
@kframework-ts/kfuzz` works with no second step. If you already depend on
fast-check, keep your range within `^4` and your package manager will dedupe.

**No K installation is required at runtime.** Execution goes through
`@kframework-ts/ktool`'s `llvmInterpretRaw`, and `<definitionDir>/interpreter` is
a self-contained native binary that `kompile --backend llvm` produced. No JVM, no
`kore-rpc` server, nothing on `PATH`. You do of course need a machine that
kompiled the semantics at some point; you do not need it to be this one.

## The shape of it

```ts
import { KFuzz, kintegers } from "@kframework-ts/kfuzz";
import { evar, sortApp } from "@kframework-ts/kore";

const VAR_X = evar("VarX", sortApp("SortInt"));
const VAR_Y = evar("VarY", sortApp("SortInt"));

const kfuzz = new KFuzz("./my-kompiled");

// Grade by reading the interpreter's output pattern; throw to fail.
const report = await kfuzz.fuzzWithCheck(
  template, // a KORE pattern containing VAR_X and VAR_Y
  [
    [VAR_X, kintegers({ minValue: 0 })],
    [VAR_Y, kintegers({ minValue: 0 })],
  ],
  (output) => {
    if (resultCell(output) !== 0n) throw new Error("property violated");
  },
  { seed: 20250806, numRuns: 200 },
);

// …or grade by the exit status of the interpreter, which comes from the
// configuration cell marked `exit=""`.
await kfuzz.fuzzWithExitCode(template, strategy, { seed: report.seed });
```

Four things and one seam:

| name             | what it is                                                                                  |
| ---------------- | ------------------------------------------------------------------------------------------- |
| `fuzz`           | the whole loop as a function — pyk's `fuzz`                                                 |
| `KFuzz`          | the same, with the definition directory, handler and `substFunc` bound once                 |
| `kintegers`      | an `Arbitrary<Pattern>` of `\dv{SortInt{}}` values, optionally injected — pyk's `kintegers` |
| `substituteVars` | the default substitution: bottom-up, keyed by variable **name and sort**                    |
| `KFuzzHandler`   | `handleTest` / `handleFailure`, called per case and per failure — the integration seam      |

## `hypothesis` → `fast-check`, idiom by idiom

This table documents the behavioral correspondences between the two property-
testing APIs. Every row is exercised by a test.

| hypothesis (pyk)                             | fast-check (here)                               | note                                                                                                                                               |
| -------------------------------------------- | ----------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SearchStrategy[Pattern]`                    | `Arbitrary<Pattern>`                            | same concept, same `.map`                                                                                                                          |
| `integers(min_value=, max_value=)`           | `fc.bigInt({ min, max })`                       | **not** `fc.integer()`: a K `Int` and a Python `int` are arbitrary precision, a JS `number` is not                                                 |
| `.map(int_dv)`                               | `.map(intDv)`                                   | unchanged                                                                                                                                          |
| `fixed_dictionaries(subst_strategy)`         | `fc.tuple(...arbs).map(zip)`                    | `fc.record` is keyed by strings and cannot carry `EVar` keys, so the tuple is zipped back against the declared variables — order preserved         |
| `@given(strat)(settings(**args)(test))()`    | `await fc.check(fc.asyncProperty(...), params)` | `check`, not `assert`: the failure is turned into a typed error rather than fast-check's thrown report                                             |
| `settings(deadline=5000)`                    | `Parameters.timeout: 5000`                      | per-case, async only — which this loop always is. `run.timeout: 0` disables it                                                                     |
| `phases = (explicit, reuse, generate)`       | see the three rows below                        | pyk's one settings line is three separate fast-check facts                                                                                         |
| …`Phase.explicit` (`@example`)               | `Parameters.examples`                           | `run.examples` takes a list of substitutions and runs them first                                                                                   |
| …`Phase.reuse` (the `.hypothesis/` database) | **nothing** — `run.seed` + `run.path` instead   | fast-check has no example store. Every failure reports both, so a replay is an instruction you can paste rather than a directory you have to carry |
| …**`Phase.shrink` is absent**                | `endOnFailure: true` (the default here)         | pyk does not shrink; neither does this, by default. `run.shrink: true` turns fast-check's shrinker on, at one interpreter spawn per step           |
| `max_examples` (default 100)                 | `Parameters.numRuns` (default 100)              | identical defaults                                                                                                                                 |
| `hypothesis.errors.DeadlineExceeded`         | a failing case                                  | fast-check reports a timeout as the property failing, with the timeout as `cause`                                                                  |
| the raised `AssertionError`                  | `KFuzzError`                                    | counterexample, seed, replay path, shrink count and the original error as `cause` — all fields, none of them substrings                            |
| `assert res.returncode == 0`                 | `ExitCodeAssertionError`                        | upstream's bare `assert` says nothing about what happened; this one names the status and carries stderr                                            |
| `SearchStrategy` for `bool` / `str`          | `kbools` / `kstrings`                           | additions — pyk has only `kintegers`                                                                                                               |

## What is deliberately different from pyk

Each is tested by name and argued in the module header that owns it.

| deviation                                          | why                                                                                                                                                                                                                                                    |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `substituteVars` is re-exported, not reimplemented | it _was_ reimplemented here, while `@kframework-ts/kore`'s keyed by bare **name** and collided `X:SortInt` with `X:SortBool` (a defect the 2026-08-06 gap triage caught). That is fixed; the argument for why a fuzzer cares is kept in `src/subst.ts` |
| `KFuzzHandler` is an interface, not an `ABC`       | structural typing gives the same guarantee at compile time and costs nothing at run time                                                                                                                                                               |
| handler callbacks and `checkFunc` may be `async`   | a handler that appends a line of JSONL has no synchronous spelling in Node, and a fire-and-forget write loses its last lines                                                                                                                           |
| **any** throw from `checkFunc` is a failing case   | JavaScript has no distinguished `AssertionError`. In pyk a `TypeError` inside `check_func` escapes without `handle_failure` running; here it does not                                                                                                  |
| unparseable interpreter output is a failing case   | pyk's `KoreParser` raises inside the `try` but outside `except AssertionError`, so a malformed response aborts the run with the handler never told. That is a silent oracle failure                                                                    |
| `fuzz` **returns** `{ seed, numRuns }`             | pyk returns `None`. A run whose seed you cannot recover is a run you cannot replay — C4 in `docs/gap-analysis.md`, R6 in `docs/execution-traces.md`                                                                                                    |
| an interrupted run is a failure, not a success     | fast-check's `markInterruptAsFailure` defaults off; "I ran out of time" reported as green is a broken oracle                                                                                                                                           |
| `NULL_KFUZZ_HANDLER` is exported and frozen        | upstream keeps `_KFuzzNullHandler` private; composing handlers needs a name for the identity element                                                                                                                                                   |
| `kbools`, `kstrings`, `fromDomainValues`           | the "generate, wrap as a `\dv`, optionally inject" shape is not specific to `Int`                                                                                                                                                                      |
| no CLI that runs a fuzzer                          | a template pattern and a set of arbitraries have no command-line encoding (`docs/gap-analysis.md` S5)                                                                                                                                                  |

## One hazard worth knowing about, handled next door

pyk's argv hands the interpreter the literal paths `/dev/stdin` and
`/dev/stdout` (`krun.py:476`) and delivers the data over the pipe. **That cannot
work from Node or Bun.** libuv gives a spawned child a `socketpair(2)` where
CPython's `subprocess` gives it a `pipe(2)`, and reopening a socket through
`/proc/self/fd/N` is `ENXIO`, so the interpreter answers

```text
Cannot read file: /dev/stdin
```

and produces nothing. Both ends are affected — the interpreter opens its output
with `fopen(output_filename, "a")`, so a piped `/dev/stdout` fails identically —
and a shell pipeline works, which is why the failure is invisible until you
drive the tool from a program.

`@kframework-ts/ktool` handles it: `llvmInterpretRaw` materialises two temp
files and passes their paths, reporting the output file as `stdout`. This
package makes the plain call and records the hazard, because it is the kind of
thing a reader of a fuzzing package will hit while writing a custom `interpret`
seam of their own.

## Grading a run

**`checkFunc` mode** hands you the interpreter's output as a parsed `Pattern`.
Throw to fail. This is the mode that reads a verdict cell:

```ts
function checkPassed(output: Pattern): void {
  // walk to <res> and assert it holds 0
}
```

**`checkExitCode` mode** grades on the process status, where 0 passes. The
status comes from the configuration cell marked `exit=""`, which the LLVM
backend turns into the process's exit code
(`llvm-backend runtime/util/finish_rewriting.cpp`). Two things to know before
relying on it:

- **a definition with no `exit=""` cell always exits 0**, so this mode always
  passes. That is not an error anyone reports; it is a silently green oracle.
- **113 is reserved**: it is the status for "attempted to evaluate a partial
  function at an undefined input", not a verdict your semantics chose.

Exactly one of the two modes is required. Passing both, or neither, raises
`KFuzzArgumentError` with upstream's own message (`kfuzz.py:175-176`).

## Determinism, and how a failure is replayed

`run.seed` is fast-check's seed and defaults to fast-check's default,
`Date.now()`. It is **not** pinned to a constant: a fuzzer that explores the same
100 inputs every run is a slow unit test. What is guaranteed instead is that the
seed is always _reported_ — `FuzzReport.seed` on success, `KFuzzError.seed` on
failure — so any run is replayable exactly:

```ts
try {
  await kfuzz.fuzzWithCheck(template, strategy, check);
} catch (error) {
  if (error instanceof KFuzzError) {
    console.error({ seed: error.seed, path: error.path, counterexample: error.counterexample });
    // …and to replay only the failing case:
    await kfuzz.fuzzWithCheck(template, strategy, check, { seed: error.seed, path: error.path });
  }
}
```

The replay runs one case, not the whole prefix. Pin `run.seed` explicitly when
you want a byte-identical corpus across runs.

## Building the template

`fuzz` takes a KORE pattern with variables in it, and this package does not build
one for you — every semantics' initial configuration is different. Two routes,
both used in this repo's own tests:

1. **Ask K.** `krun --depth 0 --output kore <program>` prints the whole initial
   configuration; parse it with `@kframework-ts/kore` and swap marker values for
   `EVar`s. This is what `test/live-k.test.ts` does, and it is the same trick
   pyk's `test_fuzz.py:99-107` uses with marker identifiers.
2. **Build it yourself** out of `@kframework-ts/kore`'s constructors, if you
   already know the cell layout.

`@kframework-ts/kore` also exports `topCellInitializer`, corresponding to
pyk's `top_cell_initializer`. Route 1 needs no helper because K assembles the
configuration itself; callers that know the cell layout can use
`topCellInitializer` to build a template without starting a JVM.

## `kfuzz check-k <k-release>`

The house drift check, over the three files this package declares. **Both tiers
decide the exit code**, and the reason is specific to this module: `kfuzz.py` has
no unit test, no doctest and no documented contract beyond its docstrings, so
`test_fuzz.py` is not a test of a specification that exists elsewhere — it _is_
the specification. A change to it invalidates this package's answers as surely as
a change to `kfuzz.py`.

```sh
$ npx @kframework-ts/kfuzz check-k v7.1.400
```

`0 unchanged, 1 changed, 3 could not locate, 2 could not ask`, per
[`docs/versioning.md`](../../docs/versioning.md). `checkKfuzzSources` is exported
if you would rather call it than shell out.

Two pyk files this package depends on are deliberately **not** in its manifest:
`krun.py` (`llvm_interpret_raw`) is pinned by `@kframework-ts/ktool`, and
`kore/prelude.py` by `@kframework-ts/kore`. This package delegates to both rather
than transcribing them, and duplicating a hash would create two places to update.

Also per `docs/versioning.md`: this package's inputs — a KORE pattern and a
kompiled directory — carry no self-identifying version header, so it asserts
nothing about its input's K version at runtime. Both are already checked where
they are read: kore's parser rejects malformed KORE, and `llvmInterpretRaw`
refuses a directory with no `interpreter` in it.

## What is deliberately not here

Permanently, not "not yet":

- **A fuzzing CLI.** See the deviation table.
- **Symbolic fuzzing.** This is concrete execution through the LLVM interpreter.
  Property _proving_ is `@kframework-ts/proof`'s job, and the two are
  complementary rather than competing.
- **A corpus format, a minimiser, or a mutation engine.** A `KFuzzHandler` is
  where a harness hangs those; this package does not own the policy.

Caller-triggered additions are tracked in [`ROADMAP.md`](ROADMAP.md).

## Development

```sh
bun install
bun test              # no K install, no network
bun run check:types
bun run build
```

The live suite is opt-in and needs a real K install at exactly `v7.1.337`:

```sh
KFRAMEWORK_TS_K_BIN=/path/to/k/bin bun test test/live-k.test.ts
```

It kompiles `fixtures/live-k/fuzz-test.k` once per session through ktool's
memoizing `kompileCached` (~9 s), and then runs pyk's three `test_fuzz.py`
scenarios — the property that holds, the planted violation, and the
K-cell-restricted `substFunc` — plus the `checkExitCode` mode that upstream's
suite never exercises. Set `KFRAMEWORK_TS_KOMPILE_CACHE` to a directory to keep
the compiled definition between runs.

`fixtures/PROVENANCE.md` documents the fixture, which is first-party.

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
