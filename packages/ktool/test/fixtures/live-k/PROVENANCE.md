# Live-K ktool fixture provenance

The input for `../../live-throughput.test.ts`, the opt-in conformance lane for
B9's three spawn-layer fast paths. The test re-compiles it through
`@kframework-ts/ktool/testing`'s session-scoped `kompileCached`; no generated
`*-kompiled` output is checked in, because it carries machine-specific source
paths and a 30 MB native `interpreter`.

## Source

| fixture | origin | fixture sha256 |
| --- | --- | --- |
| `tiny-parser.k` | **written for this repo** | `23aca30bc24644d061bfb030dd58540750bf0ecac8135534de64c95f3476931b` |
| `generated-bison-lr1.k` | **written for this repo** | `140409df4636689e5817246683dbd9e5e6907d435b157e0460d48f152349d378` |
| `generated-bison-ambiguous.k` | **written for this repo** | `4f2b08307cd645e50264cb4f57d848e04f29d2e8ec5f6d7fdb748b2b1106dd40` |
| `generated-bison-unused.k` | **written for this repo** | `628db974e5a1e02b4b90a61d7d88b485b06241ffa6d76284984ce745c6188af9` |
| `generated-bison-not-lr1.k` | **written for this repo** | `b6078c7ed7994329324e9d5ffa8de316ddf0008300998550f5aa78ec61ff05f4` |
| `generated-bison-additional-parser.k` | **written for this repo** | `38a39f8277c1ac18f8516bcd0ae0ca848b9355b8ba5a8c8f7fb12432730cf4b9` |

Not a copy of anything upstream. pyk has no fixture for this lane, because pyk
has nothing to test here: it never execs a generated Bison parser and never
manages a kserver. The definition is the smallest thing that satisfies the four
properties the lane needs:

1. a **program grammar** with an infix production, so `kompile
   --gen-glr-bison-parser` has something to generate a parser *for*;
2. `$PGM` declared at a named sort, so `configVars.sh` carries
   `declaredConfigVar_PGM='Exp'` and `kparse`'s *default* target
   (`resolveKparseTarget`) resolves without the test naming a sort — which is
   the rule under test, not an incidental convenience;
3. a distinct syntax module (`TINY-PARSER-SYNTAX`), so the generated filename is
   `parser_Exp_TINY-PARSER-SYNTAX` and a lookup that wrongly used
   `mainModule.txt` would fail rather than accidentally pass;
4. one rewrite rule, so the LLVM `interpreter` has something to do — which is
   what the `/dev/stdin` regression test needs (see `src/stdio.ts`).

It compiles clean under the harness's forced `--type-inference-mode checked
--warnings-to-errors`, which is why the `+` production is `[left]` and not
`[seqstrict]`: strictness would require a `KResult` declaration and the warning
is fatal here.

## Reproduction

The lane is deliberately inert unless explicitly enabled:

```sh
KFRAMEWORK_TS_K_BIN=/path/to/k-7.1.337/bin \
bun test packages/ktool/test/live-throughput.test.ts
```

`KFRAMEWORK_TS_K_BIN` selects the pinned distribution (`v7.1.337`, commit
`4a46d1231473b599c699160132fd6e76a5c46406`); `KFRAMEWORK_TS_KOMPILE_CACHE`
optionally names a persistent build cache so the lane does not re-kompile on
every run. The kserver tests bind an `AF_UNIX` socket under the system temp
directory — short by construction, because `sockaddr_un.sun_path` is 104 bytes
and a deeper path fails to bind (see `src/kserver.ts`).

## Deterministic generated-Bison lane

The five `generated-bison-*` definitions are the independent cases consumed by
`../../generated-bison-live.test.ts`:

1. `lr1` is the smallest conflict-free PGM grammar;
2. `ambiguous` deliberately has `Pgm ::= Pgm Pgm`, so K generation succeeds
   while the independent conflict-as-error invocation reports shift/reduce;
3. `unused` has one sort unreachable from Pgm, proving that `unused-symbol` is
   the sole necessary suppression; and
4. `not-lr1` imports a module carrying `[not-lr1]`, proving that suppression
   remains fatal as `non-lr-grammar`; and
5. `additional-parser` uses a real configuration-cell parser attribute, proving
   that the capture API rejects K's multi-parser output rather than guessing
   which grammar its single reused residual `parser.y` represents.

All five were exercised on 2026-08-09 with K v7.1.337 (commit
`4a46d1231473b599c699160132fd6e76a5c46406`) and GNU Bison 3.8.2. Generated
definition directories and retained `.kompile-*` directories are not checked
in because their paths and native binaries are machine-specific. The lane is
explicitly enabled with both selected tool identities:

```sh
KFRAMEWORK_TS_K_BIN=/path/to/k-7.1.337/bin-unwrapped \
KFRAMEWORK_TS_BISON_BIN=/path/to/bison-3.8.2/bin/bison \
bun test packages/ktool/test/generated-bison-live.test.ts
```

The selected `kompile` entry point must preserve the head of its inherited
`PATH`; packaged wrappers that prepend another Bison are rejected even when it
reports the same version. The test checks the generated C/header version
markers and independent XML root against 3.8.2, retains K's exact process
evidence, and independently analyzes with the immutable selected-Bison snapshot
whose invocation by K was attested.

Pinned K does not expose a successful invocation with zero retained
`parser.y`, multiple residual `parser.y` files, or a PGM parser whose top rule
names the wrong requested sort: those are wrapper-adversarial filesystem states,
not selectable K features. `../../generated-bison.test.ts` therefore exercises
them with executable shell fixtures that run through the real process and
filesystem boundary. The genuine additional-parser case above is the reachable
live-K identity ambiguity; changing K's output after it runs merely to induce
the other states would test the mutator rather than the pinned distribution.
