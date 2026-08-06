# prooftrace fixture provenance

Two `.k` sources, three programs, and ten generated artefacts. One of the two
sources is **third-party**; everything else in this directory is first-party or
machine-generated from it.

Fixtures are not distributed: `package.json`'s `files` field ships `dist`, the
two licences, `README.md` and `THIRD-PARTY-NOTICES.md`. `fixtures/` is not in
the published tarball.

## Why there are checked-in binaries at all

This package reads a binary format that only the LLVM backend can write. Every
other kind of test — a hand-written encoder, a synthetic blob — proves that the
reader agrees with *this repository's* understanding of the format. Only a real
trace, and the real tool's rendering of it, proves that the understanding is
right. So `fixtures/hints/` carries three complete traced runs, and
`test/reference.test.ts` diffs this package's output against
`kore-proof-trace`'s byte for byte. Total: 1.4 MB, most of it the two
`compiled.json` files.

## `live-k/add-rewrite.k` — third-party

**This file is copied verbatim** from the llvm-backend's own documentation:
`docs/proof-trace.md` §Example (`:109-133`), at `v0.1.140`. It is the semantics
the normative spec uses to illustrate the format, which makes it the best
possible fixture for a reader of that format — if this package disagrees with
the backend on the document's own example, the disagreement is not subtle.

BSD 3-Clause, © Runtime Verification, Inc. and the University of Illinois; see
`THIRD-PARTY-NOTICES.md`, which reproduces both notices as clauses 1 and 2
require.

The only change is what `kompile` requires and the doc omits: nothing. The file
is the doc's two modules and five rules, unmodified.

| what | value |
| --- | --- |
| copied from | `llvm-backend docs/proof-trace.md:109-133` at `v0.1.140` |
| modifications | none |
| programs | `add-rewrite.pgm` = `state(s(s(z())), z())` — the doc's own input (`:138`) |

## `live-k/guarded.k` — first-party

Written in this workspace. `add-rewrite.k` has no side conditions and no
functions, so it exercises neither `side_cond_entry`/`side_cond_exit` nor the
nesting that `records.ts`'s `depth` option is about. This one does, and it is
built specifically to answer `docs/execution-traces.md` R4's own check:

> For a rule with a side condition, two programs that take the two sides of that
> condition produce traces that differ in the substitution, and the difference
> is the operand that differs.

```
rule [halve-big]   : halve(N:Nat) => halve(pred(N)) requires depth(N) >Int 1
rule [halve-small] : halve(N:Nat) => done(N)        requires depth(N) <=Int 1
```

Both rules bind the **same** variable `N` in the **same** position, so the two
programs differ in nothing but what `N` matched — which is exactly the
difference a trace without substitutions cannot see.

| program | term | what it exercises |
| --- | --- | --- |
| `guarded-small.pgm` | `halve(s(z()))` | `halve-small`'s guard passes on the first try |
| `guarded-big.pgm` | `halve(s(s(s(z()))))` | it fails twice first, so the trace carries two rejected attempts |

`depth` and `pred` are `[function, total]`, which puts real equations inside the
`requires` evaluation — the events `depth: Infinity` reveals.

## Generated: `hints/`

| file | produced by |
| --- | --- |
| `*.definition.kore` | `kompile` — the backend's own definition; the ordinal numbering is its declaration order |
| `*.compiled.json` | `kompile --emit-json` — the `KDefinition` `koreToKast` needs for R4 |
| `*.header` | `kore-rich-header` — binary KORE 2.0 string/sort/symbol tables |
| `*.hints` | `krun --proof-hint` — the trace |
| `*.trace.txt` | `kore-proof-trace --expand-terms --verbose` — the conformance oracle |

Note the `--emit-json` flag: it changes nothing in `definition.kore` (verified
byte-identical with and without it) and only adds `compiled.json`.

### Reproducing them

Exactly these commands, from exactly this directory, at K `v7.1.337`:

```sh
mkdir -p /tmp/kfts-prooftrace-fixture && cd /tmp/kfts-prooftrace-fixture
cp <repo>/packages/prooftrace/fixtures/live-k/*.k .
cp <repo>/packages/prooftrace/fixtures/live-k/*.pgm .

for name in add-rewrite guarded; do
  kompile "$name.k" --llvm-proof-hint-instrumentation --emit-json \
    --output-definition "$name-kompiled"
  kore-rich-header "$name-kompiled/definition.kore" -o "$name.header"
done

krun add-rewrite.pgm   --definition add-rewrite-kompiled --proof-hint --output-file add-rewrite.hints
krun guarded-big.pgm   --definition guarded-kompiled     --proof-hint --output-file guarded-big.hints
krun guarded-small.pgm --definition guarded-kompiled     --proof-hint --output-file guarded-small.hints

kore-proof-trace add-rewrite.header add-rewrite.hints add-rewrite-kompiled/definition.kore \
  --expand-terms --verbose > add-rewrite.trace.txt
for name in guarded-big guarded-small; do
  kore-proof-trace guarded.header "$name.hints" guarded-kompiled/definition.kore \
    --expand-terms --verbose > "$name.trace.txt"
done
```

**The `/tmp/kfts-prooftrace-fixture` path is load-bearing** and is why it is
spelled out rather than left to `mktemp`: `definition.kore` and `*.trace.txt`
both embed the absolute path of the `.k` file in their `Source(…)` attributes,
so regenerating anywhere else produces files that differ from the checked-in
ones in that string. `packages/kompiled/fixtures` has the same property.

Everything above is deterministic. Regenerating from a clean directory
reproduced all eight binary and text artefacts byte-for-byte — including across
a second `kompile` of the same source, which is itself the R6 evidence at the
compiler level.

### What keeps them honest

`test/live-k.test.ts` regenerates the two `.header` files and byte-compares
them, re-runs `kore-proof-trace` against live artefacts and diffs its output
against this package's rendering, and checks that a live traced run's events
equal the fixture's. A K upgrade that changes any of it fails there rather than
silently invalidating the offline suite.

## The K install these were made against

```text
$ kompile --version
K version:    v7.1.337
$ llvm-backend-version
0.1.140
```

Recorded because the fixtures are output, not source: a different K release
would produce different bytes, and the live suite refuses to run against one —
`@kframework-ts/ktool`'s `requireKTestEnvironment` checks the version exactly.
