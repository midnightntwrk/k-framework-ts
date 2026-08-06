# Fixture provenance

These fixtures exist for one reason: `pyk/ktool/claim_index.py` and
`claim_loader.py` have **no direct test anywhere in pyk**. Their de-facto test
suite is `pyk/src/tests/integration/kprove/test_get_claims.py`, an *integration*
test that needs a kompiled definition and a `kprove` binary before it can assert
anything about a pure, in-process data structure.

Pre-generating that test's input turns the whole matrix into a pure `bun test`:
`test/claim-index.test.ts` runs all eight parametrized rows plus the two
standalone cases with no K installed and no process started.

Two kinds of bytes, the same split `packages/kompiled/fixtures/` makes:

- **`upstream/`** — byte-for-byte what the `k` repository has committed.
  Nothing reformatted, re-indented or trimmed.
- **`generated/`** — the pinned K v7.1.337 toolchain's own output, produced by
  the recipe below. Real toolchain bytes; see the reproducibility note.

The `fixtures` directory is excluded from the formatter and the linter by the
repo-root `.oxfmtrc.json` / `.oxlintrc.json` `ignorePatterns` (both list the
bare pattern `fixtures`). Verified for this directory: `oxfmt --check
packages/ktool/fixtures` reports _"All matched files may have been excluded by
ignore rules."_

## Toolchain

Everything in `generated/` came from the same nix-store v7.1.337 install
`packages/kompiled/fixtures/PROVENANCE.md` records, invoked by absolute path.
Both emitted files were checked to begin `{"format":"KAST","version":4,`.

The recorded absolute path identifies the K `v7.1.337` installation that
generated these fixtures. The required validation is the
`{"format":"KAST","version":4,` prefix: K `v7.1.191` emits KAST version 3,
which is incompatible with these fixtures. Invoke the recorded binary rather
than relying on the `kompile` selected by `PATH`.

|                          |                                                                                                 |
| ------------------------ | ----------------------------------------------------------------------------------------------- |
| K release                | `v7.1.337`                                                                                      |
| K commit for that tag    | `4a46d1231473b599c699160132fd6e76a5c46406`                                                      |
| K install path           | `/nix/store/y63xkr8pk2bqd5lh4889rlwldw26v9f4-k-7.1.337-4a46d1231473b599c699160132fd6e76a5c46406` |
| KAST format emitted      | `4`                                                                                             |
| Generated                | 2026-08-06                                                                                      |

## `upstream/multi-claim-spec.k`

|                |                                                                    |
| -------------- | ------------------------------------------------------------------ |
| repository     | `runtimeverification/k` at `v7.1.337` (`4a46d123`)                 |
| path           | `pyk/src/tests/integration/test-data/k-files/multi-claim-spec.k`   |
| git blob       | `950e0938c34a456ed8520d2513dacbd90cc65892`                          |
| sha256         | `346b7677a46e3c0ee57e52595b189bf3a0a7586be5c20041189fbad2e8c4645e`  |
| size           | 48 lines, 1053 bytes                                                |
| licence        | BSD 3-Clause (`pyk/LICENSE.md`, Runtime Verification Inc. 2022)     |

Copied unmodified; `cmp` against the checkout is part of the record above. It is
the definition the whole `ClaimIndex` matrix is written against: 5 modules,
10 claims, 2 of them unlabelled, 2 pairs sharing a short name across modules
(`rep-dep`), and one module (`MULTI-CLAIM-BROKEN-SPEC`) whose single claim
depends on a label that does not exist.

Two of the labels the upstream table references — `main.2` and `main.4` — are
**not in this file**, and that is deliberate upstream: the
`bad-unqualified-main-dep` row exists precisely to check that an unresolvable
`claim_labels` entry raises.

## `generated/*.modulelist.json`

`kprove --dry-run --output json --emit-json-spec` output — a `KFlatModuleList`
inside a KAST v4 envelope, which is exactly what `KProve.parse_modules`
(`pyk/ktool/kprove.py:255-278`) reads back. One file per spec module the
upstream test uses:

| file                                     | `--spec-module`            | bytes  | sha256                                                             |
| ---------------------------------------- | -------------------------- | -----: | ------------------------------------------------------------------ |
| `multi-claim-spec.modulelist.json`       | `MULTI-CLAIM-SPEC`         | 19 471 | `f9fbc5f1760f5ffe319189dc9507af0b7a21154236ae00634f4be86abd1a9d0f` |
| `multi-claim-broken-spec.modulelist.json`| `MULTI-CLAIM-BROKEN-SPEC`  | 21 684 | `b0bd37af0b163f4ae1e7d6a57c14765acae27a6c18eeb49396fc6bc0d4bc8fe2` |

### The recipe

Run verbatim; the working directory is **part of the output** (see below), so it
is fixed rather than left to the reader.

```
K=/nix/store/y63xkr8pk2bqd5lh4889rlwldw26v9f4-k-7.1.337-4a46d1231473b599c699160132fd6e76a5c46406/bin
W=/tmp/ktool-claims-build

rm -rf "$W" && mkdir -p "$W/tmp" && cd "$W"
cp <repo>/packages/ktool/fixtures/upstream/multi-claim-spec.k .

"$K/kompile" --backend haskell --main-module MULTI-CLAIM \
    --syntax-module MULTI-CLAIM-SYNTAX --emit-json \
    --type-inference-mode checked multi-claim-spec.k

for M in MULTI-CLAIM-SPEC MULTI-CLAIM-BROKEN-SPEC; do
  "$K/kprove" multi-claim-spec.k \
      --definition multi-claim-spec-kompiled --spec-module "$M" \
      --output json --temp-dir tmp --dry-run \
      --type-inference-mode checked \
      --emit-json-spec "$M.json" --allow-rules
done
```

`MULTI-CLAIM-SPEC.json` → `generated/multi-claim-spec.modulelist.json`,
`MULTI-CLAIM-BROKEN-SPEC.json` → `generated/multi-claim-broken-spec.modulelist.json`.

The `kprove` invocation is `kproveParseModulesArgs`' golden argv spelled out by
hand — `--definition`, `--spec-module`, `--output json`, `--temp-dir`,
`--dry-run`, then `--emit-json-spec` and `--allow-rules` in the free-form tail.
`test/parse-modules.test.ts` pins that this is the argv the code builds, so the
fixture and the builder check each other.

`--dry-run` is why no proof runs: K stops before invoking `kore-exec`. The
`kompile` step is still required, because `kprove` resolves the spec against a
compiled definition even when it will not prove anything with it.

### The reproducibility note

Like `packages/kompiled/fixtures/generated/`, these bytes are **path-dependent**.
K writes an `org.kframework.attributes.Source` attribute onto every sentence, so
each file embeds two absolute prefixes:

| file                                      | `/nix/store/…` occurrences | working-directory occurrences |
| ----------------------------------------- | -------------------------: | ----------------------------: |
| `multi-claim-spec.modulelist.json`        |                         10 |                            13 |
| `multi-claim-broken-spec.modulelist.json` |                         11 |                            15 |

They reproduce **only** given the same nix store path and the fixed working
directory specified in the recipe above: `/tmp/ktool-claims-build`.

The practical consequence is the same one that package records: **tests must not
assert on absolute paths inside these files.** Nothing in
`test/claim-index.test.ts` does — it asserts on module names, claim labels,
dependency edges and ordering, none of which carry a path.

The `UNIQUE_ID` attributes are *not* path-dependent (they are content hashes of
the claim), which is why the two hex labels of the spec's unlabelled claims can
be asserted on verbatim.

## Licensing

Everything here is derived from `runtimeverification/k` at `v7.1.337`:
`upstream/multi-claim-spec.k` is copied from the `pyk` subtree
(`pyk/LICENSE.md`, **BSD 3-Clause**, Runtime Verification Inc. 2022), and
`generated/` is that file put through K's own compiler, so it inherits the same
terms. BSD-3 is compatible with this repository's `MIT OR Apache-2.0`; the
notice travels in `packages/ktool/THIRD-PARTY-NOTICES.md`, the same treatment
the other packages give their vendored bytes.

Nothing here comes from `imp-semantics` (no licence file) or from any repository
other than `k`.

## Checksums

Recomputed 2026-08-06 from the files as committed.

```
b0bd37af0b163f4ae1e7d6a57c14765acae27a6c18eeb49396fc6bc0d4bc8fe2  generated/multi-claim-broken-spec.modulelist.json
f9fbc5f1760f5ffe319189dc9507af0b7a21154236ae00634f4be86abd1a9d0f  generated/multi-claim-spec.modulelist.json
346b7677a46e3c0ee57e52595b189bf3a0a7586be5c20041189fbad2e8c4645e  upstream/multi-claim-spec.k
```
