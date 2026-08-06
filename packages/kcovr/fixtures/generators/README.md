# `generators/` — inputs and recipes, not test data

Nothing in this directory is read by `bun test`. It exists so that every other
fixture in `../` can be reproduced, and so that a reader can see what a
`kompile --coverage` build actually takes.

| file                       | what it is                                                       |
| -------------------------- | ---------------------------------------------------------------- |
| `sanitize-cov-build.py`    | rebuilds `../cov-build/` and `../compiled/` from a real build      |
| `sanitize-imp-build.py`    | rebuilds `../imp-build/` — the large hit log — from an IMP build   |
| `make-synthetic.py`        | rebuilds `../synthetic/allrules-{src,dst}.txt`                     |
| `mint-golden.py`           | rebuilds `../synthetic/golden.cobertura.xml` from pyk's own renderer |
| `build-corpus.sh`          | opt-in real-semantics corpora; output is never checked in          |
| `coverage-test.k`          | upstream `pyk/regression-new/coverage/test.k` (270 B)              |
| `bytes-coverage-test.k`    | upstream `pyk/regression-new/bytes-coverage/test.k` (103 B)        |
| `issue-1388-test.k`        | upstream `pyk/regression-new/issue-1388/test.k` (149 B)            |
| `imp.k`                    | upstream `pyk/regression-new/imp-llvm/imp.k` (2 385 B)             |

Each script's own docstring is the authority on how to invoke it.
`../PROVENANCE.md` records what came out when they were last run.

## The three vendored `test.k` files

These are the entire `--coverage` test surface of the K repository. Six
`Makefile`s pass `--coverage` at `v7.1.337` — three directories, duplicated
between `pyk/regression-new/` and `k-distribution/tests/regression-new/`, with
the `test.k` byte-identical across each pair (verified). They are vendored from
the `pyk/` copies.

What they assert is: nothing. `ktest.mak:35-36` builds `$(KOMPILED_DIR)/timestamp`
by running `$(KOMPILE) $(KOMPILE_FLAGS) ...`, and none of the three directories
contains a `.test` program, so `krun` never runs, no `*_coverage.txt` is ever
produced, and no output is ever compared. The test is `kompile --coverage` exits
0. That is why this package's real fixtures had to come from a build made
outside the K repository — see `../PROVENANCE.md`.

Their `Makefile`s, for the record:

```make
# coverage/                             # bytes-coverage/            # issue-1388/
DEF=test                                DEF=test                     DEF=test
EXT=test                                EXT=test                     EXT=test
TESTDIR=.                               TESTDIR=.                    TESTDIR=.
                                        KOMPILE_BACKEND=llvm         KOMPILE_BACKEND=llvm
KOMPILE_FLAGS=--coverage \              KOMPILE_FLAGS=--coverage \   KOMPILE_FLAGS=--coverage \
  --syntax-module TEST                    --syntax-module TEST         --main-module WASM-TEST
```

`coverage/` is the only one that omits `KOMPILE_BACKEND`, so it takes the
`ktest.mak` default; the other two pin `llvm`, which is the only backend where
coverage does anything at all — `#logToFile` is implemented in `io.cpp:559` and
the haskell backend registers only `IO.logString` (`IO.hs:69-76,102`), so
`--coverage --backend haskell` compiles and then logs nothing.

`issue-1388/test.k` is worth a second look: two modules, no rules, no syntax. It
is a regression test for `--coverage` on an *empty* definition, and it is the
closest thing upstream has to an edge case.

## `imp.k` — the fourth vendored `.k`, and the only one that runs

`imp-llvm/` is not a `--coverage` directory; it is a plain LLVM regression test.
It is vendored because it is the one thing the six `--coverage` directories
lack: a semantics with **programs**. `imp-llvm/Makefile` sets `EXT=imp` and the
directory ships `sum.imp`, `collatz.imp` and `primes.imp`, so `krun` actually
runs — which is the only way a hit log comes into existence.

Adding `--coverage` to its `kompile` is therefore the shortest path from "K's
test suite" to "a real hit log", and at 101 instrumented rules and a 6.6-second
`kompile` it is by far the cheapest real semantics to build. `../imp-build/` is
the result; `../PROVENANCE.md` has the numbers.

The program run there is `../imp-build/loops.imp` rather than one of upstream's
three, and the reason is measured rather than assumed — all three were run
against the same build:

| program       | lines | unique | bytes   |
| ------------- | ----: | -----: | ------: |
| `primes.imp`  | 2 217 |     36 | 144 105 |
| `sum.imp`     | 3 219 |     25 | 209 235 |
| `collatz.imp` | 4 481 |     30 | 291 265 |
| `loops.imp`   | 6 951 |     34 | 451 815 |

`collatz.imp` is the longest upstream has and it lands at 291 KB, just under
the 300 KB floor this fixture was for. `loops.imp` is a loop count away from
any size wanted.

## Reproducing a coverage build by hand

```sh
kompile --coverage --backend llvm coverage-test.k --syntax-module TEST \
        --output-definition ./cov-kompiled
# allRules.txt is written by every kompile, --coverage or not (Kompile.java:363-382).
# coverage.txt (macro applications) is written at kompile time AND at krun
# program-parse time, in append mode (ExpandMacros.java:131-144,286-289).

krun --definition ./cov-kompiled <program>
# leaves ./cov-kompiled/<pid>_coverage.txt — one UNIQUE_ID per rule APPLICATION,
# appended, flushed at exit (io.cpp:526-572).  K_LOG_DIR and K_LOG_PREFIX move
# and rename it.

rm -f ./cov-kompiled/*_coverage.txt   # the only way to reset; the logs append
```
