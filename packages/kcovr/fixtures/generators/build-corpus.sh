#!/usr/bin/env bash
# Build real-semantics coverage corpora for the opt-in soak test.
#
# NOT run by `bun test`, not run in CI, and nothing it produces is checked in.
# `docs/coverage-plan.md` §5 explains why: KEVM and KMIR kompile in tens of
# minutes, and even KWasm needs a K toolchain this repository does not assume.
# Point `KFRAMEWORK_TS_KCOVR_CORPUS` at the output directory and the soak test
# picks it up; with the variable unset the test skips.
#
# What the soak test does with the output needs no golden: it runs
# `createCoverMap` + `renderCoverageXml` over each build, and checks that
# `translateCoverage` from a build to *itself* is the identity on the
# `<generatedTop>` rules — a strong invariant that holds for any semantics.
#
#   usage: build-corpus.sh <out-dir> [wasm|kevm|kmir]...
#
# Each semantics is built with **its own** pinned K release, read from its
# `deps/k_release`, not with whatever `kompile` is first on PATH.  The KWasm
# attempt in PROVENANCE.md was made off-pin; that turned out not to be why it
# failed, but a coverage build made with the wrong K is still not a fixture.
#
#   wasm-semantics  deps/k_release 7.1.329   (NCSA)
#   evm-semantics   deps/k_release 7.1.337   (BSD-3-Clause)
#   mir-semantics   deps/k_release 7.1.337   (BSD-3-Clause)
#
# Read PROVENANCE.md's "KWasm generation attempt" section before running the
# wasm target: `--coverage` is known to fail on KWasm, measured at both K
# 7.1.191 and v7.1.337 — same `sideEffect:#SortParam{Q0}` error on the same
# sort-parametric rule at `wasm-data/tools.k:17`, exit 113 in ~15 s — so a
# successful build here would itself be news.  The `kmir` target is non-viable
# for the same reason and also at both releases; `kevm` has never been tried.

set -euo pipefail

INSPIRATIONS="${KFRAMEWORK_TS_INSPIRATIONS:-}"
if [[ -z $INSPIRATIONS ]]; then
  echo "set KFRAMEWORK_TS_INSPIRATIONS to the directory holding the runtimeverification checkouts" >&2
  exit 2
fi

OUT="${1:?usage: build-corpus.sh <out-dir> [wasm|kevm|kmir]...}"
shift
TARGETS=("${@:-wasm}")
mkdir -p "$OUT"

# Resolve the K release a semantics pins, and refuse to proceed on a mismatch:
# a coverage build made with the wrong K is not a fixture, it is a bug report.
require_k() {
  local repo=$1 want observed
  want="$(cat "$INSPIRATIONS/$repo/deps/k_release")"
  observed="$(kompile --version | sed -n 's/^K version: *v\{0,1\}//p' | head -1)"
  if [[ $observed != "$want" ]]; then
    echo "$repo pins K $want but 'kompile' on PATH is $observed" >&2
    echo "  install it, e.g.: kup install k --version v$want" >&2
    exit 1
  fi
}

# Run a handful of concrete programs so the build has hit logs and not just an
# `allRules.txt`.  Hit logs are opened in APPEND mode (io.cpp:526-572), so the
# directory is cleared first: without this, a re-run silently doubles counts.
run_programs() {
  local def=$1
  shift
  rm -f "$def"/*_coverage.txt
  for pgm in "$@"; do
    krun --definition "$def" "$pgm" >/dev/null 2>&1 || echo "  (krun failed on $pgm; continuing)" >&2
  done
}

build_wasm() {
  local src="$INSPIRATIONS/wasm-semantics/pykwasm/src/pykwasm/kdist"
  require_k wasm-semantics
  # Flags are the `llvm` target's from pykwasm/src/pykwasm/kdist/plugin.py:49-51.
  kompile --coverage --backend llvm \
    --main-module WASM-TEST --syntax-module WASM-TEST-SYNTAX \
    -I "$src" --md-selector k \
    -o "$OUT/wasm-cov" "$src/wasm-semantics/test.md"
  run_programs "$OUT/wasm-cov" "$INSPIRATIONS"/wasm-semantics/tests/simple/*.wast
}

build_kevm() {
  require_k evm-semantics
  echo "kevm: build through the repo's own kdist ('kdist build evm-semantics.llvm')" >&2
  echo "      with --coverage added to its kompile flags; tens of minutes." >&2
  exit 1
}

build_kmir() {
  require_k mir-semantics
  echo "kmir: build through the repo's own kdist; tens of minutes." >&2
  exit 1
}

for target in "${TARGETS[@]}"; do
  echo "== $target" >&2
  "build_$target"
done

echo "corpus in $OUT; export KFRAMEWORK_TS_KCOVR_CORPUS=$OUT" >&2
