# Third-party notices

## Stricli

The `ktool` command uses `@stricli/core` 1.3.0 for typed command routing,
argument validation, and generated help. Stricli is copyright Bloomberg
Finance L.P. and distributed under the Apache License, Version 2.0. The
dependency carries its complete license text. This repository applies a
declaration-only compatibility patch for TypeScript 7 with
`exactOptionalPropertyTypes`; it does not change Stricli's runtime code.

## K Framework (including pyk)

This package is a **hand-transcription** of pyk's tool-orchestration layer,
read from the K Framework source tree at tag `v7.1.337` (commit
`4a46d1231473b599c699160132fd6e76a5c46406`):

- `pyk/src/pyk/ktool/kompile.py`
  (sha256 `fda90f2c679be32c64e4720d823975732d31adfb75f42f43c5fa64d5f9e66e7e`)
- `pyk/src/pyk/ktool/_ktool.py`
  (sha256 `2a3fc71c67917a6cf5e04eef45888660e5ba16574c352ad32e0fc702caa9eb41`)
- `pyk/src/pyk/ktool/utils.py`
  (sha256 `edec26c181b28320ad3b1aa13ce40d08dbf933fc7e8feaa2c16c0b363ddc4689`)
- `pyk/src/pyk/utils.py`
  (sha256 `a773154b7832bb5f1a9a8334bc5807fd8ecdc65f94f943118e477dbf52755312`)
- `pyk/src/pyk/kbuild/utils.py`
  (sha256 `3f9cb09ad363e1402f6c95c4b9c883082532775fa914c2c62a1b8e189f0571ff`)
- `pyk/src/pyk/ktool/kprint.py`
  (sha256 `cf0d3518e2457fe5b5da4b435d976b031221f3715b92f077ec1afe77d7b574c2`)
- `pyk/src/pyk/ktool/krun.py`
  (sha256 `ae45a5156bbb4004a50ae51bf53c476fb21f847787b4bc8f4935881d106c9a76`)
- `pyk/src/pyk/kore/tools.py`
  (sha256 `775bdae924b48def2563391f8e23f3da1edf982bf40ca88785b3acc88ab1c636`)
- `pyk/src/pyk/ktool/claim_index.py`
  (sha256 `bbfddb80a3a549b7339be4b2f00ecde474bf19b7a1167359fc0abd81a6911ff4`)
- `pyk/src/pyk/ktool/claim_loader.py`
  (sha256 `62825323fe81f414755eac34dcf4520cbc0774ec51b1a9fbf646cb5e3db0db3c`)
- `pyk/src/pyk/ktool/kprove.py`
  (sha256 `f08d09941c272a791542cfede1b80826184e3e9223f9696650389c8b715ea339`)

Of `utils.py` and `kbuild/utils.py` only parts are transcribed: from
`utils.py`, the process runner (`run_process_2`, `_subprocess_run`,
`_subprocess_communicate`), the path predicates and `single()`; from
`kbuild/utils.py`, `KVersion` and `k_version`. From `krun.py`, `run_proof_hint`
is deliberately **not** transcribed. From `kprove.py` only `parse_modules` and
the `_kprove`/`_build_arg_list` argv builder are transcribed. Claim proving is
provided by `@kframework-ts/proof`'s RPC `proveClaims`, while this package
provides claim indexing through `ClaimIndex`/`ClaimLoader`.

Four further sources are read as **references** rather than transcribed — the
declarations of the flags every argv this package builds must agree with:

- `k-frontend/src/main/java/org/kframework/kompile/KompileOptions.java`
  (sha256 `c4e1768934d10b677e0bfe1cc0ae8c4dd64a3260a6bcecc84fa8d33d8b4e6590`)
- `k-frontend/src/main/java/org/kframework/kast/KastOptions.java`
  (sha256 `fb4af35d462b18577c47d2fd082fe094c159fd27ebccaf897bb0ddd5b82312fd`)
- `k-distribution/src/main/scripts/bin/kore-print`
  (sha256 `9ecc25d61d1d4773a4a582d5eb34cb54630ea615649a7404732ed8a1510b55a2`)
- `k-distribution/src/main/scripts/bin/krun`
  (sha256 `3133034f2427b8438fc52575ffd7a2b0cde43ba7a6a2da597f9279fbaee80b0e`)

The same hashes appear in `src/version.ts` (the machine-readable copy, which
`src/ksources.ts` checks against any later K release).

Two golden test cases in `test/argv.test.ts` are ported from a **deleted**
upstream test, `pyk/src/tests/unit/ktool/test_kompile.py`, recovered at
`c952e77850^`; the assertions are re-derived against current pyk behaviour and
the deltas are recorded in that file.

`test/krun.test.ts` ports the argv table of
`pyk/src/tests/unit/ktool/test_krun.py`
(sha256 `ae1fb9ddfbd8a8b25e89e15e3a3c5eb8874388fcb3a40555eb7a0f850e012ba3`)
verbatim, and `test/kprint.test.ts` uses the configuration and pretty-print
goldens of `pyk/src/tests/integration/test_kprint.py`
(sha256 `05825177a9024af4d46efba7d42704016652b1db4d0be97786da5c3128d1c1f5`).

No K source code is copied verbatim into this package, but a transcription this
close is fairly regarded as a derivative work, so K's notices travel with it.
The K Framework is distributed under the BSD 3-Clause License. Its repository
`LICENSE.md` carries the first copyright notice below; the headers of the
individual source files carry the second. **Both are reproduced, as required by
clauses 1 and 2.**

### Copyright notices

> Copyright (c) 2010-2024, University of Illinois Board of Trustees and
> individual contributors. All rights reserved. The K Framework originated in
> the Formal Systems Laboratory led by Prof. Grigore Rosu at the University of
> Illinois at Urbana-Champaign.

> Copyright (c) Runtime Verification, Inc. All Rights Reserved.

### License text

```
BSD 3-Clause License

Copyright (c) 2010-2024, University of Illinois Board of Trustees and individual contributors. All rights reserved. The K Framework originated in the Formal Systems Laboratory led by Prof. Grigore Rosu at the University of Illinois at Urbana-Champaign.

Redistribution and use in source and binary forms, with or without
modification, are permitted provided that the following conditions are met:

1. Redistributions of source code must retain the above copyright notice, this
   list of conditions and the following disclaimer.

2. Redistributions in binary form must reproduce the above copyright notice,
   this list of conditions and the following disclaimer in the documentation
   and/or other materials provided with the distribution.

3. Neither the name of the copyright holder nor the names of its contributors
   may be used to endorse or promote products derived from this software
   without specific prior written permission.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS"
AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE
FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL
DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR
SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER
CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY,
OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
```

`test/claim-index.test.ts` ports the claim-selection table of
`pyk/src/tests/integration/kprove/test_get_claims.py`
(sha256 `284bbe29592ea01252abe34749be41106bd7fbc168c2c7c1b5d3fcaa39a6568d`)
row for row.

## Test fixtures

`fixtures/upstream/multi-claim-spec.k` is copied byte-for-byte from
`runtimeverification/k` `pyk/src/tests/integration/test-data/k-files/` at
`v7.1.337` (BSD 3-Clause, `pyk/LICENSE.md`, Runtime Verification Inc.; sha256
`346b7677a46e3c0ee57e52595b189bf3a0a7586be5c20041189fbad2e8c4645e`), and
`fixtures/generated/` is that file put through K's own compiler and prover,
inheriting the same terms. Full provenance, including the exact toolchain
store path and reproduction recipe, is in `fixtures/PROVENANCE.md`. Nothing
else under `test/` comes from another project.
