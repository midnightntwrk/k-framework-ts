# kfuzz fixture provenance

One fixture, and it is **first-party**: `live-k/fuzz-test.k` was written in this
workspace. Nothing here is copied or derived from any third-party source, so no
external grant is involved and `THIRD-PARTY-NOTICES.md` has nothing to say about
this directory.

Fixtures are not distributed: `package.json`'s `files` field ships `dist`, the
two licences, `README.md` and `THIRD-PARTY-NOTICES.md`. `fixtures/` is not in
the published tarball.

## `live-k/fuzz-test.k`

A semantics that exists to be fuzzed. It is the *scenario* of pyk's
`test_fuzz.py` — one property that holds, one planted violation, and a
custom-substitution variant over the same configuration — written directly
rather than borrowed, because upstream's fixture is `imp.k` and kompiling IMP
with the LLVM backend costs more than the rest of this package's test suite
combined.

| what                | value                                                     |
| ------------------- | --------------------------------------------------------- |
| written             | 2026-08-06, in this workspace                             |
| kompiled with       | `kompile --backend llvm` at K `v7.1.337`                  |
| modelled on         | `pyk/src/tests/integration/ktool/test_fuzz.py` (BSD-3)    |
| copied from that    | nothing — the scenario, not the source                    |
| build time observed | ~9 s cold, once per test session via ktool's cache        |

### What each part is for

- `commutes(X, Y)` computes `(X +Int Y) -Int (Y +Int X)`'s verdict — always 0.
  This is the property that **holds**, and it is upstream's `test_fuzz` claim
  (commutativity of addition) reduced to one rule.
- `ordered(X, Y)` computes 0 when `X <=Int Y` and 1 otherwise. This is the
  **planted violation**, and it is upstream's `test_fuzz_fail` claim.
- `<res>` is an ordinary cell, read by `checkFunc` mode out of the interpreter's
  KORE output.
- `<exitCode exit="">` carries the same verdict, and the LLVM backend turns a
  cell with that attribute into the process's exit status
  (`llvm-backend runtime/util/finish_rewriting.cpp`, `finish_rewriting`:
  `auto exit_code = error ? 113 : get_exit_code(subject);`). That is what
  `checkExitCode` mode reads, and it is why the fixture carries a second cell
  rather than reusing `<res>`.

Both cells start at `1` — "nothing proved yet" — so a definition that gets stuck
before its rule fires fails rather than passing silently. The consequence is
that `krun --depth 0`, which the live test uses to build its template, exits
non-zero by construction; the test asks for it with `check: false` and reads
stdout, which carries the configuration either way.

The cell is spelled `exitCode` rather than K's customary `exit-code` only so its
KORE symbol has no mangled hyphen in it. Nothing depends on the name.

### Reproducing the live-test artifacts

Nothing in this directory is generated, so there is nothing to regenerate. To
see what the live test sees:

```sh
kompile --backend llvm fixtures/live-k/fuzz-test.k --output-definition /tmp/fuzz-out
printf 'commutes(1234567, 7654321)' > /tmp/p.pgm

# The template, before variables are substituted in:
krun --definition /tmp/fuzz-out --depth 0 --output kore /tmp/p.pgm   # exits 1; stdout is the KORE

# One case, by hand:
krun --definition /tmp/fuzz-out --depth 0 --output kore /tmp/p.pgm 2>/dev/null \
  | sed 's/1234567/3/; s/7654321/5/' \
  | /tmp/fuzz-out/interpreter /dev/stdin -1 /dev/stdout
echo "status: $?"        # 0 — commutes holds
```

Swap `commutes` for `ordered` and pick `x > y` to see the violation: `<res>`
comes back `1` and the interpreter exits `1`.

The two literals `1234567` and `7654321` are markers, not data. The live test
replaces the `\dv{SortInt{}}` nodes carrying them with `VarX` and `VarY` after
parsing, which is `test_fuzz.py:99-107`'s trick with integers in place of
upstream's identifiers.

## The K install these were made against

```text
$ kompile --version
K version:    v7.1.337
```

Recorded because the fixture is source, not output: a different K release would
kompile it differently, and the live suite refuses to run against one — ktool's
`requireKTestEnvironment` checks the version exactly.
