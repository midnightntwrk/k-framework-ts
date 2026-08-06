# Live-K ktool fixture provenance

The input for `../../live-throughput.test.ts`, the opt-in conformance lane for
B9's three spawn-layer fast paths. The test re-compiles it through
`@kframework-ts/ktool/testing`'s session-scoped `kompileCached`; no generated
`*-kompiled` output is checked in, because it carries machine-specific source
paths and a 30 MB native `interpreter`.

## Source

| fixture          | origin                | fixture sha256                                                     |
| ---------------- | --------------------- | ------------------------------------------------------------------ |
| `tiny-parser.k`  | **written for this repo** | `23aca30bc24644d061bfb030dd58540750bf0ecac8135534de64c95f3476931b` |

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
