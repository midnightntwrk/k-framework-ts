# Third-party notices

## K Framework (including pyk)

This package's KAST ⇄ KORE converters are a **hand-transcription** of pyk's
`konvert` module, read from the K Framework source tree at tag `v7.1.337`
(commit `4a46d1231473b599c699160132fd6e76a5c46406`):

- `pyk/src/pyk/konvert/_kast_to_kore.py`
  (sha256 `ddc9aa9abff1b180cf8276375647469b83cfd3cba5f385cbd899e0529431d47f`)
- `pyk/src/pyk/konvert/_kore_to_kast.py`
  (sha256 `ce69a388bed164dd9c20cf2b1eee0e8e2d872d641bb153f463b5d67d05a2788c`)
- `pyk/src/pyk/konvert/_utils.py`
  (sha256 `b78a306fa4b23c2f4de2f459b90b1e76c12bbaae7f3ad52282feec6b05ec7cff`)
- `pyk/src/pyk/konvert/_module_to_kore.py`
  (sha256 `e5ef5e4d29c47c0acbaf952f81bc6d2ca797ed1f27449a50ad2de1bb6b01dfc3`)

The last two are declared for completeness and contribute **no lines**:
`_utils.py`'s `munge`/`unmunge` are covered by `@kframework-ts/kore`'s
`mangleName`/`demangleName` as a strict superset, and `_module_to_kore.py`'s
`moduleToKore` is not implemented here at all (see `README.md`). They are
recorded so that the drift check (`konvert check-k`) has been watching them if
either is ever picked up.

pyk's `konvert` is itself a re-implementation, and where it disagrees with the
original this package follows the original. Those originals were read at the
same tag and are the second reference for every behavioural decision:

- `k-frontend/src/main/scala/org/kframework/parser/kore/parser/KoreToK.scala`
  (sha256 `32f8f19facd2e2ad933a54316ecbffb33a24c776815c6f351c17e7703f86d02b`)
- `k-frontend/src/main/java/org/kframework/backend/kore/ModuleToKORE.java`
  (sha256 `88e961adb3620b4a51a8b1e3adb8b56961123ace89c67e04637aa7cd8334c3e4`)

Behaviour was additionally read from, but not transcribed out of,
`k-frontend/src/main/java/org/kframework/compile/AddSortInjections.java`,
`k-frontend/src/main/java/org/kframework/utils/StringUtil.java` and
`k-frontend/src/main/java/org/kframework/unparser/KPrint.java` at the same tag.

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

## haskell-backend

One normative fact is taken from
`runtimeverification/haskell-backend` at tag `v0.1.155` (the submodule commit
that K tag `v7.1.337` pins): the declarations in `src/main/kore/prelude.kore`
that fix `kseq{}(SortKItem{}, SortK{})`, `append{}(SortK{}, SortK{})`,
`dotk{}()` and `inj{From, To}`. That file is the only place in either toolchain
where those signatures are written down rather than assumed; the symbols
themselves live in `@kframework-ts/kore`'s prelude, which carries the
corresponding notice.

The haskell-backend is distributed under the BSD 3-Clause License; its
`LICENSE` file carries this notice, reproduced as required:

> Copyright (c) 2018-2021, Runtime Verification, Inc. All rights reserved.

The license text is identical to the BSD 3-Clause text reproduced above, with
that copyright line.

## Test fixtures

Every vendored byte under `fixtures/` comes from `runtimeverification/k` at
`v7.1.337` and is covered by the notices above; see `fixtures/PROVENANCE.md`
for the exact upstream paths, and for which files are upstream's bytes and
which are our toolchain's output. Fixtures are not distributed in the published
npm package.

Nothing here comes from `imp-semantics` (no LICENSE file at all),
`wasm-semantics` (NCSA), `proof-generation` (custom licence), or `scala-kore`
(no LICENSE at HEAD, and one file in it is affirmatively LGPL-2.1-or-later).
